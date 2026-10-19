import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapCommandCodeAcpUpdate,
  normalizeAcpSessionUpdate,
  type AcpTurnMapState,
} from './commandCodeAcpEventMap.js';

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

  it('maps cumulative session usage to per-turn USD delta', () => {
    const state: AcpTurnMapState = {
      textBuffer: [],
      terminalEmitted: false,
      promptAdmitted: true,
      sessionCostBaselineUSD: 0.1,
    };
    mapCommandCodeAcpUpdate(
      { sessionUpdate: 'usage_update', cost: { amount: 0.15, currency: 'USD' } },
      state,
      1,
    );
    assert.ok(Math.abs((state.usage?.totalCostUSD ?? 0) - 0.05) < 1e-9);
    assert.equal(state.lastCumulativeCostUSD, 0.15);
  });

  it('maps failed tool_call_update to tool_failed', () => {
    const state = { textBuffer: [], terminalEmitted: false, promptAdmitted: true };
    const events = mapCommandCodeAcpUpdate(
      { sessionUpdate: 'tool_call_update', status: 'failed', title: 'run', toolCallId: 't1' },
      state,
      1,
    );
    assert.equal(events[0]?.type, 'tool_failed');
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
