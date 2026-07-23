import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  formatLiveCliReliabilityCaseListHuman,
  isLiveHeavyReliabilityCase,
  listLiveCliReliabilityCases,
  runLiveCliReliabilityMatrix,
} from './liveCliReliabilityMatrix.js';
import {
  formatLiveCliReliabilityMatrixHelp,
  parseLiveCliReliabilityMatrixArgs,
} from './liveCliReliabilityMatrixCliArgs.js';

test('reliability matrix help and CLI aliases are stable', () => {
  const help = formatLiveCliReliabilityMatrixHelp();
  assert.match(help, /--help/);
  assert.match(help, /--list/);
  assert.match(help, /--json/);
  assert.match(help, /--artifact-dir/);

  const parsed = parseLiveCliReliabilityMatrixArgs([
    '--json',
    '--case',
    'autonomous_exact_file_create',
    '--artifact-dir',
    'artifacts/matrix',
    '--timeout-ms=5000',
  ]);

  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.caseFilter, ['autonomous_exact_file_create']);
  assert.equal(parsed.outputDir, 'artifacts/matrix');
  assert.equal(parsed.timeoutMs, 5000);
});

test('fast profile skips live_heavy cases and can pass release gate', () => {
  const fakeRoot = makeFakeCliRoot(`
console.log(JSON.stringify({ status: 'COMPLETE', run_dir: process.cwd() }));
`);
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-matrix-fast-profile-'));
  const report = runLiveCliReliabilityMatrix({
    babelCliRoot: fakeRoot,
    outputDir,
    profile: 'fast',
    caseFilter: ['required_verifier_all_pass_complete', 'failing_unit_test_repair'],
    timeoutMs: 2_000,
    now: new Date('2026-06-11T00:00:00.000Z'),
  });

  assert.equal(report.profile, 'fast');
  assert.equal(report.releaseGate, 'PASSED');
  assert.deepEqual(report.live_heavy_skipped_cases, ['failing_unit_test_repair']);
  const heavy = report.cases.find((testCase) => testCase.id === 'failing_unit_test_repair');
  assert.equal(heavy?.status, 'skipped');
  assert.equal(heavy?.pass, true);
});

test('live_heavy tagging covers autonomous repair cases', () => {
  assert.equal(isLiveHeavyReliabilityCase('failing_unit_test_repair'), true);
  assert.equal(isLiveHeavyReliabilityCase('required_verifier_all_pass_complete'), false);
});

test('reliability matrix case listing is parseable and includes stable case IDs', () => {
  const listing = listLiveCliReliabilityCases(new Date('2026-05-04T00:00:00.000Z'));
  assert.equal(listing.schema_version, 1);
  assert.equal(listing.report_type, 'babel_live_cli_reliability_case_list');
  assert.equal(listing.generated_at, '2026-05-04T00:00:00.000Z');
  assert.equal(
    listing.cases.some((testCase) => testCase.id === 'autonomous_exact_file_create'),
    true,
  );
  assert.equal(
    listing.cases.some((testCase) => testCase.id === 'required_verifier_missing_blocks_complete'),
    true,
  );
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(listing)));
  assert.match(formatLiveCliReliabilityCaseListHuman(listing), /autonomous_exact_file_create/);
});

test('case timeout writes case result and blocked matrix report', () => {
  const fakeRoot = makeFakeCliRoot('setTimeout(() => {}, 10_000);');
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-matrix-timeout-'));

  const report = runLiveCliReliabilityMatrix({
    babelCliRoot: fakeRoot,
    outputDir,
    caseFilter: ['autonomous_exact_file_create'],
    timeoutMs: 50,
    now: new Date('2026-05-02T00:00:00.000Z'),
  });

  assert.equal(report.final_status, 'TIMED_OUT');
  assert.equal(report.releaseGate, 'BLOCKED');
  assert.equal(report.summary.timed_out, 1);
  assert.equal(report.cases[0]?.status, 'timed_out');
  assert.equal(report.cases[0]?.pass, false);
  assert.ok(existsSync(report.artifact_path));
  assert.ok(existsSync(report.summary_path));
  assert.ok(existsSync(report.cases[0]?.artifact_path ?? ''));
  assert.ok(existsSync(report.cases[0]?.stdout_log_path ?? ''));
  assert.ok(existsSync(report.cases[0]?.stderr_log_path ?? ''));
  assert.doesNotThrow(() => JSON.parse(readFileSync(report.artifact_path, 'utf8')));
});

test('resume only-failed reruns timed-out case and preserves parseable report', () => {
  const fakeRoot = makeFakeCliRoot('setTimeout(() => {}, 10_000);');
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-matrix-resume-'));
  const first = runLiveCliReliabilityMatrix({
    babelCliRoot: fakeRoot,
    outputDir,
    caseFilter: ['autonomous_exact_file_create'],
    timeoutMs: 50,
    now: new Date('2026-05-02T00:01:00.000Z'),
  });

  writeFakeDistIndex(
    fakeRoot,
    `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const rootIndex = process.argv.indexOf('--project-root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'exact-status.txt'), 'autonomous exact ok', 'utf8');
console.log(JSON.stringify({ status: 'COMPLETE', run_dir: join(root, '.babel-run') }));
`,
  );

  const resumed = runLiveCliReliabilityMatrix({
    babelCliRoot: fakeRoot,
    resumeDir: first.matrix_root,
    onlyFailed: true,
    caseFilter: ['autonomous_exact_file_create'],
    timeoutMs: 2_000,
    now: new Date('2026-05-02T00:02:00.000Z'),
  });

  assert.equal(resumed.final_status, 'PASS');
  assert.equal(resumed.releaseGate, 'PASSED');
  assert.equal(resumed.summary.passed, 1);
  assert.equal(resumed.cases[0]?.status, 'passed');
  assert.equal(resumed.cases[0]?.actual_status, 'COMPLETE');
  assert.doesNotThrow(() => JSON.parse(readFileSync(resumed.artifact_path, 'utf8')));
});

function makeFakeCliRoot(distIndexSource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-fake-cli-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, '.env'), '', 'utf8');
  writeFakeDistIndex(root, distIndexSource);
  return root;
}

function writeFakeDistIndex(root: string, source: string): void {
  writeFileSync(join(root, 'dist', 'index.js'), `${source}\n`, 'utf8');
}
