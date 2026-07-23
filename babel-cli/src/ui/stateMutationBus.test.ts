/**
 * Tests for StateMutationBus — StateStore, TuiMutations, tuiStateReducer,
 * subscriptions, middleware, and dispatch pipeline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StateStore,
  createStateStore,
  createInitialTuiState,
  tuiStateReducer,
  type TuiState,
  type Mutation,
} from './stateMutationBus.js';

// ── Helpers ────────────────────────────────────────────────────────────────

interface TestMutation extends Mutation {
  type: 'test:increment';
  amount: number;
}

interface TestState {
  count: number;
}

function testReducer(state: TestState, m: TestMutation): TestState {
  if (m.type === 'test:increment') {
    return { count: state.count + m.amount };
  }
  return state;
}

// ── StateStore core ────────────────────────────────────────────────────────

test('createStateStore returns a StateStore instance', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  assert.ok(store instanceof StateStore);
});

test('currentState returns the initial state', () => {
  const store = createStateStore({ count: 5 }, testReducer);
  assert.deepEqual(store.currentState, { count: 5 });
});

test('dispatch applies mutation through reducer and updates state', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  store.dispatch({ type: 'test:increment', amount: 3 } as TestMutation);
  assert.deepEqual(store.currentState, { count: 3 });
});

test('dispatch sets timestamp if not provided', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  const before = Date.now();
  store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  const log = store.getMutationLog();
  assert.equal(log.length, 1);
  assert.ok(typeof log[0]!.ts === 'number');
  assert.ok(log[0]!.ts! >= before);
});

test('dispatch preserves provided timestamp', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  store.dispatch({ type: 'test:increment', amount: 1, ts: 42 } as TestMutation);
  assert.equal(store.getMutationLog()[0]!.ts, 42);
});

test('setState routes through dispatch and logs @internal:reset mutation', () => {
  const store = createStateStore(createInitialTuiState(), tuiStateReducer);
  const newState = createInitialTuiState();
  store.setState(newState);
  assert.deepEqual(store.currentState, newState);
  const log = store.getMutationLog();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.type, '@internal:reset');
});

test('getMutationLog returns dispatched mutations in order', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  store.dispatch({ type: 'test:increment', amount: 2 } as TestMutation);
  const log = store.getMutationLog();
  assert.equal(log.length, 2);
});

test('clearLog empties the mutation log', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  assert.equal(store.getMutationLog().length, 1);
  store.clearLog();
  assert.equal(store.getMutationLog().length, 0);
});

test('mutation log enforces maxLogSize (default 500, custom via options)', () => {
  const store = createStateStore({ count: 0 }, testReducer, { maxLogSize: 3 });
  for (let i = 0; i < 5; i++) {
    store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  }
  const log = store.getMutationLog();
  assert.equal(log.length, 3);
});

test('maxLogSize defaults to 500 when not specified', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  const storeAny = store as unknown as { logMaxSize: number };
  // Access private field indirectly
  for (let i = 0; i < 500; i++) {
    store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  }
  assert.equal(store.getMutationLog().length, 500);
  // One more should evict oldest
  store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  assert.equal(store.getMutationLog().length, 500);
});

// ── Subscriptions ──────────────────────────────────────────────────────────

test('subscribe to specific type receives only that type', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  const received: TestMutation[] = [];
  store.subscribe('test:increment', (m) => received.push(m));
  store.dispatch({ type: 'test:increment', amount: 5 } as TestMutation);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.amount, 5);
});

test('subscribe wildcard "*" receives all mutation types', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  const received: Mutation[] = [];
  // Wildcard '*' is supported at runtime but not modeled by the generic
  // constraint K extends M['type']. Cast to any for the test.
  (store as StateStore<TestState, any>).subscribe('*', (m: Mutation) => received.push(m));
  store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.type, 'test:increment');
});

test('multiple subscribers for same type all fire', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  let count = 0;
  store.subscribe('test:increment', () => {
    count++;
  });
  store.subscribe('test:increment', () => {
    count++;
  });
  store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  assert.equal(count, 2);
});

test('unsubscribe function stops callback from being called', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  let count = 0;
  const unsub = store.subscribe('test:increment', () => {
    count++;
  });
  unsub();
  store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  assert.equal(count, 0);
});

test('subscriber errors are reported to stderr but do not break the dispatch pipeline', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  let secondFired = false;
  const stderrWritten: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: any) => {
    stderrWritten.push(String(chunk));
    return true;
  };
  try {
    store.subscribe('test:increment', () => {
      throw new Error('boom');
    });
    store.subscribe('test:increment', () => {
      secondFired = true;
    });
    // Should not throw
    store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
    assert.ok(secondFired, 'second subscriber must still fire');
    assert.ok(stderrWritten.length >= 1, 'must have written to stderr');
    assert.ok(stderrWritten[0]!.includes('[babel:tui] subscriber error in "test:increment"'));
    assert.ok(stderrWritten[0]!.includes('boom'));
  } finally {
    process.stderr.write = origWrite;
  }
});

test('dispatch without subscribers does not throw', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  // No subscribers at all
  assert.doesNotThrow(() => {
    store.dispatch({ type: 'test:increment', amount: 1 } as TestMutation);
  });
});

test('subscriber is not called when state does not change (reducer returns same reference)', () => {
  // Use a reducer that returns the same reference when nothing changes
  function noChangeReducer(
    state: { count: number },
    m: { type: string; amount: number },
  ): { count: number } {
    if (m.type === 'test:increment' && m.amount === 0) return state;
    return { count: state.count + m.amount };
  }
  const store = createStateStore({ count: 0 }, noChangeReducer);
  let called = false;
  store.subscribe('test:increment', () => {
    called = true;
  });
  store.dispatch({ type: 'test:increment', amount: 0 } as any);
  assert.equal(called, false);
});

// ── Middleware ─────────────────────────────────────────────────────────────

test('middleware can modify mutation before reducer', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  store.use((m) => ({ ...m, amount: (m as TestMutation).amount * 2 }));
  store.dispatch({ type: 'test:increment', amount: 5 } as TestMutation);
  assert.deepEqual(store.currentState, { count: 10 });
});

test('middleware returning null cancels the mutation', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  store.use(() => null);
  store.dispatch({ type: 'test:increment', amount: 5 } as TestMutation);
  assert.deepEqual(store.currentState, { count: 0 });
});

test('multiple middlewares chain in registration order', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  store.use((m) => ({ ...m, amount: (m as TestMutation).amount + 1 }));
  store.use((m) => ({ ...m, amount: (m as TestMutation).amount * 3 }));
  // amount: 5 → +1 → *3 = 18
  store.dispatch({ type: 'test:increment', amount: 5 } as TestMutation);
  assert.deepEqual(store.currentState, { count: 18 });
});

test('middleware removal via returned unsubscriber works', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  const remove = store.use((m) => ({ ...m, amount: (m as TestMutation).amount * 10 }));
  remove(); // Remove the middleware
  store.dispatch({ type: 'test:increment', amount: 5 } as TestMutation);
  assert.deepEqual(store.currentState, { count: 5 });
});

test('cancelled mutations are not appended to the log', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  store.use(() => null);
  store.dispatch({ type: 'test:increment', amount: 5 } as TestMutation);
  assert.equal(store.getMutationLog().length, 0);
});

test('middleware only cancels the current mutation, not subsequent ones', () => {
  const store = createStateStore({ count: 0 }, testReducer);
  let shouldCancel = true;
  store.use((m) => (shouldCancel ? null : m));
  store.dispatch({ type: 'test:increment', amount: 5 } as TestMutation);
  assert.equal(store.getMutationLog().length, 0);

  shouldCancel = false;
  store.dispatch({ type: 'test:increment', amount: 3 } as TestMutation);
  assert.equal(store.getMutationLog().length, 1);
});

// ── Dispatch return value ─────────────────────────────────────────────────

test('dispatch returns true when mutation changes state', () => {
  const store = createStateStore(createInitialTuiState(), tuiStateReducer);
  const result = store.dispatch({ type: 'stage:transition', stage: 2 });
  assert.equal(result, true);
  assert.equal(store.currentState.stage, 2);
});

test('dispatch returns false when middleware cancels mutation', () => {
  const store = createStateStore(createInitialTuiState(), tuiStateReducer);
  const remove = store.use(() => null); // middleware that cancels everything
  const result = store.dispatch({ type: 'stage:transition', stage: 2 });
  assert.equal(result, false);
  assert.equal(store.currentState.stage, 0); // unchanged
  remove(); // cleanup
});

test('dispatch returns false when reducer returns unchanged state', () => {
  const store = createStateStore(createInitialTuiState(), tuiStateReducer);
  // stage:transition returns same state ref when stage is unchanged
  const result = store.dispatch({ type: 'stage:transition', stage: 0 });
  assert.equal(result, false);
  assert.equal(store.currentState.stage, 0);
});

// ── tuiStateReducer — per mutation type ────────────────────────────────────

function freshState(overrides: Partial<TuiState> = {}): TuiState {
  return { ...createInitialTuiState(), ...overrides };
}

test('stage:transition updates stage and activeAction', () => {
  const state = tuiStateReducer(freshState(), { type: 'stage:transition', stage: 2 });
  assert.equal(state.stage, 2);
  assert.equal(state.activeAction, 'Planning');
});

test('stage:transition no-ops when stage is unchanged', () => {
  const initial = freshState({ stage: 1, activeAction: 'existing' });
  const state = tuiStateReducer(initial, { type: 'stage:transition', stage: 1 });
  assert.equal(state, initial); // Same reference
});

test('activity:log appends line to activityLog', () => {
  const state = tuiStateReducer(freshState(), { type: 'activity:log', line: 'hello' });
  assert.deepEqual(state.activityLog, ['hello']);
  assert.equal(state.activeAction, 'hello');
});

test('activity:log caps activityLog at 10 entries', () => {
  let state = freshState();
  for (let i = 0; i < 15; i++) {
    state = tuiStateReducer(state, { type: 'activity:log', line: `line-${i}` });
  }
  assert.equal(state.activityLog.length, 10);
  assert.equal(state.activityLog[0], 'line-5');
});

test('activity:log with filePath adds to activeFiles', () => {
  const state = tuiStateReducer(freshState(), {
    type: 'activity:log',
    line: 'edited',
    filePath: '/foo.ts',
  });
  assert.deepEqual(state.activeFiles, ['/foo.ts']);
});

test('activity:log deduplicates activeFiles', () => {
  let state = tuiStateReducer(freshState(), {
    type: 'activity:log',
    line: 'a',
    filePath: '/a.ts',
  });
  state = tuiStateReducer(state, {
    type: 'activity:log',
    line: 'b',
    filePath: '/a.ts',
  });
  assert.deepEqual(state.activeFiles, ['/a.ts']);
});

test('activity:log caps activeFiles at 6', () => {
  let state = freshState();
  for (let i = 0; i < 10; i++) {
    state = tuiStateReducer(state, {
      type: 'activity:log',
      line: `edit-${i}`,
      filePath: `/f${i}.ts`,
    });
  }
  assert.equal(state.activeFiles.length, 6);
});

test('tool:start adds pending tool call', () => {
  const state = tuiStateReducer(freshState(), {
    type: 'tool:start',
    toolId: 1,
    tool: 'file_read',
    target: 'foo.ts',
  });
  assert.equal(state.pendingToolCalls.size, 1);
  assert.deepEqual(state.pendingToolCalls.get(1), { tool: 'file_read', target: 'foo.ts' });
});

test('tool:start supports multiple pending tool calls', () => {
  let state = tuiStateReducer(freshState(), {
    type: 'tool:start',
    toolId: 1,
    tool: 'read',
    target: 'a.ts',
  });
  state = tuiStateReducer(state, {
    type: 'tool:start',
    toolId: 2,
    tool: 'write',
    target: 'b.ts',
  });
  assert.equal(state.pendingToolCalls.size, 2);
});

test('tool:complete removes pending and increments completed count', () => {
  let state = tuiStateReducer(freshState(), {
    type: 'tool:start',
    toolId: 1,
    tool: 'read',
    target: 'a.ts',
  });
  state = tuiStateReducer(state, { type: 'tool:complete', toolId: 1 });
  assert.equal(state.pendingToolCalls.size, 0);
  assert.equal(state.completedToolCalls, 1);
});

test('tool:complete for unknown toolId is a no-op (tool already removed from pending)', () => {
  const initial = freshState();
  const state = tuiStateReducer(initial, { type: 'tool:complete', toolId: 999 });
  assert.equal(state.completedToolCalls, 0); // No increment for unknown toolId
});

test('thought:chunk appends text', () => {
  let state = tuiStateReducer(freshState(), { type: 'thought:chunk', text: 'Hmm' });
  state = tuiStateReducer(state, { type: 'thought:chunk', text: ', let me think' });
  assert.equal(state.thoughtText, 'Hmm, let me think');
});

test('answer:chunk updates lastActivityTime', () => {
  const before = Date.now();
  const state = tuiStateReducer(freshState(), { type: 'answer:chunk', text: 'The answer is 42' });
  assert.ok(state.lastActivityTime >= before);
});

test('state:transition changes renderState', () => {
  const state = tuiStateReducer(freshState(), { type: 'state:transition', to: 'streaming' });
  assert.equal(state.renderState, 'streaming');
});

test('state:transition no-ops when to matches current renderState', () => {
  const initial = freshState({ renderState: 'thinking' });
  const state = tuiStateReducer(initial, { type: 'state:transition', to: 'thinking' });
  assert.equal(state, initial);
});

test('pause:toggle sets paused flag', () => {
  const state = tuiStateReducer(freshState(), { type: 'pause:toggle', paused: true });
  assert.equal(state.paused, true);
});

test('pause:toggle no-ops when paused already matches', () => {
  const initial = freshState({ paused: true });
  const state = tuiStateReducer(initial, { type: 'pause:toggle', paused: true });
  assert.equal(state, initial);
});

test('thought:toggle sets collapsed flag', () => {
  const state = tuiStateReducer(freshState(), { type: 'thought:toggle', collapsed: true });
  assert.equal(state.thoughtCollapsed, true);
});

test('thought:toggle no-ops when collapsed already matches', () => {
  const initial = freshState({ thoughtCollapsed: true });
  const state = tuiStateReducer(initial, { type: 'thought:toggle', collapsed: true });
  assert.equal(state, initial);
});

test('file:changed adds file to activeFiles and deduplicates', () => {
  let state = tuiStateReducer(freshState(), {
    type: 'file:changed',
    filePath: '/x.ts',
    additions: 5,
    deletions: 2,
  });
  assert.deepEqual(state.activeFiles, ['/x.ts']);
  // Add same file again — deduped
  state = tuiStateReducer(state, {
    type: 'file:changed',
    filePath: '/x.ts',
    additions: 0,
    deletions: 0,
  });
  assert.deepEqual(state.activeFiles, ['/x.ts']);
});

test('file:changed caps activeFiles at 6', () => {
  let state = freshState();
  for (let i = 0; i < 10; i++) {
    state = tuiStateReducer(state, {
      type: 'file:changed',
      filePath: `/f${i}.ts`,
      additions: 1,
      deletions: 0,
    });
  }
  assert.equal(state.activeFiles.length, 6);
});

test('cost:update formats to 4 decimal places', () => {
  const state = tuiStateReducer(freshState(), { type: 'cost:update', costUSD: 0.0425 });
  assert.equal(state.cachedCostStr, '0.0425');
});

test('cost:update no-ops when cost string unchanged', () => {
  const initial = freshState({ cachedCostStr: '0.0425' });
  const state = tuiStateReducer(initial, { type: 'cost:update', costUSD: 0.0425 });
  assert.equal(state, initial);
});

test('error mutation sets renderState to failed and stores message', () => {
  const state = tuiStateReducer(freshState(), {
    type: 'error',
    message: 'Connection refused',
    stage: 2,
  });
  assert.equal(state.renderState, 'failed');
  assert.equal(state.errorMessage, 'Connection refused');
  assert.equal(state.failedStage, 2);
});

test('error mutation defaults failedStage to current stage when not provided', () => {
  const initial = freshState({ stage: 3 });
  const state = tuiStateReducer(initial, { type: 'error', message: 'boom' });
  assert.equal(state.failedStage, 3);
});

// ── createInitialTuiState ──────────────────────────────────────────────────

test('createInitialTuiState returns correct defaults', () => {
  const state = createInitialTuiState();
  assert.equal(state.renderState, 'idle');
  assert.equal(state.stage, 0);
  assert.equal(state.thoughtText, '');
  assert.equal(state.thoughtCollapsed, false);
  assert.equal(state.paused, false);
  assert.equal(state.activeAction, '');
  assert.deepEqual(state.activityLog, []);
  assert.deepEqual(state.activeFiles, []);
  assert.equal(state.pendingToolCalls.size, 0);
  assert.equal(state.completedToolCalls, 0);
  assert.equal(state.cachedCostStr, '0.0000');
  assert.equal(state.errorMessage, '');
  assert.equal(state.failedStage, 0);
});

// ── Integration: full chat lifecycle ───────────────────────────────────────

test('full chat lifecycle simulation through StateStore', () => {
  const store = createStateStore(createInitialTuiState(), tuiStateReducer);

  // Start thinking
  store.dispatch({ type: 'state:transition', to: 'thinking' });
  assert.equal(store.currentState.renderState, 'thinking');

  // Thought chunk
  store.dispatch({ type: 'thought:chunk', text: 'Let me check the imports...' });
  assert.ok(store.currentState.thoughtText.includes('imports'));

  // Tool call start
  store.dispatch({ type: 'tool:start', toolId: 1, tool: 'file_read', target: 'src/app.ts' });
  assert.equal(store.currentState.pendingToolCalls.size, 1);

  // Tool call complete
  store.dispatch({ type: 'tool:complete', toolId: 1 });
  assert.equal(store.currentState.pendingToolCalls.size, 0);
  assert.equal(store.currentState.completedToolCalls, 1);

  // Transition to streaming
  store.dispatch({ type: 'state:transition', to: 'streaming' });
  assert.equal(store.currentState.renderState, 'streaming');

  // Answer chunks
  store.dispatch({ type: 'answer:chunk', text: 'The file contains...' });

  // Done
  store.dispatch({ type: 'state:transition', to: 'done' });
  assert.equal(store.currentState.renderState, 'done');
});

test('full governed lifecycle with stage transitions', () => {
  const store = createStateStore(createInitialTuiState(), tuiStateReducer);

  store.dispatch({ type: 'state:transition', to: 'thinking' });
  store.dispatch({ type: 'stage:transition', stage: 1 });
  assert.equal(store.currentState.activeAction, 'Analyzing request');

  store.dispatch({ type: 'stage:transition', stage: 2 });
  assert.equal(store.currentState.activeAction, 'Planning');

  store.dispatch({ type: 'stage:transition', stage: 3 });
  assert.equal(store.currentState.activeAction, 'Reviewing');

  store.dispatch({ type: 'stage:transition', stage: 4 });
  assert.equal(store.currentState.activeAction, 'Applying changes');
});

test('pause/resume lifecycle through store', () => {
  const store = createStateStore(createInitialTuiState(), tuiStateReducer);

  store.dispatch({ type: 'pause:toggle', paused: true });
  assert.equal(store.currentState.paused, true);

  store.dispatch({ type: 'pause:toggle', paused: false });
  assert.equal(store.currentState.paused, false);
});

test('error followed by new start resets state correctly', () => {
  const store = createStateStore(createInitialTuiState(), tuiStateReducer);

  // Error occurs
  store.dispatch({ type: 'state:transition', to: 'thinking' });
  store.dispatch({ type: 'error', message: 'Network timeout' });
  assert.equal(store.currentState.renderState, 'failed');
  assert.equal(store.currentState.errorMessage, 'Network timeout');

  // New run starts — reset state
  store.setState(createInitialTuiState());
  store.dispatch({ type: 'state:transition', to: 'thinking' });
  assert.equal(store.currentState.renderState, 'thinking');
  assert.equal(store.currentState.errorMessage, '');
});
