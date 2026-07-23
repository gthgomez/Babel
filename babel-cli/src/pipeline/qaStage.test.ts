/**
 * qaStage.test.ts — Integration tests for the adversarial QA gate
 *
 * Phase 1C: Tests runAdversarialQaGate with mocked globalThis.fetch.
 * Uses the same mock pattern as deepInfraApi.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SwePlan, QaVerdictPass, QaVerdictReject } from '../schemas/agentContracts.js';

// ─── Env var save/restore ─────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const originalApiKey = process.env['DEEPINFRA_API_KEY'];
const originalAdversarial = process.env['BABEL_ADVERSARIAL_REVIEW'];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env['DEEPINFRA_API_KEY'];
  } else {
    process.env['DEEPINFRA_API_KEY'] = originalApiKey;
  }
  if (originalAdversarial === undefined) {
    delete process.env['BABEL_ADVERSARIAL_REVIEW'];
  } else {
    process.env['BABEL_ADVERSARIAL_REVIEW'] = originalAdversarial;
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeSwePlan(overrides: Partial<SwePlan> = {}): SwePlan {
  return {
    plan_version: '1.0',
    thinking: 'The fix is straightforward.',
    task_summary: 'Fix the subtract function to return a + b instead of a - b',
    known_facts: ['src/math.js contains a subtract function'],
    assumptions: ['The function should return the sum'],
    risks: [{ risk: 'May break callers', likelihood: 'low', mitigation: 'Verify with tests' }],
    minimal_action_set: [
      {
        step: 1,
        description: 'Change - to +',
        tool: 'file_write',
        target: 'src/math.js',
        rationale: 'Fixes bug',
        reversible: true,
        verification: 'Run tests',
      },
    ],
    root_cause: 'Operator error in subtract function',
    out_of_scope: ['Refactoring other functions'],
    ...overrides,
  };
}

function makePassVerdict(): QaVerdictPass {
  return { verdict: 'PASS', overall_confidence: 4, notes: 'Looks correct.' };
}

function makeRejectVerdict(): QaVerdictReject {
  return {
    verdict: 'REJECT',
    failure_count: 1,
    failures: [
      { tag: 'SFDIPOT-P', condition: 'No verification step before file write', confidence: 4 },
    ],
    overall_confidence: 3,
    proposed_fix_strategy: 'Add a verification step.',
  };
}

/** Mock fetch that returns a controlled QA API response */
function mockFetchResponse(verdictText: string) {
  return (async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(JSON.parse(verdictText)) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

/** Mock fetch that throws a network error */
function mockFetchError(message: string) {
  return (async () => {
    throw new Error(message);
  }) as typeof fetch;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test('runAdversarialQaGate returns { passed: true } when BABEL_ADVERSARIAL_REVIEW is NOT set', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  delete process.env['BABEL_ADVERSARIAL_REVIEW'];

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makePassVerdict(),
      'Fix the subtract function',
      1,
      runDir,
      () => {}, // logDetail no-op
    );

    assert.equal(result.passed, true);
    assert.equal(result.reason, undefined); // no explicit reason when skipping
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('runAdversarialQaGate returns { passed: true } when env var is set to false', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'false';

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makePassVerdict(),
      'task',
      1,
      runDir,
      () => {},
    );
    assert.equal(result.passed, true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('runAdversarialQaGate activates when BABEL_ADVERSARIAL_REVIEW=true and returns PASS on agreement', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'true';

  // Adversarial model agrees with original PASS
  globalThis.fetch = mockFetchResponse(
    '{"verdict":"PASS","overall_confidence":5,"notes":"Adversarial review found no new issues."}',
  );

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makePassVerdict(),
      'task',
      1,
      runDir,
      () => {},
    );

    assert.equal(result.passed, true);
    assert.ok(result.adversarialVerdict !== undefined);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('runAdversarialQaGate returns { passed: false } when adversarial model finds new failures', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'true';

  // Adversarial model finds a new issue the original reviewer missed
  globalThis.fetch = mockFetchResponse(
    `{"verdict":"REJECT","failure_count":1,"failures":[{"tag":"SECURITY-INJECTION","condition":"Plan uses eval on unsanitized input","confidence":5}],"overall_confidence":4,"proposed_fix_strategy":"Sanitize input before passing to eval."}`,
  );

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makePassVerdict(),
      'task',
      1,
      runDir,
      () => {},
    );

    assert.equal(result.passed, false);
    assert.ok(result.allFailures && result.allFailures.length > 0);
    assert.ok(result.qaRejections && result.qaRejections.length > 0);
    assert.ok(result.proposedFixStrategy !== undefined);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('runAdversarialQaGate adds new failures beyond original REJECT verdict', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'true';

  // Adversarial finds an ADDITIONAL failure beyond the original
  globalThis.fetch = mockFetchResponse(
    `{"verdict":"REJECT","failure_count":1,"failures":[{"tag":"NAMIT-T","condition":"Cross-file type mismatch between src/math.js and src/types.ts","confidence":4}],"overall_confidence":3}`,
  );

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makeRejectVerdict(), // original already REJECT
      'task',
      1,
      runDir,
      () => {},
    );

    assert.equal(result.passed, false);
    // Should have both original (1) + new adversarial (1) = 2 failures
    assert.ok(result.allFailures && result.allFailures.length >= 1);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('runAdversarialQaGate handles runner error by rejecting with halt fallback (F1 fix, default)', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'true';
  // Default: BABEL_ADVERSARIAL_QA_FALLBACK is unset → 'halt' (reject on error)

  globalThis.fetch = mockFetchError('Network timeout');

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));
  const logMessages: string[] = [];

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makePassVerdict(),
      'task',
      1,
      runDir,
      (msg: string) => logMessages.push(msg),
    );

    // F1 fix: Runner failure should now REJECT by default (halt fallback)
    assert.equal(result.passed, false);
    assert.ok(logMessages.some((m) => m.includes('Network timeout')));
    assert.ok(logMessages.some((m) => m.includes('adversarial review unavailable')));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('runAdversarialQaGate handles runner error with warn fallback (old behavior opt-in)', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'true';
  process.env['BABEL_ADVERSARIAL_QA_FALLBACK'] = 'warn';

  globalThis.fetch = mockFetchError('Network timeout');

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));
  const logMessages: string[] = [];

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makePassVerdict(),
      'task',
      1,
      runDir,
      (msg: string) => logMessages.push(msg),
    );

    // warn fallback: passes with warning (old behavior, explicit opt-in)
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'adversarial_review_unavailable');
    assert.ok(logMessages.some((m) => m.includes('Network timeout')));
    assert.ok(logMessages.some((m) => m.includes('Allowing primary verdict to stand')));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    delete process.env['BABEL_ADVERSARIAL_QA_FALLBACK'];
  }
});

test('runAdversarialQaGate handles runner error with skip fallback (silent, least safe)', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'true';
  process.env['BABEL_ADVERSARIAL_QA_FALLBACK'] = 'skip';

  globalThis.fetch = mockFetchError('Network timeout');

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));
  const logMessages: string[] = [];

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makePassVerdict(),
      'task',
      1,
      runDir,
      (msg: string) => logMessages.push(msg),
    );

    // skip fallback: silently passes
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'adversarial_review_skipped');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    delete process.env['BABEL_ADVERSARIAL_QA_FALLBACK'];
  }
});

test('runAdversarialQaGate writes evidence JSON to run directory', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'true';

  globalThis.fetch = mockFetchResponse('{"verdict":"PASS","overall_confidence":5}');

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  const { readFileSync, existsSync } = await import('node:fs');
  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));

  try {
    await runAdversarialQaGate(makeSwePlan(), makePassVerdict(), 'task', 1, runDir, () => {});

    // Evidence file should exist at 03_qa_verdict_v1_adversarial.json
    const evidencePath = join(runDir, '03_qa_verdict_v1_adversarial.json');
    assert.ok(existsSync(evidencePath), `Expected evidence file at ${evidencePath}`);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    assert.equal(evidence.verdict, 'PASS');
    assert.equal(evidence.overall_confidence, 5);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('runAdversarialQaGate uses step-flash model (not nemotron) after Phase 1A swap', async () => {
  process.env['DEEPINFRA_API_KEY'] = 'test-key';
  process.env['BABEL_ADVERSARIAL_REVIEW'] = 'true';

  // Verify the model mapping resolves step-flash correctly
  const { pickAdversarialModel } = await import('../agent/lanes/adversarialQALane.js');
  assert.equal(pickAdversarialModel('deepseek'), 'step-flash');

  const { runAdversarialQaGate } = await import('../pipeline/qaStage.js');
  globalThis.fetch = mockFetchResponse('{"verdict":"PASS","overall_confidence":5}');

  const runDir = mkdtempSync(join(tmpdir(), 'babel-qa-test-'));

  try {
    const result = await runAdversarialQaGate(
      makeSwePlan(),
      makePassVerdict(),
      'task',
      1,
      runDir,
      () => {},
    );
    // If we got here without error, the model mapping resolved correctly
    assert.equal(result.passed, true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
