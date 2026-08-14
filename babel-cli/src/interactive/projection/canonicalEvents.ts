/**
 * Canonical Typed Turn Events for Babel TUI & Chat Engine.
 *
 * Defines the unified semantic event stream from which all UI components
 * (status bar, review card, transcript cells, telemetry) are projected.
 */

import type { TerminalOutcome } from '../../schemas/agentContracts.js';
import type { VerifierReceipt } from '../../agent/completionGatePolicy.js';

export type CanonicalEventType =
  | 'turn_started'
  | 'provider_request_started'
  | 'provider_usage_recorded'
  | 'assistant_chunk_received'
  | 'tool_started'
  | 'tool_progressed'
  | 'tool_completed'
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
  | PolicyInterventionTriggeredEvent
  | VerificationEvaluatedEvent
  | TurnTerminalResolvedEvent
  | ModelSwitchedEvent
  | ContextCompactedEvent;
