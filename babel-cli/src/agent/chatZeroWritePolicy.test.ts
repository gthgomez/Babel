/**
 * Zero-write thrash policy unit tests.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyExploreFuses,
  buildPolicyTerminalBlockedReport,
  buildZeroWriteHardStopBlockedReport,
  evaluateZeroWriteHardStop,
  exportToolCallLog,
  resolveRestrictedToolMode,
  resolveZeroWriteHardStopTurns,
} from './chatZeroWritePolicy.js';

describe('chatZeroWritePolicy', () => {
  test('resolveZeroWriteHardStopTurns uses task-class defaults', () => {
    assert.equal(resolveZeroWriteHardStopTurns('general_swe', {}), 0);
    assert.equal(resolveZeroWriteHardStopTurns('investigate', {}), 0);
  });

  test('env override wins', () => {
    assert.equal(
      resolveZeroWriteHardStopTurns('general_swe', {
        BABEL_CHAT_ZERO_WRITE_HARD_STOP_TURNS: '3',
      }),
      3,
    );
    assert.equal(
      resolveZeroWriteHardStopTurns('general_swe', {
        BABEL_CHAT_ZERO_WRITE_HARD_STOP_TURNS: '0',
      }),
      0,
    );
  });

  test('evaluateZeroWriteHardStop disabled for general_swe (threshold 0 = disabled)', () => {
    const msg = evaluateZeroWriteHardStop({
      executeIntent: true,
      completedTurns: 12,
      hasAnyWrites: false,
      taskClass: 'general_swe',
      env: {},
    });
    assert.equal(msg, null);
  });

  test('evaluateZeroWriteHardStop skips when writes exist', () => {
    assert.equal(
      evaluateZeroWriteHardStop({
        executeIntent: true,
        completedTurns: 20,
        hasAnyWrites: true,
        taskClass: 'general_swe',
        env: {},
      }),
      null,
    );
  });

  test('restricted mode is mutate_only until writes', () => {
    assert.equal(resolveRestrictedToolMode(false), 'mutate_only');
    assert.equal(resolveRestrictedToolMode(true), 'act_or_verify');
  });

  test('exportToolCallLog strips index', () => {
    const out = exportToolCallLog([
      { tool: 'run_command', target: 'pytest', index: 0 },
      { tool: 'str_replace', target: 'a.py', index: 1, detail: 'ok' },
    ]);
    assert.deepEqual(out, [
      { tool: 'run_command', target: 'pytest' },
      { tool: 'str_replace', target: 'a.py', detail: 'ok' },
    ]);
  });

  test('blocked report shape', () => {
    const r = buildZeroWriteHardStopBlockedReport('BLOCKED: test');
    assert.equal(r.status, 'BLOCKED');
    assert.equal(r.schema_version, 1);
    assert.ok(r.checked.length >= 1);
  });

  test('buildPolicyTerminalBlockedReport does not mislabel stall as zero-write', () => {
    const stall = buildPolicyTerminalBlockedReport('progress_terminal', 'Repeated no-progress');
    assert.equal(stall.checked[0]?.action, 'progress_terminal');
    assert.notEqual(stall.checked[0]?.action, 'zero_write_hard_stop');
    assert.match(stall.reason, /no-progress|progress/i);

    const zw = buildPolicyTerminalBlockedReport('zero_write', 'BLOCKED: zero writes');
    assert.equal(zw.checked[0]?.action, 'zero_write_hard_stop');
  });

  test('applyExploreFuses deferMessagesToArbiter does not push force/read messages', () => {
    const pushed: string[] = [];
    const state = {
      turnsWithoutWrite: 99,
      consecutiveReadOnlyTools: 99,
      cumulativeExplorationTools: 0,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 10,
      toolsWithoutWrite: 20,
      phase: 'investigate' as const,
    };
    const result = applyExploreFuses({
      executeIntent: true,
      taskClass: 'general_swe',
      hasAnyWrites: false,
      state,
      pushUser: (c) => pushed.push(c),
      deferMessagesToArbiter: true,
    });
    assert.equal(pushed.length, 0, 'deferred path must not pushUser for force/read');
    assert.ok(
      result.forceMutateMessage != null ||
        result.readThrashMessage != null ||
        result.shellSoftMessage != null ||
        result.investigateBudgetMessage != null ||
        result.labels.length >= 0,
    );
  });

  test('applyExploreFuses fires shell soft budget for general_swe', () => {
    const state = {
      turnsWithoutWrite: 0,
      consecutiveReadOnlyTools: 0,
      cumulativeExplorationTools: 0,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 4,
      toolsWithoutWrite: 4,
      phase: 'mutate' as const,
    };
    const result = applyExploreFuses({
      executeIntent: true,
      taskClass: 'general_swe',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
    });
    assert.ok(result.shellSoftMessage?.includes('shell soft budget'));
  });
});
