/**
 * Pure task projection over runtime facts.
 *
 * P04. `projectTask` is a pure reducer: no model calls, no tools, no clock, no
 * filesystem, no UI. It separates execution state, turn state and the terminal
 * outcome, and it never invents a success. Only a `completion.decided` fact
 * whose envelope authority is `authoritative` may set an authoritative outcome;
 * `run.settled`/`turn_ended` stay observations.
 *
 * Determinism: facts are ordered by (sequence, id) within the fact budget, so
 * any input ordering of the admitted facts yields a deep-equal projection,
 * including every reported array. The node budget is content-deterministic; the
 * MAX_FACTS count cap applies to the consumed prefix (input-order dependent), so
 * the guarantee covers the admitted set.
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
import { types as utilTypes } from 'node:util';

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
  type FactPayload,
  type RuntimeFactProducer,
  type RuntimeFactV1,
} from './events.js';
import type { LegacyFactContext } from './legacyEventAdapters.js';
import { sessionLogToFacts } from './legacyEventAdapters.js';
import { canonicalize, cloneJsonSafe, codeUnitCompare, type CloneBudget } from './canonical.js';

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

/** SHA-256 over the canonical encoding of the whole envelope+payload. */
const CONTENT_KEY_CACHE = new WeakMap<object, string>();

function contentKey(fact: RuntimeFactV1): string {
  const cached = CONTENT_KEY_CACHE.get(fact);
  if (cached !== undefined) return cached;
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
    let encoded: string;
    if (canonical.ok) {
      encoded = JSON.stringify(canonical.value);
    } else {
      let payloadText = 'unserializable';
      try {
        payloadText = JSON.stringify(fact.payload) ?? 'unserializable';
      } catch {
        /* keep sentinel */
      }
      encoded = `malformed:${fact.id}:${fact.sequence}:${fact.timestamp}:${payloadText}`;
    }
    const key = createHash('sha256').update(encoded).digest('hex');
    CONTENT_KEY_CACHE.set(fact, key);
    return key;
  } catch {
    const key = createHash('sha256')
      .update(`inaccessible:${fact.id}:${fact.sequence}:${fact.timestamp}`)
      .digest('hex');
    CONTENT_KEY_CACHE.set(fact, key);
    return key;
  }
}

function compareSequences(a: number, b: number): number {
  if (Number.isFinite(a) && Number.isFinite(b)) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  // Non-finite sequences (or non-numbers) order by their canonical string so
  // the comparator is a total order and never returns NaN.
  return codeUnitCompare(String(a), String(b));
}

function orderedCompare(a: RuntimeFactV1, b: RuntimeFactV1): number {
  const bySequence = compareSequences(a.sequence, b.sequence);
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
  | { kind: 'known'; fact: RuntimeFactV1; nodes: number }
  | { kind: 'unknown_authority'; id?: string }
  | { kind: 'unknown_optional'; fact: RuntimeFactV1; nodes: number }
  | { kind: 'invalid'; id?: string; reason: string; authority: FactAuthority };

/** Deterministic cumulative budget applied over the sorted fact order. */
const MAX_TOTAL_JSON_NODES = 2_000_000;

interface EnvelopeRead {
  authorityRaw: unknown;
  idRaw: unknown;
  schemaVersion: unknown;
  payloadRaw: unknown;
  cursorStream: unknown;
  cursorSequence: unknown;
  sequence: unknown;
  threadId: unknown;
  taskId: unknown;
  turnId: unknown;
  runId: unknown;
  causationId: unknown;
  producer: unknown;
  timestamp: unknown;
}

/** Read one own data property without invoking a `get` trap. */
function readDataField(input: Record<string, unknown>, key: string): { ok: boolean; value: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) return { ok: false, value: undefined };
    if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      return { ok: false, value: undefined };
    }
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false, value: undefined };
  }
}

/**
 * Read every envelope and cursor field exactly once through property
 * descriptors, bypassing `[[Get]]`. A Proxy whose `get` trap is stateful but
 * whose `getOwnPropertyDescriptor` reports data therefore cannot make ordering
 * depend on read order; a missing/accessor field fails closed.
 */
function readEnvelopeFrom(
  input: Record<string, unknown>,
): { ok: boolean; read: EnvelopeRead | null } {
  if (utilTypes.isProxy(input)) return { ok: false, read: null };
  const fields = [
    'authority',
    'id',
    'schemaVersion',
    'payload',
    'sequence',
    'threadId',
    'taskId',
    'turnId',
    'runId',
    'causationId',
    'producer',
    'timestamp',
  ] as const;
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const result = readDataField(input, field);
    if (!result.ok) return { ok: false, read: null };
    values[field] = result.value;
  }
  const cursorResult = readDataField(input, 'cursor');
  if (!cursorResult.ok || !isRecord(cursorResult.value)) return { ok: false, read: null };
  if (utilTypes.isProxy(cursorResult.value)) return { ok: false, read: null };
  const streamResult = readDataField(cursorResult.value, 'stream');
  const sequenceResult = readDataField(cursorResult.value, 'sequence');
  if (!streamResult.ok || !sequenceResult.ok) return { ok: false, read: null };
  return {
    ok: true,
    read: {
      authorityRaw: values['authority'],
      idRaw: values['id'],
      schemaVersion: values['schemaVersion'],
      payloadRaw: values['payload'],
      cursorStream: streamResult.value,
      cursorSequence: sequenceResult.value,
      sequence: values['sequence'],
      threadId: values['threadId'],
      taskId: values['taskId'],
      turnId: values['turnId'],
      runId: values['runId'],
      causationId: values['causationId'],
      producer: values['producer'],
      timestamp: values['timestamp'],
    },
  };
}

/** Build a plain fact snapshot from values already read exactly once. */
function snapshotFact(read: EnvelopeRead, payload: FactPayload): RuntimeFactV1 {
  return {
    schemaVersion: RUNTIME_FACT_SCHEMA_VERSION,
    id: read.idRaw as string,
    cursor: { stream: 'runtime-facts', sequence: read.cursorSequence as number },
    threadId: read.threadId as string,
    taskId: read.taskId as string,
    turnId: read.turnId as string,
    runId: read.runId as string,
    sequence: read.sequence as number,
    causationId: read.causationId as string,
    producer: read.producer as RuntimeFactProducer,
    authority: read.authorityRaw as FactAuthority,
    timestamp: read.timestamp as string,
    payload,
  };
}

/** Classify one untrusted input from its descriptor-read envelope. */
function classifyInput(read: EnvelopeRead | null, accessible: boolean): Classified {
  if (read === null || !accessible) {
    return { kind: 'invalid', reason: 'inaccessible_fact', authority: 'authoritative' };
  }
  const authorityRaw = read.authorityRaw;
  const authorityKnown = authorityRaw === 'authoritative' || authorityRaw === 'observation';
  // A novel/absent authority token is treated as authority-bearing (fail closed).
  const authority: FactAuthority = authorityRaw === 'observation' ? 'observation' : 'authoritative';
  const id = typeof read.idRaw === 'string' ? read.idRaw : undefined;
  const withId = id !== undefined ? { id } : {};
  const schemaKnown = read.schemaVersion === RUNTIME_FACT_SCHEMA_VERSION;
  const payloadRaw = read.payloadRaw;
  const typeResult =
    isRecord(payloadRaw) && !utilTypes.isProxy(payloadRaw)
      ? readDataField(payloadRaw, 'type')
      : { ok: false, value: undefined };
  const type = typeResult.ok && typeof typeResult.value === 'string' ? typeResult.value : undefined;
  const typeKnown = type !== undefined && KNOWN_FACT_TYPES.has(type as never);

  const envelopeAccessible =
    typeof read.threadId === 'string' &&
    typeof read.taskId === 'string' &&
    typeof read.turnId === 'string' &&
    typeof read.runId === 'string' &&
    typeof read.causationId === 'string' &&
    typeof read.timestamp === 'string' &&
    typeof read.producer === 'string' &&
    Number.isInteger(read.sequence) &&
    read.cursorStream === 'runtime-facts' &&
    Number.isInteger(read.cursorSequence);

  if (!schemaKnown || !typeKnown) {
    if (!authorityKnown || authority === 'authoritative') {
      return { kind: 'unknown_authority', ...withId };
    }
    if (!envelopeAccessible) {
      return { kind: 'invalid', reason: 'inaccessible_envelope', authority, ...withId };
    }
    if (!isRecord(payloadRaw) || id === undefined) {
      return { kind: 'invalid', reason: 'invalid_optional_fact', authority, ...withId };
    }
    const budget: CloneBudget = { nodes: 0 };
    const cloned = cloneJsonSafe(payloadRaw, new WeakSet(), 0, budget);
    if (!cloned.ok) {
      return { kind: 'invalid', reason: 'unserializable_payload', authority, ...withId };
    }
    return {
      kind: 'unknown_optional',
      fact: snapshotFact(read, cloned.value as FactPayload),
      nodes: budget.nodes,
    };
  }

  if (!envelopeAccessible) {
    return { kind: 'invalid', reason: 'inaccessible_envelope', authority, ...withId };
  }
  const budget: CloneBudget = { nodes: 0 };
  const cloned = cloneJsonSafe(payloadRaw, new WeakSet(), 0, budget);
  if (!cloned.ok) {
    return { kind: 'invalid', reason: 'unserializable_payload', authority, ...withId };
  }
  // Validate the snapshot (plain data) rather than the caller's object, so a
  // stateful getter cannot pass validation and then mutate the snapshot.
  const snapshot = snapshotFact(read, cloned.value as FactPayload);
  const validation = validateRuntimeFact(snapshot);
  if (!validation.ok) {
    return { kind: 'invalid', reason: validation.reason, authority, ...withId };
  }
  return { kind: 'known', fact: snapshot, nodes: budget.nodes };
}

/**
 * Collapse facts by id in a stable order. A fact with the same id but a
 * different content key is corruption: it degrades and is dropped
 * deterministically (the order-first fact wins). Guarded so a corrupt snapshot
 * can never throw.
 */
function dedupeByFactId(facts: RuntimeFactV1[], state: TaskProjection): RuntimeFactV1[] {
  const byId = new Map<string, RuntimeFactV1>();
  const keyById = new Map<string, string>();
  for (const fact of [...facts].sort(orderedCompare)) {
    try {
      const identity = `${fact.sequence}\u0000${fact.id}`;
      const key = contentKey(fact);
      const prior = keyById.get(identity);
      if (prior === undefined) {
        byId.set(identity, fact);
        keyById.set(identity, key);
      } else if (prior !== key) {
        state.degradedReasons.push('conflicting_duplicate_fact');
      }
    } catch {
      state.degradedReasons.push('invalid_fact:dedupe_error');
    }
  }
  return [...byId.values()];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(codeUnitCompare);
}

/** Hard cap on the number of facts sharing one (sequence,id) key. */
const MAX_TIE_GROUP = 32;

/** Bound the number of facts consumed so an endless iterable cannot run forever. */
const MAX_FACTS = 100_000;

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

  // Group raw facts by their deterministic (sequence, id) key, sort the groups
  // by that key, then classify each group all-or-nothing under one cumulative
  // node budget. Acceptance and truncation therefore depend only on content,
  // never on the caller's input order; duplicates within a group resolve later
  // by the injective content key.
  const groups = new Map<
    string,
    Array<{ read: EnvelopeRead | null; seq: number | null; id: string; accessible: boolean }>
  >();
  let factCount = 0;
  try {
    for (const input of facts) {
      factCount += 1;
      if (factCount > MAX_FACTS) {
        state.degradedReasons.push('fact_count_exceeded');
        // The unread tail cannot be shown free of authority claims: fail closed.
        sawUnknownAuthority = true;
        break;
      }
      let read: EnvelopeRead | null = null;
      let accessible = false;
      if (isRecord(input)) {
        const result = readEnvelopeFrom(input);
        if (result.ok && result.read) {
          read = result.read;
          accessible = true;
        }
      }
      const seq =
        accessible && typeof read!.sequence === 'number' && Number.isFinite(read!.sequence)
          ? read!.sequence
          : null;
      const id = accessible && typeof read!.idRaw === 'string' ? read!.idRaw : '';
      const key = `${accessible ? (seq === null ? '~' : seq) : 'A'}\u0000${id}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push({ read, seq, id, accessible });
      else groups.set(key, [{ read, seq, id, accessible }]);
    }
  } catch {
    state.degradedReasons.push('fact_iteration_failed');
    // A truncated/aborted stream may have withheld authority claims: fail closed.
    sawUnknownAuthority = true;
  }

  const groupList = [...groups.values()];
  groupList.sort((a, b) => {
    const left = a[0]!;
    const right = b[0]!;
    if (left.seq !== right.seq) {
      if (left.seq === null) return 1;
      if (right.seq === null) return -1;
      return left.seq - right.seq;
    }
    const byId = codeUnitCompare(left.id, right.id);
    if (byId !== 0) return byId;
    // Total order even when sequence/id tie (e.g. null-sequence inaccessible
    // entries): accessible groups sort after inaccessible ones.
    if (left.accessible !== right.accessible) return left.accessible ? 1 : -1;
    return 0;
  });

  const demoteGroupAuthority = (
    group: Array<{ read: EnvelopeRead | null; id: string; accessible: boolean }>,
  ): void => {
    for (const entry of group) {
      const raw = entry.read ? entry.read.authorityRaw : undefined;
      // An inaccessible envelope is authority-bearing by the same rule the
      // classified path uses, so it must demote here too.
      if (!entry.accessible || raw !== 'observation') {
        sawUnknownAuthority = true;
        state.degradedReasons.push('unknown_authoritative_fact');
        if (entry.id) state.unknownAuthorityFactIds.push(entry.id);
      }
    }
  };

  let totalNodes = 0;
  for (let groupIndex = 0; groupIndex < groupList.length; groupIndex += 1) {
    const group = groupList[groupIndex]!;
    if (group.length > MAX_TIE_GROUP) {
      state.degradedReasons.push('tie_group_exceeded');
      demoteGroupAuthority(group);
      continue;
    }
    const members: Classified[] = [];
    let groupNodes = 0;
    let fits = true;
    for (const entry of group) {
      let classified: Classified;
      try {
        classified = classifyInput(entry.read, entry.accessible);
      } catch {
        classified = { kind: 'invalid', reason: 'inaccessible_fact', authority: 'authoritative' };
      }
      members.push(classified);
      if (classified.kind === 'known' || classified.kind === 'unknown_optional') {
        groupNodes += classified.nodes;
      }
      if (totalNodes + groupNodes > MAX_TOTAL_JSON_NODES) {
        fits = false;
        state.degradedReasons.push('projection_budget_exceeded');
        break;
      }
    }
    if (!fits) {
      // Fail closed for this and every subsequent group that will be excluded.
      for (let rest = groupIndex; rest < groupList.length; rest += 1) {
        demoteGroupAuthority(groupList[rest]!);
      }
      break;
    }
    totalNodes += groupNodes;
    for (const classified of members) {
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
  }

  const orderedKnown = dedupeByFactId(known, state);
  const orderedOptional = dedupeByFactId(optional, state);
  for (const fact of orderedOptional) state.unknownOptionalFactIds.push(fact.id);
  // A known and an unknown-optional fact sharing an id+sequence is still a
  // duplicate; flag it rather than letting both survive silently.
  const knownKeys = new Set(orderedKnown.map((fact) => `${fact.sequence}\u0000${fact.id}`));
  for (const fact of orderedOptional) {
    if (knownKeys.has(`${fact.sequence}\u0000${fact.id}`)) {
      state.degradedReasons.push('conflicting_duplicate_fact');
    }
  }

  const open = new Set<string>();
  const completed = new Set<string>();
  const interrupted = new Set<string>();
  let previousSequence: number | null = null;
  let terminalObserved = false;

  for (const fact of orderedKnown) {
    try {
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
        if (typeof payload.reason === 'string' && payload.reason.startsWith('mutation_')) {
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
      case 'completion.decided': {
        // Authority is monotonic: a later observation-authority completion may
        // not replace an already authoritative one.
        if (state.outcome?.authoritative === true && !assertAuthority) {
          break;
        }
        terminalObserved = true;
        state.phase = 'terminal';
        state.execution.state = 'settled';
        state.outcome = {
          outcome: payload.decision.finalOutcome as TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN',
          status: payload.decision.allowed ? 'allowed' : 'denied',
          reason: payload.decision.reason,
          evidenceRefs: Array.isArray(payload.decision.evidenceRefs)
            ? [...payload.decision.evidenceRefs]
            : [],
          authoritative: assertAuthority,
        };
        break;
      }
      case 'permission.decided':
        state.permissionDecisionCount += 1;
        break;
    }
    } catch {
      // A fact that throws mid-reduction is corrupt, not fatal to the reducer.
      state.degradedReasons.push('invalid_fact:projection_error');
      try {
        if (fact.authority === 'authoritative') {
          sawUnknownAuthority = true;
          state.degradedReasons.push('unknown_authoritative_fact');
        }
      } catch {
        /* snapshots are plain data; never let this escape if that ever changes */
      }
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
  let truncated = false;
  const callerOnTruncated = context.onTruncated;
  const facts = sessionLogToFacts(events, {
    ...context,
    onTruncated: () => {
      truncated = true;
      callerOnTruncated?.();
    },
  });
  const projection = projectTask(facts);
  if (!truncated) return projection;
  // The adapter withheld part of the stream, so the tail may claim authority:
  // fail closed exactly as the projection's own truncation paths do.
  projection.degraded = true;
  projection.degradedReasons = uniqueSorted([...projection.degradedReasons, 'legacy_adapter_truncated']);
  if (projection.outcome) projection.outcome = { ...projection.outcome, authoritative: false };
  projection.verifier = { ...projection.verifier, authoritative: false };
  return projection;
}
