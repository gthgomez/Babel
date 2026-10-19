import type { ChatEvent } from '../agent/chatEngineContracts.js';

const zeroUsage = {
  totalCostUSD: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  modelBreakdown: {},
};

export function mapCommandCodeAcpUpdate(
  update: Record<string, unknown>,
  state: {
    textBuffer: string[];
    cancelRequested: boolean;
    usage?: (typeof zeroUsage);
  },
): ChatEvent[] {
  const type = update.type;
  if (type === 'message_chunk') {
    const text = typeof update.text === 'string' ? update.text : '';
    if (text) {
      state.textBuffer.push(text);
      return [{ type: 'answer_chunk', text }];
    }
    return [];
  }
  if (type === 'tool_call') {
    const tool = typeof update.tool === 'string' ? update.tool : 'tool';
    const target = typeof update.target === 'string' ? update.target : '';
    const status = update.status;
    if (status === 'completed') {
      return [{ type: 'tool_complete', tool, target }];
    }
    return [{ type: 'tool_start', tool, target }];
  }
  if (type === 'state_update') {
    const stopReason = update.stopReason;
    if (update.state === 'idle') {
      if (stopReason === 'cancelled' || state.cancelRequested) {
        return [{ type: 'cancelled' }];
      }
      if (stopReason === 'error') {
        return [{ type: 'failed', error: String(update.message ?? 'Command Code turn failed') }];
      }
      const answer = state.textBuffer.join('');
      return [
        {
          type: 'done',
          answer,
          status: 'completed',
          usage: state.usage ?? zeroUsage,
        },
      ];
    }
  }
  if (type === 'usage_update' && update.usage && typeof update.usage === 'object') {
    const raw = update.usage as Record<string, unknown>;
    const totalCostUSD = typeof raw.totalCostUSD === 'number' ? raw.totalCostUSD : undefined;
    if (totalCostUSD !== undefined) {
      state.usage = {
        totalCostUSD,
        totalInputTokens: Number(raw.totalInputTokens ?? 0),
        totalOutputTokens: Number(raw.totalOutputTokens ?? 0),
        totalTokens: Number(raw.totalTokens ?? 0),
        modelBreakdown: {},
      };
    }
  }
  return [];
}
