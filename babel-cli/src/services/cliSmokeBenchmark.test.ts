import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCliSmokeBenchmark } from './cliSmokeBenchmark.js';

test('CLI smoke benchmark dry run records Babel, Lite, and do cases without provider calls', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-cli-smoke-'));
  try {
    const report = runCliSmokeBenchmark({
      live: false,
      modes: ['babel', 'bl', 'do'],
      outputDir,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    assert.equal(report.report_type, 'babel_cli_smoke_benchmark');
    assert.equal(report.live, false);
    assert.equal(report.summary.total, 22);
    assert.equal(report.summary.skipped, 22);
    assert.equal(report.cases.some(testCase => testCase.id === 'babel_read_only_repo_question'), true);
    assert.equal(report.cases.some(testCase => testCase.id === 'babel_bare_read_only_repo_question'), true);
    assert.equal(report.cases.some(testCase => testCase.id === 'babel_bare_inferred_one_file_bug_fix'), true);
    assert.equal(report.cases.some(testCase => testCase.id === 'bl_do_read_only_repo_question'), true);
    assert.equal(report.cases.some(testCase => testCase.id === 'bl_do_one_file_bug_fix'), true);
    assert.equal(report.cases.some(testCase => testCase.id === 'bl_small_refactor'), true);
    assert.equal(report.cases.some(testCase => testCase.id === 'do_one_file_bug_fix'), true);
    assert.equal(report.cases.some(testCase => testCase.id === 'do_provider_schema_recovery'), true);
    assert.equal(report.cases.some(testCase => testCase.id === 'do_verifier_failure_resume'), true);
    assert.equal(report.cases.every(testCase => testCase.scenario_id.length > 0), true);
    assert.equal(report.cases.every(testCase => testCase.expected_statuses.length > 0), true);
    assert.equal(report.cases.every(testCase => testCase.required_fields.length > 0), true);
    assert.equal(report.cases.every(testCase => testCase.missing_fields.length === 0), true);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
