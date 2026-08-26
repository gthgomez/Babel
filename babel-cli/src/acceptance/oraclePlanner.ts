import type {
  ExecutableAcceptanceContractV0,
  OracleKind,
  OracleIndependence,
  OraclePlanV0,
  OracleStepV0,
} from "./types.js";
import { buildOraclePlan } from "./artifacts.js";

export interface OracleCandidateV0 {
  claimId: string;
  oracleKind: OracleKind;
  command?: string;
  independence: OracleIndependence;
  createdBeforePatch: boolean;
  sourceRef?: string;
}

export interface OraclePlannerOptionsV0 {
  candidates?: OracleCandidateV0[];
  baselineVerifiers?: readonly { command: string }[];
  /**
   * Explicit semantic bindings for baseline verifiers. A command alone is not
   * evidence that it bears on every claim in a contract.
   */
  baselineVerifierBindings?: readonly {
    command: string;
    claimIds: readonly string[];
  }[];
  planner?: { name: string; version: string; patchBlind?: boolean };
  createdAt?: string;
}

function defaultCandidates(
  contract: ExecutableAcceptanceContractV0,
  baselineVerifiers: readonly { command: string }[],
  baselineVerifierBindings: readonly {
    command: string;
    claimIds: readonly string[];
  }[],
): OracleCandidateV0[] {
  const candidates: OracleCandidateV0[] = [];
  for (const verifier of baselineVerifiers) {
    const bindings = baselineVerifierBindings
      .filter((binding) => binding.command === verifier.command)
      .flatMap((binding) => binding.claimIds);
    for (const claimId of [...new Set(bindings)]) {
      const claim = contract.claims.find((item) => item.claimId === claimId);
      if (
        !claim ||
        !claim.required ||
        claim.epistemicStatus === "ambiguous" ||
        claim.epistemicStatus === "unverifiable"
      )
        continue;
      candidates.push({
        claimId: claim.claimId,
        oracleKind: "existing_test",
        command: verifier.command,
        independence: "canonical",
        createdBeforePatch: true,
        sourceRef: "AcceptanceInputSnapshotV0.baselineVerifiers",
      });
    }
  }
  // A baseline command without a claim binding is a known verifier, not a
  // claim-bearing oracle.
  return candidates;
}

/** Create a frozen plan without executing a command or reading candidate state. */
export function planOracles(
  contract: ExecutableAcceptanceContractV0,
  options: OraclePlannerOptionsV0 = {},
): OraclePlanV0 {
  const supplied =
    options.candidates ??
    defaultCandidates(
      contract,
      options.baselineVerifiers ?? [],
      options.baselineVerifierBindings ?? [],
    );
  const steps: OracleStepV0[] = supplied.map((candidate, index) => ({
    oracleStepId: `oracle-step-${index + 1}`,
    claimId: candidate.claimId,
    oracleKind: candidate.oracleKind,
    ...(candidate.command ? { command: candidate.command } : {}),
    independence: candidate.independence,
    createdBeforePatch: candidate.createdBeforePatch,
    ...(candidate.sourceRef ? { sourceRef: candidate.sourceRef } : {}),
  }));

  const plannedClaims = new Set(steps.map((step) => step.claimId));
  for (const claim of contract.claims.filter((item) => item.required)) {
    if (plannedClaims.has(claim.claimId)) continue;
    if (
      claim.epistemicStatus === "ambiguous" ||
      claim.epistemicStatus === "unverifiable"
    ) {
      steps.push({
        oracleStepId: `oracle-human-${steps.length + 1}`,
        claimId: claim.claimId,
        oracleKind: "human",
        independence: "verifier",
        createdBeforePatch: true,
        sourceRef: "acceptance.epistemic-status",
      });
    }
  }

  return buildOraclePlan({
    contract,
    steps,
    ...(options.planner ? { planner: options.planner } : {}),
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  });
}

export const buildFrozenOraclePlan = planOracles;
