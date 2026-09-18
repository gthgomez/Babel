/**
 * Pure task projection over runtime facts.
 *
 * P04. `projectTask` is a pure reducer: no model calls, no tools, no clock, no
 * filesystem, no UI. It separates execution state, turn state and the terminal
 * outcome, and it never invents a success. Only a `completion.decided` fact
 * whose envelope authority is `authoritative` may set an authoritative outcome;
 * `run.settled`/`turn_ended` stay observations.
 *
 * Determinism: facts are normalized by cursor sequence and id before reducing,
 * so duplicate/reordered input yields the same projection. Unknown
 * authority-bearing schema fails closed and demotes every authority claim
 * (outcome and verifier), not only the outcome.
 *
 * View/UI projection remains separate. This module must not import `ui/` or
 * `interactive/` (enforced by `dependencyBoundary.test.ts`).
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';
import type { SessionEvent } from '../agent/sessionEvents.js';
import {
  compareFactCursors,
  KNOWN_FACT_TYPES,
  RUNTIME_FACT_PROJECTION_VERSION,
  RUNTIME_FACT_SCHEMA_VERSION,
  validateRuntimeFact,
  type EventCursor,
  type FactAuthority,
  type RuntimeFactV1,
} from './events.js';
import type { LegacyFactContext } from './legacyEventAdapters.js';
import { sessionLogToFacts } from './legacyEventAdapters.js';

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
  /** Unknown observation/optional facts preserved for evidence. */
  unknownOptionalFactIds: string[];
  degraded: boolean;
  degradedReasons: string[];
  /** Ids of facts whose authority could not be interpreted (fail closed). */
  unknownAuthorityFactIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function emptyProjection(): TaskProjection {
  return {
    schemaVersion: RUNTIME_FACT_PROJECTION_VERSION,
    threadId: '',
    taskId: '',
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
    unknownOptionalFactIds: [],
    degraded: false,
    degradedReasons: [],
    unknownAuthorityFactIds: [],
  };
}

function codeUnitCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function payloadKey(fact: RuntimeFactV1): string {
  return JSON.stringify(fact.payload);
}

/** Total order over facts independent of input order. */
function orderedCompare(a: RuntimeFactV1, b: RuntimeFactV1): number {
  return (
    a.sequence - b.sequence ||
    codeUnitCompare(a.id, b.id) ||
    codeUnitCompare(payloadKey(a), payloadKey(b))
  );
}

type Classified =
  | { kind: 'known'; fact: RuntimeFactV1 }
  | { kind: 'unknown_authority'; id?: string }
  | { kind: 'unknown_optional'; fact: RuntimeFactV1 }
  | { kind: 'invalid'; id?: string; reason: string; authority: FactAuthority };

function classifyInput(input: unknown): Classified {
  if (!isRecord(input)) {
    return { kind: 'invalid', reason: 'fact_not_object', authority: 'authoritative' };
  }
  const authority: FactAuthority =
    input['authority'] === 'authoritative' ? 'authoritative' : 'observation';
  const id = typeof input['id'] === 'string' ? input['id'] : undefined;
  const schemaKnown = input['schemaVersion'] === RUNTIME_FACT_SCHEMA_VERSION;
  const payload = input['payload'];
  const type = isRecord(payload) && typeof payload['type'] === 'string' ? payload['type'] : undefined;
  const typeKnown = type !== undefined && KNOWN_FACT_TYPES.has(type as never);

  if (!schemaKnown || !typeKnown) {
    if (authority === 'authoritative') {
      return { kind: 'unknown_authority', ...(id !== undefined ? { id } : {}) };
    }
    if (id !== undefined) {
      return { kind: 'unknown_optional', fact: input as unknown as RuntimeFactV1 };
    }
    return {
      kind: 'invalid',
      reason: typeKnown ? 'invalid_fact_identity' : 'unknown_fact_type',
      authority,
    };
  }

  const validation = validateRuntimeFact(input);
  if (!validation.ok) {
    return {
      kind: 'invalid',
      reason: validation.reason,
      authority,
      ...(id !== undefined ? { id } : {}),
    };
  }
  return { kind: 'known', fact: validation.fact };
}

/**
 * Pure reduction over facts. Validation runs at this boundary; duplicates
 * collapse by fact id (conflicting content degrades), reordering is normalized
 * by a total order, gaps degrade, and unknown authority schema fails closed.
 */
export function projectTask(facts: Iterable<RuntimeFactV1>): TaskProjection {
  const state = emptyProjection();
  const known: RuntimeFactV1[] = [];
  const optional: RuntimeFactV1[] = [];

  for (const input of facts) {
    const classified = classifyInput(input);
    switch (classified.kind) {
      case 'known':
        known.push(classified.fact);
        break;
      case 'unknown_authority':
        state.degraded = true;
        state.degradedReasons.push('unknown_authoritative_fact');
        if (classified.id !== undefined) state.unknownAuthorityFactIds.push(classified.id);
        break;
      case 'unknown_optional':
        optional.push(classified.fact);
        break;
      case 'invalid':
        state.degraded = true;
        state.degradedReasons.push(`invalid_fact:${classified.reason}`);
        if (classified.authority === 'authoritative') {
          state.degradedReasons.push('unknown_authoritative_fact');
          if (classified.id !== undefined) state.unknownAuthorityFactIds.push(classified.id);
        }
        break;
    }
  }

  const orderedKnown = dedupeByFactId(known, state);
  const orderedOptional = dedupeByFactId(optional, state);
  for (const fact of orderedOptional) state.unknownOptionalFactIds.push(fact.id);

  const open = new Set<string>();
  const completed = new Set<string>();
  const interrupted = new Set<string>();
  let previousSequence: number | null = null;
  let terminalObserved = false;

  for (const fact of orderedKnown) {
    if (previousSequence !== null && fact.sequence > previousSequence + 1) {
      state.degraded = true;
      state.degradedReasons.push('sequence_gap');
    }
    previousSequence = Math.max(previousSequence ?? fact.sequence, fact.sequence);

    state.evidenceFactIds.push(fact.id);
    if (state.lastCursor === null || compareFactCursors(fact.cursor, state.lastCursor) > 0) {
      state.lastCursor = fact.cursor;
    }
    if (!state.threadId && fact.threadId) state.threadId = fact.threadId;
    if (!state.taskId && fact.taskId) state.taskId = fact.taskId;
    if (fact.turnId) state.activeTurnId = fact.turnId;
    if (fact.runId) state.execution.runId = fact.runId;

    const setPhase = (phase: ProjectionPhase): void => {
      if (!terminalObserved) state.phase = phase;
    };
    const assertAuthority = fact.authority === 'authoritative';
    const payload = fact.payload;

    switch (payload.type) {
      case 'turn.admitted':
        setPhase('authorized');
        break;
      case 'run.started':
        setPhase('authorized');
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
          setPhase('terminal');
          state.outcome = {
            outcome: (payload.status as TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN') ?? 'UNKNOWN',
            status: payload.status,
            evidenceRefs: state.outcome?.evidenceRefs ?? [],
            authoritative: false,
          };
        }
        break;
      case 'operation.prepared':
        setPhase('effect_running');
        open.add(payload.operationId ?? payload.operationDigest);
        break;
      case 'operation.settled': {
        setPhase('effect_complete');
        const key = payload.operationId ?? payload.receiptId;
        open.delete(key);
        completed.add(key);
        state.mutation = {
          lastOperationId: key,
          ...(payload.status !== undefined ? { lastStatus: payload.status } : {}),
        };
        break;
      }
      case 'operation.indeterminate': {
        setPhase('effect_complete');
        const key = payload.operationId ?? payload.operationDigest;
        open.delete(key);
        interrupted.add(key);
        if (payload.reason.startsWith('mutation_')) {
          state.mutation = { lastOperationId: key, lastStatus: payload.reason };
        }
        break;
      }
      case 'context.committed':
        setPhase('compacting');
        state.compactionCount += 1;
        break;
      case 'context.degraded':
        state.degraded = true;
        state.degradedReasons.push(`context_degraded:${payload.reason}`);
        break;
      case 'verification.recorded':
        setPhase('verifying');
        state.verifier.attempts += 1;
        state.verifier.authoritative = assertAuthority && payload.authoritative;
        state.verifier.lastReceiptId = payload.receiptId;
        break;
      case 'completion.decided':
        state.phase = 'terminal';
        terminalObserved = true;
        state.execution.state = 'settled';
        state.outcome = {
          outcome: payload.decision.finalOutcome as TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN',
          status: payload.decision.allowed ? 'allowed' : 'denied',
          reason: payload.decision.reason,
          evidenceRefs: [...payload.decision.evidenceRefs],
          authoritative: assertAuthority,
        };
        break;
      case 'permission.decided':
        state.permissionDecisionCount += 1;
        break;
    }
  }

  // Evidence chain includes preserved unknown optional facts, in the same
  // deterministic order as known facts.
  const evidence = [...orderedKnown, ...orderedOptional].sort(orderedCompare);
  state.evidenceFactIds = evidence.map((fact) => fact.id);

  // Unsettled operations become interruptions, never successes (H2/H11).
  for (const key of open) {
    if (!completed.has(key) && !interrupted.has(key)) interrupted.add(key);
  }

  state.tools = {
    openOperationIds: [...open],
    completedOperationIds: [...completed],
    interruptedOperationIds: [...interrupted],
  };

  if (terminalObserved) state.phase = 'terminal';

  // Unknown authority-bearing schema prevents any authority claim, including
  // the verifier badge, not only the outcome.
  if (state.unknownAuthorityFactIds.length > 0) {
    if (state.outcome) state.outcome = { ...state.outcome, authoritative: false };
    state.verifier = { ...state.verifier, authoritative: false };
  }

  state.degradedReasons = [...new Set(state.degradedReasons)];
  state.unknownAuthorityFactIds = [...new Set(state.unknownAuthorityFactIds)];
  return state;
}

/**
 * Collapse facts by id in a stable order. A later fact with the same id but a
 * different payload is corruption: it degrades the projection and is dropped.
 */
function dedupeByFactId(facts: RuntimeFactV1[], state: TaskProjection): RuntimeFactV1[] {
  const byId = new Map<string, RuntimeFactV1>();
  const payloadById = new Map<string, string>();
  for (const fact of [...facts].sort(orderedCompare)) {
    const prior = payloadById.get(fact.id);
    if (prior === undefined) {
      byId.set(fact.id, fact);
      payloadById.set(fact.id, payloadKey(fact));
    } else if (prior !== payloadKey(fact)) {
      state.degraded = true;
      state.degradedReasons.push('conflicting_duplicate_fact');
    }
  }
  return [...byId.values()];
}

/** Convenience: adapt durable session events and project them in one step. */
export function projectTaskFromSessionEvents(
  events: readonly SessionEvent[],
  context: LegacyFactContext = {},
): TaskProjection {
  return projectTask(sessionLogToFacts(events, context));
}
