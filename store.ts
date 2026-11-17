// store.ts — the one store every surface (git, REST, GraphQL, MCP) reads and writes.
//
// In-memory Maps are authoritative (the trial's hot paths are latency-scored); a JSON
// snapshot is written behind mutations (debounced, atomic rename) so the forge keeps
// its state on disk without paying a disk flush per request. A read-only data dir is
// tolerated silently: the server keeps serving from memory.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The forge's one user: any non-empty bearer token authenticates as this login. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'Ada Iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const ZERO_SHA = '0000000000000000000000000000000000000000';

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface LabelRecord {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRecord {
  id: number;
  issueNumber: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: CommentRecord[];
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Tip snapshots: refreshed from the refs while the branches live, kept after. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeMethod: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Full ref name (refs/heads/…, refs/tags/…) -> object sha. */
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  /** Issues and pull requests share one per-repo number sequence, as on GitHub. */
  nextNumber: number;
}

interface Snapshot {
  version: 1;
  clock: number;
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  objects: Record<string, { type: GitObject['type']; data: string }>;
  repos: Array<Omit<RepoRecord, 'refs' | 'labels' | 'issues' | 'pulls'> & {
    refs: Array<[string, string]>;
    labels: LabelRecord[];
    issues: IssueRecord[];
    pulls: PullRecord[];
  }>;
}

const DATA_DIR = process.env.FORGE_DATA_DIR ?? join(tmpdir(), 'github-core-clone-forge');
const SNAPSHOT_PATH = join(DATA_DIR, 'state.json');

/** Logical clock: a fixed base plus one second per tick, so created_at ordering is
 *  strictly monotonic in mutation order and never depends on the wall clock. */
const CLOCK_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, RepoRecord>();
  private clockTicks = 0;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.load();
  }

  /** Current logical time as an ISO string; every call advances the clock. */
  now(): string {
    this.clockTicks += 1;
    return new Date(CLOCK_BASE_MS + this.clockTicks * 1000).toISOString();
  }

  /** Current logical time as unix seconds (for git author/committer lines). */
  nowSeconds(): number {
    return Math.floor(CLOCK_BASE_MS / 1000) + this.clockTicks;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRecord | null {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRecord {
    const ts = this.now();
    const repo: RepoRecord = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: ts,
      updatedAt: ts,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    this.markDirty();
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const gone = this.repos.delete(this.repoKey(owner, name));
    if (gone) this.markDirty();
    return gone;
  }

  reposOf(owner: string): RepoRecord[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }

  allocIssueId(): number {
    return this.nextIssueId++;
  }

  allocPullId(): number {
    return this.nextPullId++;
  }

  allocCommentId(): number {
    return this.nextCommentId++;
  }

  markDirty(): void {
    this.dirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
    }, 200);
    this.saveTimer.unref?.();
  }

  /** Write the JSON snapshot now (best effort; failures never break the server). */
  save(): void {
    this.dirty = false;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const snapshot: Snapshot = {
        version: 1,
        clock: this.clockTicks,
        nextRepoId: this.nextRepoId,
        nextIssueId: this.nextIssueId,
        nextPullId: this.nextPullId,
        nextCommentId: this.nextCommentId,
        objects: Object.fromEntries(
          [...this.objects.entries()].map(([sha, obj]) => [sha, { type: obj.type, data: obj.data.toString('base64') }]),
        ),
        repos: [...this.repos.values()].map((r) => ({
          id: r.id,
          owner: r.owner,
          name: r.name,
          description: r.description,
          isPrivate: r.isPrivate,
          defaultBranch: r.defaultBranch,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          nextNumber: r.nextNumber,
          refs: [...r.refs.entries()],
          labels: [...r.labels.values()],
          issues: [...r.issues.values()],
          pulls: [...r.pulls.values()],
        })),
      };
      const tmp = `${SNAPSHOT_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot));
      renameSync(tmp, SNAPSHOT_PATH);
    } catch {
      // A read-only or vanished data dir must never take the forge down.
    }
  }

  private load(): void {
    try {
      if (!existsSync(SNAPSHOT_PATH)) return;
      const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
      if (snapshot.version !== 1) return;
      this.clockTicks = snapshot.clock;
      this.nextRepoId = snapshot.nextRepoId;
      this.nextIssueId = snapshot.nextIssueId;
      this.nextPullId = snapshot.nextPullId;
      this.nextCommentId = snapshot.nextCommentId;
      for (const [sha, obj] of Object.entries(snapshot.objects)) {
        this.objects.set(sha, { type: obj.type, data: Buffer.from(obj.data, 'base64') });
      }
      for (const r of snapshot.repos) {
        const repo: RepoRecord = {
          ...r,
          refs: new Map(r.refs),
          labels: new Map(r.labels.map((l) => [l.name, l])),
          issues: new Map(r.issues.map((i) => [i.number, i])),
          pulls: new Map(r.pulls.map((p) => [p.number, p])),
        };
        this.repos.set(this.repoKey(repo.owner, repo.name), repo);
      }
    } catch {
      // A corrupt snapshot starts the forge empty rather than crashing the boot.
    }
  }
}

/** The process-wide store instance. */
export const store = new Store();

/** Relay-style global id: base64 of "Type:databaseId", opaque and stable. */
export function globalId(type: string, databaseId: number): string {
  return Buffer.from(`${type}:${databaseId}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and database id, or null when malformed. */
export function parseGlobalId(id: string): { type: string; databaseId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1], databaseId: Number(match[2]) };
  } catch {
    return null;
  }
}
