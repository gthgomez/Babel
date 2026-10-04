import type { ChatStreamEvent } from '../interactive/execution/chatEventDispatch.js';
import { makeRunStreamEvent, writeNdjson, type RunStreamEvent } from './structuredOutput.js';

const DETAIL_LIMIT = 4000;

function clip(value: string | undefined): string {
  return (value ?? '').slice(0, DETAIL_LIMIT);
}

/** Project one chat-engine event onto the stream-json line Desktop renders. */
export function chatStreamToRunEvent(event: ChatStreamEvent): RunStreamEvent {
  switch (event.type) {
    case 'assistant_chunk':
      return makeRunStreamEvent('assistant_chunk', { chunk: event.chunk });
    case 'thought':
      return makeRunStreamEvent('thought', { line: clip(event.text) });
    case 'tool_start':
      return makeRunStreamEvent('tool.started', {
        item: { id: event.toolCallId ?? '', tool: event.tool, target: event.target },
      });
    case 'tool_complete':
    case 'tool_failed':
      return makeRunStreamEvent(event.type === 'tool_complete' ? 'tool.completed' : 'tool.failed', {
        item: {
          id: event.toolCallId ?? '',
          tool: event.tool,
          target: event.target,
          detail: clip(event.detail ?? event.error),
          ...(event.exitCode !== undefined ? { exit_code: event.exitCode } : {}),
        },
      });
    case 'file_changed':
      return makeRunStreamEvent('file.changed', {
        item: { path: event.path, additions: event.additions, deletions: event.deletions },
      });
    case 'cancelled':
      return makeRunStreamEvent('cancelled', { status: 'CANCELLED' });
  }
}

export function writeChatStreamLine(event: ChatStreamEvent): void {
  writeNdjson(chatStreamToRunEvent(event));
}
