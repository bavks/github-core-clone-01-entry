// graphql.ts — the GraphQL v4 surface at /api/graphql: a small parser and executor
// covering the query/mutation shapes gh and the github-mcp-server send — viewer,
// repository, issues and pull requests with Relay global ids, cursor pagination,
// batched operations, and __type/__schema introspection — over the shared store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalId, parseGlobalId, store, VIEWER, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';
import { createIssue, createPull, mergePull, pullMergeable } from './rest.ts';
import { commitTree, diffTrees, mergeBase, resolveCommit } from './git.ts';
import { sendJson } from './rest.ts';

// ---------------------------------------------------------------- lexer & parser

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  selections: SelectionNode[];
  directives: Array<{ name: string; args: Record<string, Value> }>;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Record<string, Value>;
  selections: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, SelectionNode[]>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (match !== null) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character "${ch}" in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    return token;
  }

  private expect(token: string): void {
    const found = this.next();
    if (found !== token) throw new Error(`expected "${token}", found "${found}"`);
  }

  private skipTypeRef(): void {
    if (this.peek() === '[') {
      this.next();
      this.skipTypeRef();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: {}, selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') name = this.next();
        const variableDefaults: Record<string, Value> = {};
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            this.skipTypeRef();
            if (this.peek() === '=') {
              this.next();
              variableDefaults[varName] = this.parseValue();
            }
            this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        operations.push({ type, name, variableDefaults, selections: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // the type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token "${head}"`);
      }
    }
    return { operations, fragments };
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          this.next();
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.next();
        alias = first;
        name = this.next();
      }
      const args: Record<string, Value> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.expect(')');
      }
      const directives: FieldNode['directives'] = [];
      while (this.peek() === '@') {
        this.next();
        const dirName = this.next();
        const dirArgs: Record<string, Value> = {};
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            const argName = this.next();
            this.expect(':');
            dirArgs[argName] = this.parseValue();
          }
          this.expect(')');
        }
        directives.push({ name: dirName, args: dirArgs });
      }
      const sub = this.peek() === '{' ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', field: { name, alias, args, selections: sub, directives } });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d+/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

/** Resolve a parsed argument value against the operation's variables. */
function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return variables[value.name];
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(value.fields)) out[key] = valueOf(sub, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema registry

type Source = Record<string, unknown> & { __typename: string };

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  fields?: Record<string, { type: string; args?: Record<string, string> }>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
}

const TYPES: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!' },
      repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
      node: { type: 'Node', args: { id: 'ID!' } },
      user: { type: 'User', args: { login: 'String!' } },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } } },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      login: { type: 'String!' },
      name: { type: 'String' },
      email: { type: 'String' },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int!' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'User!' },
      description: { type: 'String' },
      isPrivate: { type: 'Boolean!' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean!' },
      defaultBranchRef: { type: 'Ref' },
      url: { type: 'String!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      issue: { type: 'Issue', args: { number: 'Int!' } },
      issues: {
        type: 'IssueConnection!',
        args: { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' },
      },
      pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
      pullRequests: {
        type: 'PullRequestConnection!',
        args: { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[PullRequestState!]' },
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      name: { type: 'String!' },
      prefix: { type: 'String!' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      state: { type: 'IssueState!' },
      url: { type: 'String!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      author: { type: 'User' },
      labels: { type: '[Label!]' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]' },
      edges: { type: '[IssueEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String!' } } },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      mergedAt: { type: 'DateTime' },
      mergeable: { type: 'MergeableState!' },
      headRefName: { type: 'String!' },
      baseRefName: { type: 'String!' },
      headRef: { type: 'Ref' },
      baseRef: { type: 'Ref' },
      url: { type: 'String!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      author: { type: 'User' },
      files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int', after: 'String' } },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]' },
      edges: { type: '[PullRequestEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String!' } } },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String!' },
      additions: { type: 'Int!' },
      deletions: { type: 'Int!' },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      name: { type: 'String!' },
      color: { type: 'String!' },
      description: { type: 'String' },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int!' },
      body: { type: 'String!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      author: { type: 'User' },
    },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, issue: { type: 'Issue' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, pullRequest: { type: 'PullRequest' } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { clientMutationId: { type: 'String' }, commentEdge: { type: 'CommentEdge' }, subject: { type: 'Node' } } },
  CommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String!' } } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField', direction: 'OrderDirection' } },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' } },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', clientMutationId: 'String' } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', clientMutationId: 'String' },
  },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' } },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' } },
};

// ---------------------------------------------------------------- sources

function userSource(): Source {
  return { __typename: 'User' };
}

function repoSource(repo: RepoRecord): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: RepoRecord, issue: IssueRecord): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: RepoRecord, pull: PullRecord): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function findIssueById(databaseId: number): { repo: RepoRecord; issue: IssueRecord } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === databaseId) return { repo, issue };
  }
  return null;
}

function findPullById(databaseId: number): { repo: RepoRecord; pull: PullRecord } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === databaseId) return { repo, pull };
  }
  return null;
}

function findRepoById(databaseId: number): RepoRecord | null {
  for (const repo of store.repos.values()) if (repo.id === databaseId) return repo;
  return null;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string): number {
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match !== null ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface Connection {
  sources: Source[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

/** Slice an ordered item list by first/after into a Relay connection shape. */
function connect(typeName: string, items: Source[], args: Record<string, unknown>): Source {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string') start = indexOfCursor(args.after) + 1;
  const slice = items.slice(start, start + first);
  const connection: Connection = {
    sources: slice,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
    },
    totalCount: items.length,
  };
  return { __typename: typeName, connection, startIndex: start };
}

// ---------------------------------------------------------------- introspection types in the registry

TYPES.__Type = {
  kind: 'OBJECT',
  fields: {
    kind: { type: 'String!' },
    name: { type: 'String' },
    description: { type: 'String' },
    fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' } },
    enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' } },
    inputFields: { type: '[__InputValue!]' },
    ofType: { type: '__Type' },
    possibleTypes: { type: '[__Type!]' },
  },
};
TYPES.__Field = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!' },
    description: { type: 'String' },
    args: { type: '[__InputValue!]!' },
    type: { type: '__Type!' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
};
TYPES.__InputValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!' },
    description: { type: 'String' },
    type: { type: '__Type!' },
    defaultValue: { type: 'String' },
  },
};
TYPES.__EnumValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String!' },
    description: { type: 'String' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
};
TYPES.__Schema = {
  kind: 'OBJECT',
  fields: {
    types: { type: '[__Type!]!' },
    queryType: { type: '__Type!' },
    mutationType: { type: '__Type' },
    subscriptionType: { type: '__Type' },
    directives: { type: '[String!]!' },
  },
};

// ---------------------------------------------------------------- resolvers

type Resolver = (source: Source, args: Record<string, unknown>) => unknown;

function connectionResolvers(edgeType: string): Record<string, Resolver> {
  return {
    nodes: (source) => (source.connection as Connection).sources,
    edges: (source) => {
      const connection = source.connection as Connection;
      return connection.sources.map((node, i) => ({
        __typename: edgeType,
        node,
        cursor: cursorOf((source.startIndex as number) + i),
      }));
    },
    pageInfo: (source) => ({ __typename: 'PageInfo', ...(source.connection as Connection).pageInfo }),
    totalCount: (source) => (source.connection as Connection).totalCount,
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userSource(),
    user: () => userSource(),
    repository: (_source, args) => {
      const repo = store.getRepo(String(args.owner), String(args.name));
      return repo !== null ? repoSource(repo) : null;
    },
    node: (_source, args) => {
      const parsed = parseGlobalId(String(args.id));
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = findRepoById(parsed.databaseId);
        return repo !== null ? repoSource(repo) : null;
      }
      if (parsed.type === 'Issue') {
        const found = findIssueById(parsed.databaseId);
        return found !== null ? issueSource(found.repo, found.issue) : null;
      }
      if (parsed.type === 'PullRequest') {
        const found = findPullById(parsed.databaseId);
        return found !== null ? pullSource(found.repo, found.pull) : null;
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId));
      const repo = parsed !== null && parsed.type === 'Repository' ? findRepoById(parsed.databaseId) : null;
      if (repo === null) throw new Error('repository not found');
      const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_source, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId));
      const found = parsed !== null ? findIssueById(parsed.databaseId) : null;
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updatedAt = store.now();
      store.markDirty();
      return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_source, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId));
      const repo = parsed !== null && parsed.type === 'Repository' ? findRepoById(parsed.databaseId) : null;
      if (repo === null) throw new Error('repository not found');
      const pull = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName), String(input.baseRefName));
      if (pull === null) throw new Error('the head or base branch does not exist');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_source, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId));
      const found = parsed !== null ? findPullById(parsed.databaseId) : null;
      if (found === null) throw new Error('pull request not found');
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      mergePull(found.repo, found.pull, method);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_source, args) => {
      const input = args.input as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId));
      const found = parsed !== null ? findIssueById(parsed.databaseId) : null;
      if (found === null) throw new Error('subject not found');
      const ts = store.now();
      const comment = { id: store.allocCommentId(), issueNumber: found.issue.number, body: String(input.body ?? ''), createdAt: ts, updatedAt: ts };
      found.issue.comments.push(comment);
      found.issue.updatedAt = ts;
      store.markDirty();
      const commentSource: Source = { __typename: 'IssueComment', comment };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: commentSource, cursor: cursorOf(0) },
        subject: issueSource(found.repo, found.issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    id: () => globalId('User', VIEWER.id),
    databaseId: () => VIEWER.id,
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (source) => globalId('Repository', (source.repo as RepoRecord).id),
    databaseId: (source) => (source.repo as RepoRecord).id,
    name: (source) => (source.repo as RepoRecord).name,
    nameWithOwner: (source) => `${(source.repo as RepoRecord).owner}/${(source.repo as RepoRecord).name}`,
    owner: () => userSource(),
    description: (source) => (source.repo as RepoRecord).description,
    isPrivate: (source) => (source.repo as RepoRecord).isPrivate,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (source) => {
      const repo = source.repo as RepoRecord;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    },
    url: (source) => `https://forge.local/${(source.repo as RepoRecord).owner}/${(source.repo as RepoRecord).name}`,
    createdAt: (source) => (source.repo as RepoRecord).createdAt,
    updatedAt: (source) => (source.repo as RepoRecord).updatedAt,
    issue: (source, args) => {
      const repo = source.repo as RepoRecord;
      const issue = repo.issues.get(Number(args.number));
      return issue !== undefined ? issueSource(repo, issue) : null;
    },
    issues: (source, args) => {
      const repo = source.repo as RepoRecord;
      let issues = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set((args.states as string[]).map((s) => s.toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const field = String(orderBy.field ?? 'CREATED_AT');
      const direction = String(orderBy.direction ?? 'DESC');
      issues.sort((a, b) => {
        const diff = field === 'UPDATED_AT' ? a.updatedAt.localeCompare(b.updatedAt) || a.number - b.number : a.number - b.number;
        return direction === 'ASC' ? diff : -diff;
      });
      return connect('IssueConnection', issues.map((issue) => issueSource(repo, issue)), args);
    },
    pullRequest: (source, args) => {
      const repo = source.repo as RepoRecord;
      const pull = repo.pulls.get(Number(args.number));
      return pull !== undefined ? pullSource(repo, pull) : null;
    },
    pullRequests: (source, args) => {
      const repo = source.repo as RepoRecord;
      let pulls = [...repo.pulls.values()];
      const stateOf = (pull: PullRecord): string => (pull.merged ? 'MERGED' : pull.state.toUpperCase());
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states as string[]);
        pulls = pulls.filter((pull) => wanted.has(stateOf(pull)));
      }
      pulls.sort((a, b) => b.number - a.number);
      return connect('PullRequestConnection', pulls.map((pull) => pullSource(repo, pull)), args);
    },
  },
  Ref: {
    id: (source) => Buffer.from(`Ref:${String(source.name)}`, 'utf8').toString('base64'),
    name: (source) => source.name,
    prefix: () => 'refs/heads/',
  },
  Issue: {
    id: (source) => globalId('Issue', (source.issue as IssueRecord).id),
    databaseId: (source) => (source.issue as IssueRecord).id,
    number: (source) => (source.issue as IssueRecord).number,
    title: (source) => (source.issue as IssueRecord).title,
    body: (source) => (source.issue as IssueRecord).body,
    state: (source) => (source.issue as IssueRecord).state.toUpperCase(),
    url: (source) => `https://forge.local/${(source.repo as RepoRecord).owner}/${(source.repo as RepoRecord).name}/issues/${(source.issue as IssueRecord).number}`,
    createdAt: (source) => (source.issue as IssueRecord).createdAt,
    updatedAt: (source) => (source.issue as IssueRecord).updatedAt,
    author: () => userSource(),
    labels: (source) => {
      const repo = source.repo as RepoRecord;
      return (source.issue as IssueRecord).labels.map((name) => ({
        __typename: 'Label',
        labelName: name,
        labelColor: repo.labels.get(name)?.color ?? '000000',
        labelDescription: repo.labels.get(name)?.description ?? null,
      }));
    },
  },
  Label: {
    id: (source) => Buffer.from(`Label:${String(source.labelName)}`, 'utf8').toString('base64'),
    name: (source) => source.labelName,
    color: (source) => source.labelColor,
    description: (source) => source.labelDescription,
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source.pull as PullRecord).id),
    databaseId: (source) => (source.pull as PullRecord).id,
    number: (source) => (source.pull as PullRecord).number,
    title: (source) => (source.pull as PullRecord).title,
    body: (source) => (source.pull as PullRecord).body,
    state: (source) => {
      const pull = source.pull as PullRecord;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.pull as PullRecord).merged,
    mergedAt: (source) => (source.pull as PullRecord).mergedAt,
    mergeable: (source) => pullMergeable(source.repo as RepoRecord, source.pull as PullRecord),
    headRefName: (source) => (source.pull as PullRecord).headRef,
    baseRefName: (source) => (source.pull as PullRecord).baseRef,
    headRef: (source) => ({ __typename: 'Ref', name: (source.pull as PullRecord).headRef }),
    baseRef: (source) => ({ __typename: 'Ref', name: (source.pull as PullRecord).baseRef }),
    url: (source) => `https://forge.local/${(source.repo as RepoRecord).owner}/${(source.repo as RepoRecord).name}/pull/${(source.pull as PullRecord).number}`,
    createdAt: (source) => (source.pull as PullRecord).createdAt,
    updatedAt: (source) => (source.pull as PullRecord).updatedAt,
    author: () => userSource(),
    files: (source, args) => {
      const repo = source.repo as RepoRecord;
      const pull = source.pull as PullRecord;
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const baseCommit = resolveCommit(baseTip);
      const headCommit = resolveCommit(headTip);
      const ancestor = baseCommit !== null && headCommit !== null ? mergeBase(baseCommit, headCommit) : null;
      const changes = diffTrees(ancestor !== null ? commitTree(ancestor) : null, headCommit !== null ? commitTree(headCommit) : null);
      const nodes: Source[] = changes.map((change) => ({
        __typename: 'PullRequestChangedFile',
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
      }));
      return connect('PullRequestChangedFileConnection', nodes, args);
    },
  },
  PullRequestChangedFile: {
    path: (source) => source.path,
    additions: (source) => source.additions,
    deletions: (source) => source.deletions,
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', (source.comment as { id: number }).id),
    databaseId: (source) => (source.comment as { id: number }).id,
    body: (source) => (source.comment as { body: string }).body,
    createdAt: (source) => (source.comment as { createdAt: string }).createdAt,
    updatedAt: (source) => (source.comment as { updatedAt: string }).updatedAt,
    author: () => userSource(),
  },
  IssueConnection: connectionResolvers('IssueEdge'),
  PullRequestConnection: connectionResolvers('PullRequestEdge'),
  PullRequestChangedFileConnection: connectionResolvers('PullRequestChangedFileEdge'),
  IssueEdge: { node: (source) => source.node, cursor: (source) => source.cursor },
  PullRequestEdge: { node: (source) => source.node, cursor: (source) => source.cursor },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage,
    hasPreviousPage: (source) => source.hasPreviousPage,
    startCursor: (source) => source.startCursor,
    endCursor: (source) => source.endCursor,
  },
  CreateIssuePayload: { issue: (source) => source.issue, clientMutationId: (source) => source.clientMutationId ?? null },
  CloseIssuePayload: { issue: (source) => source.issue, clientMutationId: (source) => source.clientMutationId ?? null },
  CreatePullRequestPayload: { pullRequest: (source) => source.pullRequest, clientMutationId: (source) => source.clientMutationId ?? null },
  MergePullRequestPayload: { pullRequest: (source) => source.pullRequest, clientMutationId: (source) => source.clientMutationId ?? null },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge,
    subject: (source) => source.subject,
    clientMutationId: (source) => source.clientMutationId ?? null,
  },
  CommentEdge: { node: (source) => source.node, cursor: (source) => source.cursor },
  __Type: {
    kind: (source) => typeKind(source),
    name: (source) => typeName(source),
    description: () => null,
    fields: (source) => {
      const def = namedDef(source);
      if (def === undefined || def.fields === undefined) return null;
      return Object.entries(def.fields).map(([name, fieldDef]) => ({ __typename: '__Field', fieldName: name, fieldDef }));
    },
    enumValues: (source) => {
      const def = namedDef(source);
      if (def === undefined || def.enumValues === undefined) return null;
      return def.enumValues.map((name) => ({ __typename: '__EnumValue', enumName: name }));
    },
    inputFields: (source) => {
      const def = namedDef(source);
      if (def === undefined || def.inputFields === undefined) return null;
      return Object.entries(def.inputFields).map(([name, type]) => ({ __typename: '__InputValue', inputName: name, inputType: type }));
    },
    ofType: (source) => {
      const ref = source.__ref as TypeRef | undefined;
      if (ref === undefined || ref.kind === 'NAMED') return null;
      return typeRefSource(ref.of);
    },
    possibleTypes: (source) => {
      if (typeName(source) !== 'Node') return null;
      return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].map((name) => ({ __typename: '__Type', named: name }));
    },
  },
  __Field: {
    name: (source) => source.fieldName,
    description: () => null,
    args: (source) => {
      const fieldDef = source.fieldDef as { args?: Record<string, string> };
      return Object.entries(fieldDef.args ?? {}).map(([name, type]) => ({ __typename: '__InputValue', inputName: name, inputType: type }));
    },
    type: (source) => typeRefSource(parseTypeRef((source.fieldDef as { type: string }).type)),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __InputValue: {
    name: (source) => source.inputName,
    description: () => null,
    type: (source) => typeRefSource(parseTypeRef(String(source.inputType))),
    defaultValue: () => null,
  },
  __EnumValue: {
    name: (source) => source.enumName,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => Object.keys(TYPES).map((name) => ({ __typename: '__Type', named: name })),
    queryType: () => ({ __typename: '__Type', named: 'Query' }),
    mutationType: () => ({ __typename: '__Type', named: 'Mutation' }),
    subscriptionType: () => null,
    directives: () => [],
  },
};

// ---------------------------------------------------------------- type references

type TypeRef = { kind: 'NAMED'; name: string } | { kind: 'LIST'; of: TypeRef } | { kind: 'NON_NULL'; of: TypeRef };

function parseTypeRef(text: string): TypeRef {
  const trimmed = text.trim();
  if (trimmed.endsWith('!')) return { kind: 'NON_NULL', of: parseTypeRef(trimmed.slice(0, -1)) };
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return { kind: 'LIST', of: parseTypeRef(trimmed.slice(1, -1)) };
  return { kind: 'NAMED', name: trimmed };
}

function typeRefSource(ref: TypeRef): Source {
  return { __typename: '__Type', __ref: ref };
}

function typeName(source: Source): string | null {
  const ref = source.__ref as TypeRef | undefined;
  if (ref !== undefined) return ref.kind === 'NAMED' ? ref.name : null;
  return String(source.named ?? '');
}

function typeKind(source: Source): string {
  const ref = source.__ref as TypeRef | undefined;
  if (ref !== undefined) {
    if (ref.kind === 'LIST') return 'LIST';
    if (ref.kind === 'NON_NULL') return 'NON_NULL';
    return TYPES[ref.name]?.kind ?? 'SCALAR';
  }
  return TYPES[String(source.named)]?.kind ?? 'OBJECT';
}

function namedDef(source: Source): TypeDef | undefined {
  const name = typeName(source);
  return name !== null ? TYPES[name] : undefined;
}

// ---------------------------------------------------------------- executor

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

function directiveAllows(field: FieldNode, ctx: ExecCtx): boolean {
  for (const directive of field.directives) {
    if (directive.name === 'skip' && valueOf(directive.args.if, ctx.variables) === true) return false;
    if (directive.name === 'include' && valueOf(directive.args.if, ctx.variables) === false) return false;
  }
  return true;
}

function executeSelectionSet(typeName: string, source: Source, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const runtimeType = source.__typename ?? typeName;
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === runtimeType || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selections, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(typeName, source, fragment, ctx));
      continue;
    }
    const field = selection.field;
    if (!directiveAllows(field, ctx)) continue;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = runtimeType;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(field.args)) args[argName] = valueOf(argValue, ctx.variables);
    if (field.name === '__type' && typeName === 'Query') {
      const name = String(args.name ?? '');
      out[key] = TYPES[name] !== undefined ? completeValue('__Type', { __typename: '__Type', named: name }, field.selections, ctx) : null;
      continue;
    }
    if (field.name === '__schema' && typeName === 'Query') {
      out[key] = completeValue('__Schema', { __typename: '__Schema' }, field.selections, ctx);
      continue;
    }
    const fieldDef = TYPES[typeName]?.fields?.[field.name] ?? TYPES[runtimeType]?.fields?.[field.name];
    const resolver = RESOLVERS[typeName]?.[field.name] ?? RESOLVERS[runtimeType]?.[field.name];
    if (fieldDef === undefined && resolver === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    try {
      const raw = resolver !== undefined ? resolver(source, args) : (source as Record<string, unknown>)[field.name];
      out[key] = completeValue(fieldDef?.type ?? 'String', raw, field.selections, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

function completeValue(typeText: string, value: unknown, selections: SelectionNode[], ctx: ExecCtx): unknown {
  return completeRef(parseTypeRef(typeText), value, selections, ctx);
}

function completeRef(ref: TypeRef, value: unknown, selections: SelectionNode[], ctx: ExecCtx): unknown {
  if (ref.kind === 'NON_NULL') return completeRef(ref.of, value, selections, ctx);
  if (value === null || value === undefined) return null;
  if (ref.kind === 'LIST') {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => completeRef(ref.of, item, selections, ctx));
  }
  const def = TYPES[ref.name];
  if (def === undefined || def.kind === 'SCALAR') return ref.name === 'ID' ? String(value) : value;
  if (def.kind === 'ENUM') return value;
  const source = value as Source;
  const objectType = source.__typename ?? ref.name;
  return executeSelectionSet(objectType, source, selections, ctx);
}

// ---------------------------------------------------------------- HTTP handler

interface OperationRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOperation(request: OperationRequest): Record<string, unknown> {
  if (typeof request.query !== 'string') return { errors: [{ message: 'query must be a string' }] };
  let document: Document;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const variables: Record<string, unknown> = {};
  for (const [name, defaultValue] of Object.entries(operation.variableDefaults)) {
    variables[name] = valueOf(defaultValue, {});
  }
  if (typeof request.variables === 'object' && request.variables !== null) {
    Object.assign(variables, request.variables as Record<string, unknown>);
  }
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __typename: rootType }, operation.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql (single operation or a batched array of them). */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOperation(entry as OperationRequest)));
    return;
  }
  sendJson(res, 200, runOperation(parsed as OperationRequest));
}
