/**
 * research/discovery/candidateMerge.ts — candidate deduplication
 *
 * Deduplicates discovered repositories across hypotheses by stable GitHub
 * identity (provider repo id), collapses fork families to the parent
 * unless a fork is materially divergent (different language), and records
 * which hypotheses surfaced each survivor.
 */

import type { CandidateRecordV1, RepositoryIdentity } from '../contracts.js';

export interface CandidateSearchEntry {
  identity: RepositoryIdentity;
  description: string | null;
  language: string | null;
  topics: string[];
  archived: boolean;
  stars: number;
  forks: number;
  pushed_at: string | null;
  license_spdx_id: string | null;
  is_fork: boolean;
}

export function candidateFromSearchEntry(
  entry: CandidateSearchEntry,
  hypothesisId: string,
  candidateIndex: number,
): CandidateRecordV1 {
  return {
    schema_version: 1,
    candidate_id: `cand_${String(candidateIndex).padStart(5, '0')}`,
    identity: entry.identity,
    matched_hypothesis_ids: [hypothesisId],
    description: entry.description,
    language: entry.language,
    topics: entry.topics,
    archived: entry.archived,
    stars: entry.stars,
    forks: entry.forks,
    pushed_at: entry.pushed_at,
    license_spdx_id: entry.license_spdx_id,
    is_fork: entry.is_fork,
  };
}

export interface MergeOutcome {
  candidates: CandidateRecordV1[];
  /** provider_repo_id -> kept candidate_id for collapsed forks. */
  forkFamilyCollapsed: number;
  duplicateDiscoveries: number;
}

/**
 * Merge search results from multiple hypotheses. Input order must be
 * deterministic (hypothesis order, then provider order). Candidates with
 * the same provider_repo_id are merged (union of hypothesis ids); forks
 * whose parent is present are dropped unless their language differs from
 * the parent's — a heuristic for "materially divergent".
 */
export function mergeAndDedupeCandidates(
  pagesByHypothesis: Array<{ hypothesisId: string; entries: Parameters<typeof candidateFromSearchEntry>[0][] }>,
): MergeOutcome {
  const byRepoId = new Map<string, CandidateRecordV1>();
  let duplicateDiscoveries = 0;

  for (const { hypothesisId, entries } of pagesByHypothesis) {
    for (const entry of entries) {
      const existing = byRepoId.get(entry.identity.provider_repo_id);
      if (existing) {
        duplicateDiscoveries += 1;
        if (!existing.matched_hypothesis_ids.includes(hypothesisId)) {
          existing.matched_hypothesis_ids.push(hypothesisId);
        }
        continue;
      }
      byRepoId.set(
        entry.identity.provider_repo_id,
        candidateFromSearchEntry(entry, hypothesisId, byRepoId.size),
      );
    }
  }

  const kept: CandidateRecordV1[] = [];
  let forkFamilyCollapsed = 0;
  for (const candidate of byRepoId.values()) {
    if (candidate.is_fork && candidate.identity.parent_provider_repo_id) {
      const parent = byRepoId.get(candidate.identity.parent_provider_repo_id);
      if (parent) {
        forkFamilyCollapsed += 1;
        if ((candidate.language ?? null) === (parent.language ?? null)) continue;
      }
    }
    kept.push(candidate);
  }

  return { candidates: kept, forkFamilyCollapsed, duplicateDiscoveries };
}
