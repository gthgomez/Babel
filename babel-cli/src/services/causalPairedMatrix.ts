/**
 * Slice 6 — Provider-free paired Stage 1 arm matrix.
 *
 * Runs Stage 1 arms `{babel_prompt_control, babel_shadow, babel_enforce}` on
 * identical fixture tasks with pair_id / replicate_id / arm_order, resource
 * parity accounting, and observed-model parity gating for the paired causal
 * estimate.
 *
 * Substrate only: proves measurement wiring (oracle + detectors + parity), not
 * live causal claims about production harness behavior.
 */

import { join } from 'node:path';

import {
  CAUSAL_SCORER_VERSION,
  CAUSAL_STAGE1_ARMS,
  makePairId,
  writeJsonAtomic,
  type CausalStage1Arm,
} from './causalCampaignContract.js';
import {
  detectHarnessSuppressed,
  detectHonestyCatch,
  FALSE_COMPLETE_TRANSCRIPT,
  INJECTED_BOUNDARY_TRANSCRIPT,
  KNOWN_GOOD_TRANSCRIPT,
  runTrustedFixtureVerifier,
  type FixtureOracleResult,
  type ScriptedTranscript,
} from './causalMeasurementFixtures.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const PAIRED_MATRIX_KIND = 'babel_causal_paired_matrix' as const;

/** Fixed Stage 1 arm order for paired matrix (control → shadow → enforce). */
export const PAIRED_MATRIX_FIXED_ARM_ORDER: readonly CausalStage1Arm[] = [
  'babel_prompt_control',
  'babel_shadow',
  'babel_enforce',
] as const;

/** Default fixture task used when options.taskIds is omitted. */
export const DEFAULT_PAIRED_TASK_IDS = ['fixture_paired_task_0'] as const;

/** Simulated baseline model for provider-free parity (all arms share unless overridden). */
export const DEFAULT_OBSERVED_MODEL_ID = 'fixture-model-baseline' as const;

/** Simulated per-arm spend budget (USD) for resource-parity accounting. */
export const DEFAULT_SIMULATED_COST_USD = 0.012 as const;

/** Epsilon for spend parity across arms (USD). */
export const SPEND_PARITY_EPSILON_USD = 1e-9 as const;

/** Default shared response/turn allowance for resource parity. */
export const DEFAULT_MAX_TURNS = 32 as const;
export const DEFAULT_MAX_RESPONSES = 32 as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export type ResourceParityView = {
  /** Simulated cost estimate sum per arm (fixture token/cost budgets). */
  equal_total_spend_usd: Record<string, number>;
  equal_model_response_allowance: { max_turns: number; max_responses: number };
  /** True when simulated costs across arms agree within SPEND_PARITY_EPSILON_USD. */
  spend_parity_ok: boolean;
  /** True when max_turns / max_responses budgets are identical for all arms. */
  response_allowance_identical: boolean;
};

export type PairedArmResult = {
  oracle_pass: boolean;
  non_pass: boolean;
  signature?: string;
  simulated_cost_usd: number;
  observed_model_id: string | null;
  effort_summary?: unknown;
};

export type PairedBlockResult = {
  pair_id: string;
  task_id: string;
  replicate_id: number;
  arm_order: string[];
  arms: Record<string, PairedArmResult>;
  /** control pass && enforce non-pass (detector wiring). */
  harness_suppressed: boolean;
  honesty_catch: boolean;
  /** False if any arm differs from block baseline observed_model_id / effort. */
  model_parity_ok: boolean;
  resource_parity: ResourceParityView;
  /** model_parity_ok && all Stage 1 arms present and scored. */
  included_in_paired_causal_estimate: boolean;
};

export type PairedMatrixReport = {
  schema_version: 1;
  kind: typeof PAIRED_MATRIX_KIND;
  scorer_version: string;
  mode: 'chat-headless';
  substrate: 'provider_free_fixtures';
  blocks: PairedBlockResult[];
  /**
   * Integer event counts only — no generalized suppression rate float claim
   * without an explicit numerator/denominator structure.
   */
  paired_counts: {
    total_blocks: number;
    harness_suppressed: number;
    honesty_catch: number;
    model_mismatch: number;
    included_in_estimate: number;
  };
  notes: string[];
};

export type ArmModelOverride = {
  observed_model_id?: string | null;
  effort_summary?: unknown;
  /** Override simulated cost for spend-parity exercises (default: shared budget). */
  simulated_cost_usd?: number;
};

export type RunProviderFreePairedMatrixOptions = {
  taskIds?: string[];
  replicates?: number;
  /** When true, permute arm_order with a seeded PRNG per block. */
  shuffleArmOrder?: boolean;
  /** PRNG seed for shuffle (default 1). Ignored when shuffleArmOrder is false. */
  seed?: number;
  maxTurns?: number;
  maxResponses?: number;
  /**
   * When true (default), inject INJECTED_BOUNDARY on enforce for the first
   * non-honesty block so harness_suppressed wires true once.
   */
  injectSuppressionOnEnforce?: boolean;
  /**
   * When true, append a separate honesty-catch block (FALSE_COMPLETE control
   * + babel reject). Default false.
   */
  injectHonestyCatch?: boolean;
  /**
   * When true, first block's enforce arm gets a mismatched observed_model_id
   * so model_parity_ok=false and the block is excluded from the estimate.
   */
  injectModelMismatch?: boolean;
  /** Baseline observed model for the block (all arms unless overridden). */
  observedModelBaseline?: string | null;
  /** Per-arm overrides (model / effort / simulated cost). */
  armModelOverrides?: Partial<Record<CausalStage1Arm, ArmModelOverride>>;
  /** When set, write `paired-matrix-report.json` under this evidence dir. */
  evidenceDir?: string;
  /** Simulated equal cost per arm when not overridden (USD). */
  simulatedCostUsd?: number;
};

// ─── PRNG / shuffle ──────────────────────────────────────────────────────────

/** Mulberry32 — small deterministic PRNG for arm_order shuffle. */
export function createSeededRng(seed: number): () => number {
  let t = seed >>> 0;
  return (): number => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}

function resolveArmOrder(
  shuffle: boolean,
  rng: () => number,
): CausalStage1Arm[] {
  const order = [...PAIRED_MATRIX_FIXED_ARM_ORDER];
  if (shuffle) shuffleInPlace(order, rng);
  return order;
}

// ─── Transcript selection per arm ────────────────────────────────────────────

type BlockTranscriptPlan = {
  /** When true, control uses FALSE_COMPLETE and honesty detector is applied. */
  honesty: boolean;
  /** When true, enforce uses INJECTED_BOUNDARY (suppression shape). */
  suppressEnforce: boolean;
};

function transcriptForArm(
  arm: CausalStage1Arm,
  plan: BlockTranscriptPlan,
): ScriptedTranscript {
  if (plan.honesty && arm === 'babel_prompt_control') {
    return { ...FALSE_COMPLETE_TRANSCRIPT, arm: 'babel_prompt_control' };
  }
  if (plan.suppressEnforce && arm === 'babel_enforce') {
    return { ...INJECTED_BOUNDARY_TRANSCRIPT, arm: 'babel_enforce' };
  }
  // control / shadow known-good; enforce known-good when not suppressed
  if (arm === 'babel_shadow') {
    return { ...KNOWN_GOOD_TRANSCRIPT, arm: 'babel_shadow', id: 'fixture_known_good_shadow' };
  }
  if (arm === 'babel_enforce') {
    return { ...KNOWN_GOOD_TRANSCRIPT, arm: 'babel_enforce', id: 'fixture_known_good_enforce' };
  }
  return { ...KNOWN_GOOD_TRANSCRIPT, arm: 'babel_prompt_control' };
}

function signatureForOracle(oracle: FixtureOracleResult, arm: CausalStage1Arm): string {
  if (oracle.verified_pass) return `fixture:oracle_pass:${arm}`;
  return `fixture:oracle_non_pass:${arm}:${oracle.reason}`;
}

function stableEffortKey(effort: unknown): string {
  if (effort === undefined) return '__undefined__';
  try {
    return JSON.stringify(effort);
  } catch {
    return String(effort);
  }
}

// ─── Block evaluation ────────────────────────────────────────────────────────

function evaluateBlock(input: {
  taskId: string;
  replicateId: number;
  armOrder: CausalStage1Arm[];
  plan: BlockTranscriptPlan;
  maxTurns: number;
  maxResponses: number;
  observedModelBaseline: string | null;
  armModelOverrides: Partial<Record<CausalStage1Arm, ArmModelOverride>> | undefined;
  simulatedCostUsd: number;
  forceModelMismatchOnEnforce: boolean;
}): PairedBlockResult {
  const pair_id = makePairId(input.taskId, input.replicateId);
  const arms: Record<string, PairedArmResult> = {};
  const spendByArm: Record<string, number> = {};

  for (const arm of input.armOrder) {
    const transcript = transcriptForArm(arm, input.plan);
    const oracle = runTrustedFixtureVerifier(transcript);
    const override = input.armModelOverrides?.[arm];

    let observed_model_id: string | null =
      override?.observed_model_id !== undefined
        ? override.observed_model_id
        : input.observedModelBaseline;

    if (input.forceModelMismatchOnEnforce && arm === 'babel_enforce') {
      observed_model_id = 'fixture-model-MISMATCH';
    }

    const simulated_cost_usd =
      override?.simulated_cost_usd !== undefined
        ? override.simulated_cost_usd
        : input.simulatedCostUsd;

    const armResult: PairedArmResult = {
      oracle_pass: oracle.verified_pass,
      non_pass: !oracle.verified_pass,
      signature: signatureForOracle(oracle, arm),
      simulated_cost_usd,
      observed_model_id,
    };
    if (override?.effort_summary !== undefined) {
      armResult.effort_summary = override.effort_summary;
    }

    arms[arm] = armResult;
    spendByArm[arm] = simulated_cost_usd;
  }

  // Ensure all Stage 1 arms are present even if arm_order was partial (defensive)
  const completeArms = CAUSAL_STAGE1_ARMS.every((a) => arms[a] != null);

  const control = arms['babel_prompt_control'];
  const enforce = arms['babel_enforce'];

  const controlOracle: FixtureOracleResult = {
    verified_pass: control?.oracle_pass === true,
    reason: control?.signature ?? 'missing_control',
  };
  const enforceNonPassInput: { non_pass: boolean; signature?: string } = {
    non_pass: enforce?.non_pass === true,
  };
  if (enforce?.signature !== undefined) {
    enforceNonPassInput.signature = enforce.signature;
  }
  const suppressSignal = detectHarnessSuppressed(controlOracle, enforceNonPassInput);

  let honesty_catch = false;
  if (input.plan.honesty && control) {
    // Honesty path: false-complete control + babel correct reject (fixture wiring)
    const honestyOracle = runTrustedFixtureVerifier({
      ...FALSE_COMPLETE_TRANSCRIPT,
      arm: 'babel_prompt_control',
    });
    const honestySignal = detectHonestyCatch(
      FALSE_COMPLETE_TRANSCRIPT.claimed_complete === true,
      honestyOracle,
      true,
    );
    honesty_catch = honestySignal.honesty_catch;
  }

  // Model parity: all arms must match block baseline model + effort key
  const baselineModel = input.observedModelBaseline;
  const baselineEffort = stableEffortKey(
    input.armModelOverrides?.babel_prompt_control?.effort_summary,
  );
  let model_parity_ok = true;
  for (const arm of CAUSAL_STAGE1_ARMS) {
    const a = arms[arm];
    if (!a) {
      model_parity_ok = false;
      break;
    }
    if (a.observed_model_id !== baselineModel) {
      model_parity_ok = false;
      break;
    }
    const effortKey = stableEffortKey(a.effort_summary);
    // Only compare effort when any arm carried an effort_summary; otherwise all undefined match
    const anyEffort = CAUSAL_STAGE1_ARMS.some(
      (x) => arms[x]?.effort_summary !== undefined,
    );
    if (anyEffort && effortKey !== baselineEffort) {
      // If control had no effort override, baselineEffort is __undefined__;
      // mismatch when another arm set effort_summary.
      const controlEffort = stableEffortKey(arms['babel_prompt_control']?.effort_summary);
      if (effortKey !== controlEffort) {
        model_parity_ok = false;
        break;
      }
    }
  }

  // Resource parity: equal simulated spend (within epsilon) + identical response allowance
  const spendValues = Object.values(spendByArm);
  const minSpend = spendValues.length ? Math.min(...spendValues) : 0;
  const maxSpend = spendValues.length ? Math.max(...spendValues) : 0;
  const spend_parity_ok = maxSpend - minSpend <= SPEND_PARITY_EPSILON_USD;
  const response_allowance_identical = true; // matrix applies one budget to all arms

  const resource_parity: ResourceParityView = {
    equal_total_spend_usd: spendByArm,
    equal_model_response_allowance: {
      max_turns: input.maxTurns,
      max_responses: input.maxResponses,
    },
    spend_parity_ok,
    response_allowance_identical,
  };

  const included_in_paired_causal_estimate = model_parity_ok && completeArms;

  return {
    pair_id,
    task_id: input.taskId,
    replicate_id: input.replicateId,
    arm_order: input.armOrder.map(String),
    arms,
    harness_suppressed: suppressSignal.harness_suppressed,
    honesty_catch,
    model_parity_ok,
    resource_parity,
    included_in_paired_causal_estimate,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the provider-free paired Stage 1 arm matrix over fixture transcripts.
 *
 * @param options - Task set, replicates, arm order, injection knobs, optional evidence write.
 * @returns Paired matrix report with integer paired_counts (no lone rate claim).
 */
export function runProviderFreePairedMatrix(
  options?: RunProviderFreePairedMatrixOptions,
): PairedMatrixReport {
  const taskIds = options?.taskIds?.length
    ? [...options.taskIds]
    : [...DEFAULT_PAIRED_TASK_IDS];
  const replicates = options?.replicates ?? 1;
  if (replicates < 1) throw new Error('replicates must be >= 1');

  const shuffleArmOrder = options?.shuffleArmOrder === true;
  const seed = options?.seed ?? 1;
  const rng = createSeededRng(seed);

  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxResponses = options?.maxResponses ?? DEFAULT_MAX_RESPONSES;
  const injectSuppressionOnEnforce = options?.injectSuppressionOnEnforce !== false;
  const injectHonestyCatch = options?.injectHonestyCatch === true;
  const injectModelMismatch = options?.injectModelMismatch === true;
  const observedModelBaseline =
    options?.observedModelBaseline !== undefined
      ? options.observedModelBaseline
      : DEFAULT_OBSERVED_MODEL_ID;
  const simulatedCostUsd = options?.simulatedCostUsd ?? DEFAULT_SIMULATED_COST_USD;

  const blocks: PairedBlockResult[] = [];
  const notes: string[] = [
    'provider_free_fixtures: measurement substrate only; not live causal claims',
    `scorer_version=${CAUSAL_SCORER_VERSION}`,
    `arm_order_mode=${shuffleArmOrder ? `shuffled_seed_${seed}` : 'fixed'}`,
  ];

  let suppressionInjected = false;
  let mismatchInjected = false;

  for (let r = 0; r < replicates; r += 1) {
    for (const taskId of taskIds) {
      const suppressThis =
        injectSuppressionOnEnforce && !suppressionInjected;
      if (suppressThis) suppressionInjected = true;

      const mismatchThis = injectModelMismatch && !mismatchInjected;
      if (mismatchThis) mismatchInjected = true;

      const armOrder = resolveArmOrder(shuffleArmOrder, rng);
      const block = evaluateBlock({
        taskId,
        replicateId: r,
        armOrder,
        plan: {
          honesty: false,
          suppressEnforce: suppressThis,
        },
        maxTurns,
        maxResponses,
        observedModelBaseline,
        armModelOverrides: options?.armModelOverrides,
        simulatedCostUsd,
        forceModelMismatchOnEnforce: mismatchThis,
      });
      blocks.push(block);
    }
  }

  if (injectHonestyCatch) {
    const honestyTaskId = 'fixture_paired_honesty';
    const honestyReplicate = 0;
    const armOrder = resolveArmOrder(shuffleArmOrder, rng);
    const honestyBlock = evaluateBlock({
      taskId: honestyTaskId,
      replicateId: honestyReplicate,
      armOrder,
      plan: {
        honesty: true,
        // Honesty block: control false-complete; enforce can stay known-good
        // so harness_suppressed is false and honesty_catch is the focal signal.
        suppressEnforce: false,
      },
      maxTurns,
      maxResponses,
      observedModelBaseline,
      armModelOverrides: options?.armModelOverrides,
      simulatedCostUsd,
      forceModelMismatchOnEnforce: false,
    });
    blocks.push(honestyBlock);
    notes.push('honesty_catch block appended (FALSE_COMPLETE control + babel reject)');
  }

  if (injectSuppressionOnEnforce) {
    notes.push(
      suppressionInjected
        ? 'injectSuppressionOnEnforce: first non-honesty block enforce=INJECTED_BOUNDARY'
        : 'injectSuppressionOnEnforce requested but no primary block available',
    );
  }
  if (injectModelMismatch) {
    notes.push(
      mismatchInjected
        ? 'injectModelMismatch: first block enforce observed_model_id mismatched'
        : 'injectModelMismatch requested but no primary block available',
    );
  }

  const paired_counts = {
    total_blocks: blocks.length,
    harness_suppressed: blocks.filter((b) => b.harness_suppressed).length,
    honesty_catch: blocks.filter((b) => b.honesty_catch).length,
    model_mismatch: blocks.filter((b) => !b.model_parity_ok).length,
    included_in_estimate: blocks.filter((b) => b.included_in_paired_causal_estimate).length,
  };

  // Invariant: counts are integers (no lone rate field on this report)
  for (const [k, v] of Object.entries(paired_counts)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`paired_counts.${k} must be a non-negative integer, got ${v}`);
    }
  }

  const report: PairedMatrixReport = {
    schema_version: 1,
    kind: PAIRED_MATRIX_KIND,
    scorer_version: CAUSAL_SCORER_VERSION,
    mode: 'chat-headless',
    substrate: 'provider_free_fixtures',
    blocks,
    paired_counts,
    notes,
  };

  if (options?.evidenceDir) {
    const path = join(options.evidenceDir, 'paired-matrix-report.json');
    notes.push(`wrote ${path}`);
    writeJsonAtomic(path, report);
  }

  return report;
}

/**
 * Convenience: recompute resource-parity view from a finished block's arms.
 * Useful for tests asserting spend / allowance fields without re-running matrix.
 */
export function computeResourceParityView(
  arms: Record<string, Pick<PairedArmResult, 'simulated_cost_usd'>>,
  allowance: { max_turns: number; max_responses: number },
): ResourceParityView {
  const equal_total_spend_usd: Record<string, number> = {};
  for (const [arm, v] of Object.entries(arms)) {
    equal_total_spend_usd[arm] = v.simulated_cost_usd;
  }
  const values = Object.values(equal_total_spend_usd);
  const minSpend = values.length ? Math.min(...values) : 0;
  const maxSpend = values.length ? Math.max(...values) : 0;
  return {
    equal_total_spend_usd,
    equal_model_response_allowance: {
      max_turns: allowance.max_turns,
      max_responses: allowance.max_responses,
    },
    spend_parity_ok: maxSpend - minSpend <= SPEND_PARITY_EPSILON_USD,
    response_allowance_identical: true,
  };
}
