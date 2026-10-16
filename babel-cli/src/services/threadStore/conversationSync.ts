/**
 * Rebuild ChatEngine conversation from committed HistoryCell records.
 * Prefer typed ThreadEventLog when available so tool results are not dropped.
 */

import type { ChatMessage } from '../../agent/chatToolDefinitions.js';
import { ChatEngine, type ChatEngineOptions } from '../../agent/chatEngine.js';
import type { ProviderMessage } from '../../runners/base.js';
import { providerMessagesToChatMessages } from '../../agent/providerMessagesToChatMessages.js';
export { providerMessagesToChatMessages } from '../../agent/providerMessagesToChatMessages.js';
import {
  rebuildProviderMessagesFromEvents,
  loadThreadEventLogFromDir,
  type ThreadEventLog,
} from '../../agent/threadEventLog.js';
import {chatSessionDir} from '../../cli/runsLayout.js';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {recoverCheckpointArtifacts,loadLiveSessionAuthorityStrict,INSTRUCTION_MANIFEST_FILENAME,TASK_CONTRACT_FILENAME,TASK_MODE_HISTORY_FILENAME} from '../../agent/liveSessionBridge.js';
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

/**
 * Rebuild provider context from typed events so no tool
 * result is dropped. Also mirrors into the legacy conversation store.
 */
export function applyEventLogToChatEngine(
  engine: ChatEngine,
  log: ThreadEventLog,
  options: { systemPrompt?: string } = {},
): ProviderMessage[] {
  engine.restoreEventLog(log);
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
  try{
    const log=loadThreadEventLogFromDir(chatSessionDir(engine.getEngineRunId()));
    if(log)engine.restoreEventLog(log);
    applyCellsToChatEngine(engine, records);
  }finally{engine.resyncTurnStateAfterBranch();}
}

/** Inspect existing authority before any constructor can replace its artifacts. */
function constructResumedEngine(threadId:string,options:ChatEngineOptions):ChatEngine{
  const runDir=chatSessionDir(threadId);recoverCheckpointArtifacts(runDir);
  if([INSTRUCTION_MANIFEST_FILENAME,TASK_CONTRACT_FILENAME,TASK_MODE_HISTORY_FILENAME].some(name=>existsSync(join(runDir,name)))){
    const retained=loadLiveSessionAuthorityStrict(runDir);
    const engine=new ChatEngine({...options,runtimeMode:options.runtimeMode??'direct',runId:threadId,resumeExisting:true,executionProfile:options.executionProfile??retained.taskContract.mode});
    // Accepted intent comes from canonical history, independently of whether
    // the accounting checkpoint is available. A bare continuation must not
    // acquire a fresh objective/allowance because its budget could not restore.
    const log=loadThreadEventLogFromDir(runDir);
    if(log)engine.restoreEventLog(log);
    return engine;
  }
  const engine=new ChatEngine({...options,runtimeMode:options.runtimeMode??'direct',retainedHistory:true});
  engine.assignRunId(threadId);return engine;
}

/** Create a ChatEngine from thread-store cells (no transcript.jsonl required). */
export function createEngineFromThreadCells(
  threadId: string,
  options: ChatEngineOptions,
  records: HistoryCellRecord[],
): ChatEngine {
  const engine = constructResumedEngine(threadId,options);
  applyCellsToChatEngine(engine, records);
  return engine;
}

/**
 * Create/resync engine from a durable ThreadEventLog so tool results
 * are not dropped on resume.
 */
export function createEngineFromEventLog(
  options: ChatEngineOptions,
  log: ThreadEventLog,
  systemPrompt?: string,
): ChatEngine {
  const engine = constructResumedEngine(log.thread_id,options);
  applyEventLogToChatEngine(engine, log, {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  });
  engine.restoreEventLog(log);
  // R1: load durable observation membership before session-event restore, which
  // re-persists the snapshot from `parity.authorizedObservationIds`.
  engine.loadObservationMembership();
  // W2.2: settle interrupted tools from session-events.jsonl if present.
  engine.restoreSessionEventsFromDir();
  // R1: the primary resume path must run the same context-authority hydration
  // as `ChatEngine.restore`, not silently skip checkpoint validation.
  engine.hydrateInstalledContextAuthority();
  return engine;
}
