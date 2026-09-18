/**
 * Runtime facts v1 — a versioned semantic event contract.
 *
 * P04 defines the durable-fact vocabulary and a pure projection boundary
 * *without* replacing any historical store. Facts are a shadow model: existing
 * thread/session/episode readers remain authoritative until parity is proven
 * (P05 owns durable admission; P21 retires duplicate producers).
 *
 * Distinct from:
 *   - wire `TurnEventParams.seq` (per-turn, ephemeral),
 *   - history `cursor` (a `cell_id`),
 *   - `sessionEvents.nextSeq` / `LiveSessionV1.last_seq`.
 * `EventCursor` is its own address space.
 *
 * Never executes tools, replays provider calls, or re-derives authority.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';

/** Version of the runtime-fact event schema. */
export const RUNTIME_FACT_SCHEMA_VERSION = 1 as const;

/** Version of the pure task projection derived from facts. */
export const RUNTIME_FACT_PROJECTION_VERSION = 1 as const;

/** Durable fact stream identity. */
export type RuntimeFactStream = 'runtime-facts';

/**
 * Opaque position in a fact stream. Deliberately not interchangeable with the
 * protocol `seq`, a history `cell_id` cursor, or a session-event `seq`.
 */
export interface EventCursor {
  readonly stream: RuntimeFactStream;
  readonly sequence: number;
}

/** Producer class of a fact. Observations never mint authority. */
export type RuntimeFactProducer =
  | 'runtime_coordinator'
  | 'chat_engine'
  | 'pipeline'
  | 'legacy_adapter';

/** Whether a fact carries authority or is an observation. */
export type FactAuthority = 'authoritative' | 'observation';

/**
 * Semantic payload union. Payloads carry execution/turn identity so a reducer
 * never has to infer it, but they never contain a raw secret.
 */
export type FactPayload =
  | { readonly type: 'turn.admitted'; readonly commandId: string; readonly snapshotId?: string }
  | { readonly type: 'run.started'; readonly ownerGeneration: number }
  | { readonly type: 'run.cancel_requested'; readonly commandId?: string }
  | {
      readonly type: 'run.settled';
      /** Terminal status observed at the run boundary (not itself authority). */
      readonly status: string;
    }
  | {
      readonly type: 'operation.prepared';
      readonly operationDigest: string;
      readonly operationId?: string;
      readonly toolName?: string;
      readonly effectClass?: string;
    }
  | {
      readonly type: 'operation.settled';
      readonly receiptId: string;
      readonly operationId?: string;
      readonly status?: string;
    }
  | {
      readonly type: 'operation.indeterminate';
      readonly operationDigest: string;
      readonly reason: string;
      readonly operationId?: string;
    }
  | { readonly type: 'context.committed'; readonly checkpointId: string }
  | { readonly type: 'context.degraded'; readonly reason: string }
  | { readonly type: 'verification.recorded'; readonly receiptId: string; readonly authoritative: boolean }
  | { readonly type: 'completion.decided'; readonly decision: RuntimeCompletionDecision }
  | {
      readonly type: 'permission.decided';
      readonly decision: 'allow' | 'ask' | 'deny';
      readonly reason?: string;
    };

/** Minimal completion decision mirrored from the executor contract (no new authority). */
export interface RuntimeCompletionDecision {
  readonly requestedOutcome: string;
  readonly finalOutcome: string;
  readonly allowed: boolean;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly policyVersion: string;
}

/** Durable semantic fact envelope. */
export interface RuntimeFactV1 {
  readonly schemaVersion: typeof RUNTIME_FACT_SCHEMA_VERSION;
  readonly id: string;
  readonly cursor: EventCursor;
  /** Thread/session identity the fact belongs to. */
  readonly threadId: string;
  /** Task identity; empty when the surface has not frozen a task. */
  readonly taskId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly causationId: string;
  readonly producer: RuntimeFactProducer;
  readonly authority: FactAuthority;
  readonly timestamp: string;
  readonly payload: FactPayload;
}

/** Fact payload types this schema understands. */
export const KNOWN_FACT_TYPES: ReadonlySet<FactPayload['type']> = new Set([
  'turn.admitted',
  'run.started',
  'run.cancel_requested',
  'run.settled',
  'operation.prepared',
  'operation.settled',
  'operation.indeterminate',
  'context.committed',
  'context.degraded',
  'verification.recorded',
  'completion.decided',
  'permission.decided',
]);

/**
 * Fact types that may carry authority. `run.settled` is deliberately excluded:
 * only `completion.decided` is the authoritative terminal fact (one producer).
 */
export const AUTHORITATIVE_FACT_TYPES: ReadonlySet<string> = new Set([
  'completion.decided',
  'verification.recorded',
]);

export type FactTypeClassification = FactAuthority | 'unknown';

/** Classify a payload type, including unknown types from a newer schema. */
export function classifyFactType(type: string): FactTypeClassification {
  if (!KNOWN_FACT_TYPES.has(type as FactPayload['type'])) return 'unknown';
  return AUTHORITATIVE_FACT_TYPES.has(type) ? 'authoritative' : 'observation';
}

export interface ValidatedFact {
  readonly ok: true;
  readonly fact: RuntimeFactV1;
}
export interface InvalidFact {
  readonly ok: false;
  readonly reason: string;
  /** Whether the rejected fact claimed authority (fail closed). */
  readonly authority: FactAuthority;
  readonly id?: string;
}
export type FactValidation = ValidatedFact | InvalidFact;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Required payload fields per fact type, used for ingress validation. */
const REQUIRED_PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  'turn.admitted': ['commandId'],
  'run.started': ['ownerGeneration'],
  'run.cancel_requested': [],
  'run.settled': ['status'],
  'operation.prepared': ['operationDigest'],
  'operation.settled': ['receiptId'],
  'operation.indeterminate': ['operationDigest', 'reason'],
  'context.committed': ['checkpointId'],
  'context.degraded': ['reason'],
  'verification.recorded': ['receiptId', 'authoritative'],
  'completion.decided': ['decision'],
  'permission.decided': ['decision'],
};

/**
 * Validate an untrusted fact at ingress. Unknown authority-bearing schema is
 * rejected fail-closed; unknown observation schema may be preserved by callers.
 */
export function validateRuntimeFact(input: unknown): FactValidation {
  if (!isRecord(input)) {
    return { ok: false, reason: 'fact_not_object', authority: 'authoritative' };
  }
  const authorityRaw = input['authority'];
  const authority: FactAuthority = authorityRaw === 'observation' ? 'observation' : 'authoritative';
  const id = typeof input['id'] === 'string' ? input['id'] : undefined;
  const fail = (reason: string): InvalidFact => ({
    ok: false,
    reason,
    authority,
    ...(id !== undefined ? { id } : {}),
  });

  if (authorityRaw !== 'authoritative' && authorityRaw !== 'observation') {
    return fail('invalid_authority');
  }
  if (input['schemaVersion'] !== RUNTIME_FACT_SCHEMA_VERSION) {
    return fail(`unsupported_fact_schema:${String(input['schemaVersion'])}`);
  }
  for (const field of ['id', 'threadId', 'taskId', 'turnId', 'runId', 'causationId', 'timestamp', 'producer']) {
    if (typeof input[field] !== 'string') return fail(`missing_${field}`);
  }
  if (typeof input['sequence'] !== 'number' || !Number.isInteger(input['sequence'])) {
    return fail('invalid_sequence');
  }
  const cursor = input['cursor'];
  if (
    !isRecord(cursor) ||
    cursor['stream'] !== 'runtime-facts' ||
    typeof cursor['sequence'] !== 'number' ||
    !Number.isInteger(cursor['sequence'])
  ) {
    return fail('invalid_cursor');
  }
  const payload = input['payload'];
  if (!isRecord(payload) || typeof payload['type'] !== 'string') {
    return fail('invalid_payload');
  }
  const type = payload['type'];
  if (!KNOWN_FACT_TYPES.has(type as FactPayload['type'])) {
    return fail(`unknown_fact_type:${type}`);
  }
  for (const field of REQUIRED_PAYLOAD_FIELDS[type] ?? []) {
    if (payload[field] === undefined || payload[field] === null) {
      return fail(`payload_missing_${field}`);
    }
  }
  if (type === 'completion.decided') {
    const decision = payload['decision'];
    if (
      !isRecord(decision) ||
      typeof decision['finalOutcome'] !== 'string' ||
      typeof decision['allowed'] !== 'boolean' ||
      !Array.isArray(decision['evidenceRefs']) ||
      !decision['evidenceRefs'].every((entry) => typeof entry === 'string') ||
      typeof decision['reason'] !== 'string'
    ) {
      return fail('invalid_completion_decision');
    }
  }
  if (type === 'operation.indeterminate' || type === 'context.degraded') {
    if (typeof payload['reason'] !== 'string') {
      return fail(`invalid_${type}_reason`);
    }
  }
  if (type === 'verification.recorded' && typeof payload['authoritative'] !== 'boolean') {
    return fail('invalid_verification_authoritative');
  }
  return { ok: true, fact: input as unknown as RuntimeFactV1 };
}

const SECRET_KEY_PATTERN = /(pass(word)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key)/i;
const MAX_STRING_CHARS = 512;
const MAX_REDACT_DEPTH = 12;

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_REDACT_DEPTH) return '[redacted:depth]';
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    // Past the depth budget we cannot safety-scan keys, so redact wholesale
    // rather than returning a nested object that may hold a credential.
    if (depth >= MAX_REDACT_DEPTH) return '[redacted:depth]';
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/** Redact a fact for persistence or publication. Never weakens authority. */
export function redactRuntimeFact(fact: RuntimeFactV1): RuntimeFactV1 {
  return {
    ...fact,
    payload: redactValue(fact.payload) as FactPayload,
  };
}

/** Order two cursors; negative when `a` precedes `b`. */
export function compareFactCursors(a: EventCursor, b: EventCursor): number {
  if (a.stream !== b.stream) return a.stream < b.stream ? -1 : 1;
  return a.sequence - b.sequence;
}

/** Whether `later` is strictly newer than `earlier` within the same stream. */
export function isFactAfter(later: EventCursor, earlier: EventCursor): boolean {
  return later.stream === earlier.stream && later.sequence > earlier.sequence;
}

// ─── Ephemeral stream envelope ──────────────────────────────────────────────

/**
 * Ephemeral, non-durable delta (e.g. a model token chunk). Ephemeral data may
 * drive client animation but never authorizes state or completion.
 */
export interface EphemeralStreamEnvelope<T = unknown> {
  readonly kind: 'ephemeral';
  readonly threadId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly payload: T;
}

export function makeEphemeralEvent<T>(input: {
  threadId: string;
  turnId: string;
  sequence: number;
  payload: T;
}): EphemeralStreamEnvelope<T> {
  return { kind: 'ephemeral', ...input };
}

// ─── Bounded fact bus ───────────────────────────────────────────────────────

export interface FactBusSubscription {
  readonly id: number;
  drain(): void;
  queued(): number;
  dropped(): number;
  close(): void;
}

export interface FactBus {
  subscribe(handler: (fact: RuntimeFactV1) => void): FactBusSubscription;
  publish(fact: RuntimeFactV1): void;
  subscriberCount(): number;
}

/**
 * Bounded in-memory observation bus. Slow subscribers drop the oldest queued
 * facts instead of holding the process alive; `dropped()` is observable.
 */
export function createFactBus(options: { maxQueue?: number } = {}): FactBus {
  const maxQueue = Math.max(1, options.maxQueue ?? 256);
  interface Entry {
    handler: (fact: RuntimeFactV1) => void;
    queue: RuntimeFactV1[];
    dropped: number;
    open: boolean;
  }
  const subscribers = new Map<number, Entry>();
  let nextId = 0;

  return {
    subscribe(handler) {
      const id = ++nextId;
      const entry: Entry = { handler, queue: [], dropped: 0, open: true };
      subscribers.set(id, entry);
      return {
        id,
        drain() {
          if (!entry.open) return;
          const pending = entry.queue;
          entry.queue = [];
          for (const fact of pending) entry.handler(fact);
        },
        queued: () => entry.queue.length,
        dropped: () => entry.dropped,
        close() {
          entry.open = false;
          entry.queue = [];
          subscribers.delete(id);
        },
      };
    },
    publish(fact) {
      for (const entry of subscribers.values()) {
        if (!entry.open) continue;
        entry.queue.push(fact);
        while (entry.queue.length > maxQueue) {
          entry.queue.shift();
          entry.dropped += 1;
        }
      }
    },
    subscriberCount: () => subscribers.size,
  };
}

/** Terminal outcomes accepted by the fact model (mirrors the executor vocabulary). */
export type RuntimeTerminalOutcome = TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN';
