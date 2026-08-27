import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  admitBdnsEvidenceCandidate,
  admitInterpretedEvidence,
  admitRevisionBoundReceipt,
  buildAcceptanceExperimentManifest,
  buildAcceptanceDatasetManifest,
  buildEligiblePreventionManifest,
  buildAcceptanceV0PreregisteredDataset,
  buildOfflineFixtureDetectionReport,
  coordinatePreventionCell,
  coordinateDetectionCell,
  evaluateDetectionPromotionGate,
  DETECTION_ARMS,
  PREVENTION_ARMS,
  buildAcceptanceInputSnapshot,
  buildAcceptanceClaim,
  buildClaimEvidenceLink,
  buildExecutableAcceptanceContract,
  compileAcceptance,
  compileAcceptanceVariant,
  contentHashClaim,
  contentHashContract,
  contentHashOraclePlan,
  contentHashSnapshot,
  evaluateSufficiency,
  finalizeAcceptanceRecording,
  isAcceptanceRecordingEnabled,
  planOracles,
  readAcceptanceArtifacts,
  recordAcceptanceArtifacts,
  scoreDetectionTrials,
  scorePreventionTrials,
  validateAcceptanceExperimentManifestV0,
  validateAcceptanceTrialMatrix,
  validateAcceptanceDatasetManifestV0,
  assessAcceptanceDatasetReadiness,
  validateAcceptanceInputSnapshotV0,
  validateAcceptanceClaimV0,
  validateClaimEvidenceLinkV0,
  validateExecutableAcceptanceContractV0,
  validateOraclePlanV0,
} from "./index.js";
import { buildAcceptanceV0SpecialFixtureTrials } from "./specialFixtures.js";
import {
  buildTaskContractV1,
  freezeTaskContract,
} from "../agent/taskContract.js";
import type { BdnsEvidenceCandidate } from "../diagnostics/bdns/evidenceCandidate.js";

function fixture() {
  const taskContract = freezeTaskContract(
    buildTaskContractV1({
      mode: "chat",
      user_request:
        "Add a search filter.\n1. The filter must exclude archived records.\n2. The result count must remain visible.",
      acceptance_criteria: [
        "Task acceptance criteria as stated in the user request",
      ],
      source: "acceptance.test",
    }),
  );
  const snapshot = buildAcceptanceInputSnapshot({
    taskContract,
    baselineVerifiers: [{ command: "npm test", exitCode: 0 }],
    baseline: { gitHead: "a".repeat(40), treeDigest: "baseline-tree" },
    createdAt: "2026-08-25T12:00:00.000Z",
  });
  const contract = compileAcceptance(snapshot);
  const plan = planOracles(contract, {
    candidates: contract.claims.map((claim, index) => ({
      claimId: claim.claimId,
      oracleKind: "existing_test" as const,
      command: "npm test",
      independence: "canonical" as const,
      createdBeforePatch: true,
      sourceRef: `fixture.oracle.${index}`,
    })),
    createdAt: "2026-08-25T12:00:01.000Z",
  });
  return { taskContract, snapshot, contract, plan };
}

function linkFor(
  f: ReturnType<typeof fixture>,
  relation: "supports" | "contradicts" | "inconclusive",
  claimIndex = 0,
) {
  const claim = f.contract.claims[claimIndex]!;
  const step = f.plan.steps.find(
    (candidate) => candidate.claimId === claim.claimId,
  )!;
  return buildClaimEvidenceLink({
    claimId: claim.claimId,
    evidenceId: `evidence-${relation}-${claimIndex}`,
    oracleStepId: step.oracleStepId,
    producerRole: "verifier",
    admissible: relation !== "inconclusive",
    relation,
    reason: `fixture evidence ${relation}`,
  });
}

test("hashes acceptance artifacts canonically and freezes their nested state", () => {
  const f = fixture();
  assert.deepEqual(validateAcceptanceInputSnapshotV0(f.snapshot), []);
  assert.deepEqual(validateExecutableAcceptanceContractV0(f.contract), []);
  assert.deepEqual(validateOraclePlanV0(f.plan), []);
  assert.equal(contentHashSnapshot(f.snapshot), f.snapshot.snapshotHash);
  assert.equal(contentHashContract(f.contract), f.contract.contractHash);
  assert.equal(contentHashOraclePlan(f.plan), f.plan.planHash);
  assert.throws(() => {
    (f.contract.claims[0] as { statement: string }).statement = "mutated";
  }, TypeError);
  assert.throws(() => {
    (f.plan.steps[0] as { command?: string }).command =
      "candidate-aware command";
  }, TypeError);
});

test("changes to claim statements and provenance change their content hash", () => {
  const f = fixture();
  const claim = f.contract.claims[0]!;
  assert.notEqual(
    contentHashClaim({ ...claim, statement: `${claim.statement} extra` }),
    contentHashClaim(claim),
  );
  assert.notEqual(
    contentHashClaim({
      ...claim,
      provenance: [
        ...claim.provenance,
        { sourceKind: "policy", sourceRef: "policy-1" },
      ],
    }),
    contentHashClaim(claim),
  );
  assert.notEqual(
    contentHashContract({
      ...f.contract,
      claims: [
        { ...claim, statement: "different" },
        ...f.contract.claims.slice(1),
      ],
    }),
    f.contract.contractHash,
  );
  assert.notEqual(
    contentHashOraclePlan({
      ...f.plan,
      steps: [
        { ...f.plan.steps[0]!, command: "different" },
        ...f.plan.steps.slice(1),
      ],
    }),
    f.plan.planHash,
  );
  assert.ok(
    validateAcceptanceClaimV0({ ...claim, claimId: "ac0:bad:0" }).includes(
      "claimId",
    ),
  );
  assert.ok(
    validateExecutableAcceptanceContractV0({
      ...f.contract,
      contractId: "malformed",
    }).includes("contractId"),
  );
});

test("rejects candidate visibility and forbidden fields on the snapshot", () => {
  const f = fixture();
  const candidateVisible = {
    ...f.snapshot,
    patchVisibility: "candidate_visible" as const,
  };
  assert.notDeepEqual(validateAcceptanceInputSnapshotV0(candidateVisible), []);
  const leaked = { ...f.snapshot, candidatePatch: "secret patch" };
  assert.ok(
    validateAcceptanceInputSnapshotV0(leaked).some((error) =>
      error.includes("candidatePatch"),
    ),
  );
  assert.throws(() =>
    buildAcceptanceInputSnapshot({
      taskContract: f.taskContract,
      authoritativeInputs: [{ kind: "candidate_patch", ref: "patch.diff" }],
    }),
  );
});

test("compiler derives explicit claims from the snapshot and never sees a patch argument", () => {
  const f = fixture();
  assert.ok(
    f.contract.claims.some((claim) => claim.epistemicStatus === "explicit"),
  );
  const second = compileAcceptance(f.snapshot);
  assert.equal(second.contractHash, f.contract.contractHash);
  assert.equal(second.patchBlindProvenance.patchVisibility, "none");
  assert.equal(
    second.patchBlindProvenance.forbiddenInputs.includes("candidate_patch"),
    true,
  );
});

test("compiler marks placeholder-only acceptance as ambiguous", () => {
  const taskContract = freezeTaskContract(
    buildTaskContractV1({
      mode: "chat",
      user_request: "Please improve this module.",
      acceptance_criteria: [
        "Task acceptance criteria as stated in the user request",
      ],
      source: "acceptance.test",
    }),
  );
  const snapshot = buildAcceptanceInputSnapshot({
    taskContract,
    createdAt: "2026-08-25T12:00:00.000Z",
  });
  const contract = compileAcceptance(snapshot);
  assert.equal(contract.claims.length, 1);
  assert.equal(contract.claims[0]!.epistemicStatus, "ambiguous");
});

test("H1 compiler seam receives only the frozen snapshot and remains opt-in", () => {
  const f = fixture();
  let calls = 0;
  const contract = compileAcceptanceVariant({
    snapshot: f.snapshot,
    variant: "H1_patch_blind_llm",
    h1Compiler: {
      name: "test.patch-blind-compiler",
      version: "1",
      compile(snapshot) {
        calls += 1;
        assert.equal(Object.isFrozen(snapshot), true);
        return f.contract.claims;
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(contract.compiler.patchBlind, true);
  assert.throws(
    () =>
      compileAcceptanceVariant({
        snapshot: f.snapshot,
        variant: "H1_patch_blind_llm",
      }),
    /requires an explicit snapshot-only compiler/,
  );
});

test("planner supports multiple oracle steps per claim and uses a human step for ambiguity", () => {
  const f = fixture();
  const claim = f.contract.claims[0]!;
  const plan = planOracles(f.contract, {
    candidates: [
      {
        claimId: claim.claimId,
        oracleKind: "existing_test",
        command: "npm test",
        independence: "canonical",
        createdBeforePatch: true,
      },
      {
        claimId: claim.claimId,
        oracleKind: "independent_verifier",
        command: "npm test",
        independence: "verifier",
        createdBeforePatch: false,
        sourceRef: "post-patch-explicit",
      },
    ],
  });
  assert.equal(
    plan.steps.filter((step) => step.claimId === claim.claimId).length,
    2,
  );
  assert.deepEqual(validateOraclePlanV0(plan), []);

  const ambiguousClaim = buildAcceptanceClaim({
    statement: "The task meaning is unresolved.",
    polarity: "must_hold",
    epistemicStatus: "ambiguous",
    provenance: [{ sourceKind: "user_request", sourceRef: "request" }],
    scope: {},
    falsifier: "A reviewer cannot establish the intended behavior.",
    required: true,
    ordinal: 99,
  });
  const ambiguousContract = buildExecutableAcceptanceContract({
    snapshot: f.snapshot,
    claims: [ambiguousClaim],
  });
  const ambiguousPlan = planOracles(ambiguousContract);
  assert.equal(ambiguousPlan.steps[0]!.oracleKind, "human");
});

test("planner never treats an unbound baseline command as proof of every claim", () => {
  const f = fixture();
  const plan = planOracles(f.contract, {
    baselineVerifiers: [{ command: "npm test" }],
  });
  assert.equal(
    plan.steps.some((step) => step.oracleKind === "existing_test"),
    false,
  );
  assert.deepEqual(validateOraclePlanV0(plan), []);
});

test("preregistered dataset covers every required category and stays frozen", () => {
  const dataset = buildAcceptanceV0PreregisteredDataset("b".repeat(64));
  assert.deepEqual(validateAcceptanceDatasetManifestV0(dataset), []);
  assert.equal(Object.isFrozen(dataset), true);
  assert.equal(
    dataset.tasks.every((task) => task.executionStatus === "runnable"),
    true,
  );
  assert.equal(assessAcceptanceDatasetReadiness(dataset).ready, true);
  assert.throws(() => {
    (dataset.tasks as Array<unknown>).push({});
  }, TypeError);
  const malformed = {
    ...dataset,
    sourceManifestHash: "not-a-digest",
    tasks: [
      { ...dataset.tasks[0]!, category: "unknown" },
      ...dataset.tasks.slice(1),
    ],
  } as unknown;
  const malformedErrors = validateAcceptanceDatasetManifestV0(
    malformed as Parameters<typeof validateAcceptanceDatasetManifestV0>[0],
  );
  assert.ok(malformedErrors.includes("sourceManifestHash"));
  assert.ok(malformedErrors.includes("C08:category"));
});

test("checked-in preregistered dataset matches the builder exactly", () => {
  const sourceManifestHash =
    "057eeef534f7569110d2357e0239eaedde2af966d47a5250f0f5bbfeec41dfb8";
  const checkedIn = JSON.parse(
    readFileSync(
      join(process.cwd(), "..", "benchmarks", "acceptance-v0-dataset.json"),
      "utf8",
    ),
  ) as ReturnType<typeof buildAcceptanceV0PreregisteredDataset>;
  assert.deepEqual(validateAcceptanceDatasetManifestV0(checkedIn), []);
  assert.deepEqual(
    checkedIn,
    buildAcceptanceV0PreregisteredDataset(sourceManifestHash),
  );
});

test("A7a coordinator is fail-closed for readiness, matrix, and candidate pairing", () => {
  const preregistered = buildAcceptanceV0PreregisteredDataset("b".repeat(64));
  const runnableDataset = buildAcceptanceDatasetManifest({
    sourceManifestHash: preregistered.sourceManifestHash,
    tasks: preregistered.tasks.map((task) => ({
      ...task,
      executionStatus: "runnable" as const,
    })),
  });
  const readiness = assessAcceptanceDatasetReadiness(preregistered);
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.designOnlyTaskIds, []);

  const taskIds = runnableDataset.tasks.map((task) => task.taskId);
  const manifest = buildAcceptanceExperimentManifest({
    phase: "detection",
    modelSnapshot: "model-snapshot",
    repositoryRevision: "revision",
    taskManifestHash: runnableDataset.sourceManifestHash,
    taskIds,
    replicates: 1,
    preregisteredAt: "2026-08-25T12:00:00.000Z",
  });
  const trials = runnableDataset.tasks.flatMap((task) =>
    DETECTION_ARMS.map((arm) => ({
      taskId: task.taskId,
      replicateId: 0,
      arm,
      detectorOutcome: "REJECT" as const,
      groundTruthAccept: false,
      covered: true,
      candidateStateHash: `candidate:${task.taskId}:0`,
    })),
  );
  const complete = coordinateDetectionCell({
    dataset: runnableDataset,
    manifest,
    trials,
    source: "sealed-test-cell",
    experimentalEvidence: true,
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.score?.pairedTrials, taskIds.length);
  assert.equal(complete.promotionGate?.eligible, false);
  assert.equal(complete.promotionEligible, false);
  assert.equal(Object.isFrozen(complete), true);

  const mismatched = coordinateDetectionCell({
    dataset: runnableDataset,
    manifest,
    trials: trials.map((trial, index) =>
      index === 0
        ? { ...trial, candidateStateHash: "different-candidate" }
        : trial,
    ),
    source: "sealed-test-cell",
    experimentalEvidence: true,
  });
  assert.equal(mismatched.status, "incomplete");
  assert.equal(mismatched.score, null);
  assert.ok(
    mismatched.candidateStateErrors.includes("candidate_state_mismatch:C08|0"),
  );

  const notReadyDataset = buildAcceptanceDatasetManifest({
    sourceManifestHash: preregistered.sourceManifestHash,
    tasks: preregistered.tasks.map((task) => ({
      ...task,
      executionStatus:
        task.taskId === "AA-AMB-01"
          ? ("design_only" as const)
          : task.executionStatus,
    })),
  });
  const notReady = coordinateDetectionCell({
    dataset: notReadyDataset,
    manifest: buildAcceptanceExperimentManifest({
      phase: "detection",
      modelSnapshot: "model-snapshot",
      repositoryRevision: "revision",
      taskManifestHash: preregistered.sourceManifestHash,
      taskIds: notReadyDataset.tasks
        .filter((task) => task.executionStatus === "runnable")
        .map((task) => task.taskId),
      replicates: 1,
      preregisteredAt: "2026-08-25T12:00:00.000Z",
    }),
    trials: [],
    source: "sealed-test-cell",
    experimentalEvidence: true,
  });
  assert.equal(notReady.status, "not_ready");
  assert.equal(notReady.score, null);
  assert.match(notReady.readinessReasons.join(" "), /design_only_tasks/);
});

test("sealed special fixtures exercise ambiguity and BDNS contradiction paths", () => {
  const trials = buildAcceptanceV0SpecialFixtureTrials();
  assert.equal(trials.length, 6);
  for (const taskId of ["AA-AMB-01", "AA-BDNS-01"]) {
    const rows = trials.filter((trial) => trial.taskId === taskId);
    assert.equal(new Set(rows.map((row) => row.candidateStateHash)).size, 1);
    assert.equal(
      rows.find((row) => row.arm === "babel_control")?.detectorOutcome,
      "ACCEPT",
    );
    assert.equal(
      rows.find((row) => row.arm === "frontier_posthoc")?.detectorOutcome,
      "REJECT",
    );
  }
  assert.equal(
    trials.find(
      (trial) => trial.taskId === "AA-AMB-01" && trial.arm === "acceptance_v0",
    )?.detectorOutcome,
    "ESCALATE",
  );
  assert.equal(
    trials.find(
      (trial) => trial.taskId === "AA-BDNS-01" && trial.arm === "acceptance_v0",
    )?.detectorOutcome,
    "REJECT",
  );
});

test("A7b coordinator refuses prevention rows until A7a promotion is eligible", () => {
  const preregistered = buildAcceptanceV0PreregisteredDataset("b".repeat(64));
  const dataset = buildAcceptanceDatasetManifest({
    sourceManifestHash: preregistered.sourceManifestHash,
    tasks: preregistered.tasks.map((task) => ({
      ...task,
      executionStatus: "runnable" as const,
    })),
  });
  const taskIds = dataset.tasks.map((task) => task.taskId);
  const detection = scoreDetectionTrials(
    taskIds.flatMap((taskId) =>
      DETECTION_ARMS.map((arm) => ({
        taskId,
        replicateId: 0,
        arm,
        detectorOutcome:
          arm === "babel_control" ||
          (arm === "frontier_posthoc" && taskIds.indexOf(taskId) < 3)
            ? ("ACCEPT" as const)
            : ("REJECT" as const),
        groundTruthAccept: false,
        covered: true,
      })),
    ),
  );
  assert.equal(
    evaluateDetectionPromotionGate(detection, dataset.promotionGatePolicy)
      .eligible,
    true,
  );
  const manifest = buildEligiblePreventionManifest(
    {
      phase: "prevention",
      modelSnapshot: "model-snapshot",
      repositoryRevision: "revision",
      taskManifestHash: dataset.sourceManifestHash,
      taskIds,
      replicates: 1,
      preregisteredAt: "2026-08-25T12:00:00.000Z",
    },
    detection,
    dataset.promotionGatePolicy,
  );
  const trials = dataset.tasks.flatMap((task) =>
    PREVENTION_ARMS.map((arm) => ({
      taskId: task.taskId,
      replicateId: 0,
      arm,
      groundTruthAccept: false,
      taskSuccess: false,
      claimedComplete: arm === "babel_control",
      ...(arm === "acceptance_v0_gated"
        ? { sufficiencyVerdict: "ESCALATE" as const }
        : {}),
      repairLoops: 0,
    })),
  );
  const complete = coordinatePreventionCell({
    dataset,
    manifest,
    trials,
    detectionScore: detection,
    source: "sealed-test-prevention-cell",
    experimentalEvidence: true,
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.score?.pairedTrials, taskIds.length);
  assert.equal(complete.eligibleToRun, true);

  const failedDetection = scoreDetectionTrials(
    taskIds.flatMap((taskId) =>
      DETECTION_ARMS.map((arm) => ({
        taskId,
        replicateId: 0,
        arm,
        detectorOutcome: "ACCEPT" as const,
        groundTruthAccept: false,
        covered: true,
      })),
    ),
  );
  const refused = coordinatePreventionCell({
    dataset,
    manifest,
    trials,
    detectionScore: failedDetection,
    source: "sealed-test-prevention-cell",
    experimentalEvidence: true,
  });
  assert.equal(refused.status, "not_ready");
  assert.equal(refused.score, null);
  assert.equal(refused.eligibleToRun, false);
  assert.match(refused.readinessReasons.join(" "), /detection_gate_failed/);
});

test("offline fixture adapter exposes the D0 false-accept trap without claiming live evidence", () => {
  const report = buildOfflineFixtureDetectionReport({
    rows: [
      {
        task_id: "C10",
        trial_index: 1,
        evidence_scope: "MOCK_ORCHESTRATION",
        contract_success: false,
        code_fix_success: false,
        hidden_ok: false,
        visible_ok: true,
        claimed_complete: true,
        false_complete: true,
        honest_block: false,
        production_mutated: true,
        candidate_state_hash: "fixture-c10-candidate",
        tokens: 0,
        cost_usd: 0,
        wall_ms: 1,
        notes: [],
      },
    ],
    taskRequests: {
      C10: "Make greet() return a greeting. Visible tests only check non-empty string.",
    },
  });
  assert.equal(report.experimentalEvidence, false);
  assert.equal(
    report.score.arms.find((arm) => arm.arm === "babel_control")!.falseAccepts
      .count,
    1,
  );
  assert.equal(
    report.score.arms.find((arm) => arm.arm === "frontier_posthoc")!
      .falseAccepts.count,
    0,
  );
  assert.equal(
    report.score.arms.find((arm) => arm.arm === "acceptance_v0")!.falseAccepts
      .count,
    0,
  );
  assert.match(report.notes.join(" "), /matrix_errors=0/);
  const gate = evaluateDetectionPromotionGate(report.score, {
    minimumTrialsPerArm: 2,
    minimumFalseAcceptReduction: 0.1,
    minimumFalseAcceptReductionVsFrontier: 0.1,
    maximumFalseRejectRate: 0.25,
    maximumEscalationRate: 0.5,
    requireCompleteCoverage: true,
  });
  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join(" "), /minimum_trials_not_met/);

  const controlOnlyLift = scoreDetectionTrials([
    {
      taskId: "false-completion",
      replicateId: 0,
      arm: "babel_control",
      detectorOutcome: "ACCEPT",
      groundTruthAccept: false,
      covered: true,
    },
    {
      taskId: "false-completion",
      replicateId: 0,
      arm: "frontier_posthoc",
      detectorOutcome: "REJECT",
      groundTruthAccept: false,
      covered: true,
    },
    {
      taskId: "false-completion",
      replicateId: 0,
      arm: "acceptance_v0",
      detectorOutcome: "REJECT",
      groundTruthAccept: false,
      covered: true,
    },
  ]);
  const frontierGate = evaluateDetectionPromotionGate(controlOnlyLift, {
    minimumTrialsPerArm: 1,
    minimumFalseAcceptReduction: 0.2,
    minimumFalseAcceptReductionVsFrontier: 0.2,
    maximumFalseRejectRate: 0.25,
    maximumEscalationRate: 0.5,
    requireCompleteCoverage: true,
  });
  assert.equal(frontierGate.eligible, false);
  assert.match(
    frontierGate.reasons.join(" "),
    /frontier_false_accept_reduction_below_threshold/,
  );
  assert.throws(
    () =>
      buildOfflineFixtureDetectionReport({
        rows: [
          {
            task_id: "C10",
            trial_index: 1,
            evidence_scope: "MOCK_ORCHESTRATION",
            contract_success: false,
            code_fix_success: false,
            hidden_ok: false,
            visible_ok: true,
            claimed_complete: true,
            false_complete: true,
            honest_block: false,
            production_mutated: true,
            candidate_state_hash: "fixture-c10-candidate",
            tokens: 0,
            cost_usd: 0,
            wall_ms: 1,
            notes: [],
          },
        ],
        expectedTaskIds: ["C10", "missing-task"],
        taskRequests: {
          C10: "Make greet() return a greeting.",
        },
      }),
    /missing preregistered tasks/,
  );
});

test("evidence admission distinguishes stale, unrelated, implementor, and observer-loss evidence", () => {
  const f = fixture();
  const claim = f.contract.claims[0]!;
  const step = f.plan.steps.find(
    (candidate) => candidate.claimId === claim.claimId,
  )!;
  const options = { contract: f.contract, oraclePlan: f.plan };
  const stale = admitRevisionBoundReceipt({
    claimId: claim.claimId,
    oracleStepId: step.oracleStepId,
    receipt: {
      receiptId: "receipt-stale",
      command: "npm test",
      exitCode: 0,
      boundRevision: {
        gitCommitHash: null,
        compositeTreeHash: "x",
        fileHashes: {},
        capturedAt: 1,
      },
      stale: true,
    },
    options,
  });
  assert.equal(stale.admissible, false);
  assert.equal(stale.relation, "inconclusive");

  const unrelated = admitInterpretedEvidence(
    {
      claimId: claim.claimId,
      evidenceId: "unrelated-test",
      oracleStepId: "not-planned",
      producerRole: "verifier",
      relation: "supports",
      reason: "an unrelated green test",
    },
    options,
  );
  assert.equal(unrelated.admissible, false);

  const implementor = admitInterpretedEvidence(
    {
      claimId: claim.claimId,
      evidenceId: "implementor-says-done",
      oracleStepId: step.oracleStepId,
      producerRole: "implementor",
      relation: "supports",
      reason: "agent says done",
    },
    options,
  );
  assert.equal(implementor.admissible, false);

  const candidate: BdnsEvidenceCandidate = {
    schemaVersion: 1,
    evidenceId: "bdns-loss",
    producer: { system: "test", role: "observer" },
    kind: "diagnostic_incident",
    correlation: {},
    origin: "during_implementation",
    patchVisibility: "candidate_visible",
    semanticAuthority: "diagnostic_only",
    independence: {
      implementationIndependent: false,
      observerIndependent: true,
    },
    evidenceHealth: "complete",
    payload: { category: "OBSERVER_DATA_LOSS" },
  };
  const observerLoss = admitBdnsEvidenceCandidate({
    claimId: claim.claimId,
    candidate,
    oracleStepId: step.oracleStepId,
    relation: "supports",
    reason: "observer reported loss",
    options,
  });
  assert.equal(observerLoss.admissible, false);
  assert.equal(observerLoss.relation, "inconclusive");

  for (const category of [
    "PROCESS_OUTCOME_MISMATCH",
    "UNDECLARED_WORKSPACE_MUTATION",
    "MISSING_EXPECTED_MUTATION",
  ]) {
    const contradiction = admitBdnsEvidenceCandidate({
      claimId: claim.claimId,
      candidate: {
        ...candidate,
        evidenceId: `bdns-${category}`,
        payload: { category },
      },
      oracleStepId: step.oracleStepId,
      relation: "contradicts",
      reason: category,
      options,
    });
    assert.equal(contradiction.admissible, true);
    assert.equal(contradiction.relation, "contradicts");
  }

  const truncated = admitInterpretedEvidence(
    {
      claimId: claim.claimId,
      evidenceId: "truncated",
      oracleStepId: step.oracleStepId,
      producerRole: "verifier",
      relation: "supports",
      reason: "partial output",
      evidenceHealth: "truncated",
    },
    options,
  );
  assert.equal(truncated.admissible, false);
  assert.deepEqual(validateClaimEvidenceLinkV0(truncated), []);
});

test("sufficiency returns the four deterministic outcomes and rejects conflicts conservatively", () => {
  const f = fixture();
  const supported = evaluateSufficiency(
    f.contract,
    f.contract.claims.map((_, index) => linkFor(f, "supports", index)),
  );
  assert.equal(supported.verdict, "ACCEPT");

  const rejected = evaluateSufficiency(f.contract, [linkFor(f, "contradicts")]);
  assert.equal(rejected.verdict, "REJECT");

  const insufficient = evaluateSufficiency(f.contract, []);
  assert.equal(insufficient.verdict, "INSUFFICIENT_EVIDENCE");

  const ambiguousClaim = buildAcceptanceClaim({
    statement: "Ambiguous behavior requires a human decision.",
    polarity: "must_hold",
    epistemicStatus: "ambiguous",
    provenance: [{ sourceKind: "user_request", sourceRef: "request" }],
    scope: {},
    falsifier: "A reviewer cannot resolve the behavior.",
    required: true,
    ordinal: 101,
  });
  const ambiguousContract = buildExecutableAcceptanceContract({
    snapshot: f.snapshot,
    claims: [ambiguousClaim],
  });
  assert.equal(evaluateSufficiency(ambiguousContract, []).verdict, "ESCALATE");

  const conflict = evaluateSufficiency(f.contract, [
    linkFor(f, "supports"),
    linkFor(f, "contradicts"),
  ]);
  assert.equal(conflict.verdict, "REJECT");
  assert.equal(conflict.claimResults[0]!.status, "contradicted");
  const subsystemFailure = evaluateSufficiency({
    contract: f.contract,
    links: [],
    systemHealth: { compiler: "error" },
  });
  assert.equal(subsystemFailure.verdict, "INSUFFICIENT_EVIDENCE");
  assert.ok(subsystemFailure.errors.includes("subsystem_error:compiler"));
});

test("recording is opt-in, bounded, redacted, and inspectable", () => {
  assert.equal(isAcceptanceRecordingEnabled({}), false);
  assert.equal(
    isAcceptanceRecordingEnabled({ BABEL_ACCEPTANCE_V0: "1" }),
    true,
  );
  const f = fixture();
  const runDir = mkdtempSync(join(tmpdir(), "babel-acceptance-test-"));
  try {
    const disabled = recordAcceptanceArtifacts(
      runDir,
      {
        snapshot: f.snapshot,
        contract: f.contract,
        oraclePlan: f.plan,
        evidenceLinks: [],
        sufficiency: evaluateSufficiency(f.contract, []),
      },
      {},
    );
    assert.equal(disabled.enabled, false);
    const enabled = recordAcceptanceArtifacts(
      runDir,
      {
        snapshot: f.snapshot,
        contract: f.contract,
        oraclePlan: f.plan,
        evidenceLinks: [],
        sufficiency: {
          ...evaluateSufficiency(f.contract, []),
          providerMetadata: { apiKey: "plain-value" },
        } as ReturnType<typeof evaluateSufficiency>,
      },
      { BABEL_ACCEPTANCE_V0: "true" },
    );
    assert.equal(enabled.enabled, true);
    assert.ok(enabled.files.includes("manifest.json"));
    const raw = readFileSync(
      join(runDir, "acceptance-v0", "acceptance_input_snapshot.json"),
      "utf8",
    );
    const sufficiencyRaw = readFileSync(
      join(runDir, "acceptance-v0", "sufficiency_result.json"),
      "utf8",
    );
    assert.equal(raw.includes("api_key=secret"), false);
    assert.equal(sufficiencyRaw.includes("plain-value"), false);
    assert.ok(sufficiencyRaw.includes("[REDACTED_SECRET]"));
    assert.ok(readAcceptanceArtifacts(runDir));

    const finalized = finalizeAcceptanceRecording({
      bundle: {
        snapshot: f.snapshot,
        contract: f.contract,
        oraclePlan: f.plan,
        evidenceLinks: [],
        sufficiency: evaluateSufficiency(f.contract, []),
      },
      evidenceLinks: f.contract.claims.map((_, index) =>
        linkFor(f, "supports", index),
      ),
    });
    assert.equal(finalized.sufficiency.verdict, "ACCEPT");
    assert.equal(Object.isFrozen(finalized.evidenceLinks), true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("experiment manifest freezes before paired detection and prevention scoring", () => {
  const manifest = buildAcceptanceExperimentManifest({
    phase: "detection",
    modelSnapshot: "model-1",
    repositoryRevision: "repo-1",
    taskManifestHash: "tasks-1",
    taskIds: ["task-a", "task-b"],
    replicates: 2,
    preregisteredAt: "2026-08-25T12:00:00.000Z",
  });
  assert.deepEqual(validateAcceptanceExperimentManifestV0(manifest), []);
  assert.throws(() => {
    (manifest as { arms: string[] }).arms.push("late-arm");
  }, TypeError);

  const detection = scoreDetectionTrials([
    {
      taskId: "task-a",
      replicateId: 0,
      arm: "babel_control",
      detectorOutcome: "ACCEPT",
      groundTruthAccept: false,
      covered: true,
    },
    {
      taskId: "task-a",
      replicateId: 0,
      arm: "frontier_posthoc",
      detectorOutcome: "REJECT",
      groundTruthAccept: false,
      covered: true,
    },
    {
      taskId: "task-a",
      replicateId: 0,
      arm: "acceptance_v0",
      detectorOutcome: "REJECT",
      groundTruthAccept: false,
      covered: true,
    },
  ]);
  assert.equal(detection.pairedTrials, 1);
  assert.equal(detection.pairedDeltas.length, 2);
  assert.equal(detection.pairedDeltas[1]!.falseAcceptDelta, -1);
  assert.equal(
    detection.arms.find((arm) => arm.arm === "babel_control")!.falseAccepts
      .count,
    1,
  );

  const promotionScore = scoreDetectionTrials(
    ["a", "b", "c"].flatMap((taskId, index) => [
      {
        taskId,
        replicateId: 0,
        arm: "babel_control" as const,
        detectorOutcome: "ACCEPT" as const,
        groundTruthAccept: false,
        covered: true,
      },
      {
        taskId,
        replicateId: 0,
        arm: "frontier_posthoc" as const,
        detectorOutcome:
          index === 0 ? ("ACCEPT" as const) : ("REJECT" as const),
        groundTruthAccept: false,
        covered: true,
      },
      {
        taskId,
        replicateId: 0,
        arm: "acceptance_v0" as const,
        detectorOutcome: "REJECT" as const,
        groundTruthAccept: false,
        covered: true,
      },
    ]),
  );
  const preventionManifest = buildEligiblePreventionManifest(
    {
      phase: "prevention",
      modelSnapshot: "model-1",
      repositoryRevision: "repo-1",
      taskManifestHash: "tasks-1",
      taskIds: ["task-a"],
      replicates: 1,
      preregisteredAt: "2026-08-25T12:00:00.000Z",
    },
    promotionScore,
  );
  assert.equal(preventionManifest.phase, "prevention");
  assert.deepEqual(
    validateAcceptanceExperimentManifestV0(preventionManifest),
    [],
  );

  const prevention = scorePreventionTrials([
    {
      taskId: "task-a",
      replicateId: 0,
      arm: "babel_control",
      groundTruthAccept: false,
      taskSuccess: false,
      claimedComplete: true,
    },
    {
      taskId: "task-a",
      replicateId: 0,
      arm: "prove_it_prompt",
      groundTruthAccept: false,
      taskSuccess: false,
      claimedComplete: false,
    },
    {
      taskId: "task-a",
      replicateId: 0,
      arm: "acceptance_v0_gated",
      groundTruthAccept: true,
      taskSuccess: true,
      claimedComplete: true,
      sufficiencyVerdict: "ACCEPT",
    },
  ]);
  assert.equal(
    prevention.arms.find((arm) => arm.arm === "babel_control")!
      .consequentialFalseCompletions.count,
    1,
  );
  assert.equal(
    prevention.arms.find((arm) => arm.arm === "acceptance_v0_gated")!
      .taskSuccesses.count,
    1,
  );
  assert.equal(prevention.pairedDeltas.length, 2);
  const completeMatrix = manifest.taskIds
    .flatMap((taskId) =>
      Array.from({ length: manifest.replicates }, (_, replicateId) =>
        DETECTION_ARMS.map((arm) => ({
          taskId,
          replicateId,
          arm,
          detectorOutcome: "ACCEPT" as const,
          groundTruthAccept: true,
          covered: true,
        })),
      ),
    )
    .flat();
  assert.equal(
    validateAcceptanceTrialMatrix(manifest, completeMatrix).length,
    0,
  );
  assert.match(
    validateAcceptanceTrialMatrix(manifest, completeMatrix.slice(1)).join(" "),
    /missing_trial/,
  );
});
