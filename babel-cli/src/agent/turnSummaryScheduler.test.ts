/**
 * B2: Unit tests for turnSummaryScheduler — scheduler, store, budget gate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  shouldRequestTurnSummary,
  resolveSummaryInterval,
  shouldSkipForBudget,
  TurnSummaryStore,
  buildSummaryRequestPrompt,
  type TurnSummary,
  type SummaryCompletionHook,
} from './turnSummaryScheduler.js';
import {
  maybeRequestTurnSummary,
  getEngineTurnSummaryStore,
  clearEngineTurnSummaryStore,
  type ObservabilityHandles,
} from './chatEngineObservability.js';

// ── Scheduler ──────────────────────────────────────────────────────────────

describe('shouldRequestTurnSummary', () => {
  it('fires at turn indices 5, 10, 15, … with k=5', () => {
    // turn is 0-based, so turn=4 is the 5th turn → should fire
    assert.strictEqual(shouldRequestTurnSummary(4, 5), true);  // turn 5
    assert.strictEqual(shouldRequestTurnSummary(9, 5), true);  // turn 10
    assert.strictEqual(shouldRequestTurnSummary(14, 5), true); // turn 15
    assert.strictEqual(shouldRequestTurnSummary(19, 5), true); // turn 20
  });

  it('does NOT fire at non-K boundaries', () => {
    assert.strictEqual(shouldRequestTurnSummary(0, 5), false);
    assert.strictEqual(shouldRequestTurnSummary(1, 5), false);
    assert.strictEqual(shouldRequestTurnSummary(2, 5), false);
    assert.strictEqual(shouldRequestTurnSummary(3, 5), false);
    assert.strictEqual(shouldRequestTurnSummary(5, 5), false);
    assert.strictEqual(shouldRequestTurnSummary(6, 5), false);
    assert.strictEqual(shouldRequestTurnSummary(8, 5), false);
  });

  it('k=0 disables summaries', () => {
    assert.strictEqual(shouldRequestTurnSummary(4, 0), false);
    assert.strictEqual(shouldRequestTurnSummary(9, 0), false);
    assert.strictEqual(shouldRequestTurnSummary(0, 0), false);
  });

  it('k=1 fires every turn', () => {
    assert.strictEqual(shouldRequestTurnSummary(0, 1), true);
    assert.strictEqual(shouldRequestTurnSummary(1, 1), true);
    assert.strictEqual(shouldRequestTurnSummary(2, 1), true);
    assert.strictEqual(shouldRequestTurnSummary(99, 1), true);
  });

  it('k=3 fires at 3, 6, 9', () => {
    assert.strictEqual(shouldRequestTurnSummary(2, 3), true);  // turn 3
    assert.strictEqual(shouldRequestTurnSummary(5, 3), true);  // turn 6
    assert.strictEqual(shouldRequestTurnSummary(8, 3), true);  // turn 9
    assert.strictEqual(shouldRequestTurnSummary(0, 3), false);
    assert.strictEqual(shouldRequestTurnSummary(1, 3), false);
    assert.strictEqual(shouldRequestTurnSummary(3, 3), false);
  });
});

// ── Env resolution ─────────────────────────────────────────────────────────

describe('resolveSummaryInterval', () => {
  it('defaults to 5 when env is empty', () => {
    assert.strictEqual(resolveSummaryInterval({}), 5);
  });

  it('returns K from BABEL_CHAT_SUMMARY_EVERY', () => {
    assert.strictEqual(resolveSummaryInterval({ BABEL_CHAT_SUMMARY_EVERY: '3' }), 3);
    assert.strictEqual(resolveSummaryInterval({ BABEL_CHAT_SUMMARY_EVERY: '10' }), 10);
    assert.strictEqual(resolveSummaryInterval({ BABEL_CHAT_SUMMARY_EVERY: '1' }), 1);
  });

  it('returns 0 (disabled) when BABEL_CHAT_SUMMARY_EVERY=0', () => {
    assert.strictEqual(resolveSummaryInterval({ BABEL_CHAT_SUMMARY_EVERY: '0' }), 0);
  });

  it('handles whitespace / empty string', () => {
    assert.strictEqual(resolveSummaryInterval({ BABEL_CHAT_SUMMARY_EVERY: '  ' }), 5);
    assert.strictEqual(resolveSummaryInterval({ BABEL_CHAT_SUMMARY_EVERY: '' }), 5);
  });

  it('clamps negative values to default 5', () => {
    assert.strictEqual(resolveSummaryInterval({ BABEL_CHAT_SUMMARY_EVERY: '-1' }), 5);
  });

  it('handles non-numeric garbage gracefully', () => {
    assert.strictEqual(resolveSummaryInterval({ BABEL_CHAT_SUMMARY_EVERY: 'abc' }), 5);
  });
});

// ── Budget gate ─────────────────────────────────────────────────────────────

describe('shouldSkipForBudget', () => {
  it('returns false when no cost limit is set (0)', () => {
    assert.strictEqual(shouldSkipForBudget(0, 5), false);
  });

  it('returns false when spent is well under limit', () => {
    assert.strictEqual(shouldSkipForBudget(10, 1), false);
    assert.strictEqual(shouldSkipForBudget(10, 5), false);
    assert.strictEqual(shouldSkipForBudget(10, 8.5), false);
  });

  it('returns true when remaining budget < 10% of limit', () => {
    // limit=10, spent=9.1 → remaining=0.9 < 1.0 (10%)
    assert.strictEqual(shouldSkipForBudget(10, 9.1), true);
    // limit=10, spent=9.5 → remaining=0.5 < 1.0
    assert.strictEqual(shouldSkipForBudget(10, 9.5), true);
  });

  it('returns true when budget is already exceeded', () => {
    assert.strictEqual(shouldSkipForBudget(10, 10), true);
    assert.strictEqual(shouldSkipForBudget(10, 11), true);
  });

  it('respects custom threshold', () => {
    // 20% threshold: limit=10, spent=8.1 → remaining=1.9 < 2.0
    assert.strictEqual(shouldSkipForBudget(10, 8.1, 0.2), true);
    // 20% threshold: limit=10, spent=8.0 → remaining=2.0 not less
    assert.strictEqual(shouldSkipForBudget(10, 8.0, 0.2), false);
  });
});

// ── Store ──────────────────────────────────────────────────────────────────

describe('TurnSummaryStore', () => {
  function makeSummary(turn: number): TurnSummary {
    return {
      turn,
      hypothesis: `Test hypothesis for turn ${turn}`,
      files_of_interest: [`file${turn}.ts`],
      next_tool: 'read_file',
      blockers: [],
      ts: new Date().toISOString(),
    };
  }

  it('starts empty', () => {
    const store = new TurnSummaryStore();
    assert.strictEqual(store.length, 0);
    assert.deepStrictEqual(store.toJSON(), []);
    assert.deepStrictEqual(store.lastInContext(), []);
  });

  it('push appends and toJSON returns all', () => {
    const store = new TurnSummaryStore();
    store.push(makeSummary(4));
    store.push(makeSummary(9));
    assert.strictEqual(store.length, 2);
    const all = store.toJSON();
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0]!.turn, 4);
    assert.strictEqual(all[1]!.turn, 9);
  });

  it('lastInContext returns last N (default 2)', () => {
    const store = new TurnSummaryStore();
    for (let i = 0; i < 10; i++) store.push(makeSummary(i));
    assert.strictEqual(store.length, 10);
    const last2 = store.lastInContext();
    assert.strictEqual(last2.length, 2);
    assert.strictEqual(last2[0]!.turn, 8);
    assert.strictEqual(last2[1]!.turn, 9);
  });

  it('lastInContext with n=1 returns single entry', () => {
    const store = new TurnSummaryStore();
    store.push(makeSummary(4));
    store.push(makeSummary(9));
    const last1 = store.lastInContext(1);
    assert.strictEqual(last1.length, 1);
    assert.strictEqual(last1[0]!.turn, 9);
  });

  it('lastInContext when store has fewer than N returns all', () => {
    const store = new TurnSummaryStore();
    store.push(makeSummary(4));
    const last2 = store.lastInContext(2);
    assert.strictEqual(last2.length, 1);
  });

  it('clear empties the store', () => {
    const store = new TurnSummaryStore();
    store.push(makeSummary(4));
    store.clear();
    assert.strictEqual(store.length, 0);
    assert.deepStrictEqual(store.toJSON(), []);
  });
});

// ── Prompt builder ─────────────────────────────────────────────────────────

describe('buildSummaryRequestPrompt', () => {
  it('includes the turn number', () => {
    const prompt = buildSummaryRequestPrompt(4);
    assert.ok(prompt.includes('turn 5')); // 0-based turn 4 → 1-based "turn 5"
  });

  it('includes the expected JSON template', () => {
    const prompt = buildSummaryRequestPrompt(0);
    assert.ok(prompt.includes('hypothesis'));
    assert.ok(prompt.includes('files_of_interest'));
    assert.ok(prompt.includes('next_tool'));
    assert.ok(prompt.includes('blockers'));
  });
});

// ── Integration simulation: scheduler + store ───────────────────────────────

describe('scheduler + store integration', () => {
  it('store length matches expected firings over 25 turns with k=5', () => {
    const store = new TurnSummaryStore();
    const K = 5;
    let stored = 0;
    for (let turn = 0; turn < 25; turn++) {
      if (shouldRequestTurnSummary(turn, K)) {
        store.push({
          turn,
          hypothesis: `Simulated at turn ${turn}`,
          files_of_interest: ['sim.ts'],
          next_tool: 'read_file',
          blockers: [],
          ts: new Date().toISOString(),
        });
        stored++;
      }
    }
    // Fires at 4,9,14,19,24 → 5 summaries
    assert.strictEqual(stored, 5);
    assert.strictEqual(store.length, 5);
  });

  it('produces zero summaries when k=0 (disabled)', () => {
    const store = new TurnSummaryStore();
    for (let turn = 0; turn < 30; turn++) {
      if (shouldRequestTurnSummary(turn, 0)) {
        store.push({
          turn,
          hypothesis: 'should not be stored',
          files_of_interest: [],
          next_tool: '',
          blockers: [],
          ts: new Date().toISOString(),
        });
      }
    }
    assert.strictEqual(store.length, 0);
  });
});

// ── maybeRequestTurnSummary (B2 repair): wiring tests ─────────────────────

function makeMinimalHandles(turn: number, runDir: string): ObservabilityHandles {
  return {
    turnIndex: turn,
    engineRunDir: runDir,
    // Unused fields — minimal stubs to satisfy the interface
    toolCallLog: [],
    lastVerifierReceipt: null,
    policyEventLog: { record: () => {}, last: () => [], toJSONL: () => '', clear: () => {} } as unknown as ObservabilityHandles['policyEventLog'],
    routingReceiptLog: { push: () => {}, toJSON: () => [], clear: () => {} } as unknown as ObservabilityHandles['routingReceiptLog'],
    observationTails: { record: () => {}, toJSON: () => [], clear: () => {} } as unknown as ObservabilityHandles['observationTails'],
    blockedAttemptLedger: { record: () => {}, toJSON: () => [], countsByReason: () => ({ total: 0, byReason: {} }), clear: () => {} } as unknown as ObservabilityHandles['blockedAttemptLedger'],
    logIndexToTurn: new Map(),
    turnToolCallLogStart: 0,
    lastPhase: null,
  };
}

describe('maybeRequestTurnSummary', () => {
  const RUN_DIR = '/test/b2-run';

  function clearStore(): void {
    clearEngineTurnSummaryStore(RUN_DIR);
  }

  it('fires hook at turn 4 (5th turn) with K=5', async () => {
    clearStore();
    const prev = process.env['BABEL_CHAT_SUMMARY_EVERY'];
    process.env['BABEL_CHAT_SUMMARY_EVERY'] = '5';
    try {
      const calls: number[] = [];
      const hook: SummaryCompletionHook = async (turn, _prompt) => {
        calls.push(turn);
        return {
          turn,
          hypothesis: 'test hypothesis',
          files_of_interest: ['a.ts'],
          next_tool: 'read_file',
          blockers: [],
          ts: new Date().toISOString(),
        };
      };

      // Turn 4 (1-based turn 5) should fire
      await maybeRequestTurnSummary(makeMinimalHandles(4, RUN_DIR), hook);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0], 4);

      const store = getEngineTurnSummaryStore(RUN_DIR);
      assert.strictEqual(store.length, 1);
      assert.strictEqual(store.toJSON()[0]!.turn, 4);
    } finally {
      if (prev !== undefined) process.env['BABEL_CHAT_SUMMARY_EVERY'] = prev;
      else delete process.env['BABEL_CHAT_SUMMARY_EVERY'];
    }
  });

  it('does NOT fire at non-K boundaries (turns 0-3)', async () => {
    clearStore();
    const prev = process.env['BABEL_CHAT_SUMMARY_EVERY'];
    process.env['BABEL_CHAT_SUMMARY_EVERY'] = '5';
    try {
      const calls: number[] = [];
      const hook: SummaryCompletionHook = async (turn) => {
        calls.push(turn);
        return null;
      };

      for (let t = 0; t < 4; t++) {
        await maybeRequestTurnSummary(makeMinimalHandles(t, RUN_DIR), hook);
      }
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(getEngineTurnSummaryStore(RUN_DIR).length, 0);
    } finally {
      if (prev !== undefined) process.env['BABEL_CHAT_SUMMARY_EVERY'] = prev;
      else delete process.env['BABEL_CHAT_SUMMARY_EVERY'];
    }
  });

  it('is no-op safe when hook is null (no crash, no store)', async () => {
    clearStore();
    const prev = process.env['BABEL_CHAT_SUMMARY_EVERY'];
    process.env['BABEL_CHAT_SUMMARY_EVERY'] = '5';
    try {
      await maybeRequestTurnSummary(makeMinimalHandles(4, RUN_DIR), null);
      const store = getEngineTurnSummaryStore(RUN_DIR);
      assert.strictEqual(store.length, 0);
      // Verify no crash — just reaching here is the pass condition
    } finally {
      if (prev !== undefined) process.env['BABEL_CHAT_SUMMARY_EVERY'] = prev;
      else delete process.env['BABEL_CHAT_SUMMARY_EVERY'];
    }
  });

  it('fire count matches expected firings over 20 turns with K=5', async () => {
    clearStore();
    const prev = process.env['BABEL_CHAT_SUMMARY_EVERY'];
    process.env['BABEL_CHAT_SUMMARY_EVERY'] = '5';
    try {
      const fired: number[] = [];
      const hook: SummaryCompletionHook = async (turn) => {
        fired.push(turn);
        return {
          turn,
          hypothesis: `Summary at turn ${turn}`,
          files_of_interest: ['test.ts'],
          next_tool: 'grep',
          blockers: [],
          ts: new Date().toISOString(),
        };
      };

      for (let t = 0; t < 20; t++) {
        await maybeRequestTurnSummary(makeMinimalHandles(t, RUN_DIR), hook);
      }

      // Fires at turns 4, 9, 14, 19 → 4 summaries
      assert.strictEqual(fired.length, 4);
      assert.deepStrictEqual(fired, [4, 9, 14, 19]);

      const store = getEngineTurnSummaryStore(RUN_DIR);
      assert.strictEqual(store.length, 4);
      store.toJSON().forEach((s, i) => {
        assert.strictEqual(s.turn, [4, 9, 14, 19][i]);
      });
    } finally {
      if (prev !== undefined) process.env['BABEL_CHAT_SUMMARY_EVERY'] = prev;
      else delete process.env['BABEL_CHAT_SUMMARY_EVERY'];
    }
  });

  it('never fires when K=0 (disabled)', async () => {
    clearStore();
    const prev = process.env['BABEL_CHAT_SUMMARY_EVERY'];
    process.env['BABEL_CHAT_SUMMARY_EVERY'] = '0';
    try {
      const hook: SummaryCompletionHook = async () => {
        return { turn: 0, hypothesis: 'x', files_of_interest: [], next_tool: '', blockers: [], ts: '' };
      };
      for (let t = 0; t < 20; t++) {
        await maybeRequestTurnSummary(makeMinimalHandles(t, RUN_DIR), hook);
      }
      assert.strictEqual(getEngineTurnSummaryStore(RUN_DIR).length, 0);
    } finally {
      if (prev !== undefined) process.env['BABEL_CHAT_SUMMARY_EVERY'] = prev;
      else delete process.env['BABEL_CHAT_SUMMARY_EVERY'];
    }
  });
});
