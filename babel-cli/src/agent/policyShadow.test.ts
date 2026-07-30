/**
 * P0-E policy shadow mode unit tests.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PolicyEventLog } from './policyEventLog.js';
import {
  DEFAULT_SHADOW_ZERO_WRITE_TURNS,
  evaluateZeroWriteWithShadow,
  measureShadowInterventionOutcomes,
  recordPolicyShadowSessionOutcome,
  resolvePolicyMode,
  resolveShadowZeroWriteTurns,
  resolveStallInterventionsEnabled,
  resolveStallShadowMode,
  buildExploreFuseShadowEvents,
} from './policyShadow.js';

describe('policyShadow (P0-E)', () => {
  test('coding classes default kill-switch policies to shadow', () => {
    for (const cls of ['default', 'quick_fix', 'general_swe'] as const) {
      assert.equal(resolvePolicyMode('zero_write', cls, {}), 'shadow');
      assert.equal(resolvePolicyMode('force_mutate', cls, {}), 'shadow');
      assert.equal(resolvePolicyMode('read_thrash', cls, {}), 'shadow');
      assert.equal(resolvePolicyMode('exploration_fuse', cls, {}), 'shadow');
      assert.equal(resolvePolicyMode('stall_kill', cls, {}), 'shadow');
      assert.equal(resolveStallShadowMode(cls, {}), true);
      assert.equal(resolveStallInterventionsEnabled(cls, {}), true);
    }
  });

  test('governance defaults zero_write and stall to enforce', () => {
    assert.equal(resolvePolicyMode('zero_write', 'governance', {}), 'enforce');
    assert.equal(resolvePolicyMode('stall_kill', 'governance', {}), 'enforce');
    assert.equal(resolveStallShadowMode('governance', {}), false);
  });

  test('investigate: stall enforce, zero-write/force-mutate off', () => {
    assert.equal(resolvePolicyMode('stall_kill', 'investigate', {}), 'enforce');
    assert.equal(resolvePolicyMode('zero_write', 'investigate', {}), 'off');
    assert.equal(resolvePolicyMode('force_mutate', 'investigate', {}), 'off');
  });

  test('env ablation overrides task-class default', () => {
    assert.equal(
      resolvePolicyMode('zero_write', 'general_swe', {
        BABEL_POLICY_MODE_ZERO_WRITE: 'enforce',
      }),
      'enforce',
    );
    assert.equal(
      resolvePolicyMode('stall_kill', 'general_swe', {
        BABEL_POLICY_MODE: 'off',
      }),
      'off',
    );
    assert.equal(resolveStallInterventionsEnabled('general_swe', { BABEL_POLICY_MODE: 'off' }), false);
  });

  test('general_swe zero-write: live silent, shadow logs would-kill once', () => {
    const decision = evaluateZeroWriteWithShadow({
      executeIntent: true,
      completedTurns: 20,
      hasAnyWrites: false,
      taskClass: 'general_swe',
      env: {},
      atTurn: 19,
    });
    assert.equal(decision.mode, 'shadow');
    assert.equal(decision.liveThreshold, 0);
    assert.equal(decision.shadowThreshold, DEFAULT_SHADOW_ZERO_WRITE_TURNS);
    assert.equal(decision.liveWouldFire, false);
    assert.equal(decision.shadowWouldFire, true);
    assert.equal(decision.arbiterMessage, null);
    assert.equal(decision.terminalMessage, null);
    assert.equal(decision.events.length, 1);
    assert.equal(decision.events[0]!.kind, 'zero_write_shadow');
    assert.match(decision.events[0]!.detail ?? '', /would_kill/);
  });

  test('zero_write_shadow is deduped when alreadyHasZeroWriteShadow', () => {
    const first = evaluateZeroWriteWithShadow({
      executeIntent: true,
      completedTurns: 12,
      hasAnyWrites: false,
      taskClass: 'general_swe',
      env: {},
      alreadyHasZeroWriteShadow: false,
    });
    assert.equal(first.events.length, 1);

    const second = evaluateZeroWriteWithShadow({
      executeIntent: true,
      completedTurns: 20,
      hasAnyWrites: false,
      taskClass: 'general_swe',
      env: {},
      alreadyHasZeroWriteShadow: true,
    });
    assert.equal(second.shadowWouldFire, true);
    assert.equal(second.events.length, 0, 'must not re-log every turn after threshold');
  });

  test('general_swe with writes: no shadow kill', () => {
    const decision = evaluateZeroWriteWithShadow({
      executeIntent: true,
      completedTurns: 20,
      hasAnyWrites: true,
      taskClass: 'general_swe',
      env: {},
    });
    assert.equal(decision.shadowWouldFire, false);
    assert.equal(decision.events.length, 0);
  });

  test('enforce mode emits terminal hard-stop when live threshold fires', () => {
    const decision = evaluateZeroWriteWithShadow({
      executeIntent: true,
      completedTurns: 12,
      hasAnyWrites: false,
      taskClass: 'default',
      env: { BABEL_POLICY_MODE_ZERO_WRITE: 'enforce' },
    });
    assert.equal(decision.mode, 'enforce');
    assert.equal(decision.liveWouldFire, true);
    assert.equal(decision.arbiterMessage, null);
    assert.ok(decision.terminalMessage?.includes('BLOCKED'));
    assert.equal(decision.events[0]!.kind, 'zero_write_hard_stop');
  });

  test('off mode never logs or messages', () => {
    const decision = evaluateZeroWriteWithShadow({
      executeIntent: true,
      completedTurns: 99,
      hasAnyWrites: false,
      taskClass: 'default',
      env: { BABEL_POLICY_MODE_ZERO_WRITE: 'off' },
    });
    assert.equal(decision.mode, 'off');
    assert.equal(decision.arbiterMessage, null);
    assert.equal(decision.terminalMessage, null);
    assert.equal(decision.events.length, 0);
  });

  test('shadow zero-write turns env override', () => {
    assert.equal(resolveShadowZeroWriteTurns({ BABEL_CHAT_ZERO_WRITE_SHADOW_TURNS: '5' }), 5);
    const decision = evaluateZeroWriteWithShadow({
      executeIntent: true,
      completedTurns: 6,
      hasAnyWrites: false,
      taskClass: 'general_swe',
      env: { BABEL_CHAT_ZERO_WRITE_SHADOW_TURNS: '5' },
    });
    assert.equal(decision.shadowWouldFire, true);
  });

  test('explore fuse shadow events under soft and hardRestrict class', () => {
    const soft = buildExploreFuseShadowEvents({
      atTurn: 3,
      taskClass: 'general_swe',
      forceMutateFired: true,
      readThrashFired: true,
      explorationExhausted: true,
      hardRestrictEnabled: false,
      env: {},
    });
    assert.equal(soft.length, 3);
    assert.deepEqual(
      soft.map((e) => e.kind).sort(),
      ['exploration_shadow', 'force_mutate_shadow', 'read_thrash_shadow'],
    );

    // Shadow mode on a hardRestrict-capable class still logs would-restrict
    // (live restrict only applies when mode=enforce).
    const shadowOnHardClass = buildExploreFuseShadowEvents({
      atTurn: 3,
      taskClass: 'governance',
      forceMutateFired: true,
      readThrashFired: true,
      explorationExhausted: true,
      hardRestrictEnabled: true,
      env: {
        BABEL_POLICY_MODE_FORCE_MUTATE: 'shadow',
        BABEL_POLICY_MODE_READ_THRASH: 'shadow',
        BABEL_POLICY_MODE_EXPLORATION_FUSE: 'shadow',
      },
    });
    assert.equal(shadowOnHardClass.length, 3);
    assert.ok(shadowOnHardClass.every((e) => /live_restrict=0/.test(e.detail ?? '')));

    // governance defaults enforce — no shadow kinds
    const hard = buildExploreFuseShadowEvents({
      atTurn: 3,
      taskClass: 'governance',
      forceMutateFired: true,
      readThrashFired: true,
      explorationExhausted: true,
      hardRestrictEnabled: true,
      env: {},
    });
    assert.equal(hard.length, 0);
  });

  test('later_succeeded is coding gate only; later_progressed tracks mutation', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 5, kind: 'zero_write_shadow', detail: 'would_kill' });
    log.record({ at_turn: 6, kind: 'stall_shadow_kill', detail: 'would kill' });

    const mutationOnly = recordPolicyShadowSessionOutcome(log, {
      atTurn: 10,
      hasSuccessfulMutation: true,
      codingTaskPassed: false,
      terminalOutcome: 'UNVERIFIED_PATCH',
    });
    assert.ok(mutationOnly);
    assert.match(mutationOnly!.detail ?? '', /later_succeeded=0/);
    assert.match(mutationOnly!.detail ?? '', /later_progressed=1/);

    // Idempotent — clear and retest coding pass path
    log.clear();
    log.record({ at_turn: 5, kind: 'zero_write_shadow', detail: 'would_kill' });
    const codingPass = recordPolicyShadowSessionOutcome(log, {
      atTurn: 10,
      hasSuccessfulMutation: true,
      codingTaskPassed: true,
      terminalOutcome: 'VERIFIED_COMPLETE',
    });
    assert.ok(codingPass);
    assert.match(codingPass!.detail ?? '', /later_succeeded=1/);
    assert.match(codingPass!.detail ?? '', /shadow_count=1/);

    const second = recordPolicyShadowSessionOutcome(log, {
      atTurn: 11,
      hasSuccessfulMutation: false,
      codingTaskPassed: false,
      terminalOutcome: 'BLOCKED_POLICY',
    });
    assert.equal(second, null, 'second call is idempotent');

    const measured = measureShadowInterventionOutcomes(log.all());
    assert.equal(measured.shadow_interventions, 1);
    assert.equal(measured.sessions_with_summary, 1);
    assert.equal(measured.later_succeeded, 1);
    assert.equal(measured.later_progressed, 1);
    assert.equal(measured.later_failed, 0);
  });

  test('no summary when no shadow interventions', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 1, kind: 'force_mutate', detail: 'soft' });
    assert.equal(
      recordPolicyShadowSessionOutcome(log, {
        atTurn: 2,
        hasSuccessfulMutation: true,
        codingTaskPassed: true,
        terminalOutcome: 'UNVERIFIED_PATCH',
      }),
      null,
    );
  });
});
