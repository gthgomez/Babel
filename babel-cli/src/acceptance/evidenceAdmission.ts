import type { RevisionBoundReceipt } from "../evidence/revisionBoundReceipt.js";
import type { BdnsEvidenceCandidate } from "../diagnostics/bdns/evidenceCandidate.js";
import { hasForbiddenAcceptanceFields } from "../diagnostics/bdns/evidenceCandidate.js";
import type {
  ClaimEvidenceLinkV0,
  ExecutableAcceptanceContractV0,
  InterpretedEvidenceV0,
  OraclePlanV0,
  EvidenceRelation,
} from "./types.js";
import { buildClaimEvidenceLink } from "./artifacts.js";

export interface EvidenceAdmissionOptionsV0 {
  contract: ExecutableAcceptanceContractV0;
  oraclePlan?: OraclePlanV0;
}

function claimExists(
  contract: ExecutableAcceptanceContractV0,
  claimId: string,
): boolean {
  return contract.claims.some((claim) => claim.claimId === claimId);
}

function matchingStep(
  plan: OraclePlanV0 | undefined,
  claimId: string,
  oracleStepId: string | undefined,
): boolean {
  if (!plan) return true;
  const steps = plan.steps.filter((step) => step.claimId === claimId);
  if (!oracleStepId) return false;
  return steps.some((step) => step.oracleStepId === oracleStepId);
}

function boundedReason(reason: string): string {
  const value = reason.trim();
  return value.length > 2_000 ? `${value.slice(0, 1_997)}...` : value;
}

function healthBlocksEvidence(
  health: InterpretedEvidenceV0["evidenceHealth"],
): boolean {
  return health !== undefined && health !== "complete";
}

function defaultInfluence(
  input: InterpretedEvidenceV0,
): NonNullable<InterpretedEvidenceV0["evidenceInfluence"]> {
  if (input.producerRole === "implementor") return "IMPLEMENTOR_CONTROLLED";
  if (
    input.patchVisibility === "candidate_visible" ||
    input.implementationOrigin === "during_implementation" ||
    input.implementationOrigin === "post_implementation"
  )
    return "IMPLEMENTOR_INFLUENCED";
  return "IMPLEMENTOR_VISIBLE";
}

/**
 * Admit an already interpreted evidence/claim relationship.
 *
 * Semantic interpretation happens before this function. It only enforces
 * provenance, oracle binding, freshness, and evidence-health rules; it never
 * invents a claim or upgrades an observation into acceptance semantics.
 */
export function admitInterpretedEvidence(
  input: InterpretedEvidenceV0,
  options: EvidenceAdmissionOptionsV0,
): ClaimEvidenceLinkV0 {
  const claimKnown = claimExists(options.contract, input.claimId);
  const stepKnown = matchingStep(
    options.oraclePlan,
    input.claimId,
    input.oracleStepId,
  );
  const implementor = input.producerRole === "implementor";
  const evidenceInfluence = input.evidenceInfluence ?? defaultInfluence(input);
  const unhealthy = healthBlocksEvidence(input.evidenceHealth);
  const stale = input.stale === true;
  const invalidRelation = !(
    ["supports", "contradicts", "inconclusive"] as EvidenceRelation[]
  ).includes(input.relation);
  const reasons: string[] = [];
  if (!claimKnown) reasons.push("claim is not present in the frozen contract");
  if (!stepKnown)
    reasons.push("evidence is not bound to a planned oracle step");
  if (implementor) reasons.push("implementor explanations are not proof");
  if (input.patchVisibility === "unknown")
    reasons.push("patch visibility is unknown");
  if (input.implementationOrigin === "unknown")
    reasons.push("implementation origin is unknown");
  if (input.producerRole === "verifier" && input.verifierAuthority === false)
    reasons.push("verifier authority is explicitly absent");
  if (
    input.exactStateBinding &&
    input.exactStateBinding.contractHash !== options.contract.contractHash
  )
    reasons.push("evidence is bound to a different acceptance contract");
  if (
    input.exactStateBinding &&
    options.oraclePlan &&
    input.exactStateBinding.oraclePlanHash !== options.oraclePlan.planHash
  )
    reasons.push("evidence is bound to a different oracle plan");
  if (unhealthy) reasons.push(`evidence health is ${input.evidenceHealth}`);
  if (stale) reasons.push("evidence is stale for the candidate revision");
  if (invalidRelation) reasons.push("evidence relation is invalid");
  const admissible = reasons.length === 0 && input.relation !== "inconclusive";
  const relation = admissible ? input.relation : "inconclusive";
  return buildClaimEvidenceLink({
    claimId: input.claimId,
    evidenceId: input.evidenceId,
    ...(input.oracleStepId ? { oracleStepId: input.oracleStepId } : {}),
    producerRole: input.producerRole,
    evidenceInfluence,
    ...(input.patchVisibility
      ? { patchVisibility: input.patchVisibility }
      : {}),
    ...(input.implementationOrigin
      ? { implementationOrigin: input.implementationOrigin }
      : {}),
    ...(input.exactStateBinding
      ? { exactStateBinding: input.exactStateBinding }
      : {}),
    ...(input.verifierAuthority !== undefined
      ? { verifierAuthority: input.verifierAuthority }
      : {}),
    ...(input.verifierId ? { verifierId: input.verifierId } : {}),
    ...(input.sourceDiversityKey
      ? { sourceDiversityKey: input.sourceDiversityKey }
      : {}),
    ...(input.restrictedOracle !== undefined
      ? { restrictedOracle: input.restrictedOracle }
      : {}),
    ...(input.oracleIsolation
      ? { oracleIsolation: input.oracleIsolation }
      : {}),
    admissible,
    relation,
    reason: boundedReason(
      [input.reason.trim(), ...reasons].filter(Boolean).join("; "),
    ),
  });
}

export interface RevisionReceiptAdmissionInputV0 {
  claimId: string;
  receipt: RevisionBoundReceipt;
  oracleStepId?: string;
  options: EvidenceAdmissionOptionsV0;
}

/** Convert a revision-bound verifier receipt into a claim-bearing link. */
export function admitRevisionBoundReceipt(
  input: RevisionReceiptAdmissionInputV0,
): ClaimEvidenceLinkV0 {
  const step = input.options.oraclePlan?.steps.find(
    (candidate) => candidate.oracleStepId === input.oracleStepId,
  );
  const commandMatches =
    !step?.command || step.command === input.receipt.command;
  const authorityKnown =
    input.receipt.authority === true &&
    typeof input.receipt.authoritySource === "string" &&
    input.receipt.authoritySource.trim().length > 0 &&
    input.receipt.authoritySource !== "unknown";
  const relation: EvidenceRelation =
    input.receipt.exitCode === 0 ? "supports" : "contradicts";
  return admitInterpretedEvidence(
    {
      claimId: input.claimId,
      evidenceId: input.receipt.receiptId,
      producerRole: "verifier",
      relation: commandMatches && authorityKnown ? relation : "inconclusive",
      reason: !commandMatches
        ? "receipt command does not match the frozen oracle step"
        : !authorityKnown
          ? "receipt is not authoritative"
          : input.receipt.exitCode === 0
            ? "authoritative verifier receipt is green and revision-bound"
            : `authoritative verifier exited with ${input.receipt.exitCode}`,
      ...(input.oracleStepId ? { oracleStepId: input.oracleStepId } : {}),
      evidenceHealth: "complete",
      stale: input.receipt.stale,
      evidenceInfluence: authorityKnown
        ? "CONTROLLER_OWNED"
        : "IMPLEMENTOR_INFLUENCED",
      verifierAuthority: authorityKnown,
      verifierId: input.receipt.authoritySource ?? input.receipt.command,
      ...(input.options.oraclePlan
        ? {
            exactStateBinding: {
              candidateStateDigest:
                input.receipt.boundRevision.compositeTreeHash,
              contractHash: input.options.contract.contractHash,
              oraclePlanHash: input.options.oraclePlan.planHash,
              verifierId:
                input.receipt.authoritySource ?? input.receipt.command,
            },
          }
        : {}),
    },
    input.options,
  );
}

function candidateCategory(
  candidate: BdnsEvidenceCandidate,
): string | undefined {
  const payload = candidate.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const category = (payload as Record<string, unknown>)["category"];
  return typeof category === "string" ? category : undefined;
}

export interface BdnsCandidateAdmissionInputV0 {
  claimId: string;
  candidate: BdnsEvidenceCandidate;
  relation: EvidenceRelation;
  reason: string;
  oracleStepId?: string;
  options: EvidenceAdmissionOptionsV0;
}

/** Read a BDNS candidate without importing acceptance semantics into BDNS. */
export function admitBdnsEvidenceCandidate(
  input: BdnsCandidateAdmissionInputV0,
): ClaimEvidenceLinkV0 {
  const category = candidateCategory(input.candidate);
  const observerLoss =
    category === "OBSERVER_DATA_LOSS" || category === "PERSISTENCE_DEGRADED";
  const forbidden = hasForbiddenAcceptanceFields(input.candidate);
  const invalidAuthority =
    input.candidate.semanticAuthority !== "none" &&
    input.candidate.semanticAuthority !== "diagnostic_only";
  const health = input.candidate.evidenceHealth;
  const unhealthy = health !== "complete";
  const reasonParts = [input.reason];
  if (observerLoss)
    reasonParts.push(
      "observer or persistence loss cannot establish satisfaction",
    );
  if (forbidden)
    reasonParts.push("BDNS candidate contains forbidden acceptance fields");
  if (invalidAuthority)
    reasonParts.push("BDNS candidate has non-diagnostic semantic authority");
  return admitInterpretedEvidence(
    {
      claimId: input.claimId,
      evidenceId: input.candidate.evidenceId,
      producerRole: input.candidate.producer.role,
      relation:
        observerLoss || forbidden || invalidAuthority || unhealthy
          ? "inconclusive"
          : input.relation,
      reason: reasonParts.join("; "),
      ...(input.oracleStepId ? { oracleStepId: input.oracleStepId } : {}),
      evidenceHealth: health,
      patchVisibility: input.candidate.patchVisibility,
      implementationOrigin: input.candidate.origin,
      evidenceInfluence: input.candidate.independence.implementationIndependent
        ? "EXTERNAL"
        : input.candidate.patchVisibility === "candidate_visible"
          ? "IMPLEMENTOR_INFLUENCED"
          : "IMPLEMENTOR_VISIBLE",
      sourceDiversityKey: input.candidate.producer.system,
      restrictedOracle: false,
      oracleIsolation: "role_separated",
    },
    input.options,
  );
}

export interface EvidenceAdmissionBatchInputV0 extends EvidenceAdmissionOptionsV0 {
  evidence: InterpretedEvidenceV0[];
}

/** Admit a batch while preserving one link per interpreted evidence relation. */
export function admitEvidenceBatch(
  input: EvidenceAdmissionBatchInputV0,
): ClaimEvidenceLinkV0[] {
  return input.evidence.map((evidence) =>
    admitInterpretedEvidence(evidence, input),
  );
}

export const createClaimEvidenceLink = buildClaimEvidenceLink;
