/**
 * research/discovery/triage.ts — deterministic candidate triage
 *
 * Metadata-only scoring: no model calls, no file fetches. Every
 * contribution and penalty is retained in the breakdown so
 * `babel research inspect` can explain why a candidate survived.
 * The aggregate score is a ranking aid, not objective truth; stars are a
 * weak context signal only.
 */

import type { CandidateRecordV1, TriageScoreBreakdown } from '../contracts.js';

export interface TriageContext {
  /** Lowercased problem terms used for relevance matching. */
  problemTerms: string[];
  /** Lowercased mechanism vocabulary (e.g. durable, journal, checkpoint, idempotent). */
  mechanismTerms: string[];
  /** Target project language(s) for compatibility scoring, e.g. ['typescript']. */
  targetLanguages: string[];
  /** Reference time for maintenance recency. */
  now?: Date;
}

const RECENCY_DAYS = {
  strong: 90,
  weak: 365 * 2,
};

function clamp(points: number, max: number): number {
  return Math.max(0, Math.min(points, max));
}

function textOf(candidate: CandidateRecordV1): string {
  return [
    candidate.identity.observed_full_name,
    candidate.description ?? '',
    candidate.topics.join(' '),
    candidate.language ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function termHits(text: string, terms: string[]): number {
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits;
}

function recencyPoints(pushedAt: string | null, now: Date): number {
  if (!pushedAt) return 0;
  const pushed = Date.parse(pushedAt);
  if (!Number.isFinite(pushed)) return 0;
  const days = (now.getTime() - pushed) / 86_400_000;
  if (days <= RECENCY_DAYS.strong) return 10;
  if (days <= RECENCY_DAYS.weak) return 5;
  return 2;
}

export function triageCandidate(candidate: CandidateRecordV1, context: TriageContext): TriageScoreBreakdown {
  const now = context.now ?? new Date();
  const text = textOf(candidate);
  const contributions: TriageScoreBreakdown['contributions'] = [];
  const penalties: TriageScoreBreakdown['penalties'] = [];

  // Problem/mechanism relevance (max 30).
  const hypothesisCoverage = context.problemTerms.length
    ? termHits(text, context.problemTerms) / context.problemTerms.length
    : 0;
  contributions.push({ factor: 'problem_term_relevance', points: clamp(hypothesisCoverage * 15, 15) });
  const mechanismHits = termHits(text, context.mechanismTerms);
  contributions.push({ factor: 'mechanism_signal', points: clamp(mechanismHits * 3, 15) });

  // Implementation evidence density (max 20) — metadata proxies only at this stage.
  const evidenceTerms = ['implementation', 'engine', 'runner', 'runtime', 'library', 'framework', 'toolkit'];
  contributions.push({ factor: 'implementation_evidence', points: clamp(termHits(text, evidenceTerms) * 4, 20) });

  // Architectural compatibility (max 15) — language fit with the target project.
  const language = (candidate.language ?? '').toLowerCase();
  contributions.push({
    factor: 'language_compatibility',
    points: language && context.targetLanguages.includes(language) ? 15 : context.targetLanguages.length === 0 ? 7.5 : 0,
  });

  // Test/CI maturity (max 10) — metadata proxies until tree inspection.
  const maturityTerms = ['test', 'testing', 'ci', 'quality'];
  contributions.push({ factor: 'test_ci_maturity', points: clamp(termHits(text, maturityTerms) * 5, 10) });

  // Maintenance signal (max 10).
  contributions.push({ factor: 'maintenance_recency', points: recencyPoints(candidate.pushed_at, now) });

  // License clarity (max 10).
  contributions.push({
    factor: 'license_clarity',
    points: candidate.license_spdx_id && candidate.license_spdx_id !== 'NOASSERTION' ? 10 : 0,
  });

  // Security/supply-chain signal (max 5) — archived forks and unmaintained repos score low.
  contributions.push({ factor: 'supply_chain_signal', points: candidate.archived ? 0 : 5 });

  // Popularity context — weak signal, capped at 2 of the nominal 100.
  contributions.push({ factor: 'popularity_context', points: clamp(Math.log10(candidate.stars + 1), 2) });

  if (candidate.archived) penalties.push({ factor: 'archived', points: 40 });
  if (candidate.is_fork) penalties.push({ factor: 'fork', points: 5 });
  if (!candidate.license_spdx_id) penalties.push({ factor: 'unknown_license', points: 10 });

  const total =
    contributions.reduce((sum, c) => sum + c.points, 0) - penalties.reduce((sum, p) => sum + p.points, 0);

  return { candidate_id: candidate.candidate_id, contributions, penalties, total: Math.round(total * 100) / 100 };
}

/**
 * Rank candidates deterministically: score descending, then candidate_id
 * ascending as a stable tiebreaker. Ties must never depend on input order
 * beyond this rule.
 */
export function rankCandidates(
  candidates: CandidateRecordV1[],
  context: TriageContext,
): Array<{ candidate: CandidateRecordV1; breakdown: TriageScoreBreakdown }> {
  return candidates
    .map((candidate) => ({ candidate, breakdown: triageCandidate(candidate, context) }))
    .sort(
      (a, b) =>
        b.breakdown.total - a.breakdown.total ||
        a.candidate.candidate_id.localeCompare(b.candidate.candidate_id),
    );
}
