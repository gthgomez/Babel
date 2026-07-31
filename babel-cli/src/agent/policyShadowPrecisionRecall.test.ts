/**
 * P0-E offline shadow precision/recall report tests.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PolicyEvent } from './policyEventLog.js';
import {
  ADVISORY_MIN_WOULD_KILL_SESSIONS,
  buildShadowPrecisionRecallReport,
  fixtureShadowPrecisionRecallSessions,
  formatShadowPrecisionRecallHuman,
  groupSessionsFromPolicyEvents,
  parsePolicyEventsFromText,
  parsePolicyShadowSummaryDetail,
} from './policyShadowPrecisionRecall.js';

describe('policyShadowPrecisionRecall (P0-E)', () => {
  test('parsePolicyShadowSummaryDetail reads later_succeeded / progressed', () => {
    const p = parsePolicyShadowSummaryDetail(
      'shadow_count=2 later_succeeded=1 later_progressed=1 mutation=1 coding_pass=1 outcome=VERIFIED_COMPLETE',
    );
    assert.equal(p.shadow_count, 2);
    assert.equal(p.later_succeeded, true);
    assert.equal(p.later_progressed, true);
    assert.equal(p.terminal_outcome, 'VERIFIED_COMPLETE');

    const fail = parsePolicyShadowSummaryDetail(
      'shadow_count=1 later_succeeded=0 later_progressed=0 mutation=0 coding_pass=0 outcome=INCOMPLETE',
    );
    assert.equal(fail.later_succeeded, false);
    assert.equal(fail.later_progressed, false);
  });

  test('groupSessionsFromPolicyEvents splits multi-session stream', () => {
    const events: PolicyEvent[] = [
      { at_turn: 5, kind: 'zero_write_shadow', detail: 'would_kill' },
      {
        at_turn: 10,
        kind: 'policy_shadow_summary',
        detail:
          'shadow_count=1 later_succeeded=0 later_progressed=0 mutation=0 coding_pass=0 outcome=INCOMPLETE',
      },
      { at_turn: 3, kind: 'stall_shadow_kill', detail: 'would kill' },
      { at_turn: 4, kind: 'force_mutate_shadow', detail: 'would_restrict' },
      {
        at_turn: 12,
        kind: 'policy_shadow_summary',
        detail:
          'shadow_count=2 later_succeeded=1 later_progressed=1 mutation=1 coding_pass=1 outcome=VERIFIED_COMPLETE',
      },
    ];
    const sessions = groupSessionsFromPolicyEvents(events);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0]!.intervention_kinds, ['zero_write_shadow']);
    assert.equal(sessions[0]!.later_succeeded, false);
    assert.deepEqual(sessions[1]!.intervention_kinds, [
      'stall_shadow_kill',
      'force_mutate_shadow',
    ]);
    assert.equal(sessions[1]!.later_succeeded, true);
    assert.equal(sessions[1]!.later_progressed, true);
  });

  test('fixture report computes kill_precision and false_kill_rate', () => {
    const fixtures = fixtureShadowPrecisionRecallSessions();
    const report = buildShadowPrecisionRecallReport({
      sessions: fixtures,
      now: new Date('2026-07-30T00:00:00.000Z'),
    });
    assert.equal(report.kind, 'babel_policy_shadow_precision_recall');
    assert.equal(report.source, 'sessions');
    assert.equal(report.would_kill_sessions, 5);
    // 1 false kill (coding pass), 4 justified failures → precision 4/5, false kill 1/5
    assert.equal(report.later_succeeded, 1);
    assert.equal(report.later_failed, 4);
    assert.equal(report.later_progressed, 2); // false-kill + progressed_not_succeeded
    assert.equal(report.progressed_not_succeeded, 1);
    assert.ok(report.kill_precision != null);
    assert.ok(report.false_kill_rate != null);
    assert.ok(Math.abs(report.kill_precision! - 0.8) < 1e-9);
    assert.ok(Math.abs(report.false_kill_rate! - 0.2) < 1e-9);
    assert.equal(report.advisory_enforce_ready, false); // n < min sample
    assert.ok(report.by_kind.zero_write_shadow);
    assert.ok((report.by_kind.zero_write_shadow!.sessions ?? 0) >= 2);
  });

  test('events path matches session rollup', () => {
    const events: PolicyEvent[] = [
      { at_turn: 1, kind: 'zero_write_shadow' },
      {
        at_turn: 2,
        kind: 'policy_shadow_summary',
        detail: 'shadow_count=1 later_succeeded=1 later_progressed=1 mutation=1 coding_pass=1 outcome=VERIFIED_COMPLETE',
      },
      { at_turn: 1, kind: 'exploration_shadow' },
      {
        at_turn: 2,
        kind: 'policy_shadow_summary',
        detail: 'shadow_count=1 later_succeeded=0 later_progressed=0 mutation=0 coding_pass=0 outcome=INCOMPLETE',
      },
    ];
    const report = buildShadowPrecisionRecallReport({ events });
    assert.equal(report.source, 'events');
    assert.equal(report.would_kill_sessions, 2);
    assert.equal(report.later_succeeded, 1);
    assert.equal(report.later_failed, 1);
    assert.ok(Math.abs(report.false_kill_rate! - 0.5) < 1e-9);
  });

  test('default offline path uses fixtures and never advisory-ready', () => {
    const report = buildShadowPrecisionRecallReport({ useFixtures: true });
    assert.equal(report.source, 'fixtures');
    assert.equal(report.advisory_enforce_ready, false);
    assert.ok(report.advisory_notes.some((n) => /fixtures/i.test(n)));
    assert.ok(report.would_kill_sessions < ADVISORY_MIN_WOULD_KILL_SESSIONS);
  });

  test('advisory_enforce_ready when sample large and false_kill low', () => {
    const sessions = Array.from({ length: ADVISORY_MIN_WOULD_KILL_SESSIONS }, (_, i) => ({
      id: `s-${i}`,
      intervention_kinds: ['zero_write_shadow' as const],
      // 1 false kill in 20 → 5%
      later_succeeded: i === 0,
      later_progressed: i === 0,
      shadow_count: 1,
    }));
    const report = buildShadowPrecisionRecallReport({ sessions });
    assert.equal(report.would_kill_sessions, ADVISORY_MIN_WOULD_KILL_SESSIONS);
    assert.equal(report.advisory_enforce_ready, true);
    assert.ok(report.false_kill_rate != null && report.false_kill_rate <= 0.25);
  });

  test('parsePolicyEventsFromText accepts JSON array and JSONL', () => {
    const arr = parsePolicyEventsFromText(
      JSON.stringify([
        { at_turn: 1, kind: 'zero_write_shadow' },
        {
          at_turn: 2,
          kind: 'policy_shadow_summary',
          detail: 'shadow_count=1 later_succeeded=0 later_progressed=0 mutation=0 coding_pass=0 outcome=X',
        },
      ]),
    );
    assert.equal(arr.length, 2);

    const jsonl = parsePolicyEventsFromText(
      [
        '{"at_turn":1,"kind":"stall_shadow_kill"}',
        '{"at_turn":2,"kind":"policy_shadow_summary","detail":"shadow_count=1 later_succeeded=0 later_progressed=0 mutation=0 coding_pass=0 outcome=Y"}',
      ].join('\n'),
    );
    assert.equal(jsonl.length, 2);
    assert.equal(groupSessionsFromPolicyEvents(jsonl).length, 1);
  });

  test('human formatter includes headline rates', () => {
    const report = buildShadowPrecisionRecallReport({ useFixtures: true });
    const text = formatShadowPrecisionRecallHuman(report);
    assert.match(text, /Precision\/Recall/);
    assert.match(text, /kill_precision/);
    assert.match(text, /false_kill_rate/);
    assert.match(text, /By intervention kind/);
  });
});
