import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  attributeCausalFailure,
  buildCausalAttributionReport,
  type CausalAttributionEvidence,
} from "./causalAttribution.js";
import {
  createSessionEventLog,
  appendSessionEvent,
} from "../agent/sessionEvents.js";

const healthy = (): CausalAttributionEvidence => ({
  information_existed: true,
  result_delivered: true,
  context_preserved: true,
  capability_advertised: true,
  capability_authorized: true,
  capability_effective: true,
  task_feasible: true,
  evidence_complete: true,
  model_behavior: "none",
});

describe("no-false-model-blame attribution fixtures", () => {
  const cases: Array<
    [string, Partial<CausalAttributionEvidence>, string, string]
  > = [
    [
      "tool hidden",
      { capability_advertised: false },
      "harness",
      "capability_not_advertised",
    ],
    [
      "policy deny",
      { capability_authorized: false },
      "harness",
      "policy_denied_capability",
    ],
    [
      "read-only environment",
      { capability_effective: false },
      "environment",
      "capability_not_effective",
    ],
    [
      "missing executable",
      {
        capability_effective: false,
        environment_failure: "missing_executable",
      },
      "environment",
      "missing_executable",
    ],
    [
      "result lost",
      { result_delivered: false },
      "harness",
      "result_not_delivered",
    ],
    [
      "context loss",
      { context_preserved: false },
      "harness",
      "context_evidence_lost",
    ],
    [
      "model ignores delivered evidence",
      { model_behavior: "incorrect" },
      "model",
      "incorrect_action_despite_evidence",
    ],
    [
      "model loop",
      { model_behavior: "loop" },
      "model",
      "loop_or_stall_despite_usable_capability",
    ],
    [
      "provider error",
      { provider_failure: "provider_timeout" },
      "provider",
      "provider_timeout",
    ],
    [
      "evidence loss",
      { evidence_complete: false },
      "unknown",
      "insufficient_evidence",
    ],
  ];

  for (const [name, overrides, family, code] of cases) {
    test(name, () => {
      const result = attributeCausalFailure({ ...healthy(), ...overrides });
      assert.equal(result.family, family);
      assert.equal(result.code, code);
      assert.equal(result.model_blame_permitted, family === "model");
    });
  }

  test("unknown prerequisite never becomes confident model blame", () => {
    const result = attributeCausalFailure({
      ...healthy(),
      context_preserved: null,
      model_behavior: "incorrect",
    });
    assert.equal(result.family, "unknown");
    assert.equal(result.model_blame_permitted, false);
    assert.deepEqual(result.unknowns, ["context_preserved"]);
  });

  test("run projection keeps an incomplete session UNKNOWN", () => {
    const report = buildCausalAttributionReport({
      log: null,
      runDir: "/tmp/missing-run",
      loadError: "session event log missing",
    });
    assert.equal(report.status, "unknown");
    assert.equal(report.attribution.family, "unknown");
    assert.equal(report.attribution.model_blame_permitted, false);
    assert.match(
      report.attribution.unknowns.join(" "),
      /session event log missing/,
    );
  });

  test("run projection surfaces provider normalization failure", () => {
    const log = createSessionEventLog("why-provider");
    appendSessionEvent(log, {
      kind: "model_input_receipt",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      requested_model_id: "z-ai/glm-5.3-flash",
      normalized_model_id: "z-ai/glm-5.3-flash",
      sent_model_id: "z-ai/glm-5.3-flash",
      input_digest: "a".repeat(64),
      input_ref: join(process.cwd(), "src/services/causalAttribution.test.ts"),
    });
    appendSessionEvent(log, {
      kind: "model_invocation_phase",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      phase: "response_normalization_failed",
      detail: "tool_arguments",
    });
    appendSessionEvent(log, {
      kind: "model_result_delivery",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      status: "failed",
      observed_model_id: "z-ai/glm-5.3-flash",
    });
    const report = buildCausalAttributionReport({ log });
    assert.equal(report.status, "ok");
    assert.equal(report.attribution.family, "provider");
    assert.equal(report.attribution.code, "response_normalization_failed");
    assert.equal(report.attribution.model_blame_permitted, false);
  });

  test("run projection derives authorization and effectiveness from settled tool lifecycle", () => {
    const log = createSessionEventLog("why-tool-lifecycle");
    const inputRef = join(process.cwd(), "src/services/causalAttribution.test.ts");
    appendSessionEvent(log, {
      kind: "model_input_receipt",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      requested_model_id: "z-ai/glm-5.3-flash",
      normalized_model_id: "z-ai/glm-5.3-flash",
      sent_model_id: "z-ai/glm-5.3-flash",
      input_digest: "a".repeat(64),
      input_ref: inputRef,
    });
    appendSessionEvent(log, {
      kind: "capability_binding_receipt",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      capability: "read_file",
      advertised: true,
      authorized: null,
      effective: null,
    });
    appendSessionEvent(log, {
      kind: "tool_proposed",
      turn_id: "turn-1",
      tool_call_id: "tool-1",
      tool_name: "read_file",
      idempotency_key: "tool-1",
    });
    appendSessionEvent(log, {
      kind: "tool_started",
      turn_id: "turn-1",
      tool_call_id: "tool-1",
      tool_name: "read_file",
      idempotency_key: "tool-1",
    });
    appendSessionEvent(log, {
      kind: "tool_completed",
      turn_id: "turn-1",
      tool_call_id: "tool-1",
      tool_name: "read_file",
      idempotency_key: "tool-1",
      exit_code: 0,
    });
    appendSessionEvent(log, {
      kind: "compaction_started",
      turn_id: "turn-1",
      operation_id: "compact-1",
      strategy: "test",
      replaces_thread_seq_start: 0,
      replaces_thread_seq_end: 1,
      replaces_message_count: 1,
    });
    appendSessionEvent(log, {
      kind: "compaction_summary",
      turn_id: "turn-1",
      operation_id: "compact-1",
      capsule_digest: "b".repeat(64),
      raw_observation_refs: [],
      preserved_tool_call_ids: ["tool-1"],
    });
    appendSessionEvent(log, {
      kind: "model_result_delivery",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      status: "delivered",
      observed_model_id: "z-ai/glm-5.3-flash",
    });

    const report = buildCausalAttributionReport({
      log,
      facts: { task_feasible: true },
    });
    assert.equal(report.status, "ok");
    assert.equal(report.attribution.family, "unknown");
    assert.equal(report.attribution.code, "no_failure_signal");
    assert.equal(report.attribution.unknowns.includes("capability_authorized"), false);
    assert.equal(report.attribution.unknowns.includes("capability_effective"), false);
    assert.equal(report.attribution.unknowns.includes("task_feasible"), false);
  });

  test("run projection treats an explicit pre-dispatch denial as unauthorized", () => {
    const log = createSessionEventLog("why-pre-dispatch-denial");
    const inputRef = join(process.cwd(), "src/services/causalAttribution.test.ts");
    appendSessionEvent(log, {
      kind: "model_input_receipt",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      requested_model_id: "z-ai/glm-5.3-flash",
      normalized_model_id: "z-ai/glm-5.3-flash",
      sent_model_id: "z-ai/glm-5.3-flash",
      input_digest: "a".repeat(64),
      input_ref: inputRef,
    });
    appendSessionEvent(log, {
      kind: "capability_binding_receipt",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      capability: "finish",
      advertised: true,
      authorized: null,
      effective: null,
    });
    appendSessionEvent(log, {
      kind: "tool_proposed",
      turn_id: "turn-1",
      tool_call_id: "finish-1",
      tool_name: "finish",
      idempotency_key: "finish-1",
    });
    appendSessionEvent(log, {
      kind: "tool_cancelled",
      turn_id: "turn-1",
      tool_call_id: "finish-1",
      tool_name: "finish",
      idempotency_key: "finish-1",
      cancelled: true,
      recovery_state: "TOOL_NOT_STARTED",
      reason: "pre_dispatch_denied_or_invalid",
    });
    appendSessionEvent(log, {
      kind: "compaction_started",
      turn_id: "turn-1",
      operation_id: "compact-1",
      strategy: "test",
      replaces_thread_seq_start: 0,
      replaces_thread_seq_end: 1,
      replaces_message_count: 1,
    });
    appendSessionEvent(log, {
      kind: "compaction_summary",
      turn_id: "turn-1",
      operation_id: "compact-1",
      capsule_digest: "b".repeat(64),
      raw_observation_refs: [],
      preserved_tool_call_ids: [],
    });
    appendSessionEvent(log, {
      kind: "model_result_delivery",
      turn_id: "turn-1",
      inference_id: "inference-1",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      status: "delivered",
      observed_model_id: "z-ai/glm-5.3-flash",
    });

    const report = buildCausalAttributionReport({
      log,
      facts: { task_feasible: true },
    });
    assert.equal(report.attribution.family, "harness");
    assert.equal(report.attribution.code, "policy_denied_capability");
    assert.equal(report.attribution.model_blame_permitted, false);
  });
});
