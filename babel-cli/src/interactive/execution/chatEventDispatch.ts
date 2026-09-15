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

const INFRA_CODE_RE =
  /\b(?:ENOSPC|EROFS|EIO|EBUSY|EMFILE|ENFILE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH)\b/i;

/** Detect infrastructure/network/provider failure text without inventing agent blame. */
export function isInfrastructureErrorText(error: string): boolean {
  if (!error) return false;
  return (
    INFRA_CODE_RE.test(error) ||
    /runtime-invariant/i.test(error) ||
    /socket hang up|connection reset|fetch failed|undici|network (?:error|timeout)|broken pipe/i.test(error) ||
    /provider (?:startup|stream) idle|idle timeout|request deadline|request timeout|timeout exceeded/i.test(error) ||
    /stream closed before terminal|malformed sse|provider stream error|finish_reason: error/i.test(error) ||
    /\[(?:deepSeekApi|deepInfraApi|openRouterApi|provider)\]/i.test(error) ||
    /provider (?:error|disconnected)|overloaded|service unavailable|bad gateway|rate limit|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout/i.test(error)
  );
}

export function isBudgetErrorText(error: string): boolean {
  return /budget.*exceed(?:ed|s)|cost budget|wall (?:time|clock|budget)|token explosion/i.test(error);
}

export function isPolicyErrorText(error: string): boolean {
  return /blocked_policy|policy (?:block|intervention|denied)|permission denied by policy/i.test(error);
}

export function isEnvironmentErrorText(error: string): boolean {
  return /env(?:ironment)?[ _]blocked|toolchain cannot|missing (?:runtime|dependency)|permission denied(?! by policy)/i.test(error);
}

/**
 * Classify failure text into an established TerminalOutcome.
 * Returns undefined when the cause is not established (UNKNOWN/INCONCLUSIVE).
 * Never defaults to AGENT_FAILURE.
 */
export function classifyFailureText(error: string): TerminalOutcome | undefined {
  if (!error) return undefined;
  if (isBudgetErrorText(error)) return 'BUDGET_EXHAUSTED';
  if (isPolicyErrorText(error)) return 'BLOCKED_POLICY';
  if (isEnvironmentErrorText(error)) return 'BLOCKED_EXTERNAL';
  if (isInfrastructureErrorText(error)) return 'INFRA_FAILURE';
  return undefined;
}

export function statusForOutcome(outcome: TerminalOutcome): ChatResult['status'] {
  if (outcome === 'CANCELLED') return 'cancelled';
  if (outcome === 'BUDGET_EXHAUSTED') return 'budget_exhausted';
  if (
    outcome === 'BLOCKED_POLICY' ||
    outcome === 'BLOCKED_EXTERNAL' ||
    outcome === 'INVALID_TASK' ||
    outcome === 'NEEDS_HUMAN_DECISION'
  ) {
    return 'blocked';
  }
  if (outcome === 'VERIFIED_COMPLETE' || outcome === 'UNVERIFIED_PATCH' || outcome === 'NO_CHANGE_REQUIRED') {
    return 'completed';
  }
  return 'failed';
}

/** Resolve a failed-event outcome without treating engine AGENT_FAILURE as proof. */
export function resolveFailedEventOutcome(
  error: string,
  explicit?: TerminalOutcome,
): TerminalOutcome | undefined {
  const fromText = classifyFailureText(error);
  if (fromText) return fromText;
  if (explicit && explicit !== 'AGENT_FAILURE') return explicit;
  return undefined;
}

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
      sinks.toolIdQueue?.push(id);
      break;
    }
    case 'tool_complete': {
      const id = sinks.toolIdQueue?.shift();
      if (id !== undefined && id >= 0) {
        sinks.convRenderer?.onToolCallComplete(id, event.detail, event.error, event.exitCode);
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
    const outcome = resolveFailedEventOutcome(event.error, event.outcome);
    const ev = event as {
      turnRouting?: TurnRoutingReceipt[];
      verifierReceipt?: ChatResult['verifierReceipt'];
      blockedReport?: ChatResult['blockedReport'];
    };
    return {
      status: outcome ? statusForOutcome(outcome) : 'failed',
      ...(outcome !== undefined ? { outcome } : {}),
      answer: event.error,
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
      ...(event.toolCalls !== undefined ? { toolCalls: event.toolCalls } : {}),
      ...(event.runDir !== undefined ? { runDir: event.runDir } : {}),
      ...(event.turnTelemetry !== undefined ? { turnTelemetry: event.turnTelemetry } : {}),
      ...(ev.turnRouting !== undefined ? { turnRouting: ev.turnRouting } : {}),
      ...(ev.verifierReceipt !== undefined ? { verifierReceipt: ev.verifierReceipt } : {}),
      ...(ev.blockedReport !== undefined ? { blockedReport: ev.blockedReport } : {}),
    };
  }

  if (event.type === 'cancelled') {
    const ev = event as {
      toolCalls?: ChatResult['toolCalls'];
      runDir?: string;
      turnRouting?: TurnRoutingReceipt[];
      verifierReceipt?: ChatResult['verifierReceipt'];
    };
    return {
      status: 'cancelled',
      outcome: 'CANCELLED',
      answer: 'Cancelled',
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
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