import type {
  AcceptanceInputSnapshotV0,
  ExecutableAcceptanceContractV0,
  OracleKind,
  OracleIndependence,
  OraclePlanV0,
  OracleStepV0,
  OracleSynthesisFamily,
} from "./types.js";
import { buildOraclePlan } from "./artifacts.js";

export interface OracleCandidateV0 {
  claimId: string;
  oracleKind: OracleKind;
  command?: string;
  independence: OracleIndependence;
  createdBeforePatch: boolean;
  sourceRef?: string;
  synthesisFamily?: OracleSynthesisFamily;
  rationale?: string;
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
  snapshot?: AcceptanceInputSnapshotV0;
  synthesizeCounterexamples?: boolean;
}

function synthesisFor(statement: string): {
  family: OracleSynthesisFamily;
  oracleKind: OracleKind;
  rationale: string;
} {
  if (/security|auth|permission|secret|access/i.test(statement))
    return {
      family: "security_policy",
      oracleKind: "security_probe",
      rationale: "probe denied, unauthorized, and boundary inputs",
    };
  if (/concurr|parallel|race|atomic|idempot/i.test(statement))
    return {
      family: "concurrency",
      oracleKind: "concurrency_probe",
      rationale: "probe interleavings and repeated concurrent execution",
    };
  if (/state|transition|lifecycle|status/i.test(statement))
    return {
      family: "state_transition",
      oracleKind: "state_transition",
      rationale: "probe valid and invalid state transitions",
    };
  if (/serializ|round[- ]?trip|json|encode|decode/i.test(statement))
    return {
      family: "serialization_round_trip",
      oracleKind: "serialization_probe",
      rationale: "probe serialization round-trip and malformed payloads",
    };
  if (/compatib|backward|migration|version/i.test(statement))
    return {
      family: "compatibility",
      oracleKind: "compatibility_probe",
      rationale: "probe legacy inputs and version boundaries",
    };
  if (/display|visible|render|ui|screen/i.test(statement))
    return {
      family: "runtime_ui",
      oracleKind: "runtime_probe",
      rationale: "probe observable runtime or UI side effects",
    };
  if (/fail|reject|prevent|never|must not|invalid|empty|missing/i.test(statement))
    return {
      family: "boundary_negative",
      oracleKind: "boundary_probe",
      rationale: "probe plausible invalid, empty, and negative inputs",
    };
  return {
    family: "property",
    oracleKind: "property_probe",
    rationale: "probe the claim as an invariant across representative inputs",
  };
}

/**
 * Generate deterministic counterexample-oriented oracle seeds from the frozen
 * pre-implementation snapshot only. This H1 seam never executes a step.
 */
export function synthesizePatchBlindOracleCandidates(
  snapshot: AcceptanceInputSnapshotV0,
  contract: ExecutableAcceptanceContractV0,
): OracleCandidateV0[] {
  if (snapshot.snapshotHash !== contract.snapshotHash)
    throw new Error("oracle synthesis requires the contract's frozen snapshot");
  return contract.claims
    .filter(
      (claim) => claim.required && claim.epistemicStatus !== "unverifiable",
    )
    .map((claim) => {
      const synthesis = synthesisFor(claim.statement);
      return {
        claimId: claim.claimId,
        oracleKind: synthesis.oracleKind,
        independence: "verifier" as const,
        createdBeforePatch: true,
        sourceRef: "AcceptanceInputSnapshotV0.patch-blind-synthesis",
        synthesisFamily: synthesis.family,
        rationale: synthesis.rationale,
      };
    });
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
    (options.synthesizeCounterexamples
      ? options.snapshot
        ? synthesizePatchBlindOracleCandidates(options.snapshot, contract)
        : (() => {
            throw new Error(
              "counterexample synthesis requires the frozen input snapshot",
            );
          })()
      : defaultCandidates(
          contract,
          options.baselineVerifiers ?? [],
          options.baselineVerifierBindings ?? [],
        ));
  const steps: OracleStepV0[] = supplied.map((candidate, index) => ({
    oracleStepId: `oracle-step-${index + 1}`,
    claimId: candidate.claimId,
    oracleKind: candidate.oracleKind,
    ...(candidate.command ? { command: candidate.command } : {}),
    independence: candidate.independence,
    createdBeforePatch: candidate.createdBeforePatch,
    ...(candidate.sourceRef ? { sourceRef: candidate.sourceRef } : {}),
    ...(candidate.synthesisFamily
      ? { synthesisFamily: candidate.synthesisFamily }
      : {}),
    ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
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
