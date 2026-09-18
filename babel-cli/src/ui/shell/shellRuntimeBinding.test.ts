import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShellRuntimeBinding } from './shellRuntimeBinding.js';

describe('ShellRuntimeBinding', () => {
  it('keeps streamed revisions and tool lifecycle cells in one hosted view', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(1, 'inspect the project', 'thread-a');
    binding.onChatEvent({ type: 'answer_chunk', text: 'hel' });
    binding.onChatEvent({ type: 'answer_chunk', text: 'lo' });
    binding.onChatEvent({ type: 'tool_start', toolCallId: 'call-1', tool: 'read_file', target: 'README.md' });
    binding.onChatEvent({
      type: 'tool_complete',
      toolCallId: 'call-1',
      tool: 'read_file',
      target: 'README.md',
      detail: 'ok',
    });
    const rows = binding.getVisibleRows(80, 20).join('\n');

    assert.match(rows, /hello/);
    assert.match(rows, /README\.md/);
    assert.equal(binding.getSnapshot().threadId, 'thread-a');
  });

  it('settles a streamed turn without duplicating its user cell', () => {
    const binding = new ShellRuntimeBinding({ width: 80 });
    binding.beginTurn(7, 'first question', 'thread-b');
    binding.onChatEvent({ type: 'answer_chunk', text: 'answer' });
    binding.observeInteractiveTurn({
      schema_version: 1,
      turn_id: 7,
      ts: new Date().toISOString(),
      role: 'assistant',
      answer: 'answer',
    });

    const records = binding.store.getRecords();
    assert.equal(records.filter((record) => record.kind === 'user_message').length, 1);
    assert.equal(records.filter((record) => record.kind === 'assistant_message').length, 1);
    assert.equal(binding.getSnapshot().activity, 'idle');
  });

  it('rejects late records from an older session epoch', () => {
    const binding = new ShellRuntimeBinding();
    const oldEpoch = binding.store.epoch;
    binding.store.startSession('new-thread', []);
    const accepted = binding.store.observePersistedRecord(
      {
        schema_version: 1,
        cell_id: 'late',
        ts: new Date().toISOString(),
        kind: 'plain',
        lifecycle: 'committed',
        revision: 0,
        payload: { lines: ['late'] },
      },
      oldEpoch,
    );

    assert.equal(accepted, false);
    assert.equal(binding.store.getRecords().length, 0);
  });
});
