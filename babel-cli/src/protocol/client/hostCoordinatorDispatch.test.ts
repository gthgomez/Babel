/**
 * P03 — protocol dispatch flows through the shared runtime facade.
 *
 * Proves `turn.submit` on the protocol host begins/submits/settles the turn
 * through the coordinator, and that the compatibility switch retains the
 * pre-P03 direct adapter.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ChatEngine } from '../../agent/chatEngine.js';
import { globalCostTracker } from '../../services/costTracker.js';
import {
  createRuntimeCoordinator,
  RUNTIME_COORDINATOR_ENV,
} from '../../runtime/coordinator.js';
import type { RuntimeCoordinator } from '../../runtime/contracts.js';
import { createProtocolHostState, handleProtocolRequest } from './index.js';

const EMPTY_USAGE = globalCostTracker.getSessionSummary();

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-protocol-coord-'));
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

function makeEngine(): ChatEngine {
  return {
    assignRunId: () => undefined,
    cancel: () => undefined,
    submitMessageStream: async function* () {
      yield { type: 'answer_chunk', text: 'protocol answer' };
      yield { type: 'done', answer: 'protocol answer', usage: EMPTY_USAGE };
    },
  } as unknown as ChatEngine;
}

function spyCoordinator(calls: string[]): RuntimeCoordinator {
  const real = createRuntimeCoordinator();
  return {
    ...real,
    beginTurn: (request) => {
      calls.push(`begin:${request.prepared.mode}`);
      return real.beginTurn(request);
    },
    submit: (execution) => {
      calls.push('submit');
      return real.submit(execution);
    },
    cancel: async (execution) => {
      calls.push('cancel');
      await real.cancel(execution);
    },
    settle: (execution) => {
      calls.push('settle');
      return real.settle(execution);
    },
  };
}

async function flushUntil(predicate: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('P03: protocol turn.submit dispatches through the injected coordinator', async () => {
  const fixture = withTempRunsDir();
  const calls: string[] = [];
  try {
    const state = createProtocolHostState({
      engineFactory: () => makeEngine(),
      executeWithoutNotifications: true,
      coordinator: spyCoordinator(calls),
    });
    const created = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: { project_root: fixture.root, task: 'coordinator protocol' },
      },
      state,
    );
    assert.ok('result' in created);
    const threadId = (created as { result: { thread_id: string } }).result.thread_id;

    const submitted = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'turn.submit',
        params: { thread_id: threadId, message: 'run it' },
      },
      state,
    );
    assert.ok('result' in submitted);

    await flushUntil(() => calls.includes('settle'));
    assert.deepEqual(calls, ['begin:chat', 'submit', 'settle']);
    assert.equal(state.activeTurns.has(threadId), false);
  } finally {
    fixture.cleanup();
  }
});

test('P03: compatibility switch retains the direct protocol adapter', async () => {
  const fixture = withTempRunsDir();
  const previous = process.env[RUNTIME_COORDINATOR_ENV];
  process.env[RUNTIME_COORDINATOR_ENV] = 'legacy';
  const calls: string[] = [];
  try {
    const state = createProtocolHostState({
      engineFactory: () => makeEngine(),
      executeWithoutNotifications: true,
      coordinator: spyCoordinator(calls),
    });
    const created = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: { project_root: fixture.root, task: 'legacy protocol' },
      },
      state,
    );
    const threadId = (created as { result: { thread_id: string } }).result.thread_id;
    const submitted = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'turn.submit',
        params: { thread_id: threadId, message: 'run legacy' },
      },
      state,
    );
    assert.ok('result' in submitted);
    await flushUntil(() => !state.activeTurns.has(threadId));
    assert.deepEqual(calls, [], 'legacy switch must not touch the coordinator');
  } finally {
    if (previous === undefined) delete process.env[RUNTIME_COORDINATOR_ENV];
    else process.env[RUNTIME_COORDINATOR_ENV] = previous;
    fixture.cleanup();
  }
});
