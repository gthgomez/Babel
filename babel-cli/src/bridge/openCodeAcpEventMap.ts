import type { ChatEvent } from '../agent/chatEngineContracts.js';
import type { SessionUsageSummary } from '../services/costTracker.js';
import type { AcpProtocolVersion } from './openCodeAcpNegotiation.js';

export interface AcpTurnMapState {
  textBuffer: string[];
  terminalEmitted: boolean;
  /** True while the active turn's session/prompt is in flight. */
  promptAdmitted: boolean;
  usage?: SessionUsageSummary;
  /** Session cumulative USD at turn start (for delta usage_update mapping). */
  sessionCostBaselineUSD?: number;
  lastCumulativeCostUSD?: number;
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
    if (status === 'failed' || status === 'error') {
      return [
        {
          type: 'tool_failed',
          tool,
          target,
          error: typeof body.message === 'string' ? body.message : `OpenCode tool ${status}`,
        },
      ];
    }
    if (status === 'cancelled') {
      return [{ type: 'tool_failed', tool, target, error: 'OpenCode tool cancelled' }];
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
      return [{ type: 'failed', error: err?.message ?? 'OpenCode turn failed' }];
    }
    if (stopReason === 'end_turn' || stopReason === 'completed') {
      if (!state.promptAdmitted) return [];
      return mapPromptTerminalFromStopReason(state, protocolVersion, String(stopReason));
    }
    if (stopReason === 'refusal' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      if (!state.promptAdmitted) return [];
      state.terminalEmitted = true;
      return [{ type: 'failed', error: `OpenCode stopped: ${String(stopReason)}`, status: 'failed' }];
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
      const usdKnown = currency === 'USD';
      if (usdKnown) {
        state.lastCumulativeCostUSD = amount;
      }
      const baselineKnown = state.sessionCostBaselineUSD !== undefined;
      const baseline = state.sessionCostBaselineUSD ?? 0;
      let delta = 0;
      let costComplete = false;
      if (usdKnown && baselineKnown) {
        if (amount < baseline) {
          costComplete = false;
        } else {
          delta = amount - baseline;
          costComplete = true;
        }
      }
      state.usage = {
        totalCostUSD: usdKnown ? delta : 0,
        costComplete,
        unknownChargeCount: costComplete ? 0 : 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        modelBreakdown: {
          'opencode-acp': {
            inputTokens: 0,
            outputTokens: 0,
            costUSD: usdKnown ? delta : 0,
            unknownChargeCount: costComplete ? 0 : 1,
          },
        },
      };
    }
    return [];
  }
  return [];
}

/** Merge session/prompt response token usage (independent of cumulative usage_update cost). */
export function applyPromptResponseUsage(state: AcpTurnMapState, promptResult: Record<string, unknown>): void {
  const raw = promptResult.usage;
  if (!raw || typeof raw !== 'object') return;
  const usage = raw as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  };
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const totalTokens =
    typeof usage.totalTokens === 'number' ? usage.totalTokens : inputTokens + outputTokens;
  const priorCost = state.usage;
  state.usage = {
    totalCostUSD: priorCost?.totalCostUSD ?? 0,
    costComplete: priorCost?.costComplete ?? false,
    unknownChargeCount: priorCost?.unknownChargeCount ?? (priorCost?.costComplete ? 0 : 1),
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalTokens,
    modelBreakdown: {
      'opencode-acp': {
        inputTokens,
        outputTokens,
        costUSD: priorCost?.modelBreakdown?.['opencode-acp']?.costUSD ?? priorCost?.totalCostUSD ?? 0,
        unknownChargeCount:
          priorCost?.modelBreakdown?.['opencode-acp']?.unknownChargeCount ??
          priorCost?.unknownChargeCount ??
          1,
      },
    },
  };
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
    return [{ type: 'failed', error: 'OpenCode prompt failed' }];
  }
  if (reason !== 'end_turn' && reason !== 'completed') {
    state.terminalEmitted = true;
    return [{ type: 'failed', error: `OpenCode prompt stop: ${reason}`, status: 'failed' }];
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

export function mapOpenCodeAcpUpdate(
  update: Record<string, unknown>,
  state: AcpTurnMapState,
  protocolVersion: AcpProtocolVersion,
): ChatEvent[] {
  const body = normalizeAcpSessionUpdate(update);
  if (!body) return [];
  return mapSessionUpdateBody(body, state, protocolVersion);
}
