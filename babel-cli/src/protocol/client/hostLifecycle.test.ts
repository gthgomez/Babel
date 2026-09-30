/**
 * P01 — cancellation ownership and settlement conformance.
 *
 * These tests use only the public protocol host API. They reproduce the audited
 * P-02 race: `turn.cancel` released active ownership before the prior launch
 * settled, so a successor could be admitted and the stale finalizer could then
 * clear that successor's ownership.
 *
 * The deferred engine keeps its async generator pending until the test resolves
 * it, modelling asynchronous cancellation cleanup.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatEngine } from '../../agent/chatEngine.js';
import type { BabelProtocolServerNotification } from '../messages.js';
import { BabelProtocolErrorCode } from '../types.js';
import { createProtocolHostState, handleProtocolRequest } from './index.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-protocol-lifecycle-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = root;
  return {
    root,
    cleanup() {
      if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface PendingStep {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Engine whose run stays pending until the test explicitly settles it. */
class DeferredEngine {
  executions = 0;
  cancels = 0;
  private pending: PendingStep[] = [];

  assignRunId(_runId: string): void {
    /* identity only; no behaviour under test */
  }

  cancel(): void {
    this.cancels += 1;
  }

  async *submitMessageStream(_message: string): AsyncGenerator<unknown> {
    this.executions += 1;
    await new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
    yield { type: 'done', answer: 'ok', usage: {} };
  }

  settleNext(): void {
    this.pending.shift()?.resolve();
  }

  failNext(error: Error): void {
    this.pending.shift()?.reject(error);
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

async function flushUntil(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface Harness {
  state: ReturnType<typeof createProtocolHostState>;
  engine: DeferredEngine;
  threadId: string;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const fixture = withTempRunsDir();
  const engine = new DeferredEngine();
  const state = createProtocolHostState({
    engineFactory: () => engine as unknown as ChatEngine,
    executeWithoutNotifications: true,
  });
  const created = await handleProtocolRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'thread.create',
      params: { project_root: fixture.root, task: 'lifecycle test' },
    },
    state,
  );
  assert.ok('result' in created, 'thread.create must succeed');
  const threadId = (created as { result: { thread_id: string } }).result.thread_id;
  return { state, engine, threadId, cleanup: fixture.cleanup };
}

function submit(
  harness: Harness,
  message: string,
  onNotification?: (notification: BabelProtocolServerNotification) => void,
) {
  return handleProtocolRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'turn.submit',
      params: { thread_id: harness.threadId, message },
    },
    harness.state,
    onNotification,
  );
}

function cancel(harness: Harness) {
  return handleProtocolRequest(
    { jsonrpc: '2.0', id: 3, method: 'turn.cancel', params: { thread_id: harness.threadId } },
    harness.state,
  );
}

function errorCode(response: Awaited<ReturnType<typeof submit>>): number | undefined {
  return 'error' in response ? response.error.code : undefined;
}

function turnId(response: Awaited<ReturnType<typeof submit>>): number | undefined {
  return 'result' in response ? (response.result as { turn_id: number }).turn_id : undefined;
}

test('P01: cancellation does not admit overlapping replacement execution', async () => {
  const harness = await makeHarness();
  try {
    const first = await submit(harness, 'first');
    assert.equal(errorCode(first), undefined);
    assert.equal(harness.engine.executions, 1);

    const cancelled = await cancel(harness);
    assert.equal((cancelled as { result: { cancelled: boolean } }).result.cancelled, true);

    // Prior launch is still settling: a successor must not be admitted.
    const second = await submit(harness, 'second');
    assert.equal(errorCode(second), BabelProtocolErrorCode.TURN_IN_PROGRESS);
    assert.equal(harness.engine.executions, 1, 'no overlapping replacement execution');
  } finally {
    harness.cleanup();
  }
});

test('P01: repeated cancel is idempotent and does not release ownership', async () => {
  const harness = await makeHarness();
  try {
    await submit(harness, 'first');
    const firstCancel = await cancel(harness);
    assert.equal((firstCancel as { result: { cancelled: boolean } }).result.cancelled, true);

    const secondCancel = await cancel(harness);
    assert.equal(
      (secondCancel as { result: { cancelled: boolean } }).result.cancelled,
      true,
      'second cancel must return a stable acknowledgement',
    );
    assert.equal(harness.engine.cancels, 1, 'engine.cancel must not be duplicated');
    assert.equal(harness.state.activeTurns.has(harness.threadId), true);
  } finally {
    harness.cleanup();
  }
});

test('P01: ownership is released only when the launch actually settles', async () => {
  const harness = await makeHarness();
  try {
    const submitted = await submit(harness, 'first');
    assert.equal(errorCode(submitted), undefined);
    await cancel(harness);
    assert.equal(
      harness.state.activeTurns.has(harness.threadId),
      true,
      'cancel must not release ownership before settlement',
    );

    harness.engine.settleNext();
    await flushUntil(() => !harness.state.activeTurns.has(harness.threadId));
    assert.equal(harness.state.activeTurns.has(harness.threadId), false);

    const next = await submit(harness, 'second');
    assert.equal(errorCode(next), undefined, 'new submit works after actual settlement');
    // Turn id monotonicity depends on committed cells; the deferred stub does not
    // commit terminal cells, so admission (not the numeric id) is the assertion.
    assert.equal(typeof turnId(next), 'number');
    assert.equal(harness.state.activeTurns.has(harness.threadId), true);
  } finally {
    harness.cleanup();
  }
});

test('P01: disconnect does not release ownership', async () => {
  const harness = await makeHarness();
  const disconnected = () => {
    throw new Error('client disconnected');
  };
  try {
    await submit(harness, 'first', disconnected);
    await cancel(harness);
    assert.equal(
      harness.state.activeTurns.has(harness.threadId),
      true,
      'a throwing notification must not release ownership',
    );

    harness.engine.settleNext();
    await flushUntil(() => !harness.state.activeTurns.has(harness.threadId));
    assert.equal(harness.state.activeTurns.has(harness.threadId), false);
  } finally {
    harness.cleanup();
  }
});

test('P01: thrown terminal path releases its own ownership', async () => {
  const harness = await makeHarness();
  try {
    await submit(harness, 'first');
    assert.equal(harness.engine.executions, 1);
    harness.engine.failNext(new Error('engine failure'));
    await flushUntil(() => !harness.state.activeTurns.has(harness.threadId));
    assert.equal(harness.state.activeTurns.has(harness.threadId), false);
  } finally {
    harness.cleanup();
  }
});

test('P01: successful terminal path leaves no ghost active entry', async () => {
  const harness = await makeHarness();
  try {
    await submit(harness, 'first');
    harness.engine.settleNext();
    await flushUntil(() => !harness.state.activeTurns.has(harness.threadId));
    assert.equal(harness.state.activeTurns.has(harness.threadId), false);
    await flushUntil(() => harness.engine.pendingCount === 0);
  } finally {
    harness.cleanup();
  }
});

test('P01: cancelling a settling launch still cancels pending remote approvals', async () => {
  const harness = await makeHarness();
  const cancelCalls: Array<{ threadId: string; turnId: string }> = [];
  harness.state.approvalBroker.cancelTurn = ((threadId: string, turnId: string) => {
    cancelCalls.push({ threadId, turnId });
  }) as typeof harness.state.approvalBroker.cancelTurn;
  try {
    const submitted = await submit(harness, 'first');
    const activeTurn = turnId(submitted);
    const firstCancel = await cancel(harness);
    assert.equal((firstCancel as { result: { cancelled: boolean } }).result.cancelled, true);
    assert.equal(cancelCalls.length, 1, 'approval cancellation must happen on cancel');
    assert.equal(cancelCalls[0]?.threadId, harness.threadId);
    assert.equal(cancelCalls[0]?.turnId, String(activeTurn));

    const secondCancel = await cancel(harness);
    assert.equal((secondCancel as { result: { cancelled: boolean } }).result.cancelled, true);
    assert.equal(cancelCalls.length, 1, 'approval cancellation is idempotent');
  } finally {
    harness.cleanup();
  }
});

test('P01: an admitted launch with no runner is released by cancel (no permanent wedge)', async () => {
  const fixture = withTempRunsDir();
  const engine = new DeferredEngine();
  // No notification callback and no executeWithoutNotifications: the host admits
  // the turn but schedules no runner, so it can never settle on its own.
  const state = createProtocolHostState({
    engineFactory: () => engine as unknown as ChatEngine,
  });
  try {
    const created = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: { project_root: fixture.root, task: 'unscheduled' },
      },
      state,
    );
    const threadId = (created as { result: { thread_id: string } }).result.thread_id;

    const first = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 2, method: 'turn.submit', params: { thread_id: threadId, message: 'first' } },
      state,
    );
    assert.equal('result' in first, true);
    assert.equal(state.activeTurns.has(threadId), true);

    const cancelled = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 3, method: 'turn.cancel', params: { thread_id: threadId } },
      state,
    );
    assert.equal((cancelled as { result: { cancelled: boolean } }).result.cancelled, true);
    assert.equal(state.activeTurns.has(threadId), false, 'never-scheduled launch must be released');

    const second = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 4, method: 'turn.submit', params: { thread_id: threadId, message: 'second' } },
      state,
    );
    assert.equal('result' in second, true, 'thread must not be permanently wedged');
    assert.equal(engine.executions, 0, 'no runner was ever scheduled');
  } finally {
    fixture.cleanup();
  }
});
