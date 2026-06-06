import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runParityBenchmark, type ParityToolResult } from './parityBenchmark.js';

test('parity benchmark defaults to manual-required cells and blocks claims', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-parity-benchmark-'));
  const report = runParityBenchmark({
    outputDir,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(report.benchmark_type, 'babel_cli_phase12_parity');
  assert.equal(report.summary.tasks, 8);
  assert.equal(report.summary.result_cells, 24);
  assert.equal(report.summary.measured_cells, 0);
  assert.equal(report.summary.manual_required, 24);
  assert.equal(report.summary.claim_ready, false);
  assert.equal(report.comparisons.length, 16);
  assert.equal(report.truthful_gap_list.some((gap) => gap.includes('inconclusive')), true);

  const written = JSON.parse(readFileSync(report.artifact_path, 'utf8')) as { benchmark_type?: string };
  assert.equal(written.benchmark_type, 'babel_cli_phase12_parity');
});

test('parity benchmark can ingest measured fixture results and compute claim readiness', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-parity-benchmark-'));
  const tasks = [
    'small_bug_fix',
    'failing_test_repair',
    'multi_file_refactor',
    'docs_grounded_dependency_update',
    'issue_pr_context_implementation',
    'ui_browser_inspection',
    'checkpoint_restore_recovery',
    'read_only_subagent_review',
  ];
  const results: ParityToolResult[] = tasks.flatMap((taskId, index) => [
    {
      task_id: taskId,
      tool: 'babel',
      status: 'success',
      verifier: 'pass',
      false_complete: false,
      latency_ms: 1000 + index,
      cost_usd: 0.01,
      token_count: 1000,
      changed_files: ['src/example.ts'],
      user_interventions: 1,
      evidence_path: `runs/parity/${taskId}/babel.json`,
      notes: [],
    },
    {
      task_id: taskId,
      tool: 'codex',
      status: index === 0 ? 'failure' : 'success',
      verifier: index === 0 ? 'fail' : 'pass',
      false_complete: false,
      latency_ms: 1200 + index,
      cost_usd: 0.02,
      token_count: 1200,
      changed_files: ['src/example.ts'],
      user_interventions: 1,
      evidence_path: `runs/parity/${taskId}/codex.json`,
      notes: [],
    },
    {
      task_id: taskId,
      tool: 'claude_code',
      status: 'success',
      verifier: 'pass',
      false_complete: false,
      latency_ms: 1300 + index,
      cost_usd: 0.03,
      token_count: 1300,
      changed_files: ['src/example.ts'],
      user_interventions: 1,
      evidence_path: `runs/parity/${taskId}/claude.json`,
      notes: [],
    },
  ]);
  const fixturePath = join(outputDir, 'fixture.json');
  writeFileSync(fixturePath, `${JSON.stringify({ results }, null, 2)}\n`, 'utf8');

  const report = runParityBenchmark({
    outputDir,
    fixturePath,
    now: new Date('2026-06-05T00:00:00.000Z'),
  });

  assert.equal(report.summary.measured_cells, 24);
  assert.equal(report.summary.manual_required, 0);
  assert.equal(report.summary.claim_ready, true);
  assert.equal(report.comparisons.some((comparison) => comparison.verdict === 'babel_stronger'), true);
});
