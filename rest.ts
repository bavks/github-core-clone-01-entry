// rest.ts — the REST v3 surface: repositories, contents, git refs, branches, commits,
// labels, issues, comments and pull requests, all over the shared store. Every reply
// is JSON with an X-GitHub-Request-Id header; errors are {"message": string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, VIEWER, ZERO_SHA, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';
import {
  ancestorDepths,
  buildTreeFromFiles,
  commitParents,
  commitTree,
  diffTrees,
  flattenTree,
  formatIdentity,
  makeCommit,
  mergeBase,
  mergeTrees,
  parseCommit,
  readObject,
  resolveCommit,
  writeObject,
} from './git.ts';
import { requestId } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function identity(): string {
  return formatIdentity(VIEWER.name, VIEWER.email, store.nowSeconds());
}

function userObject(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

// ---------------------------------------------------------------- serializers

export function repoObject(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function issueObject(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: label?.description ?? null };
    }),
    user: userObject(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function pullObject(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userObject(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commitObject(sha: string): Record<string, unknown> {
  const obj = readObject(sha);
  const info = obj !== null && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const identityParts = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: '', email: '', date: '' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha,
    commit: {
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? ZERO_SHA },
      author: identityParts(info?.author ?? ''),
      committer: identityParts(info?.committer ?? ''),
    },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
    author: userObject(),
    committer: userObject(),
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(url: URL): Page {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { perPage, page };
}

/** Slice a list for the page and build the Link header (absolute, same-origin). */
function paginate<T>(req: IncomingMessage, url: URL, items: T[]): { slice: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageOf(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { slice, headers };
}

// ---------------------------------------------------------------- domain helpers

/** Commit a set of file changes (path -> content, or null to delete) onto a branch. */
export function commitFiles(repo: RepoRecord, branch: string, changes: Map<string, Buffer | null>, message: string): string {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // A contents write names a branch that does not exist yet: start it from the
    // default branch's tip when there is one (the suite's PR-setup fallback relies
    // on this), else from an unborn state.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip !== undefined) repo.refs.set(ref, tip);
  }
  const parentTree = tip !== undefined ? commitTree(tip) : null;
  const files = new Map<string, string>();
  for (const [path, entry] of flattenTree(parentTree)) files.set(path, entry.sha);
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, writeObject('blob', content));
  }
  const tree = buildTreeFromFiles(files);
  const commit = makeCommit(tree, tip !== undefined ? [tip] : [], message, identity());
  repo.refs.set(ref, commit);
  repo.updatedAt = store.now();
  store.markDirty();
  return commit;
}

export interface MergeOutcome {
  ok: boolean;
  sha?: string;
  reason?: string;
}

/** Merge a pull request for real: a three-way tree merge against the merge-base. */
export function mergePull(repo: RepoRecord, pull: PullRecord, method: string): MergeOutcome {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef) ?? (pull.headSha !== ZERO_SHA ? pull.headSha : undefined);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'a branch is missing' };
  if (pull.merged) return { ok: false, reason: 'already merged' };
  const baseCommit = resolveCommit(baseTip);
  const headCommit = resolveCommit(headTip);
  if (baseCommit === null || headCommit === null) return { ok: false, reason: 'a branch tip is not a commit' };
  const base = mergeBase(baseCommit, headCommit);
  const baseTree = commitTree(baseCommit);
  const headTree = commitTree(headCommit);
  const ancestorTree = base !== null ? commitTree(base) : null;
  const mergedTree = mergeTrees(ancestorTree, baseTree, headTree);
  if (mergedTree === null) return { ok: false, reason: 'merge conflict' };

  let newTip: string;
  if (method === 'rebase') {
    // Replay the head's own commits onto the base, oldest first.
    const headAncestors = ancestorDepths(headCommit);
    const baseAncestors = ancestorDepths(baseCommit);
    const own = [...headAncestors.entries()]
      .filter(([sha]) => !baseAncestors.has(sha))
      .sort((a, b) => b[1] - a[1])
      .map(([sha]) => sha);
    let current = baseCommit;
    let currentTree = baseTree;
    for (const commit of own) {
      const parents = commitParents(commit);
      const parentTree = parents.length > 0 ? commitTree(parents[0]) : null;
      const tree = mergeTrees(parentTree, currentTree, commitTree(commit));
      if (tree === null) return { ok: false, reason: 'merge conflict' };
      const info = readObject(commit);
      const message = info !== null && info.type === 'commit' ? parseCommit(info.data).message : pull.title;
      current = makeCommit(tree, [current], message, identity());
      currentTree = tree;
    }
    newTip = own.length === 0 ? baseCommit : current;
    void currentTree;
  } else if (method === 'merge') {
    newTip = makeCommit(mergedTree, [baseCommit, headCommit], `Merge pull request #${pull.number}: ${pull.title}`, identity());
  } else {
    // Squash (the default): one commit on the base carrying the merged tree.
    newTip = makeCommit(mergedTree, [baseCommit], `${pull.title} (#${pull.number})`, identity());
  }

  repo.refs.set(baseRef, newTip);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.now();
  pull.mergeCommitSha = newTip;
  pull.mergeMethod = method;
  pull.updatedAt = store.now();
  repo.updatedAt = store.now();
  store.markDirty();
  return { ok: true, sha: newTip };
}

/** Create an issue record (shared by REST, GraphQL and MCP). */
export function createIssue(repo: RepoRecord, title: string, body: string, labels: string[]): IssueRecord {
  const ts = store.now();
  const issue: IssueRecord = {
    id: store.allocIssueId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdAt: ts,
    updatedAt: ts,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  repo.updatedAt = ts;
  store.markDirty();
  return issue;
}

/** Create a pull request record (shared by REST, GraphQL and MCP). */
export function createPull(repo: RepoRecord, title: string, body: string, headRef: string, baseRef: string): PullRecord | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const ts = store.now();
  const pull: PullRecord = {
    id: store.allocPullId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeMethod: null,
    createdAt: ts,
    updatedAt: ts,
  };
  repo.pulls.set(pull.number, pull);
  repo.updatedAt = ts;
  store.markDirty();
  return pull;
}

/** Whether a pull request's head still merges cleanly into its base. */
export function pullMergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const baseCommit = resolveCommit(baseTip);
  const headCommit = resolveCommit(headTip);
  if (baseCommit === null || headCommit === null) return 'UNKNOWN';
  const base = mergeBase(baseCommit, headCommit);
  const merged = mergeTrees(base !== null ? commitTree(base) : null, commitTree(baseCommit), commitTree(headCommit));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------- routing

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>) => Promise<void>;

function route(method: string, pattern: string, handler: Handler): { method: string; regex: RegExp; keys: string[]; handler: Handler } {
  const keys: string[] = [];
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':') && segment.endsWith('*')) {
          // A starred param swallows slashes (branch names, content paths).
          keys.push(segment.slice(1, -1));
          return '(.+)';
        }
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}$`,
  );
  return { method, regex, keys, handler };
}

const routes: Array<ReturnType<typeof route>> = [];

function on(method: string, pattern: string, handler: Handler): void {
  routes.push(route(method, pattern, handler));
}

function bodyString(value: Record<string, unknown>, key: string): string | undefined {
  const found = value[key];
  return typeof found === 'string' ? found : undefined;
}

function needRepo(res: ServerResponse, params: Record<string, string>): RepoRecord | null {
  const repo = store.getRepo(params.owner, params.repo);
  if (repo === null) sendError(res, 404, 'Not Found');
  return repo;
}

// --- meta & user

on('GET', '/api/v3', async (_req, res) => {
  sendJson(
    res,
    200,
    { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', user_repositories_url: '/api/v3/user/repos' },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
});

on('GET', '/api/v3/meta', async (_req, res) => {
  sendJson(res, 200, { installed_version: '1.0.0-forge', hooks: [], github_services: [] });
});

on('GET', '/api/v3/user', async (_req, res) => {
  sendJson(res, 200, userObject());
});

// --- repositories

on('POST', '/api/v3/user/repos', async (req, res) => {
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const name = bodyString(body.value, 'name');
  if (name === undefined || name === '') return sendError(res, 422, 'name is required');
  if (store.getRepo(VIEWER.login, name) !== null) {
    return sendError(res, 422, 'name already exists on this account');
  }
  const repo = store.createRepo(VIEWER.login, name, bodyString(body.value, 'description') ?? '', body.value.private === true);
  sendJson(res, 201, repoObject(repo));
});

on('GET', '/api/v3/user/repos', async (req, res, url) => {
  const { slice, headers } = paginate(req, url, store.reposOf(VIEWER.login).map(repoObject));
  sendJson(res, 200, slice, headers);
});

on('GET', '/api/v3/repos/:owner/:repo', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo !== null) sendJson(res, 200, repoObject(repo));
});

on('PATCH', '/api/v3/repos/:owner/:repo', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const description = bodyString(body.value, 'description');
  if (description !== undefined) repo.description = description;
  if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
  const name = bodyString(body.value, 'name');
  if (name !== undefined && name !== repo.name) {
    store.repos.delete(store.repoKey(repo.owner, repo.name));
    repo.name = name;
    store.repos.set(store.repoKey(repo.owner, repo.name), repo);
  }
  repo.updatedAt = store.now();
  store.markDirty();
  sendJson(res, 200, repoObject(repo));
});

on('DELETE', '/api/v3/repos/:owner/:repo', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  store.deleteRepo(params.owner, params.repo);
  res.writeHead(204, { 'x-github-request-id': requestId() });
  res.end();
});

// --- branches & refs

on('GET', '/api/v3/repos/:owner/:repo/branches', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  sendJson(res, 200, branches);
});

on('GET', '/api/v3/repos/:owner/:repo/branches/:branch*', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const sha = repo.refs.get(`refs/heads/${params.branch}`);
  if (sha === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, { name: params.branch, commit: commitObject(sha), protected: false });
});

on('POST', '/api/v3/repos/:owner/:repo/git/refs', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const ref = bodyString(body.value, 'ref');
  const sha = bodyString(body.value, 'sha');
  if (ref === undefined || sha === undefined) return sendError(res, 422, 'ref and sha are required');
  const target = readObject(sha);
  if (target === null) return sendError(res, 422, 'Object does not exist');
  if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
  repo.refs.set(ref, sha);
  repo.updatedAt = store.now();
  store.markDirty();
  sendJson(res, 201, { ref, node_id: ref, object: { sha, type: target.type } });
});

on('GET', '/api/v3/repos/:owner/:repo/git/refs', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const refs = [...repo.refs.entries()].map(([ref, sha]) => ({
    ref,
    object: { sha, type: readObject(sha)?.type ?? 'commit' },
  }));
  sendJson(res, 200, refs);
});

on('GET', '/api/v3/repos/:owner/:repo/git/refs/:kind/:name*', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const ref = `refs/${params.kind}/${params.name}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, { ref, object: { sha, type: readObject(sha)?.type ?? 'commit' } });
});

// --- commits

on('GET', '/api/v3/repos/:owner/:repo/commits', async (req, res, url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const shaParam = url.searchParams.get('sha');
  let tip: string | undefined;
  if (shaParam !== null && shaParam !== '') {
    tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? undefined;
    if (tip === undefined) {
      const resolved = resolveCommit(shaParam);
      tip = resolved !== null ? resolved : undefined;
    }
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  if (tip === undefined) return sendJson(res, 200, []);
  const commit = resolveCommit(tip);
  if (commit === null) return sendJson(res, 200, []);
  const depths = ancestorDepths(commit);
  const ordered = [...depths.entries()].sort((a, b) => a[1] - b[1]).map(([sha]) => sha);
  const { slice, headers } = paginate(req, url, ordered.map(commitObject));
  sendJson(res, 200, slice, headers);
});

on('GET', '/api/v3/repos/:owner/:repo/commits/:sha', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const obj = readObject(params.sha);
  if (obj === null || obj.type !== 'commit') return sendError(res, 404, 'Not Found');
  sendJson(res, 200, commitObject(params.sha));
});

// --- contents

on('GET', '/api/v3/repos/:owner/:repo/contents/:path*', async (_req, res, url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`);
  const tree = tip !== undefined ? commitTree(tip) : null;
  const files = flattenTree(tree);
  const path = params.path;
  const file = files.get(path);
  if (file !== undefined) {
    const data = readObject(file.sha)?.data ?? Buffer.alloc(0);
    return sendJson(res, 200, {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: file.sha,
      size: data.length,
      encoding: 'base64',
      content: data.toString('base64'),
    });
  }
  const prefix = `${path}/`;
  const entries: Array<Record<string, unknown>> = [];
  const seenDirs = new Set<string>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const firstSegment = rest.split('/')[0];
    if (rest.includes('/')) {
      if (seenDirs.has(firstSegment)) continue;
      seenDirs.add(firstSegment);
      entries.push({ type: 'dir', name: firstSegment, path: `${prefix}${firstSegment}`, sha: ZERO_SHA, size: 0 });
    } else {
      const data = readObject(entry.sha)?.data ?? Buffer.alloc(0);
      entries.push({ type: 'file', name: firstSegment, path: filePath, sha: entry.sha, size: data.length });
    }
  }
  if (entries.length === 0) return sendError(res, 404, 'Not Found');
  entries.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
  sendJson(res, 200, entries);
});

on('PUT', '/api/v3/repos/:owner/:repo/contents/:path*', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const message = bodyString(body.value, 'message');
  const contentB64 = bodyString(body.value, 'content');
  if (message === undefined || contentB64 === undefined) return sendError(res, 422, 'message and content are required');
  const branch = bodyString(body.value, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const tree = tip !== undefined ? commitTree(tip) : null;
  const existing = flattenTree(tree).get(params.path);
  const givenSha = bodyString(body.value, 'sha');
  if (existing !== undefined) {
    if (givenSha === undefined) return sendError(res, 422, 'sha is required when updating a file');
    if (givenSha !== existing.sha) return sendError(res, 409, 'The sha does not match the file on the branch');
  }
  const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const commit = commitFiles(repo, branch, new Map([[params.path, content]]), message);
  const blobSha = flattenTree(commitTree(commit)).get(params.path)?.sha ?? ZERO_SHA;
  sendJson(res, existing !== undefined ? 200 : 201, {
    content: { name: params.path.split('/').pop(), path: params.path, sha: blobSha, size: content.length, encoding: 'base64' },
    commit: { sha: commit },
  });
});

on('DELETE', '/api/v3/repos/:owner/:repo/contents/:path*', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const message = bodyString(body.value, 'message');
  const sha = bodyString(body.value, 'sha');
  if (message === undefined || sha === undefined) return sendError(res, 422, 'message and sha are required');
  const branch = bodyString(body.value, 'branch') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const tree = tip !== undefined ? commitTree(tip) : null;
  const existing = flattenTree(tree).get(params.path);
  if (existing === undefined) return sendError(res, 404, 'Not Found');
  if (existing.sha !== sha) return sendError(res, 409, 'The sha does not match the file on the branch');
  const commit = commitFiles(repo, branch, new Map([[params.path, null]]), message);
  sendJson(res, 200, { content: null, commit: { sha: commit } });
});

// --- labels

on('POST', '/api/v3/repos/:owner/:repo/labels', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const name = bodyString(body.value, 'name');
  if (name === undefined || name === '') return sendError(res, 422, 'name is required');
  if (repo.labels.has(name)) return sendError(res, 422, 'Label already exists');
  const label = {
    name,
    color: (bodyString(body.value, 'color') ?? '000000').replace(/^#/, ''),
    description: bodyString(body.value, 'description') ?? null,
  };
  repo.labels.set(name, label);
  store.markDirty();
  sendJson(res, 201, { id: name, name: label.name, color: label.color, description: label.description, default: false });
});

on('GET', '/api/v3/repos/:owner/:repo/labels', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description, default: false })));
});

// --- issues

on('POST', '/api/v3/repos/:owner/:repo/issues', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const title = bodyString(body.value, 'title');
  if (title === undefined || title === '') return sendError(res, 422, 'title is required');
  const labelNames: string[] = [];
  if (Array.isArray(body.value.labels)) {
    for (const entry of body.value.labels) {
      const name = typeof entry === 'string' ? entry : '';
      if (name === '' || !repo.labels.has(name)) return sendError(res, 422, `Label "${name}" does not exist on this repository`);
      labelNames.push(name);
    }
  }
  const issue = createIssue(repo, title, bodyString(body.value, 'body') ?? '', labelNames);
  sendJson(res, 201, issueObject(repo, issue));
});

on('GET', '/api/v3/repos/:owner/:repo/issues', async (req, res, url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const state = url.searchParams.get('state') ?? 'open';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
  issues.sort((a, b) => a.number - b.number);
  if (direction === 'desc') issues.reverse();
  const { slice, headers } = paginate(req, url, issues.map((i) => issueObject(repo, i)));
  sendJson(res, 200, slice, headers);
});

on('GET', '/api/v3/repos/:owner/:repo/issues/:number', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const issue = repo.issues.get(Number(params.number));
  if (issue === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, issueObject(repo, issue));
});

on('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const issue = repo.issues.get(Number(params.number));
  if (issue === undefined) return sendError(res, 404, 'Not Found');
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const state = bodyString(body.value, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = bodyString(body.value, 'title');
  if (title !== undefined) issue.title = title;
  const text = bodyString(body.value, 'body');
  if (text !== undefined) issue.body = text;
  if (Array.isArray(body.value.labels)) {
    const names: string[] = [];
    for (const entry of body.value.labels) {
      const name = typeof entry === 'string' ? entry : '';
      if (name === '' || !repo.labels.has(name)) return sendError(res, 422, `Label "${name}" does not exist on this repository`);
      names.push(name);
    }
    issue.labels = names;
  }
  issue.updatedAt = store.now();
  store.markDirty();
  sendJson(res, 200, issueObject(repo, issue));
});

on('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const issue = repo.issues.get(Number(params.number));
  if (issue === undefined) return sendError(res, 404, 'Not Found');
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const text = bodyString(body.value, 'body');
  if (text === undefined) return sendError(res, 422, 'body is required');
  const ts = store.now();
  const comment = { id: store.allocCommentId(), issueNumber: issue.number, body: text, createdAt: ts, updatedAt: ts };
  issue.comments.push(comment);
  issue.updatedAt = ts;
  store.markDirty();
  sendJson(res, 201, { id: comment.id, body: comment.body, user: userObject(), created_at: ts, updated_at: ts });
});

on('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const issue = repo.issues.get(Number(params.number));
  if (issue === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: userObject(), created_at: c.createdAt, updated_at: c.updatedAt })));
});

// --- pull requests

on('POST', '/api/v3/repos/:owner/:repo/pulls', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const title = bodyString(body.value, 'title');
  const head = bodyString(body.value, 'head');
  const base = bodyString(body.value, 'base');
  if (title === undefined || head === undefined || base === undefined) return sendError(res, 422, 'title, head and base are required');
  const headBranch = head.includes(':') ? head.split(':').pop()! : head;
  const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headBranch && p.baseRef === base);
  if (existing !== undefined) return sendError(res, 422, `A pull request already exists for ${headBranch} into ${base}`);
  const pull = createPull(repo, title, bodyString(body.value, 'body') ?? '', headBranch, base);
  if (pull === null) return sendError(res, 422, 'The head or base branch does not exist');
  sendJson(res, 201, pullObject(repo, pull));
});

on('GET', '/api/v3/repos/:owner/:repo/pulls', async (req, res, url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const state = url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  if (state === 'open' || state === 'closed') pulls = pulls.filter((p) => p.state === state);
  const { slice, headers } = paginate(req, url, pulls.map((p) => pullObject(repo, p)));
  sendJson(res, 200, slice, headers);
});

on('GET', '/api/v3/repos/:owner/:repo/pulls/:number', async (_req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const pull = repo.pulls.get(Number(params.number));
  if (pull === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, pullObject(repo, pull));
});

on('PATCH', '/api/v3/repos/:owner/:repo/pulls/:number', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const pull = repo.pulls.get(Number(params.number));
  if (pull === undefined) return sendError(res, 404, 'Not Found');
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const state = bodyString(body.value, 'state');
  if (state === 'open' || state === 'closed') pull.state = state;
  const title = bodyString(body.value, 'title');
  if (title !== undefined) pull.title = title;
  const text = bodyString(body.value, 'body');
  if (text !== undefined) pull.body = text;
  pull.updatedAt = store.now();
  store.markDirty();
  sendJson(res, 200, pullObject(repo, pull));
});

on('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', async (req, res, url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const pull = repo.pulls.get(Number(params.number));
  if (pull === undefined) return sendError(res, 404, 'Not Found');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseCommit = resolveCommit(baseTip);
  const headCommit = resolveCommit(headTip);
  const ancestor = baseCommit !== null && headCommit !== null ? mergeBase(baseCommit, headCommit) : null;
  const changes = diffTrees(ancestor !== null ? commitTree(ancestor) : null, headCommit !== null ? commitTree(headCommit) : null);
  const files = changes.map((change) => ({
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.changes,
  }));
  const { slice, headers } = paginate(req, url, files);
  sendJson(res, 200, slice, headers);
});

on('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', async (req, res, _url, params) => {
  const repo = needRepo(res, params);
  if (repo === null) return;
  const pull = repo.pulls.get(Number(params.number));
  if (pull === undefined) return sendError(res, 404, 'Not Found');
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
  const method = (bodyString(body.value, 'merge_method') ?? 'merge').toLowerCase();
  if (pull.state !== 'open' || pull.merged) return sendError(res, 405, 'Pull Request is not mergeable');
  const outcome = mergePull(repo, pull, method);
  if (!outcome.ok) return sendError(res, 405, outcome.reason === 'merge conflict' ? 'Merge conflict' : 'Pull Request is not mergeable');
  sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
});

// ---------------------------------------------------------------- dispatch

/** Handle one /api/v3 request. Returns true when a route answered. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '') || '/api/v3';
  for (const candidate of routes) {
    if (candidate.method !== req.method) continue;
    const match = candidate.regex.exec(path);
    if (match === null) continue;
    const params: Record<string, string> = {};
    candidate.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    // The contents path swallows slashes: re-derive it from the raw path.
    if (params.path !== undefined) {
      const marker = '/contents/';
      const at = path.indexOf(marker);
      if (at !== -1) params.path = decodeURIComponent(path.slice(at + marker.length));
    }
    await candidate.handler(req, res, url, params);
    return true;
  }
  return false;
}
