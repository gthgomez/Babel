// ─── Chat Engine Limits ─────────────────────────────────────────────────────
// Configurable agent-loop and context budget defaults (A7).
// Extended with cost, wall-clock, and stall budgets (v8: budget controller).
// Task-class bases: see chatTaskClass.ts (quick_fix / general_swe / …).

import {
  getChatTaskTune,
  resolveChatTaskClass,
  type ChatTaskClass,
} from './chatTaskClass.js';

export interface ChatEngineLimits {
  maxTurns: number;
  maxConversationMessages: number;
  maxEstimatedTokens: number;
  /** Max cost in USD before forced abort (P1 budget controller). */
  maxCostUsd: number;
  /** Max wall-clock time in ms before forced abort (P1 budget controller). */
  maxWallMs: number;
  /** Consecutive turns without progress before stall is declared. */
  stallTurns: number;
  /** Model to use for investigate phase (B4: model routing). Defaults to primary model. */
  investigateModel: string | undefined;
  /** Model to use for mutate/verify phases (B4: model routing). Defaults to primary model. */
  mutateModel: string | undefined;
  /** Per-round token ceiling — a single turn exceeding this with zero tool calls is
   *  force-BLOCKED without waiting for the text-only-turn counter. R11 guard. */
  maxTokensPerRound: number;
  /**
   * Observable wall-budget provenance: what was requested, what is effective,
   * and which ceiling applied. Present on every resolved limits object.
   */
  wallBudget?: {
    effectiveMs: number;
    requestedMs: number;
    ceilingMs: number;
    longTaskProfile: boolean;
  };
  /**
   * Observable cost-budget provenance. Enumerable so JSON / spreads / manifests
   * retain requested vs effective cost (never attach with enumerable:false).
   */
  costBudget?: {
    effectiveCostUsd: number;
    requestedCostUsd: number;
    ceilingCostUsd: number;
    explicitCostCeiling: boolean;
    longTaskProfile: boolean;
  };
  /** Observable run allowance report for the current session. Enumerable. */
  runAllowance?: ChatEngineRunAllowanceReport;
}

/** Ordinary sessions never allow wall requests beyond one hour. */
export const CHAT_WALL_CEILING_MS = 3_600_000;
/**
 * Ceiling when the explicitly authorized long-task profile is active
 * (BABEL_CHAT_LONG_TASK=1). Supports two-hour-class planned tests; ordinary
 * tasks never default anywhere near this — the profile only widens the clamp
 * for callers that explicitly request more.
 */
export const LONG_TASK_WALL_CEILING_MS = 4 * 60 * 60 * 1000;

export function isLongTaskWallProfileEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env['BABEL_CHAT_LONG_TASK'];
  return raw === '1' || raw === 'true';
}

/**
 * Whether the anti-thrash post-write repair window should shrink the wall.
 *
 * The repair window exists so thrash cannot burn a short class wall after a
 * patch already exists. Against an explicitly authorized long-task wall it
 * would silently kill a multi-hour run 3-8 minutes after the first write, so
 * it is skipped while that profile is active. The hard wall, stall detector,
 * turn limit and cost ceiling all remain in force.
 */
export function shouldShrinkWallForPostWriteRepair(
  wallBudget?: ChatEngineLimits['wallBudget'],
): boolean {
  return wallBudget?.longTaskProfile !== true;
}

/**
 * Whether the anti-thrash post-write repair window should shrink the cost cap.
 *
 * Long-task wall profile does NOT disable the finite cost-repair cap.
 * Skip shrink only for an explicit cost ceiling or cost-budget long-task
 * profile, unless critic strikes show thrash (strikes >= 2).
 */
/**
 * Numeric cost override that may be copied into constructor-style options.
 * Defaults and unlimited env policy must not become a finite explicit ceiling.
 */
export function explicitFiniteCostOverride(limits: ChatEngineLimits): number | undefined {
  if (limits.costBudget?.explicitCostCeiling !== true) return undefined;
  const requested = limits.costBudget.requestedCostUsd;
  return Number.isFinite(requested) ? requested : undefined;
}

export function shouldShrinkCostForPostWriteRepair(
  limits?: Partial<ChatEngineLimits>,
  criticStrikes?: number,
): boolean {
  if (typeof criticStrikes === 'number' && criticStrikes >= 2) return true;
  if (!limits) return true;
  if (limits.costBudget?.longTaskProfile === true) return false;
  if (limits.costBudget?.explicitCostCeiling === true) return false;
  return true;
}

export type ChatRunLimiter =
  | 'wall'
  | 'cost'
  | 'turns'
  | 'stall'
  | 'tokens'
  | 'wall_repair'
  | 'cost_repair'
  | 'critic_reject'
  | 'child_exhaustion'
  | 'none';

export type ChatTerminalClassification =
  | 'success'
  | 'no_limit_triggered'
  | 'limit_wall'
  | 'limit_cost'
  | 'limit_wall_repair'
  | 'limit_cost_repair'
  | 'limit_turns'
  | 'limit_stall'
  | 'limit_tokens'
  | 'limit_child'
  | 'model_failure'
  | 'policy_block'
  | 'cancelled';

export interface ChatEngineChildLimits {
  maxRounds: number;
  timeoutMs?: number;
}

export const DEFAULT_CHILD_LIMITS: ChatEngineChildLimits = {
  maxRounds: 8,
};

export interface ChatEngineRunAllowanceReport {
  declaredWallMs: number;
  effectiveWallMs: number;
  declaredCostUsd: number;
  effectiveCostCapUsd: number;
  /** JSON-safe cost truth; numeric Infinity otherwise becomes indistinguishable from null. */
  costAllowance:
    | { kind: 'finite'; usd: number }
    | { kind: 'unlimited' }
    | { kind: 'unknown'; reason: string };
  turnCap: number;
  stallLimit: number;
  childLimits: ChatEngineChildLimits;
  postWriteRepairWallCapMs: number | null;
  criticRepairCostCapUsd: number | null;
  terminatingLimiter: ChatRunLimiter | null;
  terminalClassification: ChatTerminalClassification | null;
  terminalReason: string | null;
}

export function createRunAllowanceReport(
  limits: ChatEngineLimits,
  state?: {
    postWriteRepairWallCapMs?: number | null;
    criticRepairCostCapUsd?: number | null;
    terminatingLimiter?: ChatRunLimiter | null;
    terminalClassification?: ChatTerminalClassification | null;
    terminalReason?: string | null;
    childLimits?: ChatEngineChildLimits;
  },
): ChatEngineRunAllowanceReport {
  const declaredWallMs = limits.wallBudget?.requestedMs ?? limits.maxWallMs;
  const effectiveWallMs =
    state?.postWriteRepairWallCapMs != null
      ? Math.min(limits.maxWallMs, state.postWriteRepairWallCapMs)
      : limits.maxWallMs;

  const declaredCostUsd = limits.costBudget?.requestedCostUsd ?? limits.maxCostUsd;
  const effectiveCostCapUsd =
    state?.criticRepairCostCapUsd != null
      ? Math.min(limits.maxCostUsd, state.criticRepairCostCapUsd)
      : limits.maxCostUsd;
  const costAllowance = Number.isFinite(declaredCostUsd)
    ? { kind: 'finite' as const, usd: declaredCostUsd }
    : declaredCostUsd === Infinity
      ? { kind: 'unlimited' as const }
      : { kind: 'unknown' as const, reason: 'cost allowance was not recorded as a finite value' };

  return {
    declaredWallMs,
    effectiveWallMs,
    declaredCostUsd,
    effectiveCostCapUsd,
    costAllowance,
    turnCap: limits.maxTurns,
    stallLimit: limits.stallTurns,
    childLimits: state?.childLimits ?? DEFAULT_CHILD_LIMITS,
    postWriteRepairWallCapMs: state?.postWriteRepairWallCapMs ?? null,
    criticRepairCostCapUsd: state?.criticRepairCostCapUsd ?? null,
    terminatingLimiter: state?.terminatingLimiter ?? null,
    terminalClassification: state?.terminalClassification ?? null,
    terminalReason: state?.terminalReason ?? null,
  };
}

/**
 * Classifies a terminal limiter. Being under all limits is NOT success —
 * that is `no_limit_triggered` / ACTIVE. Child exhaustion is a harness
 * limit, not a model reasoning failure.
 */
export function classifyTerminalLimiter(
  limiter: ChatRunLimiter,
  errorOrReason?: string,
): ChatTerminalClassification {
  if (
    errorOrReason &&
    (errorOrReason.toLowerCase().includes('cancel') ||
      errorOrReason.toLowerCase().includes('abort'))
  ) {
    return 'cancelled';
  }
  switch (limiter) {
    case 'wall':
      return 'limit_wall';
    case 'wall_repair':
      return 'limit_wall_repair';
    case 'cost':
      return 'limit_cost';
    case 'cost_repair':
      return 'limit_cost_repair';
    case 'turns':
      return 'limit_turns';
    case 'stall':
      return 'limit_stall';
    case 'tokens':
      return 'limit_tokens';
    case 'critic_reject':
      return 'policy_block';
    case 'child_exhaustion':
      return 'limit_child';
    case 'none':
      return 'no_limit_triggered';
    default:
      return 'model_failure';
  }
}

/**
 * Evaluates the earliest limiter that has fired, or ACTIVE when none has.
 * `limiter: 'none'` is never classified as task success.
 */
export function evaluateTimelineLimiter(input: {
  limits: ChatEngineLimits;
  elapsedMs: number;
  spentUsd: number;
  turns: number;
  consecutiveStallTurns: number;
  postWriteRepairWallCapMs?: number | null;
  criticRepairCostCapUsd?: number | null;
}): {
  limiter: ChatRunLimiter;
  reason?: string;
  classification: ChatTerminalClassification;
} {
  const { limits, elapsedMs, spentUsd, turns, consecutiveStallTurns } = input;
  const effectiveWall =
    input.postWriteRepairWallCapMs != null
      ? Math.min(limits.maxWallMs, input.postWriteRepairWallCapMs)
      : limits.maxWallMs;
  const effectiveCost =
    input.criticRepairCostCapUsd != null
      ? Math.min(limits.maxCostUsd, input.criticRepairCostCapUsd)
      : limits.maxCostUsd;

  if (spentUsd >= effectiveCost) {
    const isRepair =
      input.criticRepairCostCapUsd != null && effectiveCost < limits.maxCostUsd;
    const limiter: ChatRunLimiter = isRepair ? 'cost_repair' : 'cost';
    return {
      limiter,
      reason: `Cost budget exceeded ($${spentUsd.toFixed(2)} of $${effectiveCost.toFixed(2)}) [${limiter}].`,
      classification: isRepair ? 'limit_cost_repair' : 'limit_cost',
    };
  }

  if (elapsedMs >= effectiveWall) {
    const isRepair =
      input.postWriteRepairWallCapMs != null && effectiveWall < limits.maxWallMs;
    const limiter: ChatRunLimiter = isRepair ? 'wall_repair' : 'wall';
    return {
      limiter,
      reason: `Time budget exceeded (${Math.round(elapsedMs / 1000)}s of ${Math.round(effectiveWall / 1000)}s) [${limiter}].`,
      classification: isRepair ? 'limit_wall_repair' : 'limit_wall',
    };
  }

  if (turns >= limits.maxTurns) {
    return {
      limiter: 'turns',
      reason: `Turn limit reached (${turns} of ${limits.maxTurns}).`,
      classification: 'limit_turns',
    };
  }

  if (consecutiveStallTurns >= limits.stallTurns) {
    return {
      limiter: 'stall',
      reason: `Stall limit reached (${consecutiveStallTurns} consecutive turns without progress).`,
      classification: 'limit_stall',
    };
  }

  return {
    limiter: 'none',
    classification: 'no_limit_triggered',
  };
}

export const DEFAULT_CHAT_ENGINE_LIMITS: ChatEngineLimits = {
  maxTurns: 200,                       // safety ceiling — budgets stop the loop
  maxConversationMessages: 20,
  maxEstimatedTokens: 128_000,         // prevent compaction thrash on real repos
  maxCostUsd: 2.00,
  maxWallMs: 10 * 60 * 1000,           // 10 minutes
  stallTurns: 8,
  investigateModel: undefined,
  mutateModel: undefined,
  maxTokensPerRound: 200_000,
};

/**
 * SWE / multi-file engineering profile — longer wall so critic repair strikes can fire.
 * Applied when task class resolves to general_swe (BABEL_CHAT_TASK_CLASS=swe|general_swe|…
 * or BABEL_CHAT_SWE_PROFILE=1). Target band follows general_swe tune (default 600s / 10 min).
 * @deprecated Prefer getChatTaskTune('general_swe').limits — kept for call-site stability.
 */
export const SWE_CHAT_ENGINE_LIMITS: Partial<ChatEngineLimits> = {
  ...getChatTaskTune('general_swe').limits,
};

/** True when env/task class selects general_swe budgets (legacy name). */
export function isSweChatProfileEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveChatTaskClass({ env, autoClassify: false }) === 'general_swe';
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/** Raw pre-clamp integer for observability: NaN/absent resolves to fallback. */
function parseRawInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoundedFloat(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/** Raw pre-clamp float for observability: NaN/absent resolves to fallback. */
function parseRawFloat(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(raw.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolve chat engine limits from environment with optional per-engine overrides.
 *
 * Env:
 * - BABEL_CHAT_MAX_TURNS (default 200, safety ceiling)
 * - BABEL_CHAT_MAX_MESSAGES (default 20)
 * - BABEL_CHAT_MAX_TOKENS (default 128000)
 * - BABEL_CHAT_MAX_COST (default 2.00 USD; explicit 'unlimited' disables only the monetary cap)
 * - BABEL_CHAT_MAX_WALL_MS (default 600000, 10 minutes)
 * - BABEL_CHAT_LONG_TASK=1 → explicitly authorized long-task profile: wall
 *   requests may go up to LONG_TASK_WALL_CEILING_MS (4h) instead of one hour.
 *   Defaults are unchanged; this only widens the clamp for explicit requests.
 *   Requested vs effective wall is always observable via limits.wallBudget.
 * - BABEL_CHAT_STALL_TURNS (default 8)
 * - BABEL_CHAT_MAX_TOKENS_PER_ROUND (default 200_000, R11 per-round token ceiling)
 * - BABEL_CHAT_INVESTIGATE_MODEL (optional, default undefined — use primary for all phases)
 * - BABEL_CHAT_MUTATE_MODEL (optional, default undefined — use primary for all phases)
 * - BABEL_CHAT_STALL_DEEPSEEK_MULTIPLIER (default 1.25, range 1.0-3.0)
 * - BABEL_CHAT_SWE_PROFILE=1 or BABEL_CHAT_TASK_CLASS=swe|general_swe|…
 *   → apply task-class base limits (general_swe wall 1200s) before env overrides
 * - Other classes: quick_fix, investigate, governance, default (see chatTaskClass.ts)
 *
 * @param overrides  Per-engine overrides from the caller.
 * @param model      Current model name, used for per-model stall scaling (DeepSeek gets higher threshold).
 * @param options.taskClass  Explicit class (skips env re-resolve when set).
 * @param options.taskText   Optional task text for auto-classification when env unset.
 */
export function resolveChatEngineLimits(
  overrides: Partial<ChatEngineLimits> = {},
  model?: string,
  options?: { taskClass?: ChatTaskClass; taskText?: string },
): ChatEngineLimits {
  const taskClass =
    options?.taskClass ??
    resolveChatTaskClass({
      ...(options?.taskText !== undefined ? { taskText: options.taskText } : {}),
      autoClassify: Boolean(options?.taskText),
    });
  const tuneLimits = getChatTaskTune(taskClass).limits;
  const baseDefaults: ChatEngineLimits = {
    ...DEFAULT_CHAT_ENGINE_LIMITS,
    ...tuneLimits,
    maxTurns: tuneLimits.maxTurns ?? DEFAULT_CHAT_ENGINE_LIMITS.maxTurns,
    maxWallMs: tuneLimits.maxWallMs ?? DEFAULT_CHAT_ENGINE_LIMITS.maxWallMs,
    maxCostUsd: tuneLimits.maxCostUsd ?? DEFAULT_CHAT_ENGINE_LIMITS.maxCostUsd,
    stallTurns: tuneLimits.stallTurns ?? DEFAULT_CHAT_ENGINE_LIMITS.stallTurns,
  };

  // Explicitly authorized long-task profile widens the wall ceiling. Product
  // defaults never change: without the flag the ceiling stays at one hour.
  const longTaskProfile =
    overrides.wallBudget?.longTaskProfile === true ||
    overrides.costBudget?.longTaskProfile === true ||
    isLongTaskWallProfileEnabled();
  const wallCeiling = longTaskProfile ? LONG_TASK_WALL_CEILING_MS : CHAT_WALL_CEILING_MS;
  // Public callers can provide a number directly. Treat non-finite values as
  // absent so NaN cannot disable the elapsed-time comparison downstream.
  const requestedOverrideMaxWallMs = Number.isFinite(overrides.maxWallMs)
    ? overrides.maxWallMs
    : undefined;
  const requestedMaxWallMs = requestedOverrideMaxWallMs ??
    parseRawInt(process.env['BABEL_CHAT_MAX_WALL_MS'], baseDefaults.maxWallMs);

  const fromEnv: ChatEngineLimits = {
    maxTurns: parseBoundedInt(
      process.env['BABEL_CHAT_MAX_TURNS'],
      baseDefaults.maxTurns,
      1,
      500,
    ),
    maxConversationMessages: parseBoundedInt(
      process.env['BABEL_CHAT_MAX_MESSAGES'],
      baseDefaults.maxConversationMessages,
      4,
      200,
    ),
    maxEstimatedTokens: parseBoundedInt(
      process.env['BABEL_CHAT_MAX_TOKENS'],
      baseDefaults.maxEstimatedTokens,
      4_000,
      200_000,
    ),
    maxCostUsd: parseBoundedFloat(
      process.env['BABEL_CHAT_MAX_COST'],
      baseDefaults.maxCostUsd,
      0.01,
      100.00,
    ),
    maxWallMs: parseBoundedInt(
      process.env['BABEL_CHAT_MAX_WALL_MS'],
      baseDefaults.maxWallMs,
      10_000,
      wallCeiling,
    ),
    stallTurns: parseBoundedInt(
      process.env['BABEL_CHAT_STALL_TURNS'],
      baseDefaults.stallTurns,
      2,
      50,
    ),
    investigateModel: typeof process.env['BABEL_CHAT_INVESTIGATE_MODEL'] === 'string'
      ? process.env['BABEL_CHAT_INVESTIGATE_MODEL']
      : undefined,
    mutateModel: typeof process.env['BABEL_CHAT_MUTATE_MODEL'] === 'string'
      ? process.env['BABEL_CHAT_MUTATE_MODEL']
      : undefined,
    maxTokensPerRound: parseBoundedInt(
      process.env['BABEL_CHAT_MAX_TOKENS_PER_ROUND'],
      baseDefaults.maxTokensPerRound,
      10_000,
      2_000_000,
    ),
  };

  // Clamp overrides through same bounds as the env-var path so callers
  // can't bypass the min/max contract.
  const baseStallTurns = Math.min(
    50,
    Math.max(2, overrides.stallTurns ?? fromEnv.stallTurns),
  );

  // Surface-aware minimum: chat surface (interactive REPL) needs more leniency
  // to avoid prematurely killing sessions during human interaction.
  const surface = process.env['BABEL_SURFACE']?.trim().toLowerCase();
  let surfaceMinStall = 0;
  if (surface === 'chat') {
    surfaceMinStall = 10; // interactive chat — don't stall aggressively
  }

  // Model-aware stall scaling: DeepSeek models are more deliberative
  let stallTurns = baseStallTurns;
  if (model && model.toLowerCase().includes('deepseek')) {
    const multiplier = parseBoundedFloat(
      process.env['BABEL_CHAT_STALL_DEEPSEEK_MULTIPLIER'],
      1.25,
      1.0,
      3.0,
    );
    stallTurns = Math.round(baseStallTurns * multiplier);
  }
  stallTurns = Math.max(stallTurns, surfaceMinStall);

  const resolvedMaxWallMs = Math.min(
    wallCeiling,
    Math.max(10_000, requestedOverrideMaxWallMs ?? fromEnv.maxWallMs),
  );

  const requestedOverrideMaxCostUsd = Number.isFinite(overrides.maxCostUsd)
    ? overrides.maxCostUsd
    : undefined;
  const rawEnvCost = process.env['BABEL_CHAT_MAX_COST'];
  const explicitCostCeiling =
    requestedOverrideMaxCostUsd !== undefined || rawEnvCost !== undefined;
  const requestedMaxCostUsd =
    requestedOverrideMaxCostUsd ??
    (rawEnvCost?.trim().toLowerCase() === 'unlimited'
      ? Infinity
      : parseRawFloat(rawEnvCost, baseDefaults.maxCostUsd));

  const resolvedMaxCostUsd =
    rawEnvCost?.trim().toLowerCase() === 'unlimited' && overrides.maxCostUsd === undefined
      ? Infinity
      : Math.min(
          100.00,
          Math.max(0.01, overrides.maxCostUsd ?? fromEnv.maxCostUsd),
        );

  const resolvedLimits: ChatEngineLimits = {
    maxTurns: Math.min(500, Math.max(1, overrides.maxTurns ?? fromEnv.maxTurns)),
    maxConversationMessages: Math.min(
      200,
      Math.max(4, overrides.maxConversationMessages ?? fromEnv.maxConversationMessages),
    ),
    maxEstimatedTokens: Math.min(
      200_000,
      Math.max(4_000, overrides.maxEstimatedTokens ?? fromEnv.maxEstimatedTokens),
    ),
    maxCostUsd: resolvedMaxCostUsd,
    maxWallMs: resolvedMaxWallMs,
    stallTurns,
    investigateModel: overrides.investigateModel ?? fromEnv.investigateModel,
    mutateModel: overrides.mutateModel ?? fromEnv.mutateModel,
    maxTokensPerRound: Math.min(
      2_000_000,
      Math.max(10_000, overrides.maxTokensPerRound ?? fromEnv.maxTokensPerRound),
    ),
    wallBudget: {
      effectiveMs: resolvedMaxWallMs,
      requestedMs: requestedMaxWallMs,
      ceilingMs: wallCeiling,
      longTaskProfile,
    },
    costBudget: {
      effectiveCostUsd: resolvedMaxCostUsd,
      requestedCostUsd: requestedMaxCostUsd,
      ceilingCostUsd: 100.00,
      explicitCostCeiling,
      // Wall long-task does not imply a cost long-task; only an explicit
      // cost-budget long-task profile skips the finite cost-repair cap.
      longTaskProfile: overrides.costBudget?.longTaskProfile === true,
    },
  };

  resolvedLimits.runAllowance = createRunAllowanceReport(resolvedLimits);
  return resolvedLimits;
}

/** Streaming is on by default; set BABEL_STREAM_TOOLS=0 to disable (A5). */
export function isChatStreamingEnabled(): boolean {
  const raw = process.env['BABEL_STREAM_TOOLS'];
  if (raw === undefined || raw.trim() === '') {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}
