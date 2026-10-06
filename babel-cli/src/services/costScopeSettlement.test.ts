/**
 * Durable cost scope: an unresolved dispatch placeholder may adopt the
 * provider named by the first real usage without failing the task closed.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CostTracker } from './costTracker.js';

describe('cost scope settlement', () => {
  test('unresolved placeholder adopts the observed provider instead of conflicting', () => {
    const tracker = new CostTracker();
    const attribution = {
      taskOwnerId: 'scope-owner',
      chargeId: 'scripted-inference-0',
      accountingEpoch: tracker.getAccountingEpoch(),
      requestId: 'scripted-request-0',
      attemptId: 'scripted-attempt-0',
    };
    assert.equal(
      tracker.settleUsage('deepseek-v4-flash', 0, 0, null, null, attribution, false, 'openrouter').kind,
      'inserted',
    );
    const update = tracker.settleUsage(
      'deepseek-v4-flash', 30_000, 30_000, null, null, attribution, true, 'scripted',
    );
    assert.equal(update.kind, 'refined');
    assert.equal(tracker.getTaskChargeObservations('scope-owner')[0]?.provider, 'scripted');
    assert.equal(tracker.getTaskSummary('scope-owner').totalTokens, 60_000);
  });

  test('a confirmed charge still conflicts when a later receipt changes provider', () => {
    const tracker = new CostTracker();
    const attribution = { taskOwnerId: 'scope-owner', chargeId: 'confirmed' };
    tracker.settleUsage('deepseek-v4-flash', 10, 10, null, null, attribution, true, 'openrouter');
    const update = tracker.settleUsage(
      'deepseek-v4-flash', 10, 10, null, null, attribution, true, 'scripted',
    );
    assert.equal(update.kind, 'conflict');
    if (update.kind === 'conflict') {
      assert.equal(update.reason, 'Charge identity differs from the recorded attempt');
    }
  });

  test('an unpriced route records the provider-reported cost', () => {
    const tracker = new CostTracker();
    const attribution = { taskOwnerId: 'scope-owner', chargeId: 'reported-cost' };
    const update = tracker.settleUsage(
      'deepseek-v4-flash', 90_000, 12_000, 0, 90_000, attribution, true, 'openrouter', 4.25,
    );
    assert.equal(update.kind, 'inserted');
    assert.equal(tracker.getTaskSummary('scope-owner').totalCostUSD, 4.25);
  });

  test('a missing price and a missing report stay unresolved', () => {
    const tracker = new CostTracker();
    const attribution = { taskOwnerId: 'scope-owner', chargeId: 'unpriced' };
    const update = tracker.settleUsage(
      'deepseek-v4-flash', 10, 10, null, null, attribution, true, 'openrouter',
    );
    assert.equal(update.kind, 'inserted');
    assert.equal(update.unknownDelta, 1);
    assert.equal(tracker.getTaskSummary('scope-owner').totalCostUSD, 0);
  });
});
