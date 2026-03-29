/**
 * execute.ts — Per-Stage LLM Waterfall Executor
 *
 * Implements four dedicated waterfalls, one per pipeline stage:
 *
 *   orchestrator  (Stage 1 — manifest generation, domain/model routing)
 *     1. Gemini CLI (gemini-3.1-flash-lite-preview)  — fastest structured JSON
 *     2. Nemotron 3 Super (DeepInfra)                — strong schema repair, ~3–4× cheaper than Claude
 *     3. Codex CLI                                   — ChatGPT Plus rare rescue
 *
 *   planning      (Stage 2 — SWE Agent minimal-action-set plan)
 *     1. Codex CLI                                   — ChatGPT Plus, best coding/reasoning
 *     2. Nemotron 3 Super (DeepInfra)                — agentic-tuned fallback
 *     3. Gemini CLI (gemini-3-flash-preview)         — mid-tier rescue
 *     4. Gemini CLI (gemini-3.1-pro-preview)         — Pro rescue (Gemini Advanced required)
 *
 *   qa            (Stage 3 — QA Reviewer adversarial verdict)
 *     1. Nemotron 3 Super (DeepInfra)                — cost-effective adversarial critique
 *     2. Codex CLI                                   — stronger adversarial judgment (ChatGPT Plus)
 *     3. Gemini CLI (gemini-3-flash-preview)         — mid-tier rare rescue
 *
 *   executor      (Stage 4 — multi-turn tool call loop)
 *     1. Gemini CLI (gemini-3.1-flash-lite-preview)  — fast per-turn structured JSON
 *     2. Qwen3-32B (DeepInfra)                       — ultra-cheap structured reliability
 *     3. Nemotron 3 Super (DeepInfra)                — complex history reasoning fallback
 *
 * Cascade rules:
 *   1. Binary not found / not recognised → cascade immediately (no retry).
 *   2. Rate-limit / quota signal         → cascade immediately (no retry).
 *   3. JSON / Zod failure                → retry up to `maxCliAttempts`, then cascade.
 *   4. Spawn timeout / non-zero exit     → same policy as rule 3.
 *   5. Runner construction error         → cascade immediately (e.g. missing API key).
 *
 * Backward compatibility:
 *   `mode: 'structural'` maps to the `orchestrator` waterfall.
 *   `mode: 'reasoning'`  maps to the `planning` waterfall.
 *   `stage` takes priority over `mode` when both are provided.
 *
 * Environment variables:
 *   DEEPINFRA_API_KEY          — Required for Nemotron / Qwen3 tiers.
 *   BABEL_DEEPINFRA_TOKENS     — max_tokens for DeepInfra responses. Default: 8096
 *   BABEL_DISABLE_API_FALLBACK — Set to "true" to skip all API tiers.
 *   BABEL_GEMINI_MODEL_FAST    — Override fast Gemini model. Default: gemini-3.1-flash-lite-preview
 *   BABEL_GEMINI_MODEL_MID     — Override mid Gemini model.  Default: gemini-3-flash-preview
 *   BABEL_GEMINI_MODEL_PRO     — Override pro Gemini model.  Default: gemini-3.1-pro-preview
 */

import type { ZodType, ZodTypeDef } from 'zod';
import { ClaudeCliRunner }       from './runners/claudeCli.js';
import { CodexCliRunner }        from './runners/codexCli.js';
import { GeminiCliRunner }       from './runners/geminiCli.js';
import { DeepInfraApiRunner }    from './runners/deepInfraApi.js';
import { CliParseError }         from './runners/cliBase.js';
import { StructuredRunner }      from './runners/structuredRunner.js';
import type { LlmRunner }        from './runners/base.js';
import type { EvidenceBundle }   from './evidence.js';
import type { TargetModel }      from './schemas/agentContracts.js';
import {
  selectBestTierForStage,
  reorderWaterfallByStartIndex,
  type RoutingStage,
}                                from './routingEngine.js';

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

// DeepInfra model IDs
const NEMOTRON_MODEL = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
const QWEN3_MODEL    = 'Qwen/Qwen3-32B';

// Gemini CLI model IDs (env overrides for forward compatibility)
// FAST  — primary tier in Stage 1/4 (lowest latency, free/sub-included)
// MID   — fallback tier in Stage 3; rescue in Stage 2
// PRO   — rare rescue in Stage 2 (highest quality, Gemini Advanced required)
const GEMINI_MODEL_FAST = process.env['BABEL_GEMINI_MODEL_FAST'] ?? 'gemini-3.1-flash-lite-preview';
const GEMINI_MODEL_MID  = process.env['BABEL_GEMINI_MODEL_MID']  ?? 'gemini-3-flash-preview';
const GEMINI_MODEL_PRO  = process.env['BABEL_GEMINI_MODEL_PRO']  ?? 'gemini-3.1-pro-preview';

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
 * Goal: high first-try structured JSON reliability + low latency.
 */
const ORCHESTRATOR_WATERFALL: TierSpec[] = [
  {
    kind: 'cli', name: `Gemini CLI (${GEMINI_MODEL_FAST})`,
    factory: () => new StructuredRunner(new GeminiCliRunner(GEMINI_MODEL_FAST), `Gemini CLI (${GEMINI_MODEL_FAST})`),
  },
  {
    kind: 'api', name: 'Nemotron 3 Super',
    factory: () => new DeepInfraApiRunner(NEMOTRON_MODEL),
  },
  {
    kind: 'cli', name: 'Codex CLI',
    factory: () => new StructuredRunner(new CodexCliRunner(), 'Codex CLI'),
  },
];

/**
 * Stage 2 — Planning (SWE Agent)
 * Goal: deepest reasoning + accurate action-set generation.
 */
const PLANNING_WATERFALL: TierSpec[] = [
  {
    kind: 'cli', name: 'Codex CLI',
    factory: () => new StructuredRunner(new CodexCliRunner(), 'Codex CLI'),
  },
  {
    kind: 'api', name: 'Nemotron 3 Super',
    factory: () => new DeepInfraApiRunner(NEMOTRON_MODEL),
  },
  {
    // Mid-tier rescue — better quality than Flash-Lite for complex plans.
    kind: 'cli', name: `Gemini CLI (${GEMINI_MODEL_MID})`,
    factory: () => new StructuredRunner(new GeminiCliRunner(GEMINI_MODEL_MID), `Gemini CLI (${GEMINI_MODEL_MID})`),
  },
  {
    // Pro rescue — best quality; requires Gemini Advanced subscription.
    kind: 'cli', name: `Gemini CLI (${GEMINI_MODEL_PRO})`,
    factory: () => new StructuredRunner(new GeminiCliRunner(GEMINI_MODEL_PRO), `Gemini CLI (${GEMINI_MODEL_PRO})`),
  },
];

/**
 * Stage 3 — QA Reviewer
 * Goal: strong adversarial judgment without over-spending on premium subscriptions.
 */
const QA_WATERFALL: TierSpec[] = [
  {
    kind: 'api', name: 'Nemotron 3 Super',
    factory: () => new DeepInfraApiRunner(NEMOTRON_MODEL),
  },
  {
    kind: 'cli', name: 'Codex CLI',
    factory: () => new StructuredRunner(new CodexCliRunner(), 'Codex CLI'),
  },
  {
    kind: 'cli', name: `Gemini CLI (${GEMINI_MODEL_MID})`,
    factory: () => new StructuredRunner(new GeminiCliRunner(GEMINI_MODEL_MID), `Gemini CLI (${GEMINI_MODEL_MID})`),
  },
];

/**
 * Stage 4 — Executor
 * Goal: fast, cheap, reliable structured JSON for each tool-call turn.
 */
const EXECUTOR_WATERFALL: TierSpec[] = [
  {
    kind: 'cli', name: `Gemini CLI (${GEMINI_MODEL_FAST})`,
    factory: () => new StructuredRunner(new GeminiCliRunner(GEMINI_MODEL_FAST), `Gemini CLI (${GEMINI_MODEL_FAST})`),
  },
  {
    kind: 'api', name: 'Qwen3-32B',
    factory: () => new DeepInfraApiRunner(QWEN3_MODEL),
  },
  {
    kind: 'api', name: 'Nemotron 3 Super',
    factory: () => new DeepInfraApiRunner(NEMOTRON_MODEL),
  },
];

/** Resolve a stage or legacy mode to its waterfall. */
function resolveWaterfall(stage: PipelineStage | undefined, mode: RunMode | undefined): TierSpec[] {
  // stage takes priority
  if (stage === 'orchestrator') return ORCHESTRATOR_WATERFALL;
  if (stage === 'planning')     return PLANNING_WATERFALL;
  if (stage === 'qa')           return QA_WATERFALL;
  if (stage === 'executor')     return EXECUTOR_WATERFALL;
  // legacy mode fallback
  if (mode === 'reasoning')     return PLANNING_WATERFALL;
  return ORCHESTRATOR_WATERFALL; // structural / unset → orchestrator
}

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

// ─── Debug file writer ────────────────────────────────────────────────────────

function writeDebugFiles(err: CliParseError, evidence: EvidenceBundle | undefined): void {
  if (!evidence) return;

  const separator = '═'.repeat(60);

  evidence.writeDebugFile(
    'debug_cli_raw_stdout.log',
    [
      separator,
      'RAW CLI STDOUT',
      separator,
      err.rawStdout,
      '',
      separator,
      'RAW CLI STDERR',
      separator,
      err.rawStderr,
      '',
      separator,
      'ERROR MESSAGE',
      separator,
      err.message,
    ].join('\n'),
  );

  if (err.zodError !== undefined) {
    evidence.writeDebugFile(
      'debug_zod_error.json',
      JSON.stringify(err.zodError, null, 2),
    );
  }

  console.warn(
    `[babel] Parse failure — debug files written to:\n` +
    `  ${evidence.runDir}/debug_cli_raw_stdout.log`,
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

    // ── API-tier gate ──────────────────────────────────────────────────────
    if (DISABLE_API_FALLBACK && spec.kind === 'api') {
      throw new Error(
        `CLI tiers exhausted and API fallback is disabled ` +
        `(BABEL_DISABLE_API_FALLBACK=true). Halting pipeline. ` +
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

        if (err instanceof CliParseError) {
          writeDebugFiles(err, evidence);
        }

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
