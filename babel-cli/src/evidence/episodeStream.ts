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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalEventKind, CanonicalExecutorEvent } from '../executor/contracts.js';
import { EXECUTOR_EVENT_SCHEMA_VERSION } from '../executor/contracts.js';
import type { SessionEvent, SessionEventKind, SessionEventLog } from '../agent/sessionEvents.js';

export const EPISODE_EVENT_SCHEMA_VERSION = 1 as const;
export const EPISODE_EVENTS_FILENAME = 'episode-events.jsonl';

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
    case 'compaction_created':
      return { kind: 'session', type: 'compaction_created' };
    case 'turn_ended':
      return { kind: 'turn', type: 'turn_ended' };
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
    payload: input.payload ? { ...input.payload } : {},
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

export function loadEpisodeEventLogFromDir(
  runDir: string,
  options?: CreateEpisodeEventLogOptions,
): EpisodeEventLog | null {
  try {
    const path = join(runDir, EPISODE_EVENTS_FILENAME);
    if (!existsSync(path)) return null;
    return parseEpisodeEventLog(readFileSync(path, 'utf-8'), undefined, options);
  } catch {
    return null;
  }
}
