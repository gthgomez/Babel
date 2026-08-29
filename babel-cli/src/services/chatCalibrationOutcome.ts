import type { SessionEvent } from "../agent/sessionEvents.js";
import type { CausalRunWhyReport } from "./causalAttribution.js";

export const TASK_OUTCOMES = [
  "SOLVED",
  "UNSOLVED",
  "CORRECT_NO_CHANGE",
  "TASK_INVALID",
  "NOT_REACHED",
] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const SESSION_OUTCOMES = [
  "VERIFIED_COMPLETE",
  "UNVERIFIED_PATCH",
  "AGENT_FAILURE",
  "BUDGET_EXHAUSTED",
  "PROVIDER_TERMINATED",
  "ENVIRONMENT_BLOCKED",
  "NO_CHANGE_COMPLETE",
] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

export const RUNTIME_INTEGRITIES = [
  "CLEAN",
  "HARNESS_DEGRADED",
  "PROVIDER_DEGRADED",
  "ENVIRONMENT_DEGRADED",
  "MULTIPLE_DEGRADATIONS",
] as const;
export type RuntimeIntegrity = (typeof RUNTIME_INTEGRITIES)[number];

export const CAUSAL_FAILURES = [
  "NONE",
  "HARNESS_POLICY_FAILURE",
  "HARNESS_DELIVERY_FAILURE",
  "HARNESS_CONTEXT_FAILURE",
  "HARNESS_EXECUTION_FAILURE",
  "PROVIDER_FAILURE",
  "ENVIRONMENT_FAILURE",
  "MODEL_FAILURE",
  "VERIFIER_FAILURE",
  "UNKNOWN",
] as const;
export type CausalFailure = (typeof CAUSAL_FAILURES)[number];

export interface CalibrationEvidenceRef {
  event_type: string;
  event_id: string;
  seq: number;
  timestamp: string;
  fields: Record<string, string | number | boolean | null>;
}

export interface CalibrationOutcome {
  task_outcome: TaskOutcome;
  session_outcome: SessionOutcome;
  runtime_integrity: RuntimeIntegrity;
  causal_failure: CausalFailure;
  causal_confidence: "high" | "medium" | "low" | "unknown";
  model_blame_permitted: boolean;
  impact: "TASK_OUTCOME_AFFECTED" | "TASK_OUTCOME_UNAFFECTED";
  legacy_outcome: "success" | "failure" | "blocked" | "unknown";
  evidence_refs: CalibrationEvidenceRef[];
}

export interface CalibrationTrialFacts {
  invalid_task?: boolean;
  honest_block?: boolean;
  status?: string | null;
  contract_success?: boolean | null;
  hidden_ok?: boolean | null;
  production_mutated?: boolean | null;
  false_complete?: boolean;
}

const terminalSessionOutcomes = new Set<string>(SESSION_OUTCOMES);

function causalFailure(report: CausalRunWhyReport | null): CausalFailure {
  const attribution = report?.attribution;
  if (!attribution) return "UNKNOWN";
  if (
    attribution.family === "unknown" &&
    attribution.code === "no_failure_signal"
  )
    return "NONE";
  if (attribution.family === "provider") return "PROVIDER_FAILURE";
  if (attribution.family === "environment") return "ENVIRONMENT_FAILURE";
  if (attribution.family === "verifier") return "VERIFIER_FAILURE";
  if (attribution.family === "model") return "MODEL_FAILURE";
  if (attribution.family === "harness") {
    if (/policy|authority|capability/i.test(attribution.code))
      return "HARNESS_POLICY_FAILURE";
    if (/delivery|result/i.test(attribution.code))
      return "HARNESS_DELIVERY_FAILURE";
    if (/context|compaction|truncat/i.test(attribution.code))
      return "HARNESS_CONTEXT_FAILURE";
    return "HARNESS_EXECUTION_FAILURE";
  }
  return "UNKNOWN";
}

function sessionOutcome(
  facts: CalibrationTrialFacts,
  taskOutcome: TaskOutcome,
  report: CausalRunWhyReport | null,
): SessionOutcome {
  if (taskOutcome === "CORRECT_NO_CHANGE") return "NO_CHANGE_COMPLETE";
  const terminal = report?.terminal_outcome;
  if (terminal && terminalSessionOutcomes.has(terminal))
    return terminal as SessionOutcome;
  if (facts.status === "BLOCKED" || facts.honest_block)
    return "ENVIRONMENT_BLOCKED";
  if (taskOutcome === "NOT_REACHED") return "PROVIDER_TERMINATED";
  return facts.contract_success === true
    ? "VERIFIED_COMPLETE"
    : "AGENT_FAILURE";
}

function runtimeIntegrity(failure: CausalFailure): RuntimeIntegrity {
  if (failure === "NONE") return "CLEAN";
  if (failure === "PROVIDER_FAILURE") return "PROVIDER_DEGRADED";
  if (failure === "ENVIRONMENT_FAILURE") return "ENVIRONMENT_DEGRADED";
  if (failure === "UNKNOWN") return "MULTIPLE_DEGRADATIONS";
  return "HARNESS_DEGRADED";
}

function legacyOutcome(
  taskOutcome: TaskOutcome,
  facts: CalibrationTrialFacts,
): CalibrationOutcome["legacy_outcome"] {
  if (facts.honest_block || facts.status === "BLOCKED") return "blocked";
  if (taskOutcome === "SOLVED" || taskOutcome === "CORRECT_NO_CHANGE")
    return "success";
  if (taskOutcome === "TASK_INVALID" || taskOutcome === "NOT_REACHED")
    return "unknown";
  return "failure";
}

/** Extract compact, stable references without persisting model or tool payloads. */
export function collectCalibrationEvidenceRefs(
  events: readonly SessionEvent[],
): CalibrationEvidenceRef[] {
  const allowed = new Set([
    "inference_id",
    "provider",
    "model",
    "status",
    "phase",
    "status_code",
    "detail",
    "capability",
    "advertised",
    "authorized",
    "effective",
    "receipt",
    "tool_call_id",
    "tool_name",
    "exit_code",
    "recovery_state",
    "reason",
    "paths",
    "pre_hash",
    "post_hash",
    "authoritative",
    "outcome",
    "final_outcome",
    "allowed",
    "requested_outcome",
  ]);
  return events
    .filter(
      (event) =>
        event.kind !== "user_submitted" && event.kind !== "model_started",
    )
    .map((event) => {
      const fields: CalibrationEvidenceRef["fields"] = {};
      for (const [key, value] of Object.entries(
        event as unknown as Record<string, unknown>,
      )) {
        if (key === "receipt") {
          const receipt = value as Record<string, unknown> | null;
          if (receipt && typeof receipt === "object") {
            fields.receipt = JSON.stringify({
              normalized_failure_class: receipt.normalized_failure_class,
              retryable: receipt.retryable,
              retry_attempt: receipt.retry_attempt,
              failure_stage: receipt.failure_stage,
              partial_model_output: receipt.partial_model_output,
              tool_calls_emitted: receipt.tool_calls_emitted,
            });
          }
        } else if (
          allowed.has(key) &&
          (typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            value === null)
        ) {
          fields[key] = value;
        }
      }
      return {
        event_type: event.kind,
        event_id: event.event_id,
        seq: event.seq,
        timestamp: event.ts,
        fields,
      };
    });
}

/** Derive the calibration dimensions from task facts and causal evidence. */
export function deriveCalibrationOutcome(
  facts: CalibrationTrialFacts,
  report: CausalRunWhyReport | null,
  evidenceRefs: CalibrationEvidenceRef[] = [],
): CalibrationOutcome {
  const taskOutcome: TaskOutcome = facts.invalid_task
    ? "TASK_INVALID"
    : facts.contract_success === true &&
        facts.hidden_ok === true &&
        facts.production_mutated === true
      ? "SOLVED"
      : facts.contract_success === true &&
          facts.hidden_ok === true &&
          facts.production_mutated === false
        ? "CORRECT_NO_CHANGE"
        : facts.contract_success === false ||
            facts.hidden_ok === false ||
            facts.false_complete === true
          ? "UNSOLVED"
          : report?.lifecycle.inference_count === 0
            ? "NOT_REACHED"
            : "UNSOLVED";
  const failure = causalFailure(report);
  const session = sessionOutcome(facts, taskOutcome, report);
  const runtime = runtimeIntegrity(failure);
  return {
    task_outcome: taskOutcome,
    session_outcome: session,
    runtime_integrity: runtime,
    causal_failure: failure,
    causal_confidence: report?.attribution.confidence ?? "unknown",
    model_blame_permitted: report?.attribution.model_blame_permitted ?? false,
    impact:
      taskOutcome === "SOLVED" || taskOutcome === "CORRECT_NO_CHANGE"
        ? "TASK_OUTCOME_UNAFFECTED"
        : "TASK_OUTCOME_AFFECTED",
    legacy_outcome: legacyOutcome(taskOutcome, facts),
    evidence_refs: evidenceRefs,
  };
}
