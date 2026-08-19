/**
 * ChatEvent → TurnStreamEvent mapping for ADR-010 notifications.
 * Kept in protocol/ so the host can map without importing the TUI transport.
 */

import type { ChatEvent } from '../agent/chatEngine.js';
import type { TurnStreamEvent } from './types.js';

export function mapChatEventToTurnStreamEvent(event: ChatEvent): TurnStreamEvent | null {
  switch (event.type) {
    case 'thinking':
      return { type: 'thinking' };
    case 'answer_chunk':
      return { type: 'answer_chunk', text: event.text };
    case 'thought':
      return { type: 'thought', text: event.text };
    case 'context_compacted':
      return { type: 'thought', text: event.message };
    case 'tool_start':
      return { type: 'tool_start', tool: event.tool, target: event.target };
    case 'tool_complete':
      return {
        type: 'tool_complete',
        tool: event.tool,
        target: event.target,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      };
    case 'sub_agent_start':
      return {
        type: 'sub_agent_start',
        id: event.id,
        label: event.label,
        ...(event.model !== undefined ? { model: event.model } : {}),
      };
    case 'sub_agent_complete':
      return {
        type: 'sub_agent_complete',
        id: event.id,
        summary: event.summary,
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
      };
    case 'sub_agent_failed':
      return { type: 'sub_agent_failed', id: event.id, error: event.error };
    case 'file_changed':
      return {
        type: 'file_changed',
        path: event.path,
        additions: event.additions,
        deletions: event.deletions,
        ...(event.content !== undefined ? { content: event.content } : {}),
      };
    case 'done':
      return { type: 'done', answer: event.answer, usage: event.usage };
    case 'failed':
      return { type: 'failed', error: event.error };
    case 'cancelled':
      return { type: 'cancelled' };
    default:
      return null;
  }
}
