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
import { classifyToolEffect, type ToolEffectClass } from '../executor/contracts.js';
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';
import {
  buildToolLifecycleCausalityDiagnostic,
  SessionEventLifecycleCausalityError,
} from './sessionEventDiagnostics.js';
import {
  createBdnsObservationBus,
  type BdnsObservationBus,
} from '../diagnostics/bdns/observationBus.js';

export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;
export const SESSION_EVENTS_FILENAME = 'session-events.jsonl';

type SessionEventObservationHook = (event: SessionEvent) => void | Promise<void>;
const sessionEventObservationBus = createBdnsObservationBus<SessionEvent>({ maxQueue: 256 });
let sessionEventObservationUnsubscribe: (() => void) | null = null;

/**
 * Optional TUI observation hook. Must not throw into the durable log path.
 *
 * @param hook Callback receiving the newly appended event, or null to clear
 */
export function setSessionEventObservationHook(hook: SessionEventObservationHook | null): void {
  sessionEventObservationUnsubscribe?.();
  sessionEventObservationUnsubscribe = hook
    ? sessionEventObservationBus.subscribe({ id: 'legacy-tui-observer', onObservation: (observation) => hook(observation.payload) })
    : null;
}

/** Subscribe to bounded asynchronous canonical session-event observations. */
export function subscribeSessionEventObservation(
  hook: SessionEventObservationHook,
  options: { id?: string; maxQueue?: number } = {},
): () => void {
  return sessionEventObservationBus.subscribe({
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
    onObservation: (observation) => hook(observation.payload),
  });
}

/** Flush the bounded global compatibility observation queue before shutdown. */
export function flushSessionEventObservations(timeoutMs = 1_000): Promise<boolean> {
  return sessionEventObservationBus.flush(timeoutMs).then(() => true);
}

/** Durable classification of a tool that was interrupted by process loss. */
export type InterruptedToolRecoveryState = 'TOOL_NOT_STARTED' | 'TOOL_OUTCOME_UNKNOWN';

/** Operator/model-safe repair instruction projected from durable tool lifecycle evidence. */
export interface InterruptedToolRecovery {
  idempotencyKey: string;
  toolCallId: string;
  toolName: string;
  effectClass: ToolEffectClass;
  state: InterruptedToolRecoveryState;
  reconciliation: 'reconsider_and_authorize' | 'inspect_or_reconcile_before_retry' | 'manual_review_no_auto_retry';
  operationFingerprint?: string;
}


export type SessionEventKind =
  | 'user_submitted'
  | 'model_started'
  | 'provider_retry_scheduled'
  | 'provider_retry_settled'
  | 'tool_proposed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'tool_cancelled'
  | 'recovery_reconciled'
  | 'mutation_batch'
  | 'verifier_attempt'
  | 'gate_decision'
  | 'policy_intervened'
  | 'progress_recovery'
  | 'completion_decision'
  | 'model_failover'
  | 'compaction_started'
  | 'compaction_summary'
  | 'compaction_committed'
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
      kind: 'provider_retry_scheduled';
      provider: 'deepinfra' | 'deepseek';
      model: string;
      attempt: number;
      reason: 'transport' | 'timeout' | 'rate_limit' | 'server_error' | 'stream_idle';
      backoff_ms: number;
    })
  | (SessionEventBase & {
      kind: 'provider_retry_settled';
      provider: 'deepinfra' | 'deepseek';
      model: string;
      attempt: number;
      outcome: 'succeeded' | 'failed' | 'cancelled';
    })
  | (SessionEventBase & {
      kind: 'tool_proposed';
      tool_call_id: string;
      tool_name: string;
      /** Stable idempotency key for settle/resume (defaults to tool_call_id). */
      idempotency_key: string;
      effect_class?: ToolEffectClass;
      args_digest?: string;
      action_index?: number;
      batch_id?: string;
      target_summary?: string;
    })
  | (SessionEventBase & {
      kind: 'tool_started';
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
      effect_class?: ToolEffectClass;
      action_index?: number;
      batch_id?: string;
      target_summary?: string;
    })
  | (SessionEventBase & {
      kind: 'tool_completed';
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
      exit_code?: number;
      output_digest?: string;
      action_index?: number;
      batch_id?: string;
      target_summary?: string;
    })
  | (SessionEventBase & {
      kind: 'tool_failed';
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
      exit_code?: number;
      error_preview?: string;
      action_index?: number;
      batch_id?: string;
      target_summary?: string;
    })
  | (SessionEventBase & {
      kind: 'tool_cancelled';
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
      reason?: string;
      recovery_state?: InterruptedToolRecoveryState;
      effect_class?: ToolEffectClass;
      reconciliation?: InterruptedToolRecovery['reconciliation'];
      args_digest?: string;
      action_index?: number;
      batch_id?: string;
      target_summary?: string;
    })
  | (SessionEventBase & {
      /** Explicit, auditable authorization to retry one recovered unknown effect. */
      kind: 'recovery_reconciled';
      recovered_idempotency_key: string;
      operation_fingerprint: string;
      /** Opaque operator/audit reference only; never free-form reconciliation contents. */
      reconciliation_ref: string;
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
      kind: 'compaction_started';
      operation_id: string;
      strategy: string;
      replaces_thread_seq_start: number;
      replaces_thread_seq_end: number;
      replaces_message_count: number;
    })
  | (SessionEventBase & {
      kind: 'compaction_summary';
      operation_id: string;
      capsule_digest: string;
      raw_observation_refs: string[];
      preserved_tool_call_ids: string[];
    })
  | (SessionEventBase & {
      kind: 'compaction_committed';
      operation_id: string;
      thread_event_id: string;
      capsule_digest: string;
      replaces_thread_seq_start: number;
      replaces_thread_seq_end: number;
      replaces_message_count: number;
      preserved_tool_call_ids: string[];
    })  | (SessionEventBase & {
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

/** Stable, content-free identity for matching a resumed tool request to durable evidence. */
export function operationFingerprint(toolName: string, args: unknown): string {
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  };
  return createHash('sha256').update(`${toolName}\n${stable(args)}`).digest('hex');
}

export interface RecoveredOutcomeReconciliationAuthorization {
  recovered_idempotency_key: string;
  operation_fingerprint: string;
  reconciliation_ref: string;
}

const RECOVERY_OPERATION_FINGERPRINT = /^[a-f0-9]{64}$/;
const RECOVERY_REFERENCE = /^[A-Za-z0-9._:/#-]{1,160}$/;

function assertRecoveryAuthorizationFields(
  authorization: RecoveredOutcomeReconciliationAuthorization,
): void {
  if (typeof authorization.recovered_idempotency_key !== 'string' || authorization.recovered_idempotency_key.trim().length === 0) {
    throw new Error('recovered_idempotency_key must be a non-empty durable id');
  }
  if (!RECOVERY_OPERATION_FINGERPRINT.test(authorization.operation_fingerprint)) {
    throw new Error('operation_fingerprint must be a SHA-256 hex digest');
  }
  if (!RECOVERY_REFERENCE.test(authorization.reconciliation_ref)) {
    throw new Error('reconciliation_ref must be an opaque, non-secret audit reference');
  }
}

function assertRecoveryReconciliationCausality(
  priorEvents: readonly SessionEvent[],
  authorization: RecoveredOutcomeReconciliationAuthorization,
  subject: string,
): void {
  assertRecoveryAuthorizationFields(authorization);
  const matchingCancellations: Array<{
    cancellation: Extract<SessionEvent, { kind: 'tool_cancelled' }>;
    index: number;
  }> = [];
  for (const [index, event] of priorEvents.entries()) {
    if (
      event.kind === 'tool_cancelled' &&
      event.recovery_state === 'TOOL_OUTCOME_UNKNOWN' &&
      event.idempotency_key === authorization.recovered_idempotency_key &&
      event.args_digest === authorization.operation_fingerprint
    ) {
      matchingCancellations.push({ cancellation: event, index });
    }
  }
  if (matchingCancellations.length !== 1) {
    throw new Error(`${subject}: recovery_reconciled must authorize exactly one prior TOOL_OUTCOME_UNKNOWN cancellation`);
  }

  const { cancellation, index: cancellationIndex } = matchingCancellations[0]!;
  if (
    cancellation.idempotency_key.trim().length === 0 ||
    cancellation.tool_call_id.trim().length === 0 ||
    cancellation.tool_name.trim().length === 0
  ) {
    throw new Error(`${subject}: recovered tool identifiers must be non-empty`);
  }
  if (cancellation.effect_class !== 'non_idempotent_local_effect' && cancellation.effect_class !== 'external_side_effect') {
    throw new Error(`${subject}: recovery_reconciled cancellation effect_class is not eligible for authorization`);
  }
  const lifecycle = priorEvents.slice(0, cancellationIndex);
  const sameOperation = (event: Extract<SessionEvent, { kind: 'tool_proposed' | 'tool_started' | 'tool_completed' | 'tool_failed' | 'tool_cancelled' }>): boolean =>
    event.idempotency_key === cancellation.idempotency_key &&
    event.tool_call_id === cancellation.tool_call_id &&
    event.tool_name === cancellation.tool_name;
  const matchingProposals = lifecycle.filter(
    (event): event is Extract<SessionEvent, { kind: 'tool_proposed' }> => event.kind === 'tool_proposed' && sameOperation(event),
  );
  const matchingStarts = lifecycle.filter(
    (event): event is Extract<SessionEvent, { kind: 'tool_started' }> => event.kind === 'tool_started' && sameOperation(event),
  );
  const isTerminalForOperation = (event: SessionEvent): boolean =>
    (event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled') &&
    sameOperation(event);
  const hasPriorTerminal = lifecycle.some(isTerminalForOperation);
  const hasTerminalAfterUnknownCancellation = priorEvents
    .slice(cancellationIndex + 1)
    .some(isTerminalForOperation);
  if (
    matchingProposals.length !== 1 ||
    matchingStarts.length !== 1 ||
    matchingProposals[0]!.args_digest !== authorization.operation_fingerprint ||
    hasPriorTerminal
  ) {
    throw new Error(`${subject}: recovery_reconciled requires one prior matching tool_proposed, tool_started, and no earlier terminal`);
  }
  if (hasTerminalAfterUnknownCancellation) {
    throw new Error(`${subject}: recovery_reconciled cannot follow another terminal after the recovered unknown cancellation`);
  }
  if (priorEvents.some(
    (event) =>
      event.kind === 'recovery_reconciled' &&
      event.recovered_idempotency_key === authorization.recovered_idempotency_key &&
      event.operation_fingerprint === authorization.operation_fingerprint,
  )) {
    throw new Error(`${subject}: recovery_reconciled authorization is duplicated`);
  }
}

/** Validate a new authorization before it reaches the append-only session log. */
export function assertRecoveredOutcomeReconciliationAuthorization(
  log: Pick<SessionEventLog, 'events'>,
  authorization: RecoveredOutcomeReconciliationAuthorization,
): void {
  assertRecoveryReconciliationCausality(log.events, authorization, 'Invalid recovery authorization');
}

/** Validate every tool lifecycle before a restoration path consumes in-memory durable records. */
export function assertSessionEventToolLifecycleCausalities(
  log: Pick<SessionEventLog, 'events'>,
): void {
  for (const [index, event] of log.events.entries()) {
    if (!isToolLifecycleEvent(event)) continue;
    assertSessionEventToolLifecycleCausality(
      log.events.slice(0, index),
      event,
      `Invalid session event at seq ${event.seq}`,
    );
  }
}
/** Validate all already-persisted authorization lines before a resume consumes them. */
export function assertSessionEventRecoveryReconciliationCausality(
  log: Pick<SessionEventLog, 'events'>,
): void {
  for (const [index, event] of log.events.entries()) {
    if (event.kind !== 'recovery_reconciled') continue;
    assertRecoveryReconciliationCausality(log.events.slice(0, index), event, `Invalid session event at seq ${event.seq}`);
  }
}

/** Append explicit, durable authorization after external inspection/reconciliation. */
export function recordRecoveredOutcomeReconciled(
  log: SessionEventLog,
  input: RecoveredOutcomeReconciliationAuthorization & { turn_id: string | null },
): SessionEvent {
  assertRecoveredOutcomeReconciliationAuthorization(log, input);
  return appendSessionEvent(log, {
    kind: 'recovery_reconciled',
    ...input,
  });
}

/** True when an exact prior unknown outcome has explicit durable reconciliation authorization. */
export function hasRecoveredOutcomeReconciliationAuthorization(
  log: SessionEventLog,
  recoveredIdempotencyKey: string,
  fingerprint: string,
): boolean {
  return log.events.some((event) =>
    event.kind === 'recovery_reconciled' &&
    event.recovered_idempotency_key === recoveredIdempotencyKey &&
    event.operation_fingerprint === fingerprint,
  );
}

/** True only when an equivalent unknown non-idempotent effect lacks durable operator reconciliation. */
export function requiresRecoveredOutcomeReconciliation(
  log: SessionEventLog,
  fingerprint: string,
  recoveredIdempotencyKey?: string,
): boolean {
  return log.events.some((event) =>
    event.kind === 'tool_cancelled' &&
    event.recovery_state === 'TOOL_OUTCOME_UNKNOWN' &&
    event.args_digest === fingerprint &&
    (recoveredIdempotencyKey === undefined || event.idempotency_key === recoveredIdempotencyKey) &&
    !hasRecoveredOutcomeReconciliationAuthorization(log, event.idempotency_key, fingerprint) &&
    (event.effect_class === 'non_idempotent_local_effect' || event.effect_class === 'external_side_effect'),
  );
}
export interface SessionEventLog {
  schema_version: typeof SESSION_EVENT_SCHEMA_VERSION;
  session_id: string;
  events: SessionEvent[];
  nextSeq: number;
  /** Paths already flushed to disk (for dual-write append efficiency). */
  flushedThroughSeq: number;
  /** Runtime-only bounded observation bus; never serialized into the durable log. */
  observationBus?: BdnsObservationBus<SessionEvent>;
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
    observationBus: createBdnsObservationBus<SessionEvent>({ maxQueue: 256 }),
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

type ToolLifecycleEvent = Extract<
  SessionEvent,
  { kind: 'tool_proposed' | 'tool_started' | 'tool_completed' | 'tool_failed' | 'tool_cancelled' }
>;

function isToolLifecycleEvent(event: SessionEvent): event is ToolLifecycleEvent {
  return event.kind === 'tool_proposed' || event.kind === 'tool_started' ||
    event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled';
}

function isTerminalToolLifecycleEvent(event: ToolLifecycleEvent): boolean {
  return event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled';
}

function sameToolLifecycleOperation(left: ToolLifecycleEvent, right: ToolLifecycleEvent): boolean {
  return left.idempotency_key === right.idempotency_key &&
    left.tool_call_id === right.tool_call_id &&
    left.tool_name === right.tool_name;
}

/** Fail closed when a durable tool record violates the proposal/start/terminal state machine. */
export function assertSessionEventToolLifecycleCausality(
  priorEvents: readonly SessionEvent[],
  candidate: ToolLifecycleEvent,
  subject: string,
): void {
  const reject = (reason: string): never => {
    const diagnostic = buildToolLifecycleCausalityDiagnostic({
      priorEvents,
      candidate,
      candidateSeq: priorEvents.length,
      reason,
    });
    throw new SessionEventLifecycleCausalityError(`${subject}: ${reason}`, diagnostic);
  };
  if (
    candidate.idempotency_key.trim().length === 0 ||
    candidate.tool_call_id.trim().length === 0 ||
    candidate.tool_name.trim().length === 0
  ) {
    reject('tool identifiers must be non-empty');
  }
  const history = priorEvents.filter(
    (event): event is ToolLifecycleEvent => isToolLifecycleEvent(event) && sameToolLifecycleOperation(event, candidate),
  );
  const proposals = history.filter((event) => event.kind === 'tool_proposed');
  const starts = history.filter((event) => event.kind === 'tool_started');
  const terminals = history.filter(isTerminalToolLifecycleEvent);

  if (candidate.kind === 'tool_proposed') {
    if (history.length > 0) reject('tool_proposed must start a new tool lifecycle');
    return;
  }
  if (candidate.kind === 'tool_started') {
    if (proposals.length !== 1 || starts.length !== 0 || terminals.length !== 0) {
      reject('tool_started requires exactly one prior tool_proposed and no terminal');
    }
    return;
  }
  if (terminals.length !== 0) {
    reject('tool lifecycle cannot record a terminal after a terminal');
  }
  const isNotStartedCancellation = candidate.kind === 'tool_cancelled' && candidate.recovery_state === 'TOOL_NOT_STARTED';
  if (isNotStartedCancellation) {
    if (proposals.length !== 1 || starts.length !== 0) {
      reject('TOOL_NOT_STARTED cancellation requires one prior tool_proposed and no tool_started');
    }
    return;
  }
  if (proposals.length !== 1 || starts.length !== 1) {
    reject('terminal tool event requires one prior tool_proposed and tool_started');
  }
}
type CompactionLifecycleEvent = Extract<
  SessionEvent,
  { kind: 'compaction_started' | 'compaction_summary' | 'compaction_committed' }
>;

function assertCompactionLifecycleCausality(
  priorEvents: readonly SessionEvent[],
  candidate: CompactionLifecycleEvent,
  subject: string,
): void {
  if (!candidate.operation_id.trim()) throw new Error(`${subject}: compaction operation_id must be non-empty`);
  const history = priorEvents.filter(
    (event): event is CompactionLifecycleEvent =>
      (event.kind === 'compaction_started' || event.kind === 'compaction_summary' || event.kind === 'compaction_committed') &&
      event.operation_id === candidate.operation_id,
  );
  const starts = history.filter((event) => event.kind === 'compaction_started');
  const summaries = history.filter((event) => event.kind === 'compaction_summary');
  const commits = history.filter((event) => event.kind === 'compaction_committed');
  if (candidate.kind === 'compaction_started') {
    if (history.length !== 0 || candidate.replaces_thread_seq_start < 0 ||
      candidate.replaces_thread_seq_end < candidate.replaces_thread_seq_start || candidate.replaces_message_count < 0) {
      throw new Error(`${subject}: compaction_started must begin one valid replacement lifecycle`);
    }
    return;
  }
  if (candidate.kind === 'compaction_summary') {
    if (starts.length !== 1 || summaries.length !== 0 || commits.length !== 0 || !/^[a-f0-9]{64}$/.test(candidate.capsule_digest)) {
      throw new Error(`${subject}: compaction_summary requires one prior start and a SHA-256 capsule digest`);
    }
    return;
  }
  const start = starts[0];
  const summary = summaries[0];
  if (starts.length !== 1 || summaries.length !== 1 || commits.length !== 0 || !start || !summary ||
    candidate.capsule_digest !== summary.capsule_digest ||
    candidate.replaces_thread_seq_start !== start.replaces_thread_seq_start ||
    candidate.replaces_thread_seq_end !== start.replaces_thread_seq_end ||
    candidate.replaces_message_count !== start.replaces_message_count ||
    candidate.preserved_tool_call_ids.length !== summary.preserved_tool_call_ids.length ||
    candidate.preserved_tool_call_ids.some((id, index) => id !== summary.preserved_tool_call_ids[index]) ||
    !candidate.thread_event_id.trim()) {
    throw new Error(`${subject}: compaction_committed must link one prior start and summary exactly`);
  }
}

/** Validate all durable C2 lifecycles before a restore path consumes them. */
export function assertSessionEventCompactionLifecycleCausality(log: Pick<SessionEventLog, 'events'>): void {
  for (const [index, event] of log.events.entries()) {
    if (event.kind !== 'compaction_started' && event.kind !== 'compaction_summary' && event.kind !== 'compaction_committed') continue;
    assertCompactionLifecycleCausality(log.events.slice(0, index), event, `Invalid session event at seq ${event.seq}`);
  }
}
type ProviderRetryLifecycleEvent = Extract<
  SessionEvent,
  { kind: 'provider_retry_scheduled' | 'provider_retry_settled' }
>;

function isProviderRetryLifecycleEvent(event: SessionEvent): event is ProviderRetryLifecycleEvent {
  return event.kind === 'provider_retry_scheduled' || event.kind === 'provider_retry_settled';
}

/** Fail closed unless each provider retry schedule has exactly one durable settlement. */
export function assertProviderRetryLifecycleCausality(
  priorEvents: readonly SessionEvent[],
  candidate: ProviderRetryLifecycleEvent,
  subject: string,
): void {
  const sameRetry = (event: ProviderRetryLifecycleEvent): boolean =>
    event.turn_id === candidate.turn_id && event.provider === candidate.provider && event.model === candidate.model;
  const history = priorEvents.filter(
    (event): event is ProviderRetryLifecycleEvent => isProviderRetryLifecycleEvent(event) && sameRetry(event),
  );
  const schedules = history.filter((event) => event.kind === 'provider_retry_scheduled');
  const settlements = history.filter((event) => event.kind === 'provider_retry_settled');
  const hasSettlement = (attempt: number): boolean => settlements.some((event) => event.attempt === attempt);
  if (candidate.kind === 'provider_retry_scheduled') {
    if (schedules.some((event) => event.attempt === candidate.attempt) ||
      schedules.some((event) => !hasSettlement(event.attempt))) {
      throw new Error(`${subject}: provider retry schedule requires all prior schedules to be settled exactly once`);
    }
    return;
  }
  if (!schedules.some((event) => event.attempt === candidate.attempt) || hasSettlement(candidate.attempt)) {
    throw new Error(`${subject}: provider retry settlement requires one unmatched prior schedule`);
  }
}
/** Append a kind-specific session event; returns the full record. */
export function appendSessionEvent(
  log: SessionEventLog,
  event: { kind: SessionEventKind; turn_id?: string | null } & Record<string, unknown>,
): SessionEvent {
  if (event.kind === 'provider_retry_scheduled' || event.kind === 'provider_retry_settled') {
    assertProviderRetryLifecycleCausality(
      log.events,
      event as unknown as ProviderRetryLifecycleEvent,
      'Invalid appended session event',
    );
  }  if (event.kind === 'recovery_reconciled') {
    assertRecoveredOutcomeReconciliationAuthorization(log, {
      recovered_idempotency_key: event.recovered_idempotency_key as string,
      operation_fingerprint: event.operation_fingerprint as string,
      reconciliation_ref: event.reconciliation_ref as string,
    });
  }
  if (event.kind === 'compaction_started' || event.kind === 'compaction_summary' || event.kind === 'compaction_committed') {
    assertCompactionLifecycleCausality(log.events, event as unknown as CompactionLifecycleEvent, 'Invalid appended session event');
  }
  if (
    event.kind === 'tool_proposed' || event.kind === 'tool_started' || event.kind === 'tool_completed' ||
    event.kind === 'tool_failed' || event.kind === 'tool_cancelled'
  ) {
    assertSessionEventToolLifecycleCausality(
      log.events,
      event as unknown as ToolLifecycleEvent,
      'Invalid appended session event',
    );
  }
  const turnId = event.turn_id === undefined ? null : event.turn_id;
  const base = baseFields(log, event.kind, turnId);
  const { kind: _k, turn_id: _t, ...rest } = event;
  const full = { ...rest, ...base } as SessionEvent;
  log.events.push(full);
  const observation = {
    schemaVersion: 1 as const,
    source: 'canonical' as const,
    kind: 'canonical_event' as const,
    correlation: {
      sessionId: full.session_id,
      ...(full.turn_id ? { turnId: full.turn_id } : {}),
      canonicalEventId: full.event_id,
    },
    evidenceState: 'complete' as const,
    payload: full,
  };
  log.observationBus?.publish(observation);
  sessionEventObservationBus.publish(observation);
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

/** Persist one content-free provider retry boundary for deterministic replay. */
export function recordProviderRetryScheduled(
  log: SessionEventLog,
  input: {
    turn_id: string;
    provider: 'deepinfra' | 'deepseek';
    model: string;
    attempt: number;
    reason: 'transport' | 'timeout' | 'rate_limit' | 'server_error' | 'stream_idle';
    backoff_ms: number;
  },
): SessionEvent {
  return appendSessionEvent(log, { kind: 'provider_retry_scheduled', ...input });
}

/** Persist the terminal result of a retry sequence without provider payloads. */
export function recordProviderRetrySettled(
  log: SessionEventLog,
  input: {
    turn_id: string;
    provider: 'deepinfra' | 'deepseek';
    model: string;
    attempt: number;
    outcome: 'succeeded' | 'failed' | 'cancelled';
  },
): SessionEvent {
  return appendSessionEvent(log, { kind: 'provider_retry_settled', ...input });
}
function toolCorrelationFields(input: {
  action_index?: number;
  batch_id?: string;
  target_summary?: string;
}): { action_index?: number; batch_id?: string; target_summary?: string } {
  return {
    ...(input.action_index !== undefined ? { action_index: input.action_index } : {}),
    ...(input.batch_id !== undefined ? { batch_id: input.batch_id } : {}),
    ...(input.target_summary !== undefined ? { target_summary: input.target_summary.slice(0, 240) } : {}),
  };
}

export function recordToolProposed(
  log: SessionEventLog,
  input: {
    turn_id: string;
    tool_call_id: string;
    tool_name: string;
    idempotency_key?: string;
    effect_class?: ToolEffectClass;
    args_digest?: string;
    action_index?: number;
    batch_id?: string;
    target_summary?: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'tool_proposed',
    turn_id: input.turn_id,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    idempotency_key: input.idempotency_key ?? input.tool_call_id,
    ...(input.effect_class !== undefined ? { effect_class: input.effect_class } : {}),
    ...(input.args_digest !== undefined ? { args_digest: input.args_digest } : {}),
    ...toolCorrelationFields(input),
  });
}

export function recordToolStarted(
  log: SessionEventLog,
  input: {
    turn_id: string;
    tool_call_id: string;
    tool_name: string;
    idempotency_key?: string;
    effect_class?: ToolEffectClass;
    action_index?: number;
    batch_id?: string;
    target_summary?: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'tool_started',
    turn_id: input.turn_id,
    tool_call_id: input.tool_call_id,
    tool_name: input.tool_name,
    idempotency_key: input.idempotency_key ?? input.tool_call_id,
    ...(input.effect_class !== undefined ? { effect_class: input.effect_class } : {}),
    ...toolCorrelationFields(input),
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
    recovery_state?: InterruptedToolRecoveryState;
    effect_class?: ToolEffectClass;
    reconciliation?: InterruptedToolRecovery['reconciliation'];
    args_digest?: string;
    action_index?: number;
    batch_id?: string;
    target_summary?: string;
  },
): SessionEvent {
  const key = input.idempotency_key ?? input.tool_call_id;
  const correlation = toolCorrelationFields(input);
  if (input.cancelled) {
    return appendSessionEvent(log, {
      kind: 'tool_cancelled',
      turn_id: input.turn_id,
      tool_call_id: input.tool_call_id,
      tool_name: input.tool_name,
      idempotency_key: key,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.recovery_state !== undefined ? { recovery_state: input.recovery_state } : {}),
      ...(input.effect_class !== undefined ? { effect_class: input.effect_class } : {}),
      ...(input.reconciliation !== undefined ? { reconciliation: input.reconciliation } : {}),
      ...(input.args_digest !== undefined ? { args_digest: input.args_digest } : {}),
      ...correlation,
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
      ...correlation,
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
    ...correlation,
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

/** C2: record a stable replacement boundary before compaction is committed. */
export function recordCompactionStarted(
  log: SessionEventLog,
  turnId: string | null,
  input: {
    operation_id: string;
    strategy: string;
    replaces_thread_seq_start: number;
    replaces_thread_seq_end: number;
    replaces_message_count: number;
  },
): SessionEvent {
  return appendSessionEvent(log, { kind: 'compaction_started', turn_id: turnId, ...input });
}

/** C2: record the content-free preservation links prepared for a compaction. */
export function recordCompactionSummary(
  log: SessionEventLog,
  turnId: string | null,
  input: {
    operation_id: string;
    capsule_digest: string;
    raw_observation_refs: string[];
    preserved_tool_call_ids: string[];
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'compaction_summary',
    turn_id: turnId,
    ...input,
    raw_observation_refs: [...input.raw_observation_refs],
    preserved_tool_call_ids: [...input.preserved_tool_call_ids],
  });
}

/** C2: record the exact durable thread capsule that committed a replacement. */
export function recordCompactionCommitted(
  log: SessionEventLog,
  turnId: string | null,
  input: {
    operation_id: string;
    thread_event_id: string;
    capsule_digest: string;
    replaces_thread_seq_start: number;
    replaces_thread_seq_end: number;
    replaces_message_count: number;
    preserved_tool_call_ids: string[];
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'compaction_committed',
    turn_id: turnId,
    ...input,
    preserved_tool_call_ids: [...input.preserved_tool_call_ids],
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

/** Parse JSONL session event log; rejects blank durable logs and wrong schema. */
export function parseSessionEventLog(
  raw: string,
  expectedSessionId?: string,
): SessionEventLog {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('Invalid session event log: no events found');
  }
  const events: SessionEvent[] = [];
  const eventIds = new Set<string>();
  let sessionId = '';
  let maxSeq = -1;
  const knownKinds = new Set<SessionEventKind>([
    'user_submitted', 'model_started', 'provider_retry_scheduled', 'provider_retry_settled', 'tool_proposed', 'tool_started',
    'tool_completed', 'tool_failed', 'tool_cancelled', 'recovery_reconciled', 'mutation_batch',
    'verifier_attempt', 'gate_decision', 'policy_intervened', 'progress_recovery',
    'completion_decision', 'model_failover', 'compaction_started', 'compaction_summary', 'compaction_committed', 'compaction_created', 'turn_ended',
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
    if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq !== events.length) {
      throw new Error(`Invalid session event at line ${index + 1}: seq must be contiguous starting at 0`)
    }
    if (eventIds.has(ev.event_id)) {
      throw new Error(`Invalid session event at line ${index + 1}: event_id is duplicated`)
    }
    if (typeof ev.ts !== 'string' || ev.ts.length === 0) {
      throw new Error(`Invalid session event at line ${index + 1}: ts is required`)
    }
    if (typeof ev.kind !== 'string' || !knownKinds.has(ev.kind as SessionEventKind)) {
      throw new Error(`Invalid session event at line ${index + 1}: unknown kind ${String(ev.kind)}`)
    }
    const required: Record<SessionEventKind, string[]> = {
      user_submitted: ['task_preview'], model_started: [],
      provider_retry_scheduled: ['provider', 'model', 'attempt', 'reason', 'backoff_ms'],
      provider_retry_settled: ['provider', 'model', 'attempt', 'outcome'],
      tool_proposed: ['tool_call_id', 'tool_name', 'idempotency_key'],
      tool_started: ['tool_call_id', 'tool_name', 'idempotency_key'], tool_completed: ['tool_call_id', 'tool_name', 'idempotency_key'],
      tool_failed: ['tool_call_id', 'tool_name', 'idempotency_key'], tool_cancelled: ['tool_call_id', 'tool_name', 'idempotency_key'],
      recovery_reconciled: ['recovered_idempotency_key', 'operation_fingerprint', 'reconciliation_ref'],
      mutation_batch: ['paths'], verifier_attempt: ['command_preview', 'authoritative'], gate_decision: ['decision'],
      policy_intervened: ['source', 'action'], progress_recovery: ['intervention', 'score', 'signals'],
      completion_decision: ['requested_outcome', 'final_outcome', 'allowed', 'reason', 'evidence_refs', 'policy_version'],
      model_failover: [], compaction_started: ['operation_id', 'strategy', 'replaces_thread_seq_start', 'replaces_thread_seq_end', 'replaces_message_count'], compaction_summary: ['operation_id', 'capsule_digest', 'raw_observation_refs', 'preserved_tool_call_ids'], compaction_committed: ['operation_id', 'thread_event_id', 'capsule_digest', 'replaces_thread_seq_start', 'replaces_thread_seq_end', 'replaces_message_count', 'preserved_tool_call_ids'], compaction_created: [], turn_ended: ['outcome', 'status'], budget_snapshot: [],
      approval_decision: ['request_id', 'decision'], repair_attempt: ['failure_class', 'attempt'],
    }
    const arrayFields = new Set(['paths', 'signals', 'evidence_refs', 'raw_observation_refs', 'preserved_tool_call_ids'])
    const booleanFields = new Set(['authoritative', 'allowed'])
    const numberFields = new Set(['score', 'attempt', 'backoff_ms', 'replaces_thread_seq_start', 'replaces_thread_seq_end', 'replaces_message_count'])
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
    const effectClasses: ToolEffectClass[] = [
      'read_only', 'idempotent', 'reconcilable_mutation',
      'non_idempotent_local_effect', 'external_side_effect',
    ];
    const recoveryStates: InterruptedToolRecoveryState[] = ['TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN'];
    const reconciliationValues: InterruptedToolRecovery['reconciliation'][] = [
      'reconsider_and_authorize', 'inspect_or_reconcile_before_retry', 'manual_review_no_auto_retry',
    ];
    if (ev.effect_class !== undefined && !effectClasses.includes(ev.effect_class as ToolEffectClass)) {
      throw new Error(`Invalid session event at line ${index + 1}: effect_class is invalid`)
    }
    if (ev.recovery_state !== undefined && (ev.kind !== 'tool_cancelled' || !recoveryStates.includes(ev.recovery_state as InterruptedToolRecoveryState))) {
      throw new Error(`Invalid session event at line ${index + 1}: recovery_state is invalid`)
    }
    if (ev.action_index !== undefined && (!Number.isInteger(ev.action_index) || (ev.action_index as number) < 0)) {
      throw new Error(`Invalid session event at line ${index + 1}: action_index is invalid`)
    }
    if (ev.batch_id !== undefined && typeof ev.batch_id !== 'string') {
      throw new Error(`Invalid session event at line ${index + 1}: batch_id must be a string`)
    }
    if (ev.target_summary !== undefined && typeof ev.target_summary !== 'string') {
      throw new Error(`Invalid session event at line ${index + 1}: target_summary must be a string`)
    }
    if (ev.reconciliation !== undefined && (ev.kind !== 'tool_cancelled' || !reconciliationValues.includes(ev.reconciliation as InterruptedToolRecovery['reconciliation']))) {
      throw new Error(`Invalid session event at line ${index + 1}: reconciliation is invalid`)
    }
    if (ev.kind === 'provider_retry_scheduled') {
      if (!['deepinfra', 'deepseek'].includes(ev.provider as string) ||
        !['transport', 'timeout', 'rate_limit', 'server_error', 'stream_idle'].includes(ev.reason as string) ||
        !Number.isInteger(ev.attempt) || (ev.attempt as number) < 2 ||
        !Number.isInteger(ev.backoff_ms) || (ev.backoff_ms as number) < 0) {
        throw new Error(`Invalid session event at line ${index + 1}: provider retry schedule is invalid`)
      }
    }
    if (ev.kind === 'provider_retry_settled') {
      if (!['deepinfra', 'deepseek'].includes(ev.provider as string) ||
        !['succeeded', 'failed', 'cancelled'].includes(ev.outcome as string) ||
        !Number.isInteger(ev.attempt) || (ev.attempt as number) < 2) {
        throw new Error(`Invalid session event at line ${index + 1}: provider retry settlement is invalid`)
      }
    }    if (ev.kind === 'recovery_reconciled' &&
      (typeof ev.reconciliation_ref !== 'string' || !/^[A-Za-z0-9._:/#-]{1,160}$/.test(ev.reconciliation_ref))) {
      throw new Error(`Invalid session event at line ${index + 1}: reconciliation_ref is invalid`)
    }
    if (ev.kind === 'compaction_started' || ev.kind === 'compaction_summary' || ev.kind === 'compaction_committed') {
      assertCompactionLifecycleCausality(
        events,
        ev as unknown as CompactionLifecycleEvent,
        `Invalid session event at line ${index + 1}`,
      )
    }
    if (
      ev.kind === 'tool_proposed' || ev.kind === 'tool_started' || ev.kind === 'tool_completed' ||
      ev.kind === 'tool_failed' || ev.kind === 'tool_cancelled'
    ) {
      assertSessionEventToolLifecycleCausality(
        events,
        ev as unknown as ToolLifecycleEvent,
        `Invalid session event at line ${index + 1}`,
      )
    }
    if (ev.kind === 'provider_retry_scheduled' || ev.kind === 'provider_retry_settled') {
      assertProviderRetryLifecycleCausality(
        events,
        ev as unknown as ProviderRetryLifecycleEvent,
        `Invalid session event at line ${index + 1}`,
      )
    }    if (ev.kind === 'recovery_reconciled') {
      assertRecoveryReconciliationCausality(
        events,
        ev as unknown as Extract<SessionEvent, { kind: 'recovery_reconciled' }>,
        `Invalid session event at line ${index + 1}`,
      )
    }
    if (expectedSessionId && ev.session_id !== expectedSessionId) {
      throw new Error(`Invalid session event at line ${index + 1}: session_id does not match requested session`)
    }
    if (sessionId && ev.session_id !== sessionId) {
      throw new Error(`Invalid session event at line ${index + 1}: session_id changed`)
    }
    if (!sessionId) sessionId = ev.session_id
    eventIds.add(ev.event_id)
    events.push(ev as unknown as SessionEvent)
    maxSeq = ev.seq
  }
  for (const scheduled of events.filter(
    (event): event is Extract<SessionEvent, { kind: 'provider_retry_scheduled' }> =>
      event.kind === 'provider_retry_scheduled',
  )) {
    const settlements = events.filter(
      (event): event is Extract<SessionEvent, { kind: 'provider_retry_settled' }> =>
        event.kind === 'provider_retry_settled' && event.turn_id === scheduled.turn_id &&
        event.provider === scheduled.provider && event.model === scheduled.model &&
        event.attempt === scheduled.attempt,
    );
    if (settlements.length !== 1) {
      throw new Error(`Invalid session event log: provider retry attempt ${scheduled.attempt} must have exactly one settlement`)
    }
  }  return {
    schema_version: SESSION_EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    events,
    nextSeq: maxSeq + 1,
    flushedThroughSeq: maxSeq,
    observationBus: createBdnsObservationBus<SessionEvent>({ maxQueue: 256 }),
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

export function inspectSessionEventLogFromDir(
  runDir: string,
  expectedSessionId?: string,
): SessionEventLogLoadResult {
  const path = join(runDir, SESSION_EVENTS_FILENAME)
  if (!existsSync(path)) return { kind: 'missing', path }
  try {
    return { kind: 'valid', path, log: parseSessionEventLog(readFileSync(path, 'utf-8'), expectedSessionId) }
  } catch (error) {
    return {
      kind: 'invalid',
      path,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export function loadSessionEventLogForResume(runDir: string, sessionId: string): SessionEventLog {
  const result = inspectSessionEventLogFromDir(runDir, sessionId)
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
  const result = inspectSessionEventLogFromDir(runDir, sessionId)
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

/** Classify unresolved durable tool lifecycles without inventing an outcome. */
export function interruptedToolRecoveries(log: SessionEventLog): InterruptedToolRecovery[] {
  const open = new Map<string, {
    toolCallId: string;
    toolName: string;
    effectClass?: ToolEffectClass;
    operationFingerprint?: string;
    started: boolean;
  }>();
  const terminal = completedToolIdempotencyKeys(log);
  for (const event of log.events) {
    if (event.kind !== 'tool_proposed' && event.kind !== 'tool_started') continue;
    if (terminal.has(event.idempotency_key)) continue;
    const prior = open.get(event.idempotency_key);
    const effectClass = event.effect_class ?? prior?.effectClass;
    const operationFingerprint = event.kind === 'tool_proposed' ? event.args_digest : prior?.operationFingerprint;
    open.set(event.idempotency_key, {
      toolCallId: event.tool_call_id,
      toolName: event.tool_name,
      ...(effectClass !== undefined ? { effectClass } : {}),
      ...(operationFingerprint !== undefined ? { operationFingerprint } : {}),
      started: event.kind === 'tool_started' || prior?.started === true,
    });
  }
  return [...open.entries()].map(([idempotencyKey, meta]) => {
    const effectClass = meta.effectClass ?? classifyToolEffect(meta.toolName);
    const state: InterruptedToolRecoveryState = meta.started
      ? 'TOOL_OUTCOME_UNKNOWN'
      : 'TOOL_NOT_STARTED';
    const reconciliation = state === 'TOOL_NOT_STARTED'
      ? 'reconsider_and_authorize'
      : effectClass === 'non_idempotent_local_effect' || effectClass === 'external_side_effect'
        ? 'manual_review_no_auto_retry'
        : 'inspect_or_reconcile_before_retry';
    return {
      idempotencyKey,
      toolCallId: meta.toolCallId,
      toolName: meta.toolName,
      effectClass,
      state,
      reconciliation,
      ...(meta.operationFingerprint !== undefined ? { operationFingerprint: meta.operationFingerprint } : {}),
    };
  });
}

/**
 * Settle interrupted lifecycles as cancelled with explicit repair state.
 * A proposed-only operation was never dispatched; a started operation has an
 * unknown outcome and must be inspected/reconciled before any retry.
 */
export function markInterruptedToolsOnResume(
  log: SessionEventLog,
  reason = 'interrupted_mid_tool',
): SessionEvent[] {
  const marked: SessionEvent[] = [];
  for (const recovery of interruptedToolRecoveries(log)) {
    const meta = toolMetaForIdempotencyKey(log, recovery.idempotencyKey);
    if (!meta) continue;
    marked.push(
      recordToolTerminal(log, {
        turn_id: meta.turn_id ?? 'resume',
        tool_call_id: recovery.toolCallId,
        tool_name: recovery.toolName,
        idempotency_key: recovery.idempotencyKey,
        cancelled: true,
        reason,
        recovery_state: recovery.state,
        effect_class: recovery.effectClass,
        reconciliation: recovery.reconciliation,
        ...(recovery.operationFingerprint !== undefined ? { args_digest: recovery.operationFingerprint } : {}),
      }),
    );
  }
  return marked;
}

/** Model-visible, secret-free repair guidance from settled resume evidence. */
export function resumedToolRecoveryGuidance(log: SessionEventLog): string | null {
  const recoveries = log.events.filter(
    (event): event is Extract<SessionEvent, { kind: 'tool_cancelled' }> =>
      event.kind === 'tool_cancelled' &&
      event.recovery_state !== undefined &&
      !(event.args_digest && hasRecoveredOutcomeReconciliationAuthorization(log, event.idempotency_key, event.args_digest)),
  );
  if (recoveries.length === 0) return null;
  const lines = recoveries.map((event) =>
    `- ${event.recovery_state}: tool=${event.tool_name}; effect_class=${event.effect_class ?? classifyToolEffect(event.tool_name)}; reconciliation=${event.reconciliation ?? 'inspect_or_reconcile_before_retry'}`,
  );
  return [
    '[RESUME_REPAIR] Durable tool recovery is required before proposing another effect.',
    ...lines,
    'Do not assume success; never blindly retry. Inspect/reconcile the workspace or external state first; for non-idempotent or external effects, an operator must record durable reconciliation authorization before retry.',
  ].join('\n');
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
