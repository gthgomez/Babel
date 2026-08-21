import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { dispatchChatEvent, terminalResultFromDoneEvent } from './chatEventDispatch.js';
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

  test('Pri-3: env toolchain blockedReport maps to BLOCKED_EXTERNAL not policy', () => {
    const result = terminalResultFromDoneEvent(
      'ENV_BLOCKED: cannot run verification',
      EMPTY_USAGE,
      undefined,
      undefined,
      null,
      {
        schema_version: 1 as const,
        status: 'BLOCKED' as const,
        reason: 'Environment / toolchain cannot run verification',
        missing: 'Working project runtime (deps installed, conftest importable, pytest/node on PATH)',
        checked: [
          {
            action: 'env_blocked',
            target: 'environment',
            finding: 'ImportError while loading conftest',
          },
        ],
      },
    );
    assert.equal(result.outcome, 'BLOCKED_EXTERNAL');
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

describe('dispatchChatEvent cancelled telemetry threading', () => {
  test('cancelled result carries the event turn telemetry', () => {
    const turnTelemetry = {
      turnId: 'turn-7',
      taskClass: 'default',
      timing: {
        submittedAt: 0,
        startedAt: 0,
        firstTokenAt: 1,
        ttftMs: 1,
        providerDurationMs: 10,
        toolDurationMs: 0,
        verificationDurationMs: 0,
        criticDurationMs: 0,
        compactionDurationMs: 0,
        orchestrationOverheadMs: 0,
        totalWallTimeMs: 12,
      },
      counts: {
        modelInvocations: 2,
        toolCalls: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        repeatedToolCalls: 0,
        policyInterventions: 0,
      },
      promptTokens: 123,
      completionTokens: 45,
      cumulativeSessionTokens: 168,
    };
    const result = dispatchChatEvent(
      { type: 'cancelled', turnTelemetry },
      {},
    );
    assert.ok(result, 'cancelled event must produce a terminal result');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.outcome, 'CANCELLED');
    assert.equal(result.turnTelemetry?.turnId, 'turn-7');
    assert.equal(result.turnTelemetry?.counts.modelInvocations, 2);
  });

  test('cancelled result without telemetry stays valid', () => {
    const result = dispatchChatEvent({ type: 'cancelled' }, {});
    assert.ok(result);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.turnTelemetry, undefined);
  });
});
