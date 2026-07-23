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

/**
 * Resolve chat engine limits from environment with optional per-engine overrides.
 *
 * Env:
 * - BABEL_CHAT_MAX_TURNS (default 200, safety ceiling)
 * - BABEL_CHAT_MAX_MESSAGES (default 20)
 * - BABEL_CHAT_MAX_TOKENS (default 128000)
 * - BABEL_CHAT_MAX_COST (default 2.00, USD)
 * - BABEL_CHAT_MAX_WALL_MS (default 600000, 10 minutes)
 * - BABEL_CHAT_STALL_TURNS (default 12)
 * - BABEL_CHAT_MAX_TOKENS_PER_ROUND (default 200_000, R11 per-round token ceiling)
 * - BABEL_CHAT_INVESTIGATE_MODEL (optional, default undefined — use primary for all phases)
 * - BABEL_CHAT_MUTATE_MODEL (optional, default undefined — use primary for all phases)
 * - BABEL_CHAT_STALL_DEEPSEEK_MULTIPLIER (default 1.5, range 1.0-3.0)
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
      3_600_000,
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

  return {
    maxTurns: Math.min(500, Math.max(1, overrides.maxTurns ?? fromEnv.maxTurns)),
    maxConversationMessages: Math.min(
      200,
      Math.max(4, overrides.maxConversationMessages ?? fromEnv.maxConversationMessages),
    ),
    maxEstimatedTokens: Math.min(
      200_000,
      Math.max(4_000, overrides.maxEstimatedTokens ?? fromEnv.maxEstimatedTokens),
    ),
    maxCostUsd: Math.min(
      100.00,
      Math.max(0.01, overrides.maxCostUsd ?? fromEnv.maxCostUsd),
    ),
    maxWallMs: Math.min(
      3_600_000,
      Math.max(10_000, overrides.maxWallMs ?? fromEnv.maxWallMs),
    ),
    stallTurns,
    investigateModel: overrides.investigateModel ?? fromEnv.investigateModel,
    mutateModel: overrides.mutateModel ?? fromEnv.mutateModel,
    maxTokensPerRound: Math.min(
      2_000_000,
      Math.max(10_000, overrides.maxTokensPerRound ?? fromEnv.maxTokensPerRound),
    ),
  };
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
