import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveReviewCertifyExitCode } from './independentReviewCommands.js';

// ── Exit-code taxonomy (unit) ────────────────────────────────────────────────
// Invariant: exit 0 means the requested trusted success state (CERTIFIED) was
// achieved — never merely that the state machine ran without crashing.

test('review certify exit code is 0 only for CERTIFIED', () => {
  assert.equal(resolveReviewCertifyExitCode('CERTIFIED'), 0);
});

test('reviewer rejection (REPAIR_REQUIRED) exits 2', () => {
  assert.equal(resolveReviewCertifyExitCode('REPAIR_REQUIRED'), 2);
});

test('configuration and external blockers exit 3', () => {
  for (const status of [
    'REVIEWER_CONFIGURATION_REQUIRED',
    'REVIEW_ORCHESTRATOR_REQUIRED',
    'ISSUER_CONFIGURATION_REQUIRED',
    'SUPERVISOR_CONFIGURATION_REQUIRED',
    'STOPPED_EXTERNAL_CAPABILITY',
    'STOPPED_AMBIGUOUS_OBJECTIVE',
  ] as const) {
    assert.equal(resolveReviewCertifyExitCode(status), 3, status);
  }
});

test('verification and certification-lifecycle states exit 4', () => {
  for (const status of ['CERTIFICATION_RETRY_REQUIRED', 'READY_FOR_TRUST_VERIFICATION'] as const) {
    assert.equal(resolveReviewCertifyExitCode(status), 4, status);
  }
});

test('unknown non-certified terminal state fails closed with exit 1', () => {
  assert.equal(resolveReviewCertifyExitCode('SOMETHING_NEW'), 1);
});

// ── Command-level behavior (spawn the real CLI) ─────────────────────────────

function writeFixtures(dir: string, verdict: 'PASS' | 'FAIL'): { candidate: string; reviewResult: string } {
  const candidate = {
    repository: 'gthgomez/Babel',
    task_id: 'task-1',
    run_id: 'run-1',
    contract_hash: 'c'.repeat(64),
    base_sha: '1'.repeat(40),
    head_sha: '2'.repeat(40),
    builder_id: 'codex-implementation',
    reviewed_scope: { kind: 'repository' },
  };
  const reviewResult = {
    repository: 'gthgomez/Babel',
    base_sha: '1'.repeat(40),
    head_sha: '2'.repeat(40),
    builder_identity: 'codex-implementation',
    reviewer_identity: 'isolated-readonly-reviewer-a',
    reviewer_model: 'test-model',
    review_provider: 'fixture',
    review_mode: 'independent-read-only',
    verdict,
    blocking_findings: verdict === 'FAIL' ? ['the change is incorrect'] : [],
    non_blocking_findings: [],
    tests_considered: [],
    reviewed_at: '2026-09-05T10:00:00.000Z',
  };
  const candidatePath = join(dir, `candidate-${verdict}.json`);
  const reviewPath = join(dir, `review-${verdict}.json`);
  writeFileSync(candidatePath, JSON.stringify(candidate, null, 2), 'utf-8');
  writeFileSync(reviewPath, JSON.stringify(reviewResult, null, 2), 'utf-8');
  return { candidate: candidatePath, reviewResult: reviewPath };
}

function runCertify(fixture: { candidate: string; reviewResult: string }): { code: number; stdout: string } {
  // Assert on the actual command-level behavior: spawn the real CLI. The
  // fixture-only flags keep this deterministic and offline; no trusted
  // services are configured, so no key custody or network is involved.
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'review', 'certify', '--candidate', fixture.candidate, '--review-result', fixture.reviewResult, '--json'],
      { encoding: 'utf8', env: { ...process.env, BABEL_REVIEW_PROVENANCE_SIGNER: '', BABEL_TRUSTED_REVIEW_ISSUER: '', BABEL_TRUSTED_REVIEW_VERIFIER: '' }, timeout: 120_000 },
    );
    return { code: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

test('command-level: reviewer FAIL produces REPAIR_REQUIRED and nonzero exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-certify-fail-'));
  try {
    const result = runCertify(writeFixtures(dir, 'FAIL'));
    assert.equal(result.code, 2, `stdout: ${result.stdout}`);
    assert.match(result.stdout, /REPAIR_REQUIRED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('command-level: PASS without issuer produces ISSUER_CONFIGURATION_REQUIRED and nonzero exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-certify-pass-'));
  try {
    const result = runCertify(writeFixtures(dir, 'PASS'));
    assert.equal(result.code, 3, `stdout: ${result.stdout}`);
    assert.match(result.stdout, /ISSUER_CONFIGURATION_REQUIRED/);
    // The shell exit must never imply certification success when the body
    // reports a non-certified status.
    assert.doesNotMatch(result.stdout, /"status":\s*"CERTIFIED"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
