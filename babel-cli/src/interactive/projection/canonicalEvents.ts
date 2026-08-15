/**
 * Canonical Typed Turn Events for Babel TUI & Chat Engine.
 *
 * Defines the unified semantic event stream from which all UI components
 * (status bar, review card, transcript cells, telemetry) are projected.
 */

import type { TerminalOutcome } from '../../schemas/agentContracts.js';
import type { VerifierReceipt } from '../../agent/completionGatePolicy.js';
import type { SessionEvent } from '../../agent/sessionEvents.js';

export type CanonicalEventType =
  | 'turn_started'
  | 'provider_request_started'
  | 'provider_usage_recorded'
  | 'assistant_chunk_received'
  | 'tool_started'
  | 'tool_progressed'
  | 'tool_completed'
  | 'mutation_batch_recorded'
  | 'policy_intervention_triggered'
  | 'verification_evaluated'
  | 'turn_terminal_resolved'
  | 'model_switched'
  | 'context_compacted';

export interface TurnStartedEvent {
  type: 'turn_started';
  turnId: string;
  timestamp: number;
  userInput: string;
  taskClass: string;
  model: string;
  modelId: string;
}

export interface ProviderRequestStartedEvent {
  type: 'provider_request_started';
  requestId: string;
  timestamp: number;
  modelId: string;
  isHelperModel?: boolean;
}

export interface ProviderUsageRecordedEvent {
  type: 'provider_usage_recorded';
  requestId: string;
  timestamp: number;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  isHelperModel?: boolean;
}

export interface AssistantChunkReceivedEvent {
  type: 'assistant_chunk_received';
  timestamp: number;
  textChunk: string;
}

export interface ToolStartedEvent {
  type: 'tool_started';
  toolId: string;
  toolName: string;
  target: string;
  timestamp: number;
  isMutating: boolean;
}

export interface ToolProgressedEvent {
  type: 'tool_progressed';
  toolId: string;
  timestamp: number;
  message: string;
}

export interface ToolCompletedEvent {
  type: 'tool_completed';
  toolId: string;
  toolName: string;
  target: string;
  timestamp: number;
  durationMs: number;
  exitCode: number;
  outputSummary?: string;
  error?: string;
  isMutating: boolean;
}

export interface MutationBatchRecordedEvent {
  type: 'mutation_batch_recorded';
  timestamp: number;
  paths: string[];
}

export interface PolicyInterventionTriggeredEvent {
  type: 'policy_intervention_triggered';
  timestamp: number;
  policyKind: 'read_thrash' | 'force_mutate' | 'investigate_budget' | 'stall_nudge';
  action: 'nudge' | 'restrict_tools' | 'force_status' | 'kill';
  message: string;
}

export interface VerificationEvaluatedEvent {
  type: 'verification_evaluated';
  timestamp: number;
  command: string;
  exitCode: number;
  receipt: VerifierReceipt;
  passed: boolean;
}

export interface TurnTerminalResolvedEvent {
  type: 'turn_terminal_resolved';
  timestamp: number;
  outcome: TerminalOutcome;
  status: 'completed' | 'cancelled' | 'blocked' | 'budget_exhausted' | 'failed';
  finalAnswer: string;
}

export interface ModelSwitchedEvent {
  type: 'model_switched';
  timestamp: number;
  newModel: string;
  newModelId: string;
}

export interface ContextCompactedEvent {
  type: 'context_compacted';
  timestamp: number;
  tokensBefore: number;
  tokensAfter: number;
}

export type CanonicalTurnEvent =
  | TurnStartedEvent
  | ProviderRequestStartedEvent
  | ProviderUsageRecordedEvent
  | AssistantChunkReceivedEvent
  | ToolStartedEvent
  | ToolProgressedEvent
  | ToolCompletedEvent
  | MutationBatchRecordedEvent
  | PolicyInterventionTriggeredEvent
  | VerificationEvaluatedEvent
  | TurnTerminalResolvedEvent
  | ModelSwitchedEvent
  | ContextCompactedEvent;

export function mapOutcomeToStatus(
  outcome: TerminalOutcome,
): 'completed' | 'cancelled' | 'blocked' | 'budget_exhausted' | 'failed' {
  switch (outcome) {
    case 'VERIFIED_COMPLETE':
    case 'UNVERIFIED_PATCH':
    case 'NO_CHANGE_REQUIRED':
      return 'completed';
    case 'CANCELLED':
      return 'cancelled';
    case 'BLOCKED_POLICY':
    case 'BLOCKED_EXTERNAL':
    case 'NEEDS_HUMAN_DECISION':
      return 'blocked';
    case 'BUDGET_EXHAUSTED':
      return 'budget_exhausted';
    case 'AGENT_FAILURE':
    case 'INFRA_FAILURE':
    case 'INVALID_TASK':
    default:
      return 'failed';
  }
}

export function mapSessionEventToCanonicalTurnEvent(ev: SessionEvent): CanonicalTurnEvent | null {
  const ts = new Date(ev.ts).getTime() || performance.now();
  switch (ev.kind) {
    case 'user_submitted':
      return {
        type: 'turn_started',
        turnId: ev.turn_id ?? '0',
        timestamp: ts,
        userInput: ev.task_preview,
        taskClass: ev.task_class ?? 'default',
        model: ev.model ?? 'unknown',
        modelId: ev.model ?? 'unknown',
      };
    case 'model_started':
      return {
        type: 'provider_request_started',
        requestId: ev.event_id,
        timestamp: ts,
        modelId: ev.model ?? 'unknown',
      };
    case 'tool_started':
      return {
        type: 'tool_started',
        toolId: ev.tool_call_id,
        toolName: ev.tool_name,
        target: '',
        timestamp: ts,
        isMutating:
          ev.effect_class === 'reconcilable_mutation' ||
          ev.effect_class === 'non_idempotent_local_effect',
      };
    case 'tool_completed':
    case 'tool_failed': {
      const err = ev.kind === 'tool_failed' ? (ev as { error_preview?: string }).error_preview : undefined;
      return {
        type: 'tool_completed',
        toolId: ev.tool_call_id,
        toolName: ev.tool_name,
        target: '',
        timestamp: ts,
        durationMs: 0,
        exitCode: ev.exit_code ?? (ev.kind === 'tool_completed' ? 0 : 1),
        ...(err ? { error: err } : {}),
        isMutating: false,
      };
    }
    case 'mutation_batch':
      return {
        type: 'mutation_batch_recorded',
        timestamp: ts,
        paths: [...ev.paths],
      };
    case 'verifier_attempt':
      return {
        type: 'verification_evaluated',
        timestamp: ts,
        command: ev.command_preview,
        exitCode: ev.exit_code ?? -1,
        receipt: ev.receipt as unknown as VerifierReceipt,
        passed: ev.exit_code === 0,
      };
    case 'policy_intervened':
      return {
        type: 'policy_intervention_triggered',
        timestamp: ts,
        policyKind: 'stall_nudge',
        action: 'nudge',
        message: ev.detail ?? ev.action,
      };
    case 'completion_decision': {
      const outcome = ev.final_outcome as TerminalOutcome;
      return {
        type: 'turn_terminal_resolved',
        timestamp: ts,
        outcome,
        status: mapOutcomeToStatus(outcome),
        finalAnswer: ev.reason,
      };
    }
    case 'turn_ended': {
      const outcome = (ev as { outcome?: TerminalOutcome }).outcome;
      const status = (ev as { status?: 'completed' | 'cancelled' | 'blocked' | 'budget_exhausted' | 'failed' }).status;
      if (!outcome && !status) {
        return null;
      }
      const resolvedOutcome = outcome ?? (status === 'cancelled' ? 'CANCELLED' : status === 'blocked' ? 'BLOCKED_POLICY' : status === 'budget_exhausted' ? 'BUDGET_EXHAUSTED' : 'AGENT_FAILURE');
      return {
        type: 'turn_terminal_resolved',
        timestamp: ts,
        outcome: resolvedOutcome,
        status: status ?? mapOutcomeToStatus(resolvedOutcome),
        finalAnswer: '',
      };
    }
    default:
      return null;
  }
}

export function mapSessionEventsToCanonicalTurnEvents(
  events: readonly SessionEvent[],
): CanonicalTurnEvent[] {
  const out: CanonicalTurnEvent[] = [];
  for (const ev of events) {
    const mapped = mapSessionEventToCanonicalTurnEvent(ev);
    if (mapped) out.push(mapped);
  }
  return out;
}
