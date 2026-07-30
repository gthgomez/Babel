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

  test('general_swe zero-write: live silent, shadow logs would-kill', () => {
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
    assert.equal(decision.events.length, 1);
    assert.equal(decision.events[0]!.kind, 'zero_write_shadow');
    assert.match(decision.events[0]!.detail ?? '', /would_kill/);
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

  test('enforce mode emits zero_write_hard_stop when live threshold fires', () => {
    const decision = evaluateZeroWriteWithShadow({
      executeIntent: true,
      completedTurns: 12,
      hasAnyWrites: false,
      taskClass: 'default',
      env: { BABEL_POLICY_MODE_ZERO_WRITE: 'enforce' },
    });
    assert.equal(decision.mode, 'enforce');
    assert.equal(decision.liveWouldFire, true);
    assert.ok(decision.arbiterMessage?.includes('BLOCKED'));
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

  test('explore fuse shadow events only when soft (not hard-restrict)', () => {
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

    const hard = buildExploreFuseShadowEvents({
      atTurn: 3,
      taskClass: 'governance',
      forceMutateFired: true,
      readThrashFired: true,
      explorationExhausted: true,
      hardRestrictEnabled: true,
      env: {},
    });
    // governance defaults enforce — no shadow kinds
    assert.equal(hard.length, 0);
  });

  test('session outcome summary + later_succeeded + idempotent', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 5, kind: 'zero_write_shadow', detail: 'would_kill' });
    log.record({ at_turn: 6, kind: 'stall_shadow_kill', detail: 'would kill' });

    const first = recordPolicyShadowSessionOutcome(log, {
      atTurn: 10,
      hasSuccessfulMutation: true,
      codingTaskPassed: true,
      terminalOutcome: 'VERIFIED_COMPLETE',
    });
    assert.ok(first);
    assert.equal(first!.kind, 'policy_shadow_summary');
    assert.match(first!.detail ?? '', /later_succeeded=1/);
    assert.match(first!.detail ?? '', /shadow_count=2/);

    const second = recordPolicyShadowSessionOutcome(log, {
      atTurn: 11,
      hasSuccessfulMutation: false,
      codingTaskPassed: false,
      terminalOutcome: 'BLOCKED_POLICY',
    });
    assert.equal(second, null, 'second call is idempotent');

    const measured = measureShadowInterventionOutcomes(log.all());
    assert.equal(measured.shadow_interventions, 2);
    assert.equal(measured.sessions_with_summary, 1);
    assert.equal(measured.later_succeeded, 1);
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
