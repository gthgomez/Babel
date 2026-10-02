/**
 * execute.ts — Per-Stage LLM Waterfall Executor
 *
 * Implements four dedicated waterfalls, one per pipeline stage.
 * Live runs are restricted to approved OpenRouter DeepSeek or exact GLM routes;
 * legacy direct DeepSeek/DeepInfra tiers remain available for offline tests and
 * compatibility. No CLI runners.
 *
 * Model selection is loaded from config/model-policy.json. Pricing and
 * capability notes belong in that config with source_url / verified_at /
 * expires_at metadata, not in this runtime header.
 *
 *   orchestrator  (Stage 1 — manifest generation, domain/model routing)
 *     Goal: reliable structured JSON output, fast, cheap.
 *     Route: configured stage waterfall.
 *
 *   planning      (Stage 2 — SWE Agent minimal-action-set plan)
 *     Goal: fast structured minimal-action-set planning that can recover.
 *     Route: configured stage waterfall.
 *
 *   qa            (Stage 3 — QA Reviewer adversarial verdict)
 *     Goal: adversarial critique, catch plan flaws. Instruction following + reasoning depth.
 *     Route: configured stage waterfall.
 *
 *   executor      (Stage 4 — multi-turn tool call loop)
 *     Goal: cheapest reliable JSON per tool-call turn, lowest latency.
 *     Route: configured stage waterfall.
 *
 * Cascade rules:
 *   1. Rate-limit / quota signal         → cascade immediately (no retry).
 *   2. JSON / Zod failure                → one schema-focused retry, then cascade.
 *   3. Runner construction error         → cascade immediately (e.g. missing API key).
 *
 * Backward compatibility:
 *   `mode: 'structural'` maps to the `orchestrator` waterfall.
 *   `mode: 'reasoning'`  maps to the `planning` waterfall.
 *   `stage` takes priority over `mode` when both are provided.
 *
 * Environment variables:
 *   DEEPINFRA_API_KEY          — Required for legacy/offline DeepInfra tiers.
 *   DEEPSEEK_API_KEY           — Direct-provider compatibility only; not used by live controls.
 *   OPENROUTER_API_KEY         — Required for live DeepSeek and GLM/OpenRouter tiers.
 *   BABEL_DEEPINFRA_TOKENS     — max_tokens for DeepInfra responses. Default: 8096
 *   BABEL_WATERFALL_TIMEOUT_MS — aggregate wall-clock timeout per stage waterfall. Default: 180000
 *   BABEL_DISABLE_API_FALLBACK — Set to "true" to halt after first tier failure.
 */

import type { ZodType } from 'zod';
// Note: Legacy API runners (ClaudeCliRunner, CodexCliRunner, etc.) have been kept
// in the `runners/` directory for public-use fallback capabilities, but the internal
// Babel system uses API runners across all stages.
import { DeepInfraApiRunner } from './runners/deepInfraApi.js';
import { DeepSeekApiRunner } from './runners/deepSeekApi.js';
import { OpenRouterApiRunner } from './runners/openRouterApi.js';
import type {
  LlmRunner,
  RunnerInvocationMetadata,
  RunnerCallbacks,
  RunnerProgressEvent,
} from './runners/base.js';
import { EvidenceBundle } from './evidence.js';
import type { TargetModel } from './schemas/agentContracts.js';
import { JitDenialError } from './ui/incrementalToolDetector.js';
import {
  selectBestTierForStage,
  reorderWaterfallByStartIndex,
  clearRoutingCache,
  type RoutingStage,
} from './routingEngine.js';
import { BabelEventBus } from './pipeline/logging.js';

export { clearRoutingCache };
import {
  assertLiveModelId,
  LIVE_OPENROUTER_BACKEND_KEY,
  resolveOpenRouterDeepSeekBackendKey,
  resolveModelByKey,
  resolveModelPolicyBackendKey,
  resolveStagePolicyRoutes,
  type ResolvedModelPolicyEntry,
} from './modelPolicy.js';
import { loadModelPolicyConfig } from './modelPolicy.js';
import { randomUUID } from 'node:crypto';
import {
  globalCostTracker,
  type UsageAttribution,
} from './services/costTracker.js';
import type { CostPrecision } from './services/modelPricingRegistry.js';
import {
  appendSchemaFailureEntry,
  appendSchemaFailureRecovery,
  appendSchemaFailureTerminal,
  readSchemaShadowHints,
  type SchemaFailureLedgerEntry,
} from './services/schemaFailureLedger.js';
import { redactSecrets } from './utils/redaction.js';

export type { TargetModel };

// ─── Waterfall telemetry ──────────────────────────────────────────────────────

/**
 * One record per `runWithFallback` call. Written to `05_waterfall_telemetry.json`
 * via `EvidenceBundle.appendWaterfallLog()` so the full fallback history of a
 * run is visible in a single file.
 */
export interface WaterfallOutcome {
  /** Which pipeline stage produced this call. */
  stage: string;
  /** Human-readable name of the tier that ultimately succeeded. */
  tier_succeeded: string;
  /** 0-based index of the winning tier (0 = first try, >0 = fallback). */
  tier_index: number;
  /** Attempt count within the winning tier (>1 = retry inside that tier). */
  attempts: number;
  /** Names of tiers that were tried and failed before the winner. */
  tiers_skipped: string[];
  /** Brief reason for the last cascade (or "none" if first try succeeded). */
  cascade_reason: string;
  /** ISO 8601 timestamp of when this call completed. */
  ts: string;
  /** Successful and failed attempts observed during this waterfall call. */
  attempts_detail?: WaterfallAttemptOutcome[];
  /** Schema-failure ledger entry ids observed during this waterfall call. */
  schema_failure_entry_ids?: string[];
  /** Aggregate latency across all attempts for this waterfall call. */
  total_latency_ms?: number | null;
  /** Aggregate prompt token count across all attempts with provider usage data. */
  total_prompt_tokens?: number | null;
  /** Aggregate completion token count across all attempts with provider usage data. */
  total_completion_tokens?: number | null;
  /** Aggregate total token count across all attempts with provider usage data. */
  total_tokens?: number | null;
  /** Aggregate estimated provider cost across all attempts with pricing metadata. */
  total_estimated_cost_usd?: number | null;
}

export interface WaterfallAttemptOutcome {
  tier_name: string;
  tier_index: number;
  attempt: number;
  succeeded: boolean;
  error_summary?: string | null;
  provider?: string | null;
  provider_model_id?: string | null;
  /** Serving upstream the gateway reported for this attempt (null when not exposed). */
  upstream_provider?: string | null;
  latency_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  estimated_cost_usd?: number | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
  cost_precision?: CostPrecision | null;
  pricing_source_url?: string | null;
  pricing_verified_at?: string | null;
  input_cost_per_1m?: number | null;
  output_cost_per_1m?: number | null;
  input_cache_hit_cost_per_1m?: number | null;
  input_cache_miss_cost_per_1m?: number | null;
  schema_failure_entry_id?: string | null;
  ttft_ms?: number | null;
  generation_ms?: number | null;
  validation_ms?: number | null;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const DISABLE_API_FALLBACK =
  process.env['BABEL_DISABLE_API_FALLBACK'] === 'true';
const DEFAULT_WATERFALL_TIMEOUT_MS = 180_000;
const AGGREGATE_WATERFALL_TIMEOUT_PREFIX = '[waterfall-timeout]';

function resolveAggregateWaterfallTimeoutMs(): number {
  const raw = Number(
    process.env['BABEL_WATERFALL_TIMEOUT_MS'] ??
      `${DEFAULT_WATERFALL_TIMEOUT_MS}`,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WATERFALL_TIMEOUT_MS;
}

// Heartbeat-aware timeout extension: when the runner is actively streaming
// content (onChunk fires), the waterfall deadline extends by this amount.
// Only triggers when within 30s of the current deadline — idle streams don't
// get extensions.
const HEARTBEAT_EXTENSION_MS = (() => {
  const raw = Number(
    process.env['BABEL_WATERFALL_HEARTBEAT_EXTENSION_MS'] ?? '60000',
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
})();
// Hard cap on the extended deadline, measured from the waterfall start time.
const MAX_EXTENDED_TIMEOUT_MS = (() => {
  const raw = Number(
    process.env['BABEL_WATERFALL_MAX_EXTENDED_MS'] ?? '600000',
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 600000;
})();

// Model IDs. Price/capability provenance is stored in model-policy.json.
const LLAMA4_SCOUT = 'meta-llama/Llama-4-Scout-17B-16E-Instruct';
const QWEN3_235B = 'Qwen/Qwen3-235B-A22B-Instruct-2507';
const STEP_FLASH = 'stepfun-ai/Step-3.5-Flash';
const NEMOTRON = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
const DEEPSEEK_V3 = 'deepseek-ai/DeepSeek-V3-0324';
const QWEN3_32B = 'Qwen/Qwen3-32B';

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

  /**
   * Human-readable schema name for schema-failure evidence. Optional so older
   * callers remain compatible; stage defaults fill the common pipeline schemas.
   */
  schemaName?: string;

  /**
   * Optional callback for streaming model outputs.
   * Only supported by API runners (DeepInfra).
   */
  onChunk?: (chunk: string) => void;

  /**
   * Policy to restrict fallback cascading.
   * 'primary_only' will disallow cascading to backup routes.
   * @default 'allow_backups'
   */
  fallbackPolicy?: 'primary_only' | 'allow_backups';

  /**
   * Event bus instance for progress logs.
   */
  eventBus?: BabelEventBus;

  /**
   * Optional system prompt override. When provided, the runner sends this as
   * the system message (cached by the provider across turns). When omitted,
   * the runner uses its default system prompt.
   *
   * Use this to move the static compiled prompt stack (Core+Guard+Domain)
   * into the system message so it's cached across executor loop turns,
   * saving ~50% of per-turn input tokens via KV cache hits.
   */
  systemPrompt?: string;

  /**
   * Backend keys (matching model-policy.json) to exclude from the waterfall.
   * Applied AFTER dynamic routing reordering and startTierIndex adjustment.
   * Use this to skip weak models (scout, qwen3-32b) for hard tasks where
   * the Smart Planner has determined they would waste attempts.
   *
   * Throws if all tiers would be skipped — at least one model must remain.
   */
  skipTierNames?: string[];

  /**
   * Explicit model backend key override (e.g. "deepseek-v4-pro", "scout").
   * When set, bypasses the stage-based waterfall and creates a direct runner
   * for the specified model. Used by sub-agents for per-agent model selection.
   *
   * The key must exist in model-policy.json's "models" section.
   * When omitted (default), the stage waterfall resolves normally.
   */
  model?: string;

  /** Restrict all provider-backed tiers to direct DeepSeek models. */
  liveOnly?: boolean;

  /** Cancel an in-flight provider call. */
  signal?: AbortSignal;

  /**
   * Optional parent-owned admission guard for delegated provider attempts.
   * A returned limiter stops retries before another provider invocation.
   */
  budgetGuard?: () => RunBudgetLimiter | null;

  /** Checkpoint parent-owned task accounting after delegated usage is recorded. */
  onUsageRecorded?: (metadata: RunnerInvocationMetadata) => void;

  /** Immutable child/parent ownership for delegated provider usage. */
  usageAttribution?: Pick<UsageAttribution, 'taskOwnerId' | 'parentTaskOwnerId' | 'projectRoot' | 'projectRootVersion'>;
}

export type RunBudgetLimiter = 'wall' | 'cost';

export class RunBudgetExceededError extends Error {
  readonly limiter: RunBudgetLimiter;

  constructor(limiter: RunBudgetLimiter) {
    super(`Inherited parent ${limiter} budget exhausted`);
    this.name = 'RunBudgetExceededError';
    this.limiter = limiter;
  }
}

import { RELIABILITY_REPAIR_PROOF_MARKER, resetOfflineQaCallCount, buildPipelineV9OfflineFixtureResponse, buildReliabilityRepairProofExecutorResponse } from './execute/offlineFixtures.js';
export { RELIABILITY_REPAIR_PROOF_MARKER, resetOfflineQaCallCount, buildPipelineV9OfflineFixtureResponse, buildReliabilityRepairProofExecutorResponse } from './execute/offlineFixtures.js';

// ─── Waterfall definitions ────────────────────────────────────────────────────

type TierKind = 'cli' | 'api';

interface TierSpec {
  kind: TierKind;
  name: string;
  provider?: string;
  /** Canonical backend key from model-policy.json (e.g. "scout", "deepseek-v4-pro"). */
  backendKey?: string;
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
 */
const ORCHESTRATOR_WATERFALL: TierSpec[] = [
  {
    kind: 'api',
    name: 'qwen3-32b',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(QWEN3_32B),
  },
  {
    kind: 'api',
    name: 'scout',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(LLAMA4_SCOUT),
  },
];

/**
 * Stage 2 — Planning (SWE Agent)
 */
const PLANNING_WATERFALL: TierSpec[] = [
  {
    kind: 'api',
    name: 'qwen3-32b',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(QWEN3_32B),
  },
  {
    kind: 'api',
    name: 'scout',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(LLAMA4_SCOUT),
  },
];

/**
 * Stage 3 — QA Reviewer
 */
const QA_WATERFALL: TierSpec[] = [
  {
    kind: 'api',
    name: 'deepseek',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(DEEPSEEK_V3),
  },
  {
    kind: 'api',
    name: 'nemotron',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(NEMOTRON),
  },
  {
    kind: 'api',
    name: 'step-flash',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(STEP_FLASH),
  },
  {
    kind: 'api',
    name: 'qwen3-32b',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(QWEN3_32B),
  },
];

/**
 * Stage 4 — Executor
 */
const EXECUTOR_WATERFALL: TierSpec[] = [
  {
    kind: 'api',
    name: 'scout',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(LLAMA4_SCOUT),
  },
  {
    kind: 'api',
    name: 'qwen3',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(QWEN3_235B),
  },
  {
    kind: 'api',
    name: 'qwen3-32b',
    provider: 'deepinfra',
    factory: () => new DeepInfraApiRunner(QWEN3_32B),
  },
  {
    kind: 'api',
    name: 'nemotron',
    provider: 'deepinfra',
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
  mode: RunMode | undefined,
): RoutingStage {
  if (stage !== undefined) return stage; // PipelineStage ⊂ RoutingStage
  if (mode === 'reasoning') return 'planning';
  return 'orchestrator';
}

function getPolicyDisplayName(entry: ResolvedModelPolicyEntry): string {
  switch (entry.backendKey) {
    case 'deepseek-v4-flash':
      return 'DeepSeek v4 Flash';
    case 'deepseek-v4-pro':
      return 'DeepSeek v4 Pro';
    case 'scout':
      return 'Llama-4-Scout';
    case 'qwen3':
      return 'Qwen3-235B-Instruct-2507';
    case 'step-flash':
      return 'Step-3.5-Flash';
    case 'nemotron':
      return 'Nemotron 3 Super';
    case 'deepseek':
      return 'DeepSeek v4 Pro';
    case 'deepinfra-deepseek-v3':
      return 'DeepInfra DeepSeek-V3-0324';
    case 'qwen3-32b':
      return 'Qwen3-32B';
    default:
      return entry.providerModelId;
  }
}

function tierSpecFromPolicyEntry(entry: ResolvedModelPolicyEntry): TierSpec {
  if (entry.provider === 'deepseek') {
    return {
      kind: 'api',
      name: getPolicyDisplayName(entry),
      provider: entry.provider,
      backendKey: entry.backendKey,
      factory: () => new DeepSeekApiRunner(entry.providerModelId),
    };
  }

  if (entry.provider === 'openrouter') {
    return {
      kind: 'api',
      name: getPolicyDisplayName(entry),
      provider: entry.provider,
      backendKey: entry.backendKey,
      factory: () => new OpenRouterApiRunner(entry.providerModelId),
    };
  }

  if (entry.provider !== 'deepinfra') {
    throw new Error(
      `Unsupported stage policy provider "${entry.provider}" for backend "${entry.backendKey}".`,
    );
  }

  return {
    kind: 'api',
    name: getPolicyDisplayName(entry),
    provider: entry.provider,
    backendKey: entry.backendKey,
    factory: () => new DeepInfraApiRunner(entry.providerModelId),
  };
}

function resolvePolicyWaterfall(
  stage: PipelineStage,
  liveOnly = false,
): TierSpec[] | null {
  const routes = resolveStagePolicyRoutes({ liveOnly });
  const route = routes.find((candidate) => candidate.stage === stage);
  if (!route) return null;
  return route.orderedBackends.map(tierSpecFromPolicyEntry);
}

/** Resolve a stage or legacy mode to its waterfall. */
function resolveWaterfall(
  stage: PipelineStage | undefined,
  mode: RunMode | undefined,
  liveOnly = false,
): TierSpec[] {
  const effectiveStage = resolveEffectiveStage(stage, mode) as PipelineStage;
  const policyWaterfall = resolvePolicyWaterfall(effectiveStage, liveOnly);
  if (policyWaterfall && policyWaterfall.length > 0) {
    return policyWaterfall;
  }

  if (effectiveStage === 'planning') return PLANNING_WATERFALL;
  if (effectiveStage === 'qa') return QA_WATERFALL;
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

const STRUCTURED_OUTPUT_FAILURE_SIGNALS = [
  'zod validation failed',
  'invalid json',
  'failed to parse api response as json',
] as const;

const REQUEST_TIMEOUT_SIGNALS = [
  'request timeout',
  'aborterror',
  'aborted',
] as const;

function isImmediateCascade(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    RATE_LIMIT_SIGNALS.some((s) => msg.includes(s)) ||
    SPAWN_ERROR_SIGNALS.some((s) => msg.includes(s)) ||
    STRUCTURED_OUTPUT_FAILURE_SIGNALS.some((s) => msg.includes(s)) ||
    REQUEST_TIMEOUT_SIGNALS.some((s) => msg.includes(s))
  );
}

export function isStructuredOutputFailure(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return STRUCTURED_OUTPUT_FAILURE_SIGNALS.some((s) => msg.includes(s));
}

export interface StructuredOutputRetryPromptOptions {
  stage?: string;
  schemaName?: string;
  shadowHints?: string[];
}

function inferSchemaNameFromStage(
  stage: string | undefined,
  fallback = 'StructuredOutputSchema',
): string {
  switch (stage) {
    case 'orchestrator':
      return 'OrchestratorOutputSchema';
    case 'planning':
      return 'SwePlanSchema';
    case 'qa':
      return 'QaVerdictSchema';
    case 'executor':
      return 'ExecutorTurnSchema';
    default:
      return fallback;
  }
}

function buildStageStructuredOutputGuidance(
  stage: string | undefined,
  schemaName: string,
): string[] {
  switch (stage) {
    case 'orchestrator':
      return [
        `Schema target: ${schemaName}.`,
        'If this is not a parallel_swarm task, omit the swarm field entirely.',
        'Never emit swarm.sub_tasks as an empty array; empty swarm means no swarm field.',
      ];
    case 'planning':
      return [
        `Schema target: ${schemaName}.`,
        'Return the complete SWE plan object with every required array present.',
        'Use [] only for arrays that are allowed to be empty; do not replace arrays with strings or prose.',
      ];
    case 'qa':
      return [
        `Schema target: ${schemaName}.`,
        'For PASS, return the exact PASS verdict shape and do not include rejection-only fields.',
        'For REJECT, include at least one actionable failure with evidence and a concrete fix direction.',
      ];
    case 'executor':
      return [
        `Schema target: ${schemaName}.`,
        'Return exactly one executor turn variant: tool_call, completion, or halt.',
        'For tool_call, include the tool discriminator and only fields valid for that tool.',
        'For completion or halt, do not mix in tool-call fields.',
      ];
    default:
      return [
        `Schema target: ${schemaName}.`,
        'Match the requested schema exactly and keep variant/discriminator fields internally consistent.',
      ];
  }
}

export function buildStructuredOutputRetryPrompt(
  prompt: string,
  error: Error,
  options: StructuredOutputRetryPromptOptions = {},
): string {
  const errorSummary = redactSecrets(
    error.message.replace(/\s+/g, ' ').slice(0, 1200),
  );
  const schemaName =
    options.schemaName ?? inferSchemaNameFromStage(options.stage);
  const stageGuidance = buildStageStructuredOutputGuidance(
    options.stage,
    schemaName,
  );
  const shadowHints = options.shadowHints ?? [];
  return [
    prompt,
    '',
    '---',
    'BABEL STRUCTURED OUTPUT RETRY',
    'Your previous response was rejected by the required JSON schema.',
    'Return exactly one raw JSON object matching the requested schema.',
    'Do not omit required arrays or objects. If a required array has no entries, return an empty array unless the schema requires at least one item.',
    ...stageGuidance,
    ...(shadowHints.length > 0
      ? [
          'Schema shadow hints from previous failures:',
          ...shadowHints.map((hint, index) => `${index + 1}. ${hint}`),
        ]
      : []),
    'Do not include markdown, prose, comments, or code fences.',
    `Validation failure: ${errorSummary}`,
  ].join('\n');
}

function buildAggregateWaterfallTimeoutError(
  label: string,
  timeoutMs: number,
  startedAtMs: number,
  phase: string,
): Error {
  const elapsedMs = Date.now() - startedAtMs;
  return new Error(
    `${AGGREGATE_WATERFALL_TIMEOUT_PREFIX} Aggregate ${label} timeout exceeded after ${elapsedMs}ms ` +
      `(limit ${timeoutMs}ms) while ${phase}.`,
  );
}

function isAggregateWaterfallTimeoutError(error: Error): boolean {
  return error.message.startsWith(AGGREGATE_WATERFALL_TIMEOUT_PREFIX);
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  buildTimeoutError: () => Error,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(buildTimeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

// ─── Internal waterfall runner ────────────────────────────────────────────────

interface WaterfallRunResult<T> {
  result: T;
  outcome: Omit<WaterfallOutcome, 'stage' | 'ts'>;
}

function appendSchemaFailureRecoveryIfNeeded(input: {
  evidence: EvidenceBundle | undefined;
  pendingEntryIds: string[];
  pendingEntries: SchemaFailureLedgerEntry[];
  label: string;
  schemaName: string;
  spec: TierSpec;
  tier: number;
  attempt: number;
  prompt: string;
  metadata: RunnerInvocationMetadata | null;
}): SchemaFailureLedgerEntry | null {
  if (!input.evidence || input.pendingEntryIds.length === 0) return null;
  return appendSchemaFailureRecovery({
    evidence: input.evidence,
    stage: input.label,
    schemaName: input.schemaName,
    tierName: input.spec.name,
    tierIndex: input.spec.originalIndex ?? input.tier,
    attempt: input.attempt,
    prompt: input.prompt,
    metadata: input.metadata,
    recoveredEntryIds: [...input.pendingEntryIds],
    recoveredEntries: [...input.pendingEntries],
  });
}

function cloneInvocationMetadata(
  metadata: RunnerInvocationMetadata | null | undefined,
): RunnerInvocationMetadata | null {
  if (!metadata) {
    return null;
  }

  return {
    provider: metadata.provider,
    provider_model_id: metadata.provider_model_id,
    latency_ms: metadata.latency_ms,
    prompt_tokens: metadata.prompt_tokens,
    completion_tokens: metadata.completion_tokens,
    total_tokens: metadata.total_tokens,
    prompt_cache_hit_tokens: metadata.prompt_cache_hit_tokens ?? null,
    prompt_cache_miss_tokens: metadata.prompt_cache_miss_tokens ?? null,
    estimated_cost_usd: metadata.estimated_cost_usd,
    cost_precision: metadata.cost_precision ?? null,
    pricing_source_url: metadata.pricing_source_url ?? null,
    pricing_verified_at: metadata.pricing_verified_at ?? null,
    input_cost_per_1m: metadata.input_cost_per_1m ?? null,
    output_cost_per_1m: metadata.output_cost_per_1m ?? null,
    input_cache_hit_cost_per_1m: metadata.input_cache_hit_cost_per_1m ?? null,
    input_cache_miss_cost_per_1m: metadata.input_cache_miss_cost_per_1m ?? null,
    ttft_ms: metadata.ttft_ms ?? null,
    generation_ms: metadata.generation_ms ?? null,
    validation_ms: metadata.validation_ms ?? null,
  };
}

function getRunnerInvocationMetadata(
  runner: LlmRunner,
): RunnerInvocationMetadata | null {
  return cloneInvocationMetadata(runner.getLastInvocationMetadata?.());
}

function buildAttemptOutcome(
  spec: TierSpec,
  tier: number,
  attempt: number,
  succeeded: boolean,
  metadata: RunnerInvocationMetadata | null,
  errorSummary: string | null = null,
  schemaFailureEntryId: string | null = null,
): WaterfallAttemptOutcome {
  const canonicalIndex = spec.originalIndex ?? tier;
  return {
    tier_name: spec.name,
    tier_index: canonicalIndex,
    attempt,
    succeeded,
    error_summary: errorSummary,
    provider: metadata?.provider ?? null,
    provider_model_id: metadata?.provider_model_id ?? null,
    upstream_provider: metadata?.upstream_provider ?? null,
    latency_ms: metadata?.latency_ms ?? null,
    prompt_tokens: metadata?.prompt_tokens ?? null,
    completion_tokens: metadata?.completion_tokens ?? null,
    total_tokens: metadata?.total_tokens ?? null,
    prompt_cache_hit_tokens: metadata?.prompt_cache_hit_tokens ?? null,
    prompt_cache_miss_tokens: metadata?.prompt_cache_miss_tokens ?? null,
    estimated_cost_usd: metadata?.estimated_cost_usd ?? null,
    cost_precision: metadata?.cost_precision ?? null,
    pricing_source_url: metadata?.pricing_source_url ?? null,
    pricing_verified_at: metadata?.pricing_verified_at ?? null,
    input_cost_per_1m: metadata?.input_cost_per_1m ?? null,
    output_cost_per_1m: metadata?.output_cost_per_1m ?? null,
    input_cache_hit_cost_per_1m: metadata?.input_cache_hit_cost_per_1m ?? null,
    input_cache_miss_cost_per_1m:
      metadata?.input_cache_miss_cost_per_1m ?? null,
    schema_failure_entry_id: schemaFailureEntryId,
    ttft_ms: metadata?.ttft_ms ?? null,
    generation_ms: metadata?.generation_ms ?? null,
    validation_ms: metadata?.validation_ms ?? null,
  };
}

function sumAttemptMetric(
  attempts: WaterfallAttemptOutcome[],
  selector: (attempt: WaterfallAttemptOutcome) => number | null | undefined,
): number | null {
  let total = 0;
  let seen = false;
  for (const attempt of attempts) {
    const value = selector(attempt);
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

function waitForWaterfallDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error('Aborted by user or parent')));
    const timer = setTimeout(() => finish(resolve), delayMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runWaterfall<T>(
  label: string,
  schemaName: string,
  waterfall: TierSpec[],
  prompt: string,
  schema: ZodType<T, unknown>,
  maxAttempts: number,
  aggregateTimeoutMs: number,
  evidence: EvidenceBundle | undefined,
  onChunk?: (chunk: string) => void,
  eventBus?: BabelEventBus,
  systemPrompt?: string,
  signal?: AbortSignal,
  budgetGuard?: () => RunBudgetLimiter | null,
  onUsageRecorded?: (metadata: RunnerInvocationMetadata) => void,
  usageAttribution?: Pick<UsageAttribution, 'taskOwnerId' | 'parentTaskOwnerId' | 'projectRoot' | 'projectRootVersion'>,
): Promise<WaterfallRunResult<T>> {
  const verboseFallbackLogs =
    process.env['BABEL_VERBOSE_WATERFALLS'] === 'true' || !evidence;
  const startedAtMs = Date.now();
  let lastError: Error | null = null;
  const tiersSkipped: string[] = [];
  const attemptsDetail: WaterfallAttemptOutcome[] = [];
  const schemaFailureEntryIds: string[] = [];
  const pendingSchemaFailureEntryIds: string[] = [];
  const pendingSchemaFailureEntries: SchemaFailureLedgerEntry[] = [];
  let lastFailureMetadata: RunnerInvocationMetadata | null = null;
  let usageAttempt = 0;

  // Dynamic deadline: starts at startedAtMs + aggregateTimeoutMs, but can be
  // extended when the runner is actively producing output (onChunk fires).
  // This prevents hard-killing a model that's mid-generation and making progress.
  // Idle streams don't get extensions — the deadline only extends when content
  // chunks are actually arriving. Capped at MAX_EXTENDED_TIMEOUT_MS from start.
  let deadline = startedAtMs + aggregateTimeoutMs;

  const extendDeadlineIfActive = (): void => {
    const now = Date.now();
    const withinExtensionWindow = deadline - now < 30_000; // only extend when near deadline
    if (withinExtensionWindow) {
      const newDeadline = now + HEARTBEAT_EXTENSION_MS;
      const maxDeadline = startedAtMs + MAX_EXTENDED_TIMEOUT_MS;
      if (newDeadline > deadline) {
        deadline = Math.min(newDeadline, maxDeadline);
      }
    }
  };

  const ensureTimeRemaining = (phase: string): number => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw buildAggregateWaterfallTimeoutError(
        label,
        aggregateTimeoutMs,
        startedAtMs,
        phase,
      );
    }
    return remainingMs;
  };

  const ensureBudgetAvailable = (): void => {
    const limiter = budgetGuard?.();
    if (limiter) throw new RunBudgetExceededError(limiter);
    if (signal?.aborted) throw new Error('Aborted by user or parent');
  };
  const recordRunnerUsage = (runner: LlmRunner, dispatchedChargeId?: string | null): RunnerInvocationMetadata | null => {
    const metadata = getRunnerInvocationMetadata(runner);
    if (
      metadata?.provider_model_id &&
      metadata.prompt_tokens !== null &&
      metadata.completion_tokens !== null
    ) {
      const update = globalCostTracker.settleUsage(
        metadata.provider_model_id,
        metadata.prompt_tokens,
        metadata.completion_tokens,
        metadata.prompt_cache_hit_tokens,
        metadata.prompt_cache_miss_tokens,
        usageAttribution
          ? {
              ...usageAttribution,
              chargeId: dispatchedChargeId ?? `${usageAttribution.taskOwnerId}:${label}:${++usageAttempt}:${randomUUID()}`,
            }
          : undefined,
      );
      if (update.kind === 'conflict') throw new Error(`Delegated charge conflict: ${update.reason}`);
      if (update.kind === 'inserted' || update.kind === 'refined') onUsageRecorded?.(metadata);
    }
    return metadata;
  };

  for (let tier = 0; tier < waterfall.length; tier++) {
    const spec = waterfall[tier]!;
    const next = waterfall[tier + 1];
    ensureBudgetAvailable();
    // Soft-landing: check deadline before starting a new tier, but allow
    // in-flight requests to complete naturally instead of raceWithTimeout.
    ensureTimeRemaining(`starting tier ${spec.name}`);

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
        if (eventBus) {
          eventBus.modelFailover({
            original_model: spec.name,
            new_model: next.name,
            ...(lastError?.message ? { reason: lastError.message } : {}),
          });
          eventBus.logLine(
            `[babel:${label}] Using backup route: cascading to ${next.name}`,
          );
        }
        if (verboseFallbackLogs) {
          console.warn(
            `[babel:${label}] ${spec.name} unavailable — ${lastError.message.slice(0, 120)}`,
          );
          console.warn(`[babel:${label}] Cascading to ${next.name}...`);
        }
      }
      continue;
    }

    // ── Attempt loop ───────────────────────────────────────────────────────
    let cascadeFromTier = false;
    let promptForTier = prompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let dispatchedChargeId: string | null = null;
      let chargePersistenceFailed = false;
      try {
        ensureBudgetAvailable();
        const remainingMs = ensureTimeRemaining(
          `running tier ${spec.name} attempt ${attempt}`,
        );

        const runnerCallbacks: RunnerCallbacks = {
          onInvocationPhase: (event) => {
            if (event.phase !== 'request_dispatched' || !usageAttribution) return;
            dispatchedChargeId = `${usageAttribution.taskOwnerId}:${label}:${++usageAttempt}:${randomUUID()}`;
            const update = globalCostTracker.settleUsage(event.model, 0, 0, null, null, {
              ...usageAttribution, chargeId: dispatchedChargeId,
            }, false);
            if (update.kind !== 'inserted') throw new Error('Delegated dispatch blocked by charge conflict');
            try {
              onUsageRecorded?.({
                provider: event.provider, provider_model_id: event.model, latency_ms: null,
                prompt_tokens: null, completion_tokens: null, total_tokens: null,
                estimated_cost_usd: null,
              });
            } catch {
              chargePersistenceFailed = true;
              throw new Error('Delegated dispatch blocked because its charge receipt could not be saved');
            }
          },
          onRetry: () => {
            if (chargePersistenceFailed) {
              throw new Error('Delegated retry blocked by charge persistence failure');
            }
            const limiter = budgetGuard?.();
            if (limiter) throw new RunBudgetExceededError(limiter);
          },
          onChunk: (chunk: string) => {
            // Heartbeat: each content chunk extends the waterfall deadline so
            // actively-streaming models aren't hard-killed mid-generation.
            extendDeadlineIfActive();
            if (onChunk) onChunk(chunk);
          },
          onThought: (thought: string) => {
            // Reasoning content also counts as activity — the model is working.
            extendDeadlineIfActive();
            if (eventBus && typeof eventBus.assistantThought === 'function') {
              eventBus.assistantThought(thought);
            }
          },
          onProgress: (event: RunnerProgressEvent) => {
            if (eventBus) {
              let logMsg = `[babel:${label}] ${event.state}`;
              if (event.details) {
                logMsg += `: ${event.details}`;
              }
              eventBus.logLine(logMsg);
            }
          },
        };

        // Soft-landing: once an attempt has started, let it finish naturally.
        // The deadline is checked before starting each tier/attempt but is NOT
        // enforced mid-flight via Promise.race — killing a model mid-generation
        // discards partial output and wastes tokens. Activity heartbeats extend
        // the deadline while the model is actively producing content.
        const result = await runner.execute(
          promptForTier,
          schema,
          runnerCallbacks,
          systemPrompt,
          signal,
        );
        const invocationMetadata = recordRunnerUsage(runner, dispatchedChargeId);
        ensureBudgetAvailable();

        const recoveryEntry = appendSchemaFailureRecoveryIfNeeded({
          evidence,
          pendingEntryIds: pendingSchemaFailureEntryIds,
          pendingEntries: pendingSchemaFailureEntries,
          label,
          schemaName,
          spec,
          tier,
          attempt,
          prompt: promptForTier,
          metadata: invocationMetadata,
        });
        if (recoveryEntry) {
          schemaFailureEntryIds.push(recoveryEntry.entry_id);
          pendingSchemaFailureEntryIds.length = 0;
          pendingSchemaFailureEntries.length = 0;
        }

        attemptsDetail.push(
          buildAttemptOutcome(
            spec,
            tier,
            attempt,
            true,
            invocationMetadata,
            null,
            recoveryEntry?.entry_id ?? null,
          ),
        );

        // ── Build and emit a structured success log ──────────────────────
        const fallbacks = tiersSkipped.length;

        // Suppress provider/model names in plain human logs unless fallback is triggered,
        // where we append (Model fallback: backup route used).
        let logMsg = `[babel:${label}] ✓ success`;
        if (fallbacks > 0) {
          logMsg += ` (Model fallback: backup route used)`;
        } else if (attempt > 1) {
          logMsg += ` (attempt ${attempt})`;
        }
        console.log(logMsg);

        const cascadeReason = lastError?.message.slice(0, 100) ?? 'none';
        const canonicalIndex = spec.originalIndex ?? tier;
        return {
          result,
          outcome: {
            tier_succeeded: spec.name,
            tier_index: canonicalIndex,
            attempts: attempt,
            tiers_skipped: [...tiersSkipped],
            cascade_reason: cascadeReason,
            attempts_detail: attemptsDetail,
            total_latency_ms: sumAttemptMetric(
              attemptsDetail,
              (entry) => entry.latency_ms,
            ),
            total_prompt_tokens: sumAttemptMetric(
              attemptsDetail,
              (entry) => entry.prompt_tokens,
            ),
            total_completion_tokens: sumAttemptMetric(
              attemptsDetail,
              (entry) => entry.completion_tokens,
            ),
            total_tokens: sumAttemptMetric(
              attemptsDetail,
              (entry) => entry.total_tokens,
            ),
            total_estimated_cost_usd: sumAttemptMetric(
              attemptsDetail,
              (entry) => entry.estimated_cost_usd,
            ),
            schema_failure_entry_ids: schemaFailureEntryIds,
          },
        };
      } catch (err) {
        if (err instanceof JitDenialError) {
          throw err;
        }
        if (err instanceof RunBudgetExceededError) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isAggregateWaterfallTimeoutError(lastError)) {
          throw lastError;
        }
        const invocationMetadata = recordRunnerUsage(runner, dispatchedChargeId);
        lastFailureMetadata = invocationMetadata;
        ensureBudgetAvailable();
        let schemaFailureEntryId: string | null = null;
        let schemaRetryPrompt: string | null = null;
        if (isStructuredOutputFailure(lastError)) {
          const willRetry = attempt < maxAttempts;
          const shadowHints = evidence
            ? readSchemaShadowHints({
                evidence,
                stage: label,
                schemaName,
              })
            : [];
          schemaRetryPrompt = willRetry
            ? buildStructuredOutputRetryPrompt(prompt, lastError, {
                stage: label,
                schemaName,
                shadowHints,
              })
            : null;
          if (evidence) {
            const entry = appendSchemaFailureEntry({
              evidence,
              stage: label,
              schemaName,
              tierName: spec.name,
              tierIndex: spec.originalIndex ?? tier,
              attempt,
              prompt: promptForTier,
              error: lastError,
              metadata: invocationMetadata,
              retryOutcome: willRetry ? 'pending_retry' : 'cascaded',
              retryPrompt: schemaRetryPrompt,
            });
            schemaFailureEntryId = entry.entry_id;
            schemaFailureEntryIds.push(entry.entry_id);
            pendingSchemaFailureEntryIds.push(entry.entry_id);
            pendingSchemaFailureEntries.push(entry);
          }
        }
        attemptsDetail.push(
          buildAttemptOutcome(
            spec,
            tier,
            attempt,
            false,
            invocationMetadata,
            lastError.message.slice(0, 200),
            schemaFailureEntryId,
          ),
        );

        if (isStructuredOutputFailure(lastError) && attempt < maxAttempts) {
          promptForTier =
            schemaRetryPrompt ??
            buildStructuredOutputRetryPrompt(prompt, lastError, {
              stage: label,
              schemaName,
            });
          const backoffMs = 750 * attempt;
          const remainingBeforeBackoff = ensureTimeRemaining(
            `waiting to retry tier ${spec.name} after schema validation failure`,
          );
          if (remainingBeforeBackoff <= backoffMs) {
            throw buildAggregateWaterfallTimeoutError(
              label,
              aggregateTimeoutMs,
              startedAtMs,
              `waiting to retry tier ${spec.name} after schema validation failure`,
            );
          }
          if (verboseFallbackLogs) {
            console.warn(
              `[babel:${label}] ${spec.name} returned schema-invalid JSON; retrying once with a schema-focused prompt.\n` +
                `  Reason: ${lastError.message.slice(0, 160)}`,
            );
          }
          await waitForWaterfallDelay(backoffMs, signal);
          continue;
        }

        if (isImmediateCascade(lastError)) {
          cascadeFromTier = true;
          break;
        }

        if (attempt < maxAttempts) {
          const backoffMs = 1500 * attempt;
          const remainingBeforeBackoff = ensureTimeRemaining(
            `waiting to retry tier ${spec.name} after attempt ${attempt}`,
          );
          if (remainingBeforeBackoff <= backoffMs) {
            throw buildAggregateWaterfallTimeoutError(
              label,
              aggregateTimeoutMs,
              startedAtMs,
              `waiting to retry tier ${spec.name} after attempt ${attempt}`,
            );
          }
          if (verboseFallbackLogs) {
            console.warn(
              `[babel:${label}] ${spec.name} attempt ${attempt}/${maxAttempts} failed — retrying in ${backoffMs}ms.\n` +
                `  Reason: ${lastError.message.slice(0, 160)}`,
            );
          }
          await waitForWaterfallDelay(backoffMs, signal);
        } else {
          cascadeFromTier = true;
        }
      }
    }

    if (cascadeFromTier) {
      tiersSkipped.push(spec.name);
      if (next) {
        if (eventBus) {
          eventBus.modelFailover({
            original_model: spec.name,
            new_model: next.name,
            ...(lastError?.message ? { reason: lastError.message } : {}),
          });
          eventBus.logLine(
            `[babel:${label}] Using backup route: cascading to ${next.name}`,
          );
        }
        if (verboseFallbackLogs) {
          console.warn(
            `[babel:${label}] ${spec.name} failed. Cascading to ${next.name}...`,
          );
        }
      }
    }
  }

  const finalMessage =
    `All ${waterfall.length} runner(s) in the waterfall failed. ` +
    `Last error: ${lastError?.message ?? 'unknown'}`;
  if (evidence && schemaFailureEntryIds.length > 0) {
    const terminalEntry = appendSchemaFailureTerminal({
      evidence,
      stage: label,
      schemaName,
      prompt,
      metadata: lastFailureMetadata,
      relatedEntryIds: schemaFailureEntryIds,
      retryOutcome: 'fatal',
      errorMessage: finalMessage,
    });
    schemaFailureEntryIds.push(terminalEntry.entry_id);
  }
  throw new Error(finalMessage);
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
  prompt: string,
  schema: ZodType<T, unknown>,
  options: RunOptions = {},
): Promise<T> {
  const maxAttempts = options.maxCliAttempts ?? 2;
  // Always have a bundle for schema failure telemetry — when the caller
  // doesn't provide one, use a lightweight in-memory bundle that writes to
  // a deterministic per-session directory so failures are never silent.
  const evidence =
    options.evidence ??
    EvidenceBundle.inMemory(options.schemaName ?? 'schema-failure');
  const liveOnly =
    options.liveOnly ?? process.env['BABEL_PIPELINE_V9_OFFLINE'] !== '1';
  let waterfall = resolveWaterfall(options.stage, options.mode, liveOnly);
  if (options.fallbackPolicy === 'primary_only') {
    waterfall = waterfall.slice(0, 1);
  }

  // Per-agent model override: when an explicit backend key is provided,
  // bypass the stage-based waterfall and create a single-tier waterfall
  // with a direct runner for that model.
  if (options.model) {
    if (liveOnly) {
      assertLiveModelId(options.model, 'live model override');
    }
    const { config } = loadModelPolicyConfig();
    const routedModel = liveOnly
      ? resolveOpenRouterDeepSeekBackendKey(options.model) ?? options.model
      : options.model;
    const backendKey = resolveModelPolicyBackendKey(routedModel);
    const backend = backendKey ? config.models?.[backendKey] : undefined;
    if (backendKey && backend) {
      const resolved = resolveModelByKey({ key: backendKey, liveOnly });
      const factory =
        backend.provider === 'deepseek'
          ? () => new DeepSeekApiRunner(backend.model_id)
          : backend.provider === 'openrouter'
            ? () => new OpenRouterApiRunner(backend.model_id)
            : () => new DeepInfraApiRunner(backend.model_id);
      waterfall = [
        {
          kind: 'api',
          name: backendKey,
          provider: resolved.provider,
          backendKey,
          factory,
        },
      ];
    }
    // Live model overrides are validated above and must resolve to an
    // approved route; they cannot silently fall through to another model.
  }
  if (liveOnly) {
    waterfall = waterfall.filter(
      (tier) =>
        tier.provider === 'openrouter' &&
        (tier.backendKey === LIVE_OPENROUTER_BACKEND_KEY ||
          tier.backendKey?.endsWith('-openrouter') === true),
    );
    if (waterfall.length === 0) {
      throw new Error(
        '[LIVE_MODEL_POLICY] No approved live tier is available for this live stage.',
      );
    }
  }
  const label = options.stage ?? options.mode ?? 'unknown';
  const effectiveStage = resolveEffectiveStage(options.stage, options.mode);
  const schemaName = options.schemaName ?? inferSchemaNameFromStage(label);
  const aggregateTimeoutMs = resolveAggregateWaterfallTimeoutMs();
  const deterministicReliabilityProofResponse =
    buildReliabilityRepairProofExecutorResponse(prompt, options);
  const pipelineV9OfflineFixtureResponse =
    buildPipelineV9OfflineFixtureResponse(prompt, options);

  if (pipelineV9OfflineFixtureResponse !== null) {
    const result = schema.parse(pipelineV9OfflineFixtureResponse);
    if (evidence) {
      evidence.writeDebugFile(
        `debug_${label}_pipeline_v9_offline_response.json`,
        `${JSON.stringify(pipelineV9OfflineFixtureResponse, null, 2)}\n`,
      );
      evidence.appendWaterfallLog({
        stage: label,
        tier_succeeded: 'pipeline-v9-offline-fixture',
        tier_index: -1,
        attempts: 1,
        tiers_skipped: [],
        cascade_reason: 'none',
        ts: new Date().toISOString(),
        attempts_detail: [
          {
            tier_name: 'pipeline-v9-offline-fixture',
            tier_index: -1,
            attempt: 1,
            succeeded: true,
            error_summary: null,
            provider: 'local-test-double',
            provider_model_id: 'babel-pipeline-v9-offline',
            latency_ms: 0,
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            estimated_cost_usd: null,
          },
        ],
        total_latency_ms: 0,
        total_prompt_tokens: null,
        total_completion_tokens: null,
        total_tokens: null,
        total_estimated_cost_usd: null,
      } satisfies WaterfallOutcome);
    }
    console.log(`[babel:${label}] ✓ pipeline v9 offline fixture response`);
    return result;
  }

  if (deterministicReliabilityProofResponse !== null) {
    const result = schema.parse(deterministicReliabilityProofResponse);
    if (evidence) {
      evidence.writeDebugFile(
        `debug_${label}_deterministic_repair_proof_response.json`,
        `${JSON.stringify(deterministicReliabilityProofResponse, null, 2)}\n`,
      );
      evidence.appendWaterfallLog({
        stage: label,
        tier_succeeded: 'deterministic-repair-proof-model-boundary',
        tier_index: -1,
        attempts: 1,
        tiers_skipped: [],
        cascade_reason: 'none',
        ts: new Date().toISOString(),
        attempts_detail: [
          {
            tier_name: 'deterministic-repair-proof-model-boundary',
            tier_index: -1,
            attempt: 1,
            succeeded: true,
            error_summary: null,
            provider: 'local-test-double',
            provider_model_id: 'babel-reliability-repair-proof',
            latency_ms: 0,
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            estimated_cost_usd: null,
          },
        ],
        total_latency_ms: 0,
        total_prompt_tokens: null,
        total_completion_tokens: null,
        total_tokens: null,
        total_estimated_cost_usd: null,
      } satisfies WaterfallOutcome);
    }
    console.log(
      `[babel:${label}] ✓ deterministic repair proof model-boundary response`,
    );
    return result;
  }

  // ── Dynamic Routing v1 ────────────────────────────────────────────────────
  // Explicit `startTierIndex` from the caller wins; otherwise consult the
  // routing engine (which returns null when disabled or data is too thin).
  let startTierIndex = options.startTierIndex;

  if (startTierIndex === undefined) {
    const routingOpts =
      options.dynamicRouting !== undefined
        ? { enabled: options.dynamicRouting }
        : undefined;

    const decision = selectBestTierForStage(
      effectiveStage,
      waterfall.map((spec) => spec.name),
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
  const stampedWaterfall = waterfall.map((spec, i) => ({
    ...spec,
    originalIndex: i,
  }));
  let orderedWaterfall = reorderWaterfallByStartIndex(
    stampedWaterfall,
    startTierIndex,
  );

  // ── Smart Planner tier skipping ──────────────────────────────────────────
  // Remove tiers whose backend key matches a skip entry. This runs AFTER
  // dynamic routing reordering and startTierIndex adjustment so it can
  // strip weak tiers regardless of where they ended up in the order.
  if (options.skipTierNames && options.skipTierNames.length > 0) {
    const skipSet = new Set(
      options.skipTierNames.map((n) => n.toLowerCase().trim()),
    );
    const filtered = orderedWaterfall.filter((spec) => {
      const key = (spec.backendKey ?? spec.name).toLowerCase().trim();
      return !skipSet.has(key);
    });
    if (filtered.length === 0) {
      throw new Error(
        `[babel:${label}] All tiers skipped by skipTierNames="${options.skipTierNames.join(', ')}". ` +
          `Cannot proceed — at least one model tier must remain in the waterfall.`,
      );
    }
    if (filtered.length < orderedWaterfall.length) {
      const skipped = orderedWaterfall
        .filter((spec) =>
          skipSet.has((spec.backendKey ?? spec.name).toLowerCase().trim()),
        )
        .map((s) => s.name)
        .join(', ');
      if (options.eventBus) {
        options.eventBus.logLine(`Smart Planner: skipping tiers [${skipped}]`);
      }
    }
    orderedWaterfall = filtered;
  }

  const waterfallResult = await runWaterfall(
    label,
    schemaName,
    orderedWaterfall,
    prompt,
    schema,
    maxAttempts,
    aggregateTimeoutMs,
    options.evidence,
    options.onChunk,
    options.eventBus,
    options.systemPrompt,
    options.signal,
    options.budgetGuard,
    options.onUsageRecorded,
    options.usageAttribution,
  );

  // Record to evidence bundle for 05_waterfall_telemetry.json.
  if (evidence) {
    evidence.appendWaterfallLog({
      ...waterfallResult.outcome,
      stage: label,
      ts: new Date().toISOString(),
    } satisfies WaterfallOutcome);
  }

  return waterfallResult.result as T;
}

export function runWithPrimaryOnlyFallback<T>(
  prompt: string,
  schema: ZodType<T, unknown>,
  options: Omit<RunOptions, 'fallbackPolicy'> = {},
): Promise<T> {
  return runWithFallback(prompt, schema, {
    ...options,
    fallbackPolicy: 'primary_only',
  });
}

/**
 * Direct model call that bypasses the waterfall machinery entirely.
 *
 * Creates a single DeepInfraApiRunner with the default chat model (QWEN3_32B)
 * and executes the prompt directly. Includes a simple retry loop for transient
 * failures but no tier management, no heartbeat, no timeout extension, and no
 * fixture detection.
 *
 * Use this for simple ask prompts where the full waterfall (~600 lines of tier
 * management, dynamic routing, timeout extension, heartbeat, retry logic, and
 * fixture detection) would be unnecessary overhead.
 *
 * @param prompt  - The prompt to send to the model.
 * @param schema  - Zod schema to validate and type the model's JSON output.
 * @param options - Optional callbacks and retry configuration.
 * @returns       Validated result of type `T`.
 */
export async function runDirectAsk<T>(
  prompt: string,
  schema: ZodType<T, unknown>,
  options: {
    onChunk?: (chunk: string) => void;
    maxAttempts?: number;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const runner = new OpenRouterApiRunner('deepseek/deepseek-v4-flash-0731');

  let lastError: Error | null = null;
  const maxAttempts = options.maxAttempts ?? 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const callbacks = options.onChunk
        ? { onChunk: options.onChunk }
        : undefined;
      const result = await runner.execute(
        prompt,
        schema,
        callbacks,
        undefined,
        options.signal,
      );
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastError ?? new Error('runDirectAsk failed');
}

export async function runWaterfallForSchemaFailureTest<T>(input: {
  prompt: string;
  schema: ZodType<T, unknown>;
  stage: string;
  schemaName: string;
  evidence: EvidenceBundle;
  maxAttempts?: number;
  tiers: Array<{ name: string; runner: LlmRunner }>;
  budgetGuard?: () => RunBudgetLimiter | null;
  onUsageRecorded?: (metadata: RunnerInvocationMetadata) => void;
  usageAttribution?: Pick<UsageAttribution, 'taskOwnerId' | 'parentTaskOwnerId' | 'projectRoot' | 'projectRootVersion'>;
}): Promise<T> {
  const waterfall = input.tiers.map(
    (tier, index): TierSpec => ({
      kind: 'api',
      name: tier.name,
      factory: () => tier.runner,
      originalIndex: index,
    }),
  );
  const waterfallResult = await runWaterfall(
    input.stage,
    input.schemaName,
    waterfall,
    input.prompt,
    input.schema,
    input.maxAttempts ?? 2,
    resolveAggregateWaterfallTimeoutMs(),
    input.evidence,
    undefined,
    undefined,
    undefined,
    undefined,
    input.budgetGuard,
    input.onUsageRecorded,
    input.usageAttribution,
  );
  input.evidence.appendWaterfallLog({
    ...waterfallResult.outcome,
    stage: input.stage,
    ts: new Date().toISOString(),
  } satisfies WaterfallOutcome);
  return waterfallResult.result;
}
