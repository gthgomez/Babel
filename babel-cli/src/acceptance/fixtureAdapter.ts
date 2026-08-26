import {
  buildTaskContractV1,
  freezeTaskContract,
} from "../agent/taskContract.js";
import type { CanaryTrialResult } from "../eval/canary/types.js";
import { buildAcceptanceInputSnapshot } from "./artifacts.js";
import { compileAcceptance } from "./compiler.js";
import {
  admitInterpretedEvidence,
} from "./evidenceAdmission.js";
import { planOracles } from "./oraclePlanner.js";
import {
  scoreDetectionTrials,
  validateAcceptanceTrialMatrix,
  type DetectionScoreV0,
  type DetectionTrialV0,
} from "./experiment.js";
import { evaluateSufficiency } from "./sufficiency.js";
import type { CandidateBoundDetectionTrialV0 } from "./campaign.js";

export interface OfflineFixtureDetectionInputV0 {
  rows: readonly CanaryTrialResult[];
  additionalTrials?: readonly CandidateBoundDetectionTrialV0[];
  taskRequests: Readonly<Record<string, string>>;
  expectedTaskIds?: readonly string[];
  createdAt?: string;
}

export interface OfflineFixtureDetectionReportV0 {
  experimentalEvidence: false;
  source: "clean_room_canary_fixture_self_test";
  trials: CandidateBoundDetectionTrialV0[];
  score: DetectionScoreV0;
  notes: string[];
}

function currentBabelOutcome(
  row: CanaryTrialResult,
): DetectionTrialV0["detectorOutcome"] {
  if (row.honest_block || !row.claimed_complete) return "ESCALATE";
  if (row.visible_ok === false) return "REJECT";
  return "ACCEPT";
}

function postHocOutcome(
  row: CanaryTrialResult,
): DetectionTrialV0["detectorOutcome"] {
  return row.hidden_ok ? "ACCEPT" : "REJECT";
}

/**
 * Compose existing clean-room canary rows into an offline D0/D1/D2 detector
 * self-test. This adapter does not launch processes and is never live evidence.
 */
export function buildOfflineFixtureDetectionReport(
  input: OfflineFixtureDetectionInputV0,
): OfflineFixtureDetectionReportV0 {
  const trials: CandidateBoundDetectionTrialV0[] = [
    ...(input.additionalTrials ?? []),
  ];
  const createdAt = input.createdAt ?? "2026-08-26T00:00:00.000Z";
  const expectedTaskIds = input.expectedTaskIds
    ? [...new Set(input.expectedTaskIds)]
    : undefined;

  for (const row of input.rows) {
    if (row.invalid_task === true) continue;
    const request = input.taskRequests[row.task_id];
    if (!request)
      throw new Error(`missing preregistered request for ${row.task_id}`);

    const taskContract = freezeTaskContract(
      buildTaskContractV1({
        mode: "chat",
        task_class: "general_swe",
        user_request: request,
        acceptance_criteria: [],
        allowed_paths: ["src"],
        verifier_requirements: ["node hidden.test.mjs"],
        source: "acceptance.fixture-adapter",
      }),
    );
    const snapshot = buildAcceptanceInputSnapshot({
      taskContract,
      userRequest: request,
      baselineVerifiers: [{ command: "node hidden.test.mjs", exitCode: 1 }],
      createdAt,
    });
    const contract = compileAcceptance(snapshot);
    const candidates = contract.claims
      .filter(
        (claim) =>
          claim.epistemicStatus !== "ambiguous" &&
          claim.epistemicStatus !== "unverifiable",
      )
      .map((claim) => ({
        claimId: claim.claimId,
        oracleKind: "hidden_test" as const,
        command: "node hidden.test.mjs",
        independence: "verifier" as const,
        createdBeforePatch: true,
        sourceRef: `sealed-clean-room-oracle:${row.task_id}`,
      }));
    const plan = planOracles(contract, { candidates, createdAt });
    const links = plan.steps.map((step) =>
      admitInterpretedEvidence(
        {
          claimId: step.claimId,
          evidenceId: `fixture-oracle:${row.task_id}:${row.trial_index}:${step.oracleStepId}`,
          oracleStepId: step.oracleStepId,
          producerRole: "verifier",
          relation: row.hidden_ok ? "supports" : "contradicts",
          reason: "sealed clean-room canary oracle result",
          evidenceHealth: "complete",
          patchVisibility: "candidate_visible",
          implementationOrigin: "post_implementation",
        },
        { contract, oraclePlan: plan },
      ),
    );
    const sufficiency = evaluateSufficiency(contract, links);

    const candidateStateHash = row.candidate_state_hash;
    if (typeof candidateStateHash !== "string" || !candidateStateHash.trim()) {
      throw new Error(`missing candidate state hash for ${row.task_id}`);
    }
    const common = {
      taskId: row.task_id,
      replicateId: Math.max(0, row.trial_index - 1),
      groundTruthAccept: row.hidden_ok,
      covered: true,
      candidateStateHash,
      latencyMs: row.wall_ms,
      wallTimeMs: row.wall_ms,
      ...(row.tokens !== null && row.tokens !== undefined
        ? { tokens: row.tokens }
        : {}),
    };
    trials.push(
      {
        ...common,
        arm: "babel_control",
        detectorOutcome: currentBabelOutcome(row),
      },
      {
        ...common,
        arm: "frontier_posthoc",
        detectorOutcome: postHocOutcome(row),
      },
      {
        ...common,
        arm: "acceptance_v0",
        detectorOutcome: sufficiency.verdict,
      },
    );
  }

  if (expectedTaskIds) {
    const observedTaskIds = new Set(trials.map((trial) => trial.taskId));
    const missingTaskIds = expectedTaskIds.filter(
      (taskId) => !observedTaskIds.has(taskId),
    );
    if (missingTaskIds.length > 0) {
      throw new Error(
        `fixture matrix is missing preregistered tasks: ${missingTaskIds.join(", ")}`,
      );
    }
  }

  const score = scoreDetectionTrials(trials);
  return {
    experimentalEvidence: false,
    source: "clean_room_canary_fixture_self_test",
    trials,
    score,
    notes: [
      "Fixture/self-test only; do not interpret as live model or confirmatory evidence.",
      "D1 uses the existing clean-room canary oracle as a deterministic post-hoc review stand-in.",
      "D2 compiles from a snapshot-only request and admits the sealed oracle result against frozen claims.",
      `matrix_errors=${validateAcceptanceTrialMatrixForRows(trials, expectedTaskIds)}`,
    ],
  };
}

function validateAcceptanceTrialMatrixForRows(
  trials: readonly DetectionTrialV0[],
  expectedTaskIds?: readonly string[],
): number {
  const taskIds = expectedTaskIds
    ? [...expectedTaskIds]
    : [...new Set(trials.map((trial) => trial.taskId))];
  const replicates =
    trials.reduce((max, trial) => Math.max(max, trial.replicateId), -1) + 1;
  const manifest = {
    schemaVersion: 0 as const,
    kind: "babel_acceptance_v0_experiment" as const,
    manifestId: "aexp0:fixture:matrix",
    manifestHash: "0".repeat(64),
    phase: "detection" as const,
    modelSnapshot: "fixture",
    repositoryRevision: "fixture",
    taskManifestHash: "fixture",
    taskIds,
    replicates,
    arms: ["babel_control", "frontier_posthoc", "acceptance_v0"],
    pairedKey: "task_id|replicate_id" as const,
    compilerVariant: "H0_deterministic" as const,
    preregisteredAt: "fixture",
    frozen: true as const,
  };
  return validateAcceptanceTrialMatrix(manifest, trials).length;
}
