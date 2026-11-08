import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolExecutor, ToolExecutionCancelledError, ToolExecutionTimeoutError, withTimeout } from './toolExecutor.js';
import { ProcessTerminationError, registerPendingProcessTermination } from '../sandbox.js';
import { isOperatorAbortError } from './operatorAbort.js';

test('cancellation retains tool ownership until the underlying work physically settles', async () => {
  const controller = new AbortController();
  let release!: () => void;
  let aborts = 0;
  let settled = false;
  const work = new Promise<void>(resolve => { release = resolve; });
  const outcome = withTimeout(work, 10_000, 'synthetic_tool', controller.signal, () => { aborts++; })
    .then(() => { settled = true; return null; }, error => { settled = true; return error; });
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborts, 1);
  assert.equal(settled, false, 'the owner must wait for physical settlement');
  release();
  const error = await outcome;
  assert.ok(error instanceof ToolExecutionCancelledError);
  assert.equal(isOperatorAbortError(error), true);
});

test('tool executor retains its invocation until a cancelled handler settles', async () => {
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const work = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  const executor = createToolExecutor({ executeTool: async () => { started(); await work; return { exit_code: 0, stdout: 'late', stderr: '' }; } });
  const outcome = executor.execute({ type: 'read_file', path: 'fixture.txt' }, { agentId: 'fixture', runId: 'fixture', babelRoot: process.cwd(), signal: controller.signal }, { perToolTimeoutMs: 10_000, maxIterations: 1 })
    .then(() => { finished = true; return null; }, error => { finished = true; return error; });
  await entered;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  assert.ok(await outcome instanceof ToolExecutionCancelledError);
});

test('a local deadline is not reported as settled while the handler is still running', async () => {
  let release!: () => void;
  let aborted!: () => void;
  const abortObserved = new Promise<void>(resolve => { aborted = resolve; });
  const work = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const outcome = withTimeout(work, 10, 'synthetic_tool', undefined, () => aborted())
    .then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await abortObserved;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  assert.ok(await outcome instanceof ToolExecutionTimeoutError);
});

test('an already-aborted signal waits for an already-started promise to settle', async () => {
  const controller = new AbortController(); controller.abort();
  let release!: () => void;
  const work = new Promise<void>(resolve => { release = resolve; });
  let settled = false; let aborted = 0;
  const outcome = withTimeout(work, 10_000, 'synthetic_tool', controller.signal, () => { aborted++; })
    .then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, 1);
  assert.equal(settled, false);
  release();
  assert.ok(await outcome instanceof ToolExecutionCancelledError);
});

test('cancellation fences a late handler result even without a timeout budget', async () => {
  const controller = new AbortController();
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const work = new Promise<void>(resolve => { release = resolve; });
  const executor = createToolExecutor({ executeTool: async () => { started(); await work; return { exit_code: 0, stdout: 'late', stderr: '' }; } });
  const outcome = executor.execute({ type: 'read_file', path: 'fixture.txt' }, { agentId: 'fixture', runId: 'fixture', babelRoot: process.cwd(), signal: controller.signal })
    .then(() => null, error => error);
  await entered; controller.abort(); release();
  assert.ok(await outcome instanceof ToolExecutionCancelledError);
});

test('tool executor waits for its own deferred process-tree termination', async () => {
  const controller = new AbortController();
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const termination = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  const executor = createToolExecutor({ executeTool: async (_request, context) => new Promise(resolve => {
    context.signal?.addEventListener('abort', () => {
      registerPendingProcessTermination(termination, context.sessionId ?? context.runId, 'synthetic-child');
      resolve({ exit_code: 1, stdout: '', stderr: 'cancelled' });
    }, { once: true });
    started();
  }) });
  const outcome = executor.execute({ type: 'run_command', command: 'synthetic' }, { agentId: 'fixture', runId: 'owner-fixture', babelRoot: process.cwd(), signal: controller.signal }, { perToolTimeoutMs: 10_000, maxIterations: 1 })
    .then(() => { finished = true; return null; }, error => { finished = true; return error; });
  await entered; controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(finished, false, 'owner must wait for deferred process termination'); }
  finally { release(); }
  assert.ok(await outcome instanceof ToolExecutionCancelledError);
});

test('a failed process-tree termination remains an explicit failure', async () => {
  const controller = new AbortController();
  let fail!: (error: Error) => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const termination = new Promise<void>((_resolve, reject) => { fail = reject; });
  const executor = createToolExecutor({ executeTool: async (_request, context) => new Promise(resolve => {
    context.signal?.addEventListener('abort', () => {
      registerPendingProcessTermination(termination, context.sessionId ?? context.runId, 'synthetic-child-failure');
      resolve({ exit_code: 1, stdout: '', stderr: 'cancelled' });
    }, { once: true });
    started();
  }) });
  const outcome = executor.execute({ type: 'run_command', command: 'synthetic' }, { agentId: 'fixture', runId: 'owner-failure', babelRoot: process.cwd(), signal: controller.signal }, { perToolTimeoutMs: 10_000, maxIterations: 1 }).then(() => null, error => error);
  await entered; controller.abort(); fail(new Error('synthetic termination failure'));
  assert.ok(await outcome instanceof ProcessTerminationError);
});
