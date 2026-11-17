[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bavks/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bavks/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

One Node process, one store, four surfaces:

- **Git smart HTTP** — `info/refs`, `upload-pack` and `receive-pack` (protocol v0 and v2,
  shallow fetch/deepen, pack deltas in and out) implemented in-process on a hand-rolled
  SHA-1 object model. No `git` binary, no proxy, no outside service.
- **REST v3** — repositories, contents, git refs, labels, issues, comments and pull
  requests (including real three-way merges) under `/api/v3`.
- **GraphQL v4** — viewer, repository, issue and pull-request queries and mutations,
  Relay global ids, cursor pagination, batched operations and introspection at
  `/api/graphql`.
- **MCP** — the github-mcp-server tool surface (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`, …) as
  JSON-RPC 2.0 over Streamable HTTP at `/mcp`, speaking the 2026-07-28 revision
  (`server/discover`) and the legacy initialize handshake.

All four surfaces read and write the same in-memory store, snapshotted to disk
(JSON, write-behind) under `FORGE_DATA_DIR` (default: a `forge-data` directory under
the OS temp dir, so a read-only working directory never breaks the server).

## Run

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL (the trial lifecycle)
```

For local poking, import `createApp()` from `app.ts` and listen on any port; any
non-empty `Authorization: Bearer …` authenticates as the forge's one user.

## Layout

- `main.ts` — the entry ↔ env lifecycle (register the bound port, poll `/done`).
- `app.ts` — the HTTP server and router.
- `store.ts` — the shared store: repos, issues, pulls, labels, comments, persistence.
- `git.ts` — the git object model: hashing, trees, commits, packs, diffs, merges.
- `githttp.ts` — the smart-HTTP protocol (advertisement, ls-refs, fetch, push).
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — the GraphQL surface (parser, executor, introspection).
- `mcp.ts` — the MCP endpoint and its tools.
