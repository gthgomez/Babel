import assert from "node:assert/strict";
import test from "node:test";
import {
  admitInterpretedEvidence,
  admitRevisionBoundReceipt,
  buildAcceptanceClaim,
  buildAcceptanceBundleV1,
  buildAcceptanceInputSnapshot,
  buildClaimEvidenceLink,
  buildExecutableAcceptanceContract,
  buildOraclePlan,
  evaluateSufficiency,
  hasIsolatedRestrictedOracle,
  validateAcceptanceBundleV1,
  resolveSufficiencyProfile,
} from "./index.js";
import {
  buildTaskContractV1,
  freezeTaskContract,
} from "../agent/taskContract.js";

function highAssuranceFixture() {
  const taskContract = freezeTaskContract(
    buildTaskContractV1({
      mode: "deep",
      user_request: "Preserve the payment invariant.",
      acceptance_criteria: ["Payment state remains valid."],
      risk: "high",
      source: "acceptance.hardening.test",
    }),
  );
  const snapshot = buildAcceptanceInputSnapshot({ taskContract });
  const claim = buildAcceptanceClaim({
    statement: "Payment state remains valid.",
    polarity: "must_hold",
    epistemicStatus: "explicit",
    provenance: [{ sourceKind: "user_request", sourceRef: "request" }],
    scope: {},
    falsifier: "An invalid payment state is observable.",
    required: true,
    assurance: "high",
  });
  const contract = buildExecutableAcceptanceContract({
    snapshot,
    claims: [claim],
  });
  const plan = buildOraclePlan({
    contract,
    steps: [
      {
        oracleStepId: "oracle-1",
        claimId: claim.claimId,
        oracleKind: "independent_verifier",
        independence: "verifier",
        createdBeforePatch: true,
      },
    ],
  });
  return { contract, plan, claim, taskContract };
}

function exactLink(
  fixture: ReturnType<typeof highAssuranceFixture>,
  input: {
    evidenceId: string;
    influence: "EXTERNAL" | "CONTROLLER_OWNED" | "IMPLEMENTOR_CONTROLLED";
    source: string;
  },
) {
  return buildClaimEvidenceLink({
    claimId: fixture.claim.claimId,
    evidenceId: input.evidenceId,
    oracleStepId: "oracle-1",
    producerRole: "verifier",
    evidenceInfluence: input.influence,
    verifierAuthority: true,
    verifierId: input.source,
    sourceDiversityKey: input.source,
    exactStateBinding: {
      candidateStateDigest: "candidate-tree",
      contractHash: fixture.contract.contractHash,
      oraclePlanHash: fixture.plan.planHash,
      verifierId: input.source,
    },
    admissible: true,
    relation: "supports",
    reason: "controlled hardening fixture evidence",
  });
}

test("risk and assurance resolve to preregistered sufficiency profiles", () => {
  assert.equal(resolveSufficiencyProfile({ taskRisk: "low" }).name, "normal");
  assert.equal(resolveSufficiencyProfile({ taskRisk: "medium" }).name, "elevated");
  assert.equal(resolveSufficiencyProfile({ taskRisk: "high" }).name, "high");
  assert.equal(resolveSufficiencyProfile({ assurance: "high" }).name, "high");
});

test("high assurance requires exact state, independent evidence, and source diversity", () => {
  const fixture = highAssuranceFixture();
  const legacy = buildClaimEvidenceLink({
    claimId: fixture.claim.claimId,
    oracleStepId: "oracle-1",
    evidenceId: "legacy-green",
    producerRole: "verifier",
    admissible: true,
    relation: "supports",
    reason: "green test without binding metadata",
  });
  assert.equal(
    evaluateSufficiency({
      contract: fixture.contract,
      links: [legacy],
      oraclePlanHash: fixture.plan.planHash,
    }).verdict,
    "INSUFFICIENT_EVIDENCE",
  );

  const accepted = evaluateSufficiency({
    contract: fixture.contract,
    links: [
      exactLink(fixture, {
        evidenceId: "controller-proof",
        influence: "CONTROLLER_OWNED",
        source: "trusted-ci",
      }),
      exactLink(fixture, {
        evidenceId: "external-proof",
        influence: "EXTERNAL",
        source: "external-verifier",
      }),
    ],
    oraclePlanHash: fixture.plan.planHash,
  });
  assert.equal(accepted.verdict, "ACCEPT");
  assert.equal(accepted.policyProfile?.name, "high");

  const controlledOnly = evaluateSufficiency({
    contract: fixture.contract,
    links: [
      exactLink(fixture, {
        evidenceId: "controlled-proof",
        influence: "IMPLEMENTOR_CONTROLLED",
        source: "candidate-test",
      }),
      exactLink(fixture, {
        evidenceId: "controlled-proof-2",
        influence: "IMPLEMENTOR_CONTROLLED",
        source: "candidate-test-2",
      }),
    ],
    oraclePlanHash: fixture.plan.planHash,
  });
  assert.equal(controlledOnly.verdict, "INSUFFICIENT_EVIDENCE");
});

test("unknown verifier authority cannot become a claim-bearing receipt", () => {
  const fixture = highAssuranceFixture();
  const link = admitRevisionBoundReceipt({
    claimId: fixture.claim.claimId,
    oracleStepId: "oracle-1",
    receipt: {
      receiptId: "receipt-unknown-authority",
      command: "npm test",
      exitCode: 0,
      boundRevision: {
        gitCommitHash: null,
        compositeTreeHash: "candidate-tree",
        fileHashes: {},
        capturedAt: 1,
      },
      stale: false,
    },
    options: { contract: fixture.contract, oraclePlan: fixture.plan },
  });
  assert.equal(link.admissible, false);
  assert.equal(link.relation, "inconclusive");
});

test("candidate-visible evidence is marked influenced and cannot be sole elevated proof", () => {
  const fixture = highAssuranceFixture();
  const link = admitInterpretedEvidence(
    {
      claimId: fixture.claim.claimId,
      evidenceId: "candidate-created-test",
      oracleStepId: "oracle-1",
      producerRole: "verifier",
      relation: "supports",
      reason: "candidate-created test passed",
      patchVisibility: "candidate_visible",
      implementationOrigin: "post_implementation",
      evidenceInfluence: "IMPLEMENTOR_INFLUENCED",
      verifierAuthority: true,
      verifierId: "candidate-test-runner",
      exactStateBinding: {
        candidateStateDigest: "candidate-tree",
        contractHash: fixture.contract.contractHash,
        oraclePlanHash: fixture.plan.planHash,
        verifierId: "candidate-test-runner",
      },
    },
    { contract: fixture.contract, oraclePlan: fixture.plan },
  );
  assert.equal(link.admissible, true);
  assert.equal(link.evidenceInfluence, "IMPLEMENTOR_INFLUENCED");
  assert.equal(
    evaluateSufficiency({
      contract: fixture.contract,
      links: [link],
      oraclePlanHash: fixture.plan.planHash,
    }).verdict,
    "INSUFFICIENT_EVIDENCE",
  );
});

test("escrow distinguishes role separation from an isolated restricted oracle", () => {
  const fixture = highAssuranceFixture();
  const roleSeparated = buildAcceptanceBundleV1({
    taskContract: fixture.taskContract,
    builder_visible: [],
    restricted: [...fixture.taskContract.acceptance],
  });
  assert.equal(hasIsolatedRestrictedOracle(roleSeparated), false);

  assert.throws(
    () =>
      buildAcceptanceBundleV1({
        taskContract: fixture.taskContract,
        builder_visible: [],
        restricted: [...fixture.taskContract.acceptance],
        restricted_boundary: {
          mode: "isolated",
          storage: "implementor_accessible",
          implementorCanRead: true,
          implementorCanWrite: false,
          execution: "shared_process",
        },
      }),
    /external storage, no implementor access, and a trusted runner/,
  );

  const isolated = buildAcceptanceBundleV1({
    taskContract: fixture.taskContract,
    builder_visible: [],
    restricted: [...fixture.taskContract.acceptance],
    restricted_boundary: {
      mode: "isolated",
      storage: "outside_implementor_worktree",
      implementorCanRead: false,
      implementorCanWrite: false,
      execution: "trusted_runner",
    },
  });
  assert.equal(hasIsolatedRestrictedOracle(isolated), true);
  assert.deepEqual(validateAcceptanceBundleV1(isolated), []);
});
