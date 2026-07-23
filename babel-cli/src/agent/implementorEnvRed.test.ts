/**
 * W0.4 — env-red honesty fixtures.
 * Missing pytest → ENV_BLOCKED, not empty success; empty_patch KPI quarantined.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyEmptyPatchHonesty,
  detectEnvBlockedFromText,
  detectEnvBlockedFromToolLog,
  formatEnvBlockedOperatorCard,
  resolveImplementorHarnessFields,
} from './implementorPolicy.js';
import { renderFailureCard } from './failureCard.js';
import { buildChatRunPayload } from '../interactive/execution/chatCore.js';
import type { ChatResult } from './chatEngine.js';
import type { SessionUsageSummary } from '../services/costTracker.js';

const emptyUsage: SessionUsageSummary = {
  totalCostUSD: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  modelBreakdown: {},
};

describe('W0.4 env-red honesty', () => {
  test('missing pytest is env_blocked, not clean success text', () => {
    assert.equal(detectEnvBlockedFromText("pytest: command not found"), true);
    assert.equal(
      detectEnvBlockedFromText("'pytest' is not recognized as an internal or external command"),
      true,
    );
    assert.equal(detectEnvBlockedFromText('all tests passed'), false);
  });

  test('tool log with pytest missing triggers env_blocked', () => {
    assert.equal(
      detectEnvBlockedFromToolLog([
        { detail: 'exit 127', error: 'pytest: command not found' },
      ]),
      true,
    );
  });

  test('empty_patch KPI quarantined when env_blocked', () => {
    const q = classifyEmptyPatchHonesty({ emptyPatch: true, envBlocked: true });
    assert.equal(q.scoreAsEmptyPatchFailure, false);
    assert.equal(q.reason, 'env_blocked_quarantine');

    const trueEmpty = classifyEmptyPatchHonesty({ emptyPatch: true, envBlocked: false });
    assert.equal(trueEmpty.scoreAsEmptyPatchFailure, true);
  });

  test('fixture: missing pytest → ENV_BLOCKED status, not ANSWER_READY empty success', () => {
    const fields = resolveImplementorHarnessFields({
      answer: 'Cannot verify: pytest: command not found',
      toolCalls: [
        {
          tool: 'test_run',
          detail: 'pytest -q',
          error: 'pytest: command not found',
        },
      ],
      hasAnyWrites: false,
      emptyPatch: true,
      legacyAnswerStatus: 'ANSWER_READY',
    });
    assert.equal(fields.env_blocked, true);
    assert.equal(fields.status, 'ENV_BLOCKED');
    assert.equal(fields.empty_patch_scoreable, false);
    assert.equal(fields.failure_class_hint, 'env_blocked');
    assert.ok(fields.operator_card?.includes('ENV_BLOCKED'));
  });

  test('post-patch env block keeps patch honesty and quarantines empty_patch scoring', () => {
    const fields = resolveImplementorHarnessFields({
      answer: 'Patch applied; pytest not found on PATH',
      toolCalls: [
        { tool: 'str_replace', detail: 'ok' },
        { tool: 'test_run', error: 'pytest: command not found' },
      ],
      hasAnyWrites: true,
      emptyPatch: false,
      legacyAnswerStatus: 'ANSWER_READY',
    });
    assert.equal(fields.env_blocked, true);
    assert.equal(fields.status, 'ANSWER_READY');
    assert.equal(fields.empty_patch_scoreable, false);
  });

  test('failure card surfaces ENV_BLOCKED distinctly', () => {
    const card = renderFailureCard({
      taskLabel: 'W0.4-pytest-missing',
      status: 'ENV_BLOCKED',
      costUsd: 0.01,
      turns: 3,
      patchBytes: 0,
      emptyPatch: true,
      modelsUsed: ['deepseek-v4-flash'],
      proCostShare: 0,
      lastTools: [{ tool: 'test_run', target: 'pytest' }],
      policyEventCounts: {},
      envBlocked: true,
      envBlockedCard: formatEnvBlockedOperatorCard({
        hasAnyWrites: false,
        signal: 'pytest: command not found',
      }),
      recommendedAction: 'Install pytest or re-run on a ready machine.',
    });
    assert.ok(card.includes('ENV_BLOCKED'));
    assert.ok(card.includes('not a policy thrash'));
    assert.ok(card.includes('empty_patch KPI quarantined'));
  });

  test('buildChatRunPayload emits env_blocked harness fields', () => {
    const result: ChatResult = {
      status: 'completed',
      outcome: 'UNVERIFIED_PATCH',
      answer: 'Done. pytest: command not found so I could not verify.',
      usage: emptyUsage,
      conversation: [],
      toolCalls: [
        { tool: 'read_file', target: 'src/x.ts' },
        {
          tool: 'test_run',
          target: 'pytest',
          error: 'pytest: command not found',
        },
      ],
    };
    const payload = buildChatRunPayload(
      result,
      {
        task: 'fix x',
        projectRoot: process.cwd(),
      },
      { taskIntent: 'execute' },
    );
    assert.equal(payload['env_blocked'], true);
    assert.equal(payload['status'], 'ENV_BLOCKED');
    assert.equal(payload['empty_patch_scoreable'], false);
    assert.equal(payload['failure_class_hint'], 'env_blocked');
    const pr = payload['patch_reality'] as Record<string, unknown>;
    assert.equal(pr['empty_patch'], true);
    assert.equal(pr['env_blocked'], true);
    assert.equal(pr['empty_patch_scoreable'], false);
  });

  test('buildChatRunPayload emits phase_gate_write_block_count (W1.2)', () => {
    const result = {
      status: 'completed' as const,
      outcome: 'ANSWER_READY' as const,
      answer: 'Could not write yet; still investigating.',
      usage: emptyUsage,
      conversation: [],
      toolCalls: [{ tool: 'str_replace', target: 'src/x.ts', detail: 'phase-gate', error: 'blocked' }],
      policyEvents: [
        {
          at_turn: 1,
          kind: 'phase_gate_block' as const,
          detail: 'phase=investigate',
          tool: 'str_replace',
        },
      ],
      blockedAttempts: [
        { turn: 1, tool: 'str_replace', target: 'src/x.ts', reason: 'phase-gate' as const },
      ],
    } as unknown as ChatResult;
    const payload = buildChatRunPayload(
      result,
      { task: 'edit x', projectRoot: process.cwd() },
      { taskIntent: 'execute' },
    );
    assert.equal(payload['phase_gate_write_block_count'], 1);
    assert.ok(
      String(payload['phase_gate_write_block_visibility']).includes('write blocked: phase-gate'),
    );
  });
});
