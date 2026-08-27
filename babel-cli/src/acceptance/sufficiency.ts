import type {
  AcceptanceSystemHealthV0,
  ClaimEvidenceLinkV0,
  ClaimResultStatus,
  ExecutableAcceptanceContractV0,
  SufficiencyResultV0,
} from "./types.js";
import {
  validateClaimEvidenceLinkV0,
  validateExecutableAcceptanceContractV0,
} from "./validation.js";

export interface SufficiencyInputV0 {
  contract: ExecutableAcceptanceContractV0;
  links: readonly ClaimEvidenceLinkV0[];
  systemHealth?: Partial<AcceptanceSystemHealthV0>;
}

const HEALTH_KEYS: (keyof AcceptanceSystemHealthV0)[] = [
  "snapshot",
  "compiler",
  "oraclePlanner",
  "evidenceAdmission",
  "sufficiency",
];

function normalizeHealth(
  input: Partial<AcceptanceSystemHealthV0> | undefined,
): AcceptanceSystemHealthV0 {
  return {
    snapshot: input?.snapshot ?? "ok",
    compiler: input?.compiler ?? "ok",
    oraclePlanner: input?.oraclePlanner ?? "ok",
    evidenceAdmission: input?.evidenceAdmission ?? "ok",
    sufficiency: input?.sufficiency ?? "ok",
  };
}

function hasSystemError(health: AcceptanceSystemHealthV0): boolean {
  return HEALTH_KEYS.some((key) => health[key] === "error");
}

/** Pure deterministic aggregation over frozen claims and admitted links. */
export function evaluateSufficiency(
  input: SufficiencyInputV0,
): SufficiencyResultV0;
export function evaluateSufficiency(
  contract: ExecutableAcceptanceContractV0,
  links: readonly ClaimEvidenceLinkV0[],
): SufficiencyResultV0;
export function evaluateSufficiency(
  first: SufficiencyInputV0 | ExecutableAcceptanceContractV0,
  second?: readonly ClaimEvidenceLinkV0[],
): SufficiencyResultV0 {
  const input: SufficiencyInputV0 =
    "links" in first ? first : { contract: first, links: second ?? [] };
  const health = normalizeHealth(input.systemHealth);
  const errors: string[] = [];
  errors.push(...validateExecutableAcceptanceContractV0(input.contract));
  for (const link of input.links)
    errors.push(
      ...validateClaimEvidenceLinkV0(link).map((error) => `link:${error}`),
    );
  for (const key of HEALTH_KEYS) {
    if (health[key] === "error") errors.push(`subsystem_error:${key}`);
  }
  if (errors.length > 0) health.evidenceAdmission = "error";

  const claimResults = input.contract.claims.map((claim) => {
    const relevant = input.links.filter(
      (link) => link.claimId === claim.claimId,
    );
    const admissible = relevant.filter((link) => link.admissible);
    const supporting = admissible.filter(
      (link) => link.relation === "supports",
    );
    const contradictory = admissible.filter(
      (link) => link.relation === "contradicts",
    );
    let status: ClaimResultStatus = "unproven";
    let reason = "no admissible claim-bearing evidence";
    if (claim.epistemicStatus === "ambiguous") {
      status = "ambiguous";
      reason = "acceptance meaning is ambiguous and requires human resolution";
    } else if (claim.epistemicStatus === "unverifiable") {
      status = "unproven";
      reason =
        "the frozen requirement is not observable with an available oracle";
    } else if (contradictory.length > 0) {
      status = "contradicted";
      reason =
        supporting.length > 0
          ? "credible evidence conflicts; conservative policy treats the required claim as contradicted"
          : "admissible evidence contradicts the required claim";
    } else if (supporting.length > 0) {
      status = "supported";
      reason =
        "at least one admissible evidence link supports the frozen claim";
    }
    return {
      claimId: claim.claimId,
      status,
      evidenceIds: admissible.map((link) => link.evidenceId),
      reason,
    };
  });

  const required = claimResults.filter((result) =>
    input.contract.claims.some(
      (claim) => claim.claimId === result.claimId && claim.required,
    ),
  );
  let verdict: SufficiencyResultV0["verdict"] = "INSUFFICIENT_EVIDENCE";
  if (required.some((result) => result.status === "contradicted"))
    verdict = "REJECT";
  else if (required.some((result) => result.status === "ambiguous"))
    verdict = "ESCALATE";
  else if (
    required.length > 0 &&
    required.every((result) => result.status === "supported")
  )
    verdict = "ACCEPT";
  if (hasSystemError(health)) verdict = "INSUFFICIENT_EVIDENCE";

  return {
    schemaVersion: 0,
    contractId: input.contract.contractId,
    contractHash: input.contract.contractHash,
    verdict,
    claimResults,
    systemHealth: health,
    errors,
  };
}

export const determineSufficiency = evaluateSufficiency;
