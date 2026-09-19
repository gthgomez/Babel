/**
 * Model-fixed harness evaluation substrate (H7).
 *
 * Separates harness behavior from model changes: fixed task set, model
 * snapshot, sampling, repo revision, permissions, verifier, resource profile,
 * environment digest. Failure ledger links episodes → fixtures → fixes.
 * Never reports a best-run as reliability; requires paired deltas + uncertainty.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import {
  assembleCompactedConversation,
  measureCriticalFactRetention,
} from './compactionCommit.js';
import { estimateTokens } from './chatCompaction.js';
import { checkToolCapability } from './capabilityBroker.js';
import { captureWorkspaceRevisionIdentity } from './capabilityBroker.js';
import {
  buildVerifierReceiptV2,
  evaluateVerifierPromotion,
} from './verifierKernel.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordCompletionDecision,
  recordTurnEnded,
} from './sessionEvents.js';
import {
  projectLiveSession,
  liveSessionsEquivalentForResume,
} from './liveSession.js';
import {
  replayTerminalDecision,
  buildLiveGoldenEpisode,
  validateGoldenEpisode,
} from './episodeReplay.js';
import { classifyToolEffect } from '../executor/contracts.js';

export const HARNESS_EVAL_VERSION = 1 as const;

/** Schema version for the hardened paired-comparison report. */
export const PAIRED_COMPARISON_SCHEMA_VERSION = 1 as const;

export interface FixedEvalControls {
  task_set_id: string;
  model_snapshot: string;
  sampling: { temperature: number; top_p?: number; max_tokens?: number };
  repository_revision: string;
  permissions_profile: string;
  verifier_profile: string;
  resource_profile: string;
  environment_digest: string;
}

export interface EvalTaskResult {
  task_id: string;
  variant: string;
  /** Repeated paired trial index; absent for historical/offline fixtures. */
  trial_index?: number;
  verified_complete_no_policy_violation: boolean;
  tokens: number;
  duration_ms: number;
  false_completion: boolean;
  instruction_policy_violation: boolean;
  resume_state_equivalent: boolean | null;
  critical_fact_retention: number | null;
  infrastructure_failure: boolean;
  agent_failure: boolean;
  human_intervention: boolean;
  clean_room_pass: boolean | null;
  /**
   * Optional model identity for this attempt. When present, paired arms must
   * agree or the comparison is rejected as a model mismatch (H7 is a
   * model-fixed comparison). Optional so historical/offline fixtures without
   * the fact stay readable; it is validated whenever supplied.
   */
  model_snapshot?: string;
  /**
   * Optional environment digest for this attempt. Same contract as
   * `model_snapshot`: validated whenever supplied.
   */
  environment_digest?: string;
}

/** Metrics eligible for paired comparison. */
export type PairedMetric = keyof Pick<
  EvalTaskResult,
  'tokens' | 'duration_ms' | 'critical_fact_retention'
>;

/**
 * Whether a numerical uncertainty value was actually estimated from repeated
 * paired trials. A single pair can never yield zero uncertainty: it yields
 * `insufficient_replicates` with `uncertainty: null`.
 */
export type PairedUncertaintyStatus =
  | 'measured'
  | 'insufficient_replicates'
  | 'not_estimable';

/**
 * Explicit reasons a paired comparison is rejected or degraded. Missing data is
 * never silently coerced to zero; duplicates and unpaired samples are reported
 * rather than dropped or reused.
 */
export type PairedComparisonIssue =
  | 'empty_population'
  | 'duplicate_pair_key'
  | 'ambiguous_pair_key'
  | 'unpaired_baseline'
  | 'unpaired_candidate'
  | 'variant_mismatch'
  | 'missing_metric'
  | 'non_finite_metric'
  | 'model_mismatch'
  | 'environment_mismatch'
  | 'controls_changed'
  | 'controls_incomplete'
  | 'missing_expected_task'
  | 'missing_expected_trial';

export interface PairedDelta {
  task_id: string;
  baseline_variant: string;
  candidate_variant: string;
  metric: string;
  /** Mean baseline metric, or null when the comparison is invalid. */
  baseline_value: number | null;
  /** Mean candidate metric, or null when the comparison is invalid. */
  candidate_value: number | null;
  /** Mean paired difference, or null when the comparison is invalid. */
  delta: number | null;
  /**
   * Standard error over repeated paired trials. `null` (never a fabricated
   * zero) when fewer than two valid pairs exist; see `uncertainty_status`.
   */
  uncertainty: number | null;
  uncertainty_status: PairedUncertaintyStatus;
  /** Number of matched pairs with a readable metric. */
  n_pairs: number;
  /** False when the comparison must not be used as promotion evidence. */
  valid: boolean;
  /** Explicit rejection/degradation reasons; empty only when `valid` is true. */
  issues: PairedComparisonIssue[];
}

export interface EvalAttemptOutcomeCounts {
  attempts: number;
  verified_complete: number;
  false_completion: number;
  instruction_policy_violation: number;
  infrastructure_failure: number;
  agent_failure: number;
  human_intervention: number;
}

export interface DroppedPairedSample {
  arm: 'baseline' | 'candidate';
  task_id: string;
  variant: string;
  trial_index: number | null;
  reason: 'unpaired' | 'duplicate_pair_key' | 'ambiguous_pair_key' | 'variant_mismatch';
  infrastructure_failure: boolean;
  agent_failure: boolean;
}

export interface PairedComparisonReport {
  schema_version: typeof PAIRED_COMPARISON_SCHEMA_VERSION;
  metric: string;
  deltas: PairedDelta[];
  /** Samples present in one arm but unusable for pairing. */
  dropped_samples: DroppedPairedSample[];
  global_issues: PairedComparisonIssue[];
  control_deviations: string[];
  model_deviations: string[];
  environment_deviations: string[];
  coverage_complete: boolean;
  valid: boolean;
  /** Outcome mix per arm; failed/infra/timeout attempts are retained, not filtered. */
  attempt_outcomes: {
    baseline: EvalAttemptOutcomeCounts;
    candidate: EvalAttemptOutcomeCounts;
  };
  /** Intention-to-test tokens including failed attempts, not only solved tasks. */
  intention_to_test_tokens: { baseline: number; candidate: number };
}

export interface PairedComparisonOptions {
  baseline_controls?: FixedEvalControls;
  candidate_controls?: FixedEvalControls;
  expected_task_ids?: readonly string[];
  expected_trials_per_task?: number;
}

export interface FailureLedgerEntry {
  entry_id: string;
  episode_id: string;
  failure_class: string;
  regression_fixture: string;
  fixing_commit?: string;
  created_at: string;
  held_out: boolean;
}

export interface PromotionRecord {
  change_id: string;
  pre_fix_fixture: string;
  pre_fix_failed: true;
  post_fix_fixture: string;
  post_fix_passed: true;
  held_out_non_regression: boolean;
  rollback_path: string;
  promoted_at?: string;
}

export interface HarnessEvalReport {
  schema_version: typeof HARNESS_EVAL_VERSION;
  controls: FixedEvalControls;
  results: EvalTaskResult[];
  paired_deltas: PairedDelta[];
  failure_ledger: FailureLedgerEntry[];
  metrics: HarnessCoreMetrics;
  /** True only when experimental runs actually executed under fixed controls. */
  experimental_evidence: boolean;
  notes: string[];
}

export interface HarnessCoreMetrics {
  verified_completion_per_token: number | null;
  verified_completion_per_minute: number | null;
  false_completion_rate: number;
  instruction_policy_violation_rate: number;
  resume_state_equivalence_rate: number | null;
  critical_fact_retention_mean: number | null;
  infrastructure_failure_rate: number;
  agent_failure_rate: number;
  clean_room_promotion_pass_rate: number | null;
  human_intervention_burden: number;
  n_tasks: number;
}

export function environmentDigest(parts: Record<string, string>): string {
  const ordered = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join('\n');
  return createHash('sha256').update(ordered).digest('hex').slice(0, 24);
}

export function computeCoreMetrics(results: readonly EvalTaskResult[]): HarnessCoreMetrics {
  const n = results.length;
  if (n === 0) {
    return {
      verified_completion_per_token: null,
      verified_completion_per_minute: null,
      false_completion_rate: 0,
      instruction_policy_violation_rate: 0,
      resume_state_equivalence_rate: null,
      critical_fact_retention_mean: null,
      infrastructure_failure_rate: 0,
      agent_failure_rate: 0,
      clean_room_promotion_pass_rate: null,
      human_intervention_burden: 0,
      n_tasks: 0,
    };
  }
  const verified = results.filter((r) => r.verified_complete_no_policy_violation);
  const tokens = results.reduce((s, r) => s + r.tokens, 0);
  const minutes = results.reduce((s, r) => s + r.duration_ms, 0) / 60_000;
  const resume = results.filter((r) => r.resume_state_equivalent !== null);
  const resumeOk = resume.filter((r) => r.resume_state_equivalent === true);
  const facts = results
    .map((r) => r.critical_fact_retention)
    .filter((x): x is number => x !== null);
  const cr = results.filter((r) => r.clean_room_pass !== null);
  const crOk = cr.filter((r) => r.clean_room_pass === true);

  return {
    verified_completion_per_token:
      tokens > 0 ? verified.length / tokens : null,
    verified_completion_per_minute:
      minutes > 0 ? verified.length / minutes : null,
    false_completion_rate: results.filter((r) => r.false_completion).length / n,
    instruction_policy_violation_rate:
      results.filter((r) => r.instruction_policy_violation).length / n,
    resume_state_equivalence_rate:
      resume.length > 0 ? resumeOk.length / resume.length : null,
    critical_fact_retention_mean:
      facts.length > 0 ? facts.reduce((a, b) => a + b, 0) / facts.length : null,
    infrastructure_failure_rate:
      results.filter((r) => r.infrastructure_failure).length / n,
    agent_failure_rate: results.filter((r) => r.agent_failure).length / n,
    clean_room_promotion_pass_rate:
      cr.length > 0 ? crOk.length / cr.length : null,
    human_intervention_burden:
      results.filter((r) => r.human_intervention).length / n,
    n_tasks: n,
  };
}

/**
 * Identity keys. A "trial key" is unique per (task, variant, trial) within one
 * arm; a "match key" pairs the two arms on (task, trial) regardless of variant
 * so a candidate for one variant can never be reused for another.
 */
function pairedTrialKey(
  taskId: string,
  variant: string,
  trialIndex: number | undefined,
): string {
  return `${taskId}\u0000${variant}\u0000${trialIndex ?? ''}`;
}

function pairedMatchKey(taskId: string, trialIndex: number | undefined): string {
  return `${taskId}\u0000${trialIndex ?? ''}`;
}

interface PairedArmIndex {
  readonly duplicateTrialKeys: ReadonlySet<string>;
  readonly byMatchKey: ReadonlyMap<string, EvalTaskResult[]>;
}

function indexPairedArm(rows: readonly EvalTaskResult[]): PairedArmIndex {
  const seenTrialKeys = new Set<string>();
  const duplicateTrialKeys = new Set<string>();
  const byMatchKey = new Map<string, EvalTaskResult[]>();
  for (const row of rows) {
    const trialKey = pairedTrialKey(row.task_id, row.variant, row.trial_index);
    if (seenTrialKeys.has(trialKey)) duplicateTrialKeys.add(trialKey);
    else seenTrialKeys.add(trialKey);
    const matchKey = pairedMatchKey(row.task_id, row.trial_index);
    const bucket = byMatchKey.get(matchKey);
    if (bucket) bucket.push(row);
    else byMatchKey.set(matchKey, [row]);
  }
  return { duplicateTrialKeys, byMatchKey };
}

function readPairedMetric(
  row: EvalTaskResult,
  metric: PairedMetric,
): { value: number | null; issue: PairedComparisonIssue | null } {
  const raw: unknown = row[metric];
  if (raw === null || raw === undefined) return { value: null, issue: 'missing_metric' };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { value: null, issue: 'non_finite_metric' };
  }
  return { value: raw, issue: null };
}

function countAttemptOutcomes(rows: readonly EvalTaskResult[]): EvalAttemptOutcomeCounts {
  return {
    attempts: rows.length,
    verified_complete: rows.filter((r) => r.verified_complete_no_policy_violation).length,
    false_completion: rows.filter((r) => r.false_completion).length,
    instruction_policy_violation: rows.filter((r) => r.instruction_policy_violation).length,
    infrastructure_failure: rows.filter((r) => r.infrastructure_failure).length,
    agent_failure: rows.filter((r) => r.agent_failure).length,
    human_intervention: rows.filter((r) => r.human_intervention).length,
  };
}

/**
 * Total tokens as an intention-to-test cost. Failed and infrastructure-failed
 * attempts are included; only non-finite values are excluded.
 */
function sumPairedTokens(rows: readonly EvalTaskResult[]): number {
  return rows.reduce((sum, r) => (Number.isFinite(r.tokens) ? sum + r.tokens : sum), 0);
}

function distinctArmValues(
  rows: readonly EvalTaskResult[],
  field: 'model_snapshot' | 'environment_digest',
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value: string | undefined = row[field];
    if (typeof value === 'string' && value !== '') seen.add(value);
  }
  return [...seen].sort();
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeRejectedDelta(
  taskId: string,
  baseRows: readonly EvalTaskResult[],
  candRows: readonly EvalTaskResult[],
  metric: PairedMetric,
  issues: PairedComparisonIssue[],
): PairedDelta {
  const baseVariants = [...new Set(baseRows.map((r) => r.variant))];
  const candVariants = [...new Set(candRows.map((r) => r.variant))];
  return {
    task_id: taskId,
    baseline_variant: baseVariants.length === 1 ? baseVariants[0]! : (baseRows[0]?.variant ?? ''),
    candidate_variant: candVariants.length === 1 ? candVariants[0]! : (candRows[0]?.variant ?? ''),
    metric,
    baseline_value: null,
    candidate_value: null,
    delta: null,
    uncertainty: null,
    uncertainty_status: 'not_estimable',
    n_pairs: 0,
    valid: false,
    issues: [...new Set(issues)],
  };
}

function toDroppedSample(
  row: EvalTaskResult,
  arm: 'baseline' | 'candidate',
  reason: DroppedPairedSample['reason'],
): DroppedPairedSample {
  return {
    arm,
    task_id: row.task_id,
    variant: row.variant,
    trial_index: row.trial_index ?? null,
    reason,
    infrastructure_failure: row.infrastructure_failure,
    agent_failure: row.agent_failure,
  };
}

/**
 * Validate paired measurements and reject/report invalid comparisons.
 *
 * Never coerces a missing metric to 0, never reuses a candidate for a duplicate
 * baseline key, never drops unpaired/duplicate samples silently, and never
 * reports numerical zero uncertainty for a single or invalid comparison.
 * Failed, infrastructure-failed and human-intervened attempts remain in the
 * population and in intention-to-test token totals.
 */
export function evaluatePairedComparison(
  baseline: readonly EvalTaskResult[],
  candidate: readonly EvalTaskResult[],
  metric: PairedMetric = 'tokens',
  options: PairedComparisonOptions = {},
): PairedComparisonReport {
  const baselineIndex = indexPairedArm(baseline);
  const candidateIndex = indexPairedArm(candidate);
  const globalIssues: PairedComparisonIssue[] = [];
  const controlDeviations: string[] = [];
  const modelDeviations: string[] = [];
  const environmentDeviations: string[] = [];

  if (baseline.length === 0 && candidate.length === 0) {
    globalIssues.push('empty_population');
  }

  const bControls = options.baseline_controls;
  const cControls = options.candidate_controls;
  if (bControls && cControls) {
    const match = controlsMatch(bControls, cControls);
    controlDeviations.push(...match.deviations);
    if (!match.ok) globalIssues.push('controls_changed');
  } else if (bControls || cControls) {
    globalIssues.push('controls_incomplete');
  }

  for (const [field, deviations, issue] of [
    ['model_snapshot', modelDeviations, 'model_mismatch'],
    ['environment_digest', environmentDeviations, 'environment_mismatch'],
  ] as const) {
    const bValues = distinctArmValues(baseline, field);
    const cValues = distinctArmValues(candidate, field);
    if (bValues.length === 0 && cValues.length === 0) continue;
    if (bValues.length > 1 || cValues.length > 1) {
      deviations.push('multiple_values_within_arm');
    } else if (bValues.length !== 1 || cValues.length !== 1 || bValues[0] !== cValues[0]) {
      deviations.push(`baseline=${bValues[0] ?? '<missing>'},candidate=${cValues[0] ?? '<missing>'}`);
    }
    if (deviations.length > 0 && !globalIssues.includes(issue)) globalIssues.push(issue);
  }

  const expectedTaskIds = options.expected_task_ids;
  const observedTaskIds = new Set([
    ...baseline.map((r) => r.task_id),
    ...candidate.map((r) => r.task_id),
  ]);
  if (expectedTaskIds && expectedTaskIds.length > 0) {
    if (expectedTaskIds.some((id) => !observedTaskIds.has(id))) {
      globalIssues.push('missing_expected_task');
    }
  }
  const expectedTrials = options.expected_trials_per_task;
  if (expectedTrials !== undefined) {
    for (const taskId of observedTaskIds) {
      const baseTrials = new Set(
        baseline.filter((r) => r.task_id === taskId).map((r) => r.trial_index ?? null),
      );
      const candTrials = new Set(
        candidate.filter((r) => r.task_id === taskId).map((r) => r.trial_index ?? null),
      );
      if (baseTrials.size < expectedTrials || candTrials.size < expectedTrials) {
        if (!globalIssues.includes('missing_expected_trial')) {
          globalIssues.push('missing_expected_trial');
        }
        break;
      }
    }
  }

  const globalInvalid = globalIssues.some(
    (issue) =>
      issue === 'controls_changed' ||
      issue === 'controls_incomplete' ||
      issue === 'model_mismatch' ||
      issue === 'environment_mismatch' ||
      issue === 'missing_expected_task' ||
      issue === 'missing_expected_trial',
  );

  const deltas: PairedDelta[] = [];
  const droppedSamples: DroppedPairedSample[] = [];
  const taskIds = [...observedTaskIds].sort();

  for (const taskId of taskIds) {
    const baseRows = baseline.filter((r) => r.task_id === taskId);
    const candRows = candidate.filter((r) => r.task_id === taskId);
    const issues: PairedComparisonIssue[] = [];

    const baseVariants = [...new Set(baseRows.map((r) => r.variant))];
    const candVariants = [...new Set(candRows.map((r) => r.variant))];
    if (baseVariants.length > 1 || candVariants.length > 1) issues.push('variant_mismatch');

    const duplicate =
      baseRows.some((r) =>
        baselineIndex.duplicateTrialKeys.has(
          pairedTrialKey(r.task_id, r.variant, r.trial_index),
        ),
      ) ||
      candRows.some((r) =>
        candidateIndex.duplicateTrialKeys.has(
          pairedTrialKey(r.task_id, r.variant, r.trial_index),
        ),
      );
    if (duplicate) issues.push('duplicate_pair_key');

    const ambiguous =
      baseRows.some(
        (r) => (baselineIndex.byMatchKey.get(pairedMatchKey(r.task_id, r.trial_index))?.length ?? 0) > 1,
      ) ||
      candRows.some(
        (r) => (candidateIndex.byMatchKey.get(pairedMatchKey(r.task_id, r.trial_index))?.length ?? 0) > 1,
      );
    if (ambiguous) issues.push('ambiguous_pair_key');

    // Structural defects reject the whole task comparison: no candidate reuse,
    // no partial aggregate. Every affected sample is explicitly reported.
    if (issues.length > 0) {
      const reason: DroppedPairedSample['reason'] = duplicate
        ? 'duplicate_pair_key'
        : ambiguous
          ? 'ambiguous_pair_key'
          : 'variant_mismatch';
      for (const row of baseRows) droppedSamples.push(toDroppedSample(row, 'baseline', reason));
      for (const row of candRows) droppedSamples.push(toDroppedSample(row, 'candidate', reason));
      deltas.push(makeRejectedDelta(taskId, baseRows, candRows, metric, issues));
      continue;
    }

    const matched: Array<{ base: EvalTaskResult; candidate: EvalTaskResult }> = [];
    for (const base of baseRows) {
      const bucket = candidateIndex.byMatchKey.get(pairedMatchKey(base.task_id, base.trial_index)) ?? [];
      if (bucket.length === 0) {
        droppedSamples.push(toDroppedSample(base, 'baseline', 'unpaired'));
        if (!issues.includes('unpaired_baseline')) issues.push('unpaired_baseline');
      } else {
        matched.push({ base, candidate: bucket[0]! });
      }
    }
    for (const cand of candRows) {
      const bucket = baselineIndex.byMatchKey.get(pairedMatchKey(cand.task_id, cand.trial_index)) ?? [];
      if (bucket.length === 0) {
        droppedSamples.push(toDroppedSample(cand, 'candidate', 'unpaired'));
        if (!issues.includes('unpaired_candidate')) issues.push('unpaired_candidate');
      }
    }

    const baselineValues: number[] = [];
    const candidateValues: number[] = [];
    for (const { base, candidate: cand } of matched) {
      const baseMetric = readPairedMetric(base, metric);
      const candMetric = readPairedMetric(cand, metric);
      for (const issue of [baseMetric.issue, candMetric.issue]) {
        if (issue && !issues.includes(issue)) issues.push(issue);
      }
      if (baseMetric.value !== null && candMetric.value !== null) {
        baselineValues.push(baseMetric.value);
        candidateValues.push(candMetric.value);
      }
    }

    const valid =
      issues.length === 0 &&
      !globalInvalid &&
      matched.length > 0 &&
      baselineValues.length === matched.length;

    if (!valid) {
      deltas.push(makeRejectedDelta(taskId, baseRows, candRows, metric, issues));
      continue;
    }

    const pairedDiffs = baselineValues.map((value, index) => candidateValues[index]! - value);
    const mean = meanOf(pairedDiffs);
    let uncertainty: number | null = null;
    let uncertaintyStatus: PairedUncertaintyStatus = 'insufficient_replicates';
    if (pairedDiffs.length >= 2) {
      const variance =
        pairedDiffs.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        (pairedDiffs.length - 1);
      uncertainty = Math.sqrt(variance / pairedDiffs.length);
      uncertaintyStatus = 'measured';
    }

    deltas.push({
      task_id: taskId,
      baseline_variant: baseVariants[0]!,
      candidate_variant: candVariants[0]!,
      metric,
      baseline_value: meanOf(baselineValues),
      candidate_value: meanOf(candidateValues),
      delta: mean,
      uncertainty,
      uncertainty_status: uncertaintyStatus,
      n_pairs: matched.length,
      valid: true,
      issues: [],
    });
  }

  const coverageComplete =
    droppedSamples.length === 0 &&
    deltas.length > 0 &&
    deltas.every((delta) => delta.valid) &&
    !globalIssues.includes('missing_expected_task') &&
    !globalIssues.includes('missing_expected_trial');

  return {
    schema_version: PAIRED_COMPARISON_SCHEMA_VERSION,
    metric,
    deltas,
    dropped_samples: droppedSamples,
    global_issues: [...new Set(globalIssues)],
    control_deviations: [...new Set(controlDeviations)],
    model_deviations: [...new Set(modelDeviations)],
    environment_deviations: [...new Set(environmentDeviations)],
    coverage_complete: coverageComplete,
    valid:
      globalIssues.length === 0 &&
      deltas.length > 0 &&
      deltas.every((delta) => delta.valid) &&
      droppedSamples.length === 0,
    attempt_outcomes: {
      baseline: countAttemptOutcomes(baseline),
      candidate: countAttemptOutcomes(candidate),
    },
    intention_to_test_tokens: {
      baseline: sumPairedTokens(baseline),
      candidate: sumPairedTokens(candidate),
    },
  };
}

/**
 * Pairwise task-level deltas with validated inputs and honest uncertainty.
 * Returns one entry per observed task (including explicit invalid entries).
 * Use {@link evaluatePairedComparison} when dropped-sample and coverage
 * reporting is required.
 */
export function computePairedDeltas(
  baseline: readonly EvalTaskResult[],
  candidate: readonly EvalTaskResult[],
  metric: PairedMetric = 'tokens',
  options: PairedComparisonOptions = {},
): PairedDelta[] {
  return evaluatePairedComparison(baseline, candidate, metric, options).deltas;
}

export function appendFailureLedger(
  ledger: FailureLedgerEntry[],
  entry: Omit<FailureLedgerEntry, 'entry_id' | 'created_at'> & {
    entry_id?: string;
    created_at?: string;
  },
): FailureLedgerEntry[] {
  return [
    ...ledger,
    {
      entry_id: entry.entry_id ?? randomUUID(),
      episode_id: entry.episode_id,
      failure_class: entry.failure_class,
      regression_fixture: entry.regression_fixture,
      ...(entry.fixing_commit ? { fixing_commit: entry.fixing_commit } : {}),
      created_at: entry.created_at ?? new Date().toISOString(),
      held_out: entry.held_out,
    },
  ];
}

/**
 * Promotion requires pre-fail, post-pass, held-out, rollback path (H7 exit).
 */
export function validatePromotionRecord(rec: PromotionRecord): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!rec.pre_fix_fixture) errors.push('missing_pre_fix_fixture');
  if (!rec.pre_fix_failed) errors.push('pre_fix_must_have_failed');
  if (!rec.post_fix_fixture) errors.push('missing_post_fix_fixture');
  if (!rec.post_fix_passed) errors.push('post_fix_must_have_passed');
  if (!rec.held_out_non_regression) errors.push('missing_held_out_evidence');
  if (!rec.rollback_path) errors.push('missing_rollback_path');
  return { ok: errors.length === 0, errors };
}

export const H7_DEDICATED_SUITES = [
  'noop_already_fixed',
  'stale_context',
  'dirty_tree',
  'prompt_injection',
  'verifier_tamper',
  'flaky_tests',
  'missing_dependency',
  'network_denied',
  'resource_exhaustion',
  'false_completion',
  'crash_resume',
  'context_compaction',
  'policy_disappearance',
  'idempotency_violation',
] as const;

export type H7SuiteId = (typeof H7_DEDICATED_SUITES)[number];

/**
 * Local dry-run of eval substrate with synthetic results under fixed controls.
 * Marks experimental_evidence: false — code path validation only.
 */
export function runLocalEvalSubstrateSmoke(controls: FixedEvalControls): HarnessEvalReport {
  const baseline: EvalTaskResult[] = [
    {
      task_id: 't1',
      variant: 'baseline',
      verified_complete_no_policy_violation: true,
      tokens: 1000,
      duration_ms: 60_000,
      false_completion: false,
      instruction_policy_violation: false,
      resume_state_equivalent: true,
      critical_fact_retention: 1,
      infrastructure_failure: false,
      agent_failure: false,
      human_intervention: false,
      clean_room_pass: true,
    },
  ];
  const candidate: EvalTaskResult[] = [
    {
      ...baseline[0]!,
      variant: 'hardened',
      tokens: 900,
    },
  ];
  const results = [...baseline, ...candidate];
  return {
    schema_version: HARNESS_EVAL_VERSION,
    controls,
    results,
    paired_deltas: computePairedDeltas(baseline, candidate, 'tokens'),
    failure_ledger: [],
    metrics: computeCoreMetrics(results),
    experimental_evidence: false,
    notes: [
      'Local substrate smoke only — not measured experimental evidence',
      `suites_registered=${H7_DEDICATED_SUITES.length}`,
    ],
  };
}

/**
 * Offline harness-factor factorial: drives shipped harness functions under fixed
 * controls without calling external model APIs. Measures resume equivalence,
 * compaction retention, capability deny, verifier promotion, and golden replay.
 *
 * Explicitly NOT a substitute for same-model Chat/Deep LLM factorial cells
 * (see ADR-013). Marks experimental_evidence: true only for harness-factor scope.
 */
export function runOfflineHarnessFactorial(controls: FixedEvalControls): HarnessEvalReport {
  const t0 = Date.now();
  const facts = ['FACT_ALPHA', 'FACT_BETA'];
  const prior = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: `remember ${facts[0]}` },
    { role: 'assistant' as const, content: `ok ${facts[0]}` },
    { role: 'user' as const, content: `remember ${facts[1]}` },
    { role: 'assistant' as const, content: `ok ${facts[1]}` },
  ];
  const compacted = assembleCompactedConversation(
    [
      prior[0]!,
      {
        role: 'system',
        content: `Preserved: ${facts.join(', ')}`,
        name: 'compaction_summary',
      },
      prior[prior.length - 2]!,
      prior[prior.length - 1]!,
    ],
    '# capsule\nTask: offline-h7',
  );
  const retention = measureCriticalFactRetention(
    compacted.map((m) => m.content).join('\n'),
    facts,
  );
  const tokensBefore = estimateTokens(prior);
  const tokensAfter = estimateTokens(compacted);

  const unknownDenied = checkToolCapability({
    toolName: 'totally_unknown_offline_xyz',
    effectClass: classifyToolEffect('totally_unknown_offline_xyz'),
    allowedEffects: ['read_only', 'idempotent', 'reconcilable_mutation'],
    mode: 'chat',
  });

  const emptyPromo = evaluateVerifierPromotion({
    mutating: true,
    task_class: 'general_swe',
    required_verifier_commands: [],
    receipts: [],
    current_revision_hash: 'rev',
  });
  const goodReceipt = buildVerifierReceiptV2({
    receipt_id: 'r1',
    verifier_id: 'v1',
    argv: ['npm', 'test'],
    cwd: '.',
    env_profile_hash: 'env',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    exit_code: 0,
    stdout: 'ok',
    stderr: '',
    workspace_revision: { compositeTreeHash: 'rev' },
    scope: 'full_suite',
    command: 'npm test',
    authoritative: true,
  });
  const goodPromo = evaluateVerifierPromotion({
    mutating: true,
    task_class: 'general_swe',
    required_verifier_commands: ['npm test'],
    receipts: [goodReceipt],
    current_revision_hash: 'rev',
  });

  const log = createSessionEventLog('offline-h7');
  recordUserSubmitted(log, { turn_id: 't1', task: 'offline harness factor' });
  recordToolProposed(log, {
    turn_id: 't1', tool_call_id: 'c1', tool_name: 'write_file', idempotency_key: 'idem-1',
  });
  recordToolStarted(log, {
    turn_id: 't1', tool_call_id: 'c1', tool_name: 'write_file', idempotency_key: 'idem-1',
  });
  recordToolTerminal(log, {
    turn_id: 't1',
    tool_call_id: 'c1',
    tool_name: 'write_file',
    idempotency_key: 'idem-1',
    exit_code: 0,
  });
  recordCompletionDecision(log, 't1', {
    requestedOutcome: 'VERIFIED_COMPLETE',
    finalOutcome: 'VERIFIED_COMPLETE',
    allowed: true,
    reason: 'ok',
    evidenceRefs: ['e1'],
    policyVersion: 'v1',
  });
  recordTurnEnded(log, {
    turn_id: 't1',
    outcome: 'VERIFIED_COMPLETE',
    status: 'done',
  });
  const liveA = projectLiveSession({ sessionLog: log });
  const liveB = projectLiveSession({ sessionLog: log });
  const resumeEq = liveSessionsEquivalentForResume(liveA, liveB);
  const replay = replayTerminalDecision(log);
  const golden = buildLiveGoldenEpisode({
    sessionLog: log,
    workspace_path: process.cwd(),
    live_runtime: false,
  });
  const goldenOk = validateGoldenEpisode(golden);

  const duration = Date.now() - t0;
  const hardenedOk =
    retention.rate === 1 &&
    !unknownDenied.allowed &&
    !emptyPromo.authorize_verified_complete &&
    goodPromo.authorize_verified_complete &&
    resumeEq.ok &&
    replay.outcome === 'VERIFIED_COMPLETE' &&
    goldenOk.ok;

  const baseline: EvalTaskResult = {
    task_id: 'offline-harness-factor-1',
    variant: 'baseline-substrate',
    verified_complete_no_policy_violation: true,
    tokens: tokensBefore,
    duration_ms: duration,
    false_completion: false,
    instruction_policy_violation: false,
    resume_state_equivalent: resumeEq.ok,
    critical_fact_retention: retention.rate,
    infrastructure_failure: false,
    agent_failure: false,
    human_intervention: false,
    clean_room_pass: null,
  };
  const candidate: EvalTaskResult = {
    ...baseline,
    variant: 'hardened-offline',
    tokens: tokensAfter,
    verified_complete_no_policy_violation: hardenedOk,
    false_completion: emptyPromo.authorize_verified_complete,
    instruction_policy_violation: unknownDenied.allowed,
  };

  const results = [baseline, candidate];
  const ledger = appendFailureLedger([], {
    episode_id: log.session_id,
    failure_class: 'false_completion',
    regression_fixture: 'harnessHardening.h3h7.test.ts',
    held_out: true,
  });

  return {
    schema_version: HARNESS_EVAL_VERSION,
    controls: {
      ...controls,
      model_snapshot: 'offline-harness-factor@none',
    },
    results,
    paired_deltas: computePairedDeltas([baseline], [candidate], 'tokens'),
    failure_ledger: ledger,
    metrics: computeCoreMetrics(results),
    experimental_evidence: true,
    notes: [
      'Offline harness-factor factorial — drives shipped compaction/capability/verifier/session/replay paths',
      'NOT same-model Chat/Deep LLM factorial (see runSameModelLlmFactorial for model-path cells)',
      `token_reduction=${tokensBefore}->${tokensAfter}`,
      `critical_fact_retention=${retention.rate}`,
      `unknown_tool_denied=${!unknownDenied.allowed}`,
      `empty_verifier_blocked=${!emptyPromo.authorize_verified_complete}`,
      `resume_equivalent=${resumeEq.ok}`,
      `golden_ok=${goldenOk.ok}`,
    ],
  };
}

/**
 * Same-model LLM factorial (H7 model-path experimental evidence).
 *
 * Fixed controls: model snapshot, temperature, task set, repo revision,
 * permissions, verifier profile, resource profile, environment digest.
 * Variants under the same model:
 *   - minimal_loop: direct provider completion (no ChatEngine harness)
 *   - chat_harness: ChatEngine submitMessage with real runner (complete path)
 *   - deep_profile: ChatEngine with executionProfile=deep (same model)
 *
 * Requires OPENROUTER_API_KEY (or opts.apiKey). Marks experimental_evidence:true
 * only when at least one model cell succeeds under fixed controls.
 */
export async function runSameModelLlmFactorial(input: {
  controls: FixedEvalControls;
  /** Absolute workspace for ChatEngine projectRoot. */
  workspace_path: string;
  /** OpenRouter model id, e.g. openai/gpt-4o-mini */
  model_id?: string;
  api_key_env?: string;
  /** Max tasks from the fixed set (default 2). */
  max_tasks?: number;
  /** Repeated paired trials per task/variant; defaults to three. */
  repetitions?: number;
}): Promise<HarnessEvalReport> {
  const modelId = input.model_id ?? 'openai/gpt-4o-mini';
  const apiKeyEnv = input.api_key_env ?? 'OPENROUTER_API_KEY';
  const apiKey = process.env[apiKeyEnv] ?? '';
  const notes: string[] = [
    'Same-model LLM factorial — OpenRouter gateway',
    `model_id=${modelId}`,
    `api_key_env=${apiKeyEnv}`,
    `temperature=${input.controls.sampling.temperature}`,
    `workspace=${input.workspace_path}`,
  ];
  const results: EvalTaskResult[] = [];
  const failureLedger: FailureLedgerEntry[] = [];

  if (!apiKey) {
    return {
      schema_version: HARNESS_EVAL_VERSION,
      controls: {
        ...input.controls,
        model_snapshot: `openrouter:${modelId}@blocked-no-key`,
      },
      results: [],
      paired_deltas: [],
      failure_ledger: [],
      metrics: computeCoreMetrics([]),
      experimental_evidence: false,
      notes: [...notes, 'BLOCKED: API key missing — no model-path experimental evidence'],
    };
  }

  const initialRevision = captureWorkspaceRevisionIdentity(input.workspace_path)
  const declaredRevisionMatches =
    input.controls.repository_revision === initialRevision.compositeTreeHash ||
    input.controls.repository_revision === initialRevision.gitCommitHash
  const effectivePermissions = process.env['BABEL_EXECUTION_PROFILE'] ?? input.controls.permissions_profile
  const effectiveVerifier = process.env['BABEL_VERIFIER_PROFILE'] ?? input.controls.verifier_profile
  const effectiveResource = process.env['BABEL_RESOURCE_PROFILE'] ?? input.controls.resource_profile
  const controlDeviations = [
    ...(!declaredRevisionMatches ? ['repository_revision'] : []),
    ...(effectivePermissions !== input.controls.permissions_profile ? ['permissions_profile'] : []),
    ...(effectiveVerifier !== input.controls.verifier_profile ? ['verifier_profile'] : []),
    ...(effectiveResource !== input.controls.resource_profile ? ['resource_profile'] : []),
    ...(!input.controls.environment_digest ? ['environment_digest'] : []),
  ]
  if (controlDeviations.length > 0) {
    return {
      schema_version: HARNESS_EVAL_VERSION,
      controls: input.controls,
      results: [],
      paired_deltas: [],
      failure_ledger: [{
        entry_id: randomUUID(),
        episode_id: 'h7-control-preflight',
        failure_class: 'infrastructure_control',
        regression_fixture: 'runSameModelLlmFactorial.controls',
        created_at: new Date().toISOString(),
        held_out: false,
      }],
      metrics: computeCoreMetrics([]),
      experimental_evidence: false,
      notes: [...notes, `BLOCKED: uncontrolled comparison (${controlDeviations.join(',')})`],
    }
  }

  // Tasks must classify as ChatEngine 'explain' intent (do not edit / what is)
  // so completion gates do not demand file mutations.
  const tasks = [
    {
      task_id: 'h7-t1-answer',
      task: 'Explain what is 2+2 without editing files. Answer only.',
      user_message: 'What is 2+2? Reply with only the number.',
    },
    {
      task_id: 'h7-t2-pong',
      task: 'Explain only — reply with the word PONG. Do not edit or modify files.',
      user_message: 'Reply with exactly the word PONG and nothing else.',
    },
  ].slice(0, input.max_tasks ?? 2);

  const temperature = input.controls.sampling.temperature;
  const maxTokens = input.controls.sampling.max_tokens ?? 64;

  async function minimalLoop(
    taskId: string,
    userMessage: string,
  ): Promise<EvalTaskResult> {
    const t0 = Date.now();
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/gthgomez/Babel',
          'X-Title': 'Babel H7 same-model factorial',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: userMessage }],
          temperature,
          max_tokens: maxTokens,
        }),
      });
      const body = (await r.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      if (!r.ok) {
        return {
          task_id: taskId,
          variant: 'minimal_loop',
          verified_complete_no_policy_violation: false,
          tokens: 0,
          duration_ms: Date.now() - t0,
          false_completion: false,
          instruction_policy_violation: false,
          resume_state_equivalent: null,
          critical_fact_retention: null,
          infrastructure_failure: true,
          agent_failure: false,
          human_intervention: false,
          clean_room_pass: null,
        };
      }
      const text = String(body.choices?.[0]?.message?.content ?? '');
      const tokens =
        body.usage?.total_tokens ??
        (body.usage?.prompt_tokens ?? 0) + (body.usage?.completion_tokens ?? 0);
      const ok =
        text.trim().length > 0 &&
        !/error|unavailable/i.test(text) &&
        (taskId.includes('pong') ? /PONG/i.test(text) : /4/.test(text));
      return {
        task_id: taskId,
        variant: 'minimal_loop',
        verified_complete_no_policy_violation: ok,
        tokens: tokens || 1,
        duration_ms: Date.now() - t0,
        false_completion: false,
        instruction_policy_violation: false,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: false,
        agent_failure: !ok,
        human_intervention: false,
        clean_room_pass: null,
      };
    } catch (e) {
      failureLedger.push({
        entry_id: randomUUID(),
        episode_id: taskId,
        failure_class: 'infrastructure',
        regression_fixture: 'runSameModelLlmFactorial',
        created_at: new Date().toISOString(),
        held_out: false,
      });
      return {
        task_id: taskId,
        variant: 'minimal_loop',
        verified_complete_no_policy_violation: false,
        tokens: 0,
        duration_ms: Date.now() - t0,
        false_completion: false,
        instruction_policy_violation: false,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: true,
        agent_failure: false,
        human_intervention: false,
        clean_room_pass: null,
      };
    }
  }

  async function chatVariant(
    taskId: string,
    task: string,
    userMessage: string,
    variant: 'chat_harness' | 'deep_profile',
  ): Promise<EvalTaskResult> {
    const t0 = Date.now();
    const priorAutoApprove = process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
    try {
      const { ChatEngine } = await import('./chatEngine.js');
      const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js');
      // Engine model must be a configured policy family; actual inference uses
      // OpenRouter runner with the fixed modelId (same for all variants).
      const runner = new OpenRouterApiRunner(modelId, {
        maxTokens,
        temperature,
      }, {
        apiKeyEnvVar: apiKeyEnv,
      });
      const engine = new ChatEngine({
        task,
        projectRoot: input.workspace_path,
        model: 'DeepSeek',
        maxTurns: 3,
        executionProfile: variant === 'deep_profile' ? 'deep' : 'chat',
        runtimeMode: 'direct',
      });
      const anyEngine = engine as unknown as {
        deliberationRunner: unknown;
        synthesisRunner: unknown;
        fallbackRunner: unknown;
        shouldUseNativeTools: () => boolean;
      };
      anyEngine.deliberationRunner = runner;
      anyEngine.synthesisRunner = runner;
      anyEngine.fallbackRunner = runner;
      // Complete-only: avoid tool loops for stable factorial cells
      anyEngine.shouldUseNativeTools = () => false;
      const turn: unknown = await engine.submitMessage(userMessage, { onThought: () => {} });
      const t = (turn ?? {}) as unknown as Record<string, unknown>;
      const answer = typeof t['answer'] === 'string' ? t['answer'] : '';
      const status = typeof t['status'] === 'string' ? t['status'] : '';
      const outcome = typeof t['outcome'] === 'string' ? t['outcome'] : '';
      const usage = t['usage'] as
        | { totalTokens?: number; totalInputTokens?: number; totalOutputTokens?: number }
        | undefined;
      const meta = runner.getLastInvocationMetadata?.() as
        | {
            total_tokens?: number;
            prompt_tokens?: number;
            completion_tokens?: number;
            usage?: { totalTokens?: number };
          }
        | null
        | undefined;
      const rawTokens =
        usage?.totalTokens ??
        meta?.total_tokens ??
        meta?.usage?.totalTokens ??
        (meta?.prompt_tokens ?? 0) + (meta?.completion_tokens ?? 0);
      const tokens =
        typeof rawTokens === 'number' && rawTokens > 0
          ? rawTokens
          : Math.max(1, Math.ceil(answer.length / 4));
      const contentOk =
        answer.trim().length > 0 &&
        !/Turn limit exceeded|Gate check|CAPABILITY_DENIED/i.test(answer) &&
        (taskId.includes('pong') ? /PONG/i.test(answer) : /4/.test(answer));
      const statusOk =
        status === 'completed' ||
        status === 'done' ||
        outcome === 'NO_CHANGE_REQUIRED' ||
        outcome === 'VERIFIED_COMPLETE' ||
        outcome === 'UNVERIFIED_PATCH' ||
        (status !== 'failed' && contentOk);
      const ok = contentOk && statusOk;
      const policyViolation = /CAPABILITY_DENIED|policy/i.test(answer);
      return {
        task_id: taskId,
        variant,
        verified_complete_no_policy_violation: ok && !policyViolation,
        tokens: Number(tokens) || 1,
        duration_ms: Date.now() - t0,
        false_completion: false,
        instruction_policy_violation: policyViolation,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: false,
        agent_failure: !ok,
        human_intervention: false,
        clean_room_pass: null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(`${variant}:${taskId}:error=${msg.slice(0, 160)}`);
      failureLedger.push({
        entry_id: randomUUID(),
        episode_id: `${variant}:${taskId}`,
        failure_class: /timeout|ECONN|429|5\d\d|fetch/i.test(msg)
          ? 'infrastructure'
          : 'agent',
        regression_fixture: 'runSameModelLlmFactorial',
        created_at: new Date().toISOString(),
        held_out: false,
      });
      return {
        task_id: taskId,
        variant,
        verified_complete_no_policy_violation: false,
        tokens: 0,
        duration_ms: Date.now() - t0,
        false_completion: false,
        instruction_policy_violation: false,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: /timeout|ECONN|429|5\d\d|fetch/i.test(msg),
        agent_failure: !/timeout|ECONN|429|5\d\d|fetch/i.test(msg),
        human_intervention: false,
        clean_room_pass: null,
      };
    } finally {
      if (priorAutoApprove === undefined) delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
      else process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = priorAutoApprove;
    }
  }

  const repetitions = Math.max(2, Math.floor(input.repetitions ?? 3));
  async function controlledCell(run: () => Promise<EvalTaskResult>): Promise<EvalTaskResult> {
    const before = captureWorkspaceRevisionIdentity(input.workspace_path)
    const result = await run()
    const after = captureWorkspaceRevisionIdentity(input.workspace_path)
    if (before.compositeTreeHash === after.compositeTreeHash) return result
    failureLedger.push({
      entry_id: randomUUID(),
      episode_id: `${result.variant}:${result.task_id}:${result.trial_index ?? 'trial'}`,
      failure_class: 'infrastructure_control',
      regression_fixture: 'runSameModelLlmFactorial.repository_revision',
      created_at: new Date().toISOString(),
      held_out: false,
    })
    return {
      ...result,
      verified_complete_no_policy_violation: false,
      infrastructure_failure: true,
      agent_failure: false,
    }
  }
  for (let trialIndex = 0; trialIndex < repetitions; trialIndex += 1) {
    for (const t of tasks) {
      results.push({ ...(await controlledCell(() => minimalLoop(t.task_id, t.user_message))), trial_index: trialIndex });
      results.push({ ...(await controlledCell(() => chatVariant(t.task_id, t.task, t.user_message, 'chat_harness'))), trial_index: trialIndex });
      results.push({ ...(await controlledCell(() => chatVariant(t.task_id, t.task, t.user_message, 'deep_profile'))), trial_index: trialIndex });
    }
  }

  const minimal = results.filter((r) => r.variant === 'minimal_loop');
  const chat = results.filter((r) => r.variant === 'chat_harness');
  const deep = results.filter((r) => r.variant === 'deep_profile');
  const paired = [
    ...computePairedDeltas(minimal, chat, 'tokens'),
    ...computePairedDeltas(minimal, deep, 'tokens'),
    ...computePairedDeltas(minimal, chat, 'duration_ms'),
  ];

  const anyOk = results.some((r) => r.verified_complete_no_policy_violation && !r.infrastructure_failure);
  const modelSnapshot = `openrouter:${modelId}@temp${temperature}`;
  notes.push(
    `cells=${results.length}`,
    `repetitions=${repetitions}`,
    `minimal_ok=${minimal.filter((r) => r.verified_complete_no_policy_violation).length}/${minimal.length}`,
    `chat_ok=${chat.filter((r) => r.verified_complete_no_policy_violation).length}/${chat.length}`,
    `deep_ok=${deep.filter((r) => r.verified_complete_no_policy_violation).length}/${deep.length}`,
    `paired_deltas=${paired.length}`,
    'Deep cell uses ChatEngine executionProfile=deep (not full Deep pipeline stages)',
  );

  return {
    schema_version: HARNESS_EVAL_VERSION,
    controls: {
      ...input.controls,
      model_snapshot: modelSnapshot,
    },
    results,
    paired_deltas: paired,
    failure_ledger: failureLedger,
    metrics: computeCoreMetrics(results),
    experimental_evidence: anyOk,
    notes,
  };
}

/**
 * Persist an eval report under `dir`. Rejects missing/placeholder paths so a
 * forgotten CLI arg cannot create a literal `undefined/` directory (seen when
 * `String(undefined)` or an unset env was passed as the output root).
 */
export function writeEvalReport(dir: string, report: HarnessEvalReport): string {
  if (typeof dir !== 'string') {
    throw new Error(
      `writeEvalReport: invalid output directory ${JSON.stringify(dir)}; pass an explicit path`,
    );
  }
  const trimmed = dir.trim();
  const leaf = basename(normalize(trimmed));
  if (!trimmed || leaf === 'undefined' || leaf === 'null') {
    throw new Error(
      `writeEvalReport: invalid output directory ${JSON.stringify(dir)}; pass an explicit path`,
    );
  }
  mkdirSync(trimmed, { recursive: true });
  const path = join(trimmed, 'harness-eval-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8');
  return path;
}

export function readEvalReport(path: string): HarnessEvalReport {
  return JSON.parse(readFileSync(path, 'utf-8')) as HarnessEvalReport;
}

/**
 * Controls must match for fair harness comparison; otherwise disclose deviation.
 */
export function controlsMatch(
  a: FixedEvalControls,
  b: FixedEvalControls,
): { ok: boolean; deviations: string[] } {
  const deviations: string[] = [];
  const keys: (keyof FixedEvalControls)[] = [
    'task_set_id',
    'model_snapshot',
    'repository_revision',
    'permissions_profile',
    'verifier_profile',
    'resource_profile',
    'environment_digest',
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) deviations.push(String(k));
  }
  if (a.sampling.temperature !== b.sampling.temperature) {
    deviations.push('sampling.temperature');
  }
  if (a.sampling.top_p !== b.sampling.top_p) deviations.push('sampling.top_p');
  if (a.sampling.max_tokens !== b.sampling.max_tokens) deviations.push('sampling.max_tokens');
  return { ok: deviations.length === 0, deviations };
}
