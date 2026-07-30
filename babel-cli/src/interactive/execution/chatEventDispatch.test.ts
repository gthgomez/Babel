import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { terminalResultFromDoneEvent } from './chatEventDispatch.js';
import { globalCostTracker } from '../../services/costTracker.js';

const EMPTY_USAGE = globalCostTracker.getSessionSummary();

describe('terminalResultFromDoneEvent (P0-D lossless)', () => {
  test('prefers engine-emitted outcome over receipt heuristics', () => {
    const result = terminalResultFromDoneEvent(
      'blocked by critic',
      EMPTY_USAGE,
      undefined,
      undefined,
      { command: 'npm test', exit_code: 0, summary: 'pass' },
      {
        schema_version: 1 as const,
        status: 'BLOCKED' as const,
        reason: 'critic rejected last-chance patch',
        missing: 'acceptable patch',
        checked: [{ action: 'str_replace', target: 'src/a.ts', finding: 'critic reject' }],
      },
      { outcome: 'BLOCKED_POLICY' },
    );
    assert.equal(result.outcome, 'BLOCKED_POLICY');
    assert.equal(result.status, 'blocked');
  });

  test('recomputes BLOCKED_POLICY from blockedReport reason when outcome omitted', () => {
    const result = terminalResultFromDoneEvent(
      'blocked',
      EMPTY_USAGE,
      undefined,
      undefined,
      null,
      {
        schema_version: 1 as const,
        status: 'BLOCKED' as const,
        reason: 'zero-write gate after exploration',
        missing: 'file mutation',
        checked: [{ action: 'read_file', target: 'src/a.ts', finding: 'read only' }],
      },
    );
    assert.equal(result.outcome, 'BLOCKED_POLICY');
    assert.equal(result.status, 'blocked');
  });

  test('maps budgetExceeded to BUDGET_EXHAUSTED', () => {
    const result = terminalResultFromDoneEvent(
      'wall budget hit',
      EMPTY_USAGE,
      undefined,
      undefined,
      null,
      null,
      { budgetExceeded: true },
    );
    assert.equal(result.outcome, 'BUDGET_EXHAUSTED');
    assert.equal(result.status, 'budget_exhausted');
    assert.equal(result.budgetExceeded, true);
  });

  test('verified complete when engine outcome present without re-deriving', () => {
    const result = terminalResultFromDoneEvent(
      'done',
      EMPTY_USAGE,
      undefined,
      undefined,
      { command: 'npm test', exit_code: 1, summary: 'fail' },
      null,
      { outcome: 'VERIFIED_COMPLETE' },
    );
    // Engine outcome wins even if receipt would disagree
    assert.equal(result.outcome, 'VERIFIED_COMPLETE');
    assert.equal(result.status, 'completed');
  });
});
