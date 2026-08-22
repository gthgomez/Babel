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
