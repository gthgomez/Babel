import { randomUUID } from 'node:crypto';

import type { HistoryCellRecord } from '../ui/historyCells/types.js';
import { normalizeAcpSessionUpdate } from './commandCodeAcpEventMap.js';

function extractText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  if (Array.isArray(content)) {
    return content.map((block) => extractText(block)).join('');
  }
  const block = content as { type?: string; text?: string };
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

/** Map ACP replay updates into durable history cells (not live turn stream). */
export function mapAcpReplayToHistoryCell(
  update: Record<string, unknown>,
  threadId: string,
): HistoryCellRecord | null {
  const body = normalizeAcpSessionUpdate(update);
  if (!body) return null;
  const kind = body.sessionUpdateKind ?? body.type;
  const ts = String(Date.now());
  const cell_id = randomUUID();
  if (kind === 'user_message_chunk' || kind === 'user_message') {
    const text = extractText(body.content ?? body.text);
    if (!text) return null;
    return {
      schema_version: 1,
      cell_id,
      thread_id: threadId,
      kind: 'user_message',
      lifecycle: 'committed',
      revision: 1,
      ts,
      payload: { message: text },
    };
  }
  if (kind === 'agent_message_chunk' || kind === 'agent_message') {
    const text = extractText(body.content ?? body.text);
    if (!text) return null;
    return {
      schema_version: 1,
      cell_id,
      thread_id: threadId,
      kind: 'assistant_message',
      lifecycle: 'committed',
      revision: 1,
      ts,
      payload: { message: text },
    };
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const title = String(body.title ?? body.toolCallId ?? 'tool');
    const status = String(body.status ?? 'completed');
    return {
      schema_version: 1,
      cell_id,
      thread_id: threadId,
      kind: 'tool_call',
      lifecycle: 'committed',
      revision: 1,
      ts,
      payload: {
        tool: title,
        target: String(body.toolCallId ?? ''),
        status: status === 'failed' ? 'failed' : 'completed',
      },
    };
  }
  return null;
}
