/**
 * Unified ChatEvent dispatch — renderer, stream callbacks, and protocol notifications.
 */

import type { ChatEvent, ChatResult } from '../../agent/chatEngine.js';
import { computeTerminalOutcome, outcomeFromReasonCode } from '../../agent/chatEngineObservability.js';
import type { TurnRoutingReceipt } from '../../agent/turnRoutingReceipt.js';
import type { BlockedReport, TerminalOutcome } from '../../schemas/agentContracts.js';
import type { SessionUsageSummary } from '../../services/costTracker.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { ConversationalRenderer } from '../../ui/waterfall.js';
import type { ProtocolTurnSession } from './chatTransport.js';

export type ChatStreamEvent =
  | { type: 'assistant_chunk'; chunk: string }
  | { type: 'thought'; text: string };

export interface ChatEventDispatchSinks {
  convRenderer?: ConversationalRenderer | null;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  protocolSession?: ProtocolTurnSession | null;
  toolIdQueue?: number[];
  toolIdsByCallId?: Map<string, number>;
}

import {
  classifyFailureText,
  isBudgetErrorText,
  isEnvironmentErrorText,
  isInfrastructureErrorText,
  isPolicyErrorText,
  projectChatTerminal,
  resolveFailedEventOutcome,
  statusForOutcome,
} from '../../agent/chatFailureClassification.js';

export {
  classifyFailureText,
  isBudgetErrorText,
  isEnvironmentErrorText,
  isInfrastructureErrorText,
  isPolicyErrorText,
  projectChatTerminal,
  resolveFailedEventOutcome,
  statusForOutcome,
};

/** Dispatch one chat event to all configured sinks. Returns a terminal ChatResult on failure. */
export function dispatchChatEvent(
  event: ChatEvent,
  sinks: ChatEventDispatchSinks,
): ChatResult | null {
  sinks.protocolSession?.emitChatEvent(event);

  switch (event.type) {
    case 'thinking':
      // Generation boundary: a new model iteration is starting with no
      // intervening tool call. The renderer must commit the previous
      // generation's streamed answer instead of concatenating onto it.
      sinks.convRenderer?.onAnswerGenerationBoundary();
      break;
    case 'answer_chunk':
      sinks.convRenderer?.onAnswerChunk(event.text);
      sinks.onStreamEvent?.({ type: 'assistant_chunk', chunk: event.text });
      break;
    case 'thought':
      sinks.convRenderer?.onThought(event.text);
      sinks.onStreamEvent?.({ type: 'thought', text: event.text });
      break;
    case 'context_compacted':
      sinks.convRenderer?.onContextCompacted(event.message);
      sinks.onStreamEvent?.({ type: 'thought', text: event.message });
      break;
    case 'tool_start': {
      const id = sinks.convRenderer?.onToolCallStart(event.tool, event.target) ?? -1;
      if (event.toolCallId) sinks.toolIdsByCallId?.set(event.toolCallId, id);
      else sinks.toolIdQueue?.push(id);
      break;
    }
    case 'tool_complete':
    case 'tool_failed': {
      const id = event.toolCallId
        ? sinks.toolIdsByCallId?.get(event.toolCallId)
        : sinks.toolIdQueue?.shift();
      if (id !== undefined && id >= 0) {
        sinks.convRenderer?.onToolCallComplete(id, event.detail, event.error, event.exitCode);
      }
      if (event.toolCallId) sinks.toolIdsByCallId?.delete(event.toolCallId);
      break;
    }
    case 'sub_agent_start':
      sinks.convRenderer?.onSubAgentStart(event.id, event.label, event.model);
      break;
    case 'sub_agent_complete':
      sinks.convRenderer?.onSubAgentComplete(event.id, event.summary, event.tokens);
      break;
    case 'sub_agent_failed':
      sinks.convRenderer?.onSubAgentFailed(event.id, event.error);
      break;
    case 'file_changed':
      sinks.convRenderer?.onFileChanged(
        event.path,
        event.additions,
        event.deletions,
        event.content,
      );
      break;
    case 'progress_recovery':
      sinks.convRenderer?.onProgressRecovery?.(event.intervention, event.source, event.score, event.message);
      break;
    case 'cancelled':
    case 'done':
    case 'failed':
      break;
    default:
      break;
  }

  if (event.type === 'failed') {
    // R0-9: a typed reason is authoritative for the tuple; derive the outcome
    // from it so the forwarded reason_code can never disagree with the outcome.
    const reasonOutcome = event.reason_code
      ? outcomeFromReasonCode(event.reason_code)
      : undefined;
    const outcome = reasonOutcome ?? resolveFailedEventOutcome(event.error, event.outcome);
    const ev = event as {
      turnRouting?: TurnRoutingReceipt[];
      verifierReceipt?: ChatResult['verifierReceipt'];
      blockedReport?: ChatResult['blockedReport'];
    };
    const terminal = projectChatTerminal({
      ...(outcome !== undefined ? { outcome } : {}),
      status: 'failed',
    });
    return {
      status: terminal.status,
      ...(terminal.outcome !== undefined ? { outcome: terminal.outcome } : {}),
      answer: event.error,
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
      ...(event.toolCalls !== undefined ? { toolCalls: event.toolCalls } : {}),
      ...(event.runDir !== undefined ? { runDir: event.runDir } : {}),
      ...(event.turnTelemetry !== undefined ? { turnTelemetry: event.turnTelemetry } : {}),
      ...(event.costBudget !== undefined ? { costBudget: event.costBudget } : {}),
      ...(event.runAllowance !== undefined ? { runAllowance: event.runAllowance } : {}),
      ...(ev.turnRouting !== undefined ? { turnRouting: ev.turnRouting } : {}),
      ...(ev.verifierReceipt !== undefined ? { verifierReceipt: ev.verifierReceipt } : {}),
      ...(ev.blockedReport !== undefined ? { blockedReport: ev.blockedReport } : {}),
      ...(event.reason_code !== undefined ? { reason_code: event.reason_code } : {}),
      ...(event.cause_class !== undefined ? { cause_class: event.cause_class } : {}),
    };
  }

  if (event.type === 'cancelled') {
    const terminal = projectChatTerminal({ outcome: event.outcome ?? 'CANCELLED' });
    const ev = event as {
      toolCalls?: ChatResult['toolCalls'];
      runDir?: string;
      turnRouting?: TurnRoutingReceipt[];
      verifierReceipt?: ChatResult['verifierReceipt'];
    };
    return {
      status: terminal.status,
      outcome: terminal.outcome!,
      answer: 'Cancelled',
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
      reason_code: event.reason_code ?? 'cancelled',
      cause_class: event.cause_class ?? null,
      ...(event.turnTelemetry !== undefined ? { turnTelemetry: event.turnTelemetry } : {}),
      ...(ev.toolCalls !== undefined ? { toolCalls: ev.toolCalls } : {}),
      ...(ev.runDir !== undefined ? { runDir: ev.runDir } : {}),
      ...(ev.turnRouting !== undefined ? { turnRouting: ev.turnRouting } : {}),
      ...(ev.verifierReceipt !== undefined ? { verifierReceipt: ev.verifierReceipt } : {}),
    };
  }

  return null;
}

export function terminalResultFromDoneEvent(
  answer: string,
  usage: SessionUsageSummary,
  toolCalls?: Array<{ tool: string; target: string; detail?: string; error?: string }>,
  runDir?: string,
  verifierReceipt?: { command: string; exit_code: number; summary: string } | null,
  blockedReport?: BlockedReport | null,
  opts?: {
    /** Prefer engine-emitted outcome (P0-D lossless). */
    outcome?: TerminalOutcome;
    budgetExceeded?: boolean;
    criticReceipt?: ChatResult['criticReceipt'];
    verifierTampered?: boolean;
    turnRouting?: TurnRoutingReceipt[];
    turnTelemetry?: import('../../agent/chatTurnTelemetry.js').ChatTurnTelemetryRecord;
    costBudget?: ChatResult['costBudget'];
    runAllowance?: ChatResult['runAllowance'];
    policyEvents?: ChatResult['policyEvents'];
    status?: ChatResult['status'];
    /** D03: structured terminal reason code. */
    reason_code?: ChatResult['reason_code'];
    cause_class?: ChatResult['cause_class'];
  },
): ChatResult {
  // Prefer the engine's authoritative TerminalOutcome. Only recompute when
  // older fixtures omit it (tests / partial events).
  const budgetExceeded = opts?.budgetExceeded === true;
  // R0-9: a typed reason is authoritative, but `verification_failed` legitimately
  // pairs with UNVERIFIED_PATCH on the completed path, so it is not remapped.
  const reasonOutcome =
    opts?.reason_code && opts.reason_code !== 'verification_failed'
      ? outcomeFromReasonCode(opts.reason_code)
      : undefined;
  const outcome: TerminalOutcome =
    reasonOutcome ??
    opts?.outcome ??
    computeTerminalOutcome({
      finalStatus: blockedReport ? 'blocked' : budgetExceeded ? 'budget_exhausted' : 'completed',
      budgetExceeded,
      lastVerifierReceipt: verifierReceipt,
      blockedReport,
    });

  const observedStatus: ChatResult['status'] = opts?.status ?? (blockedReport
    ? 'blocked'
    : budgetExceeded
      ? 'budget_exhausted'
      : 'completed');
  const terminal = projectChatTerminal({ outcome, status: observedStatus });

  return {
    status: terminal.status,
    ...(terminal.outcome !== undefined ? { outcome: terminal.outcome } : {}),
    answer,
    usage,
    conversation: [],
    ...(toolCalls ? { toolCalls } : {}),
    ...(runDir ? { runDir } : {}),
    ...(verifierReceipt ? { verifierReceipt } : {}),
    ...(blockedReport ? { blockedReport } : {}),
    ...(budgetExceeded ? { budgetExceeded: true as const } : {}),
    ...(opts?.criticReceipt ? { criticReceipt: opts.criticReceipt } : {}),
    ...(opts?.verifierTampered ? { verifierTampered: true as const } : {}),
    ...(opts?.turnRouting ? { turnRouting: opts.turnRouting } : {}),
    ...(opts?.turnTelemetry !== undefined ? { turnTelemetry: opts.turnTelemetry } : {}),
    ...(opts?.costBudget ? { costBudget: opts.costBudget } : {}),
    ...(opts?.runAllowance ? { runAllowance: opts.runAllowance } : {}),
    ...(opts?.policyEvents ? { policyEvents: opts.policyEvents } : {}),
    ...(opts?.reason_code !== undefined ? { reason_code: opts.reason_code } : {}),
    ...(opts?.cause_class !== undefined ? { cause_class: opts.cause_class } : {}),
  };
}
