/**
 * experimentIdentity.ts — orthogonal experiment dimensions for paired trials.
 *
 * Architectural rule (docs/roadmaps/OX_ALPHA_EXPERIMENTAL_PROGRAM.md): an arm
 * id is only an experiment LABEL. What actually ran is captured by structured,
 * orthogonal dimensions:
 *
 *   ExperimentCell := task_id × model_id × arm_id × replicate_id
 *   HarnessIdentity := { name, adapter_id, version }
 *   ExecutionProfile := { diagnostic, policy_mode, compaction_mode, … }
 *
 * Never encode "which harness ran" solely in the arm string; resolve arms to
 * these dimensions wherever attempts are recorded, aggregated, or audited.
 */

import { z } from 'zod';

/** Known harnesses. `reference_loop` is a minimal in-house raw denominator. */
export const HARNESS_NAMES = ['babel', 'opencode', 'reference_loop'] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export const HarnessIdentitySchema = z.object({
  name: z.enum(HARNESS_NAMES),
  /** Executor/adapter that ran the attempt (e.g. babel_cli_chat_headless). */
  adapter_id: z.string().min(1),
  /** Harness-reported version when observable; null otherwise. */
  version: z.string().nullable().default(null),
});
export type HarnessIdentity = z.infer<typeof HarnessIdentitySchema>;

export const POLICY_MODES = ['full', 'shadow', 'off', 'external'] as const;

/**
 * ExecutionProfile — which Babel mechanisms were active for an attempt.
 * All mechanism fields are optional so raw/reference profiles stay honest:
 * absent means "not applicable to this harness", never "disabled and hidden".
 * `diagnostic` runs MUST be observationally inert (never change outcomes).
 */
export const ExecutionProfileSchema = z.object({
  diagnostic: z.boolean().default(false),
  policy_mode: z.enum(POLICY_MODES).optional(),
  compaction_mode: z.enum(['on', 'off']).optional(),
  plan_gate: z.enum(['on', 'off']).optional(),
  observation_mode: z.enum(['compiled', 'raw']).optional(),
  /** Additional mechanism switches, validated against ablation profiles later. */
  extra_switches: z.record(z.string(), z.string()).default({}),
});
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

import type { CausalStage1Arm } from './causalCampaignContract.js';

/**
 * Bridge legacy/current Stage-1 arm labels to structured dimensions.
 * Arms remain manifest labels for pairing identity; these functions are the
 * ONLY place allowed to interpret what an arm means.
 */
export function harnessIdentityForArm(arm: CausalStage1Arm): HarnessIdentity {
  switch (arm) {
    case 'babel_enforce':
    case 'babel_shadow':
    case 'babel_prompt_control':
      return { name: 'babel', adapter_id: 'babel_cli_chat_headless', version: null };
    case 'raw_opencode':
      return { name: 'opencode', adapter_id: 'opencode_cli_raw', version: null };
    default: {
      const _exhaustive: never = arm;
      return _exhaustive;
    }
  }
}

export function executionProfileForArm(arm: CausalStage1Arm): ExecutionProfile {
  switch (arm) {
    case 'babel_enforce':
      return {
        diagnostic: false,
        policy_mode: 'full',
        extra_switches: {},
      };
    case 'babel_shadow':
      return {
        diagnostic: true,
        policy_mode: 'shadow',
        extra_switches: {},
      };
    case 'babel_prompt_control':
      return {
        diagnostic: true,
        policy_mode: 'shadow',
        extra_switches: { prompt_delta: 'product_minus_suppressive_v1' },
      };
    case 'raw_opencode':
      // External baseline: Babel policy surface does not apply.
      return {
        diagnostic: false,
        policy_mode: 'external',
        extra_switches: {},
      };
    default: {
      const _exhaustive: never = arm;
      return _exhaustive;
    }
  }
}
