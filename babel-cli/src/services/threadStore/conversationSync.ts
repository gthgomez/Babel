/**
 * Rebuild ChatEngine conversation from committed HistoryCell records.
 * P1-C: Prefer typed ThreadEventLog when available so tool results are not dropped.
 */

import type { ChatMessage } from '../../agent/chatToolDefinitions.js';
import { ChatEngine, type ChatEngineOptions } from '../../agent/chatEngine.js';
import type { ProviderMessage } from '../../runners/base.js';
import {
  rebuildProviderMessagesFromEvents,
  type ThreadEventLog,
} from '../../agent/threadEventLog.js';
// re-export for callers
export type { ThreadEventLog };
import type {
  AssistantMessagePayload,
  HistoryCellRecord,
  UserMessagePayload,
} from '../../ui/historyCells/types.js';

export function cellsToChatMessages(records: HistoryCellRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const record of records) {
    if (record.kind === 'user_message') {
      const text = (record.payload as UserMessagePayload).message;
      if (text.trim()) messages.push({ role: 'user', content: text });
    } else if (record.kind === 'assistant_message') {
      const text = (record.payload as AssistantMessagePayload).message;
      if (text.trim()) messages.push({ role: 'assistant', content: text });
    }
  }
  return messages;
}

/** Convert ProviderMessage[] into legacy ChatMessage[] for replaceConversation. */
export function providerMessagesToChatMessages(
  messages: ProviderMessage[],
): ChatMessage[] {
  return messages.map((m) => {
    const base: ChatMessage = {
      role: m.role,
      content: m.content,
    };
    if (m.name) base.name = m.name;
    return base;
  });
}

/**
 * P1-C exact resume: rebuild provider context from typed events so no tool
 * result is dropped. Also mirrors into the legacy conversation store.
 */
export function applyEventLogToChatEngine(
  engine: ChatEngine,
  log: ThreadEventLog,
  options: { systemPrompt?: string } = {},
): ProviderMessage[] {
  const providerMessages = rebuildProviderMessagesFromEvents(log, {
    ...(options.systemPrompt !== undefined
      ? { systemPrompt: options.systemPrompt }
      : {}),
  });
  engine.replaceConversation(providerMessagesToChatMessages(providerMessages));
  if (typeof engine.replaceProviderConversation === 'function') {
    engine.replaceProviderConversation(providerMessages);
  }
  return providerMessages;
}

/** Replace engine conversation with system row preserved + cell-derived messages. */
export function applyCellsToChatEngine(engine: ChatEngine, records: HistoryCellRecord[]): void {
  const existing = engine.getConversation();
  const system = existing.find((m) => m.role === 'system');
  const derived = cellsToChatMessages(records);
  const conversation: ChatMessage[] = system ? [system, ...derived] : derived;
  engine.replaceConversation(conversation);
}

/** Replace conversation and reset live turn state after rewind on an existing engine. */
export function resyncEngineToThreadCells(
  engine: ChatEngine,
  records: HistoryCellRecord[],
): void {
  applyCellsToChatEngine(engine, records);
  engine.resyncTurnStateAfterBranch();
}

/** Create a ChatEngine from thread-store cells (no transcript.jsonl required). */
export function createEngineFromThreadCells(
  threadId: string,
  options: ChatEngineOptions,
  records: HistoryCellRecord[],
): ChatEngine {
  const engine = new ChatEngine(options);
  engine.assignRunId(threadId);
  applyCellsToChatEngine(engine, records);
  return engine;
}

/**
 * P1-C: Create/resync engine from a durable ThreadEventLog so tool results
 * are not dropped on resume.
 */
export function createEngineFromEventLog(
  options: ChatEngineOptions,
  log: ThreadEventLog,
  systemPrompt?: string,
): ChatEngine {
  const engine = new ChatEngine(options);
  engine.assignRunId(log.thread_id);
  applyEventLogToChatEngine(engine, log, {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  });
  engine.restoreEventLog(log);
  return engine;
}