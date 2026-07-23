/**
 * systemMonitor.ts — System awareness for adaptive harness behavior.
 *
 * Called once per turn before deliberation and before sub-agent spawns.
 * Reads OS memory, process heap, active sub-agent count, and context
 * utilization to compute a throttle level and compaction strategy.
 *
 * All functions are synchronous/on-demand (no polling) to avoid
 * event-loop interference in the single-threaded Node.js runtime.
 */

import { freemem, totalmem } from 'node:os';
import { backgroundTaskRegistry } from './backgroundTaskRegistry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SystemState {
  /** Free system memory in bytes. */
  freeMemoryBytes: number;
  /** Total system memory in bytes. */
  totalMemoryBytes: number;
  /** Memory pressure as a percentage (0-100). Higher = more pressure. */
  memoryPressurePercent: number;
  /** Number of currently active sub-agents (registered in BackgroundTaskRegistry). */
  activeSubAgents: number;
  /** Estimated context window utilization as percentage (0-100). 0 if unknown. */
  contextUtilPercent: number;
  /** Number of messages in the current conversation. */
  messageCount: number;
}

export type ThrottleLevel =
  | 'none'
  | 'reduce_concurrency'
  | 'force_synthesis'
  | 'decline_new_work';

export interface CompactionStrategy {
  /** Whether compaction should run now. */
  shouldCompact: boolean;
  /** Number of recent messages to preserve (excluding system message). */
  keepCount: number;
  /** Aggressiveness of trimming: 'light' | 'normal' | 'aggressive'. */
  aggressiveness: 'light' | 'normal' | 'aggressive';
}

// ─── Thresholds ─────────────────────────────────────────────────────────────

/** Memory pressure at which we reduce tool concurrency. */
const MEMORY_PRESSURE_REDUCE = 70;

/** Memory pressure at which we force answer synthesis. */
const MEMORY_PRESSURE_SYNTHESIS = 85;

/** Memory pressure at which we decline all new work. */
const MEMORY_PRESSURE_DECLINE = 95;

/** Context utilization at which compaction triggers (percentage of model limit). */
const CONTEXT_COMPACTION_TRIGGER = 70;

/** Context utilization at which we force synthesis. */
const CONTEXT_SYNTHESIS_TRIGGER = 90;

/** Maximum concurrent sub-agents before throttling. */
const MAX_ACTIVE_SUB_AGENTS = 10;

/** Default assumed context limit when model policy is unavailable. */
const DEFAULT_CONTEXT_LIMIT = 200_000;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Gather the current system state. Called once per turn.
 * Uses synchronous OS calls — safe for single-threaded Node.js.
 */
export function getSystemState(opts?: {
  contextLimit?: number;
  currentTokens?: number;
  messageCount?: number;
}): SystemState {
  const freeBytes = freemem();
  const totalBytes = totalmem();
  const memoryPressure = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);

  // NOTE: This counts ALL active background tasks (index warmup, pipeline preflight, etc.),
  // not just sub-agents. The BackgroundTask type currently has no `kind` or `type` field
  // to distinguish sub-agent tasks from internal background work. A long-running indexing
  // task can therefore inflate this count and incorrectly throttle sub-agent concurrency.
  // Future fix: add a `kind: 'sub_agent' | 'background'` field to BackgroundTask and filter
  // here to only count sub-agent tasks.
  const activeSubAgents = backgroundTaskRegistry.getActiveTasks().length;

  // Context utilization based on model's context limit
  const contextLimit = opts?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const currentTokens = opts?.currentTokens ?? 0;
  const contextUtil = contextLimit > 0
    ? Math.round((currentTokens / contextLimit) * 100)
    : 0;

  return {
    freeMemoryBytes: freeBytes,
    totalMemoryBytes: totalBytes,
    memoryPressurePercent: memoryPressure,
    activeSubAgents,
    contextUtilPercent: Math.min(contextUtil, 100),
    messageCount: opts?.messageCount ?? 0,
  };
}

/**
 * Determine the throttle level based on system state.
 * Called at the start of each turn and before sub-agent spawns.
 */
export function getThrottleLevel(state: SystemState): ThrottleLevel {
  // Memory pressure takes priority — OOM is the worst failure mode
  if (state.memoryPressurePercent >= MEMORY_PRESSURE_DECLINE) {
    return 'decline_new_work';
  }
  if (state.memoryPressurePercent >= MEMORY_PRESSURE_SYNTHESIS) {
    return 'force_synthesis';
  }
  if (state.contextUtilPercent >= CONTEXT_SYNTHESIS_TRIGGER) {
    return 'force_synthesis';
  }
  if (
    state.memoryPressurePercent >= MEMORY_PRESSURE_REDUCE ||
    state.activeSubAgents >= MAX_ACTIVE_SUB_AGENTS
  ) {
    return 'reduce_concurrency';
  }
  return 'none';
}

/**
 * Determine the compaction strategy based on system state and model context.
 */
export function getCompactionStrategy(
  state: SystemState,
  contextLimit?: number,
): CompactionStrategy {
  const limit = contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const contextUtil = state.contextUtilPercent;

  // Memory pressure forces aggressive compaction
  if (state.memoryPressurePercent >= MEMORY_PRESSURE_SYNTHESIS) {
    return {
      shouldCompact: true,
      keepCount: Math.max(2, Math.floor(state.messageCount * 0.2)),
      aggressiveness: 'aggressive',
    };
  }

  // Context approaching limit — compact normally
  if (contextUtil >= CONTEXT_COMPACTION_TRIGGER) {
    // Keep proportionally more messages when context is plentiful
    const keepRatio = contextUtil >= 85 ? 0.3 : contextUtil >= 70 ? 0.5 : 0.6;
    return {
      shouldCompact: true,
      keepCount: Math.max(4, Math.floor(state.messageCount * keepRatio)),
      aggressiveness: contextUtil >= 85 ? 'aggressive' : 'normal',
    };
  }

  // Message count guard — compact lightly if conversation is very long
  if (state.messageCount > 200) {
    return {
      shouldCompact: true,
      keepCount: 150,
      aggressiveness: 'light',
    };
  }

  return { shouldCompact: false, keepCount: state.messageCount, aggressiveness: 'light' };
}

/**
 * Get recommended max tool concurrency based on system state.
 */
export function getRecommendedConcurrency(state: SystemState): number {
  if (state.memoryPressurePercent >= MEMORY_PRESSURE_REDUCE) {
    return 2;
  }
  if (state.activeSubAgents >= 8) {
    return 3;
  }
  if (state.activeSubAgents >= 5) {
    return 4;
  }
  return 6; // default MAX_TOOL_CONCURRENCY
}

/**
 * Check if it's safe to spawn another sub-agent.
 */
export function canSpawnSubAgent(state: SystemState): boolean {
  return (
    state.memoryPressurePercent < MEMORY_PRESSURE_REDUCE &&
    state.activeSubAgents < MAX_ACTIVE_SUB_AGENTS
  );
}
