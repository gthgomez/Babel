/**
 * research/hunt.ts — Repo Hunt discovery orchestration (Slice B)
 *
 * Runs one research mission through the discovery half of the pipeline:
 * query plan → provider search → merge/dedup → deterministic triage →
 * diversity shortlist, persisting every artifact and a metrics receipt.
 * The shortlist is the terminal output of Slice B: no deep model reader
 * runs yet, and no foreign code is executed.
 *
 * Rate limiting is an explicit non-success state: when the request budget
 * pauses or exhausts, the run is persisted as PAUSED/INCOMPLETE with the
 * reason and the artifacts produced so far.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CandidateRecordV1, RepositoryResearchProvider, TriageScoreBreakdown } from './contracts.js';
import { EvidenceRefV1Schema } from './contracts.js';
import { mergeAndDedupeCandidates, type CandidateSearchEntry } from './discovery/candidateMerge.js';
import { selectDiverseShortlist } from './discovery/diversity.js';
import { rankCandidates, type TriageContext } from './discovery/triage.js';
import {
  RateBudgetExhaustedError,
  RateBudgetPausedError,
  type RateBudgetSnapshot,
} from './rateBudget.js';
import { buildQueryPlan, extractProblemTerms } from './queryPlanner.js';
import { runDeepAnalysis, keywordReaderStrategy, type ReaderStrategy, type DeepAnalysisResult } from './analysis/deepAnalysis.js';
import { analyzeApplicability, createLocalScanBudget, type ApplicabilityFinding } from './analysis/applicability.js';
import { buildExperimentProposal, NotFalsifiableError } from './reporting/experiments.js';
import { reviewPatternCard } from './reporting/review.js';
import { writeReportArtifacts } from './reporting/report.js';
import type { ExperimentProposalV1, ResearchReviewV1 } from './contracts.js';
import {
  appendJsonl,
  initializeResearchRun,
  readJsonl,
  writeJsonArtifact,
  type ResearchRunPaths,
} from './artifacts.js';
import type { ResearchMissionV1 } from './contracts.js';

export interface HuntOptions {
  runsRoot?: string;
  now?: Date;
  /** Reader strategy for the deep-read pool; defaults to the deterministic keyword reader. */
  readerStrategy?: ReaderStrategy;
  /** Skip the Slice C deep-analysis stage (discovery-only runs). */
  skipDeepAnalysis?: boolean;
}

export type HuntStatus = 'COMPLETE' | 'INCOMPLETE' | 'PAUSED';

export interface HuntReceipt {
  mission_id: string;
  status: HuntStatus;
  reason: string | null;
  shortlist: Array<{ candidate_id: string; full_name: string; score: number }>;
  budget: RateBudgetSnapshot | null;
}

export interface HuntMetrics {
  candidate_count: number;
  candidate_count_after_dedup: number;
  candidate_count_after_triage: number;
  shortlist_count: number;
  queries_executed: number;
  fork_family_collapsed: number;
  duplicate_discoveries: number;
}

export interface HuntResult {
  status: HuntStatus;
  reason: string | null;
  paths: ResearchRunPaths;
  candidates: CandidateRecordV1[];
  shortlist: Array<{ candidate: CandidateRecordV1; breakdown: TriageScoreBreakdown }>;
  metrics: HuntMetrics;
  budget: RateBudgetSnapshot | null;
  deep: DeepAnalysisResult | null;
  findings: Array<{ patternId: string; finding: ApplicabilityFinding }>;
  proposals: ExperimentProposalV1[];
  reviews: ResearchReviewV1[];
}

/** Infer target languages from the project root (package.json today; more later). */
export function inferTargetLanguages(projectRoot: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const languages: string[] = [];
    if (deps['typescript'] || deps['tsx']) languages.push('typescript');
    return languages;
  } catch {
    return [];
  }
}

const MECHANISM_TERMS = [
  'durable', 'journal', 'checkpoint', 'idempotent', 'replay', 'workflow',
  'state machine', 'event sourcing', 'resume', 'retry', 'recovery',
];

export async function runHuntDiscovery(
  mission: ResearchMissionV1,
  provider: RepositoryResearchProvider,
  options: HuntOptions = {},
): Promise<HuntResult> {
  const paths = initializeResearchRun(mission, options.runsRoot);
  const queryPlan = buildQueryPlan(mission);
  writeJsonArtifact(paths.queryPlanJson, queryPlan);

  const pagesByHypothesis: Array<{ hypothesisId: string; entries: CandidateSearchEntry[] }> = [];
  let queriesExecuted = 0;
  let status: HuntStatus = 'COMPLETE';
  let reason: string | null = null;
  let budgetSnapshot: RateBudgetSnapshot | null = null;

  const githubProvider = provider as { budget?: { snapshot(): RateBudgetSnapshot } };

  try {
    for (const hypothesis of queryPlan.hypotheses) {
      const entries: CandidateSearchEntry[] = [];
      const page = await provider.searchRepositories(hypothesis.query, { perPage: 50 });
      entries.push(...page.repositories);
      queriesExecuted += 1;
      pagesByHypothesis.push({ hypothesisId: hypothesis.id, entries });
      if (pagesByHypothesis.reduce((sum, p) => sum + p.entries.length, 0) >= mission.budget.max_candidates) break;
    }
  } catch (error) {
    if (error instanceof RateBudgetPausedError) {
      status = 'PAUSED';
      reason = error.message;
    } else if (error instanceof RateBudgetExhaustedError) {
      status = 'INCOMPLETE';
      reason = error.message;
    } else {
      status = 'INCOMPLETE';
      reason = error instanceof Error ? error.message : String(error);
    }
  } finally {
    budgetSnapshot = githubProvider.budget?.snapshot() ?? null;
  }

  const { candidates, forkFamilyCollapsed, duplicateDiscoveries } = mergeAndDedupeCandidates(pagesByHypothesis);
  for (const candidate of candidates) appendJsonl(paths.candidatesJsonl, candidate);

  const triageContext: TriageContext = {
    problemTerms: problemTermsForTriage(mission),
    mechanismTerms: MECHANISM_TERMS,
    targetLanguages: inferTargetLanguages(mission.target.project_root),
    ...(options.now ? { now: options.now } : {}),
  };
  const ranked = rankCandidates(candidates, triageContext);
  for (const { breakdown } of ranked) appendJsonl(paths.scoreBreakdownJsonl, breakdown);
  const shortlist = selectDiverseShortlist(ranked, { limit: mission.budget.max_enriched_candidates });

  let deep: DeepAnalysisResult | null = null;
  const findings: Array<{ patternId: string; finding: ApplicabilityFinding }> = [];
  const proposals: ExperimentProposalV1[] = [];
  const reviews: ResearchReviewV1[] = [];
  const localScanBudget = createLocalScanBudget();
  if (status === 'COMPLETE' && !options.skipDeepAnalysis && shortlist.length > 0) {
    try {
      deep = await runDeepAnalysis(
        mission,
        provider,
        shortlist.map((s) => s.candidate),
        paths,
        {
          strategy: options.readerStrategy ?? keywordReaderStrategy,
          ...(options.now ? { now: options.now } : {}),
        },
      );
      if (deep.status !== 'COMPLETE') {
        status = deep.status;
        reason = deep.reason;
      }
    } catch (error) {
      status = error instanceof RateBudgetPausedError ? 'PAUSED' : 'INCOMPLETE';
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  if (deep) {
    // Slice D: local applicability (source-confirmed cards only, HEAD-bound),
    // falsifiable experiment proposals, independent research review, report.
    const persistedEvidence = readJsonl<unknown>(paths.evidenceJsonl).map((record) => EvidenceRefV1Schema.parse(record));
    for (const card of deep.patterns) {
      if (card.evidence_state !== 'SOURCE_CONFIRMED') continue;
      const sourceId = card.sources[0]?.repository_id;
      if (!sourceId) continue;
      const sourceSession = deep.sessions.find(
        (s) => s.candidate.identity.provider_repo_id === sourceId,
      );
      if (!sourceSession) continue;
      const reportText = sourceSession
        ? [
            sourceSession.finished.report.problem_match,
            ...sourceSession.finished.report.observations.map((o) => o.claim),
            ...sourceSession.finished.report.patterns.map((p) => `${p.name}: ${p.mechanism}`),
          ].join('\n')
        : '';
      const finding = analyzeApplicability(mission, card, {
        ...(options.now ? { now: options.now } : {}),
        reportText,
        localScanBudget,
      });
      findings.push({ patternId: card.pattern_id, finding });
      card.applicability = {
        target_head_sha: finding.head_sha,
        local_evidence_refs: [
          ...finding.attach_points.map((a) => a.local_ref_id),
          ...finding.existing_mechanisms.map((m) => m.local_ref_id),
        ],
        hypothesis: finding.smallest_experiment,
        integration_risks: finding.conflicts,
      };
      try {
        proposals.push(buildExperimentProposal({ mission, card, finding, now: options.now ?? new Date() }));
      } catch (error) {
        if (!(error instanceof NotFalsifiableError)) throw error;
      }
      const sourceSnapshot = deep.snapshots.find((snap) => snap.manifest.repository_id === sourceId);
      if (!sourceSnapshot) continue;
      const sourceEvidence = persistedEvidence.filter((ref) => ref.repository_id === sourceId);
      const validEvidenceIds = new Set(sourceEvidence.map((ref) => ref.evidence_id));
      reviews.push(
        reviewPatternCard({
          mission,
          card,
          evidenceRefs: sourceEvidence,
          validEvidenceIds,
          snapshot: sourceSnapshot.manifest,
          finding,
          currentTargetHeadSha: mission.target.head_sha,
          now: options.now ?? new Date(),
          applicabilityPartial: finding.scan_budget_exhausted || finding.occurrences_truncated,
        }),
      );
    }
  }
  if ((localScanBudget.exhausted || localScanBudget.occurrencesTruncated) && status === 'COMPLETE') {
    status = 'INCOMPLETE';
    reason = localScanBudget.exhausted
      ? 'local applicability scan exhausted its shared file or byte budget'
      : 'local applicability scan truncated occurrence evidence at its per-finding cap';
  }
  budgetSnapshot = githubProvider.budget?.snapshot() ?? null;

  const metrics: HuntMetrics = {
    candidate_count: pagesByHypothesis.reduce((sum, p) => sum + p.entries.length, 0),
    candidate_count_after_dedup: candidates.length,
    candidate_count_after_triage: ranked.filter((r) => r.breakdown.total > 0).length,
    shortlist_count: shortlist.length,
    queries_executed: queriesExecuted,
    fork_family_collapsed: forkFamilyCollapsed,
    duplicate_discoveries: duplicateDiscoveries,
  };
  writeJsonArtifact(paths.metricsJson, {
    ...metrics,
    status,
    reason,
    budget: budgetSnapshot,
    deep_analysis: deep
      ? {
          deep_read_count: deep.snapshots.length,
          patterns_proposed: deep.patterns.length,
          patterns_source_confirmed: deep.patterns.filter((p) => p.evidence_state === 'SOURCE_CONFIRMED').length,
          invalid_evidence_refs: deep.invalidEvidenceCount,
          rejected_evidence_ids: deep.rejectionCount,
        }
      : null,
  });

  if (deep) {
    writeReportArtifacts({
      mission,
      status,
      reason,
      candidates,
      shortlistCount: shortlist.length,
      deep,
      findings,
      proposals,
      reviews,
      paths,
      budget: budgetSnapshot,
      metrics,
      deepStatus: deep.status,
      deepReason: deep.reason,
      localScanBudget,
    });
  }

  return { status, reason, paths, candidates, shortlist, metrics, budget: budgetSnapshot, deep, findings, proposals, reviews };
}

function problemTermsForTriage(mission: ResearchMissionV1): string[] {
  // Reuse the planner's term extraction so ranking matches what was searched.
  return extractProblemTerms(mission.problem.statement);
}
