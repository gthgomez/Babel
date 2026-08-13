import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapReplSession, restoreTerminalBeforeExit } from './replLifecycle.js';
import { DEC_2026_END } from '../../ui/terminalEscapeSequences.js';
import { globalCostTracker } from '../../services/costTracker.js';

describe('restoreTerminalBeforeExit', () => {
  it('resets scroll region, ends DEC 2026, and clears the viewport', () => {
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
    assert.ok(out.includes('\x1b[2J'), 'viewport cleared');
    assert.ok(out.includes('\x1b[H'), 'cursor homed after clear');
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

    await bootstrapReplSession(ctx as never, () => ({
      costTotals: {
        totalCostUSD: 9.99,
        totalInputTokens: 50,
        totalOutputTokens: 50,
        totalTokens: 100,
      },
    }) as never);

    assert.equal(globalCostTracker.getSessionSummary().totalCostUSD, 0);
  });
});
