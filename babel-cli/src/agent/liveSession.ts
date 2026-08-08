/**
 * LiveSessionV1 — H2 recoverable policy-bound live session projection.
 *
 * One deterministic projection derived from durable SessionEventLog (+ optional
 * ThreadEventLog / InstructionManifest). Restart reconstructs the same task,
 * instruction manifest, tool/idempotency state, verifier state, budgets, and
 * terminal outcome without inventing missing events.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';
import type { InstructionManifestV1 } from './instructionManifest.js';
import type { SessionEvent, SessionEventLog } from './sessionEvents.js';
import type { ThreadEvent, ThreadEventLog } from './threadEventLog.js';
import {
  completedToolIdempotencyKeys,
  interruptedToolIdempotencyKeys,
} from './sessionEvents.js';

export const LIVE_SESSION_VERSION = 1 as const;

export type LiveSessionPhase =
  | 'idle'
  | 'authorized'
  | 'effect_running'
  | 'effect_complete'
  | 'mutation_prepare'
  | 'mutation_commit'
  | 'mutation_rollback'
  | 'verifying'
  | 'compacting'
  | 'terminal';

export interface LiveSessionBudgetState {
  turns_used: number;
  turns_remaining: number | null;
  tokens_used: number;
  tokens_remaining: number | null;
  repair_attempts_used: number;
  repair_attempts_remaining: number | null;
  infra_retries_used: number;
  infra_retries_remaining: number | null;
}

export interface LiveSessionToolState {
  open_tool_call_ids: string[];
  completed_idempotency_keys: string[];
  interrupted_idempotency_keys: string[];
  last_tool_name?: string;
}

export interface LiveSessionVerifierState {
  last_command?: string;
  last_exit_code?: number;
  authoritative: boolean;
  attempts: number;
}

export interface LiveSessionMutationState {
  last_batch_id?: string;
  last_paths: string[];
  last_status?: string;
  starting_revision?: string;
  ending_revision?: string;
}

export interface LiveSessionTerminalState {
  outcome: TerminalOutcome | string;
  status: string;
  reason?: string;
  evidence_refs: string[];
}

export interface LiveSessionV1 {
  schema_version: typeof LIVE_SESSION_VERSION;
  session_id: string;
  phase: LiveSessionPhase;
  active_task?: string;
  task_class?: string;
  turn_id: string | null;
  instruction_manifest?: InstructionManifestV1;
  /** Hash of instruction manifest when present (survives if full manifest omitted). */
  instruction_manifest_hash?: string;
  provider_model?: string;
  provider_name?: string;
  workspace_revision?: string;
  budgets: LiveSessionBudgetState;
  tools: LiveSessionToolState;
  verifier: LiveSessionVerifierState;
  mutation: LiveSessionMutationState;
  terminal?: LiveSessionTerminalState;
  /** Compaction occurred at least once. */
  compaction_count: number;
  /** Policy intervention count. */
  policy_intervention_count: number;
  /** Last event seq incorporated. */
  last_seq: number;
  /** Event ids that form the projection evidence chain. */
  evidence_event_ids: string[];
  degraded: boolean;
  degraded_reasons: string[];
}

export interface ProjectLiveSessionInput {
  sessionLog: SessionEventLog;
  threadLog?: ThreadEventLog;
  instructionManifest?: InstructionManifestV1;
  /** Budget ceilings (remaining = max(0, ceiling - used)). */
  budgetCeilings?: {
    turns?: number;
    tokens?: number;
    repair_attempts?: number;
    infra_retries?: number;
  };
  /** Optional workspace revision override (e.g. from Git). */
  workspaceRevision?: string;
}

const DEFAULT_BUDGETS: LiveSessionBudgetState = {
  turns_used: 0,
  turns_remaining: null,
  tokens_used: 0,
  tokens_remaining: null,
  repair_attempts_used: 0,
  repair_attempts_remaining: null,
  infra_retries_used: 0,
  infra_retries_remaining: null,
};

function rem(
  used: number,
  ceiling: number | undefined,
): number | null {
  if (ceiling === undefined) return null;
  return Math.max(0, ceiling - used);
}

/**
 * Project LiveSessionV1 from durable session events (and optional thread log).
 * Never invents tool completions or terminals not present in the log.
 */
export function projectLiveSession(input: ProjectLiveSessionInput): LiveSessionV1 {
  const events = [...input.sessionLog.events].sort((a, b) => a.seq - b.seq);
  const ceilings = input.budgetCeilings ?? {};
  const state: LiveSessionV1 = {
    schema_version: LIVE_SESSION_VERSION,
    session_id: input.sessionLog.session_id,
    phase: 'idle',
    turn_id: null,
    budgets: { ...DEFAULT_BUDGETS },
    tools: {
      open_tool_call_ids: [],
      completed_idempotency_keys: [],
      interrupted_idempotency_keys: [],
    },
    verifier: { authoritative: false, attempts: 0 },
    mutation: { last_paths: [] },
    compaction_count: 0,
    policy_intervention_count: 0,
    last_seq: -1,
    evidence_event_ids: [],
    degraded: false,
    degraded_reasons: [],
  };

  if (input.instructionManifest) {
    state.instruction_manifest = input.instructionManifest;
    state.instruction_manifest_hash = input.instructionManifest.manifest_hash;
  }
  if (input.workspaceRevision) {
    state.workspace_revision = input.workspaceRevision;
  }

  const open = new Set<string>();
  const openIdempotencyKeys = new Map<string, string>();
  const completed = new Set<string>();
  const interrupted = new Set<string>();
  const persistedRemaining = {
    turns: false,
    tokens: false,
    repair_attempts: false,
    infra_retries: false,
  };

  for (const e of events) {
    state.last_seq = e.seq;
    state.evidence_event_ids.push(e.event_id);
    state.turn_id = e.turn_id;

    switch (e.kind) {
      case 'user_submitted':
        state.active_task = e.task_preview;
        if (e.task_class) state.task_class = e.task_class;
        if (e.model) state.provider_model = e.model;
        if (e.provider) state.provider_name = e.provider;
        state.phase = 'authorized';
        state.budgets.turns_used += 1;
        break;
      case 'model_started':
        if (e.model) state.provider_model = e.model;
        if (e.provider) state.provider_name = e.provider;
        state.phase = 'authorized';
        break;
      case 'tool_proposed':
        state.phase = 'authorized';
        state.tools.last_tool_name = e.tool_name;
        break;
      case 'tool_started':
        open.add(e.tool_call_id);
        openIdempotencyKeys.set(e.tool_call_id, e.idempotency_key);
        state.phase = 'effect_running';
        state.tools.last_tool_name = e.tool_name;
        break;
      case 'tool_completed':
        open.delete(e.tool_call_id);
        openIdempotencyKeys.delete(e.tool_call_id);
        completed.add(e.idempotency_key);
        state.phase = 'effect_complete';
        break;
      case 'tool_failed':
        open.delete(e.tool_call_id);
        openIdempotencyKeys.delete(e.tool_call_id);
        state.phase = 'effect_complete';
        break;
      case 'tool_cancelled':
        open.delete(e.tool_call_id);
        openIdempotencyKeys.delete(e.tool_call_id);
        interrupted.add(e.idempotency_key);
        state.phase = 'effect_complete';
        break;
      case 'mutation_batch': {
        const status = e.status ?? 'unknown';
        state.mutation = {
          last_paths: [...e.paths],
          last_status: status,
          ...(e.batch_id ? { last_batch_id: e.batch_id } : {}),
          ...(e.starting_revision ? { starting_revision: e.starting_revision } : {}),
          ...(e.ending_revision ? { ending_revision: e.ending_revision } : {}),
        };
        if (e.ending_revision) state.workspace_revision = e.ending_revision;
        if (status === 'prepare') state.phase = 'mutation_prepare';
        else if (status === 'rollback') state.phase = 'mutation_rollback';
        else state.phase = 'mutation_commit';
        break;
      }
      case 'verifier_attempt':
        state.phase = 'verifying';
        state.verifier.attempts += 1;
        state.verifier.last_command = e.command_preview;
        state.verifier.authoritative = e.authoritative;
        if (e.exit_code !== undefined) state.verifier.last_exit_code = e.exit_code;
        break;
      case 'compaction_created':
        state.phase = 'compacting';
        state.compaction_count += 1;
        break;
      case 'policy_intervened':
        state.policy_intervention_count += 1;
        break;
      case 'budget_snapshot':
        if (e.turns_used !== undefined) state.budgets.turns_used = e.turns_used;
        if (e.tokens_used !== undefined) state.budgets.tokens_used = e.tokens_used;
        if (e.repair_attempts_used !== undefined) {
          state.budgets.repair_attempts_used = e.repair_attempts_used;
        }
        if (e.infra_retries_used !== undefined) {
          state.budgets.infra_retries_used = e.infra_retries_used;
        }
        if (e.turns_remaining !== undefined) {
          state.budgets.turns_remaining = e.turns_remaining;
          persistedRemaining.turns = true;
        }
        if (e.tokens_remaining !== undefined) {
          state.budgets.tokens_remaining = e.tokens_remaining;
          persistedRemaining.tokens = true;
        }
        if (e.repair_attempts_remaining !== undefined) {
          state.budgets.repair_attempts_remaining = e.repair_attempts_remaining;
          persistedRemaining.repair_attempts = true;
        }
        if (e.infra_retries_remaining !== undefined) {
          state.budgets.infra_retries_remaining = e.infra_retries_remaining;
          persistedRemaining.infra_retries = true;
        }
        break;
      case 'approval_decision':
        break;
      case 'repair_attempt':
        state.budgets.repair_attempts_used = Math.max(
          state.budgets.repair_attempts_used,
          e.attempt,
        );
        break;
      case 'completion_decision':
        state.phase = 'terminal';
        state.terminal = {
          outcome: e.final_outcome,
          status: e.allowed ? 'allowed' : 'denied',
          reason: e.reason,
          evidence_refs: [...e.evidence_refs],
        };
        break;
      case 'turn_ended':
        state.phase = 'terminal';
        state.terminal = {
          outcome: e.outcome,
          status: e.status,
          evidence_refs: state.terminal?.evidence_refs ?? [],
        };
        break;
      case 'progress_recovery':
        state.budgets.repair_attempts_used += 1;
        break;
      case 'model_failover':
        if (e.new_model) state.provider_model = e.new_model;
        if (e.new_provider) state.provider_name = e.new_provider;
        state.budgets.infra_retries_used += 1;
        break;
      case 'gate_decision':
        break;
      default:
        break;
    }
  }

  // Prefer completedToolIdempotencyKeys helper for completed set authority
  for (const k of completedToolIdempotencyKeys(input.sessionLog)) {
    completed.add(k);
  }

  state.tools = {
    open_tool_call_ids: [...open],
    completed_idempotency_keys: [...completed],
    interrupted_idempotency_keys: [...interrupted],
    ...(state.tools.last_tool_name
      ? { last_tool_name: state.tools.last_tool_name }
      : {}),
  };

  if (!persistedRemaining.turns) {
    state.budgets.turns_remaining = rem(state.budgets.turns_used, ceilings.turns);
  }
  if (!persistedRemaining.tokens) {
    state.budgets.tokens_remaining = rem(state.budgets.tokens_used, ceilings.tokens);
  }
  if (!persistedRemaining.repair_attempts) {
    state.budgets.repair_attempts_remaining = rem(
      state.budgets.repair_attempts_used,
      ceilings.repair_attempts,
    );
  }
  if (!persistedRemaining.infra_retries) {
    state.budgets.infra_retries_remaining = rem(
      state.budgets.infra_retries_used,
      ceilings.infra_retries,
    );
  }

  // Thread log: latest compaction / repo identity for revision
  if (input.threadLog) {
    for (const te of input.threadLog.events) {
      if (te.kind === 'repo_identity' && 'gitHead' in te && te.gitHead) {
        state.workspace_revision = te.gitHead as string;
      }
    }
  }

  // Open tools without terminal → interrupted projection (not success)
  for (const key of interruptedToolIdempotencyKeys(input.sessionLog)) {
    interrupted.add(key);
  }
  for (const id of open) {
    const key = openIdempotencyKeys.get(id);
    if (key && !interrupted.has(key) && !completed.has(key)) {
      interrupted.add(key);
    }
  }
  state.tools.interrupted_idempotency_keys = [
    ...new Set([...state.tools.interrupted_idempotency_keys, ...interrupted]),
  ];
  state.tools.open_tool_call_ids = [...open];

  return state;
}

/**
 * Whether a tool with the given idempotency key may still mutate.
 * Completed keys must not mutate twice (H2 exit gate).
 */
export function canMutateWithIdempotencyKey(
  session: LiveSessionV1,
  idempotencyKey: string,
): boolean {
  return !session.tools.completed_idempotency_keys.includes(idempotencyKey);
}

/**
 * Whether an interrupted non-idempotent effect may be blindly retried.
 * H2: never — interrupted keys require explicit re-authorization.
 */
export function mayBlindRetryInterrupted(
  session: LiveSessionV1,
  idempotencyKey: string,
): boolean {
  if (session.tools.interrupted_idempotency_keys.includes(idempotencyKey)) {
    return false;
  }
  return true;
}

/**
 * Reconstruct terminal outcome from durable evidence only.
 * Returns null when no terminal event exists (does not invent success).
 */
export function reconstructTerminalFromSession(
  log: SessionEventLog,
): LiveSessionTerminalState | null {
  const projected = projectLiveSession({ sessionLog: log });
  return projected.terminal ?? null;
}

/**
 * Resume equivalence check for H2 exit gates.
 */
export function liveSessionsEquivalentForResume(
  a: LiveSessionV1,
  b: LiveSessionV1,
): { ok: boolean; mismatches: string[] } {
  const normalize = (session: LiveSessionV1): Record<string, unknown> => ({
    schema_version: session.schema_version,
    session_id: session.session_id,
    phase: session.phase,
    active_task: session.active_task,
    task_class: session.task_class,
    turn_id: session.turn_id,
    instruction_manifest_hash: session.instruction_manifest_hash,
    provider_model: session.provider_model,
    provider_name: session.provider_name,
    workspace_revision: session.workspace_revision,
    budgets: { ...session.budgets },
    tools: {
      open_tool_call_ids: [...session.tools.open_tool_call_ids].sort(),
      completed_idempotency_keys: [...session.tools.completed_idempotency_keys].sort(),
      interrupted_idempotency_keys: [...session.tools.interrupted_idempotency_keys].sort(),
      last_tool_name: session.tools.last_tool_name,
    },
    verifier: { ...session.verifier },
    mutation: {
      ...session.mutation,
      last_paths: [...session.mutation.last_paths].sort(),
    },
    terminal: session.terminal
      ? { ...session.terminal, evidence_refs: [...session.terminal.evidence_refs].sort() }
      : undefined,
    compaction_count: session.compaction_count,
    policy_intervention_count: session.policy_intervention_count,
    last_seq: session.last_seq,
    evidence_event_ids: [...session.evidence_event_ids],
    degraded: session.degraded,
    degraded_reasons: [...session.degraded_reasons].sort(),
  });
  const left = normalize(a);
  const right = normalize(b);
  const mismatches: string[] = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) mismatches.push(key);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Forced-termination boundary labels for crash fixtures. */
export type CrashBoundary =
  | 'before_authorization'
  | 'after_authorization_before_effect'
  | 'during_effect'
  | 'after_effect_before_receipt'
  | 'after_receipt_before_projection'
  | 'mutation_prepare'
  | 'mutation_commit'
  | 'mutation_rollback'
  | 'before_verifier'
  | 'after_verifier'
  | 'during_compaction_persist'
  | 'before_terminal'
  | 'after_terminal';

/**
 * Slice session events to simulate forced termination at a boundary.
 * Used by crash fixtures — does not invent events.
 */
export function sliceSessionAtBoundary(
  log: SessionEventLog,
  boundary: CrashBoundary,
): SessionEvent[] {
  const events = [...log.events].sort((a, b) => a.seq - b.seq);
  const cut = (pred: (e: SessionEvent) => boolean): SessionEvent[] => {
    const idx = events.findIndex(pred);
    if (idx < 0) return [...events];
    return events.slice(0, idx);
  };

  switch (boundary) {
    case 'before_authorization':
      return [];
    case 'after_authorization_before_effect':
      return cut((e) => e.kind === 'tool_started' || e.kind === 'tool_proposed');
    case 'during_effect':
      return cut((e) =>
        e.kind === 'tool_completed' ||
        e.kind === 'tool_failed' ||
        e.kind === 'tool_cancelled',
      );
    case 'after_effect_before_receipt':
      return cut((e) => e.kind === 'mutation_batch' || e.kind === 'verifier_attempt');
    case 'after_receipt_before_projection':
      return cut((e) => e.kind === 'completion_decision' || e.kind === 'turn_ended');
    case 'mutation_prepare':
      return cut(
        (e) => e.kind === 'mutation_batch' && (e as { status?: string }).status === 'commit',
      );
    case 'mutation_commit':
      return cut(
        (e) => e.kind === 'mutation_batch' && (e as { status?: string }).status === 'commit',
      );
    case 'mutation_rollback':
      return cut(
        (e) => e.kind === 'mutation_batch' && (e as { status?: string }).status === 'rollback',
      );
    case 'before_verifier':
      return cut((e) => e.kind === 'verifier_attempt');
    case 'after_verifier':
      return cut((e) => e.kind === 'completion_decision');
    case 'during_compaction_persist':
      return cut((e) => e.kind === 'compaction_created');
    case 'before_terminal':
      return cut((e) => e.kind === 'completion_decision' || e.kind === 'turn_ended');
    case 'after_terminal':
      return events;
    default:
      return events;
  }
}
