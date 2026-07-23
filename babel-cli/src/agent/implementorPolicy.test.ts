import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEmptyPatchHonesty,
  classifyImplementorTerminal,
  detectEnvBlockedFromText,
  detectEnvBlockedFromToolLog,
  evaluateCompletionPrefersPatch,
  evaluateInvestigateToolBudget,
  evaluateShellSoftBudget,
  formatWhyStopped,
  hasLocalizationEvidence,
  isShellTool,
  rankToolsFileFirst,
  resolveImplementorHarnessFields,
} from './implementorPolicy.js';

describe('implementorPolicy', () => {
  test('shell soft budget fires after N non-mutating shells', () => {
    const r = evaluateShellSoftBudget({
      consecutiveNonMutatingShells: 4,
      budget: 4,
      hasAnyWrites: false,
    });
    assert.equal(r.fire, true);
    assert.ok(r.message?.includes('shell soft budget'));
  });

  test('shell soft budget quiet after writes', () => {
    const r = evaluateShellSoftBudget({
      consecutiveNonMutatingShells: 10,
      budget: 3,
      hasAnyWrites: true,
    });
    assert.equal(r.fire, false);
  });

  test('investigate tool budget fires without writes', () => {
    const r = evaluateInvestigateToolBudget({
      toolCallCount: 12,
      budget: 10,
      hasAnyWrites: false,
      phase: 'investigate',
    });
    assert.equal(r.fire, true);
    assert.ok(r.message?.includes('investigate budget'));
  });

  test('completion prefers patch refuses empty execute complete', () => {
    const r = evaluateCompletionPrefersPatch({
      executeIntent: true,
      hasAnyWrites: false,
    });
    assert.equal(r.allowComplete, false);
    assert.equal(r.reason, 'refuse_empty_complete');
  });

  test('completion allows env_blocked without writes', () => {
    const r = evaluateCompletionPrefersPatch({
      executeIntent: true,
      hasAnyWrites: false,
      envBlocked: true,
    });
    assert.equal(r.allowComplete, true);
    assert.equal(r.reason, 'ok_env_blocked');
  });

  test('detect env blocked from pytest missing', () => {
    assert.equal(
      detectEnvBlockedFromText("pytest: command not found"),
      true,
    );
    assert.equal(detectEnvBlockedFromText('all tests passed'), false);
    assert.equal(
      detectEnvBlockedFromToolLog([{ error: 'python was not found' }]),
      true,
    );
    assert.equal(
      classifyEmptyPatchHonesty({ emptyPatch: true, envBlocked: true }).scoreAsEmptyPatchFailure,
      false,
    );
    assert.equal(
      resolveImplementorHarnessFields({
        answer: 'pytest: command not found',
        hasAnyWrites: false,
        emptyPatch: true,
        legacyAnswerStatus: 'ANSWER_READY',
      }).status,
      'ENV_BLOCKED',
    );
  });

  test('classify ENV_BLOCKED terminal', () => {
    assert.equal(
      classifyImplementorTerminal({
        status: 'blocked',
        hasAnyWrites: true,
        envBlocked: true,
      }),
      'ENV_BLOCKED',
    );
  });

  test('localization evidence from read_file', () => {
    assert.equal(hasLocalizationEvidence(['run_command', 'read_file']), true);
    assert.equal(hasLocalizationEvidence(['run_command', 'test_run']), false);
  });

  test('rankToolsFileFirst puts mutations and reads before shell', () => {
    const ranked = rankToolsFileFirst([
      'run_command',
      'str_replace',
      'grep',
      'todo_write',
    ]);
    assert.equal(ranked[0], 'str_replace');
    assert.ok(ranked.indexOf('grep') < ranked.indexOf('run_command'));
  });

  test('formatWhyStopped includes policy and write state', () => {
    const text = formatWhyStopped({
      status: 'BLOCKED',
      hasAnyWrites: false,
      lastPolicyEvents: [
        { kind: 'force_mutate', detail: 'turns_without_write=3', at_turn: 3 },
      ],
      topBlockedReason: 'phase-gate',
    });
    assert.ok(text.includes('force_mutate'));
    assert.ok(text.includes('phase-gate'));
    assert.ok(text.includes('Writes: no'));
  });

  test('formatWhyStopped counts phase_gate_block write events', () => {
    const text = formatWhyStopped({
      status: 'BLOCKED',
      hasAnyWrites: false,
      lastPolicyEvents: [
        {
          kind: 'phase_gate_block',
          detail: 'phase=investigate',
          tool: 'str_replace',
          at_turn: 1,
        },
      ],
    });
    assert.ok(text.includes('write blocked: phase-gate'));
    assert.ok(text.includes('Phase-gate events: 1'));
  });

  test('isShellTool', () => {
    assert.equal(isShellTool('run_command'), true);
    assert.equal(isShellTool('str_replace'), false);
  });
});
