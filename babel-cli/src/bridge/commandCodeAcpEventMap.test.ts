import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapCommandCodeAcpUpdate } from './commandCodeAcpEventMap.js';

describe('commandCodeAcpEventMap', () => {
  it('maps official v2 agent_message_chunk updates', () => {
    const state = { textBuffer: [], terminalEmitted: false };
    const events = mapCommandCodeAcpUpdate(
      {
        sessionUpdate: {
          type: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
      state,
      2,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'answer_chunk');
    assert.equal((events[0] as { text: string }).text, 'hello');
  });

  it('does not fabricate zero usage or completed on unknown idle stop reason', () => {
    const state = { textBuffer: ['x'], terminalEmitted: false };
    const events = mapCommandCodeAcpUpdate(
      { sessionUpdate: { type: 'state_update', state: 'idle', stopReason: 'max_tokens' } },
      state,
      2,
    );
    assert.equal(events[0]?.type, 'failed');
    const unknown = mapCommandCodeAcpUpdate(
      { sessionUpdate: { type: 'state_update', state: 'idle' } },
      { textBuffer: [], terminalEmitted: false },
      2,
    );
    assert.equal(unknown.length, 0);
  });
});
