import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Duplex } from 'node:stream';
import test, { after, before } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import { requestChatActionApproval } from '../agent/chatApproval.js';
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from '../config/benchmarkContainer.js';
import { SafeExecutor } from '../sandbox.js';
import { createProtocolHostState } from './client/host.js';

type Packet = Record<string, any>;

const priorOperatorApproval = process.env['BABEL_REMOTE_OPERATOR_APPROVAL'];
const priorDesktopProvider = process.env['BABEL_DESKTOP_PROVIDER'];
before(() => { process.env['BABEL_REMOTE_OPERATOR_APPROVAL'] = '1'; process.env['BABEL_DESKTOP_PROVIDER'] = 'ollama'; });
after(() => {
  if (priorOperatorApproval === undefined) delete process.env['BABEL_REMOTE_OPERATOR_APPROVAL'];
  else process.env['BABEL_REMOTE_OPERATOR_APPROVAL'] = priorOperatorApproval;
  if (priorDesktopProvider === undefined) delete process.env['BABEL_DESKTOP_PROVIDER'];
  else process.env['BABEL_DESKTOP_PROVIDER'] = priorDesktopProvider;
});

class PipeClient {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly packets: Packet[] = [];
  private buffer = '';

  constructor() {
    this.output.setEncoding('utf8');
    this.output.on('data', (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.packets.push(JSON.parse(line) as Packet);
      }
    });
  }

  send(id: number, method: string, params: Record<string, unknown>): void {
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  }

  async take(predicate: (packet: Packet) => boolean): Promise<Packet> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const index = this.packets.findIndex(predicate);
      if (index !== -1) return this.packets.splice(index, 1)[0]!;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for private worker packet');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async request(id: number, method: string, params: Record<string, unknown>): Promise<Packet> {
    this.send(id, method, params);
    return this.take((packet) => packet.id === id);
  }
}

function stubProvider(engine: ChatEngine): void {
  const runner = {
    executeWithToolsStream: async function* () {
      yield { type: 'text_delta' as const, text: 'Hello from the fixture.' };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    executeRawStream: async function* () { yield 'Hello from the fixture.'; },
    executeRaw: async () => 'Hello from the fixture.',
    execute: async () => ({ type: 'completion', answer: 'Hello from the fixture.' }),
    getLastInvocationMetadata: () => null,
  };
  const box = engine as unknown as Record<string, unknown>;
  box['deliberationRunner'] = runner;
  box['shouldUseNativeTools'] = () => true;
}

async function loadWorker() {
  try {
    return await import('./privateWorker.js');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('The private protocol worker must exist and own a reusable host.');
    }
    throw error;
  }
}

test('private worker retains one real ChatEngine per thread for ten turns', async () => {
  const { startPrivateWorker } = await loadWorker();
  const root = mkdtempSync(join(tmpdir(), 'babel-private-worker-'));
  const oldRuns = process.env['BABEL_RUNS_DIR'];
  const oldProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const oldCost = process.env['BABEL_CHAT_MAX_COST'];
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited';
  process.env['BABEL_DESKTOP_PROVIDER'] = 'openrouter';
  const client = new PipeClient();
  const instances: ChatEngine[] = [];
  const worker = startPrivateWorker({ input: client.input, output: client.output,
    onEngineCreated(_descriptor, engine) {
      stubProvider(engine);
      instances.push(engine);
    },
  });
  try {
    const initialized = await client.request(1, 'worker.initialize', {
      protocol_version: 1,
      authority: {
        project_root: root,
        mode: 'chat',
        execution_profile: 'safe_repo',
        approval_policy: 'allow_once',
        provider: 'openrouter',
        model: 'deepseek-v4-flash-openrouter',
        provider_model_id: 'deepseek/deepseek-v4-flash-0731',
        credential_ref: 'local-fixture',
        configuration_generation: 'fixture-v1',
        engine_generation: 'fixture-v1',
      },
    });
    assert.ok(initialized.result, 'worker handshake must succeed');
    assert.ok((await client.request(2, 'worker.credentials', { values: { OPENROUTER_API_KEY: 'synthetic-test-cred' } })).result);

    const created = await client.request(3, 'thread.create', { task: 'hello' });
    assert.ok(created.result, 'thread creation must succeed');
    const firstId = created.result.thread_id as string;
    for (let turn = 1; turn <= 10; turn += 1) {
      const submitted = await client.request(10 + turn, 'turn.submit', {
        thread_id: firstId, message: 'hello', command_id: `first-${turn}`,
      });
      assert.ok(submitted.result, `turn ${turn} must be admitted`);
      const turnId = submitted.result.turn_id;
      const completed = await client.take((packet) => packet.method === 'cell.committed'
        && packet.params.thread_id === firstId && packet.params.turn_id === turnId);
      assert.equal(completed.params.thread_id, firstId);
      const terminal = await client.take((packet) => packet.method === 'turn.event'
        && packet.params.thread_id === firstId && packet.params.turn_id === turnId
        && ['done', 'failed', 'cancelled'].includes(packet.params.event.type));
      assert.equal(terminal.params.event.type, 'done');
      assert.equal(instances.length, 1, 'each turn must reuse the existing engine instance');
    }
    assert.equal(instances.length, 1, 'ten turns must not construct ten engines');
    assert.equal(instances[0]!.getProviderSelectionStatus().provider, 'openrouter');
    assert.equal(instances[0]!.getProviderSelectionStatus().requestedModel, 'deepseek/deepseek-v4-flash-0731');
    assert.ok(instances[0]!.getConversation().filter((item) => item.role === 'user').length >= 10,
      'the reused engine must keep the earlier conversation');

    const second = await client.request(30, 'thread.create', { task: 'hello' });
    const secondId = second.result.thread_id as string;
    const submitted = await client.request(31, 'turn.submit', {
      thread_id: secondId, message: 'hello', command_id: 'second-1',
    });
    assert.ok(submitted.result);
    await client.take((packet) => packet.method === 'cell.committed'
      && packet.params.thread_id === secondId && packet.params.turn_id === submitted.result.turn_id);
    assert.equal(instances.length, 2);
    assert.notEqual(instances[0], instances[1]);
    assert.ok(instances[1]!.getConversation().filter((item) => item.role === 'user').length < 10,
      'a second thread must not inherit the first thread conversation');
    await client.take((packet) => packet.method === 'turn.event' && packet.params.thread_id === secondId && packet.params.turn_id === submitted.result.turn_id && ['done','failed','cancelled'].includes(packet.params.event.type));
    instances[1]!.markPhysicalSettlementUnknown();
    try {
      const refusedRelease=await client.request(35,'worker.thread_release',{thread_id:secondId});
      assert.match(String(refusedRelease.error?.message),/physical settlement.*unknown/i);
    } finally {
      (instances[1] as unknown as {physicalSettlementUnknown:boolean}).physicalSettlementUnknown=false;
    }

    assert.ok((await client.request(32, 'worker.thread_release', { thread_id: firstId })).result);
    assert.ok((await client.request(33, 'thread.resume', { thread_id: firstId })).result);
    const afterEviction = await client.request(34, 'turn.submit', {
      thread_id: firstId, message: 'hello', command_id: 'first-after-eviction',
    });
    assert.ok(afterEviction.result, `evicted thread submission failed: ${JSON.stringify(afterEviction.error)}`);
    await client.take((packet) => packet.method === 'cell.committed'
      && packet.params.thread_id === firstId && packet.params.turn_id === afterEviction.result.turn_id);
    assert.equal(instances.length, 3, 'evicting a thread must construct a new engine');
    assert.notEqual(instances[2], instances[0]);
    assert.ok(instances[2]!.getConversation().filter((item) => item.role === 'user').length >= 10,
      'the replacement engine must recover the prior conversation');
    assert.ok((await client.request(40, 'worker.shutdown', {})).result);
    await worker.closed;
  } finally {
    client.input.destroy();
    client.output.destroy();
    await worker.close();
    process.env['BABEL_DESKTOP_PROVIDER'] = 'ollama';
    for (const [key, value] of [['BABEL_RUNS_DIR', oldRuns], ['BABEL_EXECUTION_PROFILE', oldProfile],
      ['BABEL_CHAT_MAX_COST', oldCost]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const EMPTY_USAGE = {
  totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, modelBreakdown: {},
};

function authority(root: string) {
  return {
    project_root: root, mode: 'chat', execution_profile: 'safe_repo', approval_policy: 'allow_once',
    provider: 'ollama', model: 'fixture-model', provider_model_id: 'fixture-model', credential_ref: 'local-fixture',
    configuration_generation: 'fixture-v1', engine_generation: 'fixture-v1',
  };
}

function fakeHost(execute: (engine: ChatEngine) => void) {
  return createProtocolHostState({
    remoteSurface: true,
    engineFactory(descriptor) {
      const engine = new ChatEngine({ inferenceOwner: 'external-harness', task: 'fixture',
        projectRoot: descriptor.projectRoot, executionProfile: 'chat' });
      engine.assignRunId(descriptor.threadId);
      engine.getProviderSelectionStatus = () => ({ provider: descriptor.provider, connection: null,
        requestedModel: 'fixture-model', sentModel: null, observedModel: null });
      execute(engine);
      return engine;
    },
  });
}

test('private worker fences authority, thread ownership, and replay across workers', async () => {
  const { startPrivateWorker } = await loadWorker();
  const root = mkdtempSync(join(tmpdir(), 'babel-private-authority-'));
  const oldRuns = process.env['BABEL_RUNS_DIR'];
  const oldProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  let executions = 0;
  const makeHost = () => fakeHost((engine) => {
    engine.submitMessageStream = async function* () {
      executions += 1;
      yield { type: 'done', answer: 'ok', usage: EMPTY_USAGE };
    } as ChatEngine['submitMessageStream'];
  });
  const first = new PipeClient();
  const second = new PipeClient();
  const worker1 = startPrivateWorker({ input: first.input, output: first.output, host: makeHost() });
  const worker2 = startPrivateWorker({ input: second.input, output: second.output, host: makeHost() });
  try {
    assert.ok((await first.request(1, 'worker.initialize', { protocol_version: 1,
      authority: { ...authority(root), mode: 'deep' } })).error);
    assert.ok((await first.request(2, 'worker.initialize', { protocol_version: 1,
      authority: { ...authority(root), execution_profile: 'host_native' } })).error);
    assert.ok((await first.request(3, 'worker.initialize', { protocol_version: 1, authority: authority(root) })).result);
    assert.ok((await first.request(31, 'worker.credentials', { values: { OPENROUTER_API_KEY: 'synthetic-fixture-value' } })).error,
      'a key for another provider must not be accepted');
    assert.ok((await first.request(4, 'worker.credentials', { values: {} })).result);
    assert.ok((await first.request(5, 'thread.create', { project_root: 'untrusted', task: 'fixture' })).error);
    const created = await first.request(6, 'thread.create', { task: 'fixture' });
    const thread = created.result.thread_id as string;
    assert.ok((await second.request(1, 'worker.initialize', { protocol_version: 1, authority: authority(root) })).result);
    assert.ok((await second.request(2, 'worker.credentials', { values: {} })).result);
    assert.ok((await second.request(3, 'thread.resume', { thread_id: thread })).error,
      'a second worker must not acquire a thread while its first owner is live');

    process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
    assert.equal((await first.request(7, 'turn.submit', { thread_id: thread, message: 'hello', command_id: 'one' })).error.code, -32021);
    process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
    const submitted = await first.request(8, 'turn.submit', { thread_id: thread, message: 'hello', command_id: 'one' });
    assert.ok(submitted.result);
    await first.take((packet) => packet.method === 'cell.committed' && packet.params.thread_id === thread);
    const replay = await first.request(9, 'turn.submit', { thread_id: thread, message: 'hello', command_id: 'one' });
    assert.equal(replay.result.turn_id, submitted.result.turn_id);
    assert.equal(replay.result.replayed, true);
    assert.equal(executions, 1);
    assert.ok((await first.request(10, 'turn.submit', { thread_id: thread, message: 'different', command_id: 'one' })).error);
    assert.ok((await first.request(11, 'worker.thread_release', { thread_id: thread })).result);
    assert.ok((await second.request(4, 'thread.resume', { thread_id: thread })).result);
    const replayAfterHandoff = await second.request(5, 'turn.submit', { thread_id: thread, message: 'hello', command_id: 'one' });
    assert.equal(replayAfterHandoff.result.turn_id, submitted.result.turn_id);
    assert.equal(executions, 1, 'reconnect must not replay an already admitted effect');
    assert.ok((await second.request(6, 'worker.thread_release', { thread_id: thread })).result);
    for (const changed of [{ model: 'another-model' }, { credential_ref: 'another-reference' },
      { configuration_generation: 'another-configuration' }]) {
      const other = new PipeClient();
      const otherWorker = startPrivateWorker({ input: other.input, output: other.output, host: makeHost() });
      try {
        assert.ok((await other.request(1, 'worker.initialize', { protocol_version: 1,
          authority: { ...authority(root), ...changed } })).result);
        assert.ok((await other.request(2, 'worker.credentials', { values: {} })).result);
        assert.ok((await other.request(3, 'thread.resume', { thread_id: thread })).error,
          'a changed model, credential reference, or configuration must not inherit the thread');
      } finally {
        other.input.destroy(); await otherWorker.close(); other.output.destroy();
      }
    }
  } finally {
    first.input.destroy(); second.input.destroy();
    await Promise.all([worker1.close(), worker2.close()]);
    first.output.destroy(); second.output.destroy();
    if (oldRuns === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = oldRuns;
    if (oldProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = oldProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancellation rejects a late approval and preserves terminal evidence', async () => {
  const { startPrivateWorker } = await loadWorker();
  const root = mkdtempSync(join(tmpdir(), 'babel-private-cancel-'));
  const oldRuns = process.env['BABEL_RUNS_DIR'];
  const oldProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  const client = new PipeClient();
  const host = fakeHost((engine) => {
    engine.submitMessageStream = async function* () {
      const allowed = await requestChatActionApproval({ type: 'write_file', path: 'fixture.txt', content: 'fixture' });
      yield allowed ? { type: 'done', answer: 'approved', usage: EMPTY_USAGE }
        : { type: 'cancelled', status: 'cancelled', outcome: 'CANCELLED' };
    } as ChatEngine['submitMessageStream'];
  });
  const worker = startPrivateWorker({ input: client.input, output: client.output, host });
  try {
    assert.ok((await client.request(1, 'worker.initialize', { protocol_version: 1, authority: authority(root) })).result);
    assert.ok((await client.request(2, 'worker.credentials', { values: {} })).result);
    const thread = (await client.request(3, 'thread.create', { task: 'fixture' })).result.thread_id as string;
    const submitted = await client.request(4, 'turn.submit', { thread_id: thread, message: 'hello', command_id: 'cancel' });
    const approval = await client.take((packet) => packet.method === 'permission.request');
    const details = approval.params;
    const cancel = await client.request(5, 'turn.cancel', { thread_id: thread });
    assert.equal(cancel.result.cancelled, true);
    const terminal = await client.take((packet) => packet.method === 'turn.event' && packet.params.event.type === 'cancelled');
    assert.equal(terminal.params.turn_id, submitted.result.turn_id);
    await client.take((packet) => packet.method === 'cell.committed' && packet.params.thread_id === thread);
    const late = await client.request(6, 'approval.decide', { thread_id: thread, turn_id: details.turn_id,
      approval_id: details.approval_id, operation_digest: details.operation_digest, decision: 'allow_once' });
    assert.ok(late.error, 'an approval from a cancelled turn must never become executable');
    const durable = await client.request(7, 'worker.turn_terminal', { thread_id: thread, turn_id: submitted.result.turn_id });
    assert.equal(durable.result.terminal.event_type, 'cancelled');
  } finally {
    client.input.destroy();
    await worker.close();
    client.output.destroy();
    if (oldRuns === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = oldRuns;
    if (oldProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = oldProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test('large output retains approval, terminal and durable reconciliation', async () => {
  const { startPrivateWorker } = await loadWorker();
  const root = mkdtempSync(join(tmpdir(), 'babel-private-output-'));
  const oldRuns = process.env['BABEL_RUNS_DIR'];
  const oldProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  const client = new PipeClient();
  const host = fakeHost((engine) => {
    engine.submitMessageStream = async function* () {
      for (let i = 0; i < 26; i += 1) yield { type: 'answer_chunk', text: 'x'.repeat(1024 * 1024) };
      const allowed = await requestChatActionApproval({ type: 'write_file', path: 'fixture.txt', content: 'fixture' });
      yield allowed ? { type: 'done', answer: 'approved', usage: EMPTY_USAGE }
        : { type: 'failed', error: 'denied' };
    } as ChatEngine['submitMessageStream'];
  });
  const worker = startPrivateWorker({ input: client.input, output: client.output, host });
  try {
    assert.ok((await client.request(1, 'worker.initialize', { protocol_version: 1, authority: authority(root) })).result);
    assert.ok((await client.request(2, 'worker.credentials', { values: {} })).result);
    const thread = (await client.request(3, 'thread.create', { task: 'fixture' })).result.thread_id as string;
    const submitted = await client.request(4, 'turn.submit', { thread_id: thread, message: 'hello', command_id: 'large' });
    assert.ok(submitted.result);
    const truncated = await client.take((packet) => packet.method === 'worker.preview_truncated');
    assert.equal(truncated.params.thread_id, thread);
    const approval = await client.take((packet) => packet.method === 'permission.request');
    const details = approval.params;
    assert.ok((await client.request(5, 'approval.decide', { thread_id: thread, turn_id: details.turn_id,
      approval_id: details.approval_id, operation_digest: details.operation_digest, decision: 'allow_once' })).result);
    const terminal = await client.take((packet) => packet.method === 'turn.event' && packet.params.event.type === 'done');
    assert.equal(terminal.params.event.answer, 'approved');
    await client.take((packet) => packet.method === 'cell.committed' && packet.params.thread_id === thread);
    const durable = await client.request(6, 'worker.turn_terminal', { thread_id: thread, turn_id: submitted.result.turn_id });
    assert.equal(durable.result.status, 'durable');
    assert.equal(durable.result.terminal.answer, 'approved');
  } finally {
    client.input.destroy();
    await worker.close();
    client.output.destroy();
    if (oldRuns === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = oldRuns;
    if (oldProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = oldProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test('private entry communicates over inherited descriptors without CLI bootstrap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-private-entry-'));
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env['HOME'] = root;
  env['USERPROFILE'] = root;
  env['BABEL_RUNS_DIR'] = join(root, 'runs');
  env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  env['BABEL_REMOTE_OPERATOR_APPROVAL'] = '1';
  env['BABEL_DESKTOP_PROVIDER'] = 'ollama';
  const child = spawn(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--import', './src/testinfra/register-no-ambient-inference.mjs',
    'src/protocol/privateWorkerMain.ts'], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const input = child.stdio[3] as Duplex;
  const output = child.stdio[4] as Duplex;
  const packets: Packet[] = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      packets.push(JSON.parse(buffer.slice(0, end)) as Packet);
      buffer = buffer.slice(end + 1);
    }
  });
  const waitFor = async (id: number): Promise<Packet> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const index = packets.findIndex((packet) => packet.id === id);
      if (index >= 0) return packets.splice(index, 1)[0]!;
      if (child.exitCode !== null) throw new Error('Private worker exited before its response');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for inherited-pipe response');
  };
  try {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'worker.initialize', params: {
      protocol_version: 1, authority: authority(root),
    } })}\n`);
    assert.ok((await waitFor(1)).result);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'worker.credentials', params: { values: {} } })}\n`);
    assert.ok((await waitFor(2)).result);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'worker.shutdown', params: {} })}\n`);
    assert.ok((await waitFor(3)).result);
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Private worker did not exit')), 10_000);
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      if (child.exitCode !== null) { clearTimeout(timer); resolve({ code: child.exitCode, signal: child.signalCode }); }
    });
    assert.equal(outcome.code, 0);
    assert.equal(outcome.signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker-bound provider credentials are absent in actual host commands', async () => {
  const { startPrivateWorker } = await loadWorker();
  const root = mkdtempSync(join(tmpdir(), 'babel-private-host-command-'));
  const oldRuns = process.env['BABEL_RUNS_DIR'];
  const oldProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  process.env['BABEL_EXECUTION_PROFILE'] = 'host_native';
  setDockerAvailableForTest(false);
  writeFileSync(join(root, 'probe.mjs'), `
const keys = ['OPENROUTER_API_KEY', 'COMMAND_CODE_API_KEY'];
process.stdout.write(keys.some((key) => Object.hasOwn(process.env, key)) ? 'present' : 'absent');
`);
  try {
    for (const [provider, envName] of [['openrouter', 'OPENROUTER_API_KEY'], ['command-code', 'COMMAND_CODE_API_KEY']] as const) {
      process.env['BABEL_DESKTOP_PROVIDER'] = provider;
      let command: Awaited<ReturnType<SafeExecutor['shellExecAsync']>> | undefined;
      const host = fakeHost((engine) => {
        engine.submitMessageStream = async function* () {
          command = await new SafeExecutor(root).shellExecAsync('node --max-old-space-size=256 probe.mjs', '.', 10_000);
          yield { type: 'done', answer: command.stdout, usage: EMPTY_USAGE };
        } as ChatEngine['submitMessageStream'];
      });
      const client = new PipeClient();
      const worker = startPrivateWorker({ input: client.input, output: client.output, host });
      try {
        assert.ok((await client.request(1, 'worker.initialize', { protocol_version: 1,
          authority: { ...authority(root), execution_profile: 'host_native', provider } })).result);
        assert.ok((await client.request(2, 'worker.credentials', { values: { [envName]: 'synthetic-test-credential' } })).result);
        const thread = (await client.request(3, 'thread.create', { task: 'fixture' })).result.thread_id as string;
        const submitted = await client.request(4, 'turn.submit', { thread_id: thread, message: 'hello', command_id: 'command' });
        assert.ok(submitted.result);
        const terminal = await client.take((packet) => packet.method === 'turn.event' && packet.params.event.type === 'done');
        assert.equal(terminal.params.event.answer, 'absent');
        assert.equal(command?.process_started, true);
        assert.equal(command?.exit_code, 0);
        await client.take((packet) => packet.method === 'cell.committed' && packet.params.thread_id === thread);
      } finally {
        client.input.destroy();
        await worker.close();
        client.output.destroy();
      }
    }
  } finally {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['COMMAND_CODE_API_KEY'];
    if (oldRuns === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = oldRuns;
    if (oldProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = oldProfile;
    resetDockerAvailabilityCache();
    process.env['BABEL_DESKTOP_PROVIDER'] = 'ollama';
    rmSync(root, { recursive: true, force: true });
  }
});
