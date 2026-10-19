import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), 'remote-ui');

async function loadPwaApp(): Promise<{
  BabelRemoteState: {
    canSendTurn: (thread: string, turn: string) => boolean;
    canCancelTurn: (turn: string) => boolean;
  };
  BabelRemoteApp: {
    getState: () => { thread: string; turn: string; approval: string };
    configureTest: (patch: Record<string, unknown>) => void;
    send: () => Promise<void>;
    stop: () => Promise<void>;
    decide: (decision: string) => Promise<void>;
  };
  setRpc: (
    fn: (method: string) => Promise<{ payload: unknown; classified: { kind: string; message?: string } }>,
  ) => void;
}> {
  const sandbox: Record<string, unknown> = {
    window: {},
    document: {
      addEventListener() {},
      getElementById: (id: string) => ({
        id,
        value: id === 'composer' ? 'hello' : id === 'thread-id' ? 'thr-test' : '',
        disabled: false,
        classList: { toggle() {}, add() {}, remove() {} },
        textContent: '',
        onclick: null,
        children: [],
        firstElementChild: null,
        appendChild() {},
        removeChild() {},
      }),
      createElement: () => ({
        className: '',
        setAttribute() {},
        appendChild() {},
        children: [],
      }),
      createTextNode: (t: string) => ({ textContent: t }),
      querySelectorAll: () => [],
    },
    location: { protocol: 'http:', host: '127.0.0.1:4545', pathname: '/ui/' },
    addEventListener() {},
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    navigator: {},
    crypto: { randomUUID: () => 'cmd-test-uuid' },
  };
  sandbox['window'] = sandbox;
  sandbox['globalThis'] = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of ['state.js', 'render.js', 'app.js']) {
    vm.runInContext(readFileSync(join(uiDir, file), 'utf8'), context, { filename: file });
  }
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const wait = () => {
      if ((sandbox['window'] as Record<string, unknown>)['BabelRemoteApp']) resolve();
      else if (Date.now() > deadline) reject(new Error('PWA boot timeout'));
      else setTimeout(wait, 5);
    };
    wait();
  });
  const win = sandbox['window'] as Record<string, unknown>;
  return {
    BabelRemoteState: win['BabelRemoteState'] as {
      apply: (m: string, from: string, ev: string) => string;
      canSendTurn: (thread: string, turn: string) => boolean;
      canCancelTurn: (turn: string) => boolean;
    },
    BabelRemoteApp: win['BabelRemoteApp'] as {
      getState: () => { thread: string; turn: string; approval: string };
      configureTest: (patch: Record<string, unknown>) => void;
      send: () => Promise<void>;
      stop: () => Promise<void>;
      decide: (decision: string) => Promise<void>;
    },
    setRpc: (fn) => {
      win['__babelRemoteRpc'] = fn;
    },
  };
}

describe('PWA production handlers', () => {
  it('returns thread to READY after a settled submit rejection so control can be retaken', async () => {
    const ctx = await loadPwaApp();
    ctx.BabelRemoteApp.configureTest({
      host: 'ONLINE',
      thread: 'READY',
      turn: 'IDLE',
      memory: {
        pairedDevice: true,
        authKind: 'paired',
        clientId: 'device:test',
        threadId: 'thr-test',
        controlEpoch: 1,
      },
    });
    ctx.setRpc(async (method) => {
      assert.equal(method, 'turn.submit');
      return {
        payload: { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'control lease required' } },
        classified: { kind: 'rejected', message: 'control lease required' },
      };
    });
    await ctx.BabelRemoteApp.send();
    const state = ctx.BabelRemoteApp.getState();
    assert.equal(state.thread, 'READY');
    assert.equal(state.turn, 'FAILED');
    assert.equal(ctx.BabelRemoteState.canSendTurn(state.thread, state.turn), true);
  });

  it('recovers turn to STREAMING after a settled cancel rejection', async () => {
    const ctx = await loadPwaApp();
    ctx.BabelRemoteApp.configureTest({
      host: 'ONLINE',
      thread: 'RUNNING',
      turn: 'STREAMING',
      memory: {
        pairedDevice: true,
        authKind: 'paired',
        clientId: 'device:test',
        threadId: 'thr-test',
        controlEpoch: 1,
      },
    });
    ctx.setRpc(async (method) => {
      assert.equal(method, 'turn.cancel');
      return {
        payload: { jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'not holder' } },
        classified: { kind: 'rejected', message: 'not holder' },
      };
    });
    await ctx.BabelRemoteApp.stop();
    const state = ctx.BabelRemoteApp.getState();
    assert.equal(state.turn, 'STREAMING');
    assert.equal(ctx.BabelRemoteState.canCancelTurn(state.turn), true);
  });

  it('marks approval stale after a settled decide rejection', async () => {
    const ctx = await loadPwaApp();
    ctx.BabelRemoteApp.configureTest({
      host: 'ONLINE',
      thread: 'WAITING_APPROVAL',
      turn: 'STREAMING',
      approval: 'PENDING',
      memory: {
        pairedDevice: true,
        authKind: 'paired',
        clientId: 'device:test',
        threadId: 'thr-test',
        controlEpoch: 1,
        pendingApproval: {
          approval_id: 'appr-1',
          thread_id: 'thr-test',
          turn_id: '1',
          operation_digest: 'abc',
        },
      },
    });
    ctx.setRpc(async (method) => {
      assert.equal(method, 'approval.decide');
      return {
        payload: { jsonrpc: '2.0', id: 3, error: { code: -32001, message: 'stale approval' } },
        classified: { kind: 'rejected', message: 'stale approval' },
      };
    });
    await ctx.BabelRemoteApp.decide('allow_once');
    const state = ctx.BabelRemoteApp.getState();
    assert.equal(state.approval, 'STALE');
  });
});
