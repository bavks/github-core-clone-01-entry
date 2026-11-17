// app.ts — the forge's HTTP server: one router over the four surfaces.
//   GET  /healthz                          the env's boot probe (no auth)
//   *    /api/v3/...                       REST v3 (rest.ts)
//   POST /api/graphql                      GraphQL v4 (graphql.ts)
//   POST /mcp                              MCP (mcp.ts)
//   *    /{owner}/{repo}.git/...           git smart HTTP (githttp.ts)
// Any non-empty Authorization header authenticates as the forge's one user;
// without one, every surface but /healthz answers 401. Every error is JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleRest, sendJson, sendError } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitRequest } from './githttp.ts';

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function authenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim() !== '';
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const isApi = path === '/api/v3' || path.startsWith('/api/v3/');
  const isGraphql = path === '/api/graphql';
  const isMcp = path === '/mcp';
  const gitMatch = GIT_PATH.exec(path);

  if (!isApi && !isGraphql && !isMcp && gitMatch === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!authenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  if (isApi) {
    const answered = await handleRest(req, res, url);
    if (!answered) sendError(res, 404, 'Not Found');
    return;
  }
  if (isGraphql) {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleGraphql(req, res);
    return;
  }
  if (isMcp) {
    if (method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
      res.end(`${JSON.stringify({ message: 'Method Not Allowed' })}\n`);
      return;
    }
    await handleMcp(req, res);
    return;
  }
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const name = decodeURIComponent(gitMatch[2]);
    const kind = gitMatch[3] as 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
    const repo = store.getRepo(owner, name);
    await handleGitRequest(req, res, repo, kind, url);
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    dispatch(req, res).catch(() => {
      // Never hang and never answer HTML: a JSON 500 is the worst case.
      try {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is already gone.
      }
    });
  });
}
