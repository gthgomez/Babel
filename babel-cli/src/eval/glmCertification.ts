/**
 * Conservative GLM certification ladder over the canonical session evidence.
 *
 * This module does not execute live work or invent receipts. It evaluates
 * persisted evidence produced by the existing ChatEngine/canary paths and
 * keeps missing evidence distinct from a failed gate.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  LIVE_OPENROUTER_MODEL_ID,
  assertLiveModelBackend,
  type ResolvedModelPolicyEntry,
} from "../modelPolicy.js";
import {
  parseSessionEventLog,
  type SessionEvent,
  type SessionEventLog,
} from "../agent/sessionEvents.js";

export const GLM_CERTIFICATION_STAGES = [
  "C0",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
] as const;
export type GlmCertificationStage = (typeof GLM_CERTIFICATION_STAGES)[number];
export type GlmCertificationStatus = "pass" | "fail" | "unknown";

export interface GlmCertificationGate {
  stage: GlmCertificationStage;
  status: GlmCertificationStatus;
  evidence_refs: string[];
  facts: string[];
  missing: string[];
  violations: string[];
}

export interface GlmCertificationReport {
  schema_version: 1;
  kind: "babel_glm_certification_report";
  model: typeof LIVE_OPENROUTER_MODEL_ID;
  provider: "openrouter";
  overall_status: GlmCertificationStatus;
  c0_c4_green: boolean;
  gates: GlmCertificationGate[];
  generated_at: string;
  certification_inputs?: {
    loaded_stages: GlmCertificationStage[];
    missing_stages: GlmCertificationStage[];
  };
}

export interface GlmCertificationInput {
  /** Canonical session logs grouped by certification stage. */
  stages: Partial<Record<GlmCertificationStage, readonly SessionEventLog[]>>;
  /** Optional external artifact references, such as canary JSON files. */
  evidence_refs?: Partial<Record<GlmCertificationStage, readonly string[]>>;
  /** Roots used to resolve relative input_ref values during a persisted audit. */
  reference_roots?: Partial<Record<GlmCertificationStage, readonly string[]>>;
}

export function assertGlmCertificationRoute(
  entry: Pick<
    ResolvedModelPolicyEntry,
    "backendKey" | "provider" | "providerModelId"
  >,
  context = "GLM certification",
): void {
  assertLiveModelBackend(entry, context);
  if (
    entry.provider !== "openrouter" ||
    entry.providerModelId !== LIVE_OPENROUTER_MODEL_ID
  ) {
    throw new Error(
      `[LIVE_MODEL_POLICY] ${context} requires openrouter/${LIVE_OPENROUTER_MODEL_ID}; ` +
        `received ${entry.provider}/${entry.providerModelId}.`,
    );
  }
}

function eventsFor(logs: readonly SessionEventLog[]): SessionEvent[] {
  return logs.flatMap((log) => log.events);
}

function evaluateStage(
  stage: GlmCertificationStage,
  logs: readonly SessionEventLog[] | undefined,
  evidenceRefs: readonly string[],
  referenceRoots: readonly string[],
): GlmCertificationGate {
  const facts: string[] = [];
  const missing: string[] = [];
  const violations: string[] = [];
  if (!logs || logs.length === 0) {
    return {
      stage,
      status: "unknown",
      evidence_refs: [...evidenceRefs],
      facts,
      missing: ["at least one persisted session event log"],
      violations,
    };
  }

  const events = eventsFor(logs);
  const inputs = events.filter(
    (event): event is Extract<SessionEvent, { kind: "model_input_receipt" }> =>
      event.kind === "model_input_receipt",
  );
  const results = events.filter(
    (
      event,
    ): event is Extract<SessionEvent, { kind: "model_result_delivery" }> =>
      event.kind === "model_result_delivery",
  );
  const invocationPhases = events.filter(
    (
      event,
    ): event is Extract<SessionEvent, { kind: "model_invocation_phase" }> =>
      event.kind === "model_invocation_phase",
  );
  const failovers = events.filter((event) => event.kind === "model_failover");
  const inputCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const input of inputs) {
    inputCounts.set(
      input.inference_id,
      (inputCounts.get(input.inference_id) ?? 0) + 1,
    );
  }
  for (const result of results) {
    resultCounts.set(
      result.inference_id,
      (resultCounts.get(result.inference_id) ?? 0) + 1,
    );
  }
  for (const [inferenceId, count] of inputCounts) {
    if (count > 1) {
      violations.push(`inference ${inferenceId} has duplicate input receipts`);
    }
    const resultCount = resultCounts.get(inferenceId) ?? 0;
    if (resultCount === 0) {
      missing.push(`result delivery for inference ${inferenceId}`);
    } else if (resultCount > 1) {
      violations.push(
        `inference ${inferenceId} has duplicate result deliveries`,
      );
    }
  }
  for (const result of results) {
    if (!inputCounts.has(result.inference_id)) {
      violations.push(
        `result delivery ${result.inference_id} has no matching input receipt`,
      );
    }
    if (result.status !== "delivered") {
      violations.push(
        `inference ${result.inference_id} did not produce a delivered result`,
      );
    }
    if (!result.output_digest) {
      missing.push(`output digest for inference ${result.inference_id}`);
    }
  }
  if (inputs.length === 0) missing.push("model input receipt");
  if (results.length === 0) missing.push("model result delivery receipt");

  const requiredPhases = [
    "request_created",
    "request_dispatched",
    "response_started",
    "first_byte",
    "response_normalized",
  ] as const;
  for (const input of inputs) {
    const phasesForInference = new Set(
      invocationPhases
        .filter((phase) => phase.inference_id === input.inference_id)
        .map((phase) => phase.phase),
    );
    for (const phase of requiredPhases) {
      if (!phasesForInference.has(phase)) {
        missing.push(`inference ${input.inference_id} ${phase} phase`);
      }
    }
  }

  for (const input of inputs) {
    if (
      input.provider !== "openrouter" ||
      input.requested_model_id !== LIVE_OPENROUTER_MODEL_ID ||
      input.normalized_model_id !== LIVE_OPENROUTER_MODEL_ID ||
      input.sent_model_id !== LIVE_OPENROUTER_MODEL_ID
    ) {
      violations.push(
        `inference ${input.inference_id} did not preserve the exact GLM route`,
      );
    }
    if (!input.input_ref) {
      violations.push(`inference ${input.inference_id} has no input reference`);
    } else if (
      referenceRoots.length > 0 &&
      !(
        (isAbsolute(input.input_ref) && existsSync(input.input_ref)) ||
        referenceRoots.some((root) => existsSync(join(root, input.input_ref)))
      )
    ) {
      violations.push(
        `inference ${input.inference_id} input reference does not resolve`,
      );
    }
  }
  for (const result of results) {
    if (
      result.provider !== "openrouter" ||
      result.model !== LIVE_OPENROUTER_MODEL_ID
    ) {
      violations.push(
        `inference ${result.inference_id} delivered through a non-GLM route`,
      );
    }
    if (result.observed_model_id !== LIVE_OPENROUTER_MODEL_ID) {
      violations.push(
        `inference ${result.inference_id} lacks observed identity ${LIVE_OPENROUTER_MODEL_ID}`,
      );
    }
  }
  for (const failover of failovers) {
    if (
      failover.original_provider !== undefined ||
      failover.new_provider !== undefined ||
      failover.original_model !== undefined ||
      failover.new_model !== undefined
    ) {
      violations.push(
        "model failover evidence exists in an exact-locked certification run",
      );
    }
  }
  if (violations.length === 0 && inputs.length > 0 && results.length > 0) {
    facts.push(
      `exact ${LIVE_OPENROUTER_MODEL_ID} input/result identity observed`,
    );
    facts.push("input references are present for every recorded inference");
    facts.push("normalized provider results have persisted delivery receipts");
  }

  if (
    stage === "C2" ||
    stage === "C3" ||
    stage === "C4" ||
    stage === "C5" ||
    stage === "C6"
  ) {
    const capabilityReceipts = events.filter(
      (event) => event.kind === "capability_binding_receipt",
    );
    if (capabilityReceipts.length === 0)
      missing.push("capability binding receipt");
    else
      facts.push(
        `${capabilityReceipts.length} capability binding receipt(s) present`,
      );
  }
  if (stage === "C2") {
    const proposed = events.filter((event) => event.kind === "tool_proposed");
    const started = events.filter((event) => event.kind === "tool_started");
    const terminals = events.filter(
      (event) =>
        event.kind === "tool_completed" ||
        event.kind === "tool_failed" ||
        event.kind === "tool_cancelled",
    );
    const operationKey = (event: {
      tool_call_id: string;
      tool_name: string;
      idempotency_key: string;
    }): string =>
      `${event.tool_call_id}\u0000${event.tool_name}\u0000${event.idempotency_key}`;
    const countByOperation = (
      records: Array<{
        tool_call_id: string;
        tool_name: string;
        idempotency_key: string;
      }>,
    ): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const record of records) {
        const key = operationKey(record);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    };
    const proposalCounts = countByOperation(proposed);
    const startCounts = countByOperation(started);
    const terminalCounts = countByOperation(terminals);
    const terminalCountsByIdempotency = new Map<string, number>();
    for (const terminal of terminals) {
      terminalCountsByIdempotency.set(
        terminal.idempotency_key,
        (terminalCountsByIdempotency.get(terminal.idempotency_key) ?? 0) + 1,
      );
    }
    for (const [key, count] of proposalCounts) {
      if (count !== 1) violations.push(`tool operation ${key} has ${count} proposals`);
      const [toolCallId] = key.split("\u0000");
      const preDispatchCancellation = terminals.some(
        (terminal) =>
          terminal.tool_call_id === toolCallId &&
          terminal.kind === "tool_cancelled" &&
          /pre_dispatch_denied_or_invalid/i.test(terminal.reason ?? ""),
      );
      if ((startCounts.get(key) ?? 0) !== 1 && !preDispatchCancellation) {
        violations.push(`tool operation ${key} does not have exactly one start`);
      }
      if (preDispatchCancellation) {
        facts.push(`tool operation ${key} settled explicitly before dispatch`);
      }
      if ((terminalCounts.get(key) ?? 0) !== 1) {
        violations.push(`tool operation ${key} does not have exactly one terminal settlement`);
      }
    }
    for (const [key, count] of terminalCounts) {
      if (!proposalCounts.has(key)) {
        violations.push(`tool terminal ${key} has no matching proposal`);
      }
      if (count > 1) {
        violations.push(`tool operation ${key} settled more than once`);
      }
    }
    for (const [idempotencyKey, count] of terminalCountsByIdempotency) {
      if (count > 1) {
        violations.push(
          `idempotency key ${idempotencyKey} settled more than once across tool-call retries`,
        );
      }
    }
    const terminalById = new Map(
      terminals.map((event) => [event.tool_call_id, event] as const),
    );
    for (const input of inputs) {
      for (const toolCallId of input.delivered_tool_call_ids ?? []) {
        if (!terminalById.has(toolCallId)) {
          violations.push(`inference ${input.inference_id} delivered unknown tool result ${toolCallId}`);
        }
      }
    }
    if (proposed.length === 0) missing.push("tool proposal");
    if (terminals.length === 0) missing.push("tool terminal result");
    if (inputs.length < 2)
      missing.push("second inference after tool execution");
    if (
      !inputs.some((input) => (input.delivered_tool_call_ids?.length ?? 0) > 0)
    ) {
      missing.push("tool result delivery into the next inference");
    } else {
      facts.push("tool result was generated, persisted, and referenced by a subsequent inference");
    }
  }
  if (stage === "C3") {
    if (!events.some((event) => event.kind === "tool_completed"))
      missing.push("completed read-only tool");
    if (events.some((event) => event.kind === "mutation_batch")) {
      violations.push("read-only certification contains a mutation batch");
    }
  }
  if (stage === "C4") {
    const mutationBatches = events.filter(
      (event) => event.kind === "mutation_batch",
    );
    if (mutationBatches.length === 0)
      missing.push("mutation batch");
    for (const mutation of mutationBatches) {
      if (mutation.paths.length === 0) {
        violations.push("mutation batch has no changed paths");
      }
      if (
        mutation.status !== undefined &&
        /^(blocked|denied|failed|rejected|rolled_back)$/i.test(mutation.status)
      ) {
        violations.push(
          `mutation batch did not settle successfully: ${mutation.status}`,
        );
      }
      if (!mutation.post_hash && !mutation.post_image_hashes) {
        missing.push("post-mutation workspace evidence");
      }
    }
    const verifierAttempts = events.filter(
      (event) => event.kind === "verifier_attempt",
    );
    if (verifierAttempts.length === 0)
      missing.push("verifier attempt");
    const successfulVerifier = verifierAttempts.find(
      (event) => event.exit_code === 0 && event.authoritative === true,
    );
    if (verifierAttempts.length > 0 && !successfulVerifier) {
      violations.push(
        "no successful authoritative verifier receipt exists for the mutation",
      );
    }
    if (successfulVerifier) {
      const subsequentInput = inputs.find((input) => input.seq > successfulVerifier.seq);
      if (!subsequentInput) {
        missing.push("verifier result delivered into a subsequent inference");
      } else if (!successfulVerifier.tool_call_id) {
        missing.push("verifier tool-call correlation");
      } else if (!(subsequentInput.delivered_tool_call_ids ?? []).includes(successfulVerifier.tool_call_id)) {
        missing.push(
          `verifier result ${successfulVerifier.tool_call_id} was not delivered into inference ${subsequentInput.inference_id}`,
        );
      } else {
        facts.push(
          `successful verifier result ${successfulVerifier.tool_call_id} was delivered into inference ${subsequentInput.inference_id}`,
        );
      }
    }
  }
  if (stage === "C5") {
    const completionDecisions = events.filter(
      (event) => event.kind === "completion_decision",
    );
    if (completionDecisions.length === 0) {
      missing.push("completion decision");
    } else {
      if (completionDecisions.length > 1) {
        violations.push("multiple completion decisions exist for the orchestration");
      }
      const decision = completionDecisions[0]!;
      if (!decision.allowed) {
        violations.push("completion decision was not allowed");
      }
    }
  }
  if (stage === "C6" && !events.some((event) => event.kind === "turn_ended")) {
    missing.push("terminal turn evidence");
  }

  return {
    stage,
    status:
      violations.length > 0 ? "fail" : missing.length > 0 ? "unknown" : "pass",
    evidence_refs: [...evidenceRefs],
    facts,
    missing,
    violations,
  };
}

export function evaluateGlmCertification(
  input: GlmCertificationInput,
): GlmCertificationReport {
  const gates = GLM_CERTIFICATION_STAGES.map((stage) =>
    evaluateStage(
      stage,
      input.stages[stage],
      input.evidence_refs?.[stage] ?? [],
      input.reference_roots?.[stage] ?? [],
    ),
  );
  const c0c4 = gates.slice(0, 5);
  const c0_c4_green = c0c4.every((gate) => gate.status === "pass");
  const overall_status = gates.some((gate) => gate.status === "fail")
    ? "fail"
    : gates.every((gate) => gate.status === "pass")
      ? "pass"
      : "unknown";
  return {
    schema_version: 1,
    kind: "babel_glm_certification_report",
    model: LIVE_OPENROUTER_MODEL_ID,
    provider: "openrouter",
    overall_status,
    c0_c4_green,
    gates,
    generated_at: new Date().toISOString(),
  };
}

/** Load one canonical session log from a run directory without weakening parse rules. */
export function loadGlmSessionLog(runDir: string): SessionEventLog | null {
  const path = join(runDir, "session-events.jsonl");
  if (!existsSync(path)) return null;
  return parseSessionEventLog(readFileSync(path, "utf8"));
}

export interface GlmCertificationStageBundle {
  root: string;
  stages: Partial<Record<GlmCertificationStage, readonly SessionEventLog[]>>;
  evidence_refs: Partial<Record<GlmCertificationStage, readonly string[]>>;
  reference_roots: Partial<Record<GlmCertificationStage, readonly string[]>>;
  loaded_stages: GlmCertificationStage[];
  missing_stages: GlmCertificationStage[];
}

/**
 * Load one persisted session-event log from each C0–C6 directory below a
 * certification root. Missing stages remain absent so the evaluator reports
 * UNKNOWN rather than treating an incomplete campaign as green.
 */
export function loadGlmCertificationStages(
  root: string,
): GlmCertificationStageBundle {
  const stages: Partial<
    Record<GlmCertificationStage, readonly SessionEventLog[]>
  > = {};
  const evidence_refs: Partial<
    Record<GlmCertificationStage, readonly string[]>
  > = {};
  const reference_roots: Partial<
    Record<GlmCertificationStage, readonly string[]>
  > = {};
  const loaded_stages: GlmCertificationStage[] = [];
  const missing_stages: GlmCertificationStage[] = [];
  for (const stage of GLM_CERTIFICATION_STAGES) {
    const stageDir = join(root, stage);
    let log: SessionEventLog | null = null;
    try {
      log = loadGlmSessionLog(stageDir);
    } catch {
      // Corrupt evidence is unavailable evidence; the aggregate remains
      // UNKNOWN instead of converting a damaged stage into a pass.
      log = null;
    }
    if (!log) {
      missing_stages.push(stage);
      continue;
    }
    stages[stage] = [log];
    evidence_refs[stage] = [stageDir];
    reference_roots[stage] = [stageDir];
    loaded_stages.push(stage);
  }
  return {
    root,
    stages,
    evidence_refs,
    reference_roots,
    loaded_stages,
    missing_stages,
  };
}

export function writeGlmCertificationReport(
  evidenceDir: string,
  report: GlmCertificationReport,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(evidenceDir, { recursive: true });
  const jsonPath = join(evidenceDir, "glm-certification-report.json");
  const markdownPath = join(evidenceDir, "glm-certification-report.md");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  const lines = [
    "# GLM certification report",
    "",
    `- overall_status: ${report.overall_status}`,
    `- c0_c4_green: ${report.c0_c4_green}`,
    `- C0-C4: ${report.c0_c4_green ? "green" : "not green"}`,
    `- model: ${report.provider}/${report.model}`,
    ...(report.certification_inputs
      ? [
          `- loaded_stages: ${report.certification_inputs.loaded_stages.join(", ") || "none"}`,
          `- missing_stages: ${report.certification_inputs.missing_stages.join(", ") || "none"}`,
        ]
      : []),
    "",
    "| Stage | Status | Missing | Violations |",
    "|---|---|---|---|",
    ...report.gates.map(
      (gate) =>
        `| ${gate.stage} | ${gate.status} | ${gate.missing.join("; ") || "—"} | ${gate.violations.join("; ") || "—"} |`,
    ),
    "",
  ];
  writeFileSync(markdownPath, lines.join("\n"));
  return { jsonPath, markdownPath };
}
