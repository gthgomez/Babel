import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveReviewCertifyExitCode,
  loadCandidateReviewHandoffs,
  handoffEvidenceToCodeReviewReceipt,
} from './independentReviewCommands.js';

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

test('loadCandidateReviewHandoffs discovers handoffs from stateDir and gh comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-handoffs-'));
  try {
    const candidateDigest = 'a'.repeat(64);
    const jobDir = join(dir, 'jobs', candidateDigest);
    mkdirSync(jobDir, { recursive: true });

    const mockHandoff = {
      schema_version: 2,
      kind: 'host_review_handoff_v2',
      repository: 'gthgomez/Babel',
      pr_number: 42,
      base_sha: '1'.repeat(40),
      head_sha: '2'.repeat(40),
      task_id: 't-1',
      task_hash: '3'.repeat(64),
      controller_run_id: 'c-1',
      reviews: [{
        schema_version: 2,
        kind: 'autonomous_review_evidence_v2',
        repository: 'gthgomez/Babel',
        pr_number: 42,
        base_sha: '1'.repeat(40),
        head_sha: '2'.repeat(40),
        task_id: 't-1',
        task_hash: '3'.repeat(64),
        builder_id: 'builder-1',
        diff_numstat_digest: '4'.repeat(64),
        reviewer_id: 'reviewer-1',
        reviewer_class: 'independent_readonly_ai',
        execution_id: 'e-1',
        review_provider: 'opencode-go',
        reviewer_model: 'mimo-v2.5',
        review_mode: 'exact_diff',
        reviewed_at: '2026-09-08T12:00:00.000Z',
        scope: ['src/math.ts'],
        verdict: 'APPROVE',
        findings: [],
        blocking_findings: [],
        isolation: {
          mode: 'readonly_sandbox',
          candidate_write: false,
          github_mutation: false,
          merge: false,
          controller_state_access: false,
        },
      }],
    };

    writeFileSync(join(jobDir, 'mimo-v2.5-handoff.json'), JSON.stringify(mockHandoff), 'utf8');

    const discovered = loadCandidateReviewHandoffs({
      repository: 'gthgomez/Babel',
      candidateDigest,
      stateDir: dir,
    });

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.reviews[0]?.reviewer_model, 'mimo-v2.5');
    assert.equal(discovered[0]?.reviews[0]?.verdict, 'APPROVE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoffEvidenceToCodeReviewReceipt constructs valid CodeReviewReceipt with findings and coverage', () => {
  const evidence: any = {
    schema_version: 2,
    kind: 'autonomous_review_evidence_v2',
    repository: 'gthgomez/Babel',
    pr_number: 42,
    base_sha: '1'.repeat(40),
    head_sha: '2'.repeat(40),
    task_id: 't-1',
    task_hash: '3'.repeat(64),
    builder_id: 'builder-1',
    diff_numstat_digest: '4'.repeat(64),
    reviewer_id: 'reviewer-1',
    reviewer_class: 'independent_readonly_ai',
    execution_id: 'e-1',
    review_provider: 'opencode-go',
    reviewer_model: 'mimo-v2.5',
    review_mode: 'exact_diff',
    reviewed_at: '2026-09-08T12:00:00.000Z',
    scope: ['src/math.ts'],
    verdict: 'BLOCK',
    findings: ['Potential divide by zero in src/math.ts:42'],
    blocking_findings: ['Potential divide by zero in src/math.ts:42'],
    isolation: {
      mode: 'readonly_sandbox',
      candidate_write: false,
      github_mutation: false,
      merge: false,
      controller_state_access: false,
    },
    changes_diff_fully_read: true,
  };

  const receipt = handoffEvidenceToCodeReviewReceipt(evidence, 'a'.repeat(64));
  assert.equal(receipt.verdict, 'BLOCK');
  assert.equal(receipt.findings.length, 1);
  assert.equal(receipt.blocking_findings.length, 1);
  assert.equal(receipt.findings[0]?.location.path, 'src/math.ts');
  assert.equal(receipt.findings[0]?.location.line, 42);
  assert.equal(receipt.independence.computed_class, 'I2');
  assert.equal(receipt.coverage.coverage_verdict, 'SUFFICIENT');

  // Without diff read or tool traces, coverage must fail closed as INSUFFICIENT_REVIEW_COVERAGE
  const uncoveredEvidence = { ...evidence, changes_diff_fully_read: undefined };
  const uncoveredReceipt = handoffEvidenceToCodeReviewReceipt(uncoveredEvidence, 'a'.repeat(64));
  assert.equal(uncoveredReceipt.coverage.coverage_verdict, 'INSUFFICIENT_REVIEW_COVERAGE');

  // Without isolation, independence must fail closed as I0
  const unisolatedEvidence = { ...evidence, isolation: { ...evidence.isolation, candidate_write: true } };
  const unisolatedReceipt = handoffEvidenceToCodeReviewReceipt(unisolatedEvidence, 'a'.repeat(64));
  assert.equal(unisolatedReceipt.independence.computed_class, 'I0');

  // Controller state leakage must fail closed as I0
  const controllerLeakedEvidence = { ...evidence, isolation: { ...evidence.isolation, controller_state_access: true } };
  const controllerLeakedReceipt = handoffEvidenceToCodeReviewReceipt(controllerLeakedEvidence, 'a'.repeat(64));
  assert.equal(controllerLeakedReceipt.independence.computed_class, 'I0');
});

test('loadCandidateReviewHandoffs authenticates gh comment authors against repo owner', () => {
  const marker = '<!-- babel-controller-ai-reviews-v2 -->';
  const mockHandoff = {
    schema_version: 2,
    kind: 'host_review_handoff_v2',
    repository: 'gthgomez/Babel',
    pr_number: 42,
    base_sha: '1'.repeat(40),
    head_sha: '2'.repeat(40),
    task_id: 't-1',
    task_hash: '3'.repeat(64),
    controller_run_id: 'c-1',
    reviews: [],
  };

  const fakeGhExec = (args: string[]) => {
    if (args.includes('repos/gthgomez/Babel')) {
      return JSON.stringify({ owner: { id: 12345, login: 'gthgomez' } });
    }
    if (args.some((a) => a.includes('comments'))) {
      return JSON.stringify([
        {
          user: { id: 99999, login: 'attacker' },
          body: marker + JSON.stringify(mockHandoff),
        },
        {
          user: { id: 12345, login: 'gthgomez' },
          body: marker + JSON.stringify(mockHandoff),
        },
      ]);
    }
    return '[]';
  };

  const discovered = loadCandidateReviewHandoffs({
    repository: 'gthgomez/Babel',
    candidateDigest: 'a'.repeat(64),
    prNumber: 42,
    ghExec: fakeGhExec,
  });

  // Only the comment from owner (12345) should be accepted, spoofed comment (99999) must be ignored
  assert.equal(discovered.length, 1);
});

test('command-level: review bench runs and verifies anti-leakage via CLI', () => {
  const stdout = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts', 'review', 'bench', '--json'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.anti_leakage_verified, true);
  assert.equal(parsed.total_fixtures, 10);
  assert.equal(parsed.categories.clean_control, 5);
});
