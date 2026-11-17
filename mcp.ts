// mcp.ts — the MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP. Speaks the
// 2026-07-28 revision (server/discover, no handshake, no session) and the legacy
// initialize handshake. Tools are the github-mcp-server shapes over the shared store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, VIEWER, type RepoRecord } from './store.ts';

const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PREFERRED_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).map(([key, text]) => [key, { type: key === 'private' ? 'boolean' : key === 'pull_number' || key === 'issue_number' ? 'integer' : 'string', description: text }])),
      required,
    },
  };
}

/** The tool list is a constant: two tools/list calls answer byte-for-byte identical. */
const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user', {
    name: 'Repository name',
    description: 'Repository description',
    private: 'Whether the repository is private',
    owner: 'Repository owner login (defaults to the authenticated user)',
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name', {
    owner: 'Repository owner login',
    repo: 'Repository name',
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    title: 'Issue title',
    body: 'Issue body',
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    state: 'Issue state filter: open, closed or all',
  }, ['owner', 'repo']),
  tool('get_issue', 'Get one issue by number', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    issue_number: 'Issue number',
  }, ['owner', 'repo', 'issue_number']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    title: 'Pull request title',
    body: 'Pull request body',
    head: 'Head branch name',
    base: 'Base branch name',
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('list_pull_requests', 'List the pull requests of a repository', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    state: 'Pull request state filter: open, closed or all',
  }, ['owner', 'repo']),
  tool('merge_pull_request', 'Merge a pull request by number', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    pull_number: 'Pull request number',
    merge_method: 'Merge method: merge, squash or rebase',
  }, ['owner', 'repo', 'pull_number']),
];

// The domain operations and serializers are shared with the REST surface.
import { createIssue as createIssueRecord, createPull as createPullRecord, mergePull as mergePullRecord, pullObject as pullObjectFn, repoObject as repoObjectFn, issueObject as issueObjectFn } from './rest.ts';

function findRepo(args: Record<string, unknown>): RepoRecord | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return store.getRepo(owner, repo);
}

interface ToolOutcome {
  value?: unknown;
  error?: string;
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome | null {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (repoName === '') return { error: 'name is required' };
      const existing = store.getRepo(VIEWER.login, repoName);
      if (existing !== null) return { value: repoObjectFn(existing) };
      const repo = store.createRepo(VIEWER.login, repoName, String(args.description ?? ''), args.private === true);
      return { value: repoObjectFn(repo) };
    }
    case 'get_repo': {
      const repo = findRepo(args);
      if (repo === null) return { error: 'repository not found' };
      return { value: repoObjectFn(repo) };
    }
    case 'create_issue': {
      const repo = findRepo(args);
      if (repo === null) return { error: 'repository not found' };
      const issue = createIssueRecord(repo, String(args.title ?? ''), String(args.body ?? ''), []);
      return { value: issueObjectFn(repo, issue) };
    }
    case 'list_issues': {
      const repo = findRepo(args);
      if (repo === null) return { error: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      return { value: issues.map((issue) => issueObjectFn(repo, issue)) };
    }
    case 'get_issue': {
      const repo = findRepo(args);
      if (repo === null) return { error: 'repository not found' };
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { error: 'issue not found' };
      return { value: issueObjectFn(repo, issue) };
    }
    case 'create_pull_request': {
      const repo = findRepo(args);
      if (repo === null) return { error: 'repository not found' };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (existing !== undefined) return { value: pullObjectFn(repo, existing) };
      const pull = createPullRecord(repo, String(args.title ?? ''), String(args.body ?? ''), head, base);
      if (pull === null) return { error: 'the head or base branch does not exist' };
      return { value: pullObjectFn(repo, pull) };
    }
    case 'list_pull_requests': {
      const repo = findRepo(args);
      if (repo === null) return { error: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      return { value: pulls.map((pull) => pullObjectFn(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(args);
      if (repo === null) return { error: 'repository not found' };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { error: 'pull request not found' };
      const method = typeof args.merge_method === 'string' ? args.merge_method.toLowerCase() : 'merge';
      const outcome = mergePullRecord(repo, pull, method);
      if (!outcome.ok) return { error: outcome.reason ?? 'pull request is not mergeable' };
      return { value: pullObjectFn(repo, pull) };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function result(id: unknown, value: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function dispatch(message: Record<string, unknown>): RpcResponse | null {
  const id = message.id ?? null;
  const method = String(message.method ?? '');
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  const isNotification = message.id === undefined;
  switch (method) {
    case 'server/discover':
      return result(id, {
        protocolVersion: PREFERRED_VERSION,
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result(id, {
        protocolVersion: negotiated,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const def = TOOLS.find((entry) => entry.name === toolName);
      if (def === undefined) return rpcError(id, -32602, `unknown tool: ${toolName === '' ? '(missing name)' : toolName}`);
      const missing = def.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return result(id, {
          content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        });
      }
      const outcome = callTool(toolName, args);
      if (outcome === null) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      if (outcome.error !== undefined) {
        return result(id, { content: [{ type: 'text', text: outcome.error }], isError: true });
      }
      const text = JSON.stringify(outcome.value);
      return result(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.value,
        isError: false,
      });
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

function sendBody(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Handle one POST /mcp. Authentication is the router's job (401 before this runs). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    sendBody(res, 400, rpcError(null, -32700, 'Parse error: the body is not JSON'));
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => (typeof entry === 'object' && entry !== null ? dispatch(entry as Record<string, unknown>) : null))
      .filter((entry) => entry !== null);
    sendBody(res, 200, responses);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendBody(res, 400, rpcError(null, -32600, 'Invalid request'));
    return;
  }
  const response = dispatch(parsed as Record<string, unknown>);
  if (response === null) {
    // A notification: accepted, no body.
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  sendBody(res, 200, response);
}
