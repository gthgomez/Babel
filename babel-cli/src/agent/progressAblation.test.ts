import assert from "node:assert/strict";
import test from "node:test";

import { runProgressAblation } from "./progressAblation.js";

test("W3 ablation produces deterministic recovery metrics without false completes", () => {
  const result = runProgressAblation();
  assert.equal(result.fixtureCount, 7);
  assert.equal(result.falseCompletes, 0);
  assert.ok(result.prematureBlocks <= result.baselinePrematureBlocks);
  assert.ok(
    result.interventions.nudge + result.interventions.restricted_tools > 0,
  );
});

test('justified budget and external stops are not premature in either arm', () => {
  const result = runProgressAblation([
    {
      id: 'external',
      signals: ['external_blocker_verified'],
      textOnlyTurn: true,
      gateStrikes: 12,
      baselineStrikes: 12,
      completionAttempt: true,
      expectedTerminal: 'blocked_external',
    },
    {
      id: 'budget',
      signals: ['repeated_unchanged_read'],
      textOnlyTurn: true,
      gateStrikes: 12,
      baselineStrikes: 12,
      budgetExhausted: true,
      expectedTerminal: 'budget_exhausted',
    },
  ])
  assert.equal(result.interventions.terminal_blocked, 2)
  assert.equal(result.prematureBlocks, 0)
  assert.equal(result.baselinePrematureBlocks, 0)
  assert.equal(result.falseCompletes, 0)
})

test('both arms count a policy stop when the task should still continue', () => {
  const result = runProgressAblation([{
    id: 'continue',
    signals: [],
    textOnlyTurn: true,
    gateStrikes: 12,
    baselineStrikes: 12,
    expectedTerminal: 'continue',
  }])
  assert.equal(result.prematureBlocks, 1)
  assert.equal(result.baselinePrematureBlocks, 1)
})
