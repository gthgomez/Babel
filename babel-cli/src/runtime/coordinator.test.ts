/**
 * P03 — runtime coordinator conformance.
 *
 * Proves the facade selects exactly one controller per turn, reuses P02
 * preparation, keeps ownership settlement stale-safe (P01 philosophy), never
 * silently substitutes Chat for Deep, and drives controllers through a
 * renderer-independent stream. No live model; deterministic subjects only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatEvent, TaskIntent } from '../agent/chatEngine.js';
import type { BabelMode, SessionDescriptor } from '../executor/contracts.js';
import {
  buildPreparedTurn,
  resolveModeCapability,
  type ModeCapability,
} from '../executor/modeAdapters.js';
import {
  createRuntimeCoordinator,
  isRuntimeCoordinatorEnabled,
  RUNTIME_COORDINATOR_ENV,
} from './coordinator.js';
import {
  RuntimeExecutionSettledError,
  RuntimeModeUnsupportedError,
  RuntimeTurnOwnedError,
  type RuntimeControllerSubject,
  type RuntimeModeAdapter,
  type RuntimeTurnRequest,
} from './contracts.js';
import { createDeepRuntimeAdapter } from './adapters/deep.js';

function descriptor(mode: BabelMode, threadId = 'thread-1'): SessionDescriptor {
  return {
    schemaVersion: 1,
    threadId,
    projectRoot: '/tmp/project',
    mode,
    provider: 'fixture-provider',
    model: 'fixture-model',
    policyProfile: 'safe_repo',
    createdAt: '2026-09-18T00:00:00.000Z',
    kernelVersion: 'executor-kernel-v1',
    contractVersion: 'executor-contract-v1',
    task: 'fixture task',
  };
}

class FakeSubject implements RuntimeControllerSubject {
  readonly events: ChatEvent[];
  cancels = 0;
  readonly calls: Array<{ task: string; intent?: TaskIntent }> = [];

  constructor(events: ChatEvent[] = [{ type: 'answer_chunk', text: 'ok' }]) {
    this.events = events;
  }

  async *submitMessageStream(task: string, intent?: TaskIntent): AsyncIterable<ChatEvent> {
    this.calls.push({ task, ...(intent !== undefined ? { intent } : {}) });
    for (const event of this.events) {
      yield event;
    }
  }

  cancel(): void {
    this.cancels += 1;
  }
}

function turn(
  mode: BabelMode,
  subject: FakeSubject,
  overrides: Partial<RuntimeTurnRequest> = {},
): RuntimeTurnRequest {
  return {
    prepared: buildPreparedTurn(descriptor(mode)),
    threadId: 'thread-1',
    turnId: '1',
    task: 'do the task',
    subject,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

test('P03: capabilities match P02 resolution for every mode', () => {
  const coordinator = createRuntimeCoordinator();
  for (const mode of ['chat', 'plan', 'deep'] as BabelMode[]) {
    assert.deepEqual(coordinator.capabilities(mode), resolveModeCapability(mode));
  }
});

test('P03: prepare reuses the P02 PreparedTurn contract', () => {
  const coordinator = createRuntimeCoordinator();
  const desc = descriptor('plan', 'thread-9');
  assert.deepEqual(coordinator.prepare(desc), buildPreparedTurn(desc));
});

test('P03: chat and plan bind the chat_engine controller; deep is explicit unsupported', () => {
  const coordinator = createRuntimeCoordinator();
  const chat = coordinator.beginTurn(turn('chat', new FakeSubject()));
  assert.equal(chat.mode, 'chat');
  assert.equal(chat.controller, 'chat_engine');

  const plan = coordinator.beginTurn(turn('plan', new FakeSubject(), { threadId: 'thread-2' }));
  assert.equal(plan.controller, 'chat_engine');

  assert.throws(
    () => coordinator.beginTurn(turn('deep', new FakeSubject(), { threadId: 'thread-3' })),
    (error: unknown) => error instanceof RuntimeModeUnsupportedError && error.mode === 'deep',
  );
});

test('P03: deep adapter refuses to run even if invoked directly (no Chat substitution)', async () => {
  const adapter = createDeepRuntimeAdapter();
  assert.equal(adapter.controller, 'v9_pipeline');
  assert.equal(adapter.capability.submission, false);
  const request = turn('deep', new FakeSubject());
  await assert.rejects(
    async () => {
      for await (const _event of adapter.submit(request)) {
        // unreachable — Deep must not stream Chat events
      }
    },
    (error: unknown) => error instanceof RuntimeModeUnsupportedError,
  );
});

test('P03: exactly one controller owns a turn on a thread', () => {
  const coordinator = createRuntimeCoordinator();
  coordinator.beginTurn(turn('chat', new FakeSubject()));
  assert.throws(
    () => coordinator.beginTurn(turn('chat', new FakeSubject(), { turnId: '2' })),
    (error: unknown) => error instanceof RuntimeTurnOwnedError,
  );
  assert.equal(coordinator.activeCount(), 1);
});

test('P03: a stale finalizer cannot release a successor owner', () => {
  const coordinator = createRuntimeCoordinator();
  const first = coordinator.beginTurn(turn('chat', new FakeSubject()));
  assert.equal(coordinator.settle(first), true);
  assert.equal(coordinator.activeCount(), 0);

  const second = coordinator.beginTurn(turn('chat', new FakeSubject(), { turnId: '2' }));
  assert.equal(coordinator.activeCount(), 1);
  assert.equal(
    coordinator.settle(first),
    false,
    'the settled predecessor must not clear the successor',
  );
  assert.equal(coordinator.activeCount(), 1);
  assert.equal(coordinator.settle(second), true);
});

test('P03: an execution handle is single-use', async () => {
  const coordinator = createRuntimeCoordinator();
  const execution = coordinator.beginTurn(turn('chat', new FakeSubject()));
  const stream = coordinator.submit(execution);
  await collect(stream);
  assert.throws(
    () => coordinator.submit(execution),
    (error: unknown) => error instanceof RuntimeExecutionSettledError,
  );
  coordinator.settle(execution);
});

test('P03: cancel is a request and does not release ownership', async () => {
  const subject = new FakeSubject();
  const coordinator = createRuntimeCoordinator();
  const execution = coordinator.beginTurn(turn('chat', subject));
  await coordinator.cancel(execution);
  assert.equal(subject.cancels, 1);
  assert.equal(coordinator.activeCount(), 1, 'cancel must not release ownership');
  coordinator.settle(execution);
});

test('P03: the coordinator stream equals the direct controller stream', async () => {
  const events: ChatEvent[] = [
    { type: 'thinking' },
    { type: 'tool_start', tool: 'file_read', target: 'a.ts' },
    { type: 'answer_chunk', text: 'done' },
  ];
  const task = 'trace-equivalent task';
  const directSubject = new FakeSubject(events);
  const direct = await collect(directSubject.submitMessageStream(task, 'execute'));

  const coordinatorSubject = new FakeSubject(events);
  const coordinator = createRuntimeCoordinator();
  const execution = coordinator.beginTurn(
    turn('chat', coordinatorSubject, { task, intent: 'execute' }),
  );
  const viaCoordinator = await collect(coordinator.submit(execution));
  coordinator.settle(execution);

  assert.deepEqual(viaCoordinator, direct);
  assert.deepEqual(coordinatorSubject.calls, directSubject.calls);
});

test('P03: threadless turns do not take thread ownership', () => {
  const coordinator = createRuntimeCoordinator();
  const a = coordinator.beginTurn(turn('chat', new FakeSubject(), { threadId: '' }));
  const b = coordinator.beginTurn(turn('chat', new FakeSubject(), { threadId: '' }));
  assert.notEqual(a.token, b.token);
  assert.equal(coordinator.activeCount(), 0);
});

test('P03: injected clock and id factory make identity deterministic', () => {
  let counter = 0;
  const coordinator = createRuntimeCoordinator({
    now: () => new Date('2026-09-18T12:34:56.000Z'),
    newId: () => `token-${++counter}`,
  });
  const execution = coordinator.beginTurn(turn('chat', new FakeSubject()));
  assert.equal(execution.token, 'token-1');
  assert.equal(execution.generation, 1);
  assert.equal(execution.startedAt, '2026-09-18T12:34:56.000Z');
});

test('P03: injected adapters are used for dispatch', async () => {
  const seen: string[] = [];
  const adapter: RuntimeModeAdapter = {
    mode: 'chat',
    controller: 'chat_engine',
    capability: { mode: 'chat', submission: true, resume: true, controller: 'chat_engine' },
    async *submit(request) {
      seen.push(request.task);
      yield { type: 'answer_chunk', text: 'injected' };
    },
    async cancel() {
      seen.push('cancel');
    },
  };
  const coordinator = createRuntimeCoordinator({ adapters: [adapter] });
  const execution = coordinator.beginTurn(turn('chat', new FakeSubject()));
  const emitted = await collect(coordinator.submit(execution));
  assert.deepEqual(seen, ['do the task']);
  assert.equal(emitted.length, 1);
});

test('P03: compatibility switch defaults on and disables on legacy values', () => {
  const cap: ModeCapability = resolveModeCapability('chat');
  assert.equal(cap.controller, 'chat_engine');
  assert.equal(isRuntimeCoordinatorEnabled({} as NodeJS.ProcessEnv), true);
  for (const value of ['0', 'false', 'off', 'legacy', 'LEGACY']) {
    assert.equal(
      isRuntimeCoordinatorEnabled({ [RUNTIME_COORDINATOR_ENV]: value } as NodeJS.ProcessEnv),
      false,
      `switch value ${value} must select the legacy adapter`,
    );
  }
  assert.equal(
    isRuntimeCoordinatorEnabled({ [RUNTIME_COORDINATOR_ENV]: 'on' } as NodeJS.ProcessEnv),
    true,
  );
});
