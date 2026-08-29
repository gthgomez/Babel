import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS,
  LIVE_OPENROUTER_MODEL_ID,
} from "../modelPolicy.js";
import type { CausalRunWhyReport } from "./causalAttribution.js";
import type { CalibrationOutcome } from "./chatCalibrationOutcome.js";

export const CHAT_CALIBRATION_CAMPAIGN_ID = "chat-calibration-v1" as const;
export type ChatCalibrationCampaignId =
  | typeof CHAT_CALIBRATION_CAMPAIGN_ID
  | "chat-calibration-v2"
  | "chat-calibration-v2-repair-validation"
  | "chat-calibration-v3-canonical";
export const CHAT_CALIBRATION_ANALYZER_VERSION = "causal-analyzer-v1" as const;
export const CHAT_CALIBRATION_TASK_IDS = ["C01", "C02", "C04", "C08"] as const;
export const CHAT_CALIBRATION_TRIALS = 3 as const;
export const CHAT_CALIBRATION_CELL_COUNT = 24 as const;
export const CHAT_CALIBRATION_DEFAULT_SEED = 20260828 as const;
export const CHAT_CALIBRATION_MANIFEST_FILENAME =
  "campaign-manifest.json" as const;

export type CampaignClassification =
  | "CANONICAL_CALIBRATION"
  | "DEVELOPMENT_EXPERIMENT";

export interface CampaignProvenance {
  git_sha: string;
  git_tree_sha: string;
  package_lock_sha256: string;
  build_artifact_sha256: string | null;
  runner_source_sha256: string;
  analyzer_source_sha256: string;
  source_composite_sha256: string;
  dirty: boolean;
  classification: CampaignClassification;
  diff_sha256: string | null;
}

export interface ChatCalibrationModel {
  label: "glm" | "deepseek";
  provider: "openrouter";
  exact_model_id: string;
}

export const CHAT_CALIBRATION_MODELS: readonly ChatCalibrationModel[] = [
  {
    label: "glm",
    provider: "openrouter",
    exact_model_id: LIVE_OPENROUTER_MODEL_ID,
  },
  {
    label: "deepseek",
    provider: "openrouter",
    exact_model_id: LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0],
  },
] as const;

export interface ChatCalibrationCell {
  cell_id: string;
  task_id: (typeof CHAT_CALIBRATION_TASK_IDS)[number];
  trial: number;
  model: ChatCalibrationModel;
  arm: "babel_enforce";
  execution_mode: "chat-headless";
}

export interface ChatCalibrationManifest {
  schema_version: 1;
  kind: "babel_chat_calibration_manifest";
  campaign_id: ChatCalibrationCampaignId;
  babel_sha: string;
  model_ids: string[];
  provider_strategy: "openrouter_exact_model_no_fallback";
  inference_settings: Record<string, string | number | boolean | null>;
  task_versions: Record<string, string>;
  trial_count: 3;
  analyzer_version: typeof CHAT_CALIBRATION_ANALYZER_VERSION;
  evidence_schema: "session-event-v1";
  runtime: {
    os: string;
    arch: string;
    node: string;
    isolation_mode: string;
    host_fallback_policy: string;
  };
  verifier_versions: Record<string, string>;
  schedule: ChatCalibrationCell[];
  schedule_seed: number;
  schedule_hash: string;
  created_at: string;
  provenance?: CampaignProvenance;
}

export interface ChatCalibrationCellEvidence {
  cell: ChatCalibrationCell;
  completed: boolean;
  outcome: "success" | "failure" | "blocked" | "unknown";
  causal_attribution: CausalRunWhyReport | null;
  task_feasible: boolean | null;
  capability_authorization_known: boolean;
  tool_terminal_known: boolean;
  result_delivery_known: boolean;
  verification_revision_known: boolean;
  context_preservation_known: boolean;
  upstream_provider: string | null;
  silent_model_substitution: boolean;
  unclassified_runtime_crash: boolean;
  calibration_outcome?: CalibrationOutcome;
}

export interface ChatCalibrationReadiness {
  status: "ready" | "blocked";
  campaign_id: ChatCalibrationCampaignId;
  cell_count: number;
  completed_cells: number;
  unknown_attribution_cells: number;
  unknown_attribution_rate: number | null;
  successful_no_failure_cells: number;
  unresolved_failure_attribution_cells: number;
  unresolved_failure_attribution_rate: number | null;
  context_preservation_known_cells: number;
  route_identity_known_cells: number;
  task_feasibility_known_cells: number;
  capability_authorization_known_cells: number;
  tool_terminal_known_cells: number;
  result_delivery_known_cells: number;
  verification_revision_known_cells: number;
  silent_model_substitution_cells: number;
  unclassified_runtime_crash_cells: number;
  blockers: string[];
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function seededOrder(seed: number): number[] {
  const values = Array.from(
    { length: CHAT_CALIBRATION_CELL_COUNT },
    (_, index) => index,
  );
  let state = seed >>> 0;
  const random = (): number => {
    state = (Math.imul(state ^ (state >>> 16), 2246822519) + 3266489917) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap]!, values[index]!];
  }
  return values;
}

/** Build the fixed 4 tasks × 2 exact models × 3 trials schedule. */
export function buildChatCalibrationSchedule(
  seed: number = CHAT_CALIBRATION_DEFAULT_SEED,
): ChatCalibrationCell[] {
  const cells: ChatCalibrationCell[] = [];
  for (const task_id of CHAT_CALIBRATION_TASK_IDS) {
    for (let trial = 1; trial <= CHAT_CALIBRATION_TRIALS; trial += 1) {
      for (const model of CHAT_CALIBRATION_MODELS) {
        cells.push({
          cell_id: `${task_id}-${model.label}-t${trial}`,
          task_id,
          trial,
          model,
          arm: "babel_enforce",
          execution_mode: "chat-headless",
        });
      }
    }
  }
  const order = seededOrder(seed);
  return order.map((index) => cells[index]!);
}

export function buildChatCalibrationManifest(input: {
  babelSha: string;
  taskVersions: Record<string, string>;
  verifierVersions: Record<string, string>;
  inferenceSettings: Record<string, string | number | boolean | null>;
  isolationMode: string;
  hostFallbackPolicy: string;
  campaignId?: ChatCalibrationCampaignId;
  seed?: number;
  now?: string;
  provenance?: CampaignProvenance;
}): ChatCalibrationManifest {
  const scheduleSeed = input.seed ?? CHAT_CALIBRATION_DEFAULT_SEED;
  const schedule = buildChatCalibrationSchedule(scheduleSeed);
  const scheduleHash = hash(schedule);
  return {
    schema_version: 1,
    kind: "babel_chat_calibration_manifest",
    campaign_id: input.campaignId ?? CHAT_CALIBRATION_CAMPAIGN_ID,
    babel_sha: input.babelSha,
    model_ids: CHAT_CALIBRATION_MODELS.map((model) => model.exact_model_id),
    provider_strategy: "openrouter_exact_model_no_fallback",
    inference_settings: { ...input.inferenceSettings },
    task_versions: { ...input.taskVersions },
    trial_count: CHAT_CALIBRATION_TRIALS,
    analyzer_version: CHAT_CALIBRATION_ANALYZER_VERSION,
    evidence_schema: "session-event-v1",
    runtime: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      isolation_mode: input.isolationMode,
      host_fallback_policy: input.hostFallbackPolicy,
    },
    verifier_versions: { ...input.verifierVersions },
    schedule,
    schedule_seed: scheduleSeed,
    schedule_hash: scheduleHash,
    created_at: input.now ?? new Date().toISOString(),
    ...(input.provenance !== undefined
      ? { provenance: structuredClone(input.provenance) }
      : {}),
  };
}

/** Validate provenance before a live campaign can be treated as canonical. */
export function validateCampaignProvenance(
  provenance: CampaignProvenance,
  expectedSha?: string,
): void {
  const digest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
  if (
    !provenance ||
    !/^[a-f0-9]{40}$/.test(provenance.git_sha) ||
    !/^[a-f0-9]{40}$/.test(provenance.git_tree_sha) ||
    !digest(provenance.package_lock_sha256) ||
    (provenance.build_artifact_sha256 !== null &&
      !digest(provenance.build_artifact_sha256)) ||
    !digest(provenance.runner_source_sha256) ||
    !digest(provenance.analyzer_source_sha256) ||
    !digest(provenance.source_composite_sha256) ||
    typeof provenance.dirty !== "boolean" ||
    !["CANONICAL_CALIBRATION", "DEVELOPMENT_EXPERIMENT"].includes(
      provenance.classification,
    ) ||
    (provenance.diff_sha256 !== null && !digest(provenance.diff_sha256))
  ) {
    throw new Error("invalid campaign provenance");
  }
  if (expectedSha && provenance.git_sha !== expectedSha) {
    throw new Error(
      "campaign provenance git_sha does not match the requested Babel SHA",
    );
  }
  if (
    provenance.classification === "CANONICAL_CALIBRATION" &&
    (provenance.dirty || provenance.diff_sha256 !== null)
  ) {
    throw new Error(
      "canonical calibration provenance must be clean and have no development diff",
    );
  }
  if (
    provenance.classification === "DEVELOPMENT_EXPERIMENT" &&
    provenance.dirty &&
    provenance.diff_sha256 === null
  ) {
    throw new Error("dirty development experiments must record diff_sha256");
  }
}

export function validateChatCalibrationManifest(
  manifest: ChatCalibrationManifest,
): void {
  if (
    manifest.schema_version !== 1 ||
    manifest.kind !== "babel_chat_calibration_manifest" ||
    !(
      [
        "chat-calibration-v1",
        "chat-calibration-v2",
        "chat-calibration-v2-repair-validation",
        "chat-calibration-v3-canonical",
      ] as readonly string[]
    ).includes(manifest.campaign_id) ||
    manifest.provider_strategy !== "openrouter_exact_model_no_fallback" ||
    manifest.trial_count !== CHAT_CALIBRATION_TRIALS ||
    manifest.evidence_schema !== "session-event-v1" ||
    manifest.schedule.length !== CHAT_CALIBRATION_CELL_COUNT ||
    !Number.isInteger(manifest.schedule_seed) ||
    hash(manifest.schedule) !== manifest.schedule_hash
  ) {
    throw new Error("invalid or tampered chat calibration manifest");
  }
  if (manifest.provenance !== undefined)
    validateCampaignProvenance(manifest.provenance, manifest.babel_sha);
  if (
    (manifest.campaign_id === "chat-calibration-v2-repair-validation" ||
      manifest.campaign_id === "chat-calibration-v3-canonical") &&
    manifest.provenance === undefined
  ) {
    throw new Error("canonical calibration manifests require provenance");
  }
  const ids = new Set(manifest.model_ids);
  for (const model of CHAT_CALIBRATION_MODELS) {
    if (!ids.has(model.exact_model_id)) {
      throw new Error(
        `calibration manifest is missing exact model ${model.exact_model_id}`,
      );
    }
  }
  const expectedIds = new Set(
    buildChatCalibrationSchedule(manifest.schedule_seed).map(
      (cell) => cell.cell_id,
    ),
  );
  const actualIds = new Set(manifest.schedule.map((cell) => cell.cell_id));
  if (actualIds.size !== CHAT_CALIBRATION_CELL_COUNT) {
    throw new Error("calibration manifest contains duplicate cell ids");
  }
  for (const cell of manifest.schedule) {
    if (
      !expectedIds.has(cell.cell_id) ||
      cell.execution_mode !== "chat-headless" ||
      cell.arm !== "babel_enforce" ||
      !CHAT_CALIBRATION_MODELS.some(
        (model) =>
          model.label === cell.model.label &&
          model.provider === cell.model.provider &&
          model.exact_model_id === cell.model.exact_model_id,
      )
    ) {
      throw new Error(
        `calibration manifest contains an invalid cell ${cell.cell_id}`,
      );
    }
  }
}

function attributionUnknown(cell: ChatCalibrationCellEvidence): boolean {
  // UNKNOWN attribution is a failure-analysis gap. A completed successful
  // cell with no failure signal is an observed success, not an unexplained
  // failure and must not inflate the checkpoint's unknown-failure rate.
  if (cell.calibration_outcome)
    return cell.calibration_outcome.causal_failure === "UNKNOWN";
  if (cell.outcome === "success") return false;
  return (
    cell.causal_attribution === null ||
    cell.causal_attribution.status !== "ok" ||
    cell.causal_attribution.attribution.family === "unknown"
  );
}

/**
 * Mandatory post-24-cell checkpoint. The returned gate is descriptive; the
 * throwing helper below is the only API that authorizes a broader campaign.
 */
export function evaluateChatCalibrationReadiness(
  cells: readonly ChatCalibrationCellEvidence[],
  campaignId: ChatCalibrationCampaignId = CHAT_CALIBRATION_CAMPAIGN_ID,
): ChatCalibrationReadiness {
  const blockers: string[] = [];
  const completedCells = cells.filter((cell) => cell.completed).length;
  const unknownCells = cells.filter(attributionUnknown).length;
  const successfulNoFailureCells = cells.filter(
    (cell) =>
      cell.calibration_outcome?.causal_failure === "NONE" ||
      (!cell.calibration_outcome &&
        cell.outcome === "success" &&
        cell.causal_attribution?.attribution.code === "no_failure_signal"),
  ).length;
  const unresolvedFailureCells = cells.filter(attributionUnknown).length;
  const cellCount = cells.length;
  const rate = cellCount > 0 ? unknownCells / cellCount : null;
  const unresolvedRate =
    cellCount > 0 ? unresolvedFailureCells / cellCount : null;
  const count = (
    predicate: (cell: ChatCalibrationCellEvidence) => boolean,
  ): number => cells.filter(predicate).length;
  const routeKnown = count(
    (cell) =>
      cell.causal_attribution?.attribution.unknowns.includes(
        "route_correct",
      ) === false && !cell.silent_model_substitution,
  );
  const taskKnown = count((cell) => cell.task_feasible !== null);
  const authorizationKnown = count(
    (cell) => cell.capability_authorization_known,
  );
  const terminalsKnown = count((cell) => cell.tool_terminal_known);
  const deliveryKnown = count((cell) => cell.result_delivery_known);
  const verificationKnown = count((cell) => cell.verification_revision_known);
  const contextKnown = count((cell) => cell.context_preservation_known);
  const substitutions = count((cell) => cell.silent_model_substitution);
  const crashes = count((cell) => cell.unclassified_runtime_crash);

  if (cellCount !== CHAT_CALIBRATION_CELL_COUNT)
    blockers.push(
      `expected ${CHAT_CALIBRATION_CELL_COUNT} cells, received ${cellCount}`,
    );
  if (completedCells !== cellCount)
    blockers.push(`${cellCount - completedCells} cells are incomplete`);
  if (routeKnown !== cellCount)
    blockers.push("route identity is not known for every cell");
  if (taskKnown !== cellCount)
    blockers.push("task feasibility is not known for every cell");
  if (authorizationKnown !== cellCount)
    blockers.push("capability authorization is not known for every cell");
  if (terminalsKnown !== cellCount)
    blockers.push("tool terminal state is not known for every cell");
  if (deliveryKnown !== cellCount)
    blockers.push("tool result delivery is not known for every cell");
  if (verificationKnown !== cellCount)
    blockers.push("verification revision is not known for every cell");
  if (contextKnown < Math.ceil(cellCount * 0.75))
    blockers.push(
      "context preservation is not determinable for the required majority",
    );
  if (substitutions !== 0)
    blockers.push(`${substitutions} silent model substitutions were observed`);
  if (crashes !== 0)
    blockers.push(`${crashes} runtime crashes remain unclassified`);
  if (unresolvedRate === null || unresolvedRate >= 0.1)
    blockers.push(
      `unresolved failure attribution rate is ${unresolvedRate === null ? "unavailable" : unresolvedRate}`,
    );

  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    campaign_id: campaignId,
    cell_count: cellCount,
    completed_cells: completedCells,
    unknown_attribution_cells: unknownCells,
    unknown_attribution_rate: rate,
    successful_no_failure_cells: successfulNoFailureCells,
    unresolved_failure_attribution_cells: unresolvedFailureCells,
    unresolved_failure_attribution_rate: unresolvedRate,
    context_preservation_known_cells: contextKnown,
    route_identity_known_cells: routeKnown,
    task_feasibility_known_cells: taskKnown,
    capability_authorization_known_cells: authorizationKnown,
    tool_terminal_known_cells: terminalsKnown,
    result_delivery_known_cells: deliveryKnown,
    verification_revision_known_cells: verificationKnown,
    silent_model_substitution_cells: substitutions,
    unclassified_runtime_crash_cells: crashes,
    blockers,
  };
}

export function assertBroaderCampaignAllowed(
  readiness: ChatCalibrationReadiness,
): void {
  if (readiness.status !== "ready") {
    throw new Error(
      `Broader Chat campaign is blocked until the 24-cell calibration checkpoint passes: ${readiness.blockers.join("; ")}`,
    );
  }
}

export function writeChatCalibrationManifest(
  evidenceDir: string,
  manifest: ChatCalibrationManifest,
): string {
  validateChatCalibrationManifest(manifest);
  mkdirSync(evidenceDir, { recursive: true });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const canonicalPath = join(evidenceDir, CHAT_CALIBRATION_MANIFEST_FILENAME);
  const versionedPath = join(
    evidenceDir,
    `${manifest.campaign_id}.manifest.json`,
  );
  writeFileSync(canonicalPath, serialized, "utf8");
  // Preserve the campaign-specific name for existing analyzers and operators;
  // both files are byte-identical and are included in the evidence manifest.
  writeFileSync(versionedPath, serialized, "utf8");
  return canonicalPath;
}
