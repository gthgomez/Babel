import assert from 'node:assert/strict';
import test from 'node:test';

import { HISTORY_CELL_SCHEMA_VERSION } from '../../ui/historyCells/types.js';
import type { HistoryCellRecord } from '../../ui/historyCells/types.js';
import {
  applyCellsToChatEngine,
  cellsToChatMessages,
  createEngineFromThreadCells,
  resyncEngineToThreadCells,
} from './conversationSync.js';

function makeRecord(
  cellId: string,
  kind: HistoryCellRecord['kind'],
  threadId: string,
): HistoryCellRecord {
  return {
    schema_version: HISTORY_CELL_SCHEMA_VERSION,
    cell_id: cellId,
    thread_id: threadId,
    turn_id: 1,
    ts: new Date().toISOString(),
    kind,
    lifecycle: 'committed',
    revision: 0,
    payload:
      kind === 'user_message'
        ? { message: `user-${cellId}` }
        : { message: `assistant-${cellId}` },
  };
}

test('cellsToChatMessages maps user and assistant rows', () => {
  const threadId = 'chat-sync-test';
  const messages = cellsToChatMessages([
    makeRecord('u1', 'user_message', threadId),
    makeRecord('a1', 'assistant_message', threadId),
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'user-u1' },
    { role: 'assistant', content: 'assistant-a1' },
  ]);
});

test('createEngineFromThreadCells restores conversation without transcript.jsonl', () => {
  const threadId = 'chat-engine-from-cells';
  const records = [
    makeRecord('u1', 'user_message', threadId),
    makeRecord('a1', 'assistant_message', threadId),
  ];
  const engine = createEngineFromThreadCells(
    threadId,
    { task: 'rewind test', projectRoot: process.cwd() },
    records,
  );

  assert.equal(engine.getEngineRunId(), threadId);
  const conversation = engine.getConversation();
  assert.equal(conversation.length, 2);
  assert.equal(conversation[0]?.role, 'user');
  assert.equal(conversation[1]?.role, 'assistant');
});

test('resyncEngineToThreadCells resets live turn state after rewind', () => {
  const threadId = 'chat-resync-turn';
  const engine = createEngineFromThreadCells(
    threadId,
    { task: 'rewind live engine', projectRoot: process.cwd() },
    [makeRecord('a1', 'assistant_message', threadId)],
  );
  type EngineInternals = { apiTokenCount: number; compactionConsecutiveFailures: number };
  const internal = engine as unknown as EngineInternals;
  internal.apiTokenCount = 42;
  internal.compactionConsecutiveFailures = 3;

  resyncEngineToThreadCells(engine, [makeRecord('u1', 'user_message', threadId)]);
  assert.equal(internal.apiTokenCount, 0);
  assert.equal(internal.compactionConsecutiveFailures, 0);
  assert.equal(engine.getConversation().length, 1);
  assert.equal(engine.getConversation()[0]?.role, 'user');
});

test('applyCellsToChatEngine preserves an existing system row', () => {
  const threadId = 'chat-apply-cells';
  const engine = createEngineFromThreadCells(
    threadId,
    { task: 'fork test', projectRoot: process.cwd() },
    [makeRecord('a-old', 'assistant_message', threadId)],
  );
  engine.replaceConversation([
    { role: 'system', content: 'system rules' },
    { role: 'user', content: 'stale user' },
  ]);
  applyCellsToChatEngine(engine, [makeRecord('u1', 'user_message', threadId)]);
  const conversation = engine.getConversation();
  assert.equal(conversation[0]?.role, 'system');
  assert.equal(conversation[1]?.role, 'user');
  assert.equal(conversation[1]?.content, 'user-u1');
});