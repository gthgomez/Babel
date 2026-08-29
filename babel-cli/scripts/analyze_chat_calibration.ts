/**
 * Offline post-calibration checkpoint.
 *
 * Reads only a frozen campaign manifest and per-cell JSON reports. Missing or
 * malformed evidence stays UNKNOWN; this command never calls a provider and
 * never invents paired model results.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  buildChatCalibrationSchedule,
  CHAT_CALIBRATION_MANIFEST_FILENAME,
  evaluateChatCalibrationReadiness,
  validateChatCalibrationManifest,
  type ChatCalibrationCell,
  type ChatCalibrationCellEvidence,
  type ChatCalibrationManifest,
} from "../src/services/chatCalibration.js";
import type { CausalRunWhyReport } from "../src/services/causalAttribution.js";
import { buildCausalAttributionReport } from "../src/services/causalAttribution.js";
import {
  CAUSAL_FAILURES,
  collectCalibrationEvidenceRefs,
  deriveCalibrationOutcome,
  type CalibrationEvidenceRef,
  type CalibrationOutcome,
} from "../src/services/chatCalibrationOutcome.js";
import {
  inspectSessionEventLogFromDir,
  type SessionEventLog,
} from "../src/agent/sessionEvents.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function json(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    return record(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function calibrationOutcome(
  trial: JsonRecord | null,
  report: CausalRunWhyReport | null,
  evidenceRefs: CalibrationEvidenceRef[],
): CalibrationOutcome {
  return deriveCalibrationOutcome(
    {
      invalid_task: trial?.["invalid_task"] === true,
      honest_block: trial?.["honest_block"] === true,
      status: string(trial?.["status"]),
      contract_success: boolean(trial?.["contract_success"]),
      hidden_ok: boolean(trial?.["hidden_ok"]),
      production_mutated: boolean(trial?.["production_mutated"]),
      false_complete: trial?.["false_complete"] === true,
    },
    report,
    evidenceRefs,
  );
}

function causal(trial: JsonRecord | null): CausalRunWhyReport | null {
  const value = record(trial?.["causal_attribution"]);
  return value ? (value as unknown as CausalRunWhyReport) : null;
}

function routeKnown(
  session: JsonRecord | null,
  cell: ChatCalibrationCell,
): boolean {
  const routes = array(session?.["model_routes"])
    .map(record)
    .filter((value): value is JsonRecord => value !== null);
  const observed = new Map(
    array(session?.["observed_models"])
      .map(record)
      .filter((value): value is JsonRecord => value !== null)
      .map((value) => [string(value["inference_id"]), value] as const),
  );
  return (
    routes.length > 0 &&
    routes.every((route) => {
      const inferenceId = string(route["inference_id"]);
      const observedModel = inferenceId ? observed.get(inferenceId) : undefined;
      return (
        route["provider"] === cell.model.provider &&
        route["sent_model_id"] === cell.model.exact_model_id &&
        observedModel?.["observed_model_id"] === cell.model.exact_model_id
      );
    })
  );
}

function eventLogForTrial(trial: JsonRecord | null): SessionEventLog | null {
  const runDir = string(trial?.["run_dir"]);
  if (!runDir) return null;
  const result = inspectSessionEventLogFromDir(runDir);
  return result.kind === "valid" ? result.log : null;
}

function cellEvidence(
  root: string,
  cell: ChatCalibrationCell,
): {
  evidence: ChatCalibrationCellEvidence;
  reportCell: JsonRecord;
} {
  const reportPath = join(root, "cells", cell.cell_id, "report.json");
  const report = json(reportPath);
  const trial = record(array(report?.["trials"])[0]);
  const eventLog = eventLogForTrial(trial);
  const persistedCausalReport = causal(trial);
  const runDir = string(trial?.["run_dir"]);
  const causalReport = eventLog
    ? buildCausalAttributionReport({
        log: eventLog,
        ...(runDir ? { runDir } : {}),
        facts: { information_existed: true, task_feasible: true },
      })
    : persistedCausalReport;
  const evidenceRefs = eventLog
    ? collectCalibrationEvidenceRefs(eventLog.events)
    : [];
  const correctedOutcome = calibrationOutcome(
    trial,
    causalReport,
    evidenceRefs,
  );
  const evidencePath =
    string(trial?.["evidence_path"]) ??
    join(root, "cells", cell.cell_id, "live", `${cell.task_id}-t1-cli.json`);
  const liveEvidence = json(resolve(evidencePath));
  const session = record(liveEvidence?.["session_evidence"]);
  const telemetry = record(session?.["telemetry"]);
  const productTelemetry = record(session?.["product_telemetry"]);
  const inferenceCalls = array(telemetry?.["inference_calls"])
    .map(record)
    .filter((value): value is JsonRecord => value !== null);
  const contextKnown =
    inferenceCalls.length > 0 &&
    inferenceCalls.every(
      (call) => boolean(call["context_preservation"]) !== null,
    );
  const taskFeasible =
    causalReport && !causalReport.attribution.unknowns.includes("task_feasible")
      ? true
      : null;
  const reportCell: JsonRecord = {
    cell_id: cell.cell_id,
    task_id: cell.task_id,
    trial: cell.trial,
    model: cell.model.exact_model_id,
    provider: cell.model.provider,
    outcome: correctedOutcome.legacy_outcome,
    calibration_outcome: correctedOutcome,
    task_outcome: correctedOutcome.task_outcome,
    session_outcome: correctedOutcome.session_outcome,
    runtime_integrity: correctedOutcome.runtime_integrity,
    causal_failure: correctedOutcome.causal_failure,
    evidence_refs: evidenceRefs,
    causal_attribution: causalReport,
    tokens: typeof trial?.["tokens"] === "number" ? trial["tokens"] : null,
    cost_usd:
      typeof trial?.["cost_usd"] === "number" ? trial["cost_usd"] : null,
    wall_ms: typeof trial?.["wall_ms"] === "number" ? trial["wall_ms"] : null,
    writes:
      typeof telemetry?.["workspace"] === "object"
        ? telemetry["workspace"]
        : null,
    verification:
      typeof telemetry?.["verification"] === "object"
        ? telemetry["verification"]
        : null,
    harness_friction:
      typeof telemetry?.["harness_friction"] === "object"
        ? telemetry["harness_friction"]
        : null,
    efficiency: productTelemetry?.["turn_telemetry"] ?? null,
    tool_calls: productTelemetry?.["tool_calls"] ?? null,
    policy_events: productTelemetry?.["policy_events"] ?? null,
    turn_routing: productTelemetry?.["turn_routing"] ?? null,
    turn_summaries: productTelemetry?.["turn_summaries"] ?? null,
    blocked_attempts: productTelemetry?.["blocked_attempts"] ?? null,
    blocked_attempt_counts:
      productTelemetry?.["blocked_attempt_counts"] ?? null,
  };
  const routeMismatch = !routeKnown(session, cell);
  const runtimeCrash =
    causalReport === null &&
    array(trial?.["notes"]).some(
      (note) => typeof note === "string" && /spawn|crash|EPERM/i.test(note),
    );
  return {
    evidence: {
      cell,
      completed:
        report !== null && trial !== null && trial["invalid_task"] !== true,
      outcome: correctedOutcome.legacy_outcome,
      causal_attribution: causalReport,
      task_feasible: taskFeasible,
      capability_authorization_known:
        telemetry?.["capability_authorization_known"] === true,
      tool_terminal_known: telemetry?.["tool_terminal_known"] === true,
      result_delivery_known: telemetry?.["result_delivery_known"] === true,
      verification_revision_known:
        telemetry?.["verification_revision_known"] === true,
      context_preservation_known: contextKnown,
      upstream_provider: string(liveEvidence?.["upstream_provider"]),
      silent_model_substitution:
        routeMismatch && causalReport?.attribution.code === "wrong_model_route",
      unclassified_runtime_crash: runtimeCrash,
      calibration_outcome: correctedOutcome,
    },
    reportCell,
  };
}

function write(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function refreshEvidenceManifest(root: string): string {
  const manifestName = "calibration-evidence-manifest.json";
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const fullPath = join(directory, name);
      if (fullPath === join(root, manifestName)) continue;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) visit(fullPath);
      else if (stat.isFile()) {
        const bytes = readFileSync(fullPath);
        files.push({
          path: fullPath.slice(root.length + 1).replaceAll("\\", "/"),
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  visit(root);
  const path = join(root, manifestName);
  writeFileSync(
    path,
    `${JSON.stringify({ schema_version: 1, kind: "babel_calibration_evidence_manifest", files }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

function parseArgs(argv: string[]): {
  root: string;
  outputRoot: string;
  help: boolean;
} {
  let root = "";
  let outputRoot = "";
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--evidence-dir") root = resolve(argv[++index] ?? "");
    else if (arg === "--output-dir") outputRoot = resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    root,
    outputRoot: outputRoot || (root ? join(root, "offline-rescore") : ""),
    help,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: npx tsx scripts/analyze_chat_calibration.ts --evidence-dir <campaign-dir> [--output-dir <rescore-dir>]\n",
    );
    return;
  }
  if (!args.root) throw new Error("--evidence-dir is required");
  if (resolve(args.outputRoot) === resolve(args.root)) {
    throw new Error(
      "--output-dir must be separate from the immutable evidence directory",
    );
  }
  mkdirSync(args.outputRoot, { recursive: true });
  const canonicalManifestPath = join(
    args.root,
    CHAT_CALIBRATION_MANIFEST_FILENAME,
  );
  const versionedManifestPath = join(
    args.root,
    "chat-calibration-v1.manifest.json",
  );
  const manifestPath = existsSync(canonicalManifestPath)
    ? canonicalManifestPath
    : versionedManifestPath;
  const manifest = json(
    manifestPath,
  ) as unknown as ChatCalibrationManifest | null;
  if (!manifest)
    throw new Error(
      `calibration manifest is missing or invalid: ${manifestPath}`,
    );
  validateChatCalibrationManifest(manifest);

  writeFileSync(
    join(args.outputRoot, "original-campaign-manifest.json"),
    readFileSync(manifestPath),
  );

  const scheduled = new Map(
    buildChatCalibrationSchedule(manifest.schedule_seed).map((cell) => [
      cell.cell_id,
      cell,
    ]),
  );
  const cells: ChatCalibrationCellEvidence[] = [];
  const reportCells: JsonRecord[] = [];
  for (const scheduledCell of manifest.schedule) {
    const cell = scheduled.get(scheduledCell.cell_id);
    if (!cell)
      throw new Error(
        `manifest schedule cell is not recognized: ${scheduledCell.cell_id}`,
      );
    const result = cellEvidence(args.root, cell);
    cells.push(result.evidence);
    reportCells.push(result.reportCell);
    write(
      args.outputRoot,
      join("cells", cell.cell_id, "rescored-report.json"),
      result.reportCell,
    );
  }
  const readiness = evaluateChatCalibrationReadiness(
    cells,
    manifest.campaign_id,
  );
  const counts: Record<string, number> = {};
  for (const cell of reportCells) {
    const family = record(cell["causal_attribution"])?.["attribution"];
    const name = string(record(family)?.["family"]) ?? "unknown";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const models = ["glm", "deepseek"].map((label) => {
    const selected = reportCells.filter(
      (cell) => cell["model"] === manifest.model_ids[label === "glm" ? 0 : 1],
    );
    const outcomeOf = (cell: JsonRecord): CalibrationOutcome | null => {
      const value = record(cell["calibration_outcome"]);
      return value as CalibrationOutcome | null;
    };
    const selectedOutcomes = selected
      .map(outcomeOf)
      .filter((value): value is CalibrationOutcome => value !== null);
    const cleanComparable = selectedOutcomes.filter(
      (value) =>
        value.runtime_integrity === "CLEAN" &&
        value.causal_failure !== "UNKNOWN",
    );
    const countTask = (taskOutcome: string): number =>
      selectedOutcomes.filter((value) => value.task_outcome === taskOutcome)
        .length;
    const countRuntime = (runtime: string): number =>
      selectedOutcomes.filter((value) => value.runtime_integrity === runtime)
        .length;
    const countFailure = (failure: string): number =>
      selectedOutcomes.filter((value) => value.causal_failure === failure)
        .length;
    const numeric = (key: string): number[] =>
      selected
        .map((cell) => cell[key])
        .filter((value): value is number => typeof value === "number");
    const tokens = numeric("tokens");
    const wall = numeric("wall_ms");
    const costs = numeric("cost_usd");
    return {
      label,
      exact_model_id: manifest.model_ids[label === "glm" ? 0 : 1],
      cells: selected.length,
      task_outcomes: Object.fromEntries(
        [
          "SOLVED",
          "UNSOLVED",
          "CORRECT_NO_CHANGE",
          "TASK_INVALID",
          "NOT_REACHED",
        ].map((value) => [value, countTask(value)]),
      ),
      session_outcomes: Object.fromEntries(
        [
          "VERIFIED_COMPLETE",
          "UNVERIFIED_PATCH",
          "AGENT_FAILURE",
          "BUDGET_EXHAUSTED",
          "PROVIDER_TERMINATED",
          "ENVIRONMENT_BLOCKED",
          "NO_CHANGE_COMPLETE",
        ].map((value) => [
          value,
          selectedOutcomes.filter(
            (outcome) => outcome.session_outcome === value,
          ).length,
        ]),
      ),
      runtime_integrity: Object.fromEntries(
        [
          "CLEAN",
          "HARNESS_DEGRADED",
          "PROVIDER_DEGRADED",
          "ENVIRONMENT_DEGRADED",
          "MULTIPLE_DEGRADATIONS",
        ].map((value) => [value, countRuntime(value)]),
      ),
      causal_failures: Object.fromEntries(
        [
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
        ].map((value) => [value, countFailure(value)]),
      ),
      successful_no_failure_count: countFailure("NONE"),
      unresolved_failure_attribution_count: countFailure("UNKNOWN"),
      unresolved_failure_attribution_rate: selected.length
        ? countFailure("UNKNOWN") / selected.length
        : null,
      clean_comparable_cells: cleanComparable.length,
      clean_comparable_solved_rate: cleanComparable.length
        ? cleanComparable.filter((value) => value.task_outcome === "SOLVED")
            .length / cleanComparable.length
        : null,
      model_blame_permitted_count: selectedOutcomes.filter(
        (value) => value.model_blame_permitted,
      ).length,
      mean_tokens: tokens.length
        ? tokens.reduce((a, b) => a + b, 0) / tokens.length
        : null,
      mean_wall_ms: wall.length
        ? wall.reduce((a, b) => a + b, 0) / wall.length
        : null,
      mean_cost_usd: costs.length
        ? costs.reduce((a, b) => a + b, 0) / costs.length
        : null,
    };
  });
  const familyCells = Object.entries(counts).map(([family, count]) => ({
    family,
    count,
    evidence_cells: reportCells
      .filter(
        (cell) =>
          string(
            record(record(cell["causal_attribution"])?.["attribution"])?.[
              "family"
            ],
          ) === family,
      )
      .map((cell) => cell["cell_id"]),
  }));
  const c02Cells = reportCells.filter((cell) => cell["task_id"] === "C02");
  const frictionSummary = (selected: JsonRecord[]) => {
    const friction = selected
      .map((cell) => record(cell["harness_friction"]))
      .filter((value): value is JsonRecord => value !== null);
    const sum = (key: string): number =>
      friction.reduce(
        (total, value) =>
          total + (typeof value[key] === "number" ? (value[key] as number) : 0),
        0,
      );
    return {
      cells: selected.length,
      failed_tool_count: sum("failed_tool_count"),
      retry_count: sum("retry_count"),
      policy_intervention_count: sum("policy_intervention_count"),
      recovery_attempt_count: sum("recovery_attempt_count"),
      compaction_count: sum("compaction_count"),
      repeated_tool_signature_cells: friction.filter(
        (value) => array(value["repeated_tool_signatures"]).length > 0,
      ).length,
    };
  };
  const c02Audit = {
    schema_version: 1,
    kind: "babel_c02_friction_audit",
    source_campaign_id: manifest.campaign_id,
    immutable_input: true,
    overall: frictionSummary(c02Cells),
    by_model: Object.fromEntries(
      ["glm", "deepseek"].map((label) => [
        label,
        frictionSummary(
          c02Cells.filter(
            (cell) =>
              cell["model"] === manifest.model_ids[label === "glm" ? 0 : 1],
          ),
        ),
      ]),
    ),
    task_outcomes: Object.fromEntries(
      ["SOLVED", "UNSOLVED", "CORRECT_NO_CHANGE", "NOT_REACHED"].map(
        (taskOutcome) => [
          taskOutcome,
          c02Cells
            .filter((cell) => cell["task_outcome"] === taskOutcome)
            .map((cell) => cell["cell_id"]),
        ],
      ),
    ),
    finding:
      "C02 friction is reported independently from task success; repeated reads, failed tools, retries, policy interventions, and recovery attempts do not become model failures without causal evidence.",
  };
  const reports = [
    write(args.outputRoot, "chat-calibration-report.json", {
      schema_version: 1,
      kind: "babel_chat_calibration_report",
      status:
        readiness.status === "ready"
          ? "CALIBRATION_COMPLETE"
          : "CALIBRATION_INCOMPLETE",
      campaign_id: manifest.campaign_id,
      manifest_sha256: sha256File(manifestPath),
      planned_cells: manifest.schedule.length,
      readiness,
      cells: reportCells,
      rescore: {
        source_root: args.root,
        source_manifest: manifestPath,
        immutable_input: true,
        analyzer_version: "causal-analyzer-v2-outcome-orthogonal",
      },
      note: "Offline checkpoint only; the source campaign directory is never modified.",
    }),
    write(args.outputRoot, "model-comparison.json", {
      schema_version: 1,
      kind: "babel_model_comparison",
      status:
        readiness.status === "ready"
          ? "INTERPRETABLE"
          : "BLOCKED_BY_CALIBRATION_READINESS",
      models,
      model_behavior: familyCells.filter((entry) => entry.family === "model"),
      babel_behavior: familyCells.filter((entry) => entry.family === "harness"),
      provider_behavior: familyCells.filter(
        (entry) => entry.family === "provider",
      ),
      environment_behavior: familyCells.filter(
        (entry) => entry.family === "environment",
      ),
      unknown: familyCells.filter((entry) => entry.family === "unknown"),
      causal_failure_counts: Object.fromEntries(
        CAUSAL_FAILURES.map((failure) => [
          failure,
          reportCells.filter((cell) => cell["causal_failure"] === failure)
            .length,
        ]),
      ),
    }),
    write(args.outputRoot, "babel-improvement-ledger.json", {
      schema_version: 1,
      kind: "babel_improvement_ledger",
      status:
        readiness.status === "ready"
          ? "DERIVED_FROM_CALIBRATION"
          : "CALIBRATION_INCOMPLETE",
      recommendations: familyCells
        .filter(
          (entry) => entry.family === "harness" || entry.family === "unknown",
        )
        .sort((a, b) => b.count - a.count)
        .map((entry, index) => ({
          rank: index + 1,
          finding_id:
            entry.family === "unknown"
              ? "OBS-UNKNOWN-001"
              : "HARNESS-CAUSAL-001",
          family: entry.family,
          evidence_cells: entry.evidence_cells,
          recommendation:
            entry.family === "unknown"
              ? "Close the missing causal prerequisite before broad execution."
              : "Reproduce and fix the recurring harness boundary before broad execution.",
        })),
      note: "Recommendations are generated only from observed cell evidence; no absent run is treated as a model result.",
    }),
    write(args.outputRoot, "calibration-readiness.json", readiness),
    write(args.outputRoot, "c02-friction-audit.json", c02Audit),
  ];
  const evidenceManifest = refreshEvidenceManifest(args.outputRoot);
  process.stdout.write(
    `${JSON.stringify({ source_manifest: manifestPath, output_root: args.outputRoot, reports, evidence_manifest: evidenceManifest, readiness }, null, 2)}\n`,
  );
}

main();
