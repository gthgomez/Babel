/**
 * research/fakeProvider.ts — Deterministic in-memory research provider
 *
 * Implements RepositoryResearchProvider over a fixture corpus with no
 * network access. Used by tests and offline smoke runs so the discovery/
 * acquisition pipeline can be exercised end-to-end without GitHub.
 *
 * Determinism: search results are filtered in corpus order and scoring
 * elsewhere must never depend on object key order.
 */

import { createHash } from 'node:crypto';
import type {
  CodeSearchResult,
  RepositoryFile,
  RepositoryIdentity,
  RepositoryResearchProvider,
  RepositorySearchOptions,
  RepositorySearchPage,
  RepositoryTree,
  ResolvedRevision,
} from './contracts.js';

export interface FakeRepository {
  providerRepoId: string;
  fullName: string;
  parentProviderRepoId?: string;
  defaultBranch: string;
  commitSha: string;
  description: string | null;
  language: string | null;
  topics: string[];
  archived: boolean;
  stars: number;
  forks: number;
  pushedAt: string | null;
  licenseSpdxId: string | null;
  isFork: boolean;
  /** Path -> file content. Blob SHAs are derived deterministically. */
  files: Record<string, string>;
}

export interface FakeProviderOptions {
  repositories: FakeRepository[];
  /** Simulate a truncated tree response for this full_name. */
  truncateTreeFor?: string[];
}

function matches(haystack: string, terms: string[]): boolean {
  const lower = haystack.toLowerCase();
  // Search engines (incl. GitHub) match loosely; require any term hit so
  // multi-hypothesis discovery behaves realistically.
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

export class FakeResearchProvider implements RepositoryResearchProvider {
  readonly name = 'fake';
  private readonly byId = new Map<string, FakeRepository>();
  private readonly byName = new Map<string, FakeRepository>();

  constructor(private readonly options: FakeProviderOptions) {
    for (const repo of options.repositories) {
      this.byId.set(repo.providerRepoId, repo);
      this.byName.set(repo.fullName.toLowerCase(), repo);
    }
  }

  private requireIdentity(repo: RepositoryIdentity): FakeRepository {
    const found = this.byId.get(repo.provider_repo_id) ?? this.byName.get(repo.observed_full_name.toLowerCase());
    if (!found) throw new Error(`fake provider: unknown repository ${repo.observed_full_name}`);
    return found;
  }

  async searchRepositories(query: string, options?: RepositorySearchOptions): Promise<RepositorySearchPage> {
    const terms = query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !t.includes(':'));
    const results = this.options.repositories
      .filter((repo) =>
        matches([repo.fullName, repo.description ?? '', repo.topics.join(' ')].join(' '), terms),
      )
      .map((repo) => this.toSearchEntry(repo));
    const perPage = options?.perPage ?? results.length;
    return {
      repositories: results.slice(0, perPage),
      totalCount: results.length,
      hasMore: results.length > perPage,
    };
  }

  async resolveRevision(repo: RepositoryIdentity, ref?: string): Promise<ResolvedRevision> {
    const found = this.requireIdentity(repo);
    if (ref && ref !== found.defaultBranch && ref !== found.commitSha) {
      throw new Error(`fake provider: unknown ref "${ref}" for ${found.fullName}`);
    }
    return { identity: repo, commitSha: found.commitSha, ref: ref ?? found.defaultBranch };
  }

  async getTree(revision: ResolvedRevision): Promise<RepositoryTree> {
    const found = this.requireIdentity(revision.identity);
    const truncate = (this.options.truncateTreeFor ?? []).includes(found.fullName);
    const entries = Object.keys(found.files).map((path) => ({
      path,
      type: 'blob' as const,
      size: Buffer.byteLength(found.files[path]!, 'utf8'),
      blobSha: fakeBlobSha(found.files[path]!),
    }));
    return {
      revision,
      entries,
      // Simulated truncation keeps the incomplete state explicit for callers.
      truncated: truncate,
    };
  }

  async readTextFile(revision: ResolvedRevision, path: string): Promise<RepositoryFile> {
    const found = this.requireIdentity(revision.identity);
    const content = found.files[path];
    if (content === undefined) throw new Error(`fake provider: no file ${path} in ${found.fullName}`);
    return {
      revision,
      path,
      content,
      blobSha: fakeBlobSha(content),
      contentHash: sha256Hex(content),
      truncated: false,
    };
  }

  async searchCode(query: string, scope?: RepositoryIdentity): Promise<CodeSearchResult[]> {
    const terms = query.split(/\s+/).filter((t) => t.length > 0);
    const pool = scope ? [this.requireIdentity(scope)] : [...this.byId.values()].map((r) => r);
    const results: CodeSearchResult[] = [];
    for (const repo of pool) {
      const identity = this.toIdentity(repo);
      for (const [path, content] of Object.entries(repo.files)) {
        if (matches(content, terms)) {
          results.push({ identity, path, blobSha: fakeBlobSha(content) });
        }
      }
    }
    return results;
  }

  private toIdentity(repo: FakeRepository): RepositoryIdentity {
    return {
      provider_repo_id: repo.providerRepoId,
      provider: 'github',
      observed_full_name: repo.fullName,
      parent_provider_repo_id: repo.parentProviderRepoId ?? null,
      default_branch: repo.defaultBranch,
      observed_at: new Date(0).toISOString(),
    };
  }

  private toSearchEntry(repo: FakeRepository) {
    return {
      identity: this.toIdentity(repo),
      description: repo.description,
      language: repo.language,
      topics: repo.topics,
      archived: repo.archived,
      stars: repo.stars,
      forks: repo.forks,
      pushed_at: repo.pushedAt,
      license_spdx_id: repo.licenseSpdxId,
      is_fork: repo.isFork,
    };
  }
}

/** Deterministic blob sha mirroring git blob hashing (sha1 of "blob <len>\0<content>"). */
export function fakeBlobSha(content: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(content, 'utf8')}\0`).update(content).digest('hex');
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
