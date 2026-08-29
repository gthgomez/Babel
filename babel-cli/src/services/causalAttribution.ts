import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SessionEvent, SessionEventLog } from "../agent/sessionEvents.js";
import { validateContextManifest } from "../agent/contextManifest.js";
import {
  collectCalibrationEvidenceRefs,
  deriveCalibrationOutcome,
  type CalibrationEvidenceRef,
} from "./chatCalibrationOutcome.js";

/**
 * Evidence-backed failure attribution for live model experiments.
 *
 * This is a read-only projection over existing runtime receipts. It never
 * assigns model blame unless every prerequisite in the no-false-model-blame
 * invariant is established by observable evidence.
 */

export type AttributionFamily =
  | "model"
  | "harness"
  | "environment"
  | "provider"
  | "task"
  | "verifier"
  | "budget"
  | "unknown";

export type AttributionConfidence = "high" | "medium" | "low";

export interface CausalAttributionEvidence {
  information_existed: boolean | null;
  /** Whether the requested exact provider/model route was used. */
  route_correct?: boolean | null;
  result_delivered: boolean | null;
  context_preserved: boolean | null;
  capability_advertised: boolean | null;
  capability_authorized: boolean | null;
  capability_effective: boolean | null;
  execution_failure?: string | null;
  task_feasible: boolean | null;
  evidence_complete: boolean;
  model_behavior: "incorrect" | "loop" | "premature_completion" | "none" | null;
  provider_failure?: string | null;
  environment_failure?: string | null;
  harness_failure?: string | null;
  task_failure?: string | null;
  verifier_failure?: string | null;
  budget_failure?: string | null;
  authority_contradiction?: boolean;
}

export interface CausalAttribution {
  family: AttributionFamily;
  code: string;
  confidence: AttributionConfidence;
  model_blame_permitted: boolean;
  evidence: string[];
  counterevidence: string[];
  unknowns: string[];
  evidence_refs?: CalibrationEvidenceRef[];
}

export interface CausalRunWhyReport {
  schema_version: 1;
  kind: "babel_causal_attribution_report";
  status: "ok" | "unknown";
  run_dir?: string;
  session_id?: string;
  terminal_outcome: string | null;
  event_count: number;
  lifecycle: {
    inference_count: number;
    delivered_result_count: number;
    failed_result_count: number;
    tool_proposal_count: number;
    tool_terminal_count: number;
    mutation_count: number;
    verifier_count: number;
    compaction_count: number;
  };
  attribution: CausalAttribution;
  task_outcome?: string;
  session_outcome?: string;
  runtime_integrity?: string;
  causal_failure?: string;
  impact?: "TASK_OUTCOME_AFFECTED" | "TASK_OUTCOME_UNAFFECTED";
  evidence_refs?: CalibrationEvidenceRef[];
}

function unknownFields(input: CausalAttributionEvidence): string[] {
  const fields: Array<[string, boolean | null]> = [
    ["information_existed", input.information_existed],
    ["route_correct", input.route_correct ?? true],
    ["result_delivered", input.result_delivered],
    ["context_preserved", input.context_preserved],
    ["capability_advertised", input.capability_advertised],
    ["capability_authorized", input.capability_authorized],
    ["capability_effective", input.capability_effective],
    ["task_feasible", input.task_feasible],
  ];
  return fields.filter(([, value]) => value === null).map(([name]) => name);
}

function baseUnknowns(input: CausalAttributionEvidence): CausalAttribution {
  const unknowns = unknownFields(input);
  if (!input.evidence_complete) unknowns.push("evidence_complete");
  return {
    family: "unknown",
    code: "insufficient_evidence",
    confidence: "low",
    model_blame_permitted: false,
    evidence: [],
    counterevidence: [],
    unknowns,
  };
}

/** Attribute a failed action without inferring beyond observable evidence. */
export function attributeCausalFailure(
  input: CausalAttributionEvidence,
): CausalAttribution {
  const unknown = baseUnknowns(input);
  if (!input.evidence_complete) return unknown;

  if (input.authority_contradiction) {
    return {
      ...unknown,
      family: "harness",
      code: "authority_contradiction",
      confidence: "high",
      evidence: [
        "capability authorization receipts contradict durable policy or execution evidence",
      ],
      counterevidence: [
        "the contradiction prevents a clean model-versus-harness comparison",
      ],
    };
  }

  if (input.provider_failure) {
    return {
      ...unknown,
      family: "provider",
      code: input.provider_failure,
      confidence: "high",
      evidence: ["provider failure was directly observed"],
    };
  }
  if (input.route_correct === false) {
    return {
      ...unknown,
      family: "harness",
      code: "wrong_model_route",
      confidence: "high",
      evidence: ["requested and observed model route identities disagree"],
    };
  }
  if (input.harness_failure) {
    return {
      ...unknown,
      family: "harness",
      code: input.harness_failure,
      confidence: "high",
      evidence: ["harness failure was directly observed"],
    };
  }
  if (input.environment_failure) {
    return {
      ...unknown,
      family: "environment",
      code: input.environment_failure,
      confidence: "high",
      evidence: ["environment failure was directly observed"],
    };
  }
  if (input.task_failure) {
    return {
      ...unknown,
      family: "task",
      code: input.task_failure,
      confidence: "high",
      evidence: ["task or dependency failure was directly observed"],
    };
  }
  if (input.verifier_failure) {
    return {
      ...unknown,
      family: "verifier",
      code: input.verifier_failure,
      confidence: "high",
      evidence: ["verifier failure was directly observed"],
    };
  }
  if (input.budget_failure) {
    return {
      ...unknown,
      family: "budget",
      code: input.budget_failure,
      confidence: "high",
      evidence: ["budget termination was directly observed"],
    };
  }

  if (input.capability_advertised === false) {
    return {
      ...unknown,
      family: "harness",
      code: "capability_not_advertised",
      confidence: "high",
      evidence: ["required capability was not advertised to the model"],
      counterevidence: ["model could not choose an unadvertised capability"],
    };
  }
  if (input.capability_authorized === false) {
    return {
      ...unknown,
      family: "harness",
      code: "policy_denied_capability",
      confidence: "high",
      evidence: ["capability was advertised but policy/authority denied it"],
    };
  }
  if (input.capability_effective === false) {
    return {
      ...unknown,
      family: "environment",
      code: "capability_not_effective",
      confidence: "high",
      evidence: [
        "capability was advertised and authorized but unusable in the environment",
      ],
    };
  }
  if (input.execution_failure) {
    return {
      ...unknown,
      family: "harness",
      code: input.execution_failure,
      confidence: "high",
      evidence: [
        "authorization existed but the executor did not cross the start boundary",
      ],
    };
  }
  if (input.result_delivered === false) {
    return {
      ...unknown,
      family: "harness",
      code: "result_not_delivered",
      confidence: "high",
      evidence: [
        "tool/process result existed but was not delivered to the next inference",
      ],
    };
  }
  if (input.context_preserved === false) {
    return {
      ...unknown,
      family: "harness",
      code: "context_evidence_lost",
      confidence: "high",
      evidence: ["relevant evidence was lost during compaction or truncation"],
    };
  }
  if (input.task_feasible === false) {
    return {
      ...unknown,
      family: "task",
      code: "task_infeasible",
      confidence: "high",
      evidence: ["task was independently established as infeasible"],
    };
  }

  const prerequisites = [
    input.information_existed,
    input.route_correct ?? true,
    input.result_delivered,
    input.context_preserved,
    input.capability_advertised,
    input.capability_authorized,
    input.capability_effective,
    input.task_feasible,
  ];
  if (prerequisites.some((value) => value !== true)) return unknown;

  if (input.model_behavior === "incorrect") {
    return {
      ...unknown,
      family: "model",
      code: "incorrect_action_despite_evidence",
      confidence: "high",
      model_blame_permitted: true,
      evidence: [
        "all delivery, capability, context, and feasibility prerequisites were proven",
      ],
    };
  }
  if (input.model_behavior === "loop") {
    return {
      ...unknown,
      family: "model",
      code: "loop_or_stall_despite_usable_capability",
      confidence: "high",
      model_blame_permitted: true,
      evidence: [
        "model repeatedly selected ineffective actions while the harness was usable",
      ],
    };
  }
  if (input.model_behavior === "premature_completion") {
    return {
      ...unknown,
      family: "model",
      code: "premature_completion_despite_evidence",
      confidence: "high",
      model_blame_permitted: true,
      evidence: [
        "model terminated despite delivered evidence and usable verification capability",
      ],
    };
  }

  return {
    ...unknown,
    family: "unknown",
    code: "no_failure_signal",
    confidence: "low",
    evidence: [
      "prerequisites were established but no observable model failure signal was supplied",
    ],
  };
}

function capabilityState(
  events: readonly SessionEvent[],
  bindings: Extract<SessionEvent, { kind: "capability_binding_receipt" }>[],
  field: "advertised" | "authorized" | "effective",
): boolean | null {
  if (bindings.length === 0) return null;
  const states = bindings.map((binding) => {
    const proposed = events.filter(
      (event): event is Extract<SessionEvent, { kind: "tool_proposed" }> =>
        event.kind === "tool_proposed" &&
        event.tool_name === binding.capability,
    );
    const proposedIds = new Set(proposed.map((event) => event.tool_call_id));
    const preDispatchDenied = events.some(
      (event): event is Extract<SessionEvent, { kind: "tool_cancelled" }> =>
        event.kind === "tool_cancelled" &&
        proposedIds.has(event.tool_call_id) &&
        event.recovery_state === "TOOL_NOT_STARTED" &&
        /pre_dispatch_denied_or_invalid/i.test(event.reason ?? ""),
    );
    if (field === "authorized" && preDispatchDenied) return false;
    if (binding[field] !== null) return binding[field];
    if (field === "advertised") return null;
    const started = events.some(
      (event): event is Extract<SessionEvent, { kind: "tool_started" }> =>
        event.kind === "tool_started" && proposedIds.has(event.tool_call_id),
    );
    if (preDispatchDenied) return false;
    if (field === "authorized") return started ? true : null;
    if (!started) return null;

    const terminals = events.filter(
      (
        event,
      ): event is Extract<
        SessionEvent,
        { kind: "tool_completed" | "tool_failed" | "tool_cancelled" }
      > =>
        (event.kind === "tool_completed" ||
          event.kind === "tool_failed" ||
          event.kind === "tool_cancelled") &&
        proposedIds.has(event.tool_call_id),
    );
    if (terminals.length === 0) return null;
    if (terminals.some((event) => event.kind === "tool_completed")) return true;
    const failed = terminals.find((event) => event.kind === "tool_failed");
    if (failed) {
      return !/ENOENT|not found|permission|EACCES|read-only/i.test(
        failed.error_preview ?? "",
      );
    }
    return null;
  });
  if (states.some((state) => state === false)) return false;
  if (states.length > 0 && states.every((state) => state === true)) return true;
  return null;
}

function authorityContradiction(events: readonly SessionEvent[]): boolean {
  const deniedCapabilities = new Set(
    events
      .filter(
        (event): event is Extract<SessionEvent, { kind: "tool_cancelled" }> =>
          event.kind === "tool_cancelled" &&
          event.recovery_state === "TOOL_NOT_STARTED" &&
          /pre_dispatch_denied_or_invalid/i.test(event.reason ?? ""),
      )
      .map((event) => event.tool_name),
  );
  return events.some(
    (event) =>
      event.kind === "capability_binding_receipt" &&
      event.authorized === true &&
      deniedCapabilities.has(event.capability),
  );
}

function relevantBindings(
  events: readonly SessionEvent[],
): Extract<SessionEvent, { kind: "capability_binding_receipt" }>[] {
  const bindings = events.filter(
    (
      event,
    ): event is Extract<SessionEvent, { kind: "capability_binding_receipt" }> =>
      event.kind === "capability_binding_receipt",
  );
  const proposedNames = new Set(
    events
      .filter(
        (event): event is Extract<SessionEvent, { kind: "tool_proposed" }> =>
          event.kind === "tool_proposed",
      )
      .map((event) => event.tool_name),
  );
  const matching = bindings.filter((binding) =>
    proposedNames.has(binding.capability),
  );
  return matching.length > 0 ? matching : bindings;
}

function contextPreserved(events: readonly SessionEvent[]): boolean | null {
  const inputManifests = events
    .filter(
      (
        event,
      ): event is Extract<SessionEvent, { kind: "model_input_receipt" }> =>
        event.kind === "model_input_receipt" &&
        event.context_manifest !== undefined,
    )
    .map((event) => event.context_manifest!);
  if (inputManifests.length > 0) {
    try {
      inputManifests.forEach(validateContextManifest);
      const statuses = inputManifests.map(
        (manifest) => manifest.preservation_status,
      );
      if (statuses.some((status) => status === false)) return false;
      if (statuses.every((status) => status === true)) return true;
    } catch {
      return null;
    }
  }
  const compactions = events.filter(
    (
      event,
    ): event is Extract<
      SessionEvent,
      { kind: "compaction_summary" | "compaction_committed" }
    > =>
      event.kind === "compaction_summary" ||
      event.kind === "compaction_committed",
  );
  if (compactions.length === 0) return null;
  const toolIds = new Set(
    events
      .filter(
        (
          event,
        ): event is Extract<
          SessionEvent,
          { kind: "tool_completed" | "tool_failed" | "tool_cancelled" }
        > =>
          event.kind === "tool_completed" ||
          event.kind === "tool_failed" ||
          event.kind === "tool_cancelled",
      )
      .map((event) => event.tool_call_id),
  );
  const preserved = new Set(
    compactions.flatMap((event) => event.preserved_tool_call_ids),
  );
  return [...toolIds].some((toolId) => !preserved.has(toolId)) ? false : true;
}

function routeCorrect(events: readonly SessionEvent[]): boolean | null {
  const inputs = events.filter(
    (event): event is Extract<SessionEvent, { kind: "model_input_receipt" }> =>
      event.kind === "model_input_receipt",
  );
  if (inputs.length === 0) return null;
  if (
    inputs.some(
      (input) =>
        input.requested_model_id !== input.normalized_model_id ||
        input.normalized_model_id !== input.sent_model_id,
    )
  ) {
    return false;
  }
  const results = events.filter(
    (
      event,
    ): event is Extract<SessionEvent, { kind: "model_result_delivery" }> =>
      event.kind === "model_result_delivery" && event.observed_model_id != null,
  );
  if (results.some((result) => result.observed_model_id !== result.model))
    return false;
  return results.length === inputs.length ? true : null;
}

function modelBehavior(
  events: readonly SessionEvent[],
): CausalAttributionEvidence["model_behavior"] {
  const proposals = events.filter(
    (event): event is Extract<SessionEvent, { kind: "tool_proposed" }> =>
      event.kind === "tool_proposed",
  );
  const signatures = new Map<string, number>();
  for (const proposal of proposals) {
    const signature = `${proposal.tool_name}\n${proposal.target_summary ?? ""}\n${proposal.args_digest ?? ""}`;
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  if ([...signatures.values()].some((count) => count >= 3)) return "loop";

  const completion = [...events]
    .reverse()
    .find(
      (
        event,
      ): event is Extract<SessionEvent, { kind: "completion_decision" }> =>
        event.kind === "completion_decision",
    );
  const failedVerifier = events.some(
    (event) =>
      event.kind === "verifier_attempt" &&
      event.exit_code !== undefined &&
      event.exit_code !== 0,
  );
  if (completion?.allowed === true && failedVerifier)
    return "premature_completion";
  return "none";
}

/**
 * Build the smallest useful `inspect why` projection over canonical session
 * events. Missing or ambiguous facts remain UNKNOWN; this function never
 * upgrades an attribution based on model text alone.
 */
export function buildCausalAttributionReport(input: {
  log: Pick<SessionEventLog, "session_id" | "events"> | null;
  runDir?: string;
  loadError?: string;
  facts?: {
    information_existed?: boolean | null;
    task_feasible?: boolean | null;
  };
}): CausalRunWhyReport {
  const events = input.log?.events ?? [];
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
  const resultByInference = new Map<
    string,
    Extract<SessionEvent, { kind: "model_result_delivery" }>
  >();
  for (const result of results)
    resultByInference.set(result.inference_id, result);
  const delivered =
    inputs.length > 0
      ? inputs.every(
          (input) =>
            resultByInference.get(input.inference_id)?.status === "delivered",
        )
      : null;
  const bindings = relevantBindings(events);
  const phases = events.filter(
    (
      event,
    ): event is Extract<SessionEvent, { kind: "model_invocation_phase" }> =>
      event.kind === "model_invocation_phase",
  );
  const providerPhase = phases.find(
    (phase) =>
      phase.phase === "provider_error" ||
      phase.phase === "response_normalization_failed",
  );
  const failedResult = results.find((result) => result.status === "failed");
  const missingResult = inputs.some(
    (input) => !resultByInference.has(input.inference_id),
  );
  const environmentFailure = events
    .filter(
      (event): event is Extract<SessionEvent, { kind: "tool_failed" }> =>
        event.kind === "tool_failed",
    )
    .map((event) => event.error_preview ?? "")
    .find((preview) =>
      /ENOENT|not found|permission|EACCES|read-only/i.test(preview),
    );
  const budgetFailure = events.some(
    (event) =>
      event.kind === "budget_snapshot" &&
      (event.turns_remaining === 0 ||
        event.tokens_remaining === 0 ||
        event.repair_attempts_remaining === 0),
  );
  const inputReferencesResolvable = inputs.every((receipt) => {
    if (isAbsolute(receipt.input_ref)) return existsSync(receipt.input_ref);
    return (
      input.runDir !== undefined &&
      existsSync(join(input.runDir, receipt.input_ref))
    );
  });
  const evidenceComplete =
    input.log !== null && !input.loadError && inputReferencesResolvable;
  let attribution = attributeCausalFailure({
    information_existed:
      input.facts?.information_existed ?? (inputs.length > 0 ? true : null),
    route_correct: routeCorrect(events),
    result_delivered: delivered,
    context_preserved: contextPreserved(events),
    capability_advertised: capabilityState(events, bindings, "advertised"),
    capability_authorized: capabilityState(events, bindings, "authorized"),
    capability_effective: capabilityState(events, bindings, "effective"),
    task_feasible: input.facts?.task_feasible ?? null,
    evidence_complete: evidenceComplete,
    model_behavior: modelBehavior(events),
    ...(providerPhase
      ? {
          provider_failure:
            providerPhase.phase === "response_normalization_failed"
              ? "response_normalization_failed"
              : "provider_error",
        }
      : {}),
    ...(failedResult || missingResult
      ? { harness_failure: "result_not_delivered" }
      : {}),
    ...(environmentFailure ? { environment_failure: environmentFailure } : {}),
    ...(budgetFailure ? { budget_failure: "budget_exhausted" } : {}),
    ...(authorityContradiction(events)
      ? { authority_contradiction: true }
      : {}),
  });
  if (!inputReferencesResolvable) {
    attribution = {
      ...attribution,
      unknowns: [
        ...new Set([...attribution.unknowns, "input_reference_unresolvable"]),
      ],
    };
  }
  const terminal = [...events]
    .reverse()
    .find((event) => event.kind === "turn_ended");
  const evidenceRefs = collectCalibrationEvidenceRefs(events);
  const terminalOutcome =
    terminal?.kind === "turn_ended" ? terminal.outcome : null;
  const verifierSuccessful = events.some(
    (event) =>
      event.kind === "verifier_attempt" &&
      (event.exit_code === undefined || event.exit_code === 0),
  );
  const orthogonal = deriveCalibrationOutcome(
    {
      status: terminalOutcome,
      contract_success: terminalOutcome === "VERIFIED_COMPLETE",
      hidden_ok: verifierSuccessful,
      production_mutated: events.some(
        (event) => event.kind === "mutation_batch",
      ),
    },
    {
      schema_version: 1,
      kind: "babel_causal_attribution_report",
      status: evidenceComplete ? "ok" : "unknown",
      terminal_outcome: terminalOutcome,
      event_count: events.length,
      lifecycle: {
        inference_count: inputs.length,
        delivered_result_count: results.filter(
          (result) => result.status === "delivered",
        ).length,
        failed_result_count: results.filter(
          (result) => result.status === "failed",
        ).length,
        tool_proposal_count: events.filter(
          (event) => event.kind === "tool_proposed",
        ).length,
        tool_terminal_count: events.filter(
          (event) =>
            event.kind === "tool_completed" ||
            event.kind === "tool_failed" ||
            event.kind === "tool_cancelled",
        ).length,
        mutation_count: events.filter(
          (event) => event.kind === "mutation_batch",
        ).length,
        verifier_count: events.filter(
          (event) => event.kind === "verifier_attempt",
        ).length,
        compaction_count: events.filter(
          (event) =>
            event.kind === "compaction_started" ||
            event.kind === "compaction_summary" ||
            event.kind === "compaction_committed",
        ).length,
      },
      attribution,
    },
    evidenceRefs,
  );
  const attributionWithRefs = { ...attribution, evidence_refs: evidenceRefs };
  return {
    schema_version: 1,
    kind: "babel_causal_attribution_report",
    status: evidenceComplete ? "ok" : "unknown",
    ...(input.runDir !== undefined ? { run_dir: input.runDir } : {}),
    ...(input.log?.session_id !== undefined
      ? { session_id: input.log.session_id }
      : {}),
    terminal_outcome: terminalOutcome,
    event_count: events.length,
    lifecycle: {
      inference_count: inputs.length,
      delivered_result_count: results.filter(
        (result) => result.status === "delivered",
      ).length,
      failed_result_count: results.filter(
        (result) => result.status === "failed",
      ).length,
      tool_proposal_count: events.filter(
        (event) => event.kind === "tool_proposed",
      ).length,
      tool_terminal_count: events.filter(
        (event) =>
          event.kind === "tool_completed" ||
          event.kind === "tool_failed" ||
          event.kind === "tool_cancelled",
      ).length,
      mutation_count: events.filter((event) => event.kind === "mutation_batch")
        .length,
      verifier_count: events.filter(
        (event) => event.kind === "verifier_attempt",
      ).length,
      compaction_count: events.filter(
        (event) =>
          event.kind === "compaction_started" ||
          event.kind === "compaction_summary" ||
          event.kind === "compaction_committed",
      ).length,
    },
    attribution: input.loadError
      ? {
          ...attributionWithRefs,
          evidence: [],
          unknowns: [...new Set([...attribution.unknowns, input.loadError])],
        }
      : attributionWithRefs,
    task_outcome: orthogonal.task_outcome,
    session_outcome: orthogonal.session_outcome,
    runtime_integrity: orthogonal.runtime_integrity,
    causal_failure: orthogonal.causal_failure,
    impact: orthogonal.impact,
    evidence_refs: evidenceRefs,
  };
}

export function formatCausalAttributionHuman(
  report: CausalRunWhyReport,
): string {
  const attribution = report.attribution;
  const lines = [
    "Why stopped?",
    `Task outcome: ${report.task_outcome ?? "unknown"}`,
    `Session outcome: ${report.session_outcome ?? report.terminal_outcome ?? "unknown"}`,
    `Runtime integrity: ${report.runtime_integrity ?? "unknown"}`,
    `Primary attribution: ${attribution.family.toUpperCase()}_${attribution.code.toUpperCase()}`,
    `Causal failure: ${report.causal_failure ?? "unknown"}`,
    `Task impact: ${report.impact ?? "unknown"}`,
    `Confidence: ${attribution.confidence}`,
    `Model blame permitted: ${attribution.model_blame_permitted ? "yes" : "no"}`,
    `Terminal outcome: ${report.terminal_outcome ?? "unknown"}`,
    "",
    "Lifecycle:",
    `  inferences=${report.lifecycle.inference_count} results_delivered=${report.lifecycle.delivered_result_count} results_failed=${report.lifecycle.failed_result_count}`,
    `  tools=${report.lifecycle.tool_proposal_count} terminals=${report.lifecycle.tool_terminal_count} mutations=${report.lifecycle.mutation_count} verifiers=${report.lifecycle.verifier_count}`,
  ];
  if (report.evidence_refs && report.evidence_refs.length > 0) {
    lines.push(
      "",
      "Evidence refs:",
      ...report.evidence_refs
        .slice(0, 20)
        .map((ref) => `- seq=${ref.seq} ${ref.event_type} ${ref.event_id}`),
    );
  }
  if (attribution.evidence.length > 0) {
    lines.push(
      "",
      "Facts:",
      ...attribution.evidence.map((fact) => `- ${fact}`),
    );
  }
  if (attribution.counterevidence.length > 0) {
    lines.push(
      "",
      "Counterevidence:",
      ...attribution.counterevidence.map((fact) => `- ${fact}`),
    );
  }
  if (attribution.unknowns.length > 0) {
    lines.push(
      "",
      "Unknowns:",
      ...attribution.unknowns.map((fact) => `- ${fact}`),
    );
  }
  return lines.join("\n");
}
