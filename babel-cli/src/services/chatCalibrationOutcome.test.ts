import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCalibrationOutcome } from "./chatCalibrationOutcome.js";
import type { CausalRunWhyReport } from "./causalAttribution.js";

function report(
  family: "unknown" | "provider" | "harness",
  code: string,
  terminal = "VERIFIED_COMPLETE",
): CausalRunWhyReport {
  return {
    schema_version: 1,
    kind: "babel_causal_attribution_report",
    status: "ok",
    terminal_outcome: terminal,
    event_count: 3,
    lifecycle: {
      inference_count: 1,
      delivered_result_count: 1,
      failed_result_count: 0,
      tool_proposal_count: 1,
      tool_terminal_count: 1,
      mutation_count: 1,
      verifier_count: 1,
      compaction_count: 0,
    },
    attribution: {
      family,
      code,
      confidence: family === "unknown" ? "low" : "high",
      model_blame_permitted: false,
      evidence: [],
      counterevidence: [],
      unknowns: [],
    },
  };
}

test("runtime degradation does not erase a solved task outcome", () => {
  const outcome = deriveCalibrationOutcome(
    {
      status: "AGENT_FAILURE",
      contract_success: true,
      hidden_ok: true,
      production_mutated: true,
    },
    report("provider", "HTTP_429", "AGENT_FAILURE"),
  );
  assert.equal(outcome.task_outcome, "SOLVED");
  assert.equal(outcome.session_outcome, "AGENT_FAILURE");
  assert.equal(outcome.runtime_integrity, "PROVIDER_DEGRADED");
  assert.equal(outcome.impact, "TASK_OUTCOME_UNAFFECTED");
});

test("successful no-failure evidence is distinct from unresolved attribution", () => {
  const outcome = deriveCalibrationOutcome(
    {
      status: "VERIFIED_COMPLETE",
      contract_success: true,
      hidden_ok: true,
      production_mutated: true,
    },
    report("unknown", "no_failure_signal"),
  );
  assert.equal(outcome.causal_failure, "NONE");
  assert.equal(outcome.runtime_integrity, "CLEAN");
  assert.equal(outcome.task_outcome, "SOLVED");
});
