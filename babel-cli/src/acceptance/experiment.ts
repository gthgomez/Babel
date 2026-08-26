import { randomUUID } from "node:crypto";
import { makeIdentity } from "./integrity.js";
import { omitKeys, sha256Canonical } from "./canonical.js";
import { deepFreeze } from "./freeze.js";

export const ACCEPTANCE_EXPERIMENT_SCHEMA_VERSION = 0 as const;
export const DETECTION_ARMS = [
  "babel_control",
  "frontier_posthoc",
  "acceptance_v0",
] as const;
export const PREVENTION_ARMS = [
  "babel_control",
  "prove_it_prompt",
  "acceptance_v0_gated",
] as const;

export type DetectionArm = (typeof DETECTION_ARMS)[number];
export type PreventionArm = (typeof PREVENTION_ARMS)[number];
export type AcceptanceExperimentPhase = "detection" | "prevention";
export type DetectionOutcome =
  | "ACCEPT"
  | "REJECT"
  | "ESCALATE"
  | "INSUFFICIENT_EVIDENCE";

export interface AcceptanceExperimentManifestV0 {
  schemaVersion: typeof ACCEPTANCE_EXPERIMENT_SCHEMA_VERSION;
  kind: "babel_acceptance_v0_experiment";
  manifestId: string;
  manifestHash: string;
  phase: AcceptanceExperimentPhase;
  modelSnapshot: string;
  repositoryRevision: string;
  taskManifestHash: string;
  taskIds: string[];
  replicates: number;
  arms: string[];
  pairedKey: "task_id|replicate_id";
  compilerVariant: "H0_deterministic" | "H1_patch_blind_llm" | "not_applicable";
  preregisteredAt: string;
  frozen: true;
}

export interface BuildExperimentManifestInputV0 {
  phase: AcceptanceExperimentPhase;
  modelSnapshot: string;
  repositoryRevision: string;
  taskManifestHash: string;
  taskIds: string[];
  replicates: number;
  compilerVariant?: AcceptanceExperimentManifestV0["compilerVariant"];
  preregisteredAt?: string;
  arms?: string[];
}

function phaseArms(phase: AcceptanceExperimentPhase): string[] {
  return [...(phase === "detection" ? DETECTION_ARMS : PREVENTION_ARMS)];
}

/** Build a frozen preregistration record; it does not run any arm. */
export function buildAcceptanceExperimentManifest(
  input: BuildExperimentManifestInputV0,
): AcceptanceExperimentManifestV0 {
  if (
    !input.modelSnapshot.trim() ||
    !input.repositoryRevision.trim() ||
    !input.taskManifestHash.trim()
  )
    throw new Error("experiment identity fields are required");
  if (!Number.isInteger(input.replicates) || input.replicates < 1)
    throw new Error("replicates must be a positive integer");
  if (
    input.taskIds.length === 0 ||
    new Set(input.taskIds).size !== input.taskIds.length
  )
    throw new Error("taskIds must be non-empty and unique");
  const arms = input.arms ? [...input.arms] : phaseArms(input.phase);
  if (arms.length === 0 || new Set(arms).size !== arms.length)
    throw new Error("arms must be non-empty and unique");
  const draft: AcceptanceExperimentManifestV0 = {
    schemaVersion: 0,
    kind: "babel_acceptance_v0_experiment",
    manifestId: "aexp0:pending",
    manifestHash: "0".repeat(64),
    phase: input.phase,
    modelSnapshot: input.modelSnapshot,
    repositoryRevision: input.repositoryRevision,
    taskManifestHash: input.taskManifestHash,
    taskIds: [...input.taskIds],
    replicates: input.replicates,
    arms,
    pairedKey: "task_id|replicate_id",
    compilerVariant:
      input.compilerVariant ??
      (input.phase === "detection" ? "H0_deterministic" : "not_applicable"),
    preregisteredAt: input.preregisteredAt ?? new Date().toISOString(),
    frozen: true,
  };
  draft.manifestHash = sha256Canonical(
    omitKeys(draft as unknown as Record<string, unknown>, [
      "manifestId",
      "manifestHash",
      "frozen",
    ]),
  );
  draft.manifestId = makeIdentity(
    "aexp0:",
    draft.manifestHash,
    randomUUID().slice(0, 8),
  );
  return deepFreeze(draft);
}

export function validateAcceptanceExperimentManifestV0(
  value: AcceptanceExperimentManifestV0,
): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== 0) errors.push("schemaVersion");
  if (value.kind !== "babel_acceptance_v0_experiment") errors.push("kind");
  if (value.frozen !== true) errors.push("frozen");
  if (!value.modelSnapshot.trim()) errors.push("modelSnapshot");
  if (!value.repositoryRevision.trim()) errors.push("repositoryRevision");
  if (!value.taskManifestHash.trim()) errors.push("taskManifestHash");
  if (
    !Number.isInteger(value.replicates) ||
    value.replicates < 1 ||
    value.taskIds.length === 0 ||
    new Set(value.taskIds).size !== value.taskIds.length
  )
    errors.push("taskMatrix");
  const expectedArms =
    value.phase === "detection" ? DETECTION_ARMS : PREVENTION_ARMS;
  if (
    value.arms.length !== expectedArms.length ||
    new Set(value.arms).size !== value.arms.length ||
    value.arms.some(
      (arm) => !expectedArms.some((candidate) => candidate === arm),
    )
  )
    errors.push("arms");
  if (
    value.phase === "prevention" &&
    value.compilerVariant !== "not_applicable"
  )
    errors.push("compilerVariant");
  const expected = sha256Canonical(
    omitKeys(value as unknown as Record<string, unknown>, [
      "manifestId",
      "manifestHash",
      "frozen",
    ]),
  );
  if (value.manifestHash !== expected) errors.push("manifestHash");
  if (!value.manifestId.startsWith(`aexp0:${value.manifestHash.slice(0, 16)}:`))
    errors.push("manifestId");
  return errors;
}

export interface DetectionTrialV0 {
  taskId: string;
  replicateId: number;
  arm: DetectionArm;
  detectorOutcome: DetectionOutcome;
  groundTruthAccept: boolean;
  covered: boolean;
  tokens?: number;
  latencyMs?: number;
  wallTimeMs?: number;
}

export interface PreventionTrialV0 {
  taskId: string;
  replicateId: number;
  arm: PreventionArm;
  groundTruthAccept: boolean;
  taskSuccess: boolean;
  claimedComplete: boolean;
  sufficiencyVerdict?: DetectionOutcome;
  tokens?: number;
  latencyMs?: number;
  wallTimeMs?: number;
  repairLoops?: number;
}

export interface RateCountV0 {
  count: number;
  total: number;
  rate: number | null;
}

export interface DetectionArmScoreV0 {
  arm: DetectionArm;
  trials: number;
  covered: number;
  falseAccepts: RateCountV0;
  trueAccepts: RateCountV0;
  falseRejects: RateCountV0;
  insufficientEvidence: RateCountV0;
  escalations: RateCountV0;
  tokens: number;
  latencyMs: number;
  wallTimeMs: number;
}

export interface DetectionScoreV0 {
  phase: "detection";
  arms: DetectionArmScoreV0[];
  pairedTrials: number;
  pairedDeltas: DetectionPairedDeltaV0[];
}

export interface PreventionArmScoreV0 {
  arm: PreventionArm;
  trials: number;
  consequentialFalseCompletions: RateCountV0;
  taskSuccesses: RateCountV0;
  falseRejects: RateCountV0;
  escalations: RateCountV0;
  tokens: number;
  latencyMs: number;
  wallTimeMs: number;
  repairLoops: number;
}

export interface PreventionScoreV0 {
  phase: "prevention";
  arms: PreventionArmScoreV0[];
  pairedTrials: number;
  pairedDeltas: PreventionPairedDeltaV0[];
}

export interface DetectionPromotionGatePolicyV0 {
  minimumTrialsPerArm: number;
  minimumFalseAcceptReduction: number;
  minimumFalseAcceptReductionVsFrontier: number;
  maximumFalseRejectRate: number;
  maximumEscalationRate: number;
  requireCompleteCoverage: boolean;
}

/** Preregistered A7a→A7b gate; change only before a confirmatory cell. */
export const A7B_DETECTION_GATE_POLICY_V0: DetectionPromotionGatePolicyV0 =
  Object.freeze({
    minimumTrialsPerArm: 3,
    minimumFalseAcceptReduction: 0.2,
    minimumFalseAcceptReductionVsFrontier: 0.2,
    maximumFalseRejectRate: 0.1,
    maximumEscalationRate: 0.25,
    requireCompleteCoverage: true,
  });

export interface DetectionPromotionGateResultV0 {
  eligible: boolean;
  reasons: string[];
  baselineFalseAcceptRate: number | null;
  frontierFalseAcceptRate: number | null;
  acceptanceFalseAcceptRate: number | null;
  falseAcceptReduction: number | null;
  falseAcceptReductionVsFrontier: number | null;
}

/**
 * Fixed policy gate for A7b. It is deliberately supplied by preregistration;
 * the scorer never chooses a threshold after seeing outcomes.
 */
export function evaluateDetectionPromotionGate(
  score: DetectionScoreV0,
  policy: DetectionPromotionGatePolicyV0,
): DetectionPromotionGateResultV0 {
  const baseline = score.arms.find((arm) => arm.arm === "babel_control");
  const frontier = score.arms.find((arm) => arm.arm === "frontier_posthoc");
  const acceptance = score.arms.find((arm) => arm.arm === "acceptance_v0");
  const reasons: string[] = [];
  if (!baseline || !frontier || !acceptance)
    reasons.push("required_detection_arms_missing");
  if (
    !Number.isInteger(policy.minimumTrialsPerArm) ||
    policy.minimumTrialsPerArm < 1
  )
    reasons.push("invalid_minimum_trials");
  if (
    policy.minimumFalseAcceptReduction < 0 ||
    policy.minimumFalseAcceptReduction > 1
  )
    reasons.push("invalid_false_accept_threshold");
  if (
    policy.minimumFalseAcceptReductionVsFrontier < 0 ||
    policy.minimumFalseAcceptReductionVsFrontier > 1
  )
    reasons.push("invalid_frontier_false_accept_threshold");
  if (policy.maximumFalseRejectRate < 0 || policy.maximumFalseRejectRate > 1)
    reasons.push("invalid_false_reject_threshold");
  if (policy.maximumEscalationRate < 0 || policy.maximumEscalationRate > 1)
    reasons.push("invalid_escalation_threshold");
  const baselineFalseAcceptRate = baseline?.falseAccepts.rate ?? null;
  const frontierFalseAcceptRate = frontier?.falseAccepts.rate ?? null;
  const acceptanceFalseAcceptRate = acceptance?.falseAccepts.rate ?? null;
  const falseAcceptReduction =
    baselineFalseAcceptRate !== null && acceptanceFalseAcceptRate !== null
      ? baselineFalseAcceptRate - acceptanceFalseAcceptRate
      : null;
  const falseAcceptReductionVsFrontier =
    frontierFalseAcceptRate !== null && acceptanceFalseAcceptRate !== null
      ? frontierFalseAcceptRate - acceptanceFalseAcceptRate
      : null;
  if (baseline && frontier && acceptance) {
    if (
      baseline.trials < policy.minimumTrialsPerArm ||
      frontier.trials < policy.minimumTrialsPerArm ||
      acceptance.trials < policy.minimumTrialsPerArm
    )
      reasons.push("minimum_trials_not_met");
    if (falseAcceptReduction === null)
      reasons.push("false_accept_rate_missing");
    else if (falseAcceptReduction < policy.minimumFalseAcceptReduction)
      reasons.push("false_accept_reduction_below_threshold");
    if (falseAcceptReductionVsFrontier === null)
      reasons.push("frontier_false_accept_rate_missing");
    else if (
      falseAcceptReductionVsFrontier <
      policy.minimumFalseAcceptReductionVsFrontier
    )
      reasons.push("frontier_false_accept_reduction_below_threshold");
    if (
      acceptance.falseRejects.rate !== null &&
      acceptance.falseRejects.rate > policy.maximumFalseRejectRate
    )
      reasons.push("false_reject_rate_above_threshold");
    if (
      acceptance.escalations.rate !== null &&
      acceptance.escalations.rate > policy.maximumEscalationRate
    )
      reasons.push("escalation_rate_above_threshold");
    if (
      policy.requireCompleteCoverage &&
      (baseline.covered !== baseline.trials ||
        frontier.covered !== frontier.trials ||
        acceptance.covered !== acceptance.trials)
    )
      reasons.push("coverage_incomplete");
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    baselineFalseAcceptRate,
    frontierFalseAcceptRate,
    acceptanceFalseAcceptRate,
    falseAcceptReduction,
    falseAcceptReductionVsFrontier,
  };
}

/** Build a prevention preregistration only after the frozen A7a gate passes. */
export function buildEligiblePreventionManifest(
  input: BuildExperimentManifestInputV0,
  detectionScore: DetectionScoreV0,
  policy: DetectionPromotionGatePolicyV0 = A7B_DETECTION_GATE_POLICY_V0,
): AcceptanceExperimentManifestV0 {
  const gate = evaluateDetectionPromotionGate(detectionScore, policy);
  if (!gate.eligible) {
    throw new Error(
      `A7b prevention is not eligible: ${gate.reasons.join(", ") || "gate_failed"}`,
    );
  }
  if (input.phase !== "prevention")
    throw new Error("eligible prevention manifest requires phase=prevention");
  return buildAcceptanceExperimentManifest(input);
}

export interface DetectionPairedDeltaV0 {
  taskId: string;
  replicateId: number;
  baselineArm: "babel_control";
  comparisonArm: Exclude<DetectionArm, "babel_control">;
  baselineCovered: boolean;
  comparisonCovered: boolean;
  falseAcceptDelta: number;
  trueAcceptDelta: number;
  falseRejectDelta: number;
  insufficientEvidenceDelta: number;
  escalationDelta: number;
}

export interface PreventionPairedDeltaV0 {
  taskId: string;
  replicateId: number;
  baselineArm: "babel_control";
  comparisonArm: Exclude<PreventionArm, "babel_control">;
  consequentialFalseCompletionDelta: number;
  taskSuccessDelta: number;
  falseRejectDelta: number;
  escalationDelta: number;
  repairLoopsDelta: number;
}

function rate(count: number, total: number): RateCountV0 {
  return { count, total, rate: total > 0 ? count / total : null };
}

function sum(values: Array<number | undefined>): number {
  let total = 0;
  for (const value of values) total += value ?? 0;
  return total;
}

function ensureUniquePairs<
  T extends { taskId: string; replicateId: number; arm: string },
>(trials: readonly T[]): number {
  const pairs = new Set<string>();
  for (const trial of trials) {
    if (!Number.isInteger(trial.replicateId) || trial.replicateId < 0)
      throw new Error("replicateId must be a non-negative integer");
    const key = `${trial.taskId}|${trial.replicateId}|${trial.arm}`;
    if (pairs.has(key)) throw new Error(`duplicate paired trial: ${key}`);
    pairs.add(key);
  }
  return new Set(trials.map((trial) => `${trial.taskId}|${trial.replicateId}`))
    .size;
}

function binary(value: boolean): number {
  return value ? 1 : 0;
}

function detectionPairedDeltas(
  trials: readonly DetectionTrialV0[],
): DetectionPairedDeltaV0[] {
  const byPair = new Map<string, DetectionTrialV0[]>();
  for (const trial of trials) {
    const key = `${trial.taskId}|${trial.replicateId}`;
    const rows = byPair.get(key) ?? [];
    rows.push(trial);
    byPair.set(key, rows);
  }
  const deltas: DetectionPairedDeltaV0[] = [];
  for (const rows of byPair.values()) {
    const baseline = rows.find((row) => row.arm === "babel_control");
    if (!baseline) continue;
    for (const comparison of ["frontier_posthoc", "acceptance_v0"] as const) {
      const candidate = rows.find((row) => row.arm === comparison);
      if (!candidate) continue;
      const falseAccept = (row: DetectionTrialV0): number =>
        binary(!row.groundTruthAccept && row.detectorOutcome === "ACCEPT");
      const trueAccept = (row: DetectionTrialV0): number =>
        binary(row.groundTruthAccept && row.detectorOutcome === "ACCEPT");
      const falseReject = (row: DetectionTrialV0): number =>
        binary(row.groundTruthAccept && row.detectorOutcome === "REJECT");
      const insufficient = (row: DetectionTrialV0): number =>
        binary(row.detectorOutcome === "INSUFFICIENT_EVIDENCE");
      const escalation = (row: DetectionTrialV0): number =>
        binary(row.detectorOutcome === "ESCALATE");
      deltas.push({
        taskId: baseline.taskId,
        replicateId: baseline.replicateId,
        baselineArm: "babel_control",
        comparisonArm: comparison,
        baselineCovered: baseline.covered,
        comparisonCovered: candidate.covered,
        falseAcceptDelta: falseAccept(candidate) - falseAccept(baseline),
        trueAcceptDelta: trueAccept(candidate) - trueAccept(baseline),
        falseRejectDelta: falseReject(candidate) - falseReject(baseline),
        insufficientEvidenceDelta:
          insufficient(candidate) - insufficient(baseline),
        escalationDelta: escalation(candidate) - escalation(baseline),
      });
    }
  }
  return deltas;
}

function preventionPairedDeltas(
  trials: readonly PreventionTrialV0[],
): PreventionPairedDeltaV0[] {
  const byPair = new Map<string, PreventionTrialV0[]>();
  for (const trial of trials) {
    const key = `${trial.taskId}|${trial.replicateId}`;
    const rows = byPair.get(key) ?? [];
    rows.push(trial);
    byPair.set(key, rows);
  }
  const deltas: PreventionPairedDeltaV0[] = [];
  for (const rows of byPair.values()) {
    const baseline = rows.find((row) => row.arm === "babel_control");
    if (!baseline) continue;
    for (const comparison of [
      "prove_it_prompt",
      "acceptance_v0_gated",
    ] as const) {
      const candidate = rows.find((row) => row.arm === comparison);
      if (!candidate) continue;
      const falseCompletion = (row: PreventionTrialV0): number =>
        binary(row.claimedComplete && !row.groundTruthAccept);
      const taskSuccess = (row: PreventionTrialV0): number =>
        binary(row.taskSuccess && row.groundTruthAccept);
      const falseReject = (row: PreventionTrialV0): number =>
        binary(row.groundTruthAccept && !row.taskSuccess);
      const escalation = (row: PreventionTrialV0): number =>
        binary(row.sufficiencyVerdict === "ESCALATE");
      deltas.push({
        taskId: baseline.taskId,
        replicateId: baseline.replicateId,
        baselineArm: "babel_control",
        comparisonArm: comparison,
        consequentialFalseCompletionDelta:
          falseCompletion(candidate) - falseCompletion(baseline),
        taskSuccessDelta: taskSuccess(candidate) - taskSuccess(baseline),
        falseRejectDelta: falseReject(candidate) - falseReject(baseline),
        escalationDelta: escalation(candidate) - escalation(baseline),
        repairLoopsDelta:
          (candidate.repairLoops ?? 0) - (baseline.repairLoops ?? 0),
      });
    }
  }
  return deltas;
}

/** Score evaluator discrimination with raw counts and no post-hoc arm changes. */
export function scoreDetectionTrials(
  trials: readonly DetectionTrialV0[],
): DetectionScoreV0 {
  const pairedTrials = ensureUniquePairs(trials);
  const arms: DetectionArmScoreV0[] = DETECTION_ARMS.map((arm) => {
    const rows = trials.filter((trial) => trial.arm === arm);
    const resolved = rows.filter((trial) => trial.covered);
    return {
      arm,
      trials: rows.length,
      covered: resolved.length,
      falseAccepts: rate(
        resolved.filter(
          (trial) =>
            !trial.groundTruthAccept && trial.detectorOutcome === "ACCEPT",
        ).length,
        resolved.length,
      ),
      trueAccepts: rate(
        resolved.filter(
          (trial) =>
            trial.groundTruthAccept && trial.detectorOutcome === "ACCEPT",
        ).length,
        resolved.length,
      ),
      falseRejects: rate(
        resolved.filter(
          (trial) =>
            trial.groundTruthAccept && trial.detectorOutcome === "REJECT",
        ).length,
        resolved.length,
      ),
      insufficientEvidence: rate(
        rows.filter(
          (trial) => trial.detectorOutcome === "INSUFFICIENT_EVIDENCE",
        ).length,
        rows.length,
      ),
      escalations: rate(
        rows.filter((trial) => trial.detectorOutcome === "ESCALATE").length,
        rows.length,
      ),
      tokens: sum(rows.map((trial) => trial.tokens)),
      latencyMs: sum(rows.map((trial) => trial.latencyMs)),
      wallTimeMs: sum(rows.map((trial) => trial.wallTimeMs)),
    };
  });
  return {
    phase: "detection",
    arms,
    pairedTrials,
    pairedDeltas: detectionPairedDeltas(trials),
  };
}

/** Score implementor prevention arms separately from detection arms. */
export function scorePreventionTrials(
  trials: readonly PreventionTrialV0[],
): PreventionScoreV0 {
  const pairedTrials = ensureUniquePairs(trials);
  const arms: PreventionArmScoreV0[] = PREVENTION_ARMS.map((arm) => {
    const rows = trials.filter((trial) => trial.arm === arm);
    return {
      arm,
      trials: rows.length,
      consequentialFalseCompletions: rate(
        rows.filter(
          (trial) => trial.claimedComplete && !trial.groundTruthAccept,
        ).length,
        rows.length,
      ),
      taskSuccesses: rate(
        rows.filter((trial) => trial.taskSuccess && trial.groundTruthAccept)
          .length,
        rows.length,
      ),
      falseRejects: rate(
        rows.filter((trial) => trial.groundTruthAccept && !trial.taskSuccess)
          .length,
        rows.length,
      ),
      escalations: rate(
        rows.filter((trial) => trial.sufficiencyVerdict === "ESCALATE").length,
        rows.length,
      ),
      tokens: sum(rows.map((trial) => trial.tokens)),
      latencyMs: sum(rows.map((trial) => trial.latencyMs)),
      wallTimeMs: sum(rows.map((trial) => trial.wallTimeMs)),
      repairLoops: sum(rows.map((trial) => trial.repairLoops)),
    };
  });
  return {
    phase: "prevention",
    arms,
    pairedTrials,
    pairedDeltas: preventionPairedDeltas(trials),
  };
}

/**
 * Ensure a preregistered cell is a complete factorial before scoring it. A
 * partial matrix must be reported as incomplete rather than silently treating
 * missing arms as zero failures.
 */
export function validateAcceptanceTrialMatrix(
  manifest: AcceptanceExperimentManifestV0,
  trials: readonly (DetectionTrialV0 | PreventionTrialV0)[],
): string[] {
  const errors: string[] = [];
  const expected = new Set<string>();
  for (const taskId of manifest.taskIds) {
    for (
      let replicateId = 0;
      replicateId < manifest.replicates;
      replicateId += 1
    ) {
      for (const arm of manifest.arms) {
        expected.add(`${taskId}|${replicateId}|${arm}`);
      }
    }
  }
  const observed = new Set<string>();
  for (const trial of trials) {
    const key = `${trial.taskId}|${trial.replicateId}|${trial.arm}`;
    if (!expected.has(key)) errors.push(`unexpected_trial:${key}`);
    if (observed.has(key)) errors.push(`duplicate_trial:${key}`);
    observed.add(key);
  }
  for (const key of expected) {
    if (!observed.has(key)) errors.push(`missing_trial:${key}`);
  }
  return errors;
}
