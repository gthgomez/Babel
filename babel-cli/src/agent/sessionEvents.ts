/**
 * SessionEventV1 — append-only durable session event log (W2 / roadmap PR-E).
 *
 * Dual-writes next to the existing thread event log under chat session run dirs.
 * JSONL first (not SQLite). Complements ThreadEventLog: finer tool lifecycle
 * kinds for kill/resume settlement without replacing thread_events.json yet.
 *
 * Roadmap: docs/plans/BABEL_RELIABLE_EXECUTOR_ROADMAP_2026-08-01.md §7.1
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalOutcome } from '../schemas/agentContracts.js';

export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;
export const SESSION_EVENTS_FILENAME = 'session-events.jsonl';

export type SessionEventKind =
  | 'user_submitted'
  | 'model_started'
  | 'tool_proposed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'tool_cancelled'
  | 'mutation_batch'
  | 'verifier_attempt'
  | 'gate_decision'
  | 'policy_intervened'
  | 'compaction_created'
  | 'turn_ended';

export interface SessionEventBase {
  schema_version: typeof SESSION_EVENT_SCHEMA_VERSION;
  event_id: string;
  session_id: string;
  turn_id: string | null;
  seq: number;
  ts: string;
  kind: SessionEventKind;
}

export type SessionEvent =
  | (SessionEventBase & {
      kind: 'user_submitted';
      task_preview: string;
      model?: string;
      provider?: string;
      project_root?: string;
      task_class?: string;
    })
  | (SessionEventBase & {
      kind: 'model_started';
      model?: string;
      provider?: string;
    })
  | (SessionEventBase & {
      kind: 'tool_proposed';
      tool_call_id: string;
      tool_name: string;
      /** Stable idempotency key for settle/resume (defaults to tool_call_id). */
      idempotency_key: string;
      args_digest?: string;
    })
  | (SessionEventBase & {
      kind: 'tool_started';
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
    })
  | (SessionEventBase & {
      kind: 'tool_completed';
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
      exit_code?: number;
      output_digest?: string;
    })
  | (SessionEventBase & {
      kind: 'tool_failed';
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
      exit_code?: number;
      error_preview?: string;
    })
  | (SessionEventBase & {
      kind: 'tool_cancelled';
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
      reason?: string;
    })
  | (SessionEventBase & {
      kind: 'mutation_batch';
      paths: string[];
      pre_hash?: string;
      post_hash?: string;
    })
  | (SessionEventBase & {
      kind: 'verifier_attempt';
      command_preview: string;
      authoritative: boolean;
      exit_code?: number;
    })
  | (SessionEventBase & {
      kind: 'gate_decision';
      decision: string;
      detail?: string;
    })
  | (SessionEventBase & {
      kind: 'policy_intervened';
      source: string;
      action: string;
      detail?: string;
    })
  | (SessionEventBase & {
      kind: 'compaction_created';
      preserved_tool_call_ids?: string[];
      content_preview?: string;
    })
  | (SessionEventBase & {
      kind: 'turn_ended';
      outcome: TerminalOutcome;
      status: string;
    });

export interface SessionEventLog {
  schema_version: typeof SESSION_EVENT_SCHEMA_VERSION;
  session_id: string;
  events: SessionEvent[];
  nextSeq: number;
  /** Paths already flushed to disk (for dual-write append efficiency). */
  flushedThroughSeq: number;
}

export function createSessionEventLog(sessionId?: string): SessionEventLog {
  return {
    schema_version: SESSION_EVENT_SCHEMA_VERSION,
    session_id: sessionId ?? randomUUID(),
    events: [],
    nextSeq: 0,
    flushedThroughSeq: -1,
  };
}

function baseFields(
  log: SessionEventLog,
  kind: SessionEventKind,
  turnId: string | null,
): SessionEventBase {
  const seq = log.nextSeq++;
  return {
    schema_version: SESSION_EVENT_SCHEMA_VERSION,
    event_id: randomUUID(),
    session_id: log.session_id,
    turn_id: turnId,
    seq,
    ts: new Date().toISOString(),
    kind,
  };
}

/** Append a kind-specific session event; returns the full record. */
export function appendSessionEvent(
  log: SessionEventLog,
  event: { kind: SessionEventKind; turn_id?: string | null } & Record<string, unknown>,
): SessionEvent {
  const turnId = event.turn_id === undefined ? null : event.turn_id;
  const base = baseFields(log, event.kind, turnId);
  const { kind: _k, turn_id: _t, ...rest } = event;
  const full = { ...rest, ...base } as SessionEvent;
  log.events.push(full);
  return full;
}

export function recordUserSubmitted(
  log: SessionEventLog,
  input: {
    turn_id: string;
    task: string;
    model?: string;
    provider?: string;
    projectRoot?: string;
    taskClass?: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'user_submitted',
    turn_id: input.turn_id,
    task_preview: input.task.slice(0, 500),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.projectRoot !== undefined ? { project_root: input.projectRoot } : {}),
    ...(input.taskClass !== undefined ? { task_class: input.taskClass } : {}),
  });
}

export function recordModelStarted(
  log: SessionEventLog,
  input: { turn_id: string; model?: string; provider?: string },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'model_started',
    turn_id: input.turn_id,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
  });
}

export function recordToolProposed(
  log: SessionEventLog,
  input: {
    turn_id: string;
    tool_call_id: string;
    tool_name: string;
    idempotency_key?: string;
    args_digest?: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'tool_proposed',
    turn_id: input.turn_id,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    idempotency_key: input.idempotency_key ?? input.tool_call_id,
    ...(input.args_digest !== undefined ? { args_digest: input.args_digest } : {}),
  });
}

export function recordToolStarted(
  log: SessionEventLog,
  input: {
    turn_id: string;
    tool_call_id: string;
    tool_name: string;
    idempotency_key?: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'tool_started',
    turn_id: input.turn_id,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    idempotency_key: input.idempotency_key ?? input.tool_call_id,
  });
}

export function recordToolTerminal(
  log: SessionEventLog,
  input: {
    turn_id: string;
    tool_call_id: string;
    tool_name: string;
    idempotency_key?: string;
    exit_code?: number;
    content?: string;
    failed?: boolean;
    cancelled?: boolean;
    reason?: string;
  },
): SessionEvent {
  const key = input.idempotency_key ?? input.tool_call_id;
  if (input.cancelled) {
    return appendSessionEvent(log, {
      kind: 'tool_cancelled',
      turn_id: input.turn_id,
      tool_call_id: input.tool_call_id,
      tool_name: input.tool_name,
      idempotency_key: key,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }
  const digest =
    input.content !== undefined ? shortDigest(input.content) : undefined;
  if (input.failed || (input.exit_code !== undefined && input.exit_code !== 0)) {
    return appendSessionEvent(log, {
      kind: 'tool_failed',
      turn_id: input.turn_id,
      tool_call_id: input.tool_call_id,
      tool_name: input.tool_name,
      idempotency_key: key,
      ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
      ...(input.content !== undefined
        ? { error_preview: input.content.slice(0, 240) }
        : {}),
    });
  }
  return appendSessionEvent(log, {
    kind: 'tool_completed',
    turn_id: input.turn_id,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    idempotency_key: key,
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
    ...(digest !== undefined ? { output_digest: digest } : {}),
  });
}

export function recordVerifierAttempt(
  log: SessionEventLog,
  input: {
    turn_id: string;
    command_preview: string;
    authoritative: boolean;
    exit_code?: number;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'verifier_attempt',
    turn_id: input.turn_id,
    command_preview: input.command_preview.slice(0, 500),
    authoritative: input.authoritative,
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
  });
}

export function recordTurnEnded(
  log: SessionEventLog,
  input: { turn_id: string; outcome: TerminalOutcome; status: string },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'turn_ended',
    turn_id: input.turn_id,
    outcome: input.outcome,
    status: input.status,
  });
}

export function shortDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Serialize all events as JSONL (one object per line). */
export function serializeSessionEventLog(log: SessionEventLog): string {
  return log.events.map((e) => JSON.stringify(e)).join('\n') + (log.events.length ? '\n' : '');
}

/** Parse JSONL session event log; skips blank lines; rejects wrong schema. */
export function parseSessionEventLog(
  raw: string,
  sessionIdFallback?: string,
): SessionEventLog {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const events: SessionEvent[] = [];
  let sessionId = sessionIdFallback ?? '';
  let maxSeq = -1;
  for (const line of lines) {
    const ev = JSON.parse(line) as SessionEvent;
    if (ev.schema_version !== SESSION_EVENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported session event schema: ${String(ev.schema_version)} (expected ${SESSION_EVENT_SCHEMA_VERSION})`,
      );
    }
    if (!sessionId) sessionId = ev.session_id;
    events.push(ev);
    if (ev.seq > maxSeq) maxSeq = ev.seq;
  }
  return {
    schema_version: SESSION_EVENT_SCHEMA_VERSION,
    session_id: sessionId || randomUUID(),
    events,
    nextSeq: maxSeq + 1,
    flushedThroughSeq: maxSeq,
  };
}

/**
 * Dual-write: append newly added events to session-events.jsonl under runDir.
 * Best-effort; never throws to callers of sync path (returns error string).
 */
export function flushSessionEventLog(
  runDir: string,
  log: SessionEventLog,
): { path: string; wrote: number; error?: string } {
  const path = join(runDir, SESSION_EVENTS_FILENAME);
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

/** Full rewrite (tests / recovery); sets flushedThroughSeq to last event. */
export function rewriteSessionEventLog(runDir: string, log: SessionEventLog): string {
  const path = join(runDir, SESSION_EVENTS_FILENAME);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path, serializeSessionEventLog(log), 'utf-8');
  log.flushedThroughSeq =
    log.events.length > 0 ? log.events[log.events.length - 1]!.seq : -1;
  return path;
}

export function loadSessionEventLogFromDir(runDir: string): SessionEventLog | null {
  try {
    const path = join(runDir, SESSION_EVENTS_FILENAME);
    if (!existsSync(path)) return null;
    return parseSessionEventLog(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Idempotency keys that already have a terminal tool event (completed/failed/cancelled). */
export function completedToolIdempotencyKeys(log: SessionEventLog): Set<string> {
  const done = new Set<string>();
  for (const e of log.events) {
    if (
      e.kind === 'tool_completed' ||
      e.kind === 'tool_failed' ||
      e.kind === 'tool_cancelled'
    ) {
      done.add(e.idempotency_key);
    }
  }
  return done;
}

/** Proposed keys that never reached a terminal event (interrupted mid-tool). */
export function interruptedToolIdempotencyKeys(log: SessionEventLog): string[] {
  const proposed = new Map<string, string>();
  const done = completedToolIdempotencyKeys(log);
  for (const e of log.events) {
    if (e.kind === 'tool_proposed' || e.kind === 'tool_started') {
      proposed.set(e.idempotency_key, e.tool_call_id);
    }
  }
  const out: string[] = [];
  for (const [key] of proposed) {
    if (!done.has(key)) out.push(key);
  }
  return out;
}

/** Lookup tool_name for an idempotency key from proposed/started events. */
export function toolMetaForIdempotencyKey(
  log: SessionEventLog,
  key: string,
): { tool_call_id: string; tool_name: string; turn_id: string | null } | null {
  for (let i = log.events.length - 1; i >= 0; i--) {
    const e = log.events[i]!;
    if (
      (e.kind === 'tool_proposed' || e.kind === 'tool_started') &&
      e.idempotency_key === key
    ) {
      return {
        tool_call_id: e.tool_call_id,
        tool_name: e.tool_name,
        turn_id: e.turn_id,
      };
    }
  }
  return null;
}

/**
 * W2.2: on resume after kill, mark in-flight tools as cancelled (not success).
 * Idempotent — skips keys that already have a terminal event.
 */
export function markInterruptedToolsOnResume(
  log: SessionEventLog,
  reason = 'interrupted_mid_tool',
): SessionEvent[] {
  const marked: SessionEvent[] = [];
  for (const key of interruptedToolIdempotencyKeys(log)) {
    const meta = toolMetaForIdempotencyKey(log, key);
    if (!meta) continue;
    marked.push(
      recordToolTerminal(log, {
        turn_id: meta.turn_id ?? 'resume',
        tool_call_id: meta.tool_call_id,
        tool_name: meta.tool_name,
        idempotency_key: key,
        cancelled: true,
        reason,
      }),
    );
  }
  return marked;
}

/** True when this tool already has a terminal settle event — resume must not re-exec. */
export function shouldSkipToolReExec(log: SessionEventLog, idempotencyKey: string): boolean {
  return completedToolIdempotencyKeys(log).has(idempotencyKey);
}

/**
 * Partition planned tools into skip (already settled) vs execute (need run).
 * Used by kill/resume and settle protocol tests.
 */
export function planToolSettle(
  log: SessionEventLog,
  tools: Array<{ idempotency_key: string; tool_call_id: string; tool_name: string }>,
): {
  skip: Array<{ idempotency_key: string; tool_call_id: string; tool_name: string }>;
  execute: Array<{ idempotency_key: string; tool_call_id: string; tool_name: string }>;
  interrupted: string[];
} {
  const done = completedToolIdempotencyKeys(log);
  const interrupted = interruptedToolIdempotencyKeys(log);
  const skip: typeof tools = [];
  const execute: typeof tools = [];
  for (const t of tools) {
    if (done.has(t.idempotency_key)) skip.push(t);
    else execute.push(t);
  }
  return { skip, execute, interrupted };
}
