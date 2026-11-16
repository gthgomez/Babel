import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isSyntheticProviderFixtureReady, runSyntheticProviderTestFile } from '../../testinfra/synthetic-provider-fixture.mjs';

if (!isSyntheticProviderFixtureReady()) {
  it('REPL startup uses an isolated synthetic profile', {timeout:60000}, async t => {
    const result=await runSyntheticProviderTestFile(import.meta.url);t.diagnostic(JSON.stringify(result));
    assert.equal(result.exitCode,0);assert.ok(result.passed>0);
  });
} else {
const { bootstrapReplSession, restoreTerminalBeforeExit } = await import('./replLifecycle.js');
const { DEC_2026_END } = await import('../../ui/terminalEscapeSequences.js');
const { globalCostTracker } = await import('../../services/costTracker.js');

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

  it('resets leftover session.json totals instead of restoring them', async () => {
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

  it('does not begin daemon or indexing work before the composer is shown', async () => {
    let warmCalled = false;
    let indexCalled = false;

    const ctx = {
      projectSettingsApplied: true,
      state: { model: 'deepseek-v4-flash' },
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

    assert.equal(warmCalled, false, 'daemon warmup is deferred');
    assert.equal(indexCalled, false, 'indexing is deferred');
    assert.equal(process.env['BABEL_INTERACTIVE'], '1');
  });

  it('does not open setup before the composer even on an interactive terminal', async () => {
    const input = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const output = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    const ci = process.env['CI'];
    let opened = false;
    const ctx = { projectSettingsApplied: true, state: {},
      resolveCurrentTarget: () => ({ targetRoot: process.cwd() }), resolveSessionModel: () => undefined,
      withExclusiveTerminal: async () => { opened = true; } };
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
      delete process.env['CI'];
      await bootstrapReplSession(ctx as never, () => null, { warmRuntime: false, startIndexing: false });
      assert.equal(opened, false);
      assert.equal((ctx.state as { readinessState?: string }).readinessState, 'setup_required');
    } finally {
      if (input) Object.defineProperty(process.stdin, 'isTTY', input); else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (output) Object.defineProperty(process.stderr, 'isTTY', output); else delete (process.stderr as { isTTY?: boolean }).isTTY;
      if (ci === undefined) delete process.env['CI']; else process.env['CI'] = ci;
    }
  });
});
}
