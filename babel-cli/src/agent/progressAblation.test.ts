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
