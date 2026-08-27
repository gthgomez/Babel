import { deepFreeze } from "./freeze.js";
import {
  assessAcceptanceDatasetReadiness,
  validateAcceptanceDatasetManifestV0,
  type AcceptanceDatasetManifestV0,
} from "./dataset.js";
import {
  evaluateDetectionPromotionGate,
  type PreventionScoreV0,
  scorePreventionTrials,
  scoreDetectionTrials,
  validateAcceptanceExperimentManifestV0,
  validateAcceptanceTrialMatrix,
  type AcceptanceExperimentManifestV0,
  type DetectionPromotionGateResultV0,
  type DetectionScoreV0,
  type DetectionTrialV0,
  type PreventionTrialV0,
} from "./experiment.js";

export interface CandidateBoundDetectionTrialV0 extends DetectionTrialV0 {
  /** Hash/identity of the candidate state shared by D0, D1, and D2. */
  candidateStateHash: string;
}

export interface CoordinateDetectionCellInputV0 {
  dataset: AcceptanceDatasetManifestV0;
  manifest: AcceptanceExperimentManifestV0;
  trials: readonly CandidateBoundDetectionTrialV0[];
  source: string;
  experimentalEvidence: boolean;
}

export interface DetectionCellCoordinationResultV0 {
  phase: "detection";
  status: "complete" | "incomplete" | "not_ready";
  datasetId: string;
  datasetHash: string;
  manifestId: string;
  manifestHash: string;
  source: string;
  experimentalEvidence: boolean;
  matrixErrors: string[];
  candidateStateErrors: string[];
  readinessReasons: string[];
  score: DetectionScoreV0 | null;
  promotionGate: DetectionPromotionGateResultV0 | null;
  promotionEligible: boolean;
}

export interface CoordinatePreventionCellInputV0 {
  dataset: AcceptanceDatasetManifestV0;
  manifest: AcceptanceExperimentManifestV0;
  trials: readonly PreventionTrialV0[];
  detectionScore: DetectionScoreV0;
  source: string;
  experimentalEvidence: boolean;
}

export interface PreventionCellCoordinationResultV0 {
  phase: "prevention";
  status: "complete" | "incomplete" | "not_ready";
  datasetId: string;
  datasetHash: string;
  manifestId: string;
  manifestHash: string;
  source: string;
  experimentalEvidence: boolean;
  matrixErrors: string[];
  readinessReasons: string[];
  detectionGate: DetectionPromotionGateResultV0;
  score: PreventionScoreV0 | null;
  eligibleToRun: boolean;
}

function candidateStateErrors(
  trials: readonly CandidateBoundDetectionTrialV0[],
): string[] {
  const errors: string[] = [];
  const states = new Map<string, string>();
  for (const trial of trials) {
    const pair = `${trial.taskId}|${trial.replicateId}`;
    if (
      typeof trial.candidateStateHash !== "string" ||
      !trial.candidateStateHash.trim()
    ) {
      errors.push(`candidate_state_missing:${pair}|${trial.arm}`);
      continue;
    }
    const previous = states.get(pair);
    if (previous && previous !== trial.candidateStateHash) {
      errors.push(`candidate_state_mismatch:${pair}`);
    } else {
      states.set(pair, trial.candidateStateHash);
    }
  }
  return [...new Set(errors)];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  );
}

/**
 * Pure A7a cell coordinator. It consumes already-produced rows and never
 * launches a provider, mutates a workspace, or changes a preregistration.
 */
export function coordinateDetectionCell(
  input: CoordinateDetectionCellInputV0,
): DetectionCellCoordinationResultV0 {
  const datasetErrors = validateAcceptanceDatasetManifestV0(input.dataset);
  const manifestErrors = validateAcceptanceExperimentManifestV0(input.manifest);
  const readiness = assessAcceptanceDatasetReadiness(input.dataset);
  const matrixErrors =
    manifestErrors.length === 0 && input.manifest.phase === "detection"
      ? validateAcceptanceTrialMatrix(input.manifest, input.trials)
      : ["manifest_not_usable"];
  const candidateErrors = candidateStateErrors(input.trials);
  const populationErrors = sameIds(
    input.manifest.taskIds,
    readiness.runnableTaskIds,
  )
    ? []
    : ["manifest_population_differs_from_runnable_dataset"];
  if (input.manifest.taskManifestHash !== input.dataset.sourceManifestHash) {
    populationErrors.push("manifest_source_manifest_hash_mismatch");
  }
  const allErrors = [
    ...datasetErrors.map((error) => `dataset:${error}`),
    ...manifestErrors.map((error) => `manifest:${error}`),
    ...readiness.reasons,
    ...populationErrors,
    ...matrixErrors,
    ...candidateErrors,
  ];
  const complete = allErrors.length === 0;
  const score = complete ? scoreDetectionTrials(input.trials) : null;
  const promotionGate = score
    ? evaluateDetectionPromotionGate(score, input.dataset.promotionGatePolicy)
    : null;
  const promotionEligible =
    complete && input.experimentalEvidence && promotionGate?.eligible === true;
  const status = !readiness.ready
    ? "not_ready"
    : complete
      ? "complete"
      : "incomplete";
  return deepFreeze({
    phase: "detection",
    status,
    datasetId: input.dataset.datasetId,
    datasetHash: input.dataset.datasetHash,
    manifestId: input.manifest.manifestId,
    manifestHash: input.manifest.manifestHash,
    source: input.source,
    experimentalEvidence: input.experimentalEvidence,
    matrixErrors: [...matrixErrors],
    candidateStateErrors: [...candidateErrors],
    readinessReasons: [...new Set(allErrors)],
    score,
    promotionGate,
    promotionEligible,
  });
}

/**
 * Pure A7b coordinator. Prevention rows are not scored unless the frozen A7a
 * gate passed first; this keeps a failed detection experiment from becoming
 * an accidental gating experiment.
 */
export function coordinatePreventionCell(
  input: CoordinatePreventionCellInputV0,
): PreventionCellCoordinationResultV0 {
  const datasetErrors = validateAcceptanceDatasetManifestV0(input.dataset);
  const manifestErrors = validateAcceptanceExperimentManifestV0(input.manifest);
  const readiness = assessAcceptanceDatasetReadiness(input.dataset);
  const detectionGate = evaluateDetectionPromotionGate(
    input.detectionScore,
    input.dataset.promotionGatePolicy,
  );
  const matrixErrors =
    manifestErrors.length === 0 && input.manifest.phase === "prevention"
      ? validateAcceptanceTrialMatrix(input.manifest, input.trials)
      : ["manifest_not_usable"];
  const populationErrors = sameIds(
    input.manifest.taskIds,
    readiness.runnableTaskIds,
  )
    ? []
    : ["manifest_population_differs_from_runnable_dataset"];
  if (input.manifest.taskManifestHash !== input.dataset.sourceManifestHash) {
    populationErrors.push("manifest_source_manifest_hash_mismatch");
  }
  const gateErrors = detectionGate.eligible
    ? []
    : [
        `detection_gate_failed:${detectionGate.reasons.join(",") || "gate_failed"}`,
      ];
  const allErrors = [
    ...datasetErrors.map((error) => `dataset:${error}`),
    ...manifestErrors.map((error) => `manifest:${error}`),
    ...readiness.reasons,
    ...populationErrors,
    ...matrixErrors,
    ...gateErrors,
  ];
  const complete = allErrors.length === 0;
  const score = complete ? scorePreventionTrials(input.trials) : null;
  const eligibleToRun =
    complete && input.experimentalEvidence && detectionGate.eligible;
  const status =
    !readiness.ready || !detectionGate.eligible
      ? "not_ready"
      : complete
        ? "complete"
        : "incomplete";
  return deepFreeze({
    phase: "prevention",
    status,
    datasetId: input.dataset.datasetId,
    datasetHash: input.dataset.datasetHash,
    manifestId: input.manifest.manifestId,
    manifestHash: input.manifest.manifestHash,
    source: input.source,
    experimentalEvidence: input.experimentalEvidence,
    matrixErrors: [...matrixErrors],
    readinessReasons: [...new Set(allErrors)],
    detectionGate,
    score,
    eligibleToRun,
  });
}
