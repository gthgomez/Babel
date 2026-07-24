// ─── Stall Detector ─────────────────────────────────────────────────────────
// P2: Detects when the chat agent is stuck in a read-loop — no writes, no new
// files read, and repeated grep/read targets across the last K turns.
//
// Cumulative progress awareness (P3): agents that have made writes get extra
// grace (may be in a slow verify loop). First 3 turns are never stalled.
//
// R11: Text-only loop detection — tracks consecutive turns where the model
// produces text/completion responses without any tool calls. A model stuck in
// pure conversation burns tokens without detection since the tool-pattern-based
// stall detector never sees any tools. After N consecutive text-only turns,
// escalation kicks in (force_status → BLOCKED).

import { isDirectMutationTool, isSuccessfulDirectMutation, isVerifierAttemptTool } from './mutationTools.js';

export interface StallState {
  turnsSinceLastWrite: number;
  turnsSinceNewFileRead: number;
  lastReadTargets: string[];
  lastWriteTurn: number;
  lastVerifierTurn: number;
  /** Total file writes across the session — used for cumulative progress. */
  totalWrites: number;
  /** Total tool calls across the session — used for grace period. */
  totalToolCalls: number;
  /** R2: Escalation level for stall interventions (0 = no intervention yet). */
  interventionLevel: number;
  /** R2: Messages from previous interventions. */
  interventionHistory: string[];
  /** R11: Consecutive turns with zero tool calls (text-only / completion turns). */
  textOnlyTurns: number;
}

export interface StallIntervention {
  level: 'nudge' | 'restrict_tools' | 'force_status' | 'kill';
  message: string;
}

export function createStallDetector(): StallState {
  return {
    turnsSinceLastWrite: 0,
    turnsSinceNewFileRead: 0,
    lastReadTargets: [],
    lastWriteTurn: -1,
    lastVerifierTurn: -1,
    totalWrites: 0,
    totalToolCalls: 0,
    interventionLevel: 0,
    interventionHistory: [],
    textOnlyTurns: 0,
  };
}

/** Max number of read targets to retain for repetition detection. */
const MAX_READ_TARGET_HISTORY = 12;

/** Don't stall in the first N turns regardless of conditions. */
const MIN_TURNS_BEFORE_STALL = 3;

/** Extra turns of grace when the agent has made writes (may be in verify loop). */
const WRITES_GRACE_TURNS = 2;

/** R11: Consecutive text-only turns before force_status escalation. */
const TEXT_ONLY_LOOP_THRESHOLD = 3;

/** R11: Consecutive text-only turns before forced BLOCKED termination. */
export const TEXT_ONLY_FORCE_BLOCKED_THRESHOLD = 5;

export function updateStallState(
  state: StallState,
  turnToolCalls: Array<{ tool: string; target: string; error?: string }>,
  turnIndex: number,
): StallState {
  const next: StallState = {
    ...state,
    turnsSinceLastWrite: state.turnsSinceLastWrite + 1,
    turnsSinceNewFileRead: state.turnsSinceNewFileRead + 1,
    totalToolCalls: state.totalToolCalls + turnToolCalls.length,
    // R11: Reset text-only counter — this turn had tool calls.
    textOnlyTurns: 0,
  };

  const readTargetsThisTurn: string[] = [];
  let sawNewFile = false;
  // Phase / verifier honesty: only count shell as "verified" after a real patch.
  // Early pytest/ls thrash must not stamp lastVerifierTurn (see classifyPhase).
  // Bug A fix: only successful mutations count as writes.
  // Blocked/failed str_replace must NOT reset turnsSinceLastWrite.
  const hasWriteThisTurn = turnToolCalls.some((tc) =>
    isSuccessfulDirectMutation(tc.tool, tc.error),
  );
  const sessionHasWrites = state.totalWrites > 0 || hasWriteThisTurn;

  for (const tc of turnToolCalls) {
    // Track writes (includes str_replace) — successful only
    if (isSuccessfulDirectMutation(tc.tool, tc.error)) {
      next.turnsSinceLastWrite = 0;
      next.lastWriteTurn = turnIndex;
      next.totalWrites = state.totalWrites + 1;
    }
    // Track verifier attempts only after mutations exist (or write this turn).
    // test_run / run_command before any patch are exploration/shell thrash.
    if (isVerifierAttemptTool(tc.tool) && sessionHasWrites) {
      next.lastVerifierTurn = turnIndex;
    }
    // Track read targets
    if (
      tc.tool === 'read_file' ||
      tc.tool === 'read_range' ||
      tc.tool === 'grep' ||
      tc.tool === 'glob' ||
      tc.tool === 'list_dir'
    ) {
      readTargetsThisTurn.push(tc.target);
      // Check if this file has been seen before
      if (!state.lastReadTargets.includes(tc.target)) {
        sawNewFile = true;
      }
    }
  }

  if (sawNewFile) {
    next.turnsSinceNewFileRead = 0;
  }

  // Maintain sliding window of read targets
  const combined = [...state.lastReadTargets, ...readTargetsThisTurn];
  next.lastReadTargets = combined.slice(-MAX_READ_TARGET_HISTORY);

  return next;
}

/** Returns true only when targets in the last N positions are identical. */
function hasRepeatedTargets(lastReadTargets: string[]): boolean {
  if (lastReadTargets.length < 3) return false;
  // Check if the last 3 targets are all the same (stuck on one file)
  const recent = lastReadTargets.slice(-3);
  return recent.length === 3 && recent[0] === recent[1] && recent[1] === recent[2];
}

export function isStalled(state: StallState, threshold: number): boolean {
  // Grace period: don't stall in the first few turns
  if (state.totalToolCalls < MIN_TURNS_BEFORE_STALL) return false;

  // If the agent has ever made a write, be more lenient (may be in a slow verify loop)
  const effectiveThreshold = state.totalWrites > 0
    ? Math.max(threshold, threshold + WRITES_GRACE_TURNS)
    : threshold;

  return (
    state.turnsSinceLastWrite >= effectiveThreshold &&
    state.turnsSinceNewFileRead >= effectiveThreshold &&
    hasRepeatedTargets(state.lastReadTargets)
  );
}

// ─── Escalating Stall Interventions (R2) ───────────────────────────────────
// Each subsequent stall produces a stronger message, culminating in kill.

/**
 * Determine the next stall intervention based on intervention history.
 * Level 1 = nudge, Level 2 = restrict_tools, Level 3 = force_status, Level 4+ = kill.
 */
export function escalateStallIntervention(
  state: StallState,
  previousInterventions: StallIntervention[],
): StallIntervention {
  const escalationIndex = previousInterventions.length;
  switch (escalationIndex) {
    case 0:
      return {
        level: 'nudge',
        message:
          'You appear to be stuck in a read loop. Consider making progress by writing files or declaring the task BLOCKED if it cannot be completed.',
      };
    case 1:
      return {
        level: 'restrict_tools',
        message:
          'You have been reading without making progress. Stop reading new files. Either write the necessary changes or declare BLOCKED with evidence of what was checked.',
      };
    case 2:
      return {
        level: 'force_status',
        message:
          'You must now emit a structured status: DONE (task complete), BLOCKED (task impossible, with evidence), or NEED: <specific thing needed>. Declare your status now.',
      };
    default:
      return {
        level: 'kill',
        message:
          'Maximum stall interventions reached. This session is being terminated.',
      };
  }
}

/**
 * Check if currently stalled and return the appropriate intervention message.
 * Returns null when not stalled.
 *
 * @param shadowMode When true and the intervention would be 'kill', downgrade
 *   to 'nudge' level with a shadow-mode note. The agent is never terminated
 *   by the stall detector.
 */
export function getStallInterventionMessage(
  state: StallState,
  threshold: number,
  shadowMode?: boolean,
): StallIntervention | null {
  if (!isStalled(state, threshold)) {
    return null;
  }
  // Reconstruct previous interventions from history for escalation level calculation
  const levels: StallIntervention['level'][] = ['nudge', 'restrict_tools', 'force_status', 'kill'];
  const previousInterventions: StallIntervention[] = state.interventionHistory.map((msg, i) => ({
    level: levels[i] ?? 'kill',
    message: msg,
  }));
  const intervention = escalateStallIntervention(state, previousInterventions);

  // Shadow mode: downgrade kill to nudge — the model keeps full tool access
  // and the would-be-kill is recorded via policyEventLog in the caller.
  if (shadowMode && intervention.level === 'kill') {
    return {
      level: 'nudge',
      message: `[Shadow mode] Would have killed but logging instead.\n${intervention.message}`,
    };
  }

  return intervention;
}

/**
 * Report what the stall detector WOULD have done at the current state.
 * Returns null when no kill would have occurred (below kill threshold).
 * Useful for terminal logging / observability in shadow mode.
 */
export function getStallShadowReport(state: StallState): {
  wouldHaveKilled: boolean;
  interventionLevel: number;
  historyLength: number;
} | null {
  // Kill threshold is reached when interventionHistory.length >= 3
  // (escalationIndex 3+ in escalateStallIntervention)
  if (state.interventionHistory.length < 3) return null;
  return {
    wouldHaveKilled: state.interventionLevel >= 4,
    interventionLevel: state.interventionLevel,
    historyLength: state.interventionHistory.length,
  };
}

// ─── R11: Text-Only Loop Detection ─────────────────────────────────────────
// Complements the tool-pattern-based stall detector. When a model produces
// only text/completion responses without ever calling tools, the standard
// stall detector (which only sees tool calls) never advances. This detector
// catches pure-conversation loops that would otherwise burn the entire budget.

/**
 * Returns true when the state has accumulated enough consecutive text-only
 * turns to trigger escalation. Use TEXT_ONLY_LOOP_THRESHOLD for the first
 * escalation (force_status) and TEXT_ONLY_FORCE_BLOCKED_THRESHOLD for
 * forced BLOCKED termination.
 */
export function isTextOnlyLoop(state: StallState, threshold?: number): boolean {
  const t = threshold ?? TEXT_ONLY_LOOP_THRESHOLD;
  return state.textOnlyTurns >= t;
}

/**
 * Build a force_status intervention message for text-only loops.
 * Distinct from the tool-stall force_status — this one emphasizes
 * the lack of tool usage rather than repeated read patterns.
 */
export function buildTextOnlyLoopIntervention(state: StallState): string {
  return [
    `You have responded ${state.textOnlyTurns} times in a row without using any tools or making file changes.`,
    'You must now emit a structured status:',
    '- DONE if the task is complete (with evidence of what was accomplished)',
    '- BLOCKED if the task cannot be completed (explain what is missing or impossible, with evidence of what you checked)',
    '- NEED: <specific thing> if you require something specific to continue',
    'If you can make progress with tools (read_file, grep, str_replace, write_file, run_command), do so now instead of just describing what you would do.',
  ].join('\n');
}

/**
 * Build a terminal BLOCKED message for text-only loops that exceeded
 * the force-blocked threshold. The agent had multiple chances to use
 * tools or declare BLOCKED and continued to loop in text.
 */
export function buildTextOnlyLoopBlockedMessage(state: StallState): string {
  return [
    `BLOCKED: ${state.textOnlyTurns} consecutive turns without any tool calls or file changes.`,
    'The agent produced only text responses and never used tools to investigate or mutate.',
    `Text-only turn count: ${state.textOnlyTurns}. The agent was given opportunities to use tools or declare BLOCKED.`,
  ].join('\n');
}
