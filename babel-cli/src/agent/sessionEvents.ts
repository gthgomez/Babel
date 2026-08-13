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
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';

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
  | 'progress_recovery'
  | 'completion_decision'
  | 'model_failover'
  | 'compaction_created'
  | 'turn_ended'
  /** H2: remaining budget snapshot for resume. */
  | 'budget_snapshot'
  /** H2: approval decision boundary. */
  | 'approval_decision'
  /** H2: typed repair attempt (failure-class keyed). */
  | 'repair_attempt';

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
      batch_id?: string;
      starting_revision?: string;
      ending_revision?: string;
      changed_bytes?: number;
      status?: string;
      pre_image_hashes?: Record<string, string>;
      post_image_hashes?: Record<string, string>;
    })
  | (SessionEventBase & {
      kind: 'verifier_attempt';
      command_preview: string;
      authoritative: boolean;
      exit_code?: number;
      /** Durable revision-bound receipt used to reconstruct verifier state. */
      receipt?: BoundChatVerifierReceipt;
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
      kind: 'progress_recovery';
      intervention: string;
      score: number;
      signals: string[];
      reason?: string;
    })
  | (SessionEventBase & {
      kind: 'completion_decision';
      requested_outcome: string;
      final_outcome: string;
      allowed: boolean;
      reason: string;
      evidence_refs: string[];
      policy_version: string;
    })
  | (SessionEventBase & {
      kind: 'model_failover';
      original_model?: string;
      original_provider?: string;
      new_model?: string;
      new_provider?: string;
      reason?: string;
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
    })
  | (SessionEventBase & {
      kind: 'budget_snapshot';
      turns_used?: number;
      turns_remaining?: number | null;
      tokens_used?: number;
      tokens_remaining?: number | null;
      repair_attempts_used?: number;
      repair_attempts_remaining?: number | null;
      infra_retries_used?: number;
      infra_retries_remaining?: number | null;
    })
  | (SessionEventBase & {
      kind: 'approval_decision';
      request_id: string;
      decision: 'deny' | 'allow_once' | 'allow_session' | 'narrow_rule';
      scope?: string;
    })
  | (SessionEventBase & {
      kind: 'repair_attempt';
      failure_class: string;
      attempt: number;
      detail?: string;
    });

export interface SessionEventLog {
  schema_version: typeof SESSION_EVENT_SCHEMA_VERSION;
  session_id: string;
  events: SessionEvent[];
  nextSeq: number;
  /** Paths already flushed to disk (for dual-write append efficiency). */
  flushedThroughSeq: number;
}

export type SessionEventLogLoadResult =
  | { kind: 'missing'; path: string }
  | { kind: 'valid'; path: string; log: SessionEventLog }
  | { kind: 'invalid'; path: string; error: Error }

export type SessionEventLogRestoreCode = 'SESSION_EVENT_LOG_MISSING' | 'SESSION_EVENT_LOG_INVALID'

export class SessionEventLogRestoreError extends Error {
  readonly code: SessionEventLogRestoreCode

  constructor(code: SessionEventLogRestoreCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SessionEventLogRestoreError'
    this.code = code
  }
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
    receipt?: BoundChatVerifierReceipt;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'verifier_attempt',
    turn_id: input.turn_id,
    command_preview: input.command_preview.slice(0, 500),
    authoritative: input.authoritative,
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
    ...(input.receipt !== undefined ? { receipt: structuredClone(input.receipt) } : {}),
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

export function recordPolicyIntervened(
  log: SessionEventLog,
  turnId: string,
  input: { source: string; action: string; detail?: string }
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'policy_intervened',
    turn_id: turnId,
    source: input.source,
    action: input.action,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
}

/** Persist one normalized progress/recovery decision for replay and transports. */
export function recordProgressRecovery(
  log: SessionEventLog,
  turnId: string,
  input: { intervention: string; score: number; signals: string[]; reason?: string },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'progress_recovery',
    turn_id: turnId,
    intervention: input.intervention,
    score: input.score,
    signals: [...input.signals],
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

/** Persist the shared completion authority decision as canonical session evidence. */
export function recordCompletionDecision(
  log: SessionEventLog,
  turnId: string,
  input: {
    requestedOutcome: string;
    finalOutcome: string;
    allowed: boolean;
    reason: string;
    evidenceRefs: string[];
    policyVersion: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'completion_decision',
    turn_id: turnId,
    requested_outcome: input.requestedOutcome,
    final_outcome: input.finalOutcome,
    allowed: input.allowed,
    reason: input.reason,
    evidence_refs: [...input.evidenceRefs],
    policy_version: input.policyVersion,
  });
}

export function recordModelFailover(
  log: SessionEventLog,
  turnId: string,
  input: { original_model?: string; original_provider?: string; new_model?: string; new_provider?: string; reason?: string }
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'model_failover',
    turn_id: turnId,
    ...(input.original_model !== undefined ? { original_model: input.original_model } : {}),
    ...(input.original_provider !== undefined ? { original_provider: input.original_provider } : {}),
    ...(input.new_model !== undefined ? { new_model: input.new_model } : {}),
    ...(input.new_provider !== undefined ? { new_provider: input.new_provider } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

/** H2: durable budget snapshot for resume. */
export function recordBudgetSnapshot(
  log: SessionEventLog,
  turnId: string | null,
  input: {
    turns_used?: number;
    turns_remaining?: number | null;
    tokens_used?: number;
    tokens_remaining?: number | null;
    repair_attempts_used?: number;
    repair_attempts_remaining?: number | null;
    infra_retries_used?: number;
    infra_retries_remaining?: number | null;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'budget_snapshot',
    turn_id: turnId,
    ...input,
  });
}

/** H2: approval decision boundary. */
export function recordApprovalDecision(
  log: SessionEventLog,
  turnId: string | null,
  input: {
    request_id: string;
    decision: 'deny' | 'allow_once' | 'allow_session' | 'narrow_rule';
    scope?: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'approval_decision',
    turn_id: turnId,
    request_id: input.request_id,
    decision: input.decision,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  });
}

/** H2: repair attempt keyed by failure class. */
export function recordRepairAttempt(
  log: SessionEventLog,
  turnId: string | null,
  input: { failure_class: string; attempt: number; detail?: string },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'repair_attempt',
    turn_id: turnId,
    failure_class: input.failure_class,
    attempt: input.attempt,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
}

/** H1: durable compaction boundary on the session event stream. */
export function recordCompactionCreated(
  log: SessionEventLog,
  turnId: string | null,
  input: {
    preserved_tool_call_ids?: string[];
    content_preview?: string;
    strategy?: string;
    tokens_before?: number;
    tokens_after?: number;
    status?: string;
  } = {},
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'compaction_created',
    turn_id: turnId,
    ...(input.preserved_tool_call_ids !== undefined
      ? { preserved_tool_call_ids: [...input.preserved_tool_call_ids] }
      : {}),
    ...(input.content_preview !== undefined ? { content_preview: input.content_preview } : {}),
    ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
    ...(input.tokens_before !== undefined ? { tokens_before: input.tokens_before } : {}),
    ...(input.tokens_after !== undefined ? { tokens_after: input.tokens_after } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
}

export function recordMutationBatch(
  log: SessionEventLog,
  turnId: string,
  input: {
    paths: string[];
    pre_hash?: string;
    post_hash?: string;
    batch_id?: string;
    starting_revision?: string;
    ending_revision?: string;
    changed_bytes?: number;
    status?: string;
    pre_image_hashes?: Record<string, string>;
    post_image_hashes?: Record<string, string>;
  },
): void {
  appendSessionEvent(log, {
    kind: 'mutation_batch',
    turn_id: turnId,
    paths: input.paths,
    pre_hash: input.pre_hash,
    post_hash: input.post_hash,
    ...(input.batch_id !== undefined ? { batch_id: input.batch_id } : {}),
    ...(input.starting_revision !== undefined ? { starting_revision: input.starting_revision } : {}),
    ...(input.ending_revision !== undefined ? { ending_revision: input.ending_revision } : {}),
    ...(input.changed_bytes !== undefined ? { changed_bytes: input.changed_bytes } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.pre_image_hashes !== undefined ? { pre_image_hashes: { ...input.pre_image_hashes } } : {}),
    ...(input.post_image_hashes !== undefined ? { post_image_hashes: { ...input.post_image_hashes } } : {}),
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
  const knownKinds = new Set<SessionEventKind>([
    'user_submitted', 'model_started', 'tool_proposed', 'tool_started',
    'tool_completed', 'tool_failed', 'tool_cancelled', 'mutation_batch',
    'verifier_attempt', 'gate_decision', 'policy_intervened', 'progress_recovery',
    'completion_decision', 'model_failover', 'compaction_created', 'turn_ended',
    'budget_snapshot', 'approval_decision', 'repair_attempt',
  ])

  for (const [index, line] of lines.entries()) {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Invalid session event at line ${index + 1}: expected an object`)
    }
    const ev = value as Record<string, unknown>
    if (ev.schema_version !== SESSION_EVENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported session event schema: ${String(ev.schema_version)} (expected ${SESSION_EVENT_SCHEMA_VERSION})`,
      );
    }
    if (typeof ev.event_id !== 'string' || ev.event_id.length === 0) {
      throw new Error(`Invalid session event at line ${index + 1}: event_id is required`)
    }
    if (typeof ev.session_id !== 'string' || ev.session_id.length === 0) {
      throw new Error(`Invalid session event at line ${index + 1}: session_id is required`)
    }
    if (typeof ev.turn_id !== 'string' && ev.turn_id !== null) {
      throw new Error(`Invalid session event at line ${index + 1}: turn_id is invalid`)
    }
    if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq < 0 || ev.seq <= maxSeq) {
      throw new Error(`Invalid session event at line ${index + 1}: seq must increase monotonically`)
    }
    if (typeof ev.ts !== 'string' || ev.ts.length === 0) {
      throw new Error(`Invalid session event at line ${index + 1}: ts is required`)
    }
    if (typeof ev.kind !== 'string' || !knownKinds.has(ev.kind as SessionEventKind)) {
      throw new Error(`Invalid session event at line ${index + 1}: unknown kind ${String(ev.kind)}`)
    }
    const required: Record<SessionEventKind, string[]> = {
      user_submitted: ['task_preview'], model_started: [], tool_proposed: ['tool_call_id', 'tool_name', 'idempotency_key'],
      tool_started: ['tool_call_id', 'tool_name', 'idempotency_key'], tool_completed: ['tool_call_id', 'tool_name', 'idempotency_key'],
      tool_failed: ['tool_call_id', 'tool_name', 'idempotency_key'], tool_cancelled: ['tool_call_id', 'tool_name', 'idempotency_key'],
      mutation_batch: ['paths'], verifier_attempt: ['command_preview', 'authoritative'], gate_decision: ['decision'],
      policy_intervened: ['source', 'action'], progress_recovery: ['intervention', 'score', 'signals'],
      completion_decision: ['requested_outcome', 'final_outcome', 'allowed', 'reason', 'evidence_refs', 'policy_version'],
      model_failover: [], compaction_created: [], turn_ended: ['outcome', 'status'], budget_snapshot: [],
      approval_decision: ['request_id', 'decision'], repair_attempt: ['failure_class', 'attempt'],
    }
    const arrayFields = new Set(['paths', 'signals', 'evidence_refs'])
    const booleanFields = new Set(['authoritative', 'allowed'])
    const numberFields = new Set(['score', 'attempt'])
    for (const field of required[ev.kind as SessionEventKind]) {
      if (!(field in ev)) throw new Error(`Invalid session event at line ${index + 1}: ${field} is required`)
      const fieldValue = ev[field]
      if (arrayFields.has(field) && !Array.isArray(fieldValue)) {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be an array`)
      }
      if (booleanFields.has(field) && typeof fieldValue !== 'boolean') {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be boolean`)
      }
      if (numberFields.has(field) && typeof fieldValue !== 'number') {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be a number`)
      }
      if (!arrayFields.has(field) && !booleanFields.has(field) && !numberFields.has(field) && typeof fieldValue !== 'string') {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be a string`)
      }
    }
    if (sessionId && ev.session_id !== sessionId) {
      throw new Error(`Invalid session event at line ${index + 1}: session_id changed`)
    }
    if (!sessionId) sessionId = ev.session_id
    events.push(ev as unknown as SessionEvent)
    maxSeq = ev.seq
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

/**
 * Flush a required session boundary. Unlike the legacy best-effort helper,
 * this throws when the durable write cannot be completed.
 */
export function flushSessionEventLogStrict(
  runDir: string,
  log: SessionEventLog,
): { path: string; wrote: number } {
  const result = flushSessionEventLog(runDir, log);
  if (result.error) {
    throw new Error(`session event persistence failed: ${result.error}`);
  }
  return result;
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
  const result = inspectSessionEventLogFromDir(runDir)
  return result.kind === 'valid' ? result.log : null
}

export function inspectSessionEventLogFromDir(runDir: string): SessionEventLogLoadResult {
  const path = join(runDir, SESSION_EVENTS_FILENAME)
  if (!existsSync(path)) return { kind: 'missing', path }
  try {
    return { kind: 'valid', path, log: parseSessionEventLog(readFileSync(path, 'utf-8')) }
  } catch (error) {
    return {
      kind: 'invalid',
      path,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export function loadSessionEventLogForResume(runDir: string, sessionId: string): SessionEventLog {
  const result = inspectSessionEventLogFromDir(runDir)
  if (result.kind === 'missing') {
    throw new SessionEventLogRestoreError(
      'SESSION_EVENT_LOG_MISSING',
      `Cannot resume ${sessionId}: session-events.jsonl is missing`,
    )
  }
  if (result.kind === 'invalid') {
    throw new SessionEventLogRestoreError(
      'SESSION_EVENT_LOG_INVALID',
      `Cannot resume ${sessionId}: session-events.jsonl is invalid (${result.error.message})`,
      { cause: result.error },
    )
  }
  return result.log
}

export function loadSessionEventLogIfPresentForResume(
  runDir: string,
  sessionId: string,
): SessionEventLog | null {
  const result = inspectSessionEventLogFromDir(runDir)
  if (result.kind === 'missing') return null
  if (result.kind === 'invalid') {
    throw new SessionEventLogRestoreError(
      'SESSION_EVENT_LOG_INVALID',
      `Cannot resume ${sessionId}: session-events.jsonl is invalid (${result.error.message})`,
      { cause: result.error },
    )
  }
  return result.log
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
