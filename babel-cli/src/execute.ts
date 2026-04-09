/**
 * execute.ts — Per-Stage LLM Waterfall Executor
 *
 * Implements four dedicated waterfalls, one per pipeline stage.
 * All tiers are DeepInfra API runners (≤$2.50/M tokens). No CLI runners.
 *
 * Model selection is evidence-based (benchmarks, July 2026):
 *
 *   orchestrator  (Stage 1 — manifest generation, domain/model routing)
 *     Goal: reliable structured JSON output, fast, cheap.
 *     1. Llama-4-Scout       $0.08/$0.30 — confirmed JSON mode, lowest TTFT (0.48s), 328K ctx
 *     2. Qwen3-235B-Instruct $0.07/$0.10 — IFEval 88.7, cheapest output, 262K ctx, no thinking overhead
 *     3. Step-3.5-Flash      $0.10/$0.30 — Intelligence Index #13/67, 256K ctx, reliable instruction following
 *     4. Qwen3-32B           $0.08/$0.28 — function calling, budget rescue
 *
 *   planning      (Stage 2 — SWE Agent minimal-action-set plan)
 *     Goal: deepest SE reasoning. SWE-bench is the key metric.
 *     1. Step-3.5-Flash      $0.10/$0.30 — SWE-bench 74.4 (best in class at this price), AIME 97.3
 *     2. Nemotron 3 Super    $0.10/$0.50 — Intelligence Index #2/58, agentic TauBench 61.1, 262K ctx
 *     3. DeepSeek-V3-0324    $0.20/$0.77 — top practitioner SE model, HumanEval 82.6, MATH-500 90.2
 *     4. Qwen3-235B-Instruct $0.07/$0.10 — MMLU-Redux 93.1, MultiPL-E 87.9, cheap deep rescue
 *     5. Qwen3-32B           $0.08/$0.28 — last-resort budget fallback
 *
 *   qa            (Stage 3 — QA Reviewer adversarial verdict)
 *     Goal: adversarial critique, catch plan flaws. Instruction following + reasoning depth.
 *     1. Nemotron 3 Super    $0.10/$0.50 — GPQA Diamond 79.4, IFBench 72.3, Arena-Hard 76.1, 262K ctx
 *     2. DeepSeek-V3-0324    $0.20/$0.77 — broad pretraining (14.8T tokens), IFEval 86.1, strong critic
 *     3. Step-3.5-Flash      $0.10/$0.30 — BBH 88.2, sharp reasoning fallback
 *     4. Qwen3-32B           $0.08/$0.28 — budget rescue
 *
 *   executor      (Stage 4 — multi-turn tool call loop)
 *     Goal: cheapest reliable JSON per tool-call turn, lowest latency.
 *     1. Llama-4-Scout       $0.08/$0.30 — JSON mode confirmed, TTFT 0.48s, 144.8 tok/s, 328K ctx
 *     2. Qwen3-235B-Instruct $0.07/$0.10 — cheapest output ($0.10/M), no thinking tokens, 262K ctx
 *     3. Qwen3-32B           $0.08/$0.28 — function calling, compact output, budget rescue
 *     4. Nemotron 3 Super    $0.10/$0.50 — complex history reasoning fallback, 262K ctx
 *
 * Cascade rules:
 *   1. Rate-limit / quota signal         → cascade immediately (no retry).
 *   2. JSON / Zod failure                → retry up to `maxAttempts`, then cascade.
 *   3. Runner construction error         → cascade immediately (e.g. missing API key).
 *
 * Backward compatibility:
 *   `mode: 'structural'` maps to the `orchestrator` waterfall.
 *   `mode: 'reasoning'`  maps to the `planning` waterfall.
 *   `stage` takes priority over `mode` when both are provided.
 *
 * Environment variables:
 *   DEEPINFRA_API_KEY          — Required for all tiers.
 *   BABEL_DEEPINFRA_TOKENS     — max_tokens for DeepInfra responses. Default: 8096
 *   BABEL_DISABLE_API_FALLBACK — Set to "true" to halt after first tier failure.
 */

import type { ZodType, ZodTypeDef } from 'zod';
import { DeepInfraApiRunner }    from './runners/deepInfraApi.js';
import type { LlmRunner }        from './runners/base.js';
import type { EvidenceBundle }   from './evidence.js';
import type { TargetModel }      from './schemas/agentContracts.js';
import {
  selectBestTierForStage,
  reorderWaterfallByStartIndex,
  type RoutingStage,
}                                from './routingEngine.js';
import {
  resolveStagePolicyRoutes,
  type ResolvedModelPolicyEntry,
}                                from './modelPolicy.js';

export type { TargetModel };

// ─── Waterfall telemetry ──────────────────────────────────────────────────────

/**
 * One record per `runWithFallback` call. Written to `05_waterfall_telemetry.json`
 * via `EvidenceBundle.appendWaterfallLog()` so the full fallback history of a
 * run is visible in a single file.
 */
export interface WaterfallOutcome {
  /** Which pipeline stage produced this call. */
  stage:          string;
  /** Human-readable name of the tier that ultimately succeeded. */
  tier_succeeded: string;
  /** 0-based index of the winning tier (0 = first try, >0 = fallback). */
  tier_index:     number;
  /** Attempt count within the winning tier (>1 = retry inside that tier). */
  attempts:       number;
  /** Names of tiers that were tried and failed before the winner. */
  tiers_skipped:  string[];
  /** Brief reason for the last cascade (or "none" if first try succeeded). */
  cascade_reason: string;
  /** ISO 8601 timestamp of when this call completed. */
  ts:             string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const DISABLE_API_FALLBACK =
  process.env['BABEL_DISABLE_API_FALLBACK'] === 'true';

// DeepInfra model IDs (all ≤$2.50/M tokens — pricing verified July 2026)
//
// Strengths summary:
//   LLAMA4_SCOUT:   JSON mode confirmed, TTFT 0.48s, 328K ctx, 144.8 tok/s — best Stage 1/4 lead
//   QWEN3_235B:     IFEval 88.7, MMLU-Redux 93.1, $0.07/$0.10 — cheapest capable output on platform
//   STEP_FLASH:     SWE-bench 74.4, AIME 97.3, Intelligence Index #13/67 — best SE reasoning per dollar
//   NEMOTRON:       GPQA 79.4, IFBench 72.3, Arena-Hard 76.1, agentic TauBench 61.1 — best critic
//   DEEPSEEK_V3:    HumanEval 82.6, MATH-500 90.2, IFEval 86.1 — top practitioner SE, 14.8T pretrain
//   QWEN3_32B:      function calling, 41K ctx, budget-tier rescue across all stages
const LLAMA4_SCOUT  = 'meta-llama/Llama-4-Scout-17B-16E-Instruct';   // $0.08/$0.30 — JSON mode, 328K ctx
const QWEN3_235B    = 'Qwen/Qwen3-235B-A22B-Instruct-2507';          // $0.07/$0.10 — cheapest output
const STEP_FLASH    = 'stepfun-ai/Step-3.5-Flash';                   // $0.10/$0.30 — SWE-bench 74.4
const NEMOTRON      = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';    // $0.10/$0.50 — adversarial critic
const DEEPSEEK_V3   = 'deepseek-ai/DeepSeek-V3-0324';               // $0.20/$0.77 — SE coding depth
const QWEN3_32B     = 'Qwen/Qwen3-32B';                              // $0.08/$0.28 — budget rescue

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Which pipeline stage is running. Selects the appropriate waterfall.
 *
 *   'orchestrator' — Stage 1: manifest generation and routing
 *   'planning'     — Stage 2: SWE Agent plan generation
 *   'qa'           — Stage 3: QA Reviewer adversarial verdict
 *   'executor'     — Stage 4: multi-turn tool call execution
 */
export type PipelineStage = 'orchestrator' | 'planning' | 'qa' | 'executor';

/**
 * Legacy two-mode selector kept for backward compatibility.
 * Prefer `stage` in new call sites.
 *   'structural' → equivalent to stage 'orchestrator'
 *   'reasoning'  → equivalent to stage 'planning'
 */
export type RunMode = 'structural' | 'reasoning';

export interface RunOptions {
  /**
   * Which pipeline stage is running. Takes priority over `mode` when set.
   * Selects the dedicated per-stage waterfall.
   */
  stage?: PipelineStage;

  /**
   * Legacy waterfall selector. Ignored when `stage` is set.
   * 'structural' → orchestrator waterfall.
   * 'reasoning'  → planning waterfall.
   * @deprecated Use `stage` instead.
   */
  mode?: RunMode;

  /**
   * Maximum number of attempts per tier before cascading to the next tier.
   * Rate-limit or spawn errors bypass this count and cascade immediately.
   * @default 2
   */
  maxCliAttempts?: number;

  /**
   * Kept for type compatibility with older call sites. Not used for routing.
   * @deprecated No-op — waterfall tiers are resolved by `stage`.
   */
  targetModel?: TargetModel;

  /**
   * Explicit starting tier override (0-based index into the stage's waterfall).
   * When set, skips dynamic routing and starts the waterfall at this position.
   * Tiers before the selected index are NOT tried (the cascade continues
   * forward from the chosen tier if it fails).
   */
  startTierIndex?: number;

  /**
   * Enables Dynamic Routing v1 for this call.
   * Overrides the `BABEL_DYNAMIC_ROUTING` environment variable for this
   * specific call — useful for A/B testing or per-pipeline opt-in.
   * When omitted, falls back to the env-var setting.
   */
  dynamicRouting?: boolean;

  /**
   * Evidence bundle for the current run. Raw stdout/stderr and Zod errors are
   * written to debug files on parse/validation failure when provided.
   */
  evidence?: EvidenceBundle;
}

// ─── Waterfall definitions ────────────────────────────────────────────────────

type TierKind = 'cli' | 'api';

interface TierSpec {
  kind:    TierKind;
  name:    string;
  factory: () => LlmRunner;
  /**
   * Canonical 0-based position in the stage's fixed waterfall definition.
   * Stamped by `runWithFallback` before reordering so `runWaterfall` can
   * always report the original tier slot even when the runtime execution
   * order has been changed by dynamic routing. Absent on static waterfalls
   * (no reorder); `runWaterfall` falls back to the loop counter in that case.
   */
  originalIndex?: number;
}

/**
 * Stage 1 — Orchestrator
 * Goal: reliable structured JSON output, fast and cheap.
 * Llama-4-Scout leads: only model with confirmed JSON mode on DeepInfra,
 * lowest TTFT (0.48s), 328K context. Qwen3-235B-Instruct backs up with the
 * cheapest output price on the platform ($0.10/M) and IFEval 88.7.
 */
const ORCHESTRATOR_WATERFALL: TierSpec[] = [
  {
    kind: 'api', name: 'Llama-4-Scout',
    factory: () => new DeepInfraApiRunner(LLAMA4_SCOUT),
  },
  {
    kind: 'api', name: 'Qwen3-235B-Instruct-2507',
    factory: () => new DeepInfraApiRunner(QWEN3_235B),
  },
  {
    kind: 'api', name: 'Step-3.5-Flash',
    factory: () => new DeepInfraApiRunner(STEP_FLASH),
  },
  {
    kind: 'api', name: 'Qwen3-32B',
    factory: () => new DeepInfraApiRunner(QWEN3_32B),
  },
];

/**
 * Stage 2 — Planning (SWE Agent)
 * Goal: deepest SE reasoning for action-set generation.
 * Step-3.5-Flash leads: SWE-bench 74.4 is the highest score at this price
 * bracket — no other sub-$0.50/M model comes close on software engineering.
 * Nemotron backs up with the best long-context agentic scores (TauBench 61.1).
 * DeepSeek-V3-0324 is the top practitioner model for SE at $0.77/M output.
 */
const PLANNING_WATERFALL: TierSpec[] = [
  {
    kind: 'api', name: 'Step-3.5-Flash',
    factory: () => new DeepInfraApiRunner(STEP_FLASH),
  },
  {
    kind: 'api', name: 'Nemotron 3 Super',
    factory: () => new DeepInfraApiRunner(NEMOTRON),
  },
  {
    kind: 'api', name: 'DeepSeek-V3-0324',
    factory: () => new DeepInfraApiRunner(DEEPSEEK_V3),
  },
  {
    kind: 'api', name: 'Qwen3-235B-Instruct-2507',
    factory: () => new DeepInfraApiRunner(QWEN3_235B),
  },
  {
    kind: 'api', name: 'Qwen3-32B',
    factory: () => new DeepInfraApiRunner(QWEN3_32B),
  },
];

/**
 * Stage 3 — QA Reviewer
 * Goal: adversarial critique and plan verification.
 * Nemotron leads: GPQA Diamond 79.4, IFBench 72.3, Arena-Hard 76.1 — the
 * strongest critical reasoning scores and explicitly adversarial post-training.
 * DeepSeek-V3-0324 backs up with broad pretraining (14.8T tokens) for factual
 * grounding and IFEval 86.1 for following structured critique schemas.
 */
const QA_WATERFALL: TierSpec[] = [
  {
    kind: 'api', name: 'Nemotron 3 Super',
    factory: () => new DeepInfraApiRunner(NEMOTRON),
  },
  {
    kind: 'api', name: 'DeepSeek-V3-0324',
    factory: () => new DeepInfraApiRunner(DEEPSEEK_V3),
  },
  {
    kind: 'api', name: 'Step-3.5-Flash',
    factory: () => new DeepInfraApiRunner(STEP_FLASH),
  },
  {
    kind: 'api', name: 'Qwen3-32B',
    factory: () => new DeepInfraApiRunner(QWEN3_32B),
  },
];

/**
 * Stage 4 — Executor
 * Goal: cheapest reliable JSON per tool-call turn, lowest latency.
 * Llama-4-Scout leads: confirmed JSON mode, TTFT 0.48s, 144.8 tok/s throughput,
 * 328K context to hold full task history. Qwen3-235B-Instruct backs up at
 * $0.10/M output — cheapest on the platform with no thinking token overhead.
 */
const EXECUTOR_WATERFALL: TierSpec[] = [
  {
    kind: 'api', name: 'Llama-4-Scout',
    factory: () => new DeepInfraApiRunner(LLAMA4_SCOUT),
  },
  {
    kind: 'api', name: 'Qwen3-235B-Instruct-2507',
    factory: () => new DeepInfraApiRunner(QWEN3_235B),
  },
  {
    kind: 'api', name: 'Qwen3-32B',
    factory: () => new DeepInfraApiRunner(QWEN3_32B),
  },
  {
    kind: 'api', name: 'Nemotron 3 Super',
    factory: () => new DeepInfraApiRunner(NEMOTRON),
  },
];

/**
 * Converts a `PipelineStage` or legacy `RunMode` to the `RoutingStage` union
 * used by `routingEngine.ts`. `PipelineStage` is a structural subset of
 * `RoutingStage` so the cast is safe.
 */
function resolveEffectiveStage(
  stage: PipelineStage | undefined,
  mode:  RunMode | undefined,
): RoutingStage {
  if (stage !== undefined) return stage;        // PipelineStage ⊂ RoutingStage
  if (mode === 'reasoning') return 'planning';
  return 'orchestrator';
}

function getPolicyDisplayName(entry: ResolvedModelPolicyEntry): string {
  switch (entry.backendKey) {
    case 'deepinfra:llama-4-scout':
      return 'Llama-4-Scout';
    case 'deepinfra:qwen3-235b-instruct-2507':
      return 'Qwen3-235B-Instruct-2507';
    case 'deepinfra:step-3.5-flash':
      return 'Step-3.5-Flash';
    case 'deepinfra:nemotron-3-super-120b-a12b':
      return 'Nemotron 3 Super';
    case 'deepinfra:deepseek-v3-0324':
      return 'DeepSeek-V3-0324';
    case 'deepinfra:qwen3-32b':
      return 'Qwen3-32B';
    default:
      return entry.providerModelId;
  }
}

function tierSpecFromPolicyEntry(entry: ResolvedModelPolicyEntry): TierSpec {
  if (entry.provider !== 'deepinfra') {
    throw new Error(
      `Unsupported stage policy provider "${entry.provider}" for backend "${entry.backendKey}".`,
    );
  }

  return {
    kind: 'api',
    name: getPolicyDisplayName(entry),
    factory: () => new DeepInfraApiRunner(entry.providerModelId),
  };
}

function resolvePolicyWaterfall(stage: PipelineStage): TierSpec[] | null {
  const routes = resolveStagePolicyRoutes();
  const route = routes.find((candidate) => candidate.stage === stage);
  if (!route) return null;
  return route.orderedBackends.map(tierSpecFromPolicyEntry);
}

/** Resolve a stage or legacy mode to its waterfall. */
function resolveWaterfall(stage: PipelineStage | undefined, mode: RunMode | undefined): TierSpec[] {
  const effectiveStage = resolveEffectiveStage(stage, mode) as PipelineStage;
  const policyWaterfall = resolvePolicyWaterfall(effectiveStage);
  if (policyWaterfall && policyWaterfall.length > 0) {
    return policyWaterfall;
  }

  if (effectiveStage === 'planning') return PLANNING_WATERFALL;
  if (effectiveStage === 'qa')       return QA_WATERFALL;
  if (effectiveStage === 'executor') return EXECUTOR_WATERFALL;
  return ORCHESTRATOR_WATERFALL;
}

// ─── Cascade signal detection ─────────────────────────────────────────────────

const RATE_LIMIT_SIGNALS = [
  'rate limit',
  'rate_limit',
  'quota',
  '429',
  'too many requests',
] as const;

const SPAWN_ERROR_SIGNALS = [
  'not found in path',
  'is not recognized as an',
  'enoent',
] as const;

function isImmediateCascade(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    RATE_LIMIT_SIGNALS.some(s => msg.includes(s)) ||
    SPAWN_ERROR_SIGNALS.some(s => msg.includes(s))
  );
}

// ─── Internal waterfall runner ────────────────────────────────────────────────

interface WaterfallRunResult<T> {
  result:  T;
  outcome: Omit<WaterfallOutcome, 'stage' | 'ts'>;
}

async function runWaterfall<T>(
  label:       string,
  waterfall:   TierSpec[],
  prompt:      string,
  schema:      ZodType<T, ZodTypeDef, unknown>,
  maxAttempts: number,
  evidence:    EvidenceBundle | undefined,
): Promise<WaterfallRunResult<T>> {
  let lastError:   Error    | null = null;
  const tiersSkipped: string[]    = [];

  for (let tier = 0; tier < waterfall.length; tier++) {
    const spec = waterfall[tier]!;
    const next = waterfall[tier + 1];

    // ── Waterfall halt gate ────────────────────────────────────────────────
    // BABEL_DISABLE_API_FALLBACK=true halts the pipeline after the first tier
    // fails, since all tiers are now DeepInfra API runners.
    if (DISABLE_API_FALLBACK && tiersSkipped.length > 0) {
      throw new Error(
        `First tier failed and BABEL_DISABLE_API_FALLBACK=true. Halting pipeline. ` +
        `Last error: ${lastError?.message ?? 'unknown'}`,
      );
    }

    // ── Instantiate runner ─────────────────────────────────────────────────
    let runner: LlmRunner;
    try {
      runner = spec.factory();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      tiersSkipped.push(spec.name);
      if (next) {
        console.warn(
          `[babel:${label}] ${spec.name} unavailable — ${lastError.message.slice(0, 120)}`,
        );
        console.warn(`[babel:${label}] Cascading to ${next.name}...`);
      }
      continue;
    }

    // ── Attempt loop ───────────────────────────────────────────────────────
    let cascadeFromTier = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await runner.execute(prompt, schema);

        // ── Build and emit a structured success log ──────────────────────
        const fallbacks = tiersSkipped.length;
        const cascadeReason = lastError?.message.slice(0, 100) ?? 'none';

        let suffix: string;
        if (fallbacks === 0 && attempt === 1) {
          suffix = '';
        } else if (fallbacks > 0 && attempt === 1) {
          suffix =
            ` — ${fallbacks} fallback${fallbacks > 1 ? 's' : ''}` +
            ` (last: ${cascadeReason})`;
        } else if (fallbacks === 0) {
          suffix = ` (attempt ${attempt})`;
        } else {
          suffix =
            ` (attempt ${attempt}, ${fallbacks} fallback${fallbacks > 1 ? 's' : ''}` +
            ` — last: ${cascadeReason})`;
        }

        // Use the canonical slot if available — dynamic routing can change the
        // runtime loop counter but must not corrupt telemetry semantics.
        const canonicalIndex = spec.originalIndex ?? tier;
        console.log(`[babel:${label}] ✓ tier ${canonicalIndex + 1}: ${spec.name}${suffix}`);

        return {
          result,
          outcome: {
            tier_succeeded: spec.name,
            tier_index:     canonicalIndex,
            attempts:       attempt,
            tiers_skipped:  tiersSkipped,
            cascade_reason: cascadeReason,
          },
        };

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (isImmediateCascade(lastError)) {
          cascadeFromTier = true;
          break;
        }

        if (attempt < maxAttempts) {
          console.warn(
            `[babel:${label}] ${spec.name} attempt ${attempt}/${maxAttempts} failed — retrying.\n` +
            `  Reason: ${lastError.message.slice(0, 160)}`,
          );
        } else {
          cascadeFromTier = true;
        }
      }
    }

    if (cascadeFromTier) {
      tiersSkipped.push(spec.name);
      if (next) {
        console.warn(`[babel:${label}] ${spec.name} failed. Cascading to ${next.name}...`);
      }
    }
  }

  throw new Error(
    `All ${waterfall.length} runner(s) in the waterfall failed. ` +
    `Last error: ${lastError?.message ?? 'unknown'}`,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Executes a compiled Babel prompt through the appropriate per-stage waterfall,
 * returning a validated typed result from whichever tier first succeeds.
 *
 * Pass `stage: 'orchestrator'` for Stage 1 (manifest generation).
 * Pass `stage: 'planning'`     for Stage 2 (SWE Agent).
 * Pass `stage: 'qa'`           for Stage 3 (QA Reviewer).
 * Pass `stage: 'executor'`     for Stage 4 (executor turns).
 *
 * @param prompt  - Compiled context string from `compileContext()`.
 * @param schema  - Zod schema that validates and types the LLM's JSON output.
 * @param options - Routing, retry, and debug options (see `RunOptions`).
 * @returns       Validated result of type `T`.
 * @throws        If every tier in the waterfall fails, or if
 *                `BABEL_DISABLE_API_FALLBACK=true` and all CLI tiers are exhausted.
 */
export async function runWithFallback<T>(
  prompt:  string,
  schema:  ZodType<T, ZodTypeDef, unknown>,
  options: RunOptions = {},
): Promise<T> {
  const maxAttempts    = options.maxCliAttempts ?? 2;
  const evidence       = options.evidence;
  const waterfall      = resolveWaterfall(options.stage, options.mode);
  const label          = options.stage ?? options.mode ?? 'unknown';
  const effectiveStage = resolveEffectiveStage(options.stage, options.mode);

  // ── Dynamic Routing v1 ────────────────────────────────────────────────────
  // Explicit `startTierIndex` from the caller wins; otherwise consult the
  // routing engine (which returns null when disabled or data is too thin).
  let startTierIndex = options.startTierIndex;

  if (startTierIndex === undefined) {
    const routingOpts = options.dynamicRouting !== undefined
      ? { enabled: options.dynamicRouting }
      : undefined;

    const decision = selectBestTierForStage(
      effectiveStage,
      waterfall.map(spec => spec.name),
      routingOpts,
    );

    if (decision !== null) {
      startTierIndex = decision.selectedIndex;
      console.log(
        `[babel:${label}] Dynamic Routing v1 → tier ${decision.selectedIndex + 1}: ` +
        `${decision.selectedName}`,
      );
      if (evidence) {
        evidence.writeDebugFile(
          `debug_dynamic_routing_${label}.json`,
          JSON.stringify(decision, null, 2),
        );
      }
    }
  }

  // Stamp canonical indices before reordering so runWaterfall can always
  // report the original tier slot in logs and telemetry.
  const stampedWaterfall = waterfall.map((spec, i) => ({ ...spec, originalIndex: i }));
  const orderedWaterfall = reorderWaterfallByStartIndex(stampedWaterfall, startTierIndex);

  const { result, outcome } = await runWaterfall(
    label, orderedWaterfall, prompt, schema, maxAttempts, evidence,
  );

  // Record to evidence bundle for 05_waterfall_telemetry.json.
  if (evidence) {
    evidence.appendWaterfallLog({
      ...outcome,
      stage: label,
      ts:    new Date().toISOString(),
    } satisfies WaterfallOutcome);
  }

  return result;
}
