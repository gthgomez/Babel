/**
 * Pure task projection over runtime facts.
 *
 * P04. `projectTask` is a pure reducer: no model calls, no tools, no clock, no
 * filesystem, no UI. It separates execution state, turn state and the terminal
 * outcome, and it never invents a success. Only `completion.decided` may set an
 * authoritative outcome; `run.settled`/`turn_ended` stay observations.
 *
 * View/UI projection remains separate. This module must not import `ui/` or
 * `interactive/` (enforced by `dependencyBoundary.test.ts`).
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';
import {
  RUNTIME_FACT_PROJECTION_VERSION,
  RUNTIME_FACT_SCHEMA_VERSION,
  type EventCursor,
  type RuntimeFactV1,
} from './events.js';
import type { LegacyFactContext } from './legacyEventAdapters.js';
import { sessionLogToFacts } from './legacyEventAdapters.js';
import type { SessionEvent } from '../agent/sessionEvents.js';

export type ProjectionPhase =
  | 'idle'
  | 'authorized'
  | 'effect_running'
  | 'effect_complete'
  | 'mutation'
  | 'verifying'
  | 'compacting'
  | 'terminal';

export interface ProjectionExecutionState {
  runId: string | null;
  ownerGeneration: number | null;
  state: 'idle' | 'running' | 'cancel_requested' | 'settled';
}

export interface ProjectionToolState {
  openOperationIds: string[];
  completedOperationIds: string[];
  interruptedOperationIds: string[];
}

export interface ProjectionVerifierState {
  attempts: number;
  authoritative: boolean;
  lastReceiptId?: string;
}

export interface ProjectionMutationState {
  lastOperationId?: string;
  lastStatus?: string;
}

export interface ProjectionOutcome {
  outcome: TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN';
  status: string;
  reason?: string;
  evidenceRefs: string[];
  /** True only when derived from an authoritative `completion.decided` fact. */
  authoritative: boolean;
}

export interface TaskProjection {
  schemaVersion: typeof RUNTIME_FACT_PROJECTION_VERSION;
  threadId: string;
  taskId: string;
  activeTurnId: string | null;
  phase: ProjectionPhase;
  execution: ProjectionExecutionState;
  tools: ProjectionToolState;
  verifier: ProjectionVerifierState;
  mutation: ProjectionMutationState;
  outcome: ProjectionOutcome | null;
  compactionCount: number;
  permissionDecisionCount: number;
  lastCursor: EventCursor | null;
  evidenceFactIds: string[];
  degraded: boolean;
  degradedReasons: string[];
  /** Ids of facts whose authority could not be interpreted (fail closed). */
  unknownAuthorityFactIds: string[];
}

function emptyProjection(threadId = '', taskId = ''): TaskProjection {
  return {
    schemaVersion: RUNTIME_FACT_PROJECTION_VERSION,
    threadId,
    taskId,
    activeTurnId: null,
    phase: 'idle',
    execution: { runId: null, ownerGeneration: null, state: 'idle' },
    tools: { openOperationIds: [], completedOperationIds: [], interruptedOperationIds: [] },
    verifier: { attempts: 0, authoritative: false },
    mutation: {},
    outcome: null,
    compactionCount: 0,
    permissionDecisionCount: 0,
    lastCursor: null,
    evidenceFactIds: [],
    degraded: false,
    degradedReasons: [],
    unknownAuthorityFactIds: [],
  };
}

/**
 * Pure reduction over facts. Duplicates collapse by fact id; gaps and unknown
 * authority-bearing schema degrade the projection instead of silently trusting
 * it. Reordering is normalized by cursor/sequence, not wall-clock time.
 */
export function projectTask(facts: Iterable<RuntimeFactV1>): TaskProjection {
  const byId = new Map<string, RuntimeFactV1>();
  const state = emptyProjection();

  for (const fact of facts) {
    if (fact.schemaVersion !== RUNTIME_FACT_SCHEMA_VERSION) {
      if (fact.authority === 'authoritative') {
        state.degraded = true;
        state.degradedReasons.push('unknown_authoritative_fact');
        state.unknownAuthorityFactIds.push(fact.id);
      } else {
        // Unknown optional/observation facts are preserved for evidence without
        // affecting projected state.
        state.evidenceFactIds.push(fact.id);
      }
      continue;
    }
    if (!byId.has(fact.id)) byId.set(fact.id, fact);
  }

  const ordered = [...byId.values()].sort((a, b) =>
    a.sequence === b.sequence ? a.id.localeCompare(b.id) : a.sequence - b.sequence,
  );

  const open = new Set<string>();
  const completed = new Set<string>();
  const interrupted = new Set<string>();
  let previousSequence: number | null = null;

  for (const fact of ordered) {
    if (previousSequence !== null && fact.sequence > previousSequence + 1) {
      state.degraded = true;
      state.degradedReasons.push('sequence_gap');
    }
    previousSequence = Math.max(previousSequence ?? fact.sequence, fact.sequence);

    state.evidenceFactIds.push(fact.id);
    if (state.lastCursor === null || fact.sequence >= state.lastCursor.sequence) {
      state.lastCursor = fact.cursor;
    }
    if (!state.threadId && fact.threadId) state.threadId = fact.threadId;
    if (!state.taskId && fact.taskId) state.taskId = fact.taskId;
    if (fact.turnId) state.activeTurnId = fact.turnId;
    if (fact.runId) state.execution.runId = fact.runId;

    const payload = fact.payload;
    switch (payload.type) {
      case 'turn.admitted':
        state.phase = 'authorized';
        break;
      case 'run.started':
        state.phase = 'authorized';
        state.execution.state = 'running';
        state.execution.ownerGeneration = payload.ownerGeneration;
        break;
      case 'run.cancel_requested':
        state.execution.state = 'cancel_requested';
        break;
      case 'run.settled':
        state.execution.state = 'settled';
        // Observation only: never overwrite an authoritative completion.
        if (state.outcome === null || !state.outcome.authoritative) {
          state.phase = 'terminal';
          state.outcome = {
            outcome: (payload.status as TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN') ?? 'UNKNOWN',
            status: payload.status,
            evidenceRefs: state.outcome?.evidenceRefs ?? [],
            authoritative: false,
          };
        }
        break;
      case 'operation.prepared':
        state.phase = 'effect_running';
        open.add(payload.operationId ?? payload.operationDigest);
        break;
      case 'operation.settled': {
        state.phase = 'effect_complete';
        const key = payload.operationId ?? payload.receiptId;
        open.delete(key);
        completed.add(key);
        if (/commit|prepare|rollback/.test(payload.status ?? '') || payload.status === undefined) {
          state.mutation = {
            lastOperationId: key,
            ...(payload.status !== undefined ? { lastStatus: payload.status } : {}),
          };
        }
        break;
      }
      case 'operation.indeterminate': {
        state.phase = 'effect_complete';
        const key = payload.operationId ?? payload.operationDigest;
        open.delete(key);
        interrupted.add(key);
        break;
      }
      case 'context.committed':
        state.phase = 'compacting';
        state.compactionCount += 1;
        break;
      case 'context.degraded':
        state.degraded = true;
        state.degradedReasons.push(`context_degraded:${payload.reason}`);
        break;
      case 'verification.recorded':
        state.phase = 'verifying';
        state.verifier.attempts += 1;
        state.verifier.authoritative = payload.authoritative;
        state.verifier.lastReceiptId = payload.receiptId;
        break;
      case 'completion.decided':
        state.phase = 'terminal';
        state.execution.state = 'settled';
        state.outcome = {
          outcome: payload.decision.finalOutcome as TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN',
          status: payload.decision.allowed ? 'allowed' : 'denied',
          reason: payload.decision.reason,
          evidenceRefs: [...payload.decision.evidenceRefs],
          authoritative: true,
        };
        break;
      case 'permission.decided':
        state.permissionDecisionCount += 1;
        break;
    }
  }

  // Unsettled operations become interruptions, never successes (H2/H11).
  for (const key of open) {
    if (!completed.has(key) && !interrupted.has(key)) interrupted.add(key);
  }

  state.tools = {
    openOperationIds: [...open],
    completedOperationIds: [...completed],
    interruptedOperationIds: [...interrupted],
  };
  // Unknown authority-bearing schema prevents a safe final interpretation:
  // never let an existing terminal claim authority while such a fact is present.
  if (state.unknownAuthorityFactIds.length > 0 && state.outcome) {
    state.outcome = { ...state.outcome, authoritative: false };
  }
  state.degradedReasons = [...new Set(state.degradedReasons)];
  return state;
}

/** Convenience: adapt durable session events and project them in one step. */
export function projectTaskFromSessionEvents(
  events: readonly SessionEvent[],
  context: LegacyFactContext = {},
): TaskProjection {
  return projectTask(sessionLogToFacts(events, context));
}
