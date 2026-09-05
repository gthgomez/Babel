import type {
  AcceptanceAssurance,
  AcceptanceSystemHealthV0,
  ClaimEvidenceLinkV0,
  ClaimResultStatus,
  ExecutableAcceptanceContractV0,
  AcceptanceTaskRisk,
  EvidenceInfluence,
  SufficiencyProfileName,
  SufficiencyProfileV1,
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
  taskRisk?: AcceptanceTaskRisk;
  oraclePlanHash?: string;
}

/** Frozen, preregistrable policy profiles; experiment results may revise V2. */
export const SUFFICIENCY_PROFILES_V1: Readonly<
  Record<SufficiencyProfileName, SufficiencyProfileV1>
> = Object.freeze({
  normal: Object.freeze({
    version: "sufficiency-v1",
    name: "normal",
    minimumSupportingEvidence: 1,
    minimumIndependentEvidence: 0,
    minimumDistinctSources: 1,
    requireExactStateBinding: false,
    requireExplicitVerifierAuthority: false,
    rejectImplementorControlledSoleSupport: false,
  }),
  elevated: Object.freeze({
    version: "sufficiency-v1",
    name: "elevated",
    minimumSupportingEvidence: 1,
    minimumIndependentEvidence: 1,
    minimumDistinctSources: 1,
    requireExactStateBinding: true,
    requireExplicitVerifierAuthority: true,
    rejectImplementorControlledSoleSupport: true,
  }),
  high: Object.freeze({
    version: "sufficiency-v1",
    name: "high",
    minimumSupportingEvidence: 2,
    minimumIndependentEvidence: 1,
    minimumDistinctSources: 2,
    requireExactStateBinding: true,
    requireExplicitVerifierAuthority: true,
    rejectImplementorControlledSoleSupport: true,
  }),
});

function maxProfile(
  left: SufficiencyProfileName,
  right: SufficiencyProfileName,
): SufficiencyProfileName {
  const rank: Record<SufficiencyProfileName, number> = {
    normal: 0,
    elevated: 1,
    high: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

/** Resolve the preregistered assurance profile without inspecting evidence. */
export function resolveSufficiencyProfile(input: {
  taskRisk?: AcceptanceTaskRisk;
  assurance?: AcceptanceAssurance;
}): SufficiencyProfileV1 {
  let name: SufficiencyProfileName = input.assurance ?? "normal";
  if (input.taskRisk === "medium") name = maxProfile(name, "elevated");
  if (input.taskRisk === "high" || input.taskRisk === "critical")
    name = maxProfile(name, "high");
  return SUFFICIENCY_PROFILES_V1[name];
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

function hasExactStateBinding(
  link: ClaimEvidenceLinkV0,
  contract: ExecutableAcceptanceContractV0,
  oraclePlanHash: string | undefined,
  required: boolean,
): boolean {
  const binding = link.exactStateBinding;
  return Boolean(
    binding &&
      binding.candidateStateDigest.trim() &&
      binding.contractHash === contract.contractHash &&
      (!required || Boolean(oraclePlanHash)) &&
      (!oraclePlanHash || binding.oraclePlanHash === oraclePlanHash) &&
      binding.verifierId.trim(),
  );
}

function isIndependentInfluence(
  influence: EvidenceInfluence | undefined,
): boolean {
  return influence === "EXTERNAL" || influence === "CONTROLLER_OWNED";
}

function sourceKey(link: ClaimEvidenceLinkV0): string {
  return link.sourceDiversityKey ?? link.producerRole;
}

function strongestProfile(
  profiles: readonly SufficiencyProfileV1[],
): SufficiencyProfileV1 {
  return profiles.reduce(
    (strongest, profile) =>
      maxProfile(strongest.name, profile.name) === profile.name
        ? profile
        : strongest,
    SUFFICIENCY_PROFILES_V1.normal,
  );
}

function qualifiesForProfile(input: {
  links: ClaimEvidenceLinkV0[];
  profile: SufficiencyProfileV1;
  contract: ExecutableAcceptanceContractV0;
  oraclePlanHash?: string;
}): { qualified: ClaimEvidenceLinkV0[]; reason?: string } {
  const eligible = input.links.filter((link) => {
    if (
      input.profile.requireExactStateBinding &&
      !hasExactStateBinding(
        link,
        input.contract,
        input.oraclePlanHash,
        input.profile.requireExactStateBinding,
      )
    )
      return false;
    if (
      input.profile.requireExplicitVerifierAuthority &&
      link.producerRole === "verifier" &&
      link.verifierAuthority !== true
    )
      return false;
    if (
      link.restrictedOracle === true &&
      link.oracleIsolation !== "isolated"
    )
      return false;
    return true;
  });
  const independent = eligible.filter((link) =>
    isIndependentInfluence(link.evidenceInfluence),
  );
  const distinctSources = new Set(eligible.map(sourceKey));
  const failures: string[] = [];
  if (
    input.profile.rejectImplementorControlledSoleSupport &&
    eligible.length > 0 &&
    eligible.every(
      (link) => link.evidenceInfluence === "IMPLEMENTOR_CONTROLLED",
    )
  )
    failures.push("implementor-controlled evidence cannot be sole proof");
  if (eligible.length < input.profile.minimumSupportingEvidence)
    failures.push("minimum supporting evidence not met");
  if (independent.length < input.profile.minimumIndependentEvidence)
    failures.push("independent/controller-owned evidence is missing");
  if (distinctSources.size < input.profile.minimumDistinctSources)
    failures.push("evidence-source diversity is insufficient");
  return {
    qualified: failures.length === 0 ? eligible : [],
    ...(failures.length > 0 ? { reason: failures.join("; ") } : {}),
  };
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

  const resolvedTaskRisk = input.taskRisk ?? input.contract.taskRisk;
  const contractProfile = strongestProfile(
    input.contract.claims
      .filter((claim) => claim.required)
      .map((claim) =>
        resolveSufficiencyProfile({
          ...(resolvedTaskRisk ? { taskRisk: resolvedTaskRisk } : {}),
          ...(claim.assurance ? { assurance: claim.assurance } : {}),
        }),
      ),
  );
  const claimResults = input.contract.claims.map((claim) => {
    const profile = resolveSufficiencyProfile({
      ...(resolvedTaskRisk
        ? { taskRisk: resolvedTaskRisk }
        : {}),
      ...(claim.assurance ? { assurance: claim.assurance } : {}),
    });
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
      const qualified = qualifiesForProfile({
        links: supporting,
        profile,
        contract: input.contract,
        ...(input.oraclePlanHash
          ? { oraclePlanHash: input.oraclePlanHash }
          : {}),
      });
      if (qualified.qualified.length === 0) {
        reason = `evidence does not satisfy ${profile.name} sufficiency profile: ${qualified.reason}`;
      } else {
        status = "supported";
        reason =
          `${qualified.qualified.length} admissible evidence link(s) satisfy the ${profile.name} sufficiency profile`;
      }
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
    policyProfile: contractProfile,
  };
}

export const determineSufficiency = evaluateSufficiency;
