import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionUsageSummary } from '../services/costTracker.js';
import type { AcpProtocolVersion } from './commandCodeAcpNegotiation.js';

export interface AcpTurnMapState {
  textBuffer: string[];
  /** Authoritative terminal already emitted for this turn. */
  terminalEmitted: boolean;
  usage?: SessionUsageSummary;
}

function extractTextFromContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const block = content as { type?: string; text?: string };
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

function mapSessionUpdateBody(
  body: Record<string, unknown>,
  state: AcpTurnMapState,
): ChatEvent[] {
  const kind = body.type;
  if (kind === 'agent_message_chunk') {
    const text = extractTextFromContent(body.content);
    if (!text) return [];
    state.textBuffer.push(text);
    return [{ type: 'answer_chunk', text }];
  }
  if (kind === 'agent_message') {
    const text = extractTextFromContent(body.content);
    if (text) state.textBuffer.push(text);
    return text ? [{ type: 'answer_chunk', text }] : [];
  }
  if (kind === 'tool_call_update') {
    const toolCall = body.toolCall as { title?: string; kind?: string; status?: string } | undefined;
    const tool = toolCall?.title ?? toolCall?.kind ?? 'tool';
    const status = toolCall?.status ?? body.status;
    if (status === 'completed' || status === 'succeeded') {
      return [{ type: 'tool_complete', tool, target: '' }];
    }
    return [{ type: 'tool_start', tool, target: '' }];
  }
  if (kind === 'tool_call') {
    const toolCall = body.toolCall as { title?: string } | undefined;
    const tool = toolCall?.title ?? 'tool';
    return [{ type: 'tool_start', tool, target: '' }];
  }
  if (kind === 'state_update') {
    if (body.state !== 'idle') return [];
    const stopReason = body.stopReason;
    if (stopReason === 'cancelled') {
      state.terminalEmitted = true;
      return [{ type: 'cancelled' }];
    }
    if (stopReason === 'error') {
      const err = body.error as { message?: string } | undefined;
      state.terminalEmitted = true;
      return [{ type: 'failed', error: err?.message ?? 'Command Code turn failed' }];
    }
    if (stopReason === 'end_turn' || stopReason === 'completed') {
      state.terminalEmitted = true;
      const answer = state.textBuffer.join('');
      const usage: SessionUsageSummary =
        state.usage ?? {
          totalCostUSD: 0,
          costComplete: false,
          unknownChargeCount: 1,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          modelBreakdown: {},
        };
      const event: ChatEvent = {
        type: 'done',
        answer,
        status: 'completed',
        usage,
      };
      return [event];
    }
    if (stopReason === 'refusal' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      state.terminalEmitted = true;
      return [
        {
          type: 'failed',
          error: `Command Code stopped: ${String(stopReason)}`,
          status: 'failed',
        },
      ];
    }
    return [];
  }
  if (kind === 'usage_update') {
    const usage = body.usage as { cost?: { amount?: number }; used?: number; size?: number } | undefined;
    const amount = usage?.cost?.amount;
    if (typeof amount === 'number') {
      state.usage = {
        totalCostUSD: amount,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: typeof usage?.used === 'number' ? usage.used : 0,
        modelBreakdown: {},
      };
    }
    return [];
  }
  return [];
}

/**
 * Map official ACP session/update payloads to ChatEngine events.
 */
export function mapCommandCodeAcpUpdate(
  update: Record<string, unknown>,
  state: AcpTurnMapState,
  protocolVersion: AcpProtocolVersion,
): ChatEvent[] {
  void protocolVersion;
  if (update.sessionUpdate && typeof update.sessionUpdate === 'object') {
    return mapSessionUpdateBody(update.sessionUpdate as Record<string, unknown>, state);
  }
  if (update.type === 'sessionUpdate' && update.update && typeof update.update === 'object') {
    return mapSessionUpdateBody(update.update as Record<string, unknown>, state);
  }
  return mapSessionUpdateBody(update, state);
}
