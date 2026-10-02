import type { TerminalOutcome } from '../schemas/agentContracts.js';
import type { TerminalReasonCode } from './chatTerminalReason.js';
import { type ToolEffectClass } from '../executor/contracts.js';
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';
import type { WorkingState } from './codingLoop/workingState.js';
import { type BdnsObservationBus } from '../diagnostics/bdns/observationBus.js';
import { type ProviderId } from '../runners/providerRegistry.js';
import { type ContextManifestV1 } from './contextManifest.js';
import { type ModelRouteReceiptV1 } from './modelRouteReceipt.js';
import { type ProviderFailureReceiptV1 } from '../runners/providerFailureReceipt.js';


export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;

export const SESSION_EVENTS_FILENAME = 'session-events.jsonl';


export type SessionEventObservationHook = (event: SessionEvent) => void | Promise<void>;

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
  | 'model_input_receipt'
  | 'model_invocation_phase'
  | 'capability_binding_receipt'
  | 'model_result_delivery'
  | 'provider_failure_receipt'
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
  | 'repair_attempt'
  | 'working_state_snapshot';

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
      continued_task?: boolean;
    })
  | (SessionEventBase & {
      kind: 'model_started';
      model?: string;
      provider?: string;
    })
  | (SessionEventBase & {
      /** Exact, content-free input receipt for one provider inference. */
      kind: 'model_input_receipt';
      inference_id: string;
      provider: ProviderId;
      requested_model_id: string;
      normalized_model_id: string;
      sent_model_id: string;
      input_digest: string;
      /** Prepared-request identity; request_id is stable across ordinary retries. */
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
    })
  | (SessionEventBase & {
      /** Secret-free, hashed provider failure evidence for one inference. */
      kind: 'provider_failure_receipt';
      inference_id: string;
      provider: ProviderId;
      model: string;
      receipt: ProviderFailureReceiptV1;
    })
  | (SessionEventBase & {
      /** Content-free provider lifecycle phase for one exact inference. */
      kind: 'model_invocation_phase';
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
    })
  | (SessionEventBase & {
      /** Terminal provider/result-delivery receipt for one inference. */
      kind: 'model_result_delivery';
      inference_id: string;
      provider: ProviderId;
      model: string;
      status: 'delivered' | 'failed';
      observed_model_id?: string | null;
      /** Upstream gateway provider identity, when exposed by the provider. */
      upstream_provider?: string | null;
      output_digest?: string | null;
      failure_receipt?: {
        inference_id: string;
        provider: ProviderId;
        model: string;
        provider_request_id: string | null;
        observed_upstream: string | null;
        http_status: number | null;
        api_error_code: string | null;
        failure_class: string;
        actual_attempt: number;
        max_attempts: number;
        stream: boolean;
        failure_stage: 'request' | 'response' | 'stream' | 'response_normalization' | 'unknown';
        inference_started: boolean;
        partial_model_output: boolean;
        tool_call_count: number;
        requested_output_budget: number | null;
        effective_output_budget: number | null;
        wire_policy_hash: string | null;
        execution_envelope_hash: string | null;
        output_digest: string;
        retryable: boolean;
      };
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
    })
  | (SessionEventBase & {
      /** Advertised/authorized/effective capability state for one inference. */
      kind: 'capability_binding_receipt';
      inference_id: string;
      provider: ProviderId;
      capability: string;
      advertised: boolean;
      authorized: boolean | null;
      effective: boolean | null;
      evidence_ref?: string;
    })
  | (SessionEventBase & {
      kind: 'provider_retry_scheduled';
      provider: ProviderId;
      model: string;
      request_id?: string;
      attempt_id?: string;
      body_digest?: string;
      attempt: number;
      reason: 'transport' | 'timeout' | 'rate_limit' | 'server_error' | 'stream_idle';
      backoff_ms: number;
    })
  | (SessionEventBase & {
      kind: 'provider_retry_settled';
      provider: ProviderId;
      model: string;
      request_id?: string;
      attempt_id?: string;
      body_digest?: string;
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
      /** Tool-call identity whose result contains the verifier output. */
      tool_call_id?: string;
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
      /** D03: structured reason code — `reason` stays free-text/diagnostic. */
      reason_code?: TerminalReasonCode;
      /** D03: separate model-vs-harness cause axis; null = not established. */
      cause_class?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
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
      /** Omitted when the cause is not established. */
      outcome?: TerminalOutcome;
      status: string;
      /** D03: structured terminal reason; survives persistence/replay. */
      reason_code?: TerminalReasonCode;
      /** D03: separate model-vs-harness cause axis; null = not established. */
      cause_class?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
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
    })
  | (SessionEventBase & {
      kind: 'working_state_snapshot';
      state_schema_version: 1;
      state: WorkingState;
    });

export interface RecoveredOutcomeReconciliationAuthorization {
  recovered_idempotency_key: string;
  operation_fingerprint: string;
  reconciliation_ref: string;
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


export type ToolLifecycleEvent = Extract<
  SessionEvent,
  { kind: 'tool_proposed' | 'tool_started' | 'tool_completed' | 'tool_failed' | 'tool_cancelled' }
>;


export type CompactionLifecycleEvent = Extract<
  SessionEvent,
  { kind: 'compaction_started' | 'compaction_summary' | 'compaction_committed' }
>;


export type ProviderRetryLifecycleEvent = Extract<
  SessionEvent,
  { kind: 'provider_retry_scheduled' | 'provider_retry_settled' }
>;


export type ModelInvocationLifecycleEvent = Extract<
  SessionEvent,
  { kind: 'model_input_receipt' | 'model_result_delivery' }
>;


export type CapabilityBindingLifecycleEvent = Extract<SessionEvent, { kind: 'capability_binding_receipt' }>;


export type ModelInvocationPhaseEvent = Extract<SessionEvent, { kind: 'model_invocation_phase' }>;


export type ProviderFailureReceiptEvent = Extract<SessionEvent, { kind: 'provider_failure_receipt' }>;
