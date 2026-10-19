import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), 'remote-ui');

type RpcResult = { payload: unknown; classified: { kind: string } };

async function loadReconcileHarness(): Promise<{
  reconcile: () => Promise<void>;
  getState: () => { turn: string; thread: string };
  configure: (patch: Record<string, unknown>) => void;
  setRpc: (fn: (method: string, params?: Record<string, unknown>) => Promise<RpcResult>) => void;
}> {
  const sandbox: Record<string, unknown> = {
    window: {},
    document: {
      addEventListener() {},
      getElementById: () => ({
        value: '',
        disabled: false,
        classList: { add() {}, remove() {} },
        textContent: '',
        children: [],
        firstElementChild: null,
        appendChild() {},
        removeChild() {},
      }),
      querySelectorAll: () => [],
    },
    location: { protocol: 'http:', host: '127.0.0.1:1', pathname: '/ui/' },
    addEventListener() {},
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    navigator: {},
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
      const app = (sandbox['window'] as Record<string, unknown>)['BabelRemoteApp'] as
        | { reconcileAuthoritativeTaskState: () => Promise<void> }
        | undefined;
      if (app?.reconcileAuthoritativeTaskState) resolve();
      else if (Date.now() > deadline) reject(new Error('PWA boot timeout'));
      else setTimeout(wait, 5);
    };
    wait();
  });
  const win = sandbox['window'] as Record<string, unknown>;
  const app = win['BabelRemoteApp'] as {
    reconcileAuthoritativeTaskState: () => Promise<void>;
    getState: () => { turn: string; thread: string };
    configureTest: (patch: Record<string, unknown>) => void;
  };
  return {
    reconcile: () => app.reconcileAuthoritativeTaskState(),
    getState: () => app.getState(),
    configure: (patch) => app.configureTest(patch),
    setRpc: (fn) => {
      win['__babelRemoteRpc'] = fn;
    },
  };
}

describe('PWA exact-turn terminal recovery', () => {
  it('does not substitute an older turn terminal when the current turn is unresolved', async () => {
    const ctx = await loadReconcileHarness();
    const lookups: number[] = [];
    ctx.configure({
      host: 'ONLINE',
      thread: 'RUNNING',
      turn: 'UNKNOWN',
      memory: { threadId: 'thr-1', turnId: 2 },
    });
    ctx.setRpc(async (method, params) => {
      if (method === 'remote.catalog') {
        return {
          payload: { result: { sessions: [{ thread_id: 'thr-1', active_turn: false, status: 'idle' }] } },
          classified: { kind: 'success' },
        };
      }
      if (method === 'history.lookup') {
        const turnId = (params as { turn_id?: number })?.turn_id;
        if (turnId !== undefined) lookups.push(turnId);
        if (turnId === 2) {
          return { payload: { result: { turn_terminal: null } }, classified: { kind: 'success' } };
        }
        if (turnId === 1) {
          return {
            payload: {
              result: {
                turn_terminal: {
                  turn_id: 1,
                  event_type: 'done',
                  outcome: 'VERIFIED_COMPLETE',
                  recorded_at: 't',
                },
              },
            },
            classified: { kind: 'success' },
          };
        }
        return { payload: { result: { latest_turn_id: 2 } }, classified: { kind: 'success' } };
      }
      if (method === 'approval.lookup') {
        return { payload: { result: { pending: [] } }, classified: { kind: 'success' } };
      }
      throw new Error(`unexpected ${method}`);
    });
    await ctx.reconcile();
    const state = ctx.getState();
    assert.equal(state.turn, 'UNKNOWN');
    assert.deepEqual(lookups, [2]);
  });

  it('reconciles STREAMING through history.lookup for the exact turn', async () => {
    const ctx = await loadReconcileHarness();
    let historyCalls = 0;
    ctx.configure({
      host: 'ONLINE',
      thread: 'RUNNING',
      turn: 'STREAMING',
      memory: { threadId: 'thr-1', turnId: 3 },
    });
    ctx.setRpc(async (method, params) => {
      if (method === 'remote.catalog') {
        return {
          payload: { result: { sessions: [{ thread_id: 'thr-1', active_turn: false, status: 'completed' }] } },
          classified: { kind: 'success' },
        };
      }
      if (method === 'history.lookup') {
        historyCalls += 1;
        const turnId = (params as { turn_id?: number })?.turn_id;
        if (turnId === 3) {
          return {
            payload: {
              result: {
                turn_terminal: {
                  turn_id: 3,
                  event_type: 'done',
                  fixture_execution: true,
                  recorded_at: 't',
                },
              },
            },
            classified: { kind: 'success' },
          };
        }
        return { payload: { result: { latest_turn_id: 3 } }, classified: { kind: 'success' } };
      }
      if (method === 'approval.lookup') {
        return { payload: { result: { pending: [] } }, classified: { kind: 'success' } };
      }
      throw new Error(`unexpected ${method}`);
    });
    await ctx.reconcile();
    assert.ok(historyCalls >= 1);
    assert.equal(ctx.getState().turn, 'COMPLETED');
  });

  it('settles cancelled authoritative terminals to COMPLETED (not CANCELLING)', async () => {
    const ctx = await loadReconcileHarness();
    ctx.configure({
      host: 'ONLINE',
      thread: 'RUNNING',
      turn: 'UNKNOWN',
      memory: { threadId: 'thr-1', turnId: 1 },
    });
    ctx.setRpc(async (method, params) => {
      if (method === 'remote.catalog') {
        return {
          payload: { result: { sessions: [{ thread_id: 'thr-1', active_turn: false, status: 'completed' }] } },
          classified: { kind: 'success' },
        };
      }
      if (method === 'history.lookup') {
        const turnId = (params as { turn_id?: number }).turn_id;
        if (turnId === undefined) {
          return {
            payload: { result: { latest_turn_id: 1, cells: [] } },
            classified: { kind: 'success' },
          };
        }
        if (turnId === 1) {
          return {
            payload: {
              result: {
                turn_terminal: {
                  turn_id: 1,
                  event_type: 'cancelled',
                  outcome: 'CANCELLED',
                  recorded_at: 't',
                },
              },
            },
            classified: { kind: 'success' },
          };
        }
      }
      if (method === 'approval.lookup') {
        return { payload: { result: { pending: [] } }, classified: { kind: 'success' } };
      }
      throw new Error(`unexpected ${method}`);
    });
    await ctx.reconcile();
    assert.equal(ctx.getState().turn, 'COMPLETED');
    assert.equal(ctx.getState().thread, 'READY');
  });
});
