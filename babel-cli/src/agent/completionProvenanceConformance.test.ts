/**
 * Completion and recovery provenance (#211, #216, #259, #310).
 *
 * Provider-free. Locks behavior the current gate, child handoff, live
 * answer_chunk transcript, and restore classifier already implement.
 * A zero-test green exit must not delete recovery provenance. Durable
 * partial-answer phase is not
 * asserted: ChatMessage, thread events, and history-cell payloads have
 * no phase field.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  evaluateCompletionGateForEngine,
  evaluateExecuteCompletionHonesty,
  hasInspectedNoChangeEvidence,
  isAuthoritativeVerifierCommand,
  isPackageManagerInstallCommand,
  planCompletionGateReject,
  type GateToolLogEntry,
  type VerifierReceipt,
} from './completionGatePolicy.js';
import { hasSubAgentWrites } from './chatEngineCriticBudget.js';
import { computeTerminalOutcome } from './chatEngineObservability.js';
import { verifierEvidenceCaveats } from './chatEngineVerifierAdapter.js';
import {
  buildReadOnlyChildResult,
  renderReadOnlyChildResultSection,
  type ReadOnlyChildResultInput,
} from './childConclusion.js';
import {
  applyWorkingStateEvent,
  createWorkingState,
  ZERO_TEST_GREEN_NON_EVIDENCE,
  type RecoveryCandidateBinding,
} from './codingLoop/workingState.js';
import { ingestVerifierResult } from './codingLoop/chatBindings.js';
import {
  buildVerifierReceiptV2,
  evaluateVerifierPromotion,
} from './verifierKernel.js';
import { HistoryTranscript } from '../ui/historyCells/transcript.js';
import {
  createThreadEventLog,
  rebuildProviderMessagesFromEvents,
  recordAssistantMessage,
} from './threadEventLog.js';
import {
  RESTORE_REASONS,
  classifyOperation,
} from '../runtime/restoreReport.js';
import { shouldSkipIntentCompiler } from './intentCompiler.js';

const WRITE: GateToolLogEntry = {
  tool: 'str_replace',
  target: 'src/parser.ts',
  effect_status: 'confirmed_change',
  mutation_paths: ['src/parser.ts'],
};

const ZERO_TEST_CAVEAT = verifierEvidenceCaveats({
  exit_code: 0,
  tests_total: 0,
})[0]!;
assert.equal(ZERO_TEST_GREEN_NON_EVIDENCE, ZERO_TEST_CAVEAT);

function zeroTestReceipt(command = 'npm test'): VerifierReceipt {
  return {
    command,
    exit_code: 0,
    authority: true,
    summary: ['npm test → exit 0', ZERO_TEST_CAVEAT].join('\n'),
    tests_total: 0,
    tests_skipped: 0,
    stale: false,
  };
}

function childInput(
  overrides: Partial<ReadOnlyChildResultInput> = {},
): ReadOnlyChildResultInput {
  return {
    steps: [
      {
        phase: 'finish',
        action: { type: 'finish', summary: 'child says the bug is gone' },
      },
    ],
    toolCallLog: [],
    stepsExecuted: 1,
    degraded: false,
    completed: true,
    roundExhausted: false,
    policyBlocked: false,
    lane: 'ask',
    childId: 'child-1',
    maxRounds: 4,
    cancelled: false,
    ...overrides,
  };
}

const BINDING: RecoveryCandidateBinding = {
  schemaVersion: 1,
  taskId: 'task-1',
  contractHash: 'contract',
  repositoryIdentity: 'repo',
  workspaceRevision: 'rev-1',
};

function openRecovery() {
  let state = createWorkingState('fix the parser');
  state = applyWorkingStateEvent(state, {
    type: 'failure_surface',
    surface: {
      kind: 'TEST_FAILURE',
      causality: 'patch_induced',
      errorSignature: 'sig-1',
      failingTests: ['parser'],
      failingFiles: ['src/parser.ts'],
      exitCode: 1,
      changedSincePrevious: false,
      evidenceRefs: [],
    },
  });
  state = applyWorkingStateEvent(state, {
    type: 'recovery_gate',
    failureSignature: 'sig-1',
    requiredEvidence: 'reread the failing assertion',
    binding: BINDING,
    failingTargets: ['src/parser.ts'],
  });
  return state;
}

function withSpentLocalization(state: ReturnType<typeof openRecovery>) {
  return applyWorkingStateEvent(state, {
    type: 'localization_begin',
    localization: {
      phase: 'exhausted',
      failureSignature: 'sig-1',
      binding: BINDING,
      candidates: [],
      testHints: [],
      calls: 4,
      rounds: 2,
      inspected: ['src/parser.ts'],
    },
  });
}

describe('completion authority is not answer text', () => {
  test('a read-only submission does not receive generated repair guidance', () => {
    assert.equal(shouldSkipIntentCompiler('hello', { operation: 'READ_ONLY' }), true);
    assert.equal(
      shouldSkipIntentCompiler('What does this function do?', { operation: 'READ_ONLY' }),
      true,
    );
    assert.equal(shouldSkipIntentCompiler('investigate and fix the parser'), false);
  });

  test('an execute completion with no write and no inspection is rejected', () => {
    assert.equal(
      evaluateCompletionGateForEngine({
        turnType: 'completion',
        taskIntent: 'execute',
        task: 'fix the parser',
        taskClass: 'default',
        toolCallLog: [],
        lastVerifierReceipt: null,
      }),
      'reject',
    );
    const plan = planCompletionGateReject({
      hasWrites: false,
      hasInspectedNoChange: false,
      policy: 'required',
      hardGate: true,
      hadToolCallsThisTurn: false,
      gateStrikes: 0,
      maxGateStrikes: 3,
    });
    assert.equal(plan.kind, 'reject_continue');
    const exhausted = planCompletionGateReject({
      hasWrites: false,
      hasInspectedNoChange: false,
      policy: 'strict',
      hardGate: true,
      hadToolCallsThisTurn: false,
      gateStrikes: 3,
      maxGateStrikes: 3,
    });
    assert.equal(exhausted.kind, 'blocked');
  });

  test('a package install exit 0 is not an authoritative verifier', () => {
    assert.equal(isPackageManagerInstallCommand('pip install requests'), true);
    assert.equal(isAuthoritativeVerifierCommand('pip install requests'), false);
    assert.equal(isAuthoritativeVerifierCommand('cat src/parser.ts'), false);
    assert.equal(
      evaluateCompletionGateForEngine({
        turnType: 'completion',
        taskIntent: 'execute',
        task: 'add requests',
        taskClass: 'default',
        toolCallLog: [WRITE],
        lastVerifierReceipt: {
          command: 'pip install requests',
          exit_code: 0,
          authority: true,
          summary: 'installed',
        },
      }),
      'reject',
    );
  });

  test('strict honesty rejects a green exit that executed zero tests', () => {
    const honesty = evaluateExecuteCompletionHonesty({
      hasWrite: true,
      policy: 'strict',
      lastVerifierReceipt: zeroTestReceipt(),
      toolCallLog: [WRITE],
      requiredVerifierCommands: ['npm test'],
    });
    assert.equal(honesty.allow, false);
    assert.equal(honesty.reason, 'verifier_missing');
    assert.equal(
      evaluateCompletionGateForEngine({
        turnType: 'completion',
        taskIntent: 'execute',
        task: 'fix the parser',
        taskClass: 'governance',
        toolCallLog: [WRITE],
        lastVerifierReceipt: zeroTestReceipt(),
        requiredVerifierCommands: ['npm test'],
      }),
      'reject',
    );
  });

  test('a no-op write cannot authorize verified completion', () => {
    const revision = 'tree-1';
    const receipt = buildVerifierReceiptV2({
      receipt_id: 'r1',
      verifier_id: 'npm test',
      argv: ['npm', 'test'],
      cwd: '.',
      env_profile_hash: 'env',
      started_at: '2026-10-11T00:00:00.000Z',
      ended_at: '2026-10-11T00:00:01.000Z',
      exit_code: 0,
      stdout: '# tests 2\n# pass 2\n',
      stderr: '',
      workspace_revision: { compositeTreeHash: revision },
      scope: 'targeted',
      command: 'npm test',
      authoritative: true,
      freshness: 'fresh',
      tests_total: 2,
      tests_failed: 0,
      tests_skipped: 0,
    });
    const base = {
      mutating: true,
      task_class: 'quick_fix',
      required_verifier_commands: ['npm test'],
      receipts: [receipt],
      current_revision_hash: revision,
    };
    assert.equal(evaluateVerifierPromotion(base).authorize_verified_complete, true);
    const noop = evaluateVerifierPromotion({
      ...base,
      adversarial: { shortcut_noop: true },
    });
    assert.equal(noop.authorize_verified_complete, false);
    assert.ok(noop.denials.includes('shortcut_noop'));
  });

  test('an informative or inspected answer is not VERIFIED_COMPLETE', () => {
    assert.equal(
      evaluateCompletionGateForEngine({
        turnType: 'completion',
        taskIntent: 'explain',
        task: 'what does parse do?',
        taskClass: 'default',
        toolCallLog: [],
        lastVerifierReceipt: null,
      }),
      'allow',
    );
    assert.equal(
      computeTerminalOutcome({
        readOnly: true,
        finalStatus: 'completed',
        budgetExceeded: false,
        hasAnyWrites: false,
      }),
      'NO_CHANGE_REQUIRED',
    );
    assert.notEqual(
      computeTerminalOutcome({
        readOnly: false,
        finalStatus: 'completed',
        budgetExceeded: false,
        hasAnyWrites: false,
      }),
      'VERIFIED_COMPLETE',
    );
    const read: GateToolLogEntry = {
      tool: 'read_file',
      target: 'src/parser.ts',
      exit_code: 0,
      detail: 'export function parse',
    };
    assert.equal(hasInspectedNoChangeEvidence([read]), true);
    assert.equal(
      evaluateCompletionGateForEngine({
        turnType: 'completion',
        taskIntent: 'execute',
        task: 'what does parse do?',
        taskClass: 'default',
        toolCallLog: [read],
        lastVerifierReceipt: null,
      }),
      'allow',
    );
  });

  test('blocked, failed, and budget outcomes are not complete', () => {
    assert.equal(
      computeTerminalOutcome({
        finalStatus: 'failed',
        budgetExceeded: false,
      }),
      'AGENT_FAILURE',
    );
    assert.equal(
      computeTerminalOutcome({
        finalStatus: 'blocked',
        budgetExceeded: false,
        blockedReport: {
          reason: 'verifier failed',
          reason_code: 'verification_failed',
        },
        hasAnyWrites: true,
      }),
      'AGENT_FAILURE',
    );
    assert.equal(
      computeTerminalOutcome({
        finalStatus: 'completed',
        budgetExceeded: true,
        lastVerifierReceipt: { exit_code: 0, command: 'npm test', summary: 'ok' },
        hasAnyWrites: true,
      }),
      'BUDGET_EXHAUSTED',
    );
    assert.equal(
      computeTerminalOutcome({
        finalStatus: 'cancelled',
        budgetExceeded: false,
      }),
      'CANCELLED',
    );
  });
});

describe('child conclusion is not parent completion', () => {
  test('a finished child stays unverified and a partial child is not completed', () => {
    const done = buildReadOnlyChildResult(childInput());
    assert.equal(done.completion, 'completed');
    assert.equal(done.provenance.authority, 'child_assertion_not_verified');
    assert.match(renderReadOnlyChildResultSection(done), /NOT verified/);

    const partial = buildReadOnlyChildResult(childInput({
      completed: false,
      roundExhausted: true,
    }));
    assert.equal(partial.completion, 'partial');
    assert.match(renderReadOnlyChildResultSection(partial), /completion: partial/);

    const cancelled = buildReadOnlyChildResult(childInput({ cancelled: true }));
    assert.equal(cancelled.completion, 'cancelled');

    const empty = buildReadOnlyChildResult(childInput({
      steps: [{ phase: 'finish', action: { type: 'finish', summary: '   ' } }],
    }));
    assert.equal(empty.completion, 'empty_conclusion');
    assert.equal(empty.conclusion, '');
  });

  test('child prose and a clean read-only child are not writes or inspection proof', () => {
    const rendered = renderReadOnlyChildResultSection(buildReadOnlyChildResult(childInput()));
    const childLog: GateToolLogEntry[] = [{
      tool: 'sub_agent',
      target: 'explain parser',
      detail: '1 steps, 0 changed, attribution=child_noop',
      exit_code: 0,
    }];
    assert.equal(hasSubAgentWrites(childLog), false);
    assert.equal(hasInspectedNoChangeEvidence(childLog), false);
    assert.equal(hasInspectedNoChangeEvidence([{
      tool: 'read_file',
      target: 'src/parser.ts',
      exit_code: 0,
      detail: rendered,
    }]), true);
    assert.equal(
      evaluateCompletionGateForEngine({
        turnType: 'completion',
        taskIntent: 'execute',
        task: 'fix the parser',
        taskClass: 'governance',
        toolCallLog: childLog,
        lastVerifierReceipt: null,
      }),
      'reject',
    );
  });
});

describe('live answer text is not a durable terminal', () => {
  test('an answer chunk stays active until the transcript commits it', () => {
    const transcript = new HistoryTranscript();
    transcript.beginTurn({ turn_id: 1, thread_id: 'thread-1' });
    transcript.onAnswerChunk('diagnosis before tests');
    assert.equal(transcript.getCommittedRecords().length, 0);
    assert.equal(transcript.getActiveRecord()?.lifecycle, 'active');
    assert.equal(transcript.getActiveRecord()?.kind, 'assistant_message');
    assert.equal(transcript.getAnswerText(), 'diagnosis before tests');
  });

  test('an assistant event without turn_ended replays as context, not an outcome', () => {
    const log = createThreadEventLog('thread-1');
    recordAssistantMessage(log, 'turn-1', 'controller hint', {
      name: 'harness_feedback',
      provenance: 'controller',
      authoritative: false,
    });
    recordAssistantMessage(log, 'turn-1', 'diagnosis before tests');
    const messages = rebuildProviderMessagesFromEvents(log);
    const hint = messages.find((message) => message.name === 'harness_feedback');
    assert.equal(hint?.authoritative, false);
    assert.equal(hint?.provenance, 'controller');
    assert.equal(hint?.role, 'assistant');
    assert.ok(messages.some((message) => message.content === 'diagnosis before tests'));
    assert.equal(log.events.some((event) => event.kind === 'turn_ended'), false);
    assert.equal(messages.some((message) => message.role === 'system' && message.authoritative === true), false);
  });
});

describe('restore does not promote a failed or incomplete effect', () => {
  test('a failed effect and a truncated settled admission are not completed', () => {
    const failed = classifyOperation({
      operationId: 'op-failed',
      effectClass: 'reconcilable_mutation',
      admissionState: 'claimed',
      effectState: 'failed',
    });
    assert.equal(failed.state, 'interrupted');
    assert.notEqual(failed.state, 'completed');
    assert.equal(failed.automaticRetryAllowed, false);

    const aborted = classifyOperation({
      operationId: 'op-aborted',
      effectClass: 'external_side_effect',
      admissionState: 'aborted',
    });
    assert.equal(aborted.state, 'not_started');
    assert.notEqual(aborted.state, 'completed');

    const truncated = classifyOperation({
      operationId: 'op-truncated',
      effectClass: 'read_only',
      admissionState: 'settled',
      outboxState: 'committed',
      effectState: 'completed',
      completeness: {
        complete: false,
        truncated: true,
        reasons: ['history_truncated'],
        admittedCount: 1,
        droppedCount: 1,
        evidenceRefsDropped: 1,
      },
    });
    assert.equal(truncated.state, 'indeterminate');
    assert.equal(truncated.action, 'operator_reconciliation_required');
    assert.equal(truncated.automaticRetryAllowed, false);
  });

  test('an effect marked completed without an admission receipt is not terminal-committed', () => {
    const effectOnly = classifyOperation({
      operationId: 'op-effect',
      effectClass: 'read_only',
      effectState: 'completed',
    });
    assert.equal(effectOnly.state, 'completed');
    assert.ok(effectOnly.reasons.includes(RESTORE_REASONS.EFFECT_APPLIED_WITHOUT_RECEIPT));
    assert.equal(effectOnly.reasons.includes(RESTORE_REASONS.TERMINAL_COMMITTED), false);
  });
});

describe('recovery provenance', () => {
  test('a real green verifier exit clears the open recovery gate', () => {
    const cleared = ingestVerifierResult({
      state: withSpentLocalization(openRecovery()),
      tool: 'test_run',
      target: 'npm test',
      exitCode: 0,
      stdout: '# tests 2\n# pass 2\n',
      stderr: '',
      summary: 'npm test → exit 0',
    });
    assert.equal(cleared.lastVerifierFailed, false);
    assert.equal(cleared.state.recoveryGate, undefined);
    assert.equal(cleared.state.failureSurface, undefined);
    assert.equal(cleared.state.localization, undefined);
  });

  test('a zero-test green exit must not erase an open recovery gate', () => {
    // verifierEvidenceCaveats appends this sentence when tests_total === 0.
    // That summary is not evidence, so the open gate stays unsatisfied.
    const kept = ingestVerifierResult({
      state: withSpentLocalization(openRecovery()),
      tool: 'test_run',
      target: 'npm test',
      exitCode: 0,
      stdout: 'No tests found',
      stderr: '',
      summary: ['npm test → exit 0', ZERO_TEST_CAVEAT].join('\n'),
    });
    assert.equal(kept.state.recoveryGate?.failureSignature, 'sig-1');
    assert.equal(kept.state.recoveryGate?.satisfied, false);
    assert.equal(kept.state.failureSurface?.errorSignature, 'sig-1');
    assert.equal(kept.state.localization?.calls, 4);
    assert.equal(kept.state.localization?.phase, 'exhausted');
    assert.equal(kept.lastVerifierFailed, true);
    assert.equal(kept.state.lastVerifier?.exitCode, 0);
    assert.equal(kept.state.lastVerifier?.fresh, true);
  });
});
