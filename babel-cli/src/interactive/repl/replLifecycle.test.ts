import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapReplSession } from './replLifecycle.js';
import { globalCostTracker } from '../../services/costTracker.js';

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
