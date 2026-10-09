/**
 * ConversationStatus — the single conversation-level status vocabulary (Packet A1).
 *
 * Babel's halt/executor statuses were previously resolved ad hoc at several
 * sites (`TerminalOutcome` in `schemas/agentContracts.ts`, the legacy string
 * `ChatStatus`, the `turn_ended` session event). This module consolidates them
 * into one exported enum with OpenHands-style terminal classification.
 *
 * Shadow pattern: this enum never replaces the legacy fields. Existing
 * `TerminalOutcome` / `ChatStatus` / `turn_ended.status` emissions continue
 * unchanged; the enum is derived in parallel (see
 * `conversationStatusFromTerminalOutcome` and
 * `conversationStatusFromLegacyStatus`) and rides the fact stream as
 * `run.status_changed`.
 *
 * Pure data and pure functions only — no I/O, no authority decisions. A
 * derived conversation status is an observation, never a completion decision
 * (`completion.decided` remains the only authoritative terminal fact).
 */

/** Conversation-level status. */
export enum ConversationStatus {
  /** No work admitted; waiting for the user. */
  IDLE = 'IDLE',
  /** A turn/run is executing. */
  RUNNING = 'RUNNING',
  /** Suspended but resumable (user pause, cancellation with resume intent). */
  PAUSED = 'PAUSED',
  /** Blocked on a human/permission decision before further action. */
  AWAITING_PERMISSION = 'AWAITING_PERMISSION',
  /** Terminal: work concluded successfully (verified or accepted-as-is). */
  FINISHED = 'FINISHED',
  /** Terminal: concluded in failure (infra, agent, budget). */
  ERROR = 'ERROR',
  /** Terminal: stuck loop detected — repeated no-progress turns halted auto-continue. */
  STUCK = 'STUCK',
}

/** Terminal statuses end the conversation; no further automatic transition. */
const TERMINAL_STATUSES: ReadonlySet<ConversationStatus> = new Set([
  ConversationStatus.FINISHED,
  ConversationStatus.ERROR,
  ConversationStatus.STUCK,
]);

/** Whether `status` is terminal (OpenHands-style classification). */
export function isTerminal(status: ConversationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Transition legality. Any transition into a status is allowed except leaving
 * a terminal one (a terminal conversation is restarted, not re-transitioned;
 * restarts begin a new conversation lifecycle at RUNNING/IDLE).
 */
export function canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
  return !isTerminal(from);
}

/**
 * Map the executor `TerminalOutcome` vocabulary to a conversation status.
 *
 * Total over the known outcomes; unknown/absent input maps to IDLE rather
 * than fabricating a failure (no outcome is never reported as an error).
 *
 * Rationale for the non-obvious rows:
 *  - `CANCELLED` → PAUSED: cancellation is resumable (a new user message
 *    continues the conversation), so it is not terminal here.
 *  - `BLOCKED_*` / `NEEDS_HUMAN_DECISION` / `INVALID_TASK` →
 *    AWAITING_PERMISSION: the conversation halts pending a human decision.
 */
export function conversationStatusFromTerminalOutcome(outcome: string | null | undefined): ConversationStatus {
  switch (outcome) {
    case 'VERIFIED_COMPLETE':
    case 'UNVERIFIED_PATCH':
    case 'NO_CHANGE_REQUIRED':
    case 'PLAN_COMPLETE':
      return ConversationStatus.FINISHED;
    case 'BUDGET_EXHAUSTED':
    case 'INFRA_FAILURE':
    case 'AGENT_FAILURE':
      return ConversationStatus.ERROR;
    case 'BLOCKED_EXTERNAL':
    case 'BLOCKED_POLICY':
    case 'NEEDS_HUMAN_DECISION':
    case 'INVALID_TASK':
      return ConversationStatus.AWAITING_PERMISSION;
    case 'CANCELLED':
      return ConversationStatus.PAUSED;
    default:
      return ConversationStatus.IDLE;
  }
}

/**
 * Map the legacy free-form `ChatStatus` / `turn_ended.status` strings to a
 * conversation status. Total; unknown strings map to IDLE (never fabricated).
 */
export function conversationStatusFromLegacyStatus(status: string | null | undefined): ConversationStatus {
  switch (status) {
    case 'completed':
      return ConversationStatus.FINISHED;
    case 'failed':
    case 'budget_exhausted':
      return ConversationStatus.ERROR;
    case 'blocked':
      return ConversationStatus.AWAITING_PERMISSION;
    case 'cancelled':
      return ConversationStatus.PAUSED;
    default:
      return conversationStatusFromTerminalOutcome(status);
  }
}

/** Human-readable label (diagnostic only; never an authority surface). */
export function conversationStatusLabel(status: ConversationStatus): string {
  switch (status) {
    case ConversationStatus.IDLE: return 'Idle';
    case ConversationStatus.RUNNING: return 'Running';
    case ConversationStatus.PAUSED: return 'Paused';
    case ConversationStatus.AWAITING_PERMISSION: return 'Awaiting permission';
    case ConversationStatus.FINISHED: return 'Finished';
    case ConversationStatus.ERROR: return 'Error';
    case ConversationStatus.STUCK: return 'Stuck';
  }
}
