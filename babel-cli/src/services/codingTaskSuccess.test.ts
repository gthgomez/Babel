import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyCodingTaskGate,
  isCodingTaskSuccess,
  isEarlyOrPolicyBlock,
} from './codingTaskSuccess.js';

describe('codingTaskSuccess (P0-E / HF-05)', () => {
  test('EARLY_BLOCK_RICH / blocked is never coding-task success', () => {
    assert.equal(
      isCodingTaskSuccess({
        statusText: 'BLOCKED',
        answerText: 'EARLY_BLOCK_RICH: zero writes after investigate',
        hasSuccessfulMutation: false,
        declaredBlocked: true,
      }),
      false,
    );
    assert.equal(
      classifyCodingTaskGate({
        terminalOutcome: 'BLOCKED_POLICY',
        hasSuccessfulMutation: false,
        answerText: 'BLOCKED: zero successful file mutations',
      }),
      'diagnostic',
    );
  });

  test('empty patch claimed complete is fail', () => {
    assert.equal(
      classifyCodingTaskGate({
        statusText: 'ANSWER_READY',
        hasSuccessfulMutation: false,
        verifierOk: true,
      }),
      'fail',
    );
    assert.equal(
      isCodingTaskSuccess({
        terminalOutcome: 'UNVERIFIED_PATCH',
        hasSuccessfulMutation: false,
      }),
      false,
    );
  });

  test('verified complete with mutation is pass', () => {
    assert.equal(
      isCodingTaskSuccess({
        terminalOutcome: 'VERIFIED_COMPLETE',
        hasSuccessfulMutation: true,
        verifierOk: true,
        requireVerifier: true,
      }),
      true,
    );
  });

  test('unverified patch with mutation passes when verifier not required', () => {
    assert.equal(
      isCodingTaskSuccess({
        terminalOutcome: 'UNVERIFIED_PATCH',
        hasSuccessfulMutation: true,
        requireVerifier: false,
      }),
      true,
    );
  });

  test('unverified patch fails when verifier required and missing', () => {
    assert.equal(
      isCodingTaskSuccess({
        terminalOutcome: 'UNVERIFIED_PATCH',
        hasSuccessfulMutation: true,
        verifierOk: false,
        requireVerifier: true,
      }),
      false,
    );
  });

  test('budget / cancel / infra are fail not pass', () => {
    for (const terminalOutcome of ['BUDGET_EXHAUSTED', 'CANCELLED', 'INFRA_FAILURE', 'AGENT_FAILURE'] as const) {
      assert.equal(
        classifyCodingTaskGate({
          terminalOutcome,
          hasSuccessfulMutation: true,
        }),
        'fail',
      );
    }
  });

  test('isEarlyOrPolicyBlock covers status and answer markers', () => {
    assert.equal(isEarlyOrPolicyBlock({ statusText: 'BLOCKED' }), true);
    assert.equal(isEarlyOrPolicyBlock({ answerText: 'EARLY_BLOCK_RICH artifacts ok' }), true);
    assert.equal(isEarlyOrPolicyBlock({ statusText: 'ANSWER_READY', answerText: 'done' }), false);
  });
});
