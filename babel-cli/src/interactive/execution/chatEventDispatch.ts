/**
 * Unified ChatEvent dispatch — renderer, stream callbacks, and protocol notifications.
 */

import type { ChatEvent, ChatResult } from '../../agent/chatEngine.js';
import { computeTerminalOutcome } from '../../agent/chatEngineObservability.js';
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
}

/** Dispatch one chat event to all configured sinks. Returns a terminal ChatResult on failure. */
export function dispatchChatEvent(
  event: ChatEvent,
  sinks: ChatEventDispatchSinks,
): ChatResult | null {
  sinks.protocolSession?.emitChatEvent(event);

  switch (event.type) {
    case 'thinking':
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
      sinks.toolIdQueue?.push(id);
      break;
    }
    case 'tool_complete': {
      const id = sinks.toolIdQueue?.shift();
      if (id !== undefined && id >= 0) {
        sinks.convRenderer?.onToolCallComplete(id, event.detail);
      }
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
    return {
      status: 'failed',
      outcome: event.outcome ?? 'AGENT_FAILURE',
      answer: event.error,
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
      ...(event.toolCalls ? { toolCalls: event.toolCalls } : {}),
      ...(event.runDir ? { runDir: event.runDir } : {}),
    };
  }

  if (event.type === 'cancelled') {
    return {
      status: 'cancelled',
      outcome: 'CANCELLED',
      answer: 'Cancelled',
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
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
  },
): ChatResult {
  // Prefer the engine's authoritative TerminalOutcome. Only recompute when
  // older fixtures omit it (tests / partial events).
  const budgetExceeded = opts?.budgetExceeded === true;
  const outcome: TerminalOutcome =
    opts?.outcome ??
    computeTerminalOutcome({
      finalStatus: blockedReport ? 'blocked' : budgetExceeded ? 'budget_exhausted' : 'completed',
      budgetExceeded,
      lastVerifierReceipt: verifierReceipt,
      blockedReport,
    });

  const status: ChatResult['status'] = blockedReport
    ? 'blocked'
    : budgetExceeded
      ? 'budget_exhausted'
      : 'completed';

  return {
    status,
    outcome,
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
  };
}