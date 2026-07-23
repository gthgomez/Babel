import assert from 'node:assert/strict';
import test from 'node:test';

import { HistoryTranscript } from './transcript.js';

test('HistoryTranscript: answer chunks flush to committed assistant on tool boundary', () => {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();

  assert.equal(transcript.getActiveRecord()?.kind, 'thinking');

  transcript.onAnswerChunk('Hello ');
  transcript.onAnswerChunk('world');

  assert.equal(transcript.getActiveRecord()?.kind, 'assistant_message');
  assert.equal(transcript.getCommittedRecords().length, 0);
  assert.equal(transcript.getAnswerText(), 'Hello world');

  transcript.beginToolCall(1, 'file_read', 'src/index.ts');
  const committed = transcript.getCommittedRecords();
  assert.equal(committed.length, 2);
  assert.equal(committed[0]?.kind, 'assistant_message');
  assert.equal(committed[1]?.kind, 'tool_call');
  assert.equal((committed[1]?.payload as { status: string }).status, 'running');
  assert.equal(transcript.getActiveRecord(), null);

  transcript.completeToolCall(1, '1.2 KB');
  const toolPayload = transcript.getCommittedRecords()[1]?.payload as {
    status: string;
    detail?: string;
  };
  assert.equal(toolPayload.status, 'completed');
  assert.equal(toolPayload.detail, '1.2 KB');
});

test('HistoryTranscript: parallel tool calls commit independently', () => {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();

  transcript.beginToolCall(1, 'file_read', 'a.ts');
  transcript.beginToolCall(2, 'file_read', 'b.ts');

  assert.equal(transcript.getCommittedRecords().length, 2);
  assert.equal(transcript.getActiveRecord(), null);

  transcript.completeToolCall(2, '2 KB');
  transcript.completeToolCall(1, '1 KB');

  const tools = transcript
    .getCommittedRecords()
    .filter((record) => record.kind === 'tool_call')
    .map((record) => record.payload as { target: string; detail?: string });
  assert.deepEqual(
    tools.map((tool) => tool.detail).sort(),
    ['1 KB', '2 KB'],
  );
});

test('HistoryTranscript: finishTurn commits trailing assistant', () => {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  transcript.onAnswerChunk('Done.');
  transcript.finishTurn();

  assert.equal(transcript.getActiveRecord(), null);
  assert.equal(transcript.getCommittedRecords().length, 1);
  assert.equal(transcript.getCommittedRecords()[0]?.kind, 'assistant_message');
});

test('HistoryTranscript: abortTurn cancels running tools', () => {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  transcript.beginToolCall(1, 'shell_exec', 'npm test');
  transcript.abortTurn();

  const tool = transcript.getCommittedRecords()[0]?.payload as { status: string };
  assert.equal(tool.status, 'cancelled');
  assert.equal(transcript.getActiveRecord(), null);
});

test('HistoryTranscript: active cache key changes on revision bump', () => {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  const key1 = transcript.getActiveCacheKey();
  transcript.onAnswerChunk('a');
  const key2 = transcript.getActiveCacheKey();
  assert.notEqual(key1, key2);
});