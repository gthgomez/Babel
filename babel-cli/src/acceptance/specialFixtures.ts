import { BdnsDiagnostics } from "../diagnostics/bdns/diagnostics.js";
import { toEvidenceCandidateFromIncident } from "../diagnostics/bdns/evidenceCandidate.js";
import {
  buildTaskContractV1,
  freezeTaskContract,
} from "../agent/taskContract.js";
import { buildAcceptanceInputSnapshot } from "./artifacts.js";
import { sha256Canonical } from "./canonical.js";
import type { CandidateBoundDetectionTrialV0 } from "./campaign.js";
import {
  admitBdnsEvidenceCandidate,
  admitInterpretedEvidence,
} from "./evidenceAdmission.js";
import { compileAcceptance } from "./compiler.js";
import type { DetectionTrialV0 } from "./experiment.js";
import { planOracles } from "./oraclePlanner.js";
import { evaluateSufficiency } from "./sufficiency.js";

export const AMBIGUOUS_FIXTURE_REQUEST =
  "Implement the behavior chosen in a product decision that has not been recorded.";

export const BDNS_FIXTURE_REQUEST =
  "The validation process must exit successfully for this candidate.";

function fixtureCandidateStateHash(path: string, contents: string): string {
  return sha256Canonical([{ path, contents }]);
}

function buildSpecialFixtureTaskContract(request: string) {
  return freezeTaskContract(
    buildTaskContractV1({
      mode: "chat",
      task_class: "general_swe",
      user_request: request,
      acceptance_criteria: [],
      allowed_paths: ["src"],
      verifier_requirements: ["sealed fixture oracle"],
      source: "acceptance.special-fixture",
    }),
  );
}

/**
 * Build the two non-canary rows that complete the preregistered categories.
 * Their outcomes are derived from the frozen H0 pipeline and a seeded BDNS
 * contradiction; they never call a provider or claim experimental evidence.
 */
export function buildAcceptanceV0SpecialFixtureTrials(): CandidateBoundDetectionTrialV0[] {
  const ambiguousContract = compileAcceptance(
    buildAcceptanceInputSnapshot({
      taskContract: buildSpecialFixtureTaskContract(AMBIGUOUS_FIXTURE_REQUEST),
      userRequest: AMBIGUOUS_FIXTURE_REQUEST,
      baselineVerifiers: [{ command: "sealed fixture oracle", exitCode: 1 }],
      createdAt: "2026-08-26T00:00:00.000Z",
    }),
  );
  const ambiguousPlan = planOracles(ambiguousContract, {
    createdAt: "2026-08-26T00:00:00.000Z",
  });
  const ambiguousStep = ambiguousPlan.steps[0];
  if (!ambiguousStep)
    throw new Error("ambiguity fixture must have a human oracle");
  const ambiguousEvidence = admitInterpretedEvidence(
    {
      claimId: ambiguousStep.claimId,
      evidenceId: "fixture-oracle:AA-AMB-01",
      oracleStepId: ambiguousStep.oracleStepId,
      producerRole: "verifier",
      relation: "inconclusive",
      reason: "sealed human resolution is required for the undefined behavior",
      evidenceHealth: "complete",
    },
    { contract: ambiguousContract, oraclePlan: ambiguousPlan },
  );
  const ambiguousResult = evaluateSufficiency(ambiguousContract, [
    ambiguousEvidence,
  ]);
  if (ambiguousResult.verdict !== "ESCALATE")
    throw new Error("ambiguity fixture must produce ESCALATE");

  const diagnostics = new BdnsDiagnostics();
  const incident = diagnostics.reconcileProcessOutcome({
    correlation: { sessionId: "AA-BDNS-01", toolCallId: "validator-1" },
    canonicalOutcome: "succeeded",
    processExitCode: 1,
    processEvidenceState: "complete",
    processObservationSequence: 2,
  });
  if (!incident) throw new Error("BDNS fixture must produce a contradiction");
  const bdnsCandidate = toEvidenceCandidateFromIncident(incident);
  const bdnsContract = compileAcceptance(
    buildAcceptanceInputSnapshot({
      taskContract: buildSpecialFixtureTaskContract(BDNS_FIXTURE_REQUEST),
      userRequest: BDNS_FIXTURE_REQUEST,
      baselineVerifiers: [{ command: "sealed fixture oracle", exitCode: 1 }],
      createdAt: "2026-08-26T00:00:00.000Z",
    }),
  );
  const bdnsClaim = bdnsContract.claims[0];
  if (!bdnsClaim) throw new Error("BDNS fixture must have a claim");
  const bdnsPlan = planOracles(bdnsContract, {
    candidates: [
      {
        claimId: bdnsClaim.claimId,
        oracleKind: "bdns_candidate",
        independence: "observer",
        createdBeforePatch: true,
        sourceRef:
          "src/diagnostics/bdns/diagnostics.ts#reconcileProcessOutcome",
      },
    ],
    createdAt: "2026-08-26T00:00:00.000Z",
  });
  const bdnsStep = bdnsPlan.steps[0];
  if (!bdnsStep) throw new Error("BDNS fixture must have an oracle step");
  const bdnsEvidence = admitBdnsEvidenceCandidate({
    claimId: bdnsClaim.claimId,
    candidate: bdnsCandidate,
    relation: "contradicts",
    reason: "seeded canonical success/process failure contradiction",
    oracleStepId: bdnsStep.oracleStepId,
    options: { contract: bdnsContract, oraclePlan: bdnsPlan },
  });
  const bdnsResult = evaluateSufficiency(bdnsContract, [bdnsEvidence]);
  if (bdnsResult.verdict !== "REJECT")
    throw new Error("BDNS fixture must produce REJECT");

  const makeRows = (
    taskId: string,
    candidateStateHash: string,
    groundTruthAccept: boolean,
    acceptanceOutcome: DetectionTrialV0["detectorOutcome"],
  ): CandidateBoundDetectionTrialV0[] => {
    const common = {
      taskId,
      replicateId: 0,
      groundTruthAccept,
      covered: true,
      candidateStateHash,
      latencyMs: 1,
      wallTimeMs: 1,
      tokens: 0,
    };
    return [
      { ...common, arm: "babel_control", detectorOutcome: "ACCEPT" },
      { ...common, arm: "frontier_posthoc", detectorOutcome: "REJECT" },
      { ...common, arm: "acceptance_v0", detectorOutcome: acceptanceOutcome },
    ];
  };

  return [
    ...makeRows(
      "AA-AMB-01",
      fixtureCandidateStateHash(
        "src/ambiguous-policy.js",
        "export const policy = 'unresolved'\n",
      ),
      false,
      ambiguousResult.verdict,
    ),
    ...makeRows(
      "AA-BDNS-01",
      fixtureCandidateStateHash(
        "src/validator.js",
        "export function validate() { return true }\n",
      ),
      false,
      bdnsResult.verdict,
    ),
  ];
}
