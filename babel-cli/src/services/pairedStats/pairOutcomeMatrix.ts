/**
 * pairedStats/pairOutcomeMatrix.ts — pure deterministic causal statistics
 * over normalized paired attempt outcomes (workstream D / roadmap item W3 of
 * docs/roadmaps/OX_ALPHA_EXPERIMENTAL_PROGRAM.md).
 *
 * Consumes ONLY `NormalizedAttemptOutcome` from ./contracts.js and honors the
 * `computePairedDeltas` precedent semantics: unresolved attempts
 * (`success === null`) are never dropped silently and never counted as
 * failures — they are excluded from denominators and REPORTED as `n_null`.
 *
 * Statistical methods (documented per mission contract):
 * - Per-rate uncertainty: standard Wilson score interval, two-sided 95%
 *   (z = 1.959963984540054):
 *     center = (p + z^2/(2n)) / (1 + z^2/n)
 *     margin = (z / (1 + z^2/n)) · sqrt(p(1−p)/n + z^2/(4n^2))
 * - `success_delta` (= cand_rate − ref_rate, PRIMARY metric) carries a
 *   conservative Newcombe-style hybrid-score interval built from the two
 *   Wilson intervals, following the existing repo precedent
 *   (`injectionBenchmark.wilsonScoreCi`, which this deliberately mirrors):
 *     low  = d − z·sqrt((p_c − L_c)^2 + (U_r − p_r)^2)
 *     high = d + z·sqrt((U_c − p_c)^2 + (p_r − L_r)^2)
 *   The extra z factor makes this wider than textbook Newcombe method 10 —
 *   an intentionally conservative approximation, kept consistent with the
 *   rest of this repository's statistics.
 * - Ratio is SECONDARY ONLY: `success_rate_ratio` is emitted with an explicit
 *   `ratio_stability` note and is NEVER used for ranking/sorting anywhere in
 *   this module.
 *
 * Pair classification compares every candidate arm against the reference arm
 * using the MAJORITY outcome across replicates within each pair × arm cell
 * (strict majority of resolved attempts; even splits resolve to a 'tie'
 * component). One vocabulary addition beyond the four roadmap cells:
 * `ambiguous_tie` — one or both components are tied majorities, so no
 * directional cell applies while attempts DID resolve (recording those as
 * `incomplete` would understate the evidence). Totals are zero-filled over
 * the full classification vocabulary so the artifact shape stays exhaustive
 * and stable.
 *
 * Symmetric evidentiary standard: classification totals are ungated, but BOTH
 * surfaced candidate lists — negative `suppression_suspects` AND positive
 * `uplift_pairs` — require MIN_REPLICATES_FOR_SUSPECT resolved candidate-arm
 * replicates within the pair. Positive claims must clear the same anti-noise
 * bar as negative ones; a single replicate is never enough to list either
 * direction (it still counts toward classification totals).
 *
 * Input integrity: attempts must be unique per (pair_id, arm, replicate_id).
 * Duplicated triples are a producer data bug that would silently inflate
 * majority counts, so `buildPairOutcomeMatrix` fails closed with an error
 * naming the first offending triple rather than deduplicating silently.
 *
 * Pure core: no network, no filesystem access, no randomness, and identical
 * inputs produce deep-equal artifacts (pass an explicit `generatedAt` when
 * bit-for-bit reproducibility across runs is required).
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { HarnessIdentitySchema } from '../experimentIdentity.js';
import type { HarnessIdentity } from '../experimentIdentity.js';
import {
  NormalizedAttemptOutcomeSchema,
  REFERENCE_ARM,
} from './contracts.js';
import type { NormalizedAttemptOutcome } from './contracts.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const PAIR_OUTCOME_MATRIX_SCHEMA_VERSION = 1 as const;
export const PAIR_OUTCOME_MATRIX_KIND = 'babel_pair_outcome_matrix' as const;

/** Filename written by {@link writeFilePairOutcomeMatrix}. */
export const PAIR_OUTCOME_MATRIX_FILENAME = 'pair-outcome-matrix.json';

/**
 * Minimum number of RESOLVED replicates required on the candidate side of a
 * pair before a directional cell is surfaced in its candidate list — BOTH
 * `suppression_suspect_raw_only` entries AND `uplift_pairs` entries (symmetric
 * evidentiary standard: positive claims are held to the same single-run-noise
 * bar as negative ones). Classification totals remain ungated.
 */
export const MIN_REPLICATES_FOR_SUSPECT = 2;

/** Two-sided 95% normal quantile used for all intervals in this module. */
export const WILSON_Z_95 = 1.959963984540054;

// ─── Zod schemas (source of truth for the artifact) ──────────────────────────

export const WilsonIntervalSchema = z.object({
  low: z.number().min(0).max(1),
  high: z.number().min(0).max(1),
});
export type WilsonInterval = z.infer<typeof WilsonIntervalSchema>;

export const PAIR_CLASSIFICATIONS = [
  'both_pass',
  'both_fail',
  'uplift_babel_only',
  'suppression_suspect_raw_only',
  'incomplete',
  /**
   * Strict-majority tie on one or both sides of the comparison: none of the
   * four directional cells applies, yet the underlying attempts did resolve.
   * Explicitly reported so classification totals remain exhaustive and no
   * tie evidence is silently folded into a directional bucket.
   */
  'ambiguous_tie',
] as const;
export type PairClassification = (typeof PAIR_CLASSIFICATIONS)[number];

export const PairClassificationSchema = z.enum(PAIR_CLASSIFICATIONS);

export const ArmSummarySchema = z.object({
  arm: z.string().min(1),
  /** Structured identity carried from the attempts when producers supplied it. */
  harness: HarnessIdentitySchema.optional(),
  n_pass: z.number().int().nonnegative(),
  n_fail: z.number().int().nonnegative(),
  /** Unresolved attempts (success === null): excluded from rates, never failures. */
  n_null: z.number().int().nonnegative(),
  /** n_pass / (n_pass + n_fail); null when the arm has zero resolved attempts. */
  pass_rate: z.number().min(0).max(1).nullable(),
  pass_rate_wilson_95: WilsonIntervalSchema.nullable(),
});
export type ArmSummary = z.infer<typeof ArmSummarySchema>;

export const RatioStabilitySchema = z.enum([
  'ok',
  'unstable_reference_near_zero',
  'undefined',
]);
export type RatioStability = z.infer<typeof RatioStabilitySchema>;

export const PairwiseDeltaSchema = z.object({
  candidate_arm: z.string().min(1),
  reference_arm: z.string().min(1),
  /**
   * Distinct pair_ids where BOTH arms contribute at least one resolved
   * attempt — the actual paired information behind this comparison.
   */
  n_pairs: z.number().int().nonnegative(),
  cand_pass_rate: z.number().min(0).max(1).nullable(),
  ref_pass_rate: z.number().min(0).max(1).nullable(),
  cand_rate_wilson_95: WilsonIntervalSchema.nullable(),
  ref_rate_wilson_95: WilsonIntervalSchema.nullable(),
  /** PRIMARY metric: cand_pass_rate − ref_pass_rate; null if either rate is null. */
  success_delta: z.number().min(-1).max(1).nullable(),
  delta_ci_low: z.number().min(-1).max(1).nullable(),
  delta_ci_high: z.number().min(-1).max(1).nullable(),
  /** SECONDARY metric only — never used for ranking/sorting. */
  success_rate_ratio: z.number().nullable(),
  ratio_stability: RatioStabilitySchema,
});
export type PairwiseDelta = z.infer<typeof PairwiseDeltaSchema>;

export const PairSuspectSchema = z.object({
  pair_id: z.string().min(1),
  task_id: z.string().min(1),
  candidate_arm: z.string().min(1),
});
export type PairSuspect = z.infer<typeof PairSuspectSchema>;

export const TaskClassBlockSchema = z.object({
  task_class: z.string().min(1),
  arm_summaries: z.array(ArmSummarySchema),
  pairwise_deltas: z.array(PairwiseDeltaSchema),
});
export type TaskClassBlock = z.infer<typeof TaskClassBlockSchema>;

export const PairOutcomeMatrixArtifactSchema = z.object({
  kind: z.literal(PAIR_OUTCOME_MATRIX_KIND),
  schema_version: z.literal(PAIR_OUTCOME_MATRIX_SCHEMA_VERSION),
  generated_at: z.string().min(1),
  reference_arm: z.string().min(1),
  /** Keys cover the full vocabulary; insertion order: count desc, then key asc. */
  totals_by_classification: z.record(z.string(), z.number().int().nonnegative()),
  /** Sorted by arm asc. Includes the reference arm itself. */
  arm_summaries: z.array(ArmSummarySchema),
  /** Sorted by candidate_arm asc. One entry per candidate arm with data when the reference arm has any attempts in scope. */
  pairwise_deltas: z.array(PairwiseDeltaSchema),
  /**
   * Sorted by (pair_id, candidate_arm) asc. Gated by MIN_REPLICATES_FOR_SUSPECT
   * on resolved candidate-arm replicates within the pair.
   */
  suppression_suspects: z.array(PairSuspectSchema),
  /**
   * Sorted by (pair_id, candidate_arm) asc. Gated by the SAME
   * MIN_REPLICATES_FOR_SUSPECT bar as suppression_suspects — symmetric
   * evidentiary standard, positive claims are not cheaper than negative ones.
   */
  uplift_pairs: z.array(PairSuspectSchema),
  /** Pairs containing zero reference-arm attempts (excluded from classification). */
  pairs_missing_reference_count: z.number().int().nonnegative(),
  /** Grouped by task_class ?? 'unclassified'; sorted by task_class asc. */
  by_task_class: z.array(TaskClassBlockSchema),
});
export type PairOutcomeMatrixArtifact = z.infer<typeof PairOutcomeMatrixArtifactSchema>;

// ─── Small deterministic helpers ─────────────────────────────────────────────

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAttempts(a: NormalizedAttemptOutcome, b: NormalizedAttemptOutcome): number {
  if (a.replicate_id !== b.replicate_id) return a.replicate_id - b.replicate_id;
  return compareStrings(a.attempt_id ?? '', b.attempt_id ?? '');
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function countResolved(attempts: readonly NormalizedAttemptOutcome[]): number {
  let n = 0;
  for (const a of attempts) if (a.success !== null) n += 1;
  return n;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// ─── Statistics: Wilson interval + conservative Newcombe-style delta CI ──────

/**
 * Standard Wilson score interval for a binomial proportion (two-sided 95% by
 * default). Returns null when there is nothing to estimate (n === 0).
 */
export function wilsonScoreInterval(passes: number, n: number): WilsonInterval | null {
  if (!(Number.isInteger(n) && Number.isInteger(passes))) return null;
  if (n <= 0 || passes < 0 || passes > n) return null;
  const p = passes / n;
  const z = WILSON_Z_95;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: clamp01(center - margin), high: clamp01(center + margin) };
}

/**
 * Conservative Newcombe-style hybrid-score interval for the difference
 * `candRate − refRate`, constructed from the two Wilson intervals exactly as
 * in the repo precedent `injectionBenchmark.wilsonScoreCi` (see module docs).
 * Returns null when either side lacks a resolvable interval.
 */
function newcombeStyleDeltaCi(
  cand: { passes: number; n: number },
  ref: { passes: number; n: number },
): [number, number] | null {
  const wCand = wilsonScoreInterval(cand.passes, cand.n);
  const wRef = wilsonScoreInterval(ref.passes, ref.n);
  if (!wCand || !wRef) return null;
  const pCand = cand.passes / cand.n;
  const pRef = ref.passes / ref.n;
  const d = pCand - pRef;
  const z = WILSON_Z_95;
  const low =
    d -
    z * Math.sqrt((pCand - wCand.low) ** 2 + (wRef.high - pRef) ** 2);
  const high =
    d +
    z * Math.sqrt((wCand.high - pCand) ** 2 + (pRef - wRef.low) ** 2);
  return [Math.max(-1, low), Math.min(1, high)];
}

// ── Per-arm summaries ────────────────────────────────────────────────────────

function summarizeArm(arm: string, sortedAttempts: readonly NormalizedAttemptOutcome[]): ArmSummary {
  let n_pass = 0;
  let n_fail = 0;
  let n_null = 0;
  let harness: HarnessIdentity | undefined;
  for (const a of sortedAttempts) {
    if (a.success === true) n_pass += 1;
    else if (a.success === false) n_fail += 1;
    else n_null += 1;
    if (harness === undefined && a.harness !== undefined) harness = a.harness;
  }
  const resolved = n_pass + n_fail;
  const pass_rate = resolved > 0 ? n_pass / resolved : null;
  const summary: ArmSummary = {
    arm,
    n_pass,
    n_fail,
    n_null,
    pass_rate,
    pass_rate_wilson_95: resolved > 0 ? wilsonScoreInterval(n_pass, resolved) : null,
  };
  if (harness !== undefined) summary.harness = harness;
  return summary;
}

function buildArmSummaries(sortedAttempts: readonly NormalizedAttemptOutcome[]): ArmSummary[] {
  const byArm = groupBy(sortedAttempts, (a) => a.arm);
  const arms = [...byArm.keys()].sort(compareStrings);
  return arms.map((arm) => summarizeArm(arm, byArm.get(arm) ?? []));
}

// ── Pairwise deltas ──────────────────────────────────────────────────────────

function buildPairwiseDeltas(
  sortedAttempts: readonly NormalizedAttemptOutcome[],
  referenceArm: string,
): PairwiseDelta[] {
  const summaries = buildArmSummaries(sortedAttempts);
  const byArm = new Map(summaries.map((s) => [s.arm, s]));
  const ref = byArm.get(referenceArm);
  // Without any reference-arm observation in scope there is nothing to
  // compare against — emit no delta rows rather than rows of nulls.
  if (!ref || ref.n_pass + ref.n_fail + ref.n_null === 0) return [];

  const resolvedPairsByArm = new Map<string, Set<string>>();
  for (const a of sortedAttempts) {
    if (a.success === null) continue;
    let set = resolvedPairsByArm.get(a.arm);
    if (!set) {
      set = new Set<string>();
      resolvedPairsByArm.set(a.arm, set);
    }
    set.add(a.pair_id);
  }

  const deltas: PairwiseDelta[] = [];
  for (const cand of summaries) {
    if (cand.arm === referenceArm) continue;
    const candResolved = resolvedPairsByArm.get(cand.arm);
    const refResolved = resolvedPairsByArm.get(referenceArm);
    const n_pairs = candResolved && refResolved
      ? [...candResolved].filter((pairId) => refResolved.has(pairId)).length
      : 0;

    let success_delta: number | null = null;
    let delta_ci_low: number | null = null;
    let delta_ci_high: number | null = null;
    if (cand.pass_rate !== null && ref.pass_rate !== null) {
      success_delta = cand.pass_rate - ref.pass_rate;
      const ci = newcombeStyleDeltaCi(
        { passes: cand.n_pass, n: cand.n_pass + cand.n_fail },
        { passes: ref.n_pass, n: ref.n_pass + ref.n_fail },
      );
      if (ci) {
        delta_ci_low = ci[0];
        delta_ci_high = ci[1];
      }
    }

    let success_rate_ratio: number | null = null;
    let ratio_stability: RatioStability;
    if (cand.pass_rate === null || ref.pass_rate === null) {
      ratio_stability = 'undefined';
    } else if (ref.pass_rate === 0) {
      // Reference baseline is at zero: the ratio explodes toward infinity and
      // carries no usable information. Suppressed with an explicit flag.
      ratio_stability = 'unstable_reference_near_zero';
    } else {
      success_rate_ratio = cand.pass_rate / ref.pass_rate;
      ratio_stability = 'ok';
    }

    deltas.push({
      candidate_arm: cand.arm,
      reference_arm: referenceArm,
      n_pairs,
      cand_pass_rate: cand.pass_rate,
      ref_pass_rate: ref.pass_rate,
      cand_rate_wilson_95: cand.pass_rate_wilson_95,
      ref_rate_wilson_95: ref.pass_rate_wilson_95,
      success_delta,
      delta_ci_low,
      delta_ci_high,
      success_rate_ratio,
      ratio_stability,
    });
  }
  return deltas;
}

// ── Pair classification ──────────────────────────────────────────────────────

type MajorityComponent = 'pass' | 'fail' | 'tie' | null;

/** Strict majority of resolved attempts; even split → 'tie'; none resolved → null. */
function majorityComponent(
  attempts: readonly NormalizedAttemptOutcome[],
): MajorityComponent {
  let pass = 0;
  let fail = 0;
  for (const a of attempts) {
    if (a.success === true) pass += 1;
    else if (a.success === false) fail += 1;
  }
  const resolved = pass + fail;
  if (resolved === 0) return null;
  if (pass * 2 > resolved) return 'pass';
  if (fail * 2 > resolved) return 'fail';
  return 'tie';
}

function classifyCell(refComp: MajorityComponent, candComp: MajorityComponent): PairClassification {
  if (refComp === null || candComp === null) return 'incomplete';
  if (refComp === 'pass') {
    if (candComp === 'fail') return 'suppression_suspect_raw_only';
    if (candComp === 'pass') return 'both_pass';
    return 'ambiguous_tie';
  }
  if (refComp === 'fail') {
    if (candComp === 'pass') return 'uplift_babel_only';
    if (candComp === 'fail') return 'both_fail';
    return 'ambiguous_tie';
  }
  return 'ambiguous_tie';
}

interface ClassificationResult {
  totals: Record<PairClassification, number>;
  suppression_suspects: PairSuspect[];
  uplift_pairs: PairSuspect[];
  pairs_missing_reference_count: number;
}

function classifyAllPairs(
  sortedAttempts: readonly NormalizedAttemptOutcome[],
  referenceArm: string,
): ClassificationResult {
  const totals = {} as Record<PairClassification, number>;
  for (const cls of PAIR_CLASSIFICATIONS) totals[cls] = 0;
  const suppression_suspects: PairSuspect[] = [];
  const uplift_pairs: PairSuspect[] = [];
  let pairs_missing_reference_count = 0;

  const byPair = groupBy(sortedAttempts, (a) => a.pair_id);
  const pairIds = [...byPair.keys()].sort(compareStrings);

  for (const pairId of pairIds) {
    const attemptsInPair = (byPair.get(pairId) ?? []).slice().sort(compareAttempts);
    const byArm = groupBy(attemptsInPair, (a) => a.arm);
    const refAttempts = byArm.get(referenceArm);
    // Pairs without ANY reference-arm attempt are excluded from pairwise
    // classification entirely and only counted as missing-reference.
    if (!refAttempts || refAttempts.length === 0) {
      pairs_missing_reference_count += 1;
      continue;
    }
    const task_id = attemptsInPair[0]?.task_id ?? '';
    const candidateArms = [...byArm.keys()].filter((a) => a !== referenceArm).sort(compareStrings);
    for (const candArm of candidateArms) {
      const candAttempts = byArm.get(candArm);
      if (!candAttempts) continue;
      const classification = classifyCell(majorityComponent(refAttempts), majorityComponent(candAttempts));
      totals[classification] += 1;
      // Symmetric evidentiary standard (m3): both directional candidate lists
      // clear the same MIN_REPLICATES_FOR_SUSPECT resolved-replicate gate.
      // Totals stay ungated — a single-replicate directional cell is still
      // classified and counted, it just never becomes a listed candidate.
      if (classification === 'suppression_suspect_raw_only') {
        if (countResolved(candAttempts) >= MIN_REPLICATES_FOR_SUSPECT) {
          suppression_suspects.push({ pair_id: pairId, task_id, candidate_arm: candArm });
        }
      } else if (classification === 'uplift_babel_only') {
        if (countResolved(candAttempts) >= MIN_REPLICATES_FOR_SUSPECT) {
          uplift_pairs.push({ pair_id: pairId, task_id, candidate_arm: candArm });
        }
      }
    }
  }

  const byOrder = (x: PairSuspect, y: PairSuspect): number =>
    compareStrings(x.pair_id, y.pair_id) || compareStrings(x.candidate_arm, y.candidate_arm);
  suppression_suspects.sort(byOrder);
  uplift_pairs.sort(byOrder);

  return {
    totals,
    suppression_suspects,
    uplift_pairs,
    pairs_missing_reference_count,
  };
}

/** Insertion order: count descending, then key ascending (deterministic). */
function orderTotalsByCountDescThenKeyAsc(
  totals: Record<PairClassification, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(totals).sort(([keyA, countA], [keyB, countB]) =>
      countB - countA || compareStrings(keyA, keyB),
    ),
  );
}

// ── Artifact builder (pure) ──────────────────────────────────────────────────

export interface BuildPairOutcomeMatrixOptions {
  /** Defaults to REFERENCE_ARM ('raw_opencode') from ./contracts.js. */
  referenceArm?: string;
  /** Fixed timestamp for reproducible artifacts; defaults to wall clock. */
  generatedAt?: string;
}

/**
 * Consumer-side input integrity check (m5): each attempt must be unique per
 * (pair_id, arm, replicate_id). A repeated triple is a producer data bug that
 * would silently inflate majority counts, so we FAIL CLOSED instead of
 * deduplicating: the error names the first offending triple. Scanning the
 * canonically sorted array keeps the named triple deterministic regardless of
 * caller element order.
 */
function assertUniquePairArmReplicateTriples(
  sortedAttempts: readonly NormalizedAttemptOutcome[],
): void {
  const seen = new Set<string>();
  for (const a of sortedAttempts) {
    const key = `${a.pair_id}\u0000${a.arm}\u0000${a.replicate_id}`;
    if (seen.has(key)) {
      throw new Error(
        `duplicate (pair_id, arm, replicate_id) triple in pairedStats input: ` +
          `(pair_id=${JSON.stringify(a.pair_id)}, arm=${JSON.stringify(a.arm)}, replicate_id=${a.replicate_id}) — ` +
          'each replicate may appear at most once per pair × arm; deduplicate producer data upstream',
      );
    }
    seen.add(key);
  }
}

/**
 * Build the `babel_pair_outcome_matrix` artifact from terminal normalized
 * attempt outcomes. Pure and deterministic: identical inputs (with identical
 * options) yield deep-equal artifacts. Input attempts are validated against
 * NormalizedAttemptOutcomeSchema; invalid shapes throw. Duplicate
 * (pair_id, arm, replicate_id) triples are a caller data bug and fail closed
 * with an error naming the first offending triple (no silent dedupe).
 */
export function buildPairOutcomeMatrix(
  attempts: readonly NormalizedAttemptOutcome[],
  options: BuildPairOutcomeMatrixOptions = {},
): PairOutcomeMatrixArtifact {
  const referenceArm = options.referenceArm ?? REFERENCE_ARM;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const parsed = attempts.map((a) => NormalizedAttemptOutcomeSchema.parse(a));
  // One canonical sort up front; every consumer below relies on it, keeping
  // "first attempt wins" choices (task_id, harness identity) deterministic.
  const sorted = parsed.slice().sort(compareAttempts);
  assertUniquePairArmReplicateTriples(sorted);

  const classified = classifyAllPairs(sorted, referenceArm);

  const byTaskClass = groupBy(sorted, (a) => a.task_class ?? 'unclassified');
  const taskClasses = [...byTaskClass.keys()].sort(compareStrings);
  const by_task_class: TaskClassBlock[] = taskClasses.map((taskClass) => ({
    task_class: taskClass,
    arm_summaries: buildArmSummaries(byTaskClass.get(taskClass) ?? []),
    pairwise_deltas: buildPairwiseDeltas(byTaskClass.get(taskClass) ?? [], referenceArm),
  }));

  const draft: PairOutcomeMatrixArtifact = {
    kind: PAIR_OUTCOME_MATRIX_KIND,
    schema_version: PAIR_OUTCOME_MATRIX_SCHEMA_VERSION,
    generated_at: generatedAt,
    reference_arm: referenceArm,
    totals_by_classification: orderTotalsByCountDescThenKeyAsc(classified.totals),
    arm_summaries: buildArmSummaries(sorted),
    pairwise_deltas: buildPairwiseDeltas(sorted, referenceArm),
    suppression_suspects: classified.suppression_suspects,
    uplift_pairs: classified.uplift_pairs,
    pairs_missing_reference_count: classified.pairs_missing_reference_count,
    by_task_class,
  };
  return PairOutcomeMatrixArtifactSchema.parse(draft);
}

// ── Optional thin atomic writer (the ONLY I/O in this module) ────────────────

/**
 * Atomically persist an artifact as `<dir>/pair-outcome-matrix.json`
 * (temp file + rename, with a same-content rewrite fallback for the
 * Windows rename-over-existing case, mirroring
 * `causalCampaignContract.writeJsonAtomic`). Validates the artifact before
 * touching the filesystem. Returns the written path.
 */
export function writeFilePairOutcomeMatrix(dir: string, artifact: PairOutcomeMatrixArtifact): string {
  const validated = PairOutcomeMatrixArtifactSchema.parse(artifact);
  const target = join(dir, PAIR_OUTCOME_MATRIX_FILENAME);
  mkdirSync(dirname(target), { recursive: true });
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, target);
  } catch {
    // Windows: rename over an existing target may fail — rewrite in place.
    try {
      writeFileSync(target, content, 'utf8');
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
  return target;
}
