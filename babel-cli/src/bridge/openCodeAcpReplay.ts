import { createHash } from 'node:crypto';

import type { HistoryCellRecord, ToolCallStatus } from '../ui/historyCells/types.js';
import { normalizeAcpSessionUpdate } from './openCodeAcpEventMap.js';

export interface OpenCodeReplayAccumulator {
  cells: Map<string, HistoryCellRecord>;
  chunkSeq: number;
  openAssistantMessageKey?: string;
  openUserMessageKey?: string;
}

export function createOpenCodeReplayAccumulator(): OpenCodeReplayAccumulator {
  return { cells: new Map(), chunkSeq: 0 };
}

function extractText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  if (Array.isArray(content)) {
    return content.map((block) => extractText(block)).join('');
  }
  const block = content as { type?: string; text?: string };
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

function stableReplayCellId(nativeSessionId: string, suffix: string): string {
  const hash = createHash('sha256').update(`${nativeSessionId}:${suffix}`).digest('hex').slice(0, 32);
  return `oc-replay:${nativeSessionId}:${hash}`;
}

function mapToolStatus(raw: unknown): ToolCallStatus {
  const status = String(raw ?? 'running');
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed' || status === 'succeeded') return 'completed';
  return 'running';
}

/** Apply one vendor replay update into an idempotent accumulator (stable cell ids). */
export function applyAcpReplayUpdate(
  accumulator: OpenCodeReplayAccumulator,
  update: Record<string, unknown>,
  threadId: string,
  nativeSessionId: string,
): void {
  const body = normalizeAcpSessionUpdate(update);
  if (!body) return;
  const kind = body.sessionUpdateKind ?? body.type;
  const ts = String(Date.now());

  if (kind === 'user_message_chunk' || kind === 'user_message') {
    const messageId =
      typeof body.messageId === 'string'
        ? body.messageId
        : (accumulator.openUserMessageKey ?? `user-seq-${accumulator.chunkSeq++}`);
    if (typeof body.messageId !== 'string') {
      accumulator.openUserMessageKey = messageId;
    } else {
      delete accumulator.openUserMessageKey;
    }
    delete accumulator.openAssistantMessageKey;
    const text = extractText(body.content ?? body.text);
    if (!text) return;
    const cellId = stableReplayCellId(nativeSessionId, `user:${messageId}`);
    const existing = accumulator.cells.get(cellId);
    const merged = existing
      ? `${(existing.payload as { message: string }).message}${text}`
      : text;
    accumulator.cells.set(cellId, {
      schema_version: 1,
      cell_id: cellId,
      thread_id: threadId,
      kind: 'user_message',
      lifecycle: 'committed',
      revision: 1,
      ts,
      payload: { message: merged },
    });
    return;
  }

  if (kind === 'agent_message_chunk' || kind === 'agent_message') {
    const messageId =
      typeof body.messageId === 'string'
        ? body.messageId
        : (accumulator.openAssistantMessageKey ?? `assistant-seq-${accumulator.chunkSeq++}`);
    if (typeof body.messageId !== 'string') {
      accumulator.openAssistantMessageKey = messageId;
    } else {
      delete accumulator.openAssistantMessageKey;
    }
    delete accumulator.openUserMessageKey;
    const text = extractText(body.content ?? body.text);
    if (!text) return;
    const cellId = stableReplayCellId(nativeSessionId, `assistant:${messageId}`);
    const existing = accumulator.cells.get(cellId);
    const merged = existing
      ? `${(existing.payload as { message: string }).message}${text}`
      : text;
    accumulator.cells.set(cellId, {
      schema_version: 1,
      cell_id: cellId,
      thread_id: threadId,
      kind: 'assistant_message',
      lifecycle: 'committed',
      revision: 1,
      ts,
      payload: { message: merged },
    });
    return;
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    delete accumulator.openAssistantMessageKey;
    delete accumulator.openUserMessageKey;
    const toolCallId = String(body.toolCallId ?? body.title ?? `tool-${accumulator.chunkSeq++}`);
    const cellId = stableReplayCellId(nativeSessionId, `tool:${toolCallId}`);
    const existing = accumulator.cells.get(cellId);
    const prior = existing?.payload as { tool?: string; target?: string; status?: ToolCallStatus } | undefined;
    const title =
      typeof body.title === 'string' ? body.title : prior?.tool ?? toolCallId;
    const statusRaw = body.status;
    const status =
      statusRaw === undefined || statusRaw === null
        ? prior?.status ?? 'running'
        : mapToolStatus(statusRaw);
    accumulator.cells.set(cellId, {
      schema_version: 1,
      cell_id: cellId,
      thread_id: threadId,
      kind: 'tool_call',
      lifecycle: 'committed',
      revision: 1,
      ts,
      payload: {
        tool: title,
        target: toolCallId,
        status,
      },
    });
  }
}

export function finalizeReplayCells(accumulator: OpenCodeReplayAccumulator): HistoryCellRecord[] {
  return [...accumulator.cells.values()];
}
