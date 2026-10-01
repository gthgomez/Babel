import { join } from 'node:path';
import { type ToolEffectClass } from '../executor/contracts.js';
import { createBdnsObservationBus } from '../diagnostics/bdns/observationBus.js';
import { PROVIDER_IDS } from '../runners/providerRegistry.js';
import { validateContextManifest, type ContextManifestV1 } from './contextManifest.js';
import { validateModelRouteReceipt, type ModelRouteReceiptV1 } from './modelRouteReceipt.js';
import { validateProviderFailureReceipt } from '../runners/providerFailureReceipt.js';
import {
  SESSION_EVENT_SCHEMA_VERSION,
  type CapabilityBindingLifecycleEvent,
  type CompactionLifecycleEvent,
  type InterruptedToolRecovery,
  type InterruptedToolRecoveryState,
  type ModelInvocationLifecycleEvent,
  type ModelInvocationPhaseEvent,
  type ProviderFailureReceiptEvent,
  type ProviderRetryLifecycleEvent,
  type SessionEvent,
  type SessionEventKind,
  type SessionEventLog,
  type SessionEventLogRestoreCode,
  type ToolLifecycleEvent,
} from './sessionEventSchema.js';
import {
  assertCapabilityBindingCausality,
  assertCompactionLifecycleCausality,
  assertModelInvocationLifecycleCausality,
  assertModelInvocationPhaseCausality,
  assertProviderFailureReceiptCausality,
  assertProviderRetryLifecycleCausality,
  assertRecoveryReconciliationCausality,
  assertSessionEventToolLifecycleCausality,
} from './sessionEventCausality.js';

export class SessionEventLogRestoreError extends Error {
  readonly code: SessionEventLogRestoreCode

  constructor(code: SessionEventLogRestoreCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SessionEventLogRestoreError'
    this.code = code
  }
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
    'user_submitted', 'model_started', 'model_input_receipt', 'model_invocation_phase', 'capability_binding_receipt', 'model_result_delivery', 'provider_failure_receipt', 'provider_retry_scheduled', 'provider_retry_settled', 'tool_proposed', 'tool_started',
    'tool_completed', 'tool_failed', 'tool_cancelled', 'recovery_reconciled', 'mutation_batch',
    'verifier_attempt', 'gate_decision', 'policy_intervened', 'progress_recovery',
    'completion_decision', 'model_failover', 'compaction_started', 'compaction_summary', 'compaction_committed', 'compaction_created', 'turn_ended',
    'budget_snapshot', 'approval_decision', 'repair_attempt', 'working_state_snapshot',
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
      model_input_receipt: ['inference_id', 'provider', 'requested_model_id', 'normalized_model_id', 'sent_model_id', 'input_digest', 'input_ref'],
      model_invocation_phase: ['inference_id', 'provider', 'model', 'phase'],
      capability_binding_receipt: ['inference_id', 'provider', 'capability', 'advertised', 'authorized', 'effective'],
      model_result_delivery: ['inference_id', 'provider', 'model', 'status'], provider_failure_receipt: ['inference_id', 'provider', 'model', 'receipt'],
      provider_retry_scheduled: ['provider', 'model', 'attempt', 'reason', 'backoff_ms'],
      provider_retry_settled: ['provider', 'model', 'attempt', 'outcome'],
      tool_proposed: ['tool_call_id', 'tool_name', 'idempotency_key'],
      tool_started: ['tool_call_id', 'tool_name', 'idempotency_key'], tool_completed: ['tool_call_id', 'tool_name', 'idempotency_key'],
      tool_failed: ['tool_call_id', 'tool_name', 'idempotency_key'], tool_cancelled: ['tool_call_id', 'tool_name', 'idempotency_key'],
      recovery_reconciled: ['recovered_idempotency_key', 'operation_fingerprint', 'reconciliation_ref'],
      mutation_batch: ['paths'], verifier_attempt: ['command_preview', 'authoritative'], gate_decision: ['decision'],
      policy_intervened: ['source', 'action'], progress_recovery: ['intervention', 'score', 'signals'],
      completion_decision: ['requested_outcome', 'final_outcome', 'allowed', 'reason', 'evidence_refs', 'policy_version'],
      model_failover: [], compaction_started: ['operation_id', 'strategy', 'replaces_thread_seq_start', 'replaces_thread_seq_end', 'replaces_message_count'], compaction_summary: ['operation_id', 'capsule_digest', 'raw_observation_refs', 'preserved_tool_call_ids'], compaction_committed: ['operation_id', 'thread_event_id', 'capsule_digest', 'replaces_thread_seq_start', 'replaces_thread_seq_end', 'replaces_message_count', 'preserved_tool_call_ids'], compaction_created: [], turn_ended: ['status'], budget_snapshot: [],
      approval_decision: ['request_id', 'decision'], repair_attempt: ['failure_class', 'attempt'],
      working_state_snapshot: ['state_schema_version', 'state'],
    }
    const arrayFields = new Set(['paths', 'signals', 'evidence_refs', 'raw_observation_refs', 'preserved_tool_call_ids', 'delivered_tool_call_ids'])
    const objectFields = new Set(['receipt', 'state'])
    const booleanFields = new Set(['authoritative', 'allowed', 'advertised', 'continued_task'])
    const nullableBooleanFields = new Set(['authorized', 'effective'])
    const numberFields = new Set(['score', 'attempt', 'backoff_ms', 'replaces_thread_seq_start', 'replaces_thread_seq_end', 'replaces_message_count', 'status_code', 'state_schema_version'])
    for (const field of required[ev.kind as SessionEventKind]) {
      if (!(field in ev)) throw new Error(`Invalid session event at line ${index + 1}: ${field} is required`)
      const fieldValue = ev[field]
      if (arrayFields.has(field) && !Array.isArray(fieldValue)) {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be an array`)
      }
      if (booleanFields.has(field) && typeof fieldValue !== 'boolean') {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be boolean`)
      }
      if (nullableBooleanFields.has(field) && fieldValue !== null && typeof fieldValue !== 'boolean') {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be boolean or null`)
      }
      if (numberFields.has(field) && typeof fieldValue !== 'number') {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be a number`)
      }
      if (!arrayFields.has(field) && !objectFields.has(field) && !booleanFields.has(field) && !nullableBooleanFields.has(field) && !numberFields.has(field) && typeof fieldValue !== 'string') {
        throw new Error(`Invalid session event at line ${index + 1}: ${field} must be a string`)
      }
    }
    if (ev.kind === 'working_state_snapshot' &&
        (ev.state_schema_version !== 1 || typeof ev.state !== 'object' || ev.state === null || Array.isArray(ev.state))) {
      throw new Error(`Invalid session event at line ${index + 1}: working state snapshot schema`)
    }
    if (ev.kind === 'user_submitted' && ev.continued_task !== undefined && typeof ev.continued_task !== 'boolean') {
      throw new Error(`Invalid session event at line ${index + 1}: continued_task must be a boolean`)
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
      if (!(PROVIDER_IDS as readonly string[]).includes(ev.provider as string) ||
        !['transport', 'timeout', 'rate_limit', 'server_error', 'stream_idle'].includes(ev.reason as string) ||
        !Number.isInteger(ev.attempt) || (ev.attempt as number) < 2 ||
        !Number.isInteger(ev.backoff_ms) || (ev.backoff_ms as number) < 0) {
        throw new Error(`Invalid session event at line ${index + 1}: provider retry schedule is invalid`)
      }
    }
    if (ev.kind === 'provider_retry_settled') {
      if (!(PROVIDER_IDS as readonly string[]).includes(ev.provider as string) ||
        !['succeeded', 'failed', 'cancelled'].includes(ev.outcome as string) ||
        !Number.isInteger(ev.attempt) || (ev.attempt as number) < 2) {
        throw new Error(`Invalid session event at line ${index + 1}: provider retry settlement is invalid`)
      }
    }
    if (ev.kind === 'model_input_receipt') {
      if (
        !(PROVIDER_IDS as readonly string[]).includes(ev.provider as string) ||
        typeof ev.inference_id !== 'string' || ev.inference_id.length === 0 ||
        typeof ev.input_ref !== 'string' || ev.input_ref.length === 0 ||
        !/^[a-f0-9]{64}$/.test(ev.input_digest as string) ||
        (ev.input_message_count !== undefined &&
          (!Number.isInteger(ev.input_message_count) || (ev.input_message_count as number) < 0))
        || (ev.delivered_tool_call_ids !== undefined &&
          (!Array.isArray(ev.delivered_tool_call_ids) ||
            ev.delivered_tool_call_ids.some((id) => typeof id !== 'string' || id.length === 0)))
      ) {
        throw new Error(`Invalid session event at line ${index + 1}: model input receipt is invalid`)
      }
      if (ev.context_manifest !== undefined) {
        if (typeof ev.context_manifest !== 'object' || ev.context_manifest === null || Array.isArray(ev.context_manifest)) {
          throw new Error(`Invalid session event at line ${index + 1}: context manifest is invalid`)
        }
        try {
          validateContextManifest(ev.context_manifest as ContextManifestV1)
        } catch (error) {
          throw new Error(
            `Invalid session event at line ${index + 1}: context manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (ev.route_receipt !== undefined) {
        try {
          validateModelRouteReceipt(ev.route_receipt);
          const routeReceipt = ev.route_receipt as ModelRouteReceiptV1;
          if (
            routeReceipt.inference_id !== ev.inference_id ||
            routeReceipt.provider !== ev.provider
          ) {
            throw new Error('route receipt identity does not match model input receipt');
          }
        } catch (error) {
          throw new Error(
            `Invalid session event at line ${index + 1}: route receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
    if (ev.kind === 'model_result_delivery') {
      if (
        !(PROVIDER_IDS as readonly string[]).includes(ev.provider as string) ||
        typeof ev.inference_id !== 'string' || ev.inference_id.length === 0 ||
        !['delivered', 'failed'].includes(ev.status as string) ||
        (ev.observed_model_id !== undefined &&
          ev.observed_model_id !== null && typeof ev.observed_model_id !== 'string') ||
        (ev.upstream_provider !== undefined &&
          ev.upstream_provider !== null && typeof ev.upstream_provider !== 'string') ||
        (ev.output_digest !== undefined && ev.output_digest !== null &&
          !/^[a-f0-9]{64}$/.test(ev.output_digest as string))
      ) {
        throw new Error(`Invalid session event at line ${index + 1}: model result delivery is invalid`)
      }
      const failureReceipt = ev.failure_receipt as Record<string, unknown> | undefined;
      const isRecord = failureReceipt !== null &&
        typeof failureReceipt === 'object' &&
        !Array.isArray(failureReceipt);
      const isNullableString = (value: unknown): boolean =>
        value === null || typeof value === 'string';
      const isNullableNonnegativeFiniteNumber = (value: unknown): boolean =>
        value === null ||
        (typeof value === 'number' && Number.isFinite(value) && value >= 0);
      const isNullableSha256 = (value: unknown): boolean =>
        value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
      if (failureReceipt !== undefined) {
        const receiptFieldsValid =
          isRecord &&
          failureReceipt.inference_id === ev.inference_id &&
          failureReceipt.provider === ev.provider &&
          failureReceipt.model === ev.model &&
          isNullableString(failureReceipt.provider_request_id) &&
          isNullableString(failureReceipt.observed_upstream) &&
          (failureReceipt.http_status === null ||
            (Number.isInteger(failureReceipt.http_status) &&
              (failureReceipt.http_status as number) >= 100 &&
              (failureReceipt.http_status as number) <= 599)) &&
          isNullableString(failureReceipt.api_error_code) &&
          typeof failureReceipt.failure_class === 'string' &&
          ['request', 'response', 'stream', 'response_normalization', 'unknown']
            .includes(failureReceipt.failure_stage as string) &&
          Number.isInteger(failureReceipt.actual_attempt) &&
          Number.isInteger(failureReceipt.max_attempts) &&
          (failureReceipt.actual_attempt as number) >= 1 &&
          (failureReceipt.max_attempts as number) >= 1 &&
          (failureReceipt.actual_attempt as number) <= (failureReceipt.max_attempts as number) &&
          typeof failureReceipt.stream === 'boolean' &&
          typeof failureReceipt.inference_started === 'boolean' &&
          typeof failureReceipt.partial_model_output === 'boolean' &&
          typeof failureReceipt.retryable === 'boolean' &&
          Number.isInteger(failureReceipt.tool_call_count) &&
          (failureReceipt.tool_call_count as number) >= 0 &&
          isNullableNonnegativeFiniteNumber(failureReceipt.requested_output_budget) &&
          isNullableNonnegativeFiniteNumber(failureReceipt.effective_output_budget) &&
          isNullableSha256(failureReceipt.wire_policy_hash) &&
          isNullableSha256(failureReceipt.execution_envelope_hash) &&
          typeof failureReceipt.output_digest === 'string' &&
          /^[a-f0-9]{64}$/.test(failureReceipt.output_digest) &&
          failureReceipt.retryable === false;
        if (!receiptFieldsValid || ev.status !== 'failed') {
          throw new Error(`Invalid session event at line ${index + 1}: provider failure receipt is invalid`)
        }
      } else if (ev.status === 'failed') {
        throw new Error(`Invalid session event at line ${index + 1}: failed model result is missing provider failure receipt`)
      }
      for (const [field, expectedType] of [
        ['failure_class', 'string'],
        ['failure_stage', 'string'],
        ['provider_request_id', 'string'],
        ['api_error_code', 'string'],
      ] as const) {
        const value = ev[field];
        if (value !== undefined && value !== null && typeof value !== expectedType) {
          throw new Error(`Invalid session event at line ${index + 1}: ${field} is invalid`)
        }
      }
      for (const field of ['http_status', 'actual_attempt', 'max_attempts', 'tool_call_count'] as const) {
        const value = ev[field];
        if (value !== undefined && value !== null && (!Number.isInteger(value) || (value as number) < 0)) {
          throw new Error(`Invalid session event at line ${index + 1}: ${field} is invalid`)
        }
      }
      for (const field of ['stream', 'inference_started', 'partial_model_output', 'retryable'] as const) {
        const value = ev[field];
        if (value !== undefined && typeof value !== 'boolean') {
          throw new Error(`Invalid session event at line ${index + 1}: ${field} is invalid`)
        }
      }
      for (const [field, expectedType] of [
        ['requested_output_budget', 'number'],
        ['effective_output_budget', 'number'],
      ] as const) {
        const value = ev[field];
        if (
          value !== undefined && value !== null &&
          (typeof value !== expectedType || !Number.isFinite(value as number) || (value as number) < 0)
        ) {
          throw new Error(`Invalid session event at line ${index + 1}: ${field} is invalid`)
        }
      }
      for (const field of ['wire_policy_hash', 'execution_envelope_hash'] as const) {
        const value = ev[field];
        if (
          value !== undefined && value !== null &&
          (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        ) {
          throw new Error(`Invalid session event at line ${index + 1}: ${field} is invalid`)
        }
      }
      if (failureReceipt !== undefined) {
        const pairedFields = [
          ['failure_class', 'failure_class'],
          ['failure_stage', 'failure_stage'],
          ['provider_request_id', 'provider_request_id'],
          ['api_error_code', 'api_error_code'],
          ['http_status', 'http_status'],
          ['actual_attempt', 'actual_attempt'],
          ['max_attempts', 'max_attempts'],
          ['stream', 'stream'],
          ['inference_started', 'inference_started'],
          ['partial_model_output', 'partial_model_output'],
          ['retryable', 'retryable'],
          ['tool_call_count', 'tool_call_count'],
          ['requested_output_budget', 'requested_output_budget'],
          ['effective_output_budget', 'effective_output_budget'],
          ['wire_policy_hash', 'wire_policy_hash'],
          ['execution_envelope_hash', 'execution_envelope_hash'],
        ] as const;
        for (const [eventField, receiptField] of pairedFields) {
          if (ev[eventField] !== undefined && ev[eventField] !== failureReceipt[receiptField]) {
            throw new Error(`Invalid session event at line ${index + 1}: ${eventField} does not match provider failure receipt`)
          }
        }
      }
      if (ev.route_receipt !== undefined) {
        try {
          validateModelRouteReceipt(ev.route_receipt);
          const routeReceipt = ev.route_receipt as ModelRouteReceiptV1;
          if (
            routeReceipt.inference_id !== ev.inference_id ||
            routeReceipt.provider !== ev.provider ||
            routeReceipt.observed_model_id !== (ev.observed_model_id ?? null) ||
            routeReceipt.upstream_provider !== (ev.upstream_provider ?? null)
          ) {
            throw new Error('route receipt identity does not match model result delivery');
          }
        } catch (error) {
          throw new Error(
            `Invalid session event at line ${index + 1}: route receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
    if (ev.kind === 'provider_failure_receipt') {
      if (
        !(PROVIDER_IDS as readonly string[]).includes(ev.provider as string) ||
        typeof ev.inference_id !== 'string' || ev.inference_id.length === 0 ||
        typeof ev.model !== 'string' || ev.model.length === 0 ||
        typeof ev.receipt !== 'object' || ev.receipt === null || Array.isArray(ev.receipt)
      ) {
        throw new Error(`Invalid session event at line ${index + 1}: provider failure receipt is invalid`)
      }
      try {
        validateProviderFailureReceipt(ev.receipt)
      } catch (error) {
        throw new Error(
          `Invalid session event at line ${index + 1}: provider failure receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (ev.kind === 'capability_binding_receipt') {
      if (
        !(PROVIDER_IDS as readonly string[]).includes(ev.provider as string) ||
        typeof ev.inference_id !== 'string' || ev.inference_id.length === 0 ||
        typeof ev.capability !== 'string' || ev.capability.length === 0 ||
        typeof ev.advertised !== 'boolean' ||
        (ev.authorized !== null && typeof ev.authorized !== 'boolean') ||
        (ev.effective !== null && typeof ev.effective !== 'boolean') ||
        (ev.evidence_ref !== undefined &&
          (typeof ev.evidence_ref !== 'string' || ev.evidence_ref.length === 0))
      ) {
        throw new Error(`Invalid session event at line ${index + 1}: capability binding receipt is invalid`)
      }
    }
    if (ev.kind === 'model_invocation_phase') {
      const phases = [
        'request_created', 'request_dispatched', 'response_started', 'first_byte', 'stream_progress',
        'stream_completed', 'provider_error', 'response_normalized',
        'response_normalization_failed',
      ];
      if (
        !(PROVIDER_IDS as readonly string[]).includes(ev.provider as string) ||
        typeof ev.inference_id !== 'string' || ev.inference_id.length === 0 ||
        typeof ev.model !== 'string' || ev.model.length === 0 ||
        !phases.includes(ev.phase as string) ||
        (ev.status_code !== undefined && (!Number.isInteger(ev.status_code) ||
          (ev.status_code as number) < 100 || (ev.status_code as number) > 599)) ||
        (ev.detail !== undefined && (typeof ev.detail !== 'string' || ev.detail.length > 160))
      ) {
        throw new Error(`Invalid session event at line ${index + 1}: model invocation phase is invalid`)
      }
    }
    if (ev.kind === 'provider_failure_receipt') {
      if (
        !(PROVIDER_IDS as readonly string[]).includes(ev.provider as string) ||
        typeof ev.inference_id !== 'string' || ev.inference_id.length === 0 ||
        typeof ev.model !== 'string' || ev.model.length === 0 ||
        typeof ev.receipt !== 'object' || ev.receipt === null || Array.isArray(ev.receipt)
      ) {
        throw new Error(`Invalid session event at line ${index + 1}: provider failure receipt is invalid`)
      }
      try {
        validateProviderFailureReceipt(ev.receipt)
      } catch (error) {
        throw new Error(
          `Invalid session event at line ${index + 1}: provider failure receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (ev.kind === 'recovery_reconciled' &&
      (typeof ev.reconciliation_ref !== 'string' || !/^[A-Za-z0-9._:/#-]{1,160}$/.test(ev.reconciliation_ref))) {
      throw new Error(`Invalid session event at line ${index + 1}: reconciliation_ref is invalid`)
    }
    if (ev.kind === 'verifier_attempt' && ev.tool_call_id !== undefined &&
      (typeof ev.tool_call_id !== 'string' || ev.tool_call_id.length === 0)) {
      throw new Error(`Invalid session event at line ${index + 1}: verifier tool_call_id is invalid`)
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
    }
    if (ev.kind === 'model_input_receipt' || ev.kind === 'model_result_delivery') {
      assertModelInvocationLifecycleCausality(
        events,
        ev as unknown as ModelInvocationLifecycleEvent,
        `Invalid session event at line ${index + 1}`,
      )
    }
    if (ev.kind === 'capability_binding_receipt') {
      assertCapabilityBindingCausality(
        events,
        ev as unknown as CapabilityBindingLifecycleEvent,
        `Invalid session event at line ${index + 1}`,
      )
    }
    if (ev.kind === 'model_invocation_phase') {
      assertModelInvocationPhaseCausality(
        events,
        ev as unknown as ModelInvocationPhaseEvent,
        `Invalid session event at line ${index + 1}`,
      )
    }
    if (ev.kind === 'provider_failure_receipt') {
      assertProviderFailureReceiptCausality(
        events,
        ev as unknown as ProviderFailureReceiptEvent,
        `Invalid session event at line ${index + 1}`,
      )
    }
    if (ev.kind === 'recovery_reconciled') {
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
  }
  for (const verifier of events.filter(
    (event): event is Extract<SessionEvent, { kind: 'verifier_attempt' }> =>
      event.kind === 'verifier_attempt' && event.tool_call_id !== undefined,
  )) {
    const matchingTerminals = events.filter(
      (event) =>
        event.turn_id === verifier.turn_id &&
        (event.kind === 'tool_completed' ||
          event.kind === 'tool_failed' ||
          event.kind === 'tool_cancelled'),
    ).filter(
      (event) =>
        (event.kind === 'tool_completed' ||
          event.kind === 'tool_failed' ||
          event.kind === 'tool_cancelled') &&
        event.tool_call_id === verifier.tool_call_id,
    )
    if (matchingTerminals.length !== 1) {
      throw new Error(
        `Invalid session event log: verifier tool_call_id ${verifier.tool_call_id} must match exactly one terminal tool result`,
      )
    }
  }
  return {
    schema_version: SESSION_EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    events,
    nextSeq: maxSeq + 1,
    flushedThroughSeq: maxSeq,
    observationBus: createBdnsObservationBus<SessionEvent>({ maxQueue: 256 }),
  };
}
