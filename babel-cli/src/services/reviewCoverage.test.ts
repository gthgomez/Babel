import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReviewCoverage, isExcludableFile } from './reviewCoverage.js';

test('reviewCoverage: identifies lockfiles, binaries and generated files', () => {
  assert.equal(isExcludableFile('package-lock.json')?.reason, 'lockfile');
  assert.equal(isExcludableFile('assets/logo.png')?.reason, 'binary');
  assert.equal(isExcludableFile('dist/bundle.js')?.reason, 'generated');
  assert.equal(isExcludableFile('src/index.ts'), null);
});

test('reviewCoverage: derives coverage from tool execution traces', () => {
  const scope = ['src/agent/chat.ts', 'src/tools/read.ts', 'assets/image.png'];
  const traces = [
    { tool: 'read_file', targetPath: 'source/src/agent/chat.ts' },
    { tool: 'read_range', args: { path: 'src/tools/read.ts', start: 1, end: 50 } },
  ];

  const receipt = evaluateReviewCoverage({
    scope,
    toolTraces: traces,
    claimedReviewedFiles: ['src/agent/chat.ts', 'src/tools/read.ts', 'assets/image.png'],
  });

  assert.equal(receipt.changed_files_total, 3);
  assert.deepEqual(receipt.directly_inspected_files, ['src/agent/chat.ts', 'src/tools/read.ts']);
  assert.equal(receipt.excluded_files.length, 1);
  assert.equal(receipt.excluded_files[0]?.reason, 'binary');
  assert.equal(receipt.unaccounted_files.length, 0);
  assert.equal(receipt.is_sufficient, true);
  assert.equal(receipt.coverage_verdict, 'SUFFICIENT');
  assert.equal(receipt.observed_coverage_ratio, 1.0);
  assert.match(receipt.receipt_digest, /^[a-f0-9]{64}$/);
});

test('reviewCoverage: catches unaccounted files and emits INSUFFICIENT_REVIEW_COVERAGE', () => {
  const scope = ['src/auth/secret.ts', 'src/payment/gateway.ts'];
  const traces = [{ tool: 'read_file', targetPath: 'src/auth/secret.ts' }];

  const receipt = evaluateReviewCoverage({
    scope,
    toolTraces: traces,
    claimedReviewedFiles: ['src/auth/secret.ts', 'src/payment/gateway.ts'], // Model claimed both, but only inspected one!
  });

  assert.equal(receipt.unaccounted_files.length, 1);
  assert.equal(receipt.unaccounted_files[0], 'src/payment/gateway.ts');
  assert.equal(receipt.claimed_matches_observed, false);
  assert.equal(receipt.is_sufficient, false);
  assert.equal(receipt.coverage_verdict, 'INSUFFICIENT_REVIEW_COVERAGE');
});

test('reviewCoverage: exclusions record causal replacement evidence', () => {
  const lock = isExcludableFile('package-lock.json');
  assert.equal(lock?.reason, 'lockfile');
  assert.equal(lock?.replacement_evidence, 'dependency_audit_and_lockfile_integrity_gate');

  const bin = isExcludableFile('assets/model.bin');
  assert.equal(bin?.reason, 'binary');
  assert.equal(bin?.replacement_evidence, 'binary_sha256_manifest_and_size_attestation');

  const gen = isExcludableFile('dist/index.js');
  assert.equal(gen?.reason, 'generated');
  assert.equal(gen?.replacement_evidence, 'clean_build_and_source_generation_verification');
});

test('reviewCoverage: derives full diff coverage from observed read intervals', () => {
  const scope = ['src/a.ts', 'src/b.ts'];
  // Total diff has 100 lines. Reviewer reads 1-60 then 55-100.
  const traces = [
    { tool: 'read_range', targetPath: 'changes.diff', args: { start_line: 1, end_line: 60 } },
    { tool: 'read_range', targetPath: 'changes.diff', args: { start_line: 55, end_line: 100 } },
  ];

  const receipt = evaluateReviewCoverage({
    scope,
    toolTraces: traces,
    changesDiffTotalLines: 100,
  });

  assert.equal(receipt.is_sufficient, true);
  assert.equal(receipt.coverage_verdict, 'SUFFICIENT');
  assert.equal(receipt.diff_coverage_ratio, 1.0);
  assert.deepEqual(receipt.covered_by_diff_files, ['src/a.ts', 'src/b.ts']);
  assert.equal(receipt.unaccounted_files.length, 0);
});

test('reviewCoverage: partial diff intervals without full coverage leaves files unaccounted', () => {
  const scope = ['src/a.ts', 'src/b.ts'];
  // Total diff has 100 lines. Reviewer only reads lines 1-40.
  const traces = [
    { tool: 'read_range', targetPath: 'changes.diff', args: { start_line: 1, end_line: 40 } },
  ];

  const receipt = evaluateReviewCoverage({
    scope,
    toolTraces: traces,
    changesDiffTotalLines: 100,
  });

  assert.equal(receipt.is_sufficient, false);
  assert.equal(receipt.coverage_verdict, 'INSUFFICIENT_REVIEW_COVERAGE');
  assert.equal(receipt.diff_coverage_ratio, 0.4);
  assert.equal(receipt.unaccounted_files.length, 2);
});

