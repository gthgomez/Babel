/**
 * pairedStats/contracts.ts — frozen input contract between experiment
 * execution (producer) and causal statistics (consumer).
 *
 * Team D's estimators consume ONLY this shape; execution wiring conforms to
 * it. Keeping the seam tiny and frozen lets both sides build in parallel.
 */

import { z } from 'zod';
import { HarnessIdentitySchema } from '../experimentIdentity.js';

export const PAIRED_STATS_CONTRACTS_VERSION = 1 as const;

/**
 * One terminal normalized attempt. `success === null` means unresolved
 * (infrastructure failure, skipped, quarantine) — consumers must NOT count
 * nulls as failures.
 */
export const NormalizedAttemptOutcomeSchema = z.object({
  pair_id: z.string().min(1),
  task_id: z.string().min(1),
  task_class: z.string().nullable().default(null),
  /** Experiment label (e.g. babel_enforce, raw_opencode). */
  arm: z.string().min(1),
  replicate_id: z.number().int().nonnegative(),
  attempt_id: z.string().nullable().default(null),

  success: z.boolean().nullable(),
  /** Structured identity resolved at execution time (never inferred later). */
  harness: HarnessIdentitySchema.optional(),
  verifier_result: z.enum(['pass', 'fail', 'skipped', 'unavailable']).nullable().default(null),
  false_completion: z.boolean().nullable().default(null),
  duration_ms: z.number().nonnegative().nullable().default(null),
});
export type NormalizedAttemptOutcome = z.infer<typeof NormalizedAttemptOutcomeSchema>;

/** Baseline arm every delta is measured against in this program. */
export const REFERENCE_ARM = 'raw_opencode' as const;

export interface RawCampaignCellLike {
  instance_id: string;
  phase?: string | undefined;
  status: 'pass' | 'fail' | 'skipped';
  signature?: string | undefined;
  notes?: string[] | undefined;
  duration_ms?: number | undefined;
  arm?: string | undefined;
  replicate_id?: number | undefined;
  arm_harness?: z.infer<typeof HarnessIdentitySchema> | undefined;
  scoreboard?: {
    host_fail_to_pass?: boolean | null | undefined;
    gold_diagnostic?: boolean | null | undefined;
  } | undefined;
  fail_to_pass_ok?: boolean | null | undefined;
  gold_diff_ok?: boolean | null | undefined;
}

export interface ExpectedAttemptLike {
  attempt_id: string;
  pair_id: string;
  task_id: string;
  arm: string;
  replicate_id: number;
}

/**
 * Canonical converter from CampaignCellResult (producer) to
 * NormalizedAttemptOutcome (consumer). Derives rather than guesses
 * identity, verifier results, false completions, and unresolved states.
 */
export function normalizeCampaignCellOutcome(
  cell: RawCampaignCellLike,
  manifestAttempt?: ExpectedAttemptLike,
): NormalizedAttemptOutcome {
  const replicate_id = manifestAttempt?.replicate_id ?? cell.replicate_id ?? 0;
  const pair_id = manifestAttempt?.pair_id ?? `${cell.instance_id}:r${replicate_id}`;
  const task_id = manifestAttempt?.task_id ?? cell.instance_id;
  const arm = manifestAttempt?.arm ?? cell.arm ?? 'babel_enforce';
  const attempt_id = manifestAttempt?.attempt_id ?? null;

  let success: boolean | null = null;
  if (cell.status === 'pass') {
    success = true;
  } else if (cell.status === 'fail') {
    if (
      cell.signature?.startsWith('infra:missing_api_key') ||
      cell.signature?.startsWith('infra:executor_not_ready')
    ) {
      success = null;
    } else {
      success = false;
    }
  } else if (cell.status === 'skipped') {
    success = null;
  }

  let verifier_result: 'pass' | 'fail' | 'skipped' | 'unavailable' | null = null;
  if (cell.scoreboard?.host_fail_to_pass === true || cell.fail_to_pass_ok === true) {
    verifier_result = 'pass';
  } else if (cell.scoreboard?.host_fail_to_pass === false || cell.fail_to_pass_ok === false) {
    verifier_result = 'fail';
  } else if (cell.status === 'skipped') {
    verifier_result = 'skipped';
  } else {
    verifier_result = 'unavailable';
  }

  let false_completion: boolean | null = null;
  if (success === true && cell.scoreboard?.gold_diagnostic === false) {
    false_completion = true;
  } else if (success === true && cell.scoreboard?.gold_diagnostic === true) {
    false_completion = false;
  }

  return {
    pair_id,
    task_id,
    task_class: null,
    arm,
    replicate_id,
    attempt_id,
    success,
    ...(cell.arm_harness ? { harness: cell.arm_harness } : {}),
    verifier_result,
    false_completion,
    duration_ms: typeof cell.duration_ms === 'number' ? cell.duration_ms : null,
  };
}
