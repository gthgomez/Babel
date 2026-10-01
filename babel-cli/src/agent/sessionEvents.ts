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
import type { TerminalReason, TerminalReasonCode } from './chatTerminalReason.js';
import { classifyToolEffect, type ToolEffectClass } from '../executor/contracts.js';
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';
import type { WorkingState } from './codingLoop/workingState.js';
import { createBdnsObservationBus } from '../diagnostics/bdns/observationBus.js';
import type { BdnsObservation } from '../diagnostics/bdns/types.js';
import { type ProviderId } from '../runners/providerRegistry.js';
import { type ContextManifestV1 } from './contextManifest.js';
import { type ModelRouteReceiptV1 } from './modelRouteReceipt.js';
import { type ProviderFailureReceiptV1 } from '../runners/providerFailureReceipt.js';
import {
  SESSION_EVENTS_FILENAME,
  SESSION_EVENT_SCHEMA_VERSION,
  type CapabilityBindingLifecycleEvent,
  type CompactionLifecycleEvent,
  type InterruptedToolRecovery,
  type InterruptedToolRecoveryState,
  type ModelInvocationLifecycleEvent,
  type ModelInvocationPhaseEvent,
  type ProviderFailureReceiptEvent,
  type ProviderRetryLifecycleEvent,
  type RecoveredOutcomeReconciliationAuthorization,
  type SessionEvent,
  type SessionEventBase,
  type SessionEventKind,
  type SessionEventLog,
  type SessionEventLogLoadResult,
  type SessionEventObservationHook,
  type ToolLifecycleEvent,
} from './sessionEventSchema.js';
import {
  assertCapabilityBindingCausality,
  assertCompactionLifecycleCausality,
  assertModelInvocationLifecycleCausality,
  assertModelInvocationPhaseCausality,
  assertProviderFailureReceiptCausality,
  assertProviderRetryLifecycleCausality,
  assertRecoveredOutcomeReconciliationAuthorization,
  assertSessionEventToolLifecycleCausality,
} from './sessionEventCausality.js';
import {
  SessionEventLogRestoreError,
  parseSessionEventLog,
  serializeSessionEventLog,
} from './sessionEventCodec.js';
export { SESSION_EVENT_SCHEMA_VERSION } from './sessionEventSchema.js';
export { SESSION_EVENTS_FILENAME } from './sessionEventSchema.js';
export type { InterruptedToolRecoveryState } from './sessionEventSchema.js';
export type { InterruptedToolRecovery } from './sessionEventSchema.js';
export type { SessionEventKind } from './sessionEventSchema.js';
export type { SessionEventBase } from './sessionEventSchema.js';
export type { SessionEvent } from './sessionEventSchema.js';
export { operationFingerprint } from './sessionEventCausality.js';
export type { RecoveredOutcomeReconciliationAuthorization } from './sessionEventSchema.js';
export { assertRecoveredOutcomeReconciliationAuthorization } from './sessionEventCausality.js';
export { assertSessionEventToolLifecycleCausalities } from './sessionEventCausality.js';
export { assertSessionEventRecoveryReconciliationCausality } from './sessionEventCausality.js';
export type { SessionEventLog } from './sessionEventSchema.js';
export type { SessionEventLogLoadResult } from './sessionEventSchema.js';
export type { SessionEventLogRestoreCode } from './sessionEventSchema.js';
export { SessionEventLogRestoreError } from './sessionEventCodec.js';
export { assertSessionEventToolLifecycleCausality } from './sessionEventCausality.js';
export { assertSessionEventCompactionLifecycleCausality } from './sessionEventCausality.js';
export { assertProviderRetryLifecycleCausality } from './sessionEventCausality.js';
export { assertModelInvocationLifecycleCausality } from './sessionEventCausality.js';
export { assertProviderFailureReceiptCausality } from './sessionEventCausality.js';
export { assertModelInvocationPhaseCausality } from './sessionEventCausality.js';
export { assertCapabilityBindingCausality } from './sessionEventCausality.js';
export { serializeSessionEventLog } from './sessionEventCodec.js';
export { parseSessionEventLog } from './sessionEventCodec.js';

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

/**
 * Subscribe to the BDNS envelope for canonical session events.
 *
 * Observer sequence, wall-clock, and monotonic timestamps come from the bus
 * (BDNS ingestion order), not from canonical `seq`.
 */
export function subscribeSessionEventBdnsObservation(
  hook: (observation: BdnsObservation<SessionEvent>) => void | Promise<void>,
  options: { id?: string; maxQueue?: number } = {},
): () => void {
  return sessionEventObservationBus.subscribe({
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
    onObservation: hook,
  });
}

/** Flush the bounded global compatibility observation queue before shutdown. */
export function flushSessionEventObservations(timeoutMs = 1_000): Promise<boolean> {
  return sessionEventObservationBus.flush(timeoutMs);
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
  }
  if (event.kind === 'model_input_receipt' || event.kind === 'model_result_delivery') {
    assertModelInvocationLifecycleCausality(
      log.events,
      event as unknown as ModelInvocationLifecycleEvent,
      'Invalid appended session event',
    );
  }
  if (event.kind === 'capability_binding_receipt') {
    assertCapabilityBindingCausality(
      log.events,
      event as unknown as CapabilityBindingLifecycleEvent,
      'Invalid appended session event',
    );
  }
  if (event.kind === 'model_invocation_phase') {
    assertModelInvocationPhaseCausality(
      log.events,
      event as unknown as ModelInvocationPhaseEvent,
      'Invalid appended session event',
    );
  }
  if (event.kind === 'provider_failure_receipt') {
    assertProviderFailureReceiptCausality(
      log.events,
      event as unknown as ProviderFailureReceiptEvent,
      'Invalid appended session event',
    );
  }
  if (event.kind === 'recovery_reconciled') {
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
    continuedTask?: boolean;
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
    ...(input.continuedTask !== undefined ? { continued_task: input.continuedTask } : {}),
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

export function recordModelInputReceipt(
  log: SessionEventLog,
  input: {
    turn_id: string;
    inference_id: string;
    provider: ProviderId;
    requested_model_id: string;
    normalized_model_id: string;
    sent_model_id: string;
    input_digest: string;
    request_id?: string;
    attempt_id?: string;
    parent_request_id?: string | null;
    body_digest?: string;
    body_bytes?: number;
    accounting_kind?: 'exact_serialized_body';
    context_limit_tokens?: number | null;
    context_limit_source?: string;
    input_ref: string;
    input_message_count?: number;
    delivered_tool_call_ids?: string[];
    context_manifest?: ContextManifestV1;
    route_receipt?: ModelRouteReceiptV1;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'model_input_receipt',
    turn_id: input.turn_id,
    inference_id: input.inference_id,
    provider: input.provider,
    requested_model_id: input.requested_model_id,
    normalized_model_id: input.normalized_model_id,
    sent_model_id: input.sent_model_id,
    input_digest: input.input_digest,
    ...(input.request_id !== undefined ? { request_id: input.request_id } : {}),
    ...(input.attempt_id !== undefined ? { attempt_id: input.attempt_id } : {}),
    ...(input.parent_request_id !== undefined ? { parent_request_id: input.parent_request_id } : {}),
    ...(input.body_digest !== undefined ? { body_digest: input.body_digest } : {}),
    ...(input.body_bytes !== undefined ? { body_bytes: input.body_bytes } : {}),
    ...(input.accounting_kind !== undefined ? { accounting_kind: input.accounting_kind } : {}),
    ...(input.context_limit_tokens !== undefined ? { context_limit_tokens: input.context_limit_tokens } : {}),
    ...(input.context_limit_source !== undefined ? { context_limit_source: input.context_limit_source } : {}),
    input_ref: input.input_ref,
    ...(input.input_message_count !== undefined
      ? { input_message_count: input.input_message_count }
      : {}),
    ...(input.delivered_tool_call_ids !== undefined
      ? { delivered_tool_call_ids: [...input.delivered_tool_call_ids] }
      : {}),
    ...(input.context_manifest !== undefined
      ? { context_manifest: structuredClone(input.context_manifest) }
      : {}),
    ...(input.route_receipt !== undefined
      ? { route_receipt: structuredClone(input.route_receipt) }
      : {}),
  });
}

/** Record a bounded provider lifecycle phase after its input receipt. */
export function recordModelInvocationPhase(
  log: SessionEventLog,
  input: {
    turn_id: string;
    inference_id: string;
    provider: ProviderId;
    model: string;
    phase:
      | 'request_created'
      | 'request_dispatched'
      | 'response_started'
      | 'first_byte'
      | 'stream_progress'
      | 'stream_completed'
      | 'provider_error'
      | 'response_normalized'
      | 'response_normalization_failed';
    status_code?: number;
    detail?: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'model_invocation_phase',
    turn_id: input.turn_id,
    inference_id: input.inference_id,
    provider: input.provider,
    model: input.model,
    phase: input.phase,
    ...(input.status_code !== undefined ? { status_code: input.status_code } : {}),
    ...(input.detail !== undefined ? { detail: input.detail.slice(0, 160) } : {}),
  });
}

/** Record capability state without inferring authority or environment health. */
export function recordCapabilityBindingReceipt(
  log: SessionEventLog,
  input: {
    turn_id: string;
    inference_id: string;
    provider: ProviderId;
    capability: string;
    advertised: boolean;
    authorized: boolean | null;
    effective: boolean | null;
    evidence_ref?: string;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'capability_binding_receipt',
    turn_id: input.turn_id,
    inference_id: input.inference_id,
    provider: input.provider,
    capability: input.capability,
    advertised: input.advertised,
    authorized: input.authorized,
    effective: input.effective,
    ...(input.evidence_ref !== undefined ? { evidence_ref: input.evidence_ref } : {}),
  });
}

export function recordModelResultDelivery(
  log: SessionEventLog,
  input: {
    turn_id: string;
    inference_id: string;
    provider: ProviderId;
    model: string;
    status: 'delivered' | 'failed';
    observed_model_id?: string | null;
    upstream_provider?: string | null;
    output_digest?: string | null;
    failure_receipt?: Extract<SessionEvent, { kind: 'model_result_delivery' }>['failure_receipt'];
    failure_class?: string | null;
    failure_stage?: 'request' | 'response' | 'stream' | 'response_normalization' | 'unknown' | null;
    provider_request_id?: string | null;
    api_error_code?: string | null;
    http_status?: number | null;
    actual_attempt?: number | null;
    max_attempts?: number | null;
    stream?: boolean;
    inference_started?: boolean;
    partial_model_output?: boolean;
    retryable?: boolean;
    tool_call_count?: number | null;
    requested_output_budget?: number | null;
    effective_output_budget?: number | null;
    wire_policy_hash?: string | null;
    execution_envelope_hash?: string | null;
    route_receipt?: ModelRouteReceiptV1;
  },
): SessionEvent {
  if (input.status === 'failed' && input.failure_receipt === undefined) {
    const priorInput = log.events.find(
      (event): event is Extract<SessionEvent, { kind: 'model_input_receipt' }> =>
        event.kind === 'model_input_receipt' &&
        event.turn_id === input.turn_id &&
        event.inference_id === input.inference_id,
    );
    if (priorInput && (priorInput.provider !== input.provider || priorInput.sent_model_id !== input.model)) {
      throw new Error('Invalid appended session event: model result delivery identity does not match its input receipt');
    }
    throw new Error('model result delivery failure requires a provider failure receipt');
  }
  if (input.status === 'delivered' && input.failure_receipt !== undefined) {
    throw new Error('delivered model result cannot carry a provider failure receipt');
  }
  return appendSessionEvent(log, {
    kind: 'model_result_delivery',
    turn_id: input.turn_id,
    inference_id: input.inference_id,
    provider: input.provider,
    model: input.model,
    status: input.status,
    ...(input.observed_model_id !== undefined
      ? { observed_model_id: input.observed_model_id }
      : {}),
    ...(input.upstream_provider !== undefined
      ? { upstream_provider: input.upstream_provider }
      : {}),
    ...(input.output_digest !== undefined ? { output_digest: input.output_digest } : {}),
    ...(input.failure_receipt !== undefined
      ? { failure_receipt: structuredClone(input.failure_receipt) }
      : {}),
    ...(input.failure_class !== undefined ? { failure_class: input.failure_class } : {}),
    ...(input.failure_stage !== undefined ? { failure_stage: input.failure_stage } : {}),
    ...(input.provider_request_id !== undefined
      ? { provider_request_id: input.provider_request_id }
      : {}),
    ...(input.api_error_code !== undefined ? { api_error_code: input.api_error_code } : {}),
    ...(input.http_status !== undefined ? { http_status: input.http_status } : {}),
    ...(input.actual_attempt !== undefined ? { actual_attempt: input.actual_attempt } : {}),
    ...(input.max_attempts !== undefined ? { max_attempts: input.max_attempts } : {}),
    ...(input.stream !== undefined ? { stream: input.stream } : {}),
    ...(input.inference_started !== undefined
      ? { inference_started: input.inference_started }
      : {}),
    ...(input.partial_model_output !== undefined
      ? { partial_model_output: input.partial_model_output }
      : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(input.tool_call_count !== undefined
      ? { tool_call_count: input.tool_call_count }
      : {}),
    ...(input.requested_output_budget !== undefined
      ? { requested_output_budget: input.requested_output_budget }
      : {}),
    ...(input.effective_output_budget !== undefined
      ? { effective_output_budget: input.effective_output_budget }
      : {}),
    ...(input.wire_policy_hash !== undefined
      ? { wire_policy_hash: input.wire_policy_hash }
      : {}),
    ...(input.execution_envelope_hash !== undefined
      ? { execution_envelope_hash: input.execution_envelope_hash }
      : {}),
    ...(input.route_receipt !== undefined
      ? { route_receipt: structuredClone(input.route_receipt) }
      : {}),
  });
}

/** Persist one secret-free provider failure receipt before result delivery settles. */
export function recordProviderFailureReceipt(
  log: SessionEventLog,
  input: {
    turn_id: string;
    inference_id: string;
    provider: ProviderId;
    model: string;
    receipt: ProviderFailureReceiptV1;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'provider_failure_receipt',
    turn_id: input.turn_id,
    inference_id: input.inference_id,
    provider: input.provider,
    model: input.model,
    receipt: structuredClone(input.receipt),
  });
}

/** Persist one content-free provider retry boundary for deterministic replay. */
export function recordProviderRetryScheduled(
  log: SessionEventLog,
  input: {
    turn_id: string;
    provider: ProviderId;
    model: string;
    request_id?: string;
    attempt_id?: string;
    body_digest?: string;
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
    provider: ProviderId;
    model: string;
    request_id?: string;
    attempt_id?: string;
    body_digest?: string;
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
    tool_call_id?: string;
    receipt?: BoundChatVerifierReceipt;
  },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'verifier_attempt',
    turn_id: input.turn_id,
    command_preview: input.command_preview.slice(0, 500),
    authoritative: input.authoritative,
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
    ...(input.tool_call_id !== undefined ? { tool_call_id: input.tool_call_id } : {}),
    ...(input.receipt !== undefined ? { receipt: structuredClone(input.receipt) } : {}),
  });
}

export function recordTurnEnded(
  log: SessionEventLog,
  input: { turn_id: string; outcome?: TerminalOutcome; status: string; reason?: TerminalReason },
): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'turn_ended',
    turn_id: input.turn_id,
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    status: input.status,
    ...(input.reason !== undefined
      ? { reason_code: input.reason.code, cause_class: input.reason.cause_class }
      : {}),
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
    reasonCode?: TerminalReasonCode;
    causeClass?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
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
    ...(input.reasonCode !== undefined ? { reason_code: input.reasonCode } : {}),
    ...(input.causeClass !== undefined ? { cause_class: input.causeClass } : {}),
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

/** Snapshot controller recovery state in the existing durable session envelope. */
export function recordWorkingStateSnapshot(log: SessionEventLog, state: WorkingState, turnId: string | null): SessionEvent {
  return appendSessionEvent(log, {
    kind: 'working_state_snapshot',
    turn_id: turnId,
    state_schema_version: 1,
    state: structuredClone(state),
  })
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
