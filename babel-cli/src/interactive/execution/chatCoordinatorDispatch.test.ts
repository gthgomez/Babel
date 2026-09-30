/**
 * P03 — CLI chat dispatch flows through the shared runtime facade.
 *
 * Proves `runChatEngineOnce` (the in-process path used by the CLI one-shot and
 * the REPL) begins/submits/settles the turn through the coordinator, and that
 * the compatibility switch selects the pre-P03 direct path when requested.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatEngine } from '../../agent/chatEngine.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import {
  createRuntimeCoordinator,
  RUNTIME_COORDINATOR_ENV,
} from '../../runtime/coordinator.js';
import type { RuntimeCoordinator } from '../../runtime/contracts.js';
import { runChatEngineOnce } from './chatCore.js';

const EMPTY_USAGE = globalCostTracker.getSessionSummary();

function makeTarget(root: string): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

function makeEngine(answer: string): ChatEngine {
  return {
    submitMessage: async () => ({
      status: 'completed' as const,
      answer,
      usage: EMPTY_USAGE,
      conversation: [],
    }),
    submitMessageStream: async function* () {
      yield { type: 'answer_chunk', text: answer };
      yield { type: 'done', answer, usage: EMPTY_USAGE };
    },
    cancel: () => undefined,
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

test('P03: CLI chat begins/submits/settles through the injected coordinator', async () => {
  const calls: string[] = [];
  const result = await runChatEngineOnce({
    task: 'cli coordinator task',
    target: makeTarget('/tmp/project'),
    engineFactory: () => makeEngine('cli answer'),
    useStreaming: true,
    preflightContext: '',
    coordinator: spyCoordinator(calls),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'cli answer');
  assert.deepEqual(calls, ['begin:chat', 'submit', 'settle']);
});

test('P03: compatibility switch selects the direct path for CLI chat', async () => {
  const previous = process.env[RUNTIME_COORDINATOR_ENV];
  process.env[RUNTIME_COORDINATOR_ENV] = 'legacy';
  const calls: string[] = [];
  try {
    const result = await runChatEngineOnce({
      task: 'legacy cli task',
      target: makeTarget('/tmp/project'),
      engineFactory: () => makeEngine('legacy answer'),
      useStreaming: true,
      preflightContext: '',
      coordinator: spyCoordinator(calls),
    });
    assert.equal(result.answer, 'legacy answer');
    assert.deepEqual(calls, [], 'legacy switch must not touch the coordinator');
  } finally {
    if (previous === undefined) delete process.env[RUNTIME_COORDINATOR_ENV];
    else process.env[RUNTIME_COORDINATOR_ENV] = previous;
  }
});
