import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSessionEventLog,
  recordCapabilityBindingReceipt,
  recordCompletionDecision,
  recordModelInputReceipt,
  recordModelInvocationPhase,
  recordModelResultDelivery,
  recordMutationBatch,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordTurnEnded,
  recordUserSubmitted,
  recordVerifierAttempt,
  rewriteSessionEventLog,
} from "../agent/sessionEvents.js";
import {
  evaluateGlmCertification,
  assertGlmCertificationRoute,
  GLM_CERTIFICATION_STAGES,
  loadGlmCertificationStages,
  writeGlmCertificationReport,
} from "./glmCertification.js";

const MODEL = "z-ai/glm-5.3-flash";

function addInference(
  log: ReturnType<typeof createSessionEventLog>,
  id: string,
  deliveredToolCallIds?: string[],
): void {
  recordModelInputReceipt(log, {
    turn_id: "turn-1",
    inference_id: id,
    provider: "openrouter",
    requested_model_id: MODEL,
    normalized_model_id: MODEL,
    sent_model_id: MODEL,
    input_digest: "a".repeat(64),
    input_ref: "thread_events.json",
    ...(deliveredToolCallIds !== undefined
      ? { delivered_tool_call_ids: deliveredToolCallIds }
      : {}),
  });
  for (const phase of [
    "request_created",
    "request_dispatched",
    "response_started",
    "first_byte",
    "response_normalized",
  ] as const) {
    recordModelInvocationPhase(log, {
      turn_id: "turn-1",
      inference_id: id,
      provider: "openrouter",
      model: MODEL,
      phase,
    });
  }
  recordCapabilityBindingReceipt(log, {
    turn_id: "turn-1",
    inference_id: id,
    provider: "openrouter",
    capability: "read_file",
    advertised: true,
    authorized: true,
    effective: true,
  });
  recordModelResultDelivery(log, {
    turn_id: "turn-1",
    inference_id: id,
    provider: "openrouter",
    model: MODEL,
    status: "delivered",
    observed_model_id: MODEL,
    output_digest: "b".repeat(64),
  });
}

function completeEvidenceLog(includeMutation = true) {
  const log = createSessionEventLog("glm-cert");
  recordUserSubmitted(log, {
    turn_id: "turn-1",
    task: "certify",
    model: MODEL,
    provider: "openrouter",
  });
  addInference(log, "inference-a");
  recordToolProposed(log, {
    turn_id: "turn-1",
    tool_call_id: "tool-1",
    tool_name: "read_file",
  });
  recordToolStarted(log, {
    turn_id: "turn-1",
    tool_call_id: "tool-1",
    tool_name: "read_file",
  });
  recordToolTerminal(log, {
    turn_id: "turn-1",
    tool_call_id: "tool-1",
    tool_name: "read_file",
    exit_code: 0,
    content: "ok",
  });
  recordToolProposed(log, {
    turn_id: "turn-1",
    tool_call_id: "tool-verify",
    tool_name: "run_command",
  });
  recordToolStarted(log, {
    turn_id: "turn-1",
    tool_call_id: "tool-verify",
    tool_name: "run_command",
  });
  recordToolTerminal(log, {
    turn_id: "turn-1",
    tool_call_id: "tool-verify",
    tool_name: "run_command",
    exit_code: 0,
    content: "tests passed",
  });
  if (includeMutation) {
    recordMutationBatch(log, "turn-1", {
      paths: ["src/example.ts"],
      pre_hash: "a".repeat(64),
      post_hash: "b".repeat(64),
      status: "applied",
    });
  }
  recordVerifierAttempt(log, {
    turn_id: "turn-1",
    command_preview: "npm test -- example",
    authoritative: true,
    exit_code: 0,
    tool_call_id: "tool-verify",
  });
  addInference(log, "inference-b", ["tool-1", "tool-verify"]);
  recordCompletionDecision(log, "turn-1", {
    requestedOutcome: "VERIFIED_COMPLETE",
    finalOutcome: "VERIFIED_COMPLETE",
    allowed: true,
    reason: "verifier passed",
    evidenceRefs: ["thread_events.json"],
    policyVersion: "test-v1",
  });
  recordTurnEnded(log, {
    turn_id: "turn-1",
    outcome: "VERIFIED_COMPLETE",
    status: "complete",
  });
  return log;
}

describe("GLM certification ladder", () => {
  test("requires exact route and gates C0–C4 on persisted evidence", () => {
    const log = completeEvidenceLog();
    const stages = Object.fromEntries(GLM_CERTIFICATION_STAGES.map((stage) => [
      stage,
      [stage === "C3" ? completeEvidenceLog(false) : log],
    ]));
    const report = evaluateGlmCertification({ stages });
    assert.equal(report.overall_status, "pass");
    assert.equal(report.c0_c4_green, true);
    assert.ok(report.gates.every((gate) => gate.status === "pass"));
  });

  test("missing or wrong observed identity cannot pass certification", () => {
    const log = completeEvidenceLog();
    const result = log.events.find(
      (event) => event.kind === "model_result_delivery",
    );
    assert.ok(result && result.kind === "model_result_delivery");
    result.observed_model_id = null;
    const report = evaluateGlmCertification({ stages: { C0: [log] } });
    assert.equal(report.overall_status, "fail");
    assert.equal(report.gates[0]!.status, "fail");
  });

  test("failed or orphaned result delivery cannot pass a certification gate", () => {
    const log = completeEvidenceLog();
    const result = log.events.find(
      (event) => event.kind === "model_result_delivery",
    );
    assert.ok(result && result.kind === "model_result_delivery");
    result.status = "failed";
    const report = evaluateGlmCertification({ stages: { C0: [log] } });
    assert.equal(report.gates[0]!.status, "fail");
    assert.match(
      report.gates[0]!.violations.join("\n"),
      /did not produce a delivered result/,
    );
  });

  test("tool certification rejects duplicate settlements and orphan delivery ids", () => {
    const log = completeEvidenceLog();
    const terminal = log.events.find(
      (event) => event.kind === "tool_completed" && event.tool_call_id === "tool-1",
    );
    assert.ok(terminal && terminal.kind === "tool_completed");
    log.events.push({
      ...terminal,
      event_id: "duplicate-terminal",
      seq: log.nextSeq++,
    });
    const secondInference = log.events.find(
      (event) => event.kind === "model_input_receipt" && event.inference_id === "inference-b",
    );
    assert.ok(secondInference && secondInference.kind === "model_input_receipt");
    secondInference.delivered_tool_call_ids = ["tool-1", "missing-tool"];
    const report = evaluateGlmCertification({ stages: { C2: [log] } });
    assert.equal(report.gates[2]!.status, "fail");
    assert.match(report.gates[2]!.violations.join("\n"), /duplicate|unknown tool result/);
  });

  test("tool certification rejects retry settlements that reuse an idempotency key", () => {
    const log = completeEvidenceLog();
    const terminal = log.events.find(
      (event) => event.kind === "tool_completed" && event.tool_call_id === "tool-1",
    );
    assert.ok(terminal && terminal.kind === "tool_completed");
    log.events.push({
      ...terminal,
      event_id: "retry-terminal",
      seq: log.nextSeq++,
      tool_call_id: "tool-1-retry",
    });
    const report = evaluateGlmCertification({ stages: { C2: [log] } });
    assert.equal(report.gates[2]!.status, "fail");
    assert.match(
      report.gates[2]!.violations.join("\n"),
      /idempotency key .* settled more than once/,
    );
  });

  test("tool certification accepts an explicitly settled pre-dispatch denial", () => {
    const log = completeEvidenceLog();
    recordToolProposed(log, {
      turn_id: "turn-1",
      tool_call_id: "tool-denied",
      tool_name: "finish",
    });
    recordToolTerminal(log, {
      turn_id: "turn-1",
      tool_call_id: "tool-denied",
      tool_name: "finish",
      cancelled: true,
      reason: "pre_dispatch_denied_or_invalid",
      recovery_state: "TOOL_NOT_STARTED",
    });
    const report = evaluateGlmCertification({ stages: { C2: [log] } });
    assert.equal(report.gates[2]!.status, "pass");
    assert.match(report.gates[2]!.facts.join("\n"), /settled explicitly before dispatch/);
  });

  test("mutation certification requires a successful verifier result to reach a later inference", () => {
    const log = completeEvidenceLog();
    const laterInference = log.events.find(
      (event) => event.kind === "model_input_receipt" && event.inference_id === "inference-b",
    );
    assert.ok(laterInference && laterInference.kind === "model_input_receipt");
    laterInference.seq = -1;
    const report = evaluateGlmCertification({ stages: { C4: [log] } });
    assert.equal(report.gates[4]!.status, "unknown");
    assert.match(
      report.gates[4]!.missing.join("\n"),
      /verifier result delivered into a subsequent inference/,
    );
  });

  test("read-only certification rejects mutation evidence", () => {
    const report = evaluateGlmCertification({ stages: { C3: [completeEvidenceLog()] } });
    assert.equal(report.gates[3]!.status, "fail");
    assert.match(report.gates[3]!.violations.join("\n"), /mutation batch/);
  });

  test("mutation certification requires an authoritative verifier", () => {
    const log = completeEvidenceLog();
    const verifier = log.events.find((event) => event.kind === "verifier_attempt");
    assert.ok(verifier && verifier.kind === "verifier_attempt");
    verifier.authoritative = false;
    const report = evaluateGlmCertification({ stages: { C4: [log] } });
    assert.equal(report.gates[4]!.status, "fail");
    assert.match(report.gates[4]!.violations.join("\n"), /authoritative verifier/);
  });

  test("missing evidence is unknown and does not become a green gate", () => {
    const report = evaluateGlmCertification({ stages: {} });
    assert.equal(report.overall_status, "unknown");
    assert.equal(report.c0_c4_green, false);
    assert.ok(report.gates.every((gate) => gate.status === "unknown"));
  });

  test("route assertion rejects substitution", () => {
    assert.doesNotThrow(() =>
      assertGlmCertificationRoute({
        backendKey: "glm-5.3-flash",
        provider: "openrouter",
        providerModelId: MODEL,
      }),
    );
    assert.throws(
      () =>
        assertGlmCertificationRoute({
          backendKey: "deepseek-v4-flash",
          provider: "deepseek",
          providerModelId: "deepseek-v4-flash",
        }),
      /requires openrouter/,
    );
  });

  test("persists JSON and Markdown certification receipts", () => {
    const root = mkdtempSync(join(tmpdir(), "glm-cert-report-"));
    try {
      const report = evaluateGlmCertification({ stages: {} });
      const paths = writeGlmCertificationReport(root, report);
      assert.equal(existsSync(paths.jsonPath), true);
      assert.equal(existsSync(paths.markdownPath), true);
      assert.equal(
        JSON.parse(readFileSync(paths.jsonPath, "utf8")).kind,
        "babel_glm_certification_report",
      );
      assert.match(readFileSync(paths.markdownPath, "utf8"), /C0-C4/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads a persisted C0–C6 stage bundle with referential closure", () => {
    const root = mkdtempSync(join(tmpdir(), "glm-cert-stages-"));
    try {
      for (const stage of GLM_CERTIFICATION_STAGES) {
        const stageDir = join(root, stage);
        mkdirSync(stageDir, { recursive: true });
        writeFileSync(join(stageDir, "thread_events.json"), "[]\n");
        rewriteSessionEventLog(stageDir, completeEvidenceLog(stage !== "C3"));
      }
      const bundle = loadGlmCertificationStages(root);
      assert.deepEqual(bundle.loaded_stages, [...GLM_CERTIFICATION_STAGES]);
      assert.deepEqual(bundle.missing_stages, []);
      const report = evaluateGlmCertification(bundle);
      assert.equal(report.overall_status, "pass");
      assert.equal(report.c0_c4_green, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
