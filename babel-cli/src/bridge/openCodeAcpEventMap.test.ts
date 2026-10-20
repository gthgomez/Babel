import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyPromptResponseUsage,
  mapOpenCodeAcpUpdate,
  mapPromptTerminalFromStopReason,
  normalizeAcpSessionUpdate,
  type AcpTurnMapState,
} from './openCodeAcpEventMap.js';

describe('openCodeAcpEventMap', () => {
  it('normalizes canonical string sessionUpdate discriminators', () => {
    const body = normalizeAcpSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: [{ type: 'text', text: 'hello' }],
    });
    assert.equal(body?.sessionUpdateKind, 'agent_message_chunk');
  });

  it('maps canonical v1 agent_message_chunk updates', () => {
    const state = { textBuffer: [], terminalEmitted: false, promptAdmitted: true };
    const events = mapOpenCodeAcpUpdate(
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
    const events = mapOpenCodeAcpUpdate(
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
    mapOpenCodeAcpUpdate(
      { sessionUpdate: 'usage_update', cost: { amount: 0.15, currency: 'USD' } },
      state,
      1,
    );
    assert.ok(Math.abs((state.usage?.totalCostUSD ?? 0) - 0.05) < 1e-9);
    assert.equal(state.lastCumulativeCostUSD, 0.15);
  });

  it('treats USD cumulative usage as incomplete when session baseline is unknown', () => {
    const state: AcpTurnMapState = {
      textBuffer: [],
      terminalEmitted: false,
      promptAdmitted: true,
    };
    mapOpenCodeAcpUpdate(
      { sessionUpdate: 'usage_update', cost: { amount: 10.05, currency: 'USD' } },
      state,
      1,
    );
    assert.equal(state.usage?.costComplete, false);
    assert.equal(state.usage?.unknownChargeCount, 1);
  });

  it('treats decreasing USD cumulative total as incomplete cost', () => {
    const state: AcpTurnMapState = {
      textBuffer: [],
      terminalEmitted: false,
      promptAdmitted: true,
      sessionCostBaselineUSD: 10,
    };
    mapOpenCodeAcpUpdate(
      { sessionUpdate: 'usage_update', cost: { amount: 0.15, currency: 'USD' } },
      state,
      1,
    );
    assert.equal(state.usage?.costComplete, false);
    assert.equal(state.usage?.totalCostUSD, 0);
  });

  it('keeps USD turn partial after unknown baseline on a session-new path', () => {
    const state: AcpTurnMapState = {
      textBuffer: [],
      terminalEmitted: false,
      promptAdmitted: true,
    };
    mapOpenCodeAcpUpdate(
      { sessionUpdate: 'usage_update', cost: { amount: 10.05, currency: 'USD' } },
      state,
      1,
    );
    assert.equal(state.usage?.costComplete, false);
  });

  it('treats EUR cumulative usage as unknown USD cost', () => {
    const state: AcpTurnMapState = {
      textBuffer: [],
      terminalEmitted: false,
      promptAdmitted: true,
      sessionCostBaselineUSD: 0,
    };
    mapOpenCodeAcpUpdate(
      { sessionUpdate: 'usage_update', cost: { amount: 0.15, currency: 'EUR' } },
      state,
      1,
    );
    assert.equal(state.usage?.costComplete, false);
    assert.equal(state.usage?.unknownChargeCount, 1);
    assert.equal(state.lastCumulativeCostUSD, undefined);
  });

  it('maps failed tool_call_update to tool_failed', () => {
    const state = { textBuffer: [], terminalEmitted: false, promptAdmitted: true };
    const events = mapOpenCodeAcpUpdate(
      { sessionUpdate: 'tool_call_update', status: 'failed', title: 'run', toolCallId: 't1' },
      state,
      1,
    );
    assert.equal(events[0]?.type, 'tool_failed');
  });

  it('preserves session/prompt response token usage without inventing cost', () => {
    const state: AcpTurnMapState = {
      textBuffer: ['answer'],
      terminalEmitted: false,
      promptAdmitted: true,
    };
    applyPromptResponseUsage(state, {
      stopReason: 'end_turn',
      usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
    });
    const events = mapPromptTerminalFromStopReason(state, 1, 'end_turn');
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    assert.equal(done.usage.totalInputTokens, 1200);
    assert.equal(done.usage.totalOutputTokens, 340);
    assert.equal(done.usage.totalTokens, 1540);
    assert.equal(done.usage.costComplete, false);
  });

  it('ignores v1 idle end_turn after prompt admission (stopReason is authoritative on prompt RPC)', () => {
    const state = { textBuffer: [], terminalEmitted: false, promptAdmitted: true };
    const events = mapOpenCodeAcpUpdate(
      { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
      state,
      1,
    );
    assert.equal(events.length, 0);
  });
});
