// git.ts — the git object model in pure stdlib code: SHA-1 objects, trees, commits,
// tags, packfiles (read: plain + ofs/ref deltas; write: plain), tree diffs and the
// three-way tree merge pull requests need. No git binary is ever invoked.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { store, ZERO_SHA, type GitObject } from './store.ts';

export type ObjectType = GitObject['type'];

const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Hash and store one object; returns its sha. Idempotent (content-addressed). */
export function writeObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = sha1Hex(Buffer.concat([header, data]));
  if (!store.objects.has(sha)) {
    store.objects.set(sha, { type, data });
    store.markDirty();
  }
  return sha;
}

export function readObject(sha: string): GitObject | null {
  return store.objects.get(sha) ?? null;
}

export function hasObject(sha: string): boolean {
  return store.objects.has(sha);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // "100644" for files, "40000" for directories (as written in tree bytes)
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.subarray(pos, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries by name, directories as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function writeTree(entries: TreeEntry[]): string {
  return writeObject('tree', buildTreeData(entries));
}

/** Flatten a tree (recursively) to path -> {sha, mode}. Missing tree = empty. */
export function flattenTree(treeSha: string | null, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  if (treeSha === null) return out;
  const obj = readObject(treeSha);
  if (obj === null || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> blob sha map. Returns the root tree sha. */
export function buildTreeFromFiles(files: Map<string, string>): string {
  interface Dir {
    files: Map<string, string>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = dir.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1], sha);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of dir.files) entries.push({ mode: '100644', name, sha });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: emit(sub) });
    return writeTree(entries);
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits & tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_SHA;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function formatIdentity(name: string, email: string, tsSeconds: number): string {
  return `${name} <${email}> ${tsSeconds} +0000`;
}

export function makeCommit(tree: string, parents: string[], message: string, identity: string): string {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`, `committer ${identity}`);
  return writeObject('commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: ZERO_SHA, type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Peel tags (through chains) to the object they ultimately name; non-tags return themselves. */
export function peelTag(sha: string): { target: string; type: ObjectType | null } {
  let current = sha;
  for (let depth = 0; depth < 16; depth++) {
    const obj = readObject(current);
    if (obj === null) return { target: current, type: null };
    if (obj.type !== 'tag') return { target: current, type: obj.type };
    current = parseTag(obj.data).object;
  }
  return { target: current, type: null };
}

/** Resolve a commit-ish sha (commit or annotated tag) to a commit sha, or null. */
export function resolveCommit(sha: string): string | null {
  const { target, type } = peelTag(sha);
  return type === 'commit' ? target : null;
}

export function commitTree(commitSha: string): string | null {
  const obj = readObject(commitSha);
  if (obj === null || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

export function commitParents(commitSha: string): string[] {
  const obj = readObject(commitSha);
  if (obj === null || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

// ---------------------------------------------------------------- graph walks

/** All commits reachable from a tip (inclusive), as sha -> depth (shortest distance). */
export function ancestorDepths(tip: string): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<{ sha: string; depth: number }> = [{ sha: tip, depth: 0 }];
  while (queue.length > 0) {
    const { sha, depth } = queue.shift()!;
    if (depths.has(sha) && depths.get(sha)! <= depth) continue;
    depths.set(sha, depth);
    for (const parent of commitParents(sha)) queue.push({ sha: parent, depth: depth + 1 });
  }
  return depths;
}

export function isAncestor(ancestor: string, descendant: string): boolean {
  return ancestorDepths(descendant).has(ancestor);
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOfA = ancestorDepths(a);
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsOfA.has(sha)) return sha;
    queue.push(...commitParents(sha));
  }
  return null;
}

/** The tree+blob closure of one commit (the commit itself is not included). */
function treeClosure(commitSha: string, out: Set<string>): void {
  const tree = commitTree(commitSha);
  if (tree === null) return;
  const walk = (treeSha: string): void => {
    if (out.has(treeSha)) return;
    const obj = readObject(treeSha);
    if (obj === null || obj.type !== 'tree') return;
    out.add(treeSha);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.sha);
      else out.add(entry.sha);
    }
  };
  walk(tree);
}

/** Full object closure of a commit: the commit, its ancestors, and every tree/blob. */
export function fullClosure(tipSha: string): Set<string> {
  const out = new Set<string>();
  const start = resolveCommit(tipSha);
  if (start === null) {
    // A tag or tree/blob tip: include the object itself and its closure.
    const obj = readObject(tipSha);
    if (obj !== null) {
      out.add(tipSha);
      if (obj.type === 'tree') treeClosureFlat(tipSha, out);
    }
    return out;
  }
  for (const commit of ancestorDepths(start).keys()) {
    out.add(commit);
    treeClosure(commit, out);
  }
  // Include any tag objects pointing at the tip.
  return out;
}

function treeClosureFlat(treeSha: string, out: Set<string>): void {
  const obj = readObject(treeSha);
  if (obj === null || obj.type !== 'tree') return;
  out.add(treeSha);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') treeClosureFlat(entry.sha, out);
    else out.add(entry.sha);
  }
}

export interface FetchOptions {
  /** Truncate the want closure at this many commits from the wants. */
  depth?: number | null;
  /** deepen-since: only include commits whose committer time is >= this unix ts. */
  since?: number | null;
  /** deepen-not: tips whose whole closure is excluded, like extra haves. */
  notTips?: string[];
}

function commitTime(commitSha: string): number {
  const obj = readObject(commitSha);
  if (obj === null || obj.type !== 'commit') return 0;
  const match = / (\d+) [+-]\d{4}$/.exec(parseCommit(obj.data).committer);
  return match !== null ? Number(match[1]) : 0;
}

/**
 * Objects to send for a fetch: closure(wants) minus closure(haves).
 * - `shallowHaves`: haves the client holds as shallow boundaries — only the commit
 *   itself and its tree closure are excluded, never its parents.
 * - With a depth/since limit, `newShallow` receives the sent commits whose parents
 *   were cut off by the limit (the new shallow boundary).
 */
export function fetchSelection(
  wants: string[],
  haves: string[],
  shallowHaves: Set<string>,
  options: FetchOptions = {},
): { send: Set<string>; newShallow: Set<string> } {
  const depth = options.depth ?? null;
  const since = options.since ?? null;
  const haveSet = new Set<string>();
  const excludeClosure = (tip: string, shallowOnly: boolean): void => {
    const commit = resolveCommit(tip);
    if (commit === null) return;
    if (shallowOnly) {
      haveSet.add(commit);
      treeClosure(commit, haveSet);
    } else {
      for (const ancestor of ancestorDepths(commit).keys()) {
        haveSet.add(ancestor);
        treeClosure(ancestor, haveSet);
      }
    }
  };
  for (const have of haves) excludeClosure(have, shallowHaves.has(have) || shallowHaves.has(resolveCommit(have) ?? ''));
  for (const tip of options.notTips ?? []) excludeClosure(tip, false);

  const send = new Set<string>();
  const newShallow = new Set<string>();
  for (const want of wants) {
    const obj = readObject(want);
    if (obj === null) continue;
    if (obj.type === 'tag') {
      if (!haveSet.has(want)) send.add(want);
      const commit = resolveCommit(want);
      if (commit === null) continue;
      collectWant(commit, depth, since, haveSet, send, newShallow);
    } else if (obj.type === 'commit') {
      collectWant(want, depth, since, haveSet, send, newShallow);
    } else if (!haveSet.has(want)) {
      send.add(want);
    }
  }
  for (const sha of haveSet) send.delete(sha);
  return { send, newShallow };
}

function collectWant(
  tip: string,
  depth: number | null,
  since: number | null,
  haveSet: Set<string>,
  send: Set<string>,
  newShallow: Set<string>,
): void {
  // Breadth-first by commit depth so a depth limit means "N commits back from the tip".
  const depths = new Map<string, number>();
  const queue: Array<{ sha: string; depth: number }> = [{ sha: tip, depth: 0 }];
  while (queue.length > 0) {
    const { sha, depth: d } = queue.shift()!;
    if (depths.has(sha) && depths.get(sha)! <= d) continue;
    depths.set(sha, d);
    for (const parent of commitParents(sha)) queue.push({ sha: parent, depth: d + 1 });
  }
  const included = new Set<string>();
  for (const [commit, d] of depths) {
    if (depth !== null && d >= depth) continue;
    if (since !== null && commitTime(commit) < since) continue;
    included.add(commit);
  }
  for (const commit of included) {
    if (haveSet.has(commit)) continue;
    send.add(commit);
    const trees = new Set<string>();
    treeClosure(commit, trees);
    for (const sha of trees) if (!haveSet.has(sha)) send.add(sha);
    // A sent commit with a parent left outside the limit is a shallow boundary.
    if ((depth !== null || since !== null) && commitParents(commit).some((p) => !included.has(p))) {
      newShallow.add(commit);
    }
  }
}

// ---------------------------------------------------------------- packs

/** Serialise a packfile of the given objects (plain, undeltified). */
export function buildPack(shas: Iterable<string>): Buffer {
  const list = [...shas].filter((sha) => store.objects.has(sha));
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const sha of list) {
    const obj = store.objects.get(sha)!;
    parts.push(encodePackObjectHeader(TYPE_IDS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

function encodePackObjectHeader(typeId: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeId << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Apply a git delta to a base object, returning the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size (trusted, not checked)
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) throw new Error('delta produced the wrong size');
  return result;
}

export interface ParsedPack {
  /** Every object the pack carries, resolved to full objects. */
  objects: Array<{ sha: string; type: ObjectType; data: Buffer }>;
  /** Bytes consumed by the pack, including its 20-byte trailer. */
  consumed: number;
}

/**
 * Parse a packfile starting at `offset`. Deltas are resolved against objects earlier
 * in the pack or already in the store (thin packs). The zlib stream end of each object
 * is found by the minimal-slice method: inflateSync tolerates trailing bytes and throws
 * on truncation, so the shortest slice yielding the full output is the stream's end.
 */
export function parsePack(buf: Buffer, offset: number): ParsedPack {
  if (buf.length < offset + 12 || buf.subarray(offset, offset + 4).toString('utf8') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(offset + 8);
  let pos = offset + 12;
  const local = new Map<string, GitObject>();
  const byPosition = new Map<number, GitObject>();
  const raw: Array<{ type: ObjectType; data: Buffer }> = [];

  const inflateObject = (start: number, expectedSize: number): { data: Buffer; consumed: number } => {
    const rest = buf.subarray(start);
    const full = inflateSync(rest);
    if (full.length !== expectedSize) throw new Error('pack object size mismatch');
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let ok = false;
      try {
        ok = inflateSync(rest.subarray(0, mid)).equals(full);
      } catch {
        ok = false;
      }
      if (ok) hi = mid;
      else lo = mid + 1;
    }
    return { data: full, consumed: lo };
  };

  for (let i = 0; i < count; i++) {
    const objectStart = pos;
    let byte = buf[pos++];
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | null = null;
    let baseLocal: GitObject | null = null;
    if (typeId === 6) {
      // OFS_DELTA: a negative offset back to the base object's start.
      let b = buf[pos++];
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos++];
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const baseStart = objectStart - baseOffset;
      baseLocal = byPosition.get(baseStart) ?? null;
      if (baseLocal === null) throw new Error('ofs-delta base not found in pack');
    } else if (typeId === 7) {
      baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const { data, consumed } = inflateObject(pos, size);
    pos += consumed;
    if (typeId === 6 || typeId === 7) {
      const base = baseLocal ?? (baseSha !== null ? (local.get(baseSha) ?? store.objects.get(baseSha) ?? null) : null);
      if (base === null || base === undefined) throw new Error('delta base is missing');
      const resolved = applyDelta(base.data, data);
      writeResolved(local, base.type, resolved);
      byPosition.set(objectStart, { type: base.type, data: resolved });
      raw.push({ type: base.type, data: resolved });
    } else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      writeResolved(local, type, data);
      byPosition.set(objectStart, { type, data });
      raw.push({ type, data });
    }
  }
  pos += 20; // the pack trailer (a SHA-1 of everything before it; not verified)
  const objects = raw.map((entry) => ({
    sha: sha1Hex(Buffer.concat([Buffer.from(`${entry.type} ${entry.data.length}\0`, 'utf8'), entry.data])),
    ...entry,
  }));
  return { objects, consumed: pos - offset };
}

function writeResolved(local: Map<string, GitObject>, type: ObjectType, data: Buffer): string {
  const sha = sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
  local.set(sha, { type, data });
  return sha;
}

/** Store every object of a parsed pack (used by receive-pack). */
export function storePackObjects(pack: ParsedPack): void {
  for (const obj of pack.objects) {
    if (!store.objects.has(obj.sha)) {
      store.objects.set(obj.sha, { type: obj.type, data: obj.data });
    }
  }
  store.markDirty();
}

// ---------------------------------------------------------------- diffs & merges

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  return data[data.length - 1] === 0x0a ? count : count + 1;
}

function isText(data: Buffer): boolean {
  return !data.includes(0);
}

/** Line-level change counts between two blob versions (LCS over lines, capped). */
function diffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData !== null) return { additions: isText(newData) ? lineCount(newData) : 1, deletions: 0 };
  if (newData === null && oldData !== null) return { additions: 0, deletions: isText(oldData) ? lineCount(oldData) : 1 };
  if (oldData === null || newData === null) return { additions: 0, deletions: 0 };
  if (oldData.equals(newData)) return { additions: 0, deletions: 0 };
  if (!isText(oldData) || !isText(newData)) return { additions: 1, deletions: 1 };
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  // LCS via dynamic programming; files in this forge are small.
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}

/** The changed files between two trees (either may be null = empty). */
export function diffTrees(baseTree: string | null, headTree: string | null): FileChange[] {
  const baseFiles = flattenTree(baseTree);
  const headFiles = flattenTree(headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const oldData = before !== undefined ? (readObject(before.sha)?.data ?? null) : null;
    const newData = after !== undefined ? (readObject(after.sha)?.data ?? null) : null;
    const { additions, deletions } = diffCounts(oldData, newData);
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/**
 * Three-way tree merge. Returns the merged tree sha, or null on conflict
 * (both sides changed the same entry differently, or delete-vs-modify).
 */
export function mergeTrees(baseTree: string | null, ourTree: string | null, theirTree: string | null): string | null {
  const read = (sha: string | null): TreeEntry[] => {
    if (sha === null) return [];
    const obj = readObject(sha);
    return obj !== null && obj.type === 'tree' ? parseTree(obj.data) : [];
  };
  const byName = (entries: TreeEntry[]): Map<string, TreeEntry> => new Map(entries.map((e) => [e.name, e]));
  const base = byName(read(baseTree));
  const ours = byName(read(ourTree));
  const theirs = byName(read(theirTree));
  const names = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged: TreeEntry[] = [];
  const same = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.sha === b.sha && a.mode === b.mode;
  for (const name of names) {
    const b = base.get(name);
    const o = ours.get(name);
    const t = theirs.get(name);
    if (same(o, t)) {
      if (o !== undefined) merged.push(o);
      continue;
    }
    if (same(b, o)) {
      if (t !== undefined) merged.push(t);
      continue;
    }
    if (same(b, t)) {
      if (o !== undefined) merged.push(o);
      continue;
    }
    // Both sides changed this entry differently.
    if (o !== undefined && t !== undefined && o.mode === '40000' && t.mode === '40000') {
      const sub = mergeTrees(b !== undefined && b.mode === '40000' ? b.sha : null, o.sha, t.sha);
      if (sub === null) return null;
      merged.push({ mode: '40000', name, sha: sub });
      continue;
    }
    return null;
  }
  return writeTree(merged);
}
