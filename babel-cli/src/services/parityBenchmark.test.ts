import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  mergeParityFixtureInputs,
  readParityFixtureFile,
  runParityBenchmark,
  type ParityToolResult,
} from './parityBenchmark.js';

function sampleParityCell(taskId: string, tool: ParityToolResult['tool']): ParityToolResult {
  return {
    task_id: taskId,
    tool,
    status: 'success',
    verifier: 'pass',
    false_complete: false,
    latency_ms: 1000,
    cost_usd: 0.01,
    token_count: 1000,
    changed_files: ['src/example.ts'],
    user_interventions: 0,
    evidence_path: `runs/parity/${taskId}-${tool}.json`,
    notes: [],
  };
}

test('mergeParityFixtureInputs dedupes overlapping cells with last-wins', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-parity-merge-'));
  const firstPath = join(outputDir, 'first.json');
  const secondPath = join(outputDir, 'second.json');
  writeFileSync(
    firstPath,
    `${JSON.stringify(
      {
        results: [sampleParityCell('small_bug_fix', 'babel')],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    secondPath,
    `${JSON.stringify(
      {
        results: [
          {
            ...sampleParityCell('small_bug_fix', 'babel'),
            latency_ms: 2500,
            notes: ['live rerun'],
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const merged = mergeParityFixtureInputs([firstPath, secondPath]);
  assert.equal(merged.summary.input_files, 2);
  assert.equal(merged.summary.input_cells, 2);
  assert.equal(merged.summary.merged_cells, 1);
  assert.equal(merged.summary.duplicates_overwritten, 1);
  assert.equal(merged.results[0]?.latency_ms, 2500);
  assert.deepEqual(merged.results[0]?.notes, ['live rerun']);
});

test('mergeParityFixtureInputs returns empty results for empty inputs', () => {
  const merged = mergeParityFixtureInputs([]);
  assert.deepEqual(merged.results, []);
  assert.equal(merged.summary.merged_cells, 0);
});

test('readParityFixtureFile rejects invalid fixture schema', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-parity-merge-invalid-'));
  const fixturePath = join(outputDir, 'invalid.json');
  writeFileSync(
    fixturePath,
    `${JSON.stringify({ results: [{ task_id: 'x' }] }, null, 2)}\n`,
    'utf8',
  );
  assert.throws(() => readParityFixtureFile(fixturePath));
});

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
  assert.equal(
    report.truthful_gap_list.some((gap) => gap.includes('inconclusive')),
    true,
  );

  const written = JSON.parse(readFileSync(report.artifact_path, 'utf8')) as {
    benchmark_type?: string;
  };
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
  assert.equal(
    report.comparisons.some((comparison) => comparison.verdict === 'babel_stronger'),
    true,
  );
});
