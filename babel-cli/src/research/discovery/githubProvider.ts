/**
 * research/discovery/githubProvider.ts — GitHub REST research provider
 *
 * Implements RepositoryResearchProvider against api.github.com. Host code
 * owns the credential: an optional token is supplied to the constructor
 * (never to a model), sent only in the Authorization header, and is
 * redacted from every error message. Discovery uses the Search and
 * recursive Tree APIs and tracks x-ratelimit-* response headers via the
 * mission's RateBudget.
 */

import { createHash } from 'node:crypto';
import type {
  RepositoryFile,
  RepositoryIdentity,
  RepositoryResearchProvider,
  RepositorySearchOptions,
  RepositorySearchPage,
  RepositoryTree,
  ResolvedRevision,
} from '../contracts.js';
import { RateBudget, RateBudgetExhaustedError, type RateLimitHeaders } from '../rateBudget.js';

const API_ROOT = 'https://api.github.com';

export interface GitHubProviderOptions {
  /** Host-owned token; never logged, never returned, never placed in errors. */
  token?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  rateBudget?: RateBudget;
  apiRoot?: string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function headersFrom(response: { headers: Headers }): RateLimitHeaders {
  const h = response.headers;
  const get = (name: string) => {
    const value = h.get(name);
    return value === null ? null : value;
  };
  return {
    'x-ratelimit-limit': get('x-ratelimit-limit'),
    'x-ratelimit-remaining': get('x-ratelimit-remaining'),
    'x-ratelimit-reset': get('x-ratelimit-reset'),
    'x-ratelimit-resource': get('x-ratelimit-resource'),
    'retry-after': get('retry-after'),
  };
}

/** Redact any token material that could leak into an error or trace. */
function redact(text: string, token?: string): string {
  if (!token) return text;
  return text.split(token).join('***');
}

interface GitHubRepoSearchItem {
  id: number;
  node_id: string;
  full_name: string;
  parent?: { id: number } | null;
  default_branch: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  pushed_at: string | null;
  license: { spdx_id: string | null } | null;
  fork: boolean;
}

export class GitHubResearchProvider implements RepositoryResearchProvider {
  readonly name = 'github';
  private readonly fetchImpl: typeof fetch;
  private readonly rateBudget: RateBudget;

  constructor(private readonly options: GitHubProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rateBudget = options.rateBudget ?? new RateBudget();
  }

  get budget(): RateBudget {
    return this.rateBudget;
  }

  private identityFrom(item: GitHubRepoSearchItem, observedAt: string): RepositoryIdentity {
    return {
      provider_repo_id: String(item.id),
      provider: 'github',
      observed_full_name: item.full_name,
      parent_provider_repo_id: item.parent ? String(item.parent.id) : null,
      default_branch: item.default_branch,
      observed_at: observedAt,
    };
  }

  async searchRepositories(query: string, options?: RepositorySearchOptions): Promise<RepositorySearchPage> {
    const qualifiers = options?.qualifiers ?? [];
    const q = [query, ...qualifiers].join(' ');
    const perPage = Math.min(options?.perPage ?? 50, 100);
    const url = `${this.options.apiRoot ?? API_ROOT}/search/repositories?q=${encodeURIComponent(q)}&per_page=${perPage}`;
    const json = await this.request<GITHUB_SEARCH_RESPONSE>('search', url);
    const observedAt = new Date().toISOString();
    const repositories = (json.items ?? []).map((item: GitHubRepoSearchItem) => ({
      identity: this.identityFrom(item, observedAt),
      description: item.description,
      language: item.language,
      topics: item.topics ?? [],
      archived: item.archived,
      stars: item.stargazers_count,
      forks: item.forks_count,
      pushed_at: item.pushed_at,
      license_spdx_id: item.license?.spdx_id ?? null,
      is_fork: item.fork,
    }));
    return {
      repositories,
      totalCount: typeof json.total_count === 'number' ? json.total_count : repositories.length,
      hasMore: repositories.length === perPage && repositories.length < (json.total_count ?? repositories.length),
    };
  }

  async resolveRevision(repo: RepositoryIdentity, ref?: string): Promise<ResolvedRevision> {
    const [owner, name] = splitFullName(repo.observed_full_name);
    const refName = ref ?? repo.default_branch ?? 'HEAD';
    const url = `${this.options.apiRoot ?? API_ROOT}/repos/${owner}/${name}/commits/${encodeURIComponent(refName)}`;
    const json = await this.request<{ sha: string }>('core', url);
    return { identity: repo, commitSha: json.sha, ref: refName };
  }

  async getTree(revision: ResolvedRevision): Promise<RepositoryTree> {
    const [owner, name] = splitFullName(revision.identity.observed_full_name);
    const url = `${this.options.apiRoot ?? API_ROOT}/repos/${owner}/${name}/git/trees/${revision.commitSha}?recursive=1`;
    const json = await this.request<GITHUB_TREE_RESPONSE>('core', url);
    const entries = (json.tree ?? [])
      .filter((entry) => entry.type === 'blob' || entry.type === 'tree')
      .map((entry) => ({
        path: entry.path,
        type: entry.type as 'blob' | 'tree',
        size: entry.type === 'blob' ? (entry.size ?? null) : null,
        blobSha: entry.sha ?? null,
      }));
    return { revision, entries, truncated: json.truncated === true };
  }

  async readTextFile(revision: ResolvedRevision, path: string): Promise<RepositoryFile> {
    const [owner, name] = splitFullName(revision.identity.observed_full_name);
    const url = `${this.options.apiRoot ?? API_ROOT}/repos/${owner}/${name}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?ref=${revision.commitSha}`;
    const json = await this.request<GITHUB_CONTENTS_RESPONSE>('core', url);
    if (json.encoding !== 'base64' || typeof json.content !== 'string') {
      throw new GitHubApiError(`unsupported contents response for ${path}`, 200, redact(url, this.options.token));
    }
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    return {
      revision,
      path,
      content,
      blobSha: json.sha ?? null,
      contentHash: createHash('sha256').update(content).digest('hex'),
      truncated: false,
    };
  }

  private async request<T>(kind: 'search' | 'core', url: string, attempt = 0): Promise<T> {
    this.rateBudget.beforeRequest(kind);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'babel-research',
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
      });
    } catch (error) {
      this.rateBudget.recordError();
      if (attempt < 2) {
        this.rateBudget.recordRetry();
        return this.request<T>(kind, url, attempt + 1);
      }
      throw new GitHubApiError(
        redact(error instanceof Error ? error.message : String(error), this.options.token),
        0,
        redact(url, this.options.token),
      );
    }
    this.rateBudget.recordHeaders(headersFrom(response), 0);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    try {
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Never trust Content-Length. Reject before retaining an overflow
          // chunk; its already-received bytes remain honest in the receipt.
          this.rateBudget.recordBytes(value.byteLength);
          chunks.push(value);
        }
      }
    } catch (error) {
      this.rateBudget.recordError();
      await reader?.cancel().catch(() => {});
      if (error instanceof RateBudgetExhaustedError) throw error;
      throw new GitHubApiError('GitHub response body could not be read', response.status, redact(url, this.options.token));
    } finally {
      reader?.releaseLock();
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (response.status === 403 || response.status === 429) {
      this.rateBudget.recordError();
      throw new GitHubApiError(
        `rate limited or forbidden (status ${response.status})`,
        response.status,
        redact(url, this.options.token),
      );
    }
    if (!response.ok) {
      this.rateBudget.recordError();
      if (response.status >= 500 && attempt < 2) {
        this.rateBudget.recordRetry();
        return this.request<T>(kind, url, attempt + 1);
      }
      throw new GitHubApiError(`GitHub API error ${response.status}`, response.status, redact(url, this.options.token));
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      this.rateBudget.recordError();
      throw new GitHubApiError('GitHub returned invalid JSON', response.status, redact(url, this.options.token));
    }
  }
}

interface GITHUB_SEARCH_RESPONSE {
  total_count?: number;
  items?: GitHubRepoSearchItem[];
}

interface GITHUB_TREE_RESPONSE {
  tree?: Array<{
    path: string;
    type: string;
    size?: number;
    sha?: string;
  }>;
  truncated?: boolean;
}

interface GITHUB_CONTENTS_RESPONSE {
  encoding?: string;
  content?: string;
  sha?: string;
}

export function splitFullName(fullName: string): [string, string] {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`invalid repository full_name: ${fullName}`);
  }
  return [parts[0], parts[1]];
}
