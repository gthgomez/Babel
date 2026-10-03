/**
 * research/discovery/diversity.ts — diversity selection after ranking
 *
 * Pure top-N relevance yields ten forks or ten copies of one architecture.
 * This pass enforces coverage across fork family, organization, language,
 * and mechanism, using deterministic grouping plus Jaccard topic
 * similarity (no embeddings in V1). Goal: inspect several materially
 * different ways of solving the problem.
 */

import type { CandidateRecordV1, TriageScoreBreakdown } from '../contracts.js';

export interface DiversityOptions {
  /** Maximum candidates admitted to the enriched pool. */
  limit: number;
  /** At most this many candidates per organization. */
  maxPerOrg?: number;
  /** At most this many candidates per fork family root. */
  maxPerForkFamily?: number;
  /** Candidates above this topic Jaccard similarity to an already-selected candidate are skipped. */
  topicSimilarityThreshold?: number;
}

function orgOf(fullName: string): string {
  return fullName.split('/')[0] ?? fullName;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function selectDiverseShortlist(
  ranked: Array<{ candidate: CandidateRecordV1; breakdown: TriageScoreBreakdown }>,
  options: DiversityOptions,
): Array<{ candidate: CandidateRecordV1; breakdown: TriageScoreBreakdown }> {
  const maxPerOrg = options.maxPerOrg ?? 3;
  const maxPerFamily = options.maxPerForkFamily ?? 2;
  const similarityThreshold = options.topicSimilarityThreshold ?? 0.8;

  const orgCounts = new Map<string, number>();
  const familyCounts = new Map<string, number>();
  const selectedTopics: string[][] = [];
  const selected: Array<{ candidate: CandidateRecordV1; breakdown: TriageScoreBreakdown }> = [];

  for (const entry of ranked) {
    if (selected.length >= options.limit) break;
    const { candidate } = entry;
    const org = orgOf(candidate.identity.observed_full_name);
    if ((orgCounts.get(org) ?? 0) >= maxPerOrg) continue;
    const familyKey = candidate.identity.parent_provider_repo_id ?? candidate.identity.provider_repo_id;
    if ((familyCounts.get(familyKey) ?? 0) >= maxPerFamily) continue;
    const tooSimilar = selectedTopics.some((topics) => jaccard(topics, candidate.topics) >= similarityThreshold);
    if (tooSimilar) continue;

    selected.push(entry);
    selectedTopics.push(candidate.topics);
    orgCounts.set(org, (orgCounts.get(org) ?? 0) + 1);
    familyCounts.set(familyKey, (familyCounts.get(familyKey) ?? 0) + 1);
  }
  return selected;
}
