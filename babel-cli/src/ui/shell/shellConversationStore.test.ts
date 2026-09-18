import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShellConversationStore } from './shellConversationStore.js';
import { ShellRuntimeBinding } from './shellRuntimeBinding.js';

describe('ShellConversationStore settlement', () => {
  it('clears activeTurnId when settling while retaining final records', () => {
    const store = new ShellConversationStore({ threadId: 'thread-a' });
    store.beginTurn(4);
    store.observePersistedRecord({
      schema_version: 1,
      cell_id: 'assistant-4',
      ts: new Date().toISOString(),
      kind: 'plain',
      lifecycle: 'committed',
      revision: 0,
      payload: { lines: ['complete'] },
    });

    assert.equal(store.settleTurn(store.getCurrentTurnRecords()), true);
    assert.equal(store.turnId, undefined);
    assert.equal(store.getRecords().some((record) => record.cell_id === 'assistant-4'), true);
  });

  it('ignores stale settlement without clearing the current epoch turn', () => {
    const store = new ShellConversationStore({ threadId: 'thread-a' });
    store.beginTurn(4);
    const oldEpoch = store.epoch;
    store.startSession('thread-b', []);
    store.beginTurn(5);

    assert.equal(store.settleTurn([], oldEpoch), false);
    assert.equal(store.turnId, 5);
  });
});

describe('ShellRuntimeBinding lifecycle', () => {
  it('settles complete, failed, and cancelled outcomes without losing the outcome', () => {
    for (const [outcome, event] of [
      ['completed', { type: 'done', answer: 'done', status: 'completed' }],
      ['failed', { type: 'failed', status: 'failed', error: 'failed' }],
      ['cancelled', { type: 'cancelled', outcome: 'cancelled' }],
    ] as const) {
      const binding = new ShellRuntimeBinding();
      binding.beginTurn(1, `task-${outcome}`);
      binding.onChatEvent(event as never);
      binding.settleTurn();

      const snapshot = binding.getSnapshot();
      assert.equal(snapshot.turnId, undefined);
      assert.equal(snapshot.lastOutcome, outcome);
    }
  });

  it('rejects stale prior-epoch events without changing the current shell view', () => {
    const binding = new ShellRuntimeBinding();
    binding.beginTurn(1, 'old task');
    binding.onChatEvent({ type: 'answer_chunk', text: 'old answer' });
    binding.store.startSession('new-thread', []);

    binding.onChatEvent({ type: 'answer_chunk', text: 'stale answer' });

    assert.equal(binding.store.getRecords().length, 0);
    assert.equal(binding.getSnapshot().turnId, undefined);
  });

  it('keeps one canonical user cell when a settled assistant turn is observed', () => {
    const binding = new ShellRuntimeBinding();
    binding.beginTurn(7, 'one question');
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
    assert.equal(binding.getSnapshot().turnId, undefined);
  });
});
