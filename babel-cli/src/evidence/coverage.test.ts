import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCoverageManifest,
  coverageCoversPath,
  coverageIsWholeWorkspace,
  coverageWarnings,
  unknownCoverageManifest,
  validateCoverageManifest,
  type CoverageManifestV1,
} from './coverage.js';

const LIMITS = { max_files: 100, max_file_bytes: 1_000_000, capture_strategy: 'bounded_scan' };

function repositoryManifest(
  overrides: Partial<Parameters<typeof buildCoverageManifest>[0]> = {},
): CoverageManifestV1 {
  return buildCoverageManifest({
    scope: { kind: 'repository' },
    limits: LIMITS,
    baseline: { git_commit_hash: null, git_binding: 'optional', dirty: false, untracked: [] },
    captured_at: 1_700_000_000_000,
    ...overrides,
  });
}

test('P07 coverage: file beyond bounded capture makes completeness explicit and partial', () => {
  const manifest = repositoryManifest({
    exclusions: [{ path: 'huge/generated.json', reason: 'bounded_capture' }],
  });
  assert.equal(manifest.completeness, 'partial');
  assert.equal(coverageIsWholeWorkspace(manifest), false);
  assert.ok(coverageWarnings(manifest).includes('excluded:bounded_capture:huge/generated.json'));
  assert.deepEqual(validateCoverageManifest(manifest), []);
});

test('P07 coverage: skipped and unreadable paths stay excluded, never silently included', () => {
  const manifest = repositoryManifest({
    exclusions: [
      { path: 'src/legacy.ts', reason: 'skipped' },
      { path: 'src/broken.ts', reason: 'unreadable' },
    ],
  });
  assert.equal(manifest.completeness, 'partial');
  assert.equal(coverageCoversPath(manifest, 'src/legacy.ts'), false);
  assert.equal(coverageCoversPath(manifest, 'src/broken.ts'), false);
  const warnings = coverageWarnings(manifest);
  assert.ok(warnings.includes('excluded:skipped:src/legacy.ts'));
  assert.ok(warnings.includes('excluded:unreadable:src/broken.ts'));
});

test('P07 coverage: a dirty workspace is never a whole-workspace certificate', () => {
  const manifest = repositoryManifest({
    baseline: { git_commit_hash: 'a'.repeat(40), git_binding: 'required', dirty: true, untracked: ['new.ts'] },
  });
  assert.equal(manifest.completeness, 'complete');
  assert.equal(coverageIsWholeWorkspace(manifest), false);
  const warnings = coverageWarnings(manifest);
  assert.ok(warnings.includes('dirty_baseline'));
  assert.ok(warnings.includes('untracked_baseline'));
});

test('P07 coverage: a clean, complete repository scope is the only whole-workspace claim', () => {
  const manifest = repositoryManifest();
  assert.equal(coverageIsWholeWorkspace(manifest), true);
  assert.deepEqual(coverageWarnings(manifest), []);
  assert.deepEqual(validateCoverageManifest(manifest), []);
});

test('P07 coverage: digest is a scoped claim and tampering with the body is detected', () => {
  const manifest = repositoryManifest();
  const tampered = { ...manifest, completeness: 'partial' as const };
  assert.deepEqual(validateCoverageManifest(tampered), ['coverage_digest']);
});

test('P07 coverage: legacy evidence resolves to explicit unknown coverage', () => {
  const manifest = unknownCoverageManifest('legacy_run_without_coverage');
  assert.equal(manifest.completeness, 'unknown');
  assert.equal(manifest.scope.kind, 'unknown');
  assert.equal(coverageIsWholeWorkspace(manifest), false);
  assert.equal(coverageCoversPath(manifest, 'src/a.ts'), false);
  assert.ok(coverageWarnings(manifest).includes('coverage_unknown'));
  assert.deepEqual(validateCoverageManifest(manifest), []);
});
