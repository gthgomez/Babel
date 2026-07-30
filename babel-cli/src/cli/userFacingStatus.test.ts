import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  exitCodeFromOutcome,
  getUserFacingStatus,
  userFacingStatusFromOutcome,
} from './userFacingStatus.js';
import type { TerminalOutcome } from '../schemas/agentContracts.js';

const emptyVerification = {
  status: 'not_required' as const,
  commands: [] as string[],
  skipped_reason: null as string | null,
};

describe('userFacingStatusFromOutcome (P0-D B3)', () => {
  test('maps each TerminalOutcome honestly', () => {
    const cases: Array<[TerminalOutcome, string]> = [
      ['VERIFIED_COMPLETE', 'success'],
      ['UNVERIFIED_PATCH', 'not_verified'],
      ['BLOCKED_EXTERNAL', 'blocked'],
      ['BLOCKED_POLICY', 'blocked'],
      ['BUDGET_EXHAUSTED', 'failed'],
      ['CANCELLED', 'failed'],
      ['INFRA_FAILURE', 'failed'],
      ['AGENT_FAILURE', 'failed'],
    ];
    for (const [outcome, expected] of cases) {
      assert.equal(
        userFacingStatusFromOutcome(outcome),
        expected,
        `${outcome} → ${expected}`,
      );
    }
  });

  test('exitCodeFromOutcome is 0 only for passing outcomes', () => {
    assert.equal(exitCodeFromOutcome('VERIFIED_COMPLETE'), 0);
    assert.equal(exitCodeFromOutcome('UNVERIFIED_PATCH'), 0);
    assert.equal(exitCodeFromOutcome('BLOCKED_POLICY'), 1);
    assert.equal(exitCodeFromOutcome('BUDGET_EXHAUSTED'), 1);
    assert.equal(exitCodeFromOutcome('AGENT_FAILURE'), 1);
  });
});

describe('getUserFacingStatus', () => {
  test('outcome path bypasses legacy heuristics', () => {
    // Status would look successful; outcome says blocked.
    assert.equal(
      getUserFacingStatus({
        status: 'ANSWER_READY',
        verification: emptyVerification,
        changedFiles: ['a.ts'],
        outcome: 'BLOCKED_POLICY',
      }),
      'blocked',
    );
  });

  test('legacy path still used when outcome omitted', () => {
    assert.equal(
      getUserFacingStatus({
        status: 'COMPLETE',
        verification: emptyVerification,
        changedFiles: [],
      }),
      'success',
    );
    assert.equal(
      getUserFacingStatus({
        status: 'NEEDS_MORE_CONTEXT',
        verification: emptyVerification,
        changedFiles: [],
      }),
      'blocked',
    );
  });
});
