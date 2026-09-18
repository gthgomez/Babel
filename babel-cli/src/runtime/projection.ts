/**
 * Pure task projection over runtime facts.
 *
 * P04. `projectTask` is a pure reducer: no model calls, no tools, no clock, no
 * filesystem, no UI. It separates execution state, turn state and the terminal
 * outcome, and it never invents a success. Only a `completion.decided` fact
 * whose envelope authority is `authoritative` may set an authoritative outcome;
 * `run.settled`/`turn_ended` stay observations.
 *
 * Determinism: facts are normalized by an injective content key (SHA-256 over a
 * canonical encoding that distinguishes NaN/Infinity/-0/undefined) and ordered
 * by (sequence, contentKey), so any input ordering of duplicates/reordered
 * facts yields a deep-equal projection, including every reported array.
 *
 * Fail closed: an unknown-authority-bearing fact — including one with no id, a
 * novel authority token, or a non-object entry — sets a boolean that demotes
 * BOTH `outcome.authoritative` and `verifier.authoritative`. Malformed or
 * non-serializable payloads, hostile getters, and revoked proxies degrade
 * instead of throwing; `projectTask` is total.
 *
 * View/UI projection remains separate. This module must not import `ui/` or
 * `interactive/` (enforced by `dependencyBoundary.test.ts`).
 */

import { createHash } from 'node:crypto';

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

function codeUnitCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

type Canonical = unknown;
type CanonicalResult = { ok: true; value: Canonical } | { ok: false };

/**
 * Injective canonical encoding. Distinguishes values JSON collapses or cannot
 * represent (NaN, ±Infinity, -0, undefined, BigInt, Map/Set/Date) and rejects
 * functions, symbols, true cycles and inaccessible objects. `path` is a
 * recursion stack, so a shared non-cyclic reference is valid.
 */
function canonicalize(value: unknown, path: WeakSet<object>): CanonicalResult {
  if (value === null) return { ok: true, value: null };
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return { ok: true, value };
  if (type === 'number') {
    if (Number.isNaN(value)) return { ok: true, value: { $number: 'NaN' } };
    if (value === Infinity) return { ok: true, value: { $number: 'Infinity' } };
    if (value === -Infinity) return { ok: true, value: { $number: '-Infinity' } };
    if (Object.is(value, -0)) return { ok: true, value: { $number: '-0' } };
    return { ok: true, value };
  }
  if (type === 'undefined') return { ok: true, value: { $undefined: true } };
  if (type === 'bigint') return { ok: true, value: { $bigint: (value as bigint).toString() } };
  if (type === 'function' || type === 'symbol') return { ok: false };

  const object = value as object;
  if (path.has(object)) return { ok: false };
  path.add(object);
  try {
    if (object instanceof Date) return { ok: true, value: { $date: object.toISOString() } };
    if (object instanceof Map) {
      const entries: unknown[] = [];
      for (const [key, entry] of object.entries()) {
        const canonicalKey = canonicalize(key, path);
        if (!canonicalKey.ok) return { ok: false };
        const canonicalValue = canonicalize(entry, path);
        if (!canonicalValue.ok) return { ok: false };
        entries.push([canonicalKey.value, canonicalValue.value]);
      }
      return { ok: true, value: { $map: entries } };
    }
    if (object instanceof Set) {
      const entries: unknown[] = [];
      for (const entry of object.values()) {
        const canonical = canonicalize(entry, path);
        if (!canonical.ok) return { ok: false };
        entries.push(canonical.value);
      }
      return { ok: true, value: { $set: entries } };
    }
    if (Array.isArray(object)) {
      const entries: unknown[] = [];
      for (const entry of object) {
        const canonical = canonicalize(entry, path);
        if (!canonical.ok) return { ok: false };
        entries.push(canonical.value);
      }
      return { ok: true, value: entries };
    }
    const record = object as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(codeUnitCompare)) {
      const canonical = canonicalize(record[key], path);
      if (!canonical.ok) return { ok: false };
      out[key] = canonical.value;
    }
    return { ok: true, value: out };
  } catch {
    return { ok: false };
  } finally {
    path.delete(object);
  }
}

/** SHA-256 over the canonical encoding of the whole envelope+payload. */
function contentKey(fact: RuntimeFactV1): string {
  try {
    const canonical = canonicalize(
      [
        fact.sequence,
        fact.id,
        fact.authority,
        fact.producer,
        fact.threadId,
        fact.taskId,
        fact.turnId,
        fact.runId,
        fact.causationId,
        fact.timestamp,
        fact.cursor.stream,
        fact.cursor.sequence,
        fact.payload,
      ],
      new WeakSet(),
    );
    const encoded = canonical.ok ? JSON.stringify(canonical.value) : 'malformed';
    return createHash('sha256').update(encoded).digest('hex');
  } catch {
    // Only reachable for a fact whose envelope accessors throw after
    // classification; such facts are rejected earlier, so this is a guard.
    return 'inaccessible';
  }
}

/** Read every envelope field once so a hostile accessor fails classification. */
function hasAccessibleEnvelope(input: Record<string, unknown>): boolean {
  try {
    const cursor = input['cursor'];
    return (
      typeof input['threadId'] === 'string' &&
      typeof input['taskId'] === 'string' &&
      typeof input['turnId'] === 'string' &&
      typeof input['runId'] === 'string' &&
      typeof input['causationId'] === 'string' &&
      typeof input['timestamp'] === 'string' &&
      typeof input['producer'] === 'string' &&
      typeof input['sequence'] === 'number' &&
      isRecord(cursor) &&
      typeof cursor['stream'] === 'string' &&
      typeof cursor['sequence'] === 'number'
    );
  } catch {
    return false;
  }
}

function orderedCompare(a: RuntimeFactV1, b: RuntimeFactV1): number {
  const bySequence = a.sequence - b.sequence;
  if (bySequence !== 0) return bySequence;
  return codeUnitCompare(contentKey(a), contentKey(b));
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

type Classified =
  | { kind: 'known'; fact: RuntimeFactV1 }
  | { kind: 'unknown_authority'; id?: string }
  | { kind: 'unknown_optional'; fact: RuntimeFactV1 }
  | { kind: 'invalid'; id?: string; reason: string; authority: FactAuthority };

/** Classify one untrusted input. May throw only on hostile accessors; callers guard. */
function classifyInput(input: unknown): Classified {
  if (!isRecord(input)) {
    return { kind: 'invalid', reason: 'fact_not_object', authority: 'authoritative' };
  }
  const authorityRaw = input['authority'];
  const authorityKnown = authorityRaw === 'authoritative' || authorityRaw === 'observation';
  // A novel/absent authority token is treated as authority-bearing (fail closed).
  const authority: FactAuthority = authorityRaw === 'observation' ? 'observation' : 'authoritative';
  const id = typeof input['id'] === 'string' ? input['id'] : undefined;
  const withId = id !== undefined ? { id } : {};
  const schemaKnown = input['schemaVersion'] === RUNTIME_FACT_SCHEMA_VERSION;
  const payload = input['payload'];
  const type = isRecord(payload) && typeof payload['type'] === 'string' ? payload['type'] : undefined;
  const typeKnown = type !== undefined && KNOWN_FACT_TYPES.has(type as never);

  if (!schemaKnown || !typeKnown) {
    if (!authorityKnown || authority === 'authoritative') {
      return { kind: 'unknown_authority', ...withId };
    }
    if (!hasAccessibleEnvelope(input)) {
      return { kind: 'invalid', reason: 'inaccessible_envelope', authority, ...withId };
    }
    if (!isRecord(payload) || id === undefined) {
      return { kind: 'invalid', reason: 'invalid_optional_fact', authority, ...withId };
    }
    if (!canonicalize(payload, new WeakSet()).ok) {
      return { kind: 'invalid', reason: 'unserializable_payload', authority, ...withId };
    }
    return { kind: 'unknown_optional', fact: input as unknown as RuntimeFactV1 };
  }

  const validation = validateRuntimeFact(input);
  if (!validation.ok) {
    return { kind: 'invalid', reason: validation.reason, authority, ...withId };
  }
  if (!canonicalize(validation.fact.payload, new WeakSet()).ok) {
    return { kind: 'invalid', reason: 'unserializable_payload', authority, ...withId };
  }
  return { kind: 'known', fact: validation.fact };
}

/**
 * Collapse facts by id in a stable order. A fact with the same id but a
 * different content key is corruption: it degrades and is dropped
 * deterministically (the order-first fact wins).
 */
function dedupeByFactId(facts: RuntimeFactV1[], state: TaskProjection): RuntimeFactV1[] {
  const byId = new Map<string, RuntimeFactV1>();
  const keyById = new Map<string, string>();
  for (const fact of [...facts].sort(orderedCompare)) {
    const key = contentKey(fact);
    const prior = keyById.get(fact.id);
    if (prior === undefined) {
      byId.set(fact.id, fact);
      keyById.set(fact.id, key);
    } else if (prior !== key) {
      state.degradedReasons.push('conflicting_duplicate_fact');
    }
  }
  return [...byId.values()];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(codeUnitCompare);
}

/**
 * Pure reduction over facts. Validation runs at this boundary; duplicates
 * collapse by fact id (conflicting content degrades), reordering is normalized
 * by an injective total order, gaps degrade, and unknown authority fails closed.
 */
export function projectTask(facts: Iterable<RuntimeFactV1>): TaskProjection {
  const state = emptyProjection();
  const known: RuntimeFactV1[] = [];
  const optional: RuntimeFactV1[] = [];
  let sawUnknownAuthority = false;

  try {
    for (const input of facts) {
      let classified: Classified;
      try {
        classified = classifyInput(input);
      } catch {
        classified = { kind: 'invalid', reason: 'inaccessible_fact', authority: 'authoritative' };
      }
      switch (classified.kind) {
        case 'known':
          known.push(classified.fact);
          break;
        case 'unknown_authority':
          sawUnknownAuthority = true;
          state.degradedReasons.push('unknown_authoritative_fact');
          if (classified.id !== undefined) state.unknownAuthorityFactIds.push(classified.id);
          break;
        case 'unknown_optional':
          optional.push(classified.fact);
          break;
        case 'invalid':
          state.degradedReasons.push(`invalid_fact:${classified.reason}`);
          if (classified.authority === 'authoritative') {
            sawUnknownAuthority = true;
            state.degradedReasons.push('unknown_authoritative_fact');
            if (classified.id !== undefined) state.unknownAuthorityFactIds.push(classified.id);
          }
          break;
      }
    }
  } catch {
    state.degradedReasons.push('fact_iteration_failed');
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
      state.degradedReasons.push('sequence_gap');
    }
    previousSequence = Math.max(previousSequence ?? fact.sequence, fact.sequence);

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
          terminalObserved = true;
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
        state.degradedReasons.push(`context_degraded:${payload.reason}`);
        break;
      case 'verification.recorded':
        setPhase('verifying');
        state.verifier.attempts += 1;
        state.verifier.authoritative = assertAuthority && payload.authoritative;
        state.verifier.lastReceiptId = payload.receiptId;
        break;
      case 'completion.decided':
        terminalObserved = true;
        state.phase = 'terminal';
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

  const evidenceIds: string[] = [];
  const seenEvidence = new Set<string>();
  for (const fact of [...orderedKnown, ...orderedOptional].sort(orderedCompare)) {
    if (!seenEvidence.has(fact.id)) {
      seenEvidence.add(fact.id);
      evidenceIds.push(fact.id);
    }
  }
  state.evidenceFactIds = evidenceIds;

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

  // An unknown/novel/absent authority signal prevents ANY authority claim,
  // including the verifier badge — driven by a boolean, never by the id list.
  if (sawUnknownAuthority) {
    if (state.outcome) state.outcome = { ...state.outcome, authoritative: false };
    state.verifier = { ...state.verifier, authoritative: false };
  }

  state.degraded = state.degradedReasons.length > 0;
  state.degradedReasons = uniqueSorted(state.degradedReasons);
  state.unknownAuthorityFactIds = uniqueSorted(state.unknownAuthorityFactIds);
  state.unknownOptionalFactIds = uniqueSorted(state.unknownOptionalFactIds);
  return state;
}

/** Convenience: adapt durable session events and project them in one step. */
export function projectTaskFromSessionEvents(
  events: readonly SessionEvent[],
  context: LegacyFactContext = {},
): TaskProjection {
  return projectTask(sessionLogToFacts(events, context));
}
