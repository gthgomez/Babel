import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('trackUsage honors cache-aware pricing when cache tokens are reported (§21)', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cost-tracker-'));
  try {
    const tracker = new CostTracker(root);
    // 100 cached + 100 uncached input tokens on deepseek-v4-flash
    // (hit 0.0028/M, miss 0.14/M) — must be cheaper than 200 tokens at full rate.
    const cacheAware = tracker.trackUsage('deepseek-v4-flash', 0, 0, 100, 100);
    const fullRate = tracker.trackUsage('deepseek-v4-flash', 200, 0);
    assert.ok(cacheAware > 0, 'cache-aware cost must be positive');
    assert.ok(cacheAware < fullRate, 'cache-aware cost must be below full-rate cost');
    // 100 hit + 100 miss = 0.00000028 + 0.000014 = 0.00001428; 200 full = 0.000028.
    assert.ok(Math.abs(cacheAware - 0.00001428) < 1e-10, `cacheAware=${cacheAware}`);
    assert.ok(Math.abs(fullRate - 0.000028) < 1e-10, `fullRate=${fullRate}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trackUsage falls back to per-model pricing when cache fields are absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cost-tracker-'));
  try {
    const tracker = new CostTracker(root);
    const cost = tracker.trackUsage('deepseek-v4-flash', 1_000_000, 0);
    assert.ok(Math.abs(cost - 0.14) < 1e-9, `cost=${cost}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
