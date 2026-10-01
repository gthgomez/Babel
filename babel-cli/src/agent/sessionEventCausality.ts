/**
 * SessionEventV1 — append-only durable session event log (W2 / roadmap PR-E).
 *
 * Dual-writes next to the existing thread event log under chat session run dirs.
 * JSONL first (not SQLite). Complements ThreadEventLog: finer tool lifecycle
 * kinds for kill/resume settlement without replacing thread_events.json yet.
 *
 * Roadmap: docs/plans/BABEL_RELIABLE_EXECUTOR_ROADMAP_2026-08-01.md §7.1
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  buildToolLifecycleCausalityDiagnostic,
  SessionEventLifecycleCausalityError,
} from './sessionEventDiagnostics.js';
import { validateProviderFailureReceipt } from '../runners/providerFailureReceipt.js';
import {
  type CapabilityBindingLifecycleEvent,
  type CompactionLifecycleEvent,
  type ModelInvocationLifecycleEvent,
  type ModelInvocationPhaseEvent,
  type ProviderFailureReceiptEvent,
  type ProviderRetryLifecycleEvent,
  type RecoveredOutcomeReconciliationAuthorization,
  type SessionEvent,
  type SessionEventLog,
  type ToolLifecycleEvent,
} from './sessionEventSchema.js';

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


export function assertRecoveryReconciliationCausality(
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


export function assertCompactionLifecycleCausality(
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
    event.turn_id === candidate.turn_id &&
    event.provider === candidate.provider &&
    event.model === candidate.model &&
    (event.request_id === undefined || candidate.request_id === undefined
      ? event.request_id === candidate.request_id
      : event.request_id === candidate.request_id);
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

function isModelInvocationLifecycleEvent(event: SessionEvent): event is ModelInvocationLifecycleEvent {
  return event.kind === 'model_input_receipt' || event.kind === 'model_result_delivery';
}

/** Ensure result-delivery evidence links to exactly one prior input receipt. */
export function assertModelInvocationLifecycleCausality(
  priorEvents: readonly SessionEvent[],
  candidate: ModelInvocationLifecycleEvent,
  subject: string,
): void {
  const sameInference = (event: ModelInvocationLifecycleEvent): boolean =>
    event.turn_id === candidate.turn_id && event.inference_id === candidate.inference_id;
  const history = priorEvents.filter(
    (event): event is ModelInvocationLifecycleEvent =>
      isModelInvocationLifecycleEvent(event) && sameInference(event),
  );
  if (candidate.kind === 'model_input_receipt') {
    if (history.length !== 0) {
      throw new Error(`${subject}: model input receipt inference_id is duplicated`);
    }
    const deliveredToolCallIds = candidate.delivered_tool_call_ids ?? [];
    if (new Set(deliveredToolCallIds).size !== deliveredToolCallIds.length) {
      throw new Error(`${subject}: delivered tool call ids are duplicated`);
    }
    const terminalToolCallIds = new Set(
      priorEvents
        .filter(
          (event) =>
            event.kind === 'tool_completed' ||
            event.kind === 'tool_failed' ||
            event.kind === 'tool_cancelled',
        )
        .map((event) => event.tool_call_id),
    );
    for (const toolCallId of deliveredToolCallIds) {
      if (!terminalToolCallIds.has(toolCallId)) {
        throw new Error(
          `${subject}: delivered tool call ${toolCallId} has no prior terminal result`,
        );
      }
    }
    return;
  }
  const inputs = history.filter((event) => event.kind === 'model_input_receipt');
  const results = history.filter((event) => event.kind === 'model_result_delivery');
  const input = inputs[0];
  if (inputs.length !== 1 || results.length !== 0 || !input) {
    throw new Error(`${subject}: model result delivery requires one prior input receipt`);
  }
  if (input.provider !== candidate.provider || input.sent_model_id !== candidate.model) {
    throw new Error(`${subject}: model result delivery identity does not match its input receipt`);
  }
}

/** Ensure provider failure evidence is attached to one exact failed inference. */
export function assertProviderFailureReceiptCausality(
  priorEvents: readonly SessionEvent[],
  candidate: ProviderFailureReceiptEvent,
  subject: string,
): void {
  try {
    validateProviderFailureReceipt(candidate.receipt);
  } catch (error) {
    throw new Error(`${subject}: provider failure receipt is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    candidate.receipt.local_request_id !== candidate.inference_id ||
    candidate.receipt.provider !== candidate.provider ||
    candidate.receipt.exact_model_id !== candidate.model
  ) {
    throw new Error(`${subject}: provider failure receipt identity does not match its event`);
  }
  const matchingInputs = priorEvents.filter(
    (event): event is Extract<SessionEvent, { kind: 'model_input_receipt' }> =>
      event.kind === 'model_input_receipt' &&
      event.turn_id === candidate.turn_id &&
      event.inference_id === candidate.inference_id,
  );
  if (matchingInputs.length !== 1) {
    throw new Error(`${subject}: provider failure receipt requires one matching model input receipt`);
  }
  if (priorEvents.some(
    (event) =>
      event.kind === 'provider_failure_receipt' &&
      event.turn_id === candidate.turn_id &&
      event.inference_id === candidate.inference_id,
  )) {
    throw new Error(`${subject}: provider failure receipt is duplicated`);
  }
}

/** Ensure phase evidence is attached to an already-recorded provider input. */
export function assertModelInvocationPhaseCausality(
  priorEvents: readonly SessionEvent[],
  candidate: ModelInvocationPhaseEvent,
  subject: string,
): void {
  const input = priorEvents.find(
    (event): event is Extract<SessionEvent, { kind: 'model_input_receipt' }> =>
      event.kind === 'model_input_receipt' &&
      event.turn_id === candidate.turn_id &&
      event.inference_id === candidate.inference_id,
  );
  if (!input || input.provider !== candidate.provider || input.sent_model_id !== candidate.model) {
    throw new Error(`${subject}: invocation phase requires a matching model input receipt`);
  }
}

/** Ensure capability state is bound to an already-recorded exact inference. */
export function assertCapabilityBindingCausality(
  priorEvents: readonly SessionEvent[],
  candidate: CapabilityBindingLifecycleEvent,
  subject: string,
): void {
  const inputs = priorEvents.filter(
    (event): event is Extract<SessionEvent, { kind: 'model_input_receipt' }> =>
      event.kind === 'model_input_receipt' &&
      event.turn_id === candidate.turn_id &&
      event.inference_id === candidate.inference_id,
  );
  if (inputs.length !== 1 || inputs[0]!.provider !== candidate.provider) {
    throw new Error(`${subject}: capability binding requires one matching model input receipt`);
  }
  const duplicate = priorEvents.some(
    (event) =>
      event.kind === 'capability_binding_receipt' &&
      event.turn_id === candidate.turn_id &&
      event.inference_id === candidate.inference_id &&
      event.capability === candidate.capability,
  );
  if (duplicate) {
    throw new Error(`${subject}: capability binding is duplicated for this inference`);
  }
}
