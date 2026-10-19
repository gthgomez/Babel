import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapCommandCodeAcpUpdate, normalizeAcpSessionUpdate } from './commandCodeAcpEventMap.js';

describe('commandCodeAcpEventMap', () => {
  it('normalizes canonical string sessionUpdate discriminators', () => {
    const body = normalizeAcpSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: [{ type: 'text', text: 'hello' }],
    });
    assert.equal(body?.sessionUpdateKind, 'agent_message_chunk');
  });

  it('maps canonical v1 agent_message_chunk updates', () => {
    const state = { textBuffer: [], terminalEmitted: false, promptAdmitted: true };
    const events = mapCommandCodeAcpUpdate(
      {
        sessionUpdate: 'agent_message_chunk',
        content: [{ type: 'text', text: 'hello' }],
      },
      state,
      1,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'answer_chunk');
  });

  it('ignores startup idle end_turn before prompt admission', () => {
    const state = { textBuffer: [], terminalEmitted: false, promptAdmitted: false };
    const events = mapCommandCodeAcpUpdate(
      { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
      state,
      1,
    );
    assert.equal(events.length, 0);
  });

  it('ignores v1 idle end_turn after prompt admission (stopReason is authoritative on prompt RPC)', () => {
    const state = { textBuffer: [], terminalEmitted: false, promptAdmitted: true };
    const events = mapCommandCodeAcpUpdate(
      { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
      state,
      1,
    );
    assert.equal(events.length, 0);
  });
});
