/**
 * Episode stream foundation — Chat-side append-only dual-write (Slice A).
 *
 * Writes `episode-events.jsonl` under the chat run dir alongside
 * `session-events.jsonl` / `thread_events.json`. Event envelope aligns with
 * CanonicalExecutorEvent (executor/contracts.ts). Does not replace EvidenceBundle
 * or existing session/thread logs.
 *
 * Prefer projecting from SessionEventV1 at flush time so tool paths need no
 * re-instrumentation.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalEventKind, CanonicalExecutorEvent } from '../executor/contracts.js';
import { EXECUTOR_EVENT_SCHEMA_VERSION } from '../executor/contracts.js';
import type { SessionEvent, SessionEventKind, SessionEventLog } from '../agent/sessionEvents.js';
import { redactEvidenceValue } from '../utils/redaction.js';

export const EPISODE_EVENT_SCHEMA_VERSION = 1 as const;
export const EPISODE_EVENTS_FILENAME = 'episode-events.jsonl';
export const EPISODE_PAYLOAD_MAX_BYTES = 64 * 1024;

export type EpisodeStreamLoadMode = 'new' | 'resume' | 'legacy_resume';
export type EpisodeStreamMode = EpisodeStreamLoadMode;

export type EpisodeStreamErrorCode =
  | 'absent'
  | 'already_exists'
  | 'malformed'
  | 'invalid_chain'
  | 'session_mismatch'
  | 'io_error'
  | 'quarantine_failed';

export interface EpisodeStreamError {
  code: EpisodeStreamErrorCode;
  message: string;
  reason?: string;
  quarantineFile?: string;
}

export type EpisodeStreamResult<T> =
  | { ok: true; value: T; mode: EpisodeStreamLoadMode }
  | { ok: false; error: EpisodeStreamError };

export interface EpisodeStreamFilesystem {
  exists(path: string): boolean;
  readFile(path: string): string;
  rename(from: string, to: string): void;
}

const DEFAULT_EPISODE_FILESYSTEM: EpisodeStreamFilesystem = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, 'utf-8'),
  rename: renameSync,
};

export interface EpisodeStreamLoadOptions {
  sessionId?: string;
  mode?: EpisodeStreamLoadMode;
  hashLink?: boolean;
  filesystem?: EpisodeStreamFilesystem;
}

export interface EpisodeValidationResult {
  valid: boolean;
  error?: string;
  code?: Exclude<EpisodeStreamErrorCode, 'absent' | 'already_exists' | 'io_error' | 'quarantine_failed'>;
}

/** Canonical episode event: executor envelope + optional hash-link field. */
export type EpisodeEvent = CanonicalExecutorEvent & {
  /** SHA-256 hex of the previous event's serialized JSON line (hash-link foundation). */
  prevHash?: string;
};

export interface EpisodeEventLog {
  schemaVersion: typeof EPISODE_EVENT_SCHEMA_VERSION;
  sessionId: string;
  events: EpisodeEvent[];
  nextSeq: number;
  /** Highest seq already flushed to disk (-1 = none). */
  flushedThroughSeq: number;
  /**
   * Highest SessionEvent.seq already projected into this log (-1 = none).
   * In-memory sync cursor for dual-write from session-events.
   */
  syncedSessionSeq: number;
  /** When true, each new event carries prevHash of the prior event line. */
  hashLink: boolean;
  /** SHA-256 of the last appended event JSON (for chain continuation). */
  lastEventHash: string | null;
}

export interface CreateEpisodeEventLogOptions {
  /** Enable prevHash chain (default true for foundation). */
  hashLink?: boolean;
}

/** Create an empty in-memory episode log for a session/thread. */
export function createEpisodeEventLog(
  sessionId?: string,
  options?: CreateEpisodeEventLogOptions,
): EpisodeEventLog {
  return {
    schemaVersion: EPISODE_EVENT_SCHEMA_VERSION,
    sessionId: sessionId ?? randomUUID(),
    events: [],
    nextSeq: 0,
    flushedThroughSeq: -1,
    syncedSessionSeq: -1,
    hashLink: options?.hashLink !== false,
    lastEventHash: null,
  };
}

/** Map SessionEventV1 kinds onto CanonicalEventKind + detail type string. */
export function mapSessionKindToEpisode(
  kind: SessionEventKind,
): { kind: CanonicalEventKind; type: string } {
  switch (kind) {
    case 'user_submitted':
      return { kind: 'session', type: 'user_submitted' };
    case 'model_started':
      return { kind: 'session', type: 'model_started' };
    case 'provider_retry_scheduled':
      return { kind: 'session', type: 'provider_retry_scheduled' };
    case 'provider_retry_settled':
      return { kind: 'session', type: 'provider_retry_settled' };
    case 'tool_proposed':
      return { kind: 'tool', type: 'tool_proposed' };
    case 'tool_started':
      return { kind: 'tool', type: 'tool_started' };
    case 'tool_completed':
      return { kind: 'tool', type: 'tool_completed' };
    case 'tool_failed':
      return { kind: 'tool', type: 'tool_failed' };
    case 'tool_cancelled':
      return { kind: 'tool', type: 'tool_cancelled' };
    case 'recovery_reconciled':
      return { kind: 'recovery', type: 'recovery_reconciled' };
    case 'mutation_batch':
      return { kind: 'mutation', type: 'mutation_batch' };
    case 'verifier_attempt':
      return { kind: 'verifier', type: 'verifier_attempt' };
    case 'gate_decision':
      return { kind: 'completion', type: 'gate_decision' };
    case 'policy_intervened':
      return { kind: 'recovery', type: 'policy_intervened' };
    case 'progress_recovery':
      return { kind: 'recovery', type: 'progress_recovery' };
    case 'completion_decision':
      return { kind: 'completion', type: 'completion_decision' };
    case 'model_failover':
      return { kind: 'recovery', type: 'model_failover' };
    case 'model_input_receipt':
    case 'model_invocation_phase':
    case 'capability_binding_receipt':
    case 'model_result_delivery':
      return { kind: 'session', type: kind };
    case 'compaction_started':
    case 'compaction_summary':
    case 'compaction_committed':
    case 'compaction_created':
      return { kind: 'session', type: kind };
    case 'turn_ended':
      return { kind: 'turn', type: 'turn_ended' };
    case 'budget_snapshot':
      return { kind: 'session', type: 'budget_snapshot' };
    case 'approval_decision':
      return { kind: 'session', type: 'approval_decision' };
    case 'repair_attempt':
      return { kind: 'recovery', type: 'repair_attempt' };
    default: {
      const _exhaustive: never = kind;
      return { kind: 'session', type: String(_exhaustive) };
    }
  }
}

const SESSION_BASE_KEYS = new Set([
  'schema_version',
  'event_id',
  'session_id',
  'turn_id',
  'seq',
  'ts',
  'kind',
]);

/** Extract payload fields from a session event (everything beyond the base envelope). */
export function sessionEventPayload(ev: SessionEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev as unknown as Record<string, unknown>)) {
    if (SESSION_BASE_KEYS.has(k)) continue;
    if (v !== undefined) payload[k] = v;
  }
  // Correlation back to the source session event.
  payload['sourceSessionSeq'] = ev.seq;
  payload['sourceEventId'] = ev.event_id;
  payload['sourceSchemaVersion'] = ev.schema_version;
  return payload;
}

/** SHA-256 hex of a serialized episode event (hash-link unit). */
export function hashEpisodeEvent(event: EpisodeEvent): string {
  return createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end - 1]! & 0xc0) === 0x80) {
    let start = end - 1;
    while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
    const lead = bytes[start]!;
    const expectedLength =
      lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (end - start === expectedLength) break;
    end = start;
  }
  return bytes.subarray(0, end).toString('utf8');
}

/** Redacts and caps event payloads before they enter the durable stream. */
export function redactAndCapEpisodePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactEvidenceValue(payload) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  if (Buffer.byteLength(serialized, 'utf8') <= EPISODE_PAYLOAD_MAX_BYTES) return redacted;

  const routingKeys = new Set([
    'eventId',
    'turnId',
    'runId',
    'phase',
    'stage',
    'status',
    'outcome',
    'reason',
    'tool',
    'step',
    'target',
  ]);
  const routing: Record<string, unknown> = {};
  for (const key of routingKeys) {
    const value = redacted[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      routing[key] = typeof value === 'string' ? truncateUtf8(value, 512) : value;
    }
  }
  const base = {
    ...routing,
    truncated: true,
    originalBytes: Buffer.byteLength(serialized, 'utf8'),
  };
  let low = 0;
  let high = Buffer.byteLength(serialized, 'utf8');
  let best: Record<string, unknown> = { ...base, preview: '' };
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = { ...base, preview: truncateUtf8(serialized, mid) };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= EPISODE_PAYLOAD_MAX_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (Buffer.byteLength(JSON.stringify(best), 'utf8') > EPISODE_PAYLOAD_MAX_BYTES) {
    throw new Error('Episode payload cap could not be satisfied.');
  }
  return best;
}

/**
 * Append one episode event. Optionally hash-links via prevHash when log.hashLink.
 * Returns the full record.
 */
export function appendEpisodeEvent(
  log: EpisodeEventLog,
  input: {
    kind: CanonicalEventKind;
    type: string;
    turnId?: string | null;
    payload?: Record<string, unknown>;
    eventId?: string;
    ts?: string;
    sessionId?: string;
  },
): EpisodeEvent {
  const seq = log.nextSeq++;
  const event: EpisodeEvent = {
    schemaVersion: EXECUTOR_EVENT_SCHEMA_VERSION,
    eventId: input.eventId ?? randomUUID(),
    sessionId: input.sessionId ?? log.sessionId,
    turnId: input.turnId === undefined ? null : input.turnId,
    seq,
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind,
    type: input.type,
    payload: redactAndCapEpisodePayload(input.payload ? { ...input.payload } : {}),
  };
  if (log.hashLink && log.lastEventHash) {
    event.prevHash = log.lastEventHash;
  }
  log.events.push(event);
  log.lastEventHash = hashEpisodeEvent(event);
  return event;
}

/** Project a single SessionEventV1 into an episode event and append. */
export function appendEpisodeFromSessionEvent(
  log: EpisodeEventLog,
  se: SessionEvent,
): EpisodeEvent {
  const mapped = mapSessionKindToEpisode(se.kind);
  return appendEpisodeEvent(log, {
    kind: mapped.kind,
    type: mapped.type,
    turnId: se.turn_id,
    eventId: se.event_id,
    ts: se.ts,
    sessionId: se.session_id || log.sessionId,
    payload: sessionEventPayload(se),
  });
}

/**
 * Project any session events with seq > log.syncedSessionSeq into the episode log.
 * Returns number of newly projected events.
 */
export function syncEpisodeFromSessionEvents(
  episodeLog: EpisodeEventLog,
  sessionLog: SessionEventLog,
): number {
  let added = 0;
  for (const se of sessionLog.events) {
    if (se.seq <= episodeLog.syncedSessionSeq) continue;
    appendEpisodeFromSessionEvent(episodeLog, se);
    episodeLog.syncedSessionSeq = se.seq;
    added += 1;
  }
  return added;
}

/** Serialize all events as JSONL (one object per line). */
export function serializeEpisodeEventLog(log: EpisodeEventLog): string {
  return log.events.map((e) => JSON.stringify(e)).join('\n') + (log.events.length ? '\n' : '');
}

function maxSourceSessionSeq(events: EpisodeEvent[]): number {
  let max = -1;
  for (const e of events) {
    const src = e.payload['sourceSessionSeq'];
    if (typeof src === 'number' && Number.isFinite(src) && src > max) {
      max = src;
    }
  }
  return max;
}

/** Parse JSONL episode log; skips blank lines; rejects wrong schema. */
export function parseEpisodeEventLog(
  raw: string,
  sessionIdFallback?: string,
  options?: CreateEpisodeEventLogOptions,
): EpisodeEventLog {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const events: EpisodeEvent[] = [];
  let sessionId = sessionIdFallback ?? '';
  let maxSeq = -1;
  for (const line of lines) {
    const ev = JSON.parse(line) as EpisodeEvent;
    if (ev.schemaVersion !== EPISODE_EVENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported episode event schema: ${String(ev.schemaVersion)} (expected ${EPISODE_EVENT_SCHEMA_VERSION})`,
      );
    }
    if (!sessionId) sessionId = ev.sessionId;
    events.push(ev);
    if (ev.seq > maxSeq) maxSeq = ev.seq;
  }
  const last = events.length > 0 ? events[events.length - 1]! : null;
  return {
    schemaVersion: EPISODE_EVENT_SCHEMA_VERSION,
    sessionId: sessionId || randomUUID(),
    events,
    nextSeq: maxSeq + 1,
    flushedThroughSeq: maxSeq,
    syncedSessionSeq: maxSourceSessionSeq(events),
    hashLink: options?.hashLink !== false,
    lastEventHash: last ? hashEpisodeEvent(last) : null,
  };
}

/**
 * Dual-write: append newly added episode events to episode-events.jsonl under runDir.
 * Best-effort; never throws (returns error string).
 */
export function flushEpisodeEventLog(
  runDir: string,
  log: EpisodeEventLog,
): { path: string; wrote: number; error?: string } {
  const path = join(runDir, EPISODE_EVENTS_FILENAME);
  try {
    mkdirSync(runDir, { recursive: true });
    const pending = log.events.filter((e) => e.seq > log.flushedThroughSeq);
    if (pending.length === 0) {
      return { path, wrote: 0 };
    }
    const chunk = pending.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(path, chunk, 'utf-8');
    log.flushedThroughSeq = pending[pending.length - 1]!.seq;
    return { path, wrote: pending.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path, wrote: 0, error: msg };
  }
}

/**
 * Project pending session events then flush episode log. Primary dual-write helper
 * for parity finalize/checkpoint choke points.
 */
export function syncAndFlushEpisodeFromSession(
  runDir: string,
  episodeLog: EpisodeEventLog,
  sessionLog: SessionEventLog,
): { path: string; projected: number; wrote: number; error?: string } {
  const projected = syncEpisodeFromSessionEvents(episodeLog, sessionLog);
  const result = flushEpisodeEventLog(runDir, episodeLog);
  return {
    path: result.path,
    projected,
    wrote: result.wrote,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** Full rewrite (tests / recovery); sets flushedThroughSeq to last event. */
export function rewriteEpisodeEventLog(runDir: string, log: EpisodeEventLog): string {
  const path = join(runDir, EPISODE_EVENTS_FILENAME);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path, serializeEpisodeEventLog(log), 'utf-8');
  log.flushedThroughSeq =
    log.events.length > 0 ? log.events[log.events.length - 1]!.seq : -1;
  return path;
}

/**
 * Verify SHA-256 prevHash chain, contiguous sequence numbers, and session identity consistency.
 */
export function verifyHashChain(events: readonly EpisodeEvent[]): { valid: boolean; error?: string } {
  const validation = validateEpisodeEventLog(events);
  return validation.valid
    ? { valid: true }
    : validation.error
      ? { valid: false, error: validation.error }
      : { valid: false };
}

const EPISODE_EVENT_KINDS = new Set<CanonicalEventKind>([
  'session',
  'turn',
  'tool',
  'mutation',
  'progress',
  'verifier',
  'completion',
  'recovery',
]);

/** Strict runtime validation used at every pipeline load boundary. */
export function validateEpisodeEventLog(
  events: readonly EpisodeEvent[],
  expectedSessionId?: string,
): EpisodeValidationResult {
  if (!Array.isArray(events) || events.length === 0) {
    return { valid: false, code: 'malformed', error: 'Episode event stream is empty.' };
  }

  const first = events[0]!;
  if (typeof first.sessionId !== 'string' || first.sessionId.length === 0) {
    return { valid: false, code: 'malformed', error: 'Episode stream has an invalid sessionId.' };
  }
  if (expectedSessionId && first.sessionId !== expectedSessionId) {
    return {
      valid: false,
      code: 'session_mismatch',
      error: `Episode session mismatch: expected "${expectedSessionId}", got "${first.sessionId}"`,
    };
  }
  if (!first.sessionId || first.seq !== 0 || first.prevHash !== undefined) {
    return {
      valid: false,
      code: 'invalid_chain',
      error: 'Episode stream must begin at seq 0 without a predecessor hash.',
    };
  }

  const expectedSession = first.sessionId;
  let expectedSeq = 0;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;

    if (
      event.schemaVersion !== EXECUTOR_EVENT_SCHEMA_VERSION ||
      typeof event.eventId !== 'string' ||
      event.eventId.length === 0 ||
      typeof event.sessionId !== 'string' ||
      event.sessionId.length === 0 ||
      (event.turnId !== null && typeof event.turnId !== 'string') ||
      typeof event.ts !== 'string' ||
      event.ts.length === 0 ||
      !Number.isInteger(event.seq) ||
      event.seq < 0 ||
      typeof event.type !== 'string' ||
      event.type.length === 0 ||
      !EPISODE_EVENT_KINDS.has(event.kind) ||
      !event.payload ||
      typeof event.payload !== 'object' ||
      Array.isArray(event.payload)
    ) {
      return {
        valid: false,
        code: 'malformed',
        error: `Malformed episode event at index ${i}.`,
      };
    }

    if (event.sessionId !== expectedSession) {
      return {
        valid: false,
        code: 'session_mismatch',
        error: `Inconsistent sessionId at index ${i}: expected "${expectedSession}", got "${event.sessionId}"`,
      };
    }

    if (event.seq !== expectedSeq) {
      return {
        valid: false,
        code: 'invalid_chain',
        error: `Non-contiguous seq at index ${i}: expected ${expectedSeq}, got ${event.seq}`,
      };
    }

    if (i > 0 && (typeof event.prevHash !== 'string' || !/^[a-f0-9]{64}$/i.test(event.prevHash))) {
      return {
        valid: false,
        code: 'invalid_chain',
        error: `Hash chain broken at index ${i}: predecessor hash is missing or malformed.`,
      };
    }

    if (i > 0) {
      const expectedPrevHash = hashEpisodeEvent(events[i - 1]!);
      if (event.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          code: 'invalid_chain',
          error: `Hash chain broken at index ${i}: prevHash mismatch for seq ${event.seq}`,
        };
      }
    }

    expectedSeq += 1;
  }

  return { valid: true };
}

export function loadEpisodeEventLogFromDir(
  runDir: string,
  options?: CreateEpisodeEventLogOptions,
): EpisodeEventLog | null {
  try {
    const path = join(runDir, EPISODE_EVENTS_FILENAME);
    if (!existsSync(path)) return null;
    const parsed = parseEpisodeEventLog(readFileSync(path, 'utf-8'), undefined, options);
    return validateEpisodeEventLog(parsed.events).valid ? parsed : null;
  } catch {
    return null;
  }
}

function episodeError(
  code: EpisodeStreamErrorCode,
  message: string,
  details?: Omit<EpisodeStreamError, 'code' | 'message'>,
): EpisodeStreamResult<never> {
  return { ok: false, error: { code, message, ...(details ?? {}) } };
}

function recoveryReason(reason: string): string {
  return truncateUtf8(redactEvidenceValue(reason), 512);
}

function genesisLog(
  sessionId: string | undefined,
  mode: EpisodeStreamLoadMode,
  reason?: string,
  options?: CreateEpisodeEventLogOptions,
  quarantineFile?: string,
): EpisodeEventLog {
  const log = createEpisodeEventLog(sessionId, options);
  appendEpisodeEvent(log, {
    kind: 'recovery',
    type: quarantineFile
      ? 'RECOVERY_GENESIS'
      : mode === 'legacy_resume'
        ? 'LEGACY_MIGRATION_GENESIS'
        : 'PIPELINE_GENESIS',
    payload:
      quarantineFile
        ? { quarantineFile, reason: recoveryReason(reason ?? 'Validation failed.') }
        : mode === 'legacy_resume'
        ? { reason: 'No episode stream existed for legacy resume.' }
        : reason
          ? { reason: recoveryReason(reason) }
          : { reason: 'New pipeline episode stream.' },
  });
  return log;
}

function loadEpisodeEventLogWithMode(
  runDir: string,
  options: EpisodeStreamLoadOptions = {},
): EpisodeStreamResult<EpisodeEventLog> {
  const mode = options.mode ?? 'resume';
  const fs = options.filesystem ?? DEFAULT_EPISODE_FILESYSTEM;
  const path = join(runDir, EPISODE_EVENTS_FILENAME);
  let present: boolean;
  try {
    present = fs.exists(path);
  } catch (error: unknown) {
    return episodeError('io_error', `Unable to inspect episode stream: ${String(error)}`);
  }

  if (!present) {
    if (mode === 'resume') {
      return episodeError('absent', `Episode stream does not exist at ${path}.`);
    }
    return { ok: true, value: genesisLog(options.sessionId, mode, undefined, options), mode };
  }

  if (mode === 'new') {
    return episodeError('already_exists', `Episode stream already exists at ${path}.`);
  }

  let raw: string;
  try {
    raw = fs.readFile(path);
  } catch (error: unknown) {
    return episodeError('io_error', `Unable to read episode stream: ${String(error)}`);
  }

  let parsed: EpisodeEventLog;
  try {
    parsed = parseEpisodeEventLog(raw, options.sessionId, options);
  } catch (error: unknown) {
    const timestamp = Date.now();
    const quarantineFile = `episode-events.corrupt.${timestamp}-${randomUUID()}.jsonl`;
    const quarantinePath = join(runDir, quarantineFile);
    try {
      fs.rename(path, quarantinePath);
    } catch (renameError: unknown) {
      return episodeError(
        'quarantine_failed',
        'Episode stream parsing failed and quarantine could not be completed; refusing recovery append.',
        { reason: recoveryReason(String(error ?? renameError)) },
      );
    }
    if (mode === 'resume') {
      return episodeError(
        'malformed',
        'Episode stream was quarantined after a parse failure; resume is fail-closed.',
        { quarantineFile, reason: recoveryReason(String(error)) },
      );
    }
    return {
      ok: true,
      value: genesisLog(options.sessionId, mode, String(error), options, quarantineFile),
      mode,
    };
  }

  const validation = validateEpisodeEventLog(parsed.events, options.sessionId);
  if (validation.valid) return { ok: true, value: parsed, mode };

  if (validation.code === 'session_mismatch') {
    return episodeError('session_mismatch', validation.error ?? 'Episode session mismatch.');
  }

  const timestamp = Date.now();
  const quarantineFile = `episode-events.corrupt.${timestamp}.jsonl`;
  const quarantinePath = join(runDir, quarantineFile);
  try {
    fs.rename(path, quarantinePath);
  } catch (error: unknown) {
    return episodeError(
      'quarantine_failed',
      'Episode stream validation failed and quarantine could not be completed; refusing recovery append.',
      { reason: recoveryReason(validation.error ?? String(error)) },
    );
  }

  if (mode === 'resume') {
    return episodeError(
      'invalid_chain',
      'Episode stream was quarantined after validation failure; resume is fail-closed.',
      { quarantineFile, reason: recoveryReason(validation.error ?? 'Validation failed.') },
    );
  }

  return {
    ok: true,
    value: genesisLog(
      options.sessionId ?? parsed.sessionId,
      mode,
      validation.error ?? 'validation failed',
      options,
      quarantineFile,
    ),
    mode,
  };
}

/** Parse and validate an episode stream without touching the filesystem. */
export function parseEpisodeEventLogResult(
  raw: string,
  options: Pick<EpisodeStreamLoadOptions, 'sessionId' | 'hashLink'> = {},
): EpisodeStreamResult<EpisodeEventLog> {
  try {
    const parsed = parseEpisodeEventLog(raw, options.sessionId, options);
    const validation = validateEpisodeEventLog(parsed.events, options.sessionId);
    if (!validation.valid) {
      return episodeError(
        validation.code === 'session_mismatch' ? 'session_mismatch' : validation.code === 'malformed' ? 'malformed' : 'invalid_chain',
        validation.error ?? 'Episode stream validation failed.',
      );
    }
    return { ok: true, value: parsed, mode: 'resume' };
  } catch (error: unknown) {
    return episodeError('malformed', `Episode stream JSONL is malformed: ${String(error)}`);
  }
}

/** Typed load boundary for all pipeline episode streams. */
export function loadEpisodeEventLogForMode(
  runDir: string,
  options: EpisodeStreamLoadOptions = {},
): EpisodeStreamResult<EpisodeEventLog> {
  return loadEpisodeEventLogWithMode(runDir, options);
}

export const loadEpisodeEventLog = loadEpisodeEventLogForMode;

/**
 * Load episode event log with hash-chain integrity validation.
 * If corrupt, quarantines the file to `episode-events.corrupt.<ts>.jsonl` and initializes
 * a new stream with a RECOVERY_GENESIS event.
 */
export function loadOrQuarantineEpisodeLog(
  runDir: string,
  sessionId?: string,
  options?: CreateEpisodeEventLogOptions,
): EpisodeEventLog {
  const result = loadEpisodeEventLogForMode(runDir, {
    ...(sessionId !== undefined ? { sessionId } : {}),
    mode: 'legacy_resume',
    ...(options?.hashLink !== undefined ? { hashLink: options.hashLink } : {}),
  });
  if (!result.ok) {
    throw new Error(`[episode-stream:${result.error.code}] ${result.error.message}`);
  }
  return result.value;
}
