/**
 * TF-08 / TF-11 — terminal truth agreement across shell exit, JSON payload,
 * durable outcome and the TUI-facing user status.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildChatRunPayload, exitCodeForChatResult } from '../interactive/execution/chatCore.js';
import { exitCodeFromOutcome, userFacingStatusFromOutcome } from '../cli/userFacingStatus.js';
import {
  normalizeInspectedNoChange,
  type ChatTerminalSnapshot,
} from './chatEngineTerminalRuntime.js';
import type { ChatResult } from './chatEngine.js';
import type { TerminalOutcome } from '../schemas/agentContracts.js';

function snapshotFor(input: {
  task: string;
  projectRoot?: string;
  toolCallLog: Array<Record<string, unknown>>;
}): ChatTerminalSnapshot {
  return {
    context: {
      options: {
        task: input.task,
        ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
      },
      executionProfile: 'default',
      taskClass: 'default',
      engineRunId: 'tf08',
      engineRunDir: '/tmp/tf08',
      turnIndex: 0,
      turnId: 'turn-1',
      taskContract: undefined,
      acceptedOperation: 'READ_ONLY',
    },
    outcome: {
      hasMutation: false,
      readOnly: true,
      budgetExceeded: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      lastVerifierReceipt: null,
      gatePolicy: 'none',
      lastCriticReceipt: null,
      verifierTampered: false,
      writeCount: 0,
    },
    presentation: {
      accountingWarnings: [],
      conversation: [],
      playbookId: null,
      dedupeHitCount: 0,
      lastRequestPromptTokens: null,
      lastRequestCompletionTokens: null,
      lastRequestModelId: null,
      currentTurnTelemetry: null,
      lastTurnTelemetry: null,
    },
    evidence: {
      sessionEvents: {
        schema_version: 1,
        session_id: 'tf08',
        events: [],
        nextSeq: 0,
        flushedThroughSeq: -1,
      } as never,
      policyEventLog: { record() {} } as never,
      observability: {
        toolCallLog: input.toolCallLog,
      } as never,
    },
    allowance: {
      limits: {} as never,
      postWriteRepairWallCapMs: null,
      criticRepairCostCapUsd: null,
      taskCostBaselineUsd: 0,
    },
  } as unknown as ChatTerminalSnapshot;
}

function result(outcome: TerminalOutcome, answer: string): ChatResult {
  return {
    status: 'completed',
    outcome,
    answer,
    usage: {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      modelBreakdown: {},
    },
    conversation: [],
  };
}

describe('TF-08 terminal truth', () => {
  test('UNVERIFIED_PATCH is not exit 0 and not user_status success', () => {
    const chat = result('UNVERIFIED_PATCH', 'I changed the file.');
    const payload = buildChatRunPayload(chat, { task: 'patch', projectRoot: '/tmp/project' });
    assert.equal(payload['terminal_outcome'], 'UNVERIFIED_PATCH');
    assert.equal(payload['user_status'], 'not_verified');
    assert.notEqual(exitCodeForChatResult(chat), 0);
    assert.equal(exitCodeForChatResult(chat), exitCodeFromOutcome('UNVERIFIED_PATCH'));
    assert.equal(userFacingStatusFromOutcome('UNVERIFIED_PATCH'), payload['user_status']);
  });

  test('positive control: VERIFIED_COMPLETE and NO_CHANGE_REQUIRED exit 0', () => {
    for (const outcome of ['VERIFIED_COMPLETE', 'NO_CHANGE_REQUIRED'] as TerminalOutcome[]) {
      const chat = result(outcome, 'done');
      assert.equal(exitCodeForChatResult(chat), 0);
      assert.equal(
        buildChatRunPayload(chat, { task: 'ok', projectRoot: '/tmp/project' })['user_status'],
        'success',
      );
    }
  });
});

describe('TF-11 grounded informational result', () => {
  test('repository explanation with zero successful reads is UNVERIFIED_PATCH, not success', () => {
    const outcome = normalizeInspectedNoChange(
      snapshotFor({ task: 'Explain this repository', projectRoot: '/tmp/project', toolCallLog: [] }),
      'NO_CHANGE_REQUIRED',
    );
    assert.equal(outcome, 'UNVERIFIED_PATCH');
    assert.equal(userFacingStatusFromOutcome(outcome), 'not_verified');
    assert.notEqual(exitCodeFromOutcome(outcome), 0);
  });

  test('positive control: one successful source observation keeps NO_CHANGE_REQUIRED', () => {
    const outcome = normalizeInspectedNoChange(
      snapshotFor({
        task: 'Explain this repository',
        projectRoot: '/tmp/project',
        toolCallLog: [
          {
            tool: 'read_file',
            target: 'README.md',
            exit_code: 0,
            detail: '# Babel',
          },
        ],
      }),
      'NO_CHANGE_REQUIRED',
    );
    assert.equal(outcome, 'NO_CHANGE_REQUIRED');
    assert.equal(userFacingStatusFromOutcome(outcome), 'success');
    assert.equal(exitCodeFromOutcome(outcome), 0);
  });

  test('conversational turn does not require repository inspection', () => {
    const outcome = normalizeInspectedNoChange(
      snapshotFor({ task: 'hello', projectRoot: '/tmp/project', toolCallLog: [] }),
      'NO_CHANGE_REQUIRED',
    );
    assert.equal(outcome, 'NO_CHANGE_REQUIRED');
  });

  test('implementation no-change without inspection evidence still fails closed', () => {
    const snapshot = snapshotFor({
      task: 'fix the failing test',
      projectRoot: '/tmp/project',
      toolCallLog: [],
    });
    (snapshot.context as { acceptedOperation?: string | undefined }).acceptedOperation = undefined;
    const outcome = normalizeInspectedNoChange(snapshot, 'NO_CHANGE_REQUIRED');
    assert.equal(outcome, 'AGENT_FAILURE');
  });
});
