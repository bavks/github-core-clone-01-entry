// githttp.ts — git smart HTTP: info/refs advertisements (v0 + v2), ls-refs, fetch
// (upload-pack v0 and v2, shallow/deepen) and push (receive-pack with report-status),
// all served from the in-process object model in git.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, ZERO_SHA, type RepoRecord } from './store.ts';
import {
  buildPack,
  commitParents,
  fetchSelection,
  hasObject,
  isAncestor,
  parsePack,
  peelTag,
  readObject,
  resolveCommit,
  storePackObjects,
} from './git.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktRead {
  lines: Buffer[];
  /** 'flush' | 'delim' | 'eof' — how the run of lines ended. */
  end: 'flush' | 'delim' | 'eof';
  pos: number;
}

/** Read pkt-lines from `pos` until a flush, a delim, or the buffer's end. */
export function readPktLines(buf: Buffer, pos: number): PktRead {
  const lines: Buffer[] = [];
  for (;;) {
    if (pos + 4 > buf.length) return { lines, end: 'eof', pos };
    const header = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`invalid pkt-line header "${header}"`);
    const length = parseInt(header, 16);
    if (length === 0) return { lines, end: 'flush', pos: pos + 4 };
    if (length === 1) return { lines, end: 'delim', pos: pos + 4 };
    if (length === 2) {
      // Response-end packet (v2): treat as flush.
      return { lines, end: 'flush', pos: pos + 4 };
    }
    if (length < 4 || pos + length > buf.length) throw new Error('pkt-line overruns the body');
    lines.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

let requestCounter = 0;
export function requestId(): string {
  requestCounter += 1;
  return `FORGE-${requestCounter.toString(16).toUpperCase().padStart(6, '0')}`;
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8');
  sendBuffer(res, status, 'application/json; charset=utf-8', body);
}

// ---------------------------------------------------------------- refs helpers

/** HEAD's target ref for a repo (its default branch), and the sha it names (or null). */
function headRef(repo: RepoRecord): { ref: string; sha: string | null } {
  const ref = `refs/heads/${repo.defaultBranch}`;
  return { ref, sha: repo.refs.get(ref) ?? null };
}

/** All refs in advertisement order: sorted by ref name. */
function sortedRefs(repo: RepoRecord): Array<{ name: string; sha: string }> {
  return [...repo.refs.entries()].map(([name, sha]) => ({ name, sha })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

const UPLOAD_CAPS = 'side-band-64k ofs-delta thin-pack agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

// ---------------------------------------------------------------- info/refs

export async function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: RepoRecord, url: URL): Promise<void> {
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJsonError(res, 403, 'Unsupported service');
    return;
  }
  const isUpload = service === 'git-upload-pack';
  const protocol = req.headers['git-protocol'] ?? '';
  const wantsV2 = isUpload && /(?:^|:)version=2(?:$|:)/.test(Array.isArray(protocol) ? protocol.join(':') : protocol);

  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (wantsV2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('agent=forge/1.0\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
    return;
  }

  const caps = isUpload
    ? `${UPLOAD_CAPS} symref=HEAD:${headRef(repo).ref}`
    : RECEIVE_CAPS;
  const head = headRef(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head.sha ?? ZERO_SHA} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.sha} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const { target, type } = peelTag(ref.sha);
        if (type === 'commit' && target !== ref.sha) parts.push(pktLine(`${target} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

// ---------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(res: ServerResponse, repo: RepoRecord, args: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const head = headRef(repo);
  const lines: Buffer[] = [];
  if (matches('HEAD')) {
    if (head.sha !== null) {
      lines.push(pktLine(`${head.sha} HEAD${symrefs ? ` symref-target:${head.ref}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${head.ref}` : ''}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const { target, type } = peelTag(ref.sha);
      if (type === 'commit') line += ` peeled:${target}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(lines));
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: Set<string>;
  depth: number | null;
  since: number | null;
  notTips: string[];
  done: boolean;
  waitForDone: boolean;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const slice = pack.subarray(pos, pos + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

function runFetch(repo: RepoRecord, args: FetchArgs): { send: Set<string>; newShallow: Set<string>; commonHaves: string[] } {
  const resolvedNot: string[] = [];
  for (const tip of args.notTips) {
    // deepen-not names a ref on the server; resolve it, else treat it as a sha.
    const sha = repo.refs.get(tip) ?? (hasObject(tip) ? tip : null);
    if (sha !== null) resolvedNot.push(sha);
  }
  const selection = fetchSelection(args.wants, args.haves, args.shallow, {
    depth: args.depth,
    since: args.since,
    notTips: resolvedNot,
  });
  const commonHaves = args.haves.filter((have) => resolveCommit(have) !== null);
  return { ...selection, commonHaves };
}

function shallowInfoLines(repo: RepoRecord, args: FetchArgs, newShallow: Set<string>): string[] {
  const lines: string[] = [];
  for (const sha of newShallow) lines.push(`shallow ${sha}`);
  // A previously-shallow commit the client can now see past becomes unshallow.
  if (args.depth !== null || args.since !== null) {
    for (const have of args.shallow) {
      const commit = resolveCommit(have);
      if (commit === null) continue;
      const parents = commitParents(commit);
      const covered = parents.length === 0 || parents.some((p) => hasObject(p) && !newShallow.has(commit));
      if (covered && !newShallow.has(commit)) lines.push(`unshallow ${commit}`);
    }
  }
  void repo;
  return lines;
}

export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoRecord): Promise<void> {
  const body = await readBody(req);
  let first: PktRead;
  try {
    first = readPktLines(body, 0);
  } catch {
    sendJsonError(res, 400, 'Malformed upload-pack request');
    return;
  }
  const firstLines = first.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));

  // Protocol v2: the first run of lines is the command header, ending in a delim.
  if (firstLines.some((line) => line.startsWith('command='))) {
    const command = firstLines.find((line) => line.startsWith('command='))!.slice('command='.length);
    if (first.end !== 'delim' && first.end !== 'flush') {
      sendJsonError(res, 400, 'Malformed protocol v2 request');
      return;
    }
    const argRead = readPktLines(body, first.pos);
    const argLines = argRead.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
    if (command === 'ls-refs') {
      handleLsRefs(res, repo, argLines);
      return;
    }
    if (command !== 'fetch') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pktLine(`error unsupported command ${command}\n`), PKT_FLUSH]));
      return;
    }
    const args: FetchArgs = { wants: [], haves: [], shallow: new Set(), depth: null, since: null, notTips: [], done: false, waitForDone: false };
    for (const line of argLines) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.add(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) args.since = Number(line.slice(13).trim());
      else if (line.startsWith('deepen-not ')) args.notTips.push(line.slice(11).trim());
      else if (line === 'done') args.done = true;
      else if (line === 'wait-for-done') args.waitForDone = true;
    }
    const rawHaveCount = args.haves.length;
    for (const sha of args.shallow) args.haves.push(sha);
    const { send, newShallow, commonHaves } = runFetch(repo, args);

    const parts: Buffer[] = [];
    // The acknowledgments section exists only when the client sent haves; with
    // none, the first section is shallow-info or packfile (real git insists).
    if (rawHaveCount > 0) {
      parts.push(pktLine('acknowledgments\n'));
      if (commonHaves.length === 0) parts.push(pktLine('NAK\n'));
      else for (const have of commonHaves) parts.push(pktLine(`ACK ${resolveCommit(have)} common\n`));
      parts.push(pktLine('ready\n'));
    }
    if (args.waitForDone && !args.done) {
      parts.push(PKT_FLUSH);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
      return;
    }
    const shallowLines = shallowInfoLines(repo, args, newShallow);
    if (shallowLines.length > 0 || args.shallow.size > 0 || args.depth !== null || args.since !== null) {
      if (parts.length > 0) parts.push(PKT_DELIM);
      parts.push(pktLine('shallow-info\n'));
      for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
    }
    if (parts.length > 0) parts.push(PKT_DELIM);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(buildPack(send)));
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }

  // Protocol v0: want lines (flush), have lines, "done" (flush).
  const args: FetchArgs = { wants: [], haves: [], shallow: new Set(), depth: null, since: null, notTips: [], done: false, waitForDone: false };
  for (const raw of firstLines) {
    const line = raw.split('\0')[0];
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.since = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.notTips.push(line.slice(11).trim());
  }
  if (first.end === 'flush') {
    const second = readPktLines(body, first.pos);
    for (const raw of second.lines.map((line) => line.toString('utf8').replace(/\n$/, ''))) {
      if (raw.startsWith('have ')) args.haves.push(raw.slice(5).trim());
      else if (raw === 'done') args.done = true;
    }
  }
  for (const sha of args.shallow) args.haves.push(sha);
  const { send, newShallow } = runFetch(repo, args);
  const parts: Buffer[] = [];
  const shallowLines = shallowInfoLines(repo, args, newShallow);
  for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPack(buildPack(send)));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

interface RefCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

export async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: RepoRecord): Promise<void> {
  const body = await readBody(req);
  let head: PktRead;
  try {
    head = readPktLines(body, 0);
  } catch {
    sendJsonError(res, 400, 'Malformed receive-pack request');
    return;
  }
  const commands: RefCommand[] = [];
  for (const rawLine of head.lines) {
    const line = rawLine.toString('utf8').replace(/\n$/, '').split('\0')[0];
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) commands.push({ oldSha: match[1], newSha: match[2], ref: match[3] });
  }
  const packBytes = body.subarray(head.pos);
  let unpackLine = 'unpack ok\n';
  if (packBytes.length > 0) {
    try {
      const pack = parsePack(packBytes, 0);
      storePackObjects(pack);
    } catch (err) {
      unpackLine = `unpack error: ${err instanceof Error ? err.message : String(err)}\n`;
    }
  }

  const report: string[] = [unpackLine];
  for (const command of commands) {
    if (unpackLine !== 'unpack ok\n') {
      report.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const failure = applyRefCommand(repo, command);
    report.push(failure === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${failure}\n`);
  }
  if (commands.length > 0) {
    repo.updatedAt = store.now();
    store.markDirty();
  }
  const inner = Buffer.concat([...report.map((line) => pktLine(line)), PKT_FLUSH]);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', outer);
}

/** Apply one ref update; returns a refusal reason or null on success. */
function applyRefCommand(repo: RepoRecord, command: RefCommand): string | null {
  const { oldSha, newSha, ref } = command;
  if (!ref.startsWith('refs/')) return 'invalid ref name';
  const current = repo.refs.get(ref) ?? ZERO_SHA;

  if (newSha === ZERO_SHA) {
    // Delete.
    if (current === ZERO_SHA) return 'reference not found';
    if (current !== oldSha) return 'reference mismatch';
    repo.refs.delete(ref);
    return null;
  }
  if (!hasObject(newSha)) return 'new object not found';
  if (current !== oldSha) return 'reference mismatch';
  if (oldSha !== ZERO_SHA && ref.startsWith('refs/heads/')) {
    const oldCommit = resolveCommit(oldSha);
    const newCommit = resolveCommit(newSha);
    if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit && !isAncestor(oldCommit, newCommit)) {
      return 'non-fast-forward';
    }
  }
  repo.refs.set(ref, newSha);
  return null;
}

/** Route a git smart-HTTP request. `repo` is null when the repository does not exist. */
export async function handleGitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRecord | null,
  kind: 'info/refs' | 'git-upload-pack' | 'git-receive-pack',
  url: URL,
): Promise<void> {
  if (repo === null) {
    sendJsonError(res, 404, 'Not Found');
    return;
  }
  if (kind === 'info/refs') await handleInfoRefs(req, res, repo, url);
  else if (kind === 'git-upload-pack') await handleUploadPack(req, res, repo);
  else await handleReceivePack(req, res, repo);
}
