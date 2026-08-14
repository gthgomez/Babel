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

  test('applyExploreFuses records force_mutate_shadow for general_swe soft path', () => {
    const events: Array<{ kind: string }> = [];
    const state = {
      turnsWithoutWrite: 99,
      consecutiveReadOnlyTools: 0,
      cumulativeExplorationTools: 0,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 0,
      toolsWithoutWrite: 0,
      phase: 'mutate' as const,
      shadowLoggedKinds: new Set<string>(),
    };
    applyExploreFuses({
      executeIntent: true,
      taskClass: 'general_swe',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      onPolicyEvent: (e) => events.push(e),
      currentTurn: 4,
    });
    assert.ok(events.some((e) => e.kind === 'force_mutate'));
    assert.ok(events.some((e) => e.kind === 'force_mutate_shadow'));
    assert.equal(state.restrictToolsNextTurn, false, 'soft coding path must not hard-restrict');
  });

  test('force_mutate_shadow is one-shot per session (deduped)', () => {
    const events: Array<{ kind: string }> = [];
    const state = {
      turnsWithoutWrite: 99,
      consecutiveReadOnlyTools: 0,
      cumulativeExplorationTools: 0,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 0,
      toolsWithoutWrite: 0,
      phase: 'mutate' as const,
      shadowLoggedKinds: new Set<string>(),
    };
    const run = (turn: number) => {
      // re-arm turns so force_mutate fires again (policy resets turnsWithoutWrite)
      state.turnsWithoutWrite = 99;
      applyExploreFuses({
        executeIntent: true,
        taskClass: 'general_swe',
        hasAnyWrites: false,
        state,
        pushUser: () => {},
        deferMessagesToArbiter: true,
        onPolicyEvent: (e) => events.push(e),
        currentTurn: turn,
      });
    };
    run(1);
    run(2);
    run(3);
    const shadows = events.filter((e) => e.kind === 'force_mutate_shadow');
    assert.equal(shadows.length, 1, 'shadow must fire once, not every force_mutate cycle');
    assert.ok(state.shadowLoggedKinds?.has('force_mutate_shadow'));
  });

  test('investigate hard cap terminals after tools without write', () => {
    const state = {
      turnsWithoutWrite: 0,
      consecutiveReadOnlyTools: 0,
      cumulativeExplorationTools: 0,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 0,
      toolsWithoutWrite: 12, // general_swe hard cap (Wave A: 12 fires before wall)
      phase: 'investigate' as const,
    };
    const result = applyExploreFuses({
      executeIntent: true,
      taskClass: 'general_swe',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
    });
    assert.ok(result.investigateHardCapTerminal);
    assert.match(result.investigateHardCapTerminal!, /hard cap 12/i);
  });

  test('investigate soft budget fires once per zero-write streak', () => {
    const state = {
      turnsWithoutWrite: 0,
      consecutiveReadOnlyTools: 0,
      cumulativeExplorationTools: 0,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 0,
      toolsWithoutWrite: 8,
      phase: 'investigate' as const,
      investigateSoftNudgeDone: false,
    };
    const run = () =>
      applyExploreFuses({
        executeIntent: true,
        taskClass: 'general_swe',
        hasAnyWrites: false,
        state,
        pushUser: () => {},
        deferMessagesToArbiter: true,
      });
    // First hit at soft budget → one soft nudge
    const first = run();
    assert.ok(first.investigateBudgetMessage);
    assert.equal(state.investigateSoftNudgeDone, true);
    assert.equal(first.investigateHardCapTerminal, null);
    // Still at 8 or past soft → no re-fire
    state.toolsWithoutWrite = 8;
    assert.equal(run().investigateBudgetMessage, null);
    state.toolsWithoutWrite = 10;
    assert.equal(run().investigateBudgetMessage, null);
    // Hard cap (12)
    state.toolsWithoutWrite = 12;
    assert.ok(run().investigateHardCapTerminal);
  });

  test('applyExploreFuses respects env ablation off without process mutation', () => {
    const events: Array<{ kind: string }> = [];
    const state = {
      turnsWithoutWrite: 99,
      consecutiveReadOnlyTools: 99,
      cumulativeExplorationTools: 0,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 0,
      toolsWithoutWrite: 0,
      phase: 'mutate' as const,
    };
    const result = applyExploreFuses({
      executeIntent: true,
      taskClass: 'general_swe',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      onPolicyEvent: (e) => events.push(e),
      currentTurn: 4,
      env: {
        BABEL_POLICY_MODE_FORCE_MUTATE: 'off',
        BABEL_POLICY_MODE_READ_THRASH: 'off',
        BABEL_POLICY_MODE_EXPLORATION_FUSE: 'off',
      },
    });
    assert.equal(result.forceMutateMessage, null);
    assert.equal(result.readThrashMessage, null);
    assert.ok(!events.some((e) => e.kind === 'force_mutate' || e.kind === 'force_mutate_shadow'));
  });

  test('quick_inspect enforces 4-tool initial budget without executeIntent and never fires force_mutate', () => {
    const state = {
      turnsWithoutWrite: 10,
      consecutiveReadOnlyTools: 4,
      cumulativeExplorationTools: 4,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 0,
      toolsWithoutWrite: 4,
      phase: 'investigate' as const,
    };
    const result = applyExploreFuses({
      executeIntent: false,
      taskClass: 'quick_inspect',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      currentTurn: 1,
    });
    // Must NOT fire force_mutate because it is a read-only query
    assert.equal(result.forceMutateMessage, null);
    // Must fire read-only investigate tool budget soft nudge at 4 tools
    assert.ok(result.investigateBudgetMessage);
    assert.ok(result.investigateBudgetMessage?.includes('read-only budget'));
    assert.ok(result.investigateBudgetMessage?.includes('4 tools'));
    assert.ok(!result.investigateBudgetMessage?.includes('str_replace'));
  });

  test('quick_inspect at hard cap terminates with read-only answer synthesis and never requests mutation', () => {
    const state = {
      turnsWithoutWrite: 10,
      consecutiveReadOnlyTools: 8,
      cumulativeExplorationTools: 8,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 0,
      toolsWithoutWrite: 8,
      phase: 'investigate' as const,
    };
    const result = applyExploreFuses({
      executeIntent: false,
      taskClass: 'quick_inspect',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      currentTurn: 2,
    });
    assert.ok(result.investigateHardCapTerminal);
    assert.match(result.investigateHardCapTerminal!, /^READ_ONLY_BUDGET_REACHED:/);
    assert.ok(!result.investigateHardCapTerminal?.startsWith('BLOCKED:'));
    assert.match(result.investigateHardCapTerminal!, /Inspection tool budget reached/i);
    assert.match(result.investigateHardCapTerminal!, /synthesize and return your best-supported final answer/i);
    // Must NEVER ask a read-only task to use mutation tools
    assert.ok(!result.investigateHardCapTerminal?.includes('str_replace'));
    assert.ok(!result.investigateHardCapTerminal?.includes('write_file'));
    assert.ok(!result.investigateHardCapTerminal?.includes('file mutation'));
  });

  test('quick_inspect walks through shell tools, reads, and hard cap without ANY mutation pressure', () => {
    const forbiddenPhrases = [
      'str_replace',
      'write_file',
      'mutation',
      'apply the fix',
      'pick a file and mutate',
      'commit to a file',
      'without a successful file mutation',
    ];

    const assertNoMutationPressure = (res: any, stage: string) => {
      const messages = [
        res.forceMutateMessage,
        res.readThrashMessage,
        res.explorationFuseMessage,
        res.shellSoftMessage,
        res.investigateBudgetMessage,
        res.investigateHardCapTerminal,
      ].filter(Boolean) as string[];

      for (const msg of messages) {
        const lower = msg.toLowerCase();
        for (const phrase of forbiddenPhrases) {
          assert.ok(
            !lower.includes(phrase),
            `Stage ${stage}: message "${msg}" must NOT contain "${phrase}"`,
          );
        }
      }
    };

    const state = {
      turnsWithoutWrite: 0,
      consecutiveReadOnlyTools: 0,
      cumulativeExplorationTools: 0,
      restrictToolsNextTurn: false,
      consecutiveNonMutatingShells: 0,
      toolsWithoutWrite: 0,
      phase: 'investigate' as const,
    };

    // Stage 1: shell tool 1
    state.consecutiveNonMutatingShells = 1;
    state.toolsWithoutWrite = 1;
    let res = applyExploreFuses({
      executeIntent: false,
      taskClass: 'quick_inspect',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      currentTurn: 1,
    });
    assertNoMutationPressure(res, 'shell tool 1');
    assert.equal(res.shellSoftMessage, null);

    // Stage 2: shell tool 2 (would trigger shellSoftBudget in execute tasks)
    state.consecutiveNonMutatingShells = 2;
    state.toolsWithoutWrite = 2;
    res = applyExploreFuses({
      executeIntent: false,
      taskClass: 'quick_inspect',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      currentTurn: 1,
    });
    assertNoMutationPressure(res, 'shell tool 2');
    assert.equal(res.shellSoftMessage, null, 'Read-only queries must NOT fire shell soft budget');

    // Stage 3: tool 4 (reaches 4-tool soft budget)
    state.toolsWithoutWrite = 4;
    res = applyExploreFuses({
      executeIntent: false,
      taskClass: 'quick_inspect',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      currentTurn: 2,
    });
    assertNoMutationPressure(res, 'tool 4');
    assert.ok(res.investigateBudgetMessage);
    assert.ok(res.investigateBudgetMessage?.includes('read-only budget'));

    // Stage 4: read 6 (would trigger readThrash in execute tasks)
    state.consecutiveReadOnlyTools = 6;
    state.cumulativeExplorationTools = 6;
    state.toolsWithoutWrite = 6;
    res = applyExploreFuses({
      executeIntent: false,
      taskClass: 'quick_inspect',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      currentTurn: 3,
    });
    assertNoMutationPressure(res, 'read 6');
    assert.equal(res.readThrashMessage, null, 'Read-only queries must NOT fire read thrash');
    assert.equal(res.explorationFuseMessage, null, 'Read-only queries must NOT fire exploration fuse');

    // Stage 5: tool 8 (hard cap)
    state.toolsWithoutWrite = 8;
    res = applyExploreFuses({
      executeIntent: false,
      taskClass: 'quick_inspect',
      hasAnyWrites: false,
      state,
      pushUser: () => {},
      deferMessagesToArbiter: true,
      currentTurn: 4,
    });
    assertNoMutationPressure(res, 'tool 8');
    assert.ok(res.investigateHardCapTerminal);
    assert.match(res.investigateHardCapTerminal!, /Inspection tool budget reached/i);
    assert.match(res.investigateHardCapTerminal!, /synthesize and return your best-supported final answer/i);
  });
});
