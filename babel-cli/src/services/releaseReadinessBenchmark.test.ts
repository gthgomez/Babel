import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runReleaseReadinessBenchmark } from './releaseReadinessBenchmark.js';

test('release readiness emits schema v2 without machine paths or broad claims', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-readiness-'));
  try {
    const report = runReleaseReadinessBenchmark({
      now: new Date('2026-07-22T12:00:00.000Z'),
      outputDir: root,
      gateRunner: () => ({ exitCode: 0 }),
    });
    assert.equal(report.schema_version, 2);
    assert.equal(report.benchmark_type, 'babel_cli_release_readiness');
    assert.equal(report.claim_status, 'release_checks_passed');
    assert.equal(report.summary.pass, 5);
    assert.match(report.artifact_path, /^<external-output>\//);
    const serialized = readFileSync(join(root, 'release-readiness-20260722T120000Z.json'), 'utf8');
    assert.doesNotMatch(serialized, /production-ready|Codex|Claude|Gemini|Aider|OpenHands|Cursor/i);
    assert.doesNotMatch(serialized, /[A-Z]:[\\/]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release readiness blocks claims when any current repository gate fails', () => {
  let index = 0;
  const root = mkdtempSync(join(tmpdir(), 'babel-readiness-fail-'));
  try {
    const report = runReleaseReadinessBenchmark({
      outputDir: root,
      gateRunner: () => ({ exitCode: index++ === 2 ? 1 : 0 }),
    });
    assert.equal(report.claim_status, 'release_checks_blocked');
    assert.equal(report.summary.fail, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
