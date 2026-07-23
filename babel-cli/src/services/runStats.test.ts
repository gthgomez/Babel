import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunStats } from './runStats.js';

test('buildRunStats derives waterfall, tool, cache, and session stats', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-run-stats-'));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '05_waterfall_telemetry.json'),
    JSON.stringify([
      {
        stage: 'orchestrator',
        tier_succeeded: 'qwen',
        total_latency_ms: 120,
        total_prompt_tokens: 10,
        total_completion_tokens: 20,
        total_tokens: 30,
        total_estimated_cost_usd: 0.001,
      },
      {
        stage: 'executor',
        tier_succeeded: 'codex',
        total_latency_ms: 80,
        total_prompt_tokens: 5,
        total_completion_tokens: 5,
        total_tokens: 10,
        total_estimated_cost_usd: 0.002,
      },
    ]),
    'utf8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    JSON.stringify({
      status: 'EXECUTION_COMPLETE',
      tool_call_log: [
        {
          tool: 'web_fetch',
          exit_code: 0,
          stdout: JSON.stringify({ cache: { from_cache: true } }),
          verified: true,
          checkpoint_ids: ['cp_1'],
        },
        {
          tool: 'file_read',
          exit_code: 1,
          stdout: '',
          verified: false,
        },
      ],
    }),
    'utf8',
  );
  writeFileSync(
    join(runDir, '10_session_context.json'),
    JSON.stringify({
      steps_complete: 2,
      context_fingerprint: 'abc123',
      approval_state: { executor_gate: 'PASS' },
      model_context: {
        file_read_cache: [{ path: 'a.txt', content: 'A' }],
      },
    }),
    'utf8',
  );

  const stats = buildRunStats(runDir);
  assert.equal(stats.waterfall.total_latency_ms, 200);
  assert.equal(stats.tools.tool_call_count, 2);
  assert.equal(stats.tools.successful_tool_calls, 1);
  assert.equal(stats.tools.checkpoint_count, 1);
  assert.equal(stats.cache.web_cache_hits, 1);
  assert.equal(stats.cache.file_read_cache_entries, 1);
  assert.equal(stats.tokens.total, 40);
  assert.equal(stats.tokens.source, 'waterfall_telemetry');
  assert.equal(stats.tokens.cost_ledger_path, null);
  assert.equal(stats.session.context_fingerprint, 'abc123');
});

test('buildRunStats prefers cost_ledger totals when available', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-run-stats-ledger-'));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '05_waterfall_telemetry.json'),
    JSON.stringify([
      {
        stage: 'orchestrator',
        tier_succeeded: 'qwen',
        total_latency_ms: 120,
        total_prompt_tokens: 10,
        total_completion_tokens: 20,
        total_tokens: 30,
        total_estimated_cost_usd: 0.001,
      },
    ]),
    'utf8',
  );
  writeFileSync(
    join(runDir, 'cost_ledger.json'),
    JSON.stringify({
      artifact_type: 'babel_cost_ledger',
      totals: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        estimated_cost_usd: 0.0123,
        by_precision: { exact: 0.0123, conservative: 0, unknown: 0 },
      },
    }),
    'utf8',
  );

  const stats = buildRunStats(runDir);
  assert.equal(stats.waterfall.total_latency_ms, 120);
  assert.equal(stats.tokens.total, 150);
  assert.equal(stats.tokens.estimated_cost_usd, 0.0123);
  assert.equal(stats.tokens.source, 'cost_ledger');
  assert.match(stats.tokens.cost_ledger_path ?? '', /cost_ledger\.json$/);
  assert.deepEqual(stats.tokens.by_precision, { exact: 0.0123, conservative: 0, unknown: 0 });
});

test('buildRunStats falls back to waterfall telemetry when cost_ledger has no totals', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-run-stats-ledger-empty-'));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '05_waterfall_telemetry.json'),
    JSON.stringify([
      {
        stage: 'orchestrator',
        total_prompt_tokens: 10,
        total_completion_tokens: 20,
        total_tokens: 30,
        total_estimated_cost_usd: 0.001,
      },
    ]),
    'utf8',
  );
  writeFileSync(
    join(runDir, 'cost_ledger.json'),
    JSON.stringify({ artifact_type: 'babel_cost_ledger' }),
    'utf8',
  );

  const stats = buildRunStats(runDir);
  assert.equal(stats.tokens.total, 30);
  assert.equal(stats.tokens.estimated_cost_usd, 0.001);
  assert.equal(stats.tokens.source, 'waterfall_telemetry');
  assert.equal(stats.tokens.cost_ledger_path, join(runDir, 'cost_ledger.json'));
});
