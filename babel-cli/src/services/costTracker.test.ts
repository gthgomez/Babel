import assert from 'node:assert/strict';
import test from 'node:test';

import { CostTracker, usageDelta } from './costTracker.js';

test('CostTracker prices direct DeepSeek v4 Flash with conservative cache-miss input', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('deepseek-v4-flash', 1000, 2000);
  assert.ok(cost !== null);
  const summary = tracker.getSessionSummary();

  assert.ok(Math.abs(cost - 0.0007) < 1e-12);
  assert.ok(Math.abs(summary.totalCostUSD - 0.0007) < 1e-12);
  assert.equal(summary.modelBreakdown['deepseek-v4-flash']?.inputTokens, 1000);
  assert.equal(summary.modelBreakdown['deepseek-v4-flash']?.outputTokens, 2000);
});

test('CostTracker prices direct DeepSeek v4 Pro with conservative cache-miss input', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('deepseek-v4-pro', 1000, 2000);
  assert.ok(cost !== null);

  assert.ok(Math.abs(cost - 0.002175) < 1e-12);
});

test('usageDelta is this-turn billed usage, never session totals', () => {
  const tracker = new CostTracker();
  tracker.trackUsage('deepseek-v4-flash', 40_000, 396);
  const before = tracker.getSessionSummary();
  tracker.trackUsage('deepseek-v4-flash', 9_000, 286);
  const after = tracker.getSessionSummary();
  const turn = usageDelta(before, after);
  assert.equal(turn.tokens, 9286);
  assert.ok(turn.costUsd > 0);
  assert.ok(turn.tokens < after.totalTokens);
  assert.equal(after.totalTokens, before.totalTokens + turn.tokens);
});

test('CostTracker uses the shared registry for DeepInfra model pricing', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('Qwen/Qwen3-32B', 1000, 2000);
  assert.ok(cost !== null);

  assert.ok(Math.abs(cost - 0.00064) < 1e-12);
});

test('unknown model pricing stays nullable and does not become a free or fallback charge', () => {
  const tracker = new CostTracker();
  const unknown = tracker.trackUsage('unlisted-provider-model', 1000, 1000, null, null, {
    taskOwnerId: 'owner-A', chargeId: 'unknown-1', accountingEpoch: tracker.getAccountingEpoch(),
  });
  assert.equal(unknown, null);
  const task = JSON.parse(JSON.stringify(tracker.getTaskSummary('owner-A')));
  const session = tracker.getSessionSummary();
  assert.equal(task.completeCostUSD, null);
  assert.equal(task.knownCostUSD, 0);
  assert.equal(task.unknownChargeCount, 1);
  assert.equal(task.costComplete, false);
  assert.equal(session.completeCostUSD, null);
  assert.equal(session.unknownChargeCount, 1);
  assert.equal(tracker.trackUsage('deepseek-v4-flash', 0, 0, null, null, {
    taskOwnerId: 'owner-B', chargeId: 'known-zero',
  }), 0);
  assert.equal(tracker.getTaskSummary('owner-B').completeCostUSD, 0);
  assert.equal(tracker.getSessionSummary().completeCostUSD, null);
  assert.equal(tracker.trackUsage('unlisted-provider-model', 1000, 1000, null, null, {
    taskOwnerId: 'owner-A', chargeId: 'unknown-1',
  }), 0);
  assert.equal(tracker.getTaskSummary('owner-A').unknownChargeCount, 1);
});

test('charge replay cannot change owner or accounting epoch', () => {
  const tracker = new CostTracker();
  const attribution = {
    taskOwnerId: 'owner-A', chargeId: 'attempt-1', accountingEpoch: tracker.getAccountingEpoch(),
  };
  const first = tracker.trackUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
  assert.ok(first !== null && first > 0);
  assert.equal(tracker.trackUsage('deepseek-v4-flash', 1000, 100, null, null, {
    ...attribution, taskOwnerId: 'owner-B',
  }), 0);
  assert.equal(tracker.getTaskSummary('owner-B').totalCostUSD, 0);
  assert.equal(tracker.getSessionSummary().totalCostUSD, first);
  assert.throws(() => tracker.trackUsage('deepseek-v4-flash', 1000, 100, null, null, {
    ...attribution, chargeId: 'attempt-2', accountingEpoch: 'wrong-epoch',
  }), /different accounting epoch/);
});

test('restored task snapshot keeps unknown cost incomplete without adding a session bill', () => {
  const original = new CostTracker();
  original.recordUnknownCharge('unlisted-provider-model', {
    taskOwnerId: 'owner-A', chargeId: 'unpriced-1',
  });
  const snapshot = JSON.parse(JSON.stringify({
    totalCostUSD: original.getTaskSummary('owner-A').totalCostUSD,
    unknownChargeCount: original.getTaskSummary('owner-A').unknownChargeCount,
    chargeIds: original.getTaskChargeIds('owner-A'),
  }));
  const resumed = new CostTracker();
  resumed.restoreTaskUsage('owner-A', snapshot);
  assert.equal(resumed.getTaskSummary('owner-A').completeCostUSD, null);
  assert.equal(resumed.getTaskSummary('owner-A').unknownChargeCount, 1);
  assert.equal(resumed.getSessionSummary().totalCostUSD, 0);
  assert.equal(resumed.trackUsage('deepseek-v4-flash', 100, 10, null, null, {
    taskOwnerId: 'owner-A', chargeId: 'unpriced-1',
  }), 0);
});
