import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyAcpReplayUpdate,
  createCommandCodeReplayAccumulator,
  finalizeReplayCells,
} from './commandCodeAcpReplay.js';

describe('commandCodeAcpReplay', () => {
  it('merges chunks with the same messageId into one assistant cell with stable id', () => {
    const acc = createCommandCodeReplayAccumulator();
    const native = 'sess_native_1';
    applyAcpReplayUpdate(
      acc,
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello' } },
      'thread-1',
      native,
    );
    applyAcpReplayUpdate(
      acc,
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' world' } },
      'thread-1',
      native,
    );
    const cells = finalizeReplayCells(acc);
    assert.equal(cells.length, 1);
    assert.equal((cells[0]?.payload as { message: string }).message, 'Hello world');
    const again = createCommandCodeReplayAccumulator();
    applyAcpReplayUpdate(
      again,
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello' } },
      'thread-1',
      native,
    );
    applyAcpReplayUpdate(
      again,
      { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' world' } },
      'thread-1',
      native,
    );
    assert.equal(finalizeReplayCells(again)[0]?.cell_id, cells[0]?.cell_id);
  });

  it('merges consecutive assistant chunks without messageId into one cell', () => {
    const acc = createCommandCodeReplayAccumulator();
    const native = 'sess_native_2';
    applyAcpReplayUpdate(
      acc,
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } },
      'thread-2',
      native,
    );
    applyAcpReplayUpdate(
      acc,
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
      'thread-2',
      native,
    );
    const cells = finalizeReplayCells(acc);
    assert.equal(cells.length, 1);
    assert.equal((cells[0]?.payload as { message: string }).message, 'hello world');
  });
});
