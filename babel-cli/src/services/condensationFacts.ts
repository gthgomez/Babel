/**
 * Packet A5 — condensation-as-event fact production.
 *
 * Every context compaction (condensation) emits a strict pair of runtime
 * facts: `context.condensation.started` before pruning work begins and
 * `context.condensation.completed` once the new, smaller context is real. The
 * completed fact carries the token counts before/after, the pruned message
 * ranges, and — when one was fenced — the P11 checkpoint capsule id, so
 * pre-compaction state is always recoverable from the fact stream alone.
 *
 * Invariants (fail-closed, never weakened):
 *   - started/completed is a strict pair. An interrupted compaction leaves a
 *     started fact without its completed pair and that gap stays visible
 *     (`openCompactionIds` / `condensationGapIds`) — never papered over.
 *   - Token counts and pruned ranges are derived from real compaction state.
 *     `complete()` refuses to mint a completed fact without a matching open
 *     started fact (there is no fabricated pairing), and `begin()` refuses
 *     malformed input instead of emitting a fact that ingress would reject.
 *   - Facts are observations, never authority: they classify as
 *     `observation` through the existing `classifyFactType` table.
 *
 * Delivery is injected (`CondensationFactChannel.emit`): callers with a
 * durable sink append the fact to the A2 EventLog (through its fail-closed
 * validation and redaction) or publish it on the FactBus. This module only
 * builds and tracks; it never writes storage itself.
 */

import { randomUUID } from 'node:crypto';

import type {
  CondensationPath,
  PrunedMessageRange,
  RuntimeFactProducer,
  RuntimeFactV1,
} from '../runtime/events.js';
import {
  classifyFactType,
  RUNTIME_FACT_SCHEMA_VERSION,
} from '../runtime/events.js';

/** Fact types produced here (mirrored for readable diagnostics). */
export const CONDENSATION_FACT_TYPES = {
  started: 'context.condensation.started',
  completed: 'context.condensation.completed',
} as const;

/** Hard bound on tracked open condensations and on pruned-range arrays. */
const MAX_OPEN_CONDENSATIONS = 1000;
const MAX_PRUNED_RANGES = 10_000;

/** Envelope identity stamped onto produced facts. */
export interface CondensationFactIdentity {
  readonly threadId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly turnId?: string;
  readonly producer?: RuntimeFactProducer;
}

/** Delivery + identity binding for a compaction site. */
export interface CondensationFactChannel {
  readonly emitter: CondensationFactEmitter;
  /** Deliver a built fact (EventLog append, bus publish, test capture). */
  emit(fact: RuntimeFactV1): void;
}

export interface CondensationBeginInput {
  readonly compactionId?: string;
  readonly path: CondensationPath;
  /** Real token count of the context before pruning (caller-measured). */
  readonly countBefore: number;
}

export interface CondensationCompleteInput {
  readonly compactionId: string;
  /** Real token count of the context after pruning (caller-measured). */
  readonly countAfter: number;
  /** Inclusive message index ranges removed from the active context. */
  readonly prunedMessageRanges: ReadonlyArray<PrunedMessageRange>;
  /** P11 checkpoint capsule id fenced by this compaction, when one was. */
  readonly capsuleCheckpointId?: string;
}

interface OpenCondensation {
  readonly compactionId: string;
  readonly path: CondensationPath;
  readonly countBefore: number;
  readonly sequence: number;
  readonly id: string;
}

function isBoundedInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Builds strict started/completed condensation fact pairs and tracks the
 * open (started-without-completed) set so an interrupted compaction stays
 * visible. Sequence allocation is injected so facts can join the caller's
 * cursor space without this module owning a counter that could collide.
 */
export class CondensationFactEmitter {
  private readonly identity: CondensationFactIdentity;
  private readonly allocateSequence: () => number;
  private readonly now: () => string;
  private readonly open = new Map<string, OpenCondensation>();
  private counter = 0;

  constructor(
    identity: CondensationFactIdentity,
    allocateSequence: () => number,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.identity = identity;
    this.allocateSequence = allocateSequence;
    this.now = now;
  }

  /** Ids of started condensations with no completed fact yet (visible gap). */
  openCompactionIds(): string[] {
    return [...this.open.keys()];
  }

  hasOpen(compactionId: string): boolean {
    return this.open.has(compactionId);
  }

  /**
   * Emit a started fact. Returns `null` (emitting nothing) on malformed
   * input or when the open-set bound is exceeded — fail-closed, never a
   * fact ingress would reject.
   */
  begin(input: CondensationBeginInput): RuntimeFactV1 | null {
    const compactionId =
      typeof input.compactionId === 'string' && input.compactionId.length > 0
        ? input.compactionId
        : randomUUID();
    if (this.open.size >= MAX_OPEN_CONDENSATIONS) return null;
    if (!isBoundedInt(input.countBefore)) return null;
    if (input.path !== 'pipeline_step_prune' && input.path !== 'chat_engine_inline') return null;

    const sequence = this.allocateSequence();
    const id = `condensation-started-${compactionId}-${++this.counter}`;
    const fact: RuntimeFactV1 = {
      schemaVersion: RUNTIME_FACT_SCHEMA_VERSION,
      id,
      cursor: { stream: 'runtime-facts', sequence },
      threadId: this.identity.threadId,
      taskId: this.identity.taskId ?? '',
      turnId: this.identity.turnId ?? '',
      runId: this.identity.runId,
      sequence,
      causationId: compactionId,
      producer: this.identity.producer ?? 'chat_engine',
      authority: classifyFactType('context.condensation.started') === 'authoritative'
        ? 'authoritative'
        : 'observation',
      timestamp: this.now(),
      payload: {
        type: 'context.condensation.started',
        compactionId,
        path: input.path,
        countBefore: input.countBefore,
      },
    };
    this.open.set(compactionId, {
      compactionId,
      path: input.path,
      countBefore: input.countBefore,
      sequence,
      id,
    });
    return fact;
  }

  /**
   * Emit the completed fact for an open started condensation. The completed
   * fact's `countBefore` is the real value recorded at `begin` — never
   * re-derived or fabricated. Returns `null` when no matching started fact
   * is open: a completed fact without its started pair is refused, not
   * invented.
   */
  complete(input: CondensationCompleteInput): RuntimeFactV1 | null {
    const record = this.open.get(input.compactionId);
    if (record === undefined) return null;
    if (!isBoundedInt(input.countAfter)) return null;
    if (!Array.isArray(input.prunedMessageRanges)) return null;
    if (input.prunedMessageRanges.length > MAX_PRUNED_RANGES) return null;
    const ranges: PrunedMessageRange[] = [];
    for (const range of input.prunedMessageRanges) {
      const from = (range as PrunedMessageRange | undefined)?.from;
      const to = (range as PrunedMessageRange | undefined)?.to;
      if (!isBoundedInt(from) || !isBoundedInt(to) || to < from) return null;
      ranges.push({ from, to });
    }
    this.open.delete(input.compactionId);

    const sequence = this.allocateSequence();
    const fact: RuntimeFactV1 = {
      schemaVersion: RUNTIME_FACT_SCHEMA_VERSION,
      id: `condensation-completed-${input.compactionId}-${++this.counter}`,
      cursor: { stream: 'runtime-facts', sequence },
      threadId: this.identity.threadId,
      taskId: this.identity.taskId ?? '',
      turnId: this.identity.turnId ?? '',
      runId: this.identity.runId,
      sequence,
      causationId: input.compactionId,
      producer: this.identity.producer ?? 'chat_engine',
      authority: classifyFactType('context.condensation.completed') === 'authoritative'
        ? 'authoritative'
        : 'observation',
      timestamp: this.now(),
      payload: {
        type: 'context.condensation.completed',
        compactionId: input.compactionId,
        path: record.path,
        countBefore: record.countBefore,
        countAfter: input.countAfter,
        prunedMessageRanges: ranges,
        ...(input.capsuleCheckpointId !== undefined
          ? { capsuleCheckpointId: input.capsuleCheckpointId }
          : {}),
      },
    };
    return fact;
  }
}

/** Collapse pruned step/message indexes into inclusive, ordered ranges. */
export function prunedIndexesToRanges(indexes: ReadonlyArray<number>): PrunedMessageRange[] {
  const sorted = [...indexes].filter(isBoundedInt).sort((a, b) => a - b);
  const ranges: PrunedMessageRange[] = [];
  for (const index of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && index === last.to + 1) {
      ranges[ranges.length - 1] = { from: last.from, to: index };
      continue;
    }
    if (last && index <= last.to) continue;
    ranges.push({ from: index, to: index });
  }
  return ranges;
}

export interface CondensationGapV1 {
  readonly compactionId: string;
  readonly path: string;
  readonly startedSequence: number;
  readonly countBefore: number;
}

/**
 * Scan an ordered fact list for started condensations with no matching
 * completed fact — the fail-closed signature of an interrupted compaction.
 * Pure; the gap is reported, never repaired.
 */
export function condensationGapIds(facts: ReadonlyArray<RuntimeFactV1>): CondensationGapV1[] {
  const started = new Map<string, CondensationGapV1>();
  for (const fact of facts) {
    const payload = fact?.payload;
    if (payload?.type === 'context.condensation.started') {
      started.set(payload.compactionId, {
        compactionId: payload.compactionId,
        path: payload.path,
        startedSequence: fact.sequence,
        countBefore: payload.countBefore,
      });
      continue;
    }
    if (payload?.type === 'context.condensation.completed') {
      started.delete(payload.compactionId);
    }
  }
  return [...started.values()].sort((a, b) => a.startedSequence - b.startedSequence);
}
