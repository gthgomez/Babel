import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  SHADOW_ZERO_WRITE_THRESHOLD_TURNS,
  formatImplementorScorecardHuman,
  runImplementorScorecard,
} from './implementorScorecard.js';

describe('W3.3 implementor Grok-shadow scorecard', () => {
  test('full offline scorecard passes', () => {
    const report = runImplementorScorecard({
      now: new Date('2026-07-16T12:00:00.000Z'),
    });
    assert.equal(report.schema_version, 1);
    assert.equal(report.kind, 'babel_implementor_grok_shadow_scorecard');
    assert.equal(report.generated_at, '2026-07-16T12:00:00.000Z');
    assert.equal(report.pass, true, report.fail_reasons.join('; '));
    assert.equal(report.dimensions.prove_hard_cells.pass, true);
    assert.equal(report.dimensions.w1_residual_exit.pass, true);
    assert.equal(report.dimensions.interactive_metrics.pass, true);
    assert.equal(report.dimensions.false_positive_dashboard.pass, true);
    assert.equal(report.dimensions.shadow_would_have_killed.pass, true);
  });

  test('false-positive dashboard has zero FPs on known-good cells', () => {
    const report = runImplementorScorecard();
    const fp = report.dimensions.false_positive_dashboard;
    assert.ok(fp.cells_total >= 5);
    assert.equal(fp.false_positive_count, 0);
    assert.equal(fp.false_positive_rate, 0);
    for (const f of fp.findings) {
      assert.equal(f.false_positive, false, `${f.id}: ${f.detail}`);
    }
  });

  test('shadow would-have-killed reports explorer death under shadow threshold', () => {
    const report = runImplementorScorecard();
    const shadow = report.dimensions.shadow_would_have_killed;
    assert.ok(shadow.would_have_killed_count >= 1);
    const explorer = shadow.events.find((e) => e.id === 'shadow-late-explore-no-write');
    assert.ok(explorer);
    assert.equal(explorer!.completed_turns > SHADOW_ZERO_WRITE_THRESHOLD_TURNS, true);
    assert.equal(explorer!.would_kill, true);
    assert.equal(explorer!.live_kills, false);
    const withWrite = shadow.events.find((e) => e.id === 'shadow-mid-with-write');
    assert.ok(withWrite);
    assert.equal(withWrite!.would_kill, false);
    assert.equal(withWrite!.live_kills, false);
  });

  test('human formatter includes PASS and dimension labels', () => {
    const report = runImplementorScorecard();
    const text = formatImplementorScorecardHuman(report);
    assert.match(text, /Grok-Shadow Scorecard/);
    assert.match(text, /Status: PASS/);
    assert.match(text, /False-positive dashboard/);
    assert.match(text, /Shadow would-have-killed/);
    assert.match(text, /S-EVL-01/);
  });
});
