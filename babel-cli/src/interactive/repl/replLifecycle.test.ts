import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { updateUserSettings } from '../../config/userSettings.js';
import { withInvocationSettings } from '../../config/invocationSettings.js';

import { bootstrapReplSession, restoreTerminalBeforeExit } from './replLifecycle.js';
import { DEC_2026_END } from '../../ui/terminalEscapeSequences.js';
import { globalCostTracker } from '../../services/costTracker.js';

function useIsolatedProfile(t: TestContext): void {
  const root = mkdtempSync(join(tmpdir(), 'babel-repl-startup-'));
  const values: Record<string, string> = {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    BABEL_CONFIG_DIR: join(root, 'config'), BABEL_STATE_DIR: join(root, 'state'),
    BABEL_CACHE_DIR: join(root, 'cache'), OPENROUTER_API_KEY: 'test-key',
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
}

describe('restoreTerminalBeforeExit', () => {
  it('restores terminal state without clearing the viewport', () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const stub = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = stub;
    try {
      restoreTerminalBeforeExit();
    } finally {
      process.stdout.write = original;
    }
    const out = writes.join('');
    assert.ok(out.includes('\x1b[?25h'), 'cursor shown');
    assert.ok(out.includes('\x1b[r'), 'scroll region reset');
    assert.ok(out.includes(DEC_2026_END), 'DEC 2026 ended');
    assert.doesNotMatch(out, /\x1b\[2J|\x1b\[3J/, 'clean exit preserves viewport');
  });
});

describe('fresh interactive launch cost', () => {
  afterEach(() => {
    globalCostTracker.resetSession();
    delete process.env['BABEL_INTERACTIVE'];
  });

  it('resets leftover session.json totals instead of restoring them', async t => {
    useIsolatedProfile(t);
    globalCostTracker.restoreSessionCost({
      totalCostUSD: 1.25,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalTokens: 1200,
    });
    assert.ok(globalCostTracker.getSessionSummary().totalCostUSD > 0);

    const ctx = {
      projectSettingsApplied: true,
      state: { model: 'deepseek-v4-flash' },
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
      resolveSessionModel: () => undefined,
    };

    await bootstrapReplSession(
      ctx as never,
      () => ({
        costTotals: {
          totalCostUSD: 9.99,
          totalInputTokens: 50,
          totalOutputTokens: 50,
          totalTokens: 100,
        },
      }) as never,
      { warmRuntime: false, startIndexing: false },
    );

    assert.equal(globalCostTracker.getSessionSummary().totalCostUSD, 0);
  });

  it('offers setup for a saved model with no connection on an interactive terminal', async t => {
    useIsolatedProfile(t);
    const oldCi = process.env['CI'];
    process.env['CI'] = 'false';
    const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const errorDescriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    t.after(() => {
      if (oldCi === undefined) delete process.env['CI']; else process.env['CI'] = oldCi;
      if (inputDescriptor) Object.defineProperty(process.stdin, 'isTTY', inputDescriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (errorDescriptor) Object.defineProperty(process.stderr, 'isTTY', errorDescriptor);
      else Reflect.deleteProperty(process.stderr, 'isTTY');
    });
    let setupCalls = 0;
    const ctx = {
      projectSettingsApplied: true,
      state: { model: 'deepseek-v4-flash' },
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
      resolveSessionModel: () => undefined,
      withExclusiveTerminal: async () => { setupCalls += 1; return {}; },
    };
    await bootstrapReplSession(ctx as never, () => null, { warmRuntime: false, startIndexing: false });
    assert.equal(setupCalls, 1);
  });

  it('does not warm a saved model without a configured connection', async t => {
    useIsolatedProfile(t);
    let warmCalled = false;
    let indexCalled = false;
    const ctx = {
      projectSettingsApplied: true,
      state: { model: 'deepseek-v4-flash' } as {
        model: string; readinessState?: string; lastRunUserStatus?: string;
      },
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
      resolveSessionModel: () => undefined,
    };
    await bootstrapReplSession(ctx as never, () => null, {
      warmRuntime: () => { warmCalled = true; },
      startIndexing: () => { indexCalled = true; },
    });
    assert.equal(ctx.state.readinessState, 'setup_required');
    assert.equal(ctx.state.lastRunUserStatus, 'blocked');
    assert.equal(warmCalled, false);
    assert.equal(indexCalled, false);
  });

  it('checks the account named by the selected model instead of a different default', async t => {
    useIsolatedProfile(t);
    updateUserSettings({
      connections: {
        selected: { id: 'selected', provider: 'openrouter', model: 'vendor/selected', apiKeyEnvVar: 'SYNTHETIC_MISSING_KEY' },
        fallback: { id: 'fallback', provider: 'openrouter', model: 'vendor/fallback' },
      },
      defaults: { connection: 'fallback', model: 'vendor/fallback', budgetUsd: 'unlimited' },
    });
    let warmCalled = false;
    const ctx = {
      projectSettingsApplied: true,
      state: { model: 'connection/selected/vendor/selected' } as {
        model: string; connectionId?: string; readinessState?: string;
      },
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
      resolveSessionModel: () => undefined,
    };
    await bootstrapReplSession(ctx as never, () => null, { warmRuntime: () => { warmCalled = true; }, startIndexing: false });
    assert.equal(ctx.state.model, 'connection/selected/vendor/selected');
    assert.equal(ctx.state.readinessState, 'action_required');
    assert.equal(warmCalled, false);
  });

  it('retains a valid explicit account and model over a different default', async t => {
    useIsolatedProfile(t);
    updateUserSettings({
      connections: {
        selected: { id: 'selected', provider: 'openrouter', model: 'vendor/selected' },
        fallback: { id: 'fallback', provider: 'openrouter', model: 'vendor/fallback' },
      },
      defaults: { connection: 'fallback', model: 'vendor/fallback', budgetUsd: 'unlimited' },
    });
    let warmCalled = false;
    const ctx = {
      projectSettingsApplied: true,
      state: { model: 'connection/selected/vendor/selected' } as {
        model: string; connectionId?: string; readinessState?: string;
      },
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
      resolveSessionModel: () => undefined,
    };
    await bootstrapReplSession(ctx as never, () => null, { warmRuntime: () => { warmCalled = true; }, startIndexing: false });
    assert.equal(ctx.state.connectionId, 'selected');
    assert.equal(ctx.state.model, 'connection/selected/vendor/selected');
    assert.equal(ctx.state.readinessState, 'configured_unverified');
    assert.equal(warmCalled, true);
  });

  it('blocks a model selector that conflicts with the active account', async t => {
    useIsolatedProfile(t);
    updateUserSettings({
      connections: {
        selected: { id: 'selected', provider: 'openrouter', model: 'vendor/selected' },
        other: { id: 'other', provider: 'openrouter', model: 'vendor/other' },
      },
      defaults: { connection: 'selected', model: 'vendor/selected', budgetUsd: 'unlimited' },
    });
    let warmCalled = false;
    const ctx = {
      projectSettingsApplied: true,
      state: { connectionId: 'selected', model: 'connection/other/vendor/other' } as {
        model: string; connectionId: string; readinessState?: string;
      },
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
      resolveSessionModel: () => undefined,
    };
    await bootstrapReplSession(ctx as never, () => null, { warmRuntime: () => { warmCalled = true; }, startIndexing: false });
    assert.equal(ctx.state.connectionId, 'selected');
    assert.equal(ctx.state.model, 'connection/other/vendor/other');
    assert.equal(ctx.state.readinessState, 'action_required');
    assert.equal(warmCalled, false);
  });

  it('blocks when an invocation override conflicts with the selected route', async t => {
    useIsolatedProfile(t);
    updateUserSettings({
      connections: {
        selected: { id: 'selected', provider: 'openrouter', model: 'vendor/selected' },
        other: { id: 'other', provider: 'openrouter', model: 'vendor/other' },
      },
      defaults: { connection: 'selected', model: 'vendor/selected', budgetUsd: 'unlimited' },
    });
    let warmCalled = false;
    const ctx = {
      projectSettingsApplied: true,
      state: { connectionId: 'selected', model: 'connection/selected/vendor/selected' } as {
        model: string; connectionId: string; readinessState?: string;
      },
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
      resolveSessionModel: () => undefined,
    };
    await withInvocationSettings({ connection: 'other', model: 'vendor/other' }, () =>
      bootstrapReplSession(ctx as never, () => null, { warmRuntime: () => { warmCalled = true; }, startIndexing: false }));
    assert.equal(ctx.state.connectionId, 'selected');
    assert.equal(ctx.state.model, 'connection/selected/vendor/selected');
    assert.equal(ctx.state.readinessState, 'action_required');
    assert.equal(warmCalled, false);
  });

  it('runs configured startup hooks without opening a provider connection', async t => {
    useIsolatedProfile(t);
    updateUserSettings({
      connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' } },
      defaults: { connection: 'fixture', model: 'deepseek/deepseek-v4.1-flash-1017', budgetUsd: 'unlimited' },
    });
    let warmCalled = false;
    let indexCalled = false;

    const ctx = {
      projectSettingsApplied: true,
      state: { connectionId: 'fixture', model: 'connection/fixture/deepseek/deepseek-v4.1-flash-1017' },
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }),
      resolveSessionModel: () => undefined,
    };

    await bootstrapReplSession(
      ctx as never,
      () => null,
      {
        warmRuntime: () => { warmCalled = true; },
        startIndexing: () => { indexCalled = true; },
      },
    );

    assert.equal(warmCalled, true, 'custom warmup hook invoked');
    assert.equal(indexCalled, true, 'custom indexing hook invoked');
    assert.equal(process.env['BABEL_INTERACTIVE'], '1');
  });
});
