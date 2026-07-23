import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchChatEvent } from './chatEventDispatch.js';
import type { ConversationalRenderer } from '../../ui/waterfall.js';

describe('dispatchChatEvent context_compacted (T4.1)', () => {
  it('routes context_compacted to ConversationalRenderer.onContextCompacted', () => {
    const calls: string[] = [];
    const convRenderer = {
      onContextCompacted: (msg: string) => {
        calls.push(msg);
      },
    } as unknown as ConversationalRenderer;

    dispatchChatEvent(
      {
        type: 'context_compacted',
        mode: 'heuristic',
        beforeMessages: 40,
        afterMessages: 12,
        message: '[Context compacted…] 40→12 messages (heuristic)',
      },
      { convRenderer },
    );

    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes('Context compacted'));
    assert.ok(calls[0]!.includes('40→12'));
  });
});
