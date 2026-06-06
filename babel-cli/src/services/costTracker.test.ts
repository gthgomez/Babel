import assert from 'node:assert/strict';
import test from 'node:test';

import { CostTracker } from './costTracker.js';

test('CostTracker prices direct DeepSeek v4 Flash with conservative cache-miss input', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('deepseek-v4-flash', 1000, 2000);
  const summary = tracker.getSessionSummary();

  assert.ok(Math.abs(cost - 0.0007) < 1e-12);
  assert.ok(Math.abs(summary.totalCostUSD - 0.0007) < 1e-12);
  assert.equal(summary.modelBreakdown['deepseek-v4-flash']?.inputTokens, 1000);
  assert.equal(summary.modelBreakdown['deepseek-v4-flash']?.outputTokens, 2000);
});

test('CostTracker prices direct DeepSeek v4 Pro with conservative cache-miss input', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('deepseek-v4-pro', 1000, 2000);

  assert.ok(Math.abs(cost - 0.002175) < 1e-12);
});

test('CostTracker uses the shared registry for DeepInfra model pricing', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('Qwen/Qwen3-32B', 1000, 2000);

  assert.ok(Math.abs(cost - 0.00064) < 1e-12);
});
