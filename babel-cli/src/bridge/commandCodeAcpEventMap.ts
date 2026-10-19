import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionUsageSummary } from '../services/costTracker.js';
import type { AcpProtocolVersion } from './commandCodeAcpNegotiation.js';

export interface AcpTurnMapState {
  textBuffer: string[];
  terminalEmitted: boolean;
  /** True while the active turn's session/prompt is in flight. */
  promptAdmitted: boolean;
  usage?: SessionUsageSummary;
}

/** Normalize official ACP session/update params to an internal update body. */
export function normalizeAcpSessionUpdate(update: Record<string, unknown>): Record<string, unknown> | null {
  const discriminator = update.sessionUpdate;
  if (typeof discriminator === 'string') {
    const { sessionUpdate: _drop, ...rest } = update;
    return { sessionUpdateKind: discriminator, ...rest };
  }
  if (discriminator && typeof discriminator === 'object') {
    const body = discriminator as Record<string, unknown>;
    if (typeof body.type === 'string') {
      return { sessionUpdateKind: body.type, ...body };
    }
  }
  if (update.type === 'sessionUpdate' && update.update && typeof update.update === 'object') {
    const body = update.update as Record<string, unknown>;
    if (typeof body.type === 'string') {
      return { sessionUpdateKind: body.type, ...body };
    }
  }
  if (typeof update.type === 'string') {
    return { sessionUpdateKind: update.type, ...update };
  }
  return null;
}

function extractTextFromContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  if (Array.isArray(content)) {
    let out = '';
    for (const block of content) {
      out += extractTextFromContent(block);
    }
    return out;
  }
  const block = content as { type?: string; text?: string };
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

function mapSessionUpdateBody(
  body: Record<string, unknown>,
  state: AcpTurnMapState,
  protocolVersion: AcpProtocolVersion,
): ChatEvent[] {
  const kind = body.sessionUpdateKind ?? body.type;
  if (kind === 'agent_message_chunk' || kind === 'message_chunk') {
    const text = extractTextFromContent(body.content ?? body.text);
    if (!text) return [];
    state.textBuffer.push(text);
    return [{ type: 'answer_chunk', text }];
  }
  if (kind === 'agent_message') {
    const text = extractTextFromContent(body.content);
    if (text) state.textBuffer.push(text);
    return text ? [{ type: 'answer_chunk', text }] : [];
  }
  if (kind === 'tool_call_update' || kind === 'tool_call') {
    const toolCall = body.toolCall as
      | { title?: string; toolCallId?: string; status?: string; kind?: string }
      | undefined;
    const tool =
      (typeof body.title === 'string' ? body.title : undefined) ??
      toolCall?.title ??
      (typeof body.toolCallId === 'string' ? body.toolCallId : undefined) ??
      toolCall?.toolCallId ??
      'tool';
    const target =
      (typeof body.toolCallId === 'string' ? body.toolCallId : undefined) ??
      toolCall?.toolCallId ??
      '';
    const status = body.status ?? toolCall?.status;
    if (status === 'completed' || status === 'succeeded') {
      return [{ type: 'tool_complete', tool, target }];
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      return [{ type: 'tool_complete', tool, target }];
    }
    return [{ type: 'tool_start', tool, target }];
  }
  if (kind === 'state_update') {
    if (protocolVersion === 1) {
      return [];
    }
    if (body.state !== 'idle') return [];
    const stopReason = body.stopReason;
    if (stopReason === 'cancelled') {
      if (!state.promptAdmitted) return [];
      state.terminalEmitted = true;
      return [{ type: 'cancelled' }];
    }
    if (stopReason === 'error') {
      if (!state.promptAdmitted) return [];
      const err = body.error as { message?: string } | undefined;
      state.terminalEmitted = true;
      return [{ type: 'failed', error: err?.message ?? 'Command Code turn failed' }];
    }
    if (stopReason === 'end_turn' || stopReason === 'completed') {
      if (!state.promptAdmitted) return [];
      return mapPromptTerminalFromStopReason(state, protocolVersion, String(stopReason));
    }
    if (stopReason === 'refusal' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      if (!state.promptAdmitted) return [];
      state.terminalEmitted = true;
      return [{ type: 'failed', error: `Command Code stopped: ${String(stopReason)}`, status: 'failed' }];
    }
    return [];
  }
  if (kind === 'usage_update') {
    const nested = body.usage as
      | { cost?: { amount?: number; currency?: string }; used?: number; size?: number }
      | undefined;
    const topCost = body.cost as { amount?: number; currency?: string } | undefined;
    const amount =
      typeof topCost?.amount === 'number'
        ? topCost.amount
        : typeof nested?.cost?.amount === 'number'
          ? nested.cost.amount
          : undefined;
    const used =
      typeof body.used === 'number'
        ? body.used
        : typeof nested?.used === 'number'
          ? nested.used
          : undefined;
    if (typeof amount === 'number') {
      const currency =
        typeof topCost?.currency === 'string'
          ? topCost.currency
          : typeof nested?.cost?.currency === 'string'
            ? nested.cost.currency
            : undefined;
      const usdKnown = !currency || currency === 'USD';
      state.usage = {
        totalCostUSD: usdKnown ? amount : 0,
        costComplete: usdKnown,
        unknownChargeCount: usdKnown ? 0 : 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        modelBreakdown: {
          'command-code-acp': {
            inputTokens: 0,
            outputTokens: 0,
            costUSD: usdKnown ? amount : 0,
            unknownChargeCount: usdKnown ? 0 : 1,
          },
        },
      };
    }
    return [];
  }
  return [];
}

export function mapPromptTerminalFromStopReason(
  state: AcpTurnMapState,
  _protocolVersion: AcpProtocolVersion,
  stopReason: string,
): ChatEvent[] {
  if (state.terminalEmitted) return [];
  const reason = stopReason;
  if (reason === 'cancelled') {
    state.terminalEmitted = true;
    return [{ type: 'cancelled' }];
  }
  if (reason === 'error') {
    state.terminalEmitted = true;
    return [{ type: 'failed', error: 'Command Code prompt failed' }];
  }
  if (reason !== 'end_turn' && reason !== 'completed') {
    state.terminalEmitted = true;
    return [{ type: 'failed', error: `Command Code prompt stop: ${reason}`, status: 'failed' }];
  }
  const answer = state.textBuffer.join('');
  state.terminalEmitted = true;
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
  return [{ type: 'done', answer, status: 'completed', usage }];
}

export function mapCommandCodeAcpUpdate(
  update: Record<string, unknown>,
  state: AcpTurnMapState,
  protocolVersion: AcpProtocolVersion,
): ChatEvent[] {
  const body = normalizeAcpSessionUpdate(update);
  if (!body) return [];
  return mapSessionUpdateBody(body, state, protocolVersion);
}
