import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCostLedger,
  buildSingleCallCostLedger,
  usageSummaryFromCostLedger,
} from './costLedger.js';

test('buildCostLedger flattens waterfall attempts into costed ledger entries', () => {
  const ledger = buildCostLedger({
    runId: 'run-001',
    task: 'price the task',
    lane: 'governed',
    createdAt: new Date('2026-06-04T12:00:00.000Z'),
    waterfallEntries: [
      {
        stage: 'orchestrator',
        attempts_detail: [
          {
            tier_name: 'deepseek-direct',
            tier_index: 0,
            attempt: 1,
            succeeded: true,
            provider: 'deepseek',
            provider_model_id: 'deepseek-v4-flash',
            prompt_tokens: 1000,
            completion_tokens: 2000,
            total_tokens: 3000,
            prompt_cache_hit_tokens: 400,
            prompt_cache_miss_tokens: 600,
          },
        ],
      },
      {
        stage: 'executor',
        attempts_detail: [
          {
            tier_name: 'step-flash',
            tier_index: 1,
            attempt: 1,
            succeeded: true,
            provider: 'deepinfra',
            provider_model_id: 'stepfun-ai/Step-3.5-Flash',
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
          },
        ],
      },
    ],
  });

  assert.equal(ledger.artifact_type, 'babel_cost_ledger');
  assert.equal(ledger.created_at, '2026-06-04T12:00:00.000Z');
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.entries[0]?.cost_precision, 'exact');
  assert.equal(ledger.entries[1]?.cost_precision, 'conservative');
  assert.equal(ledger.totals.prompt_tokens, 2000);
  assert.equal(ledger.totals.completion_tokens, 2500);
  assert.equal(ledger.totals.total_tokens, 4500);
  assert.ok(Math.abs(ledger.totals.estimated_cost_usd - 0.00088512) < 1e-12);
  assert.ok(Math.abs(ledger.totals.by_precision.exact - 0.00064512) < 1e-12);
  assert.ok(Math.abs(ledger.totals.by_precision.conservative - 0.00024) < 1e-12);
  assert.match(ledger.warnings.join('\n'), /conservative pricing/);

  const usage = usageSummaryFromCostLedger(ledger);
  assert.equal(usage.totalTokens, 4500);
  assert.equal(usage.modelBreakdown['deepseek-v4-flash']?.inputTokens, 1000);
  assert.equal(usage.modelBreakdown['stepfun-ai/Step-3.5-Flash']?.outputTokens, 500);
});

test('buildSingleCallCostLedger records Lite direct provider calls', () => {
  const ledger = buildSingleCallCostLedger({
    runId: 'lite-run',
    task: 'ask something',
    lane: 'lite-ask',
    stage: 'ask',
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    promptTokens: 1000,
    completionTokens: 2000,
    totalTokens: 3000,
    createdAt: new Date('2026-06-04T12:00:00.000Z'),
  });

  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0]?.stage, 'ask');
  assert.equal(ledger.entries[0]?.cost_precision, 'conservative');
  assert.ok(Math.abs(ledger.totals.estimated_cost_usd - 0.002175) < 1e-12);
  assert.match(ledger.warnings.join('\n'), /cache-hit\/cache-miss token counts were not available/);
});

test('buildCostLedger preserves stage totals when attempt details are absent', () => {
  const ledger = buildCostLedger({
    runId: 'run-002',
    task: 'fallback totals',
    lane: 'governed',
    createdAt: new Date('2026-06-04T12:00:00.000Z'),
    waterfallEntries: [
      {
        stage: 'planner',
        total_latency_ms: 25,
        total_prompt_tokens: 10,
        total_completion_tokens: 20,
        total_tokens: 30,
        total_estimated_cost_usd: 0.001,
      },
    ],
  });

  assert.equal(ledger.entries.length, 1);
  assert.match(ledger.entries[0]?.entry_id ?? '', /^planner-[a-f0-9]{8}$/);
  assert.equal(ledger.entries[0]?.stage, 'planner');
  assert.equal(ledger.entries[0]?.succeeded, null);
  assert.equal(ledger.entries[0]?.estimated_cost_usd, 0.001);
  assert.equal(ledger.totals.by_stage['planner']?.total_tokens, 30);
});

test('buildCostLedger records unknown pricing warnings for unregistered models', () => {
  const ledger = buildCostLedger({
    runId: 'run-003',
    task: 'unknown pricing',
    lane: 'governed',
    createdAt: new Date('2026-06-04T12:00:00.000Z'),
    waterfallEntries: [
      {
        stage: 'executor',
        attempts_detail: [
          {
            tier_name: 'unknown',
            provider: 'deepinfra',
            provider_model_id: 'unknown/model',
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
          },
        ],
      },
    ],
  });

  assert.equal(ledger.entries[0]?.cost_precision, 'unknown');
  assert.equal(ledger.entries[0]?.estimated_cost_usd, null);
  assert.equal(ledger.totals.by_precision.unknown, 0);
  assert.match(ledger.warnings.join('\n'), /No pinned pricing/);
});

test('buildCostLedger normalizes invalid precision values to unknown', () => {
  const ledger = buildCostLedger({
    runId: 'run-004',
    task: 'bad precision',
    lane: 'governed',
    createdAt: new Date('2026-06-04T12:00:00.000Z'),
    waterfallEntries: [
      {
        stage: 'qa',
        attempts_detail: [
          {
            tier_name: 'bad-runner',
            provider: 'deepseek',
            provider_model_id: 'deepseek-v4-flash',
            prompt_tokens: 1000,
            completion_tokens: 1000,
            total_tokens: 2000,
            estimated_cost_usd: 0.001,
            cost_precision: 'rough-estimate',
          },
        ],
      },
    ],
  });

  assert.equal(ledger.entries[0]?.cost_precision, 'unknown');
  assert.equal(
    Object.keys(ledger.totals.by_precision).sort().join(','),
    'conservative,exact,unknown',
  );
  assert.equal(ledger.totals.by_precision.unknown, 0.001);
  assert.match(ledger.warnings.join('\n'), /Invalid cost precision/);
});
