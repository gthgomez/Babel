/**
 * Packet A2 — durable per-conversation runtime EventLog.
 *
 * One append-only JSONL file per conversation, written under the existing
 * session store root (the chat session dir produced by `chatSessionDir`), that
 * persists the `RuntimeFactV1` stream sunk from the `FactBus`. This turns the
 * fact stream from a shadow model into a single authoritative, replayable
 * store — mirroring OpenHands' `EventLog` (thread-safe, ordered, disk-persisted
 * per conversation).
 *
 * Invariants (fail-closed, never weakened for tests):
 *   - Single writer: at most one log handle per file per process; a second
 *     open fails with `EVENT_LOG_WRITER_EXISTS` rather than interleaving.
 *   - Redaction at the sink: every fact passes through `redactRuntimeFact`
 *     before it touches disk; secret material never enters the file.
 *   - Torn tail: a crash mid-append can leave a partial final line. The reader
 *     discards any record that does not fully validate — a torn fact is
 *     *absent*, never surfaced.
 *   - Parent linkage: each record carries `parent_fact_id`. Run facts parent
 *     to the previous run fact; the turn fact parents to the run fact;
 *     operation facts parent to the turn fact (reusing the existing
 *     `EventCursor` address space for ordering — never a protocol `seq`, a
 *     history `cell_id`, or a session-event `seq`).
 *
 * Writes are fsync-batched: records accumulate in a bounded buffer and are
 * written + `fsync`ed together, so the durable tail is always either a
 * complete record or nothing (a lost buffered record is absent, not torn).
 *
 * Legacy stores are NOT deleted here. Retirement of duplicate persistence
 * producers is gated behind the `BABEL_FACT_EVENT_LOG_SINK=on` flag; parity
 * proof belongs to packet A4 (see `runtimeEventLogRetirementFlag`).
 */

import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  redactRuntimeFact,
  RUNTIME_FACT_SCHEMA_VERSION,
  validateRuntimeFact,
  type EventCursor,
  type FactValidation,
  type RuntimeFactV1,
} from './events.js';

/** Filename of the per-conversation runtime fact log. */
export const RUNTIME_EVENT_LOG_FILENAME = 'runtime-facts.jsonl';

/** Version of the on-disk record envelope (the fact schema version today). */
export const RUNTIME_EVENT_LOG_RECORD_VERSION = 1 as const;

/** Reason codes surfaced by EventLog operations (never thrown past the API). */
export type RuntimeEventLogErrorCode =
  | 'event_log_writer_exists'
  | 'event_log_hostile_conversation_id'
  | 'event_log_invalid_fact'
  | 'event_log_io_failure';

/**
 * A persisted fact record: the validated, redacted fact plus durable parent
 * linkage. Serialized with a stable key order so replaying the log
 * reproduces byte-identical lines.
 */
export interface RuntimeEventLogRecordV1 {
  readonly recordVersion: typeof RUNTIME_EVENT_LOG_RECORD_VERSION;
  readonly fact: RuntimeFactV1;
  /** Fact id of the causal parent; empty string when the fact roots a run. */
  readonly parentFactId: string;
}

export interface RuntimeEventLogAppendResult {
  readonly ok: boolean;
  readonly errorCode?: RuntimeEventLogErrorCode;
  readonly reason?: string;
  /** The record as persisted (pre-buffer), when the append succeeded. */
  readonly record?: RuntimeEventLogRecordV1;
  readonly validation?: FactValidation;
}

export interface RuntimeEventLogStats {
  readonly appended: number;
  readonly rejectedInvalid: number;
  readonly rejectedIo: number;
  readonly flushes: number;
}

/** Deterministic serializer: fixed key order, compact JSON, newline-terminated. */
export function serializeEventLogRecord(record: RuntimeEventLogRecordV1): string {
  return (
    JSON.stringify({
      recordVersion: record.recordVersion,
      parent_fact_id: record.parentFactId,
      fact: {
        schemaVersion: record.fact.schemaVersion,
        id: record.fact.id,
        cursor: { stream: record.fact.cursor.stream, sequence: record.fact.cursor.sequence },
        threadId: record.fact.threadId,
        taskId: record.fact.taskId,
        turnId: record.fact.turnId,
        runId: record.fact.runId,
        sequence: record.fact.sequence,
        causationId: record.fact.causationId,
        producer: record.fact.producer,
        authority: record.fact.authority,
        timestamp: record.fact.timestamp,
        payload: record.fact.payload,
      },
    }) + '\n'
  );
}

/**
 * Path of the runtime fact log for one conversation. `conversationId` is a
 * single path segment under `rootDir`; hostile ids (traversal, separators)
 * fail closed with `null` instead of escaping the store root.
 */
export function runtimeEventLogPathForConversation(
  rootDir: string,
  conversationId: string,
): string | null {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return null;
  if (conversationId.length > 200) return null;
  // Fail closed on traversal, separators, and control characters.
  for (const ch of conversationId) {
    const code = ch.charCodeAt(0);
    const ok =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      ch === '-' ||
      ch === '_' ||
      ch === '.';
    if (!ok) return null;
  }
  if (conversationId.startsWith('.')) return null;
  if (basename(conversationId) !== conversationId) return null;
  return join(rootDir, `${conversationId}.runtime-facts.jsonl`);
}

/**
 * Retirement flag for duplicate persistence producers (packet A2 task 4).
 * Legacy stores keep writing by default; when the flag is `on`, call sites may
 * suppress their duplicate persistence now that the EventLog covers them.
 * No legacy store is deleted in this packet; parity proof is A4's.
 */
export function runtimeEventLogRetirementFlag(): boolean {
  try {
    return (
      typeof process !== 'undefined' &&
      process.env?.['BABEL_FACT_EVENT_LOG_SINK'] === 'on'
    );
  } catch {
    return false;
  }
}

// ─── Parent linkage ─────────────────────────────────────────────────────────

/**
 * Parent-linkage tracker. Rules (packet A2 task 3):
 *   - `run.*` facts parent to the previous run fact (root run: empty parent).
 *   - `turn.admitted` parents to the current run fact and becomes the turn
 *     parent.
 *   - `operation.*` facts parent to the current turn fact, falling back to the
 *     run fact, then empty.
 *   - Other facts parent to the current run fact (then empty).
 */
export class FactParentLinker {
  private runFactId = '';
  private turnFactId = '';

  reset(): void {
    this.runFactId = '';
    this.turnFactId = '';
  }

  parentFor(fact: RuntimeFactV1): string {
    const type = fact.payload?.type;
    if (type === 'run.started') return this.runFactId;
    if (type === 'turn.admitted') return this.runFactId;
    if (type === 'operation.prepared' || type === 'operation.settled' || type === 'operation.indeterminate') {
      return this.turnFactId !== '' ? this.turnFactId : this.runFactId;
    }
    return this.runFactId;
  }

  /** Record a persisted fact so later facts can link to it. */
  record(record: RuntimeEventLogRecordV1): void {
    const type = record.fact.payload?.type;
    if (type === 'run.started') {
      this.runFactId = record.fact.id;
      this.turnFactId = '';
      return;
    }
    if (type === 'turn.admitted') {
      this.turnFactId = record.fact.id;
    }
  }
}

// ─── Single-writer log ──────────────────────────────────────────────────────

/** Buffer bound: a batch larger than this is split into multiple fsyncs. */
const DEFAULT_FLUSH_BYTES = 64 * 1024;
const MAX_FLUSH_BYTES = 4 * 1024 * 1024;

/** One open writer per file per process — the single-writer guard. */
const OPEN_WRITERS = new Set<string>();

export interface RuntimeEventLog {
  readonly path: string;
  appendFact(fact: RuntimeFactV1): RuntimeEventLogResult;
  flush(): RuntimeEventLogResult;
  close(): RuntimeEventLogResult;
  stats(): RuntimeEventLogStats;
  /** Records buffered but not yet fsynced (observable batch size). */
  pendingBytes(): number;
}

export type RuntimeEventLogResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: RuntimeEventLogErrorCode; readonly reason: string };

/**
 * Open the per-conversation EventLog for appending. The caller owns `close()`.
 * Only one writer may hold a file; a second open fails closed.
 */
export function createRuntimeEventLog(options: {
  /** Conversation/session directory (the existing session store root per conversation). */
  sessionDir: string;
  conversationId?: string;
  /** Batch bound before an fsync; defaults to 64 KiB. */
  flushBytes?: number;
} | null): RuntimeEventLog {
  let sessionDir: string;
  try {
    sessionDir = String(options?.sessionDir ?? '');
  } catch {
    sessionDir = '';
  }
  if (sessionDir.length === 0) {
    throw new Error('event_log_invalid_session_dir');
  }
  const path = join(sessionDir, RUNTIME_EVENT_LOG_FILENAME);
  if (OPEN_WRITERS.has(path)) {
    throw new Error('event_log_writer_exists');
  }

  let requestedFlush: unknown;
  try {
    requestedFlush = options?.flushBytes;
  } catch {
    requestedFlush = undefined;
  }
  const flushBytes =
    typeof requestedFlush === 'number' &&
    Number.isFinite(requestedFlush) &&
    requestedFlush > 0
      ? Math.min(MAX_FLUSH_BYTES, Math.max(1, Math.floor(requestedFlush)))
      : DEFAULT_FLUSH_BYTES;

  const linker = new FactParentLinker();
  const stats: { appended: number; rejectedInvalid: number; rejectedIo: number; flushes: number } = {
    appended: 0,
    rejectedInvalid: 0,
    rejectedIo: 0,
    flushes: 0,
  };

  let buffer = '';
  let fd: number | null = null;
  let closed = false;

  const ensureOpen = (): number | null => {
    if (closed) return null;
    if (fd !== null) return fd;
    try {
      fd = openSync(path, 'a');
      OPEN_WRITERS.add(path);
      return fd;
    } catch {
      return null;
    }
  };

  const flushLocked = (): RuntimeEventLogResult => {
    if (closed) return { ok: true };
    if (buffer.length === 0) return { ok: true };
    const handle = ensureOpen();
    if (handle === null) {
      return { ok: false, errorCode: 'event_log_io_failure', reason: 'open_failed' };
    }
    try {
      writeSync(handle, buffer);
      fsyncSync(handle);
      buffer = '';
      stats.flushes += 1;
      return { ok: true };
    } catch (error) {
      // Keep the buffer: the batch is retried on the next flush; nothing
      // partial was surfaced. If the write partially landed, the reader's
      // torn-tail rule discards the incomplete record.
      return {
        ok: false,
        errorCode: 'event_log_io_failure',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const handle = {
    path,
    appendFact(fact: RuntimeFactV1): RuntimeEventLogResult {
      const validation = validateRuntimeFact(fact);
      if (!validation.ok) {
        stats.rejectedInvalid += 1;
        return {
          ok: false,
          errorCode: 'event_log_invalid_fact',
          reason: validation.reason,
        };
      }
      // Redact at the sink — the file never sees secret material.
      const redacted = redactRuntimeFact(validation.fact);
      const record: RuntimeEventLogRecordV1 = {
        recordVersion: RUNTIME_EVENT_LOG_RECORD_VERSION,
        fact: redacted,
        parentFactId: linker.parentFor(redacted),
      };
      const line = serializeEventLogRecord(record);
      buffer += line;
      if (buffer.length >= flushBytes) {
        const flushed = flushLocked();
        if (!flushed.ok) {
          stats.rejectedIo += 1;
          return flushed;
        }
      }
      stats.appended += 1;
      linker.record(record);
      return { ok: true };
    },
    flush(): RuntimeEventLogResult {
      return flushLocked();
    },
    close(): RuntimeEventLogResult {
      if (closed) return { ok: true };
      const flushed = flushLocked();
      closed = true;
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort close; the fsync already made the batch durable */
        }
        fd = null;
      }
      OPEN_WRITERS.delete(path);
      return flushed;
    },
    stats(): RuntimeEventLogStats {
      return { ...stats };
    },
    pendingBytes(): number {
      return buffer.length;
    },
  };

  // Register eagerly so a second `createRuntimeEventLog` for the same file
  // fails closed even before the first write.
  OPEN_WRITERS.add(path);
  return handle;
}

// ─── Reader ─────────────────────────────────────────────────────────────────

export interface RuntimeEventLogReadResult {
  readonly path: string;
  /** Valid, ordered records. A torn/corrupt record is never among these. */
  readonly records: readonly RuntimeEventLogRecordV1[];
  /** Lines discarded fail-closed (torn tail or corrupt), with the last reason. */
  readonly discarded: number;
  /** True when the final physical line was discarded (crash mid-append). */
  readonly tornTail: boolean;
  readonly lastError?: string;
}

/**
 * Shape-validate an untrusted parsed line. Fail-closed: anything that is not a
 * complete, validated, redacted-safe record envelope is rejected.
 */
function parseEventLogRecordLine(line: string): RuntimeEventLogRecordV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (envelope['recordVersion'] !== RUNTIME_EVENT_LOG_RECORD_VERSION) return null;
  if (typeof envelope['parent_fact_id'] !== 'string') return null;
  const validation = validateRuntimeFact(envelope['fact']);
  if (!validation.ok) return null;
  // Rebuild through the serializer's shape so replayed records are identical
  // to appended ones (no smuggled extra envelope fields).
  return {
    recordVersion: RUNTIME_EVENT_LOG_RECORD_VERSION,
    fact: validation.fact,
    parentFactId: envelope['parent_fact_id'],
  };
}

/**
 * Read and reconstruct the ordered history from a runtime fact log. Never
 * throws for log content problems: corrupt or torn lines are discarded and
 * counted, never surfaced as facts.
 */
export function readRuntimeEventLog(path: string): RuntimeEventLogReadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    return {
      path,
      records: [],
      discarded: 0,
      tornTail: false,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
  const rawLines = text.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  const records: RuntimeEventLogRecordV1[] = [];
  let discarded = 0;
  let tornTail = false;
  let lastError: string | undefined;
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]!;
    if (line.length === 0) {
      discarded += 1;
      if (index === rawLines.length - 1) tornTail = true;
      lastError = 'empty_line';
      continue;
    }
    const record = parseEventLogRecordLine(line);
    if (record === null) {
      discarded += 1;
      if (index === rawLines.length - 1) tornTail = true;
      lastError = 'invalid_record';
      continue;
    }
    records.push(record);
  }
  return { path, records, discarded, tornTail, ...(lastError !== undefined ? { lastError } : {}) };
}

/**
 * Replay determinism: order the records by their existing `EventCursor`
 * semantics (`runtime-facts` stream, integer sequence) and verify the order is
 * strictly increasing. Returns `ok:false` for a non-monotonic log — a reader
 * never silently reorders a broken history.
 */
export function replayEventLogRecords(
  records: readonly RuntimeEventLogRecordV1[],
): { ok: true; ordered: readonly RuntimeFactV1[] } | { ok: false; reason: string } {
  const sorted = [...records].sort((a, b) => {
    const aSeq = typeof a.fact.cursor?.sequence === 'number' ? a.fact.cursor.sequence : 0;
    const bSeq = typeof b.fact.cursor?.sequence === 'number' ? b.fact.cursor.sequence : 0;
    return aSeq - bSeq;
  });
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1]!.fact.cursor;
    const curr = sorted[index]!.fact.cursor;
    if (!isSameStream(prev, curr) || prev.sequence >= curr.sequence) {
      return { ok: false, reason: `non_monotonic_cursor_at_${index}` };
    }
  }
  return { ok: true, ordered: sorted.map((record) => record.fact) };
}

function isSameStream(a: EventCursor, b: EventCursor): boolean {
  return a?.stream === b?.stream;
}

// ─── FactBus sink ───────────────────────────────────────────────────────────

export interface FactBusEventLogSink {
  /** The underlying log (also usable directly). */
  readonly log: RuntimeEventLog;
  /** Bus subscription id (see `FactBusSubscription`). */
  readonly subscriptionId: number;
  /** Drain the bounded subscriber queue into the log (facts become durable). */
  drain(): void;
  /** Facts the bus dropped before the sink saw them (bounded queue overflow). */
  busDropped(): number;
  /** Drain, flush, and unsubscribe; idempotent. */
  close(): void;
}

/**
 * Sink the FactBus into the EventLog. The bus remains the live in-memory path;
 * this adds the durable single-writer persistence side channel. Every fact the
 * sink sees is validated fail-closed and redacted before it reaches disk.
 */
export function sinkFactBusIntoEventLog(
  bus: {
    subscribe(handler: (fact: RuntimeFactV1) => void): {
      readonly id: number;
      drain(): void;
      dropped?(): number;
      close(): void;
    };
  },
  log: RuntimeEventLog,
): FactBusEventLogSink {
  const subscription = bus.subscribe((fact) => {
    log.appendFact(fact);
  });
  return {
    log,
    subscriptionId: subscription.id,
    drain() {
      subscription.drain();
    },
    busDropped: () => (typeof subscription.dropped === 'function' ? subscription.dropped() : 0),
    close() {
      subscription.drain();
      log.flush();
      subscription.close();
    },
  };
}

/** Convenience: schema version re-export keeps importers on one surface. */
export { RUNTIME_FACT_SCHEMA_VERSION as EVENT_LOG_FACT_SCHEMA_VERSION };
