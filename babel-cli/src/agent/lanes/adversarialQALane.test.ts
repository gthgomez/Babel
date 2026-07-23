/**
 * adversarialQALane.test.ts — Unit tests for the adversarial QA module
 *
 * Phase 1B: Tests pickAdversarialModel, buildAdversarialReviewPrompt,
 * and synthesizeAdversarialResult as pure functions (no API mocking needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pickAdversarialModel,
  buildAdversarialReviewPrompt,
  synthesizeAdversarialResult,
} from './adversarialQALane.js';
import type { AdversarialQAInput } from './adversarialQALane.js';
import type { SwePlan, QaVerdictPass, QaVerdictReject } from '../../schemas/agentContracts.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeSwePlan(overrides: Partial<SwePlan> = {}): SwePlan {
  return {
    plan_version: '1.0',
    thinking: 'The fix is straightforward — change the operator in the subtract function.',
    task_summary: 'Fix the subtract function to return a + b instead of a - b',
    known_facts: ['The file src/math.js contains a subtract function using the - operator'],
    assumptions: ['The function should return the sum, not the difference'],
    risks: [
      {
        risk: 'May break callers expecting subtraction',
        likelihood: 'low',
        mitigation: 'Verify with tests',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Change - to + in subtract function',
        tool: 'file_write',
        target: 'src/math.js',
        rationale: 'Fixes the bug',
        reversible: true,
        verification: 'Run tests',
      },
    ],
    root_cause: 'subtract function used - instead of +',
    out_of_scope: ['Refactoring other functions', 'Adding new features'],
    ...overrides,
  };
}

function makePassVerdict(overrides: Partial<QaVerdictPass> = {}): QaVerdictPass {
  return {
    verdict: 'PASS',
    overall_confidence: 4,
    notes: 'Plan looks correct.',
    ...overrides,
  };
}

function makeRejectVerdict(overrides: Partial<QaVerdictReject> = {}): QaVerdictReject {
  const failures = overrides.failures ?? [
    {
      tag: 'SFDIPOT-P',
      condition: 'Plan writes to src/math.js without verifying current content',
      confidence: 4,
    },
  ];
  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 3,
    proposed_fix_strategy: 'Check current file content before writing.',
    ...overrides,
  };
}

function makeAdversarialInput(overrides: Partial<AdversarialQAInput> = {}): AdversarialQAInput {
  return {
    swePlan: makeSwePlan(),
    originalQaVerdict: makePassVerdict(),
    rawTask: 'Fix the subtract function',
    originalQaModel: 'deepseek',
    ...overrides,
  };
}

// ─── pickAdversarialModel ─────────────────────────────────────────────────────

test('pickAdversarialModel maps deepseek → step-flash', () => {
  assert.equal(pickAdversarialModel('deepseek'), 'step-flash');
});

test('pickAdversarialModel maps deepseek-v4 → step-flash', () => {
  assert.equal(pickAdversarialModel('deepseek-v4'), 'step-flash');
});

test('pickAdversarialModel maps all known models correctly', () => {
  assert.equal(pickAdversarialModel('qwen3'), 'deepseek-v4');
  assert.equal(pickAdversarialModel('qwen3-32b'), 'deepseek-v4');
  assert.equal(pickAdversarialModel('nemotron'), 'qwen3-32b');
  assert.equal(pickAdversarialModel('codex'), 'claude');
  assert.equal(pickAdversarialModel('claude'), 'gemini');
  assert.equal(pickAdversarialModel('gemini'), 'codex');
});

test('pickAdversarialModel returns undefined for unknown input', () => {
  assert.equal(pickAdversarialModel('unknown-model'), undefined);
});

test('pickAdversarialModel returns undefined for undefined input', () => {
  assert.equal(pickAdversarialModel(undefined), undefined);
});

test('pickAdversarialModel is case-insensitive', () => {
  assert.equal(pickAdversarialModel('DeepSeek'), 'step-flash');
  assert.equal(pickAdversarialModel('DEEPSEEK-V4'), 'step-flash');
  assert.equal(pickAdversarialModel('Claude'), 'gemini');
  assert.equal(pickAdversarialModel('GEMINI'), 'codex');
});

// ─── buildAdversarialReviewPrompt ──────────────────────────────────────────────

test('buildAdversarialReviewPrompt includes original PASS verdict note', () => {
  const input = makeAdversarialInput({ originalQaVerdict: makePassVerdict() });
  const prompt = buildAdversarialReviewPrompt(input);

  assert.ok(prompt.includes('You are the Adversarial QA Reviewer'));
  assert.ok(prompt.includes('Verdict: PASS'));
  assert.ok(prompt.includes('(none — original reviewer passed)'));
  assert.ok(prompt.includes('Actively try to REFUTE the plan'));
  assert.ok(prompt.includes('Fix the subtract function')); // rawTask in plan
});

test('buildAdversarialReviewPrompt includes original REJECT verdict failures', () => {
  const rejectVerdict = makeRejectVerdict({
    failures: [
      { tag: 'SFDIPOT-P', condition: 'Writes to unapproved file', confidence: 5 },
      { tag: 'NAMIT-I', condition: 'Uses stub value for API key', confidence: 4 },
    ],
  });
  const input = makeAdversarialInput({ originalQaVerdict: rejectVerdict });
  const prompt = buildAdversarialReviewPrompt(input);

  assert.ok(prompt.includes('Verdict: REJECT'));
  assert.ok(prompt.includes('SFDIPOT-P: Writes to unapproved file'));
  assert.ok(prompt.includes('NAMIT-I: Uses stub value for API key'));
  assert.ok(!prompt.includes('(none — original reviewer passed)'));
});

test('buildAdversarialReviewPrompt includes all six adversarial lines of questioning', () => {
  const input = makeAdversarialInput();
  const prompt = buildAdversarialReviewPrompt(input);

  assert.ok(prompt.includes('miss any security issues'));
  assert.ok(prompt.includes('cross-file type mismatches'));
  assert.ok(prompt.includes('stub/placeholder values'));
  assert.ok(prompt.includes('files not mentioned in the task'));
  assert.ok(prompt.includes('edge cases or failure modes'));
  assert.ok(prompt.includes('assumptions that are not grounded'));
});

test('buildAdversarialReviewPrompt includes serialized SWE plan', () => {
  const plan = makeSwePlan({ task_summary: 'Refactor the auth module' });
  const input = makeAdversarialInput({ swePlan: plan });
  const prompt = buildAdversarialReviewPrompt(input);

  assert.ok(prompt.includes('Refactor the auth module'));
  assert.ok(prompt.includes('src/math.js'));
});

// ─── synthesizeAdversarialResult ───────────────────────────────────────────────

test('synthesizeAdversarialResult detects new failures (foundNewIssues=true)', () => {
  const input = makeAdversarialInput({
    originalQaVerdict: makePassVerdict(),
  });
  const adversarialVerdict = makeRejectVerdict({
    failures: [
      {
        tag: 'SECURITY-INJECTION',
        condition: 'Plan injects unsanitized user input into eval',
        confidence: 5,
      },
    ],
  });

  const result = synthesizeAdversarialResult(input, adversarialVerdict);

  assert.equal(result.foundNewIssues, true);
  assert.equal(result.revisionNeeded, true);
  assert.equal(result.allFailures.length, 1);
  assert.equal(result.allFailures[0]!.tag, 'SECURITY-INJECTION');
});

test('synthesizeAdversarialResult with no new failures (foundNewIssues=false)', () => {
  const input = makeAdversarialInput({
    originalQaVerdict: makePassVerdict(),
  });
  const adversarialVerdict = makePassVerdict({ overall_confidence: 5 });

  const result = synthesizeAdversarialResult(input, adversarialVerdict);

  assert.equal(result.foundNewIssues, false);
  assert.equal(result.revisionNeeded, false);
  assert.equal(result.allFailures.length, 0);
});

test('synthesizeAdversarialResult combines original REJECT + adversarial PASS', () => {
  const originalFailure = {
    tag: 'SFDIPOT-P' as const,
    condition: 'Writes without verification',
    confidence: 4,
  };
  const input = makeAdversarialInput({
    originalQaVerdict: makeRejectVerdict({ failures: [originalFailure] }),
  });
  const adversarialVerdict = makePassVerdict();

  const result = synthesizeAdversarialResult(input, adversarialVerdict);

  // Original failures preserved, no new failures
  assert.equal(result.foundNewIssues, false);
  assert.equal(result.allFailures.length, 1);
  assert.equal(result.allFailures[0]!.tag, 'SFDIPOT-P');
  // Verdict should be REJECT because original had failures
  assert.equal(result.verdict.verdict, 'REJECT');
});

test('synthesizeAdversarialResult combines original PASS + adversarial REJECT', () => {
  const input = makeAdversarialInput({
    originalQaVerdict: makePassVerdict(),
  });
  const advFailure = {
    tag: 'NAMIT-T' as const,
    condition: 'Cross-file type mismatch in User/Profile',
    confidence: 4,
  };
  const adversarialVerdict = makeRejectVerdict({ failures: [advFailure] });

  const result = synthesizeAdversarialResult(input, adversarialVerdict);

  assert.equal(result.foundNewIssues, true);
  assert.equal(result.revisionNeeded, true);
  assert.equal(result.allFailures.length, 1);
  assert.equal(result.allFailures[0]!.tag, 'NAMIT-T');
});

test('synthesizeAdversarialResult deduplicates identical failures', () => {
  const sharedFailure = {
    tag: 'EVIDENCE-GATE' as const,
    condition: 'No test evidence provided',
    confidence: 5,
  };
  const input = makeAdversarialInput({
    originalQaVerdict: makeRejectVerdict({ failures: [sharedFailure] }),
  });
  const adversarialVerdict = makeRejectVerdict({ failures: [sharedFailure] });

  const result = synthesizeAdversarialResult(input, adversarialVerdict);

  // The identical failure should NOT be double-counted
  assert.equal(result.foundNewIssues, false);
  assert.equal(result.allFailures.length, 2); // original + adversarial both present
});

test('synthesizeAdversarialResult new failure count excludes identical matches', () => {
  const sharedFailure = {
    tag: 'SFDIPOT-P' as const,
    condition: 'Same condition text',
    confidence: 4,
  };
  const newFailure = { tag: 'NAMIT-I' as const, condition: 'Different condition', confidence: 5 };
  const input = makeAdversarialInput({
    originalQaVerdict: makeRejectVerdict({ failures: [sharedFailure] }),
  });
  // Adversarial finds the same failure PLUS a new one
  const adversarialVerdict = makeRejectVerdict({ failures: [sharedFailure, newFailure] });

  const result = synthesizeAdversarialResult(input, adversarialVerdict);

  assert.equal(result.foundNewIssues, true); // newFailure is new
  assert.equal(result.allFailures.length, 3); // 1 original + 2 adversarial = 3 total
});
