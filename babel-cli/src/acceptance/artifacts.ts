import {
  validateTaskContractV1,
  type TaskContractV1,
} from "../agent/taskContract.js";
import type {
  AcceptanceClaimV0,
  AcceptanceInputSnapshotV0,
  AcceptancePolicySnapshotV0,
  AcceptanceAuthoritativeInputV0,
  AcceptanceBaselineVerifierV0,
  ExecutableAcceptanceContractV0,
  OraclePlanV0,
  OracleStepV0,
  ClaimEvidenceLinkV0,
} from "./types.js";
import {
  contentHashClaim,
  contentHashContract,
  contentHashEvidenceLink,
  contentHashOraclePlan,
  contentHashSnapshot,
  makeIdentity,
} from "./integrity.js";
import { freezeArtifact } from "./freeze.js";
import {
  assertValid,
  validateAcceptanceClaimV0,
  validateAcceptanceInputSnapshotV0,
  validateClaimEvidenceLinkV0,
  validateExecutableAcceptanceContractV0,
  validateOraclePlanV0,
} from "./validation.js";

export interface BuildAcceptanceInputSnapshotInput {
  taskContract: TaskContractV1;
  userRequest?: string;
  baseline?: AcceptanceInputSnapshotV0["baseline"];
  baselineVerifiers?: AcceptanceBaselineVerifierV0[];
  policies?: AcceptancePolicySnapshotV0;
  authoritativeInputs?: AcceptanceAuthoritativeInputV0[];
  createdAt?: string;
}

/** Build a complete, patch-blind snapshot from a frozen TaskContractV1. */
export function buildAcceptanceInputSnapshot(
  input: BuildAcceptanceInputSnapshotInput,
): AcceptanceInputSnapshotV0 {
  if (!input.taskContract.frozen)
    throw new Error(
      "AcceptanceInputSnapshotV0 requires a frozen TaskContractV1",
    );
  const taskContractErrors = validateTaskContractV1(input.taskContract);
  if (taskContractErrors.length > 0)
    throw new Error(
      `TaskContractV1 validation failed: ${taskContractErrors.join(", ")}`,
    );
  for (const authoritativeInput of input.authoritativeInputs ?? []) {
    if (
      /candidate|patch|working[_ -]?tree|implementor|bdns/i.test(
        `${authoritativeInput.kind} ${authoritativeInput.ref}`,
      )
    ) {
      throw new Error(
        "AcceptanceInputSnapshotV0 authoritative inputs cannot contain candidate or downstream state",
      );
    }
  }
  const draft: AcceptanceInputSnapshotV0 = {
    schemaVersion: 0,
    snapshotId: "as0:pending",
    snapshotHash: "0".repeat(64),
    createdAt: input.createdAt ?? new Date().toISOString(),
    origin: "pre_implementation",
    patchVisibility: "none",
    taskContractId: input.taskContract.contract_id,
    taskContractHash: input.taskContract.contract_hash,
    taskRisk: input.taskContract.risk,
    userRequest: input.userRequest ?? input.taskContract.user_request,
    baseline: { ...(input.baseline ?? {}) },
    baselineVerifiers: [...(input.baselineVerifiers ?? [])],
    policies: input.policies ?? {
      mode: input.taskContract.mode,
      allowedEffects: [...input.taskContract.allowed_effects],
      protectedPaths: [...input.taskContract.protected_paths],
    },
    ...(input.authoritativeInputs
      ? { authoritativeInputs: [...input.authoritativeInputs] }
      : {}),
    taskContractAcceptanceCriteria: [...input.taskContract.acceptance_criteria],
  };
  const snapshotHash = contentHashSnapshot(draft);
  draft.snapshotHash = snapshotHash;
  draft.snapshotId = makeIdentity("as0:", snapshotHash);
  return freezeAcceptanceInputSnapshot(draft);
}

export interface BuildAcceptanceClaimInput extends Omit<
  AcceptanceClaimV0,
  "schemaVersion" | "claimId"
> {
  claimId?: string;
  ordinal?: number;
}

/** Build one claim with a content-derived identity when no id is supplied. */
export function buildAcceptanceClaim(
  input: BuildAcceptanceClaimInput,
): AcceptanceClaimV0 {
  const draft: AcceptanceClaimV0 = {
    schemaVersion: 0,
    claimId: input.claimId ?? "ac0:pending:0",
    statement: input.statement,
    polarity: input.polarity,
    epistemicStatus: input.epistemicStatus,
    provenance: input.provenance.map((item) => ({ ...item })),
    scope: {
      ...(input.scope.paths ? { paths: [...input.scope.paths] } : {}),
      ...(input.scope.behaviors
        ? { behaviors: [...input.scope.behaviors] }
        : {}),
    },
    falsifier: input.falsifier,
    required: input.required,
    ...(input.assurance ? { assurance: input.assurance } : {}),
  };
  if (!input.claimId)
    draft.claimId = makeIdentity(
      "ac0:",
      contentHashClaim(draft),
      String(input.ordinal ?? 0),
    );
  return freezeAcceptanceClaim(draft);
}

export interface BuildExecutableAcceptanceContractInput {
  snapshot: AcceptanceInputSnapshotV0;
  claims: AcceptanceClaimV0[];
  compiler?: { name: string; version: string; patchBlind: true };
  createdAt?: string;
}

/** Build and freeze the semantic contract without exposing candidate state. */
export function buildExecutableAcceptanceContract(
  input: BuildExecutableAcceptanceContractInput,
): ExecutableAcceptanceContractV0 {
  const snapshotErrors = validateAcceptanceInputSnapshotV0(input.snapshot);
  assertValid(input.snapshot, snapshotErrors, "AcceptanceInputSnapshotV0");
  for (const claim of input.claims)
    assertValid(claim, validateAcceptanceClaimV0(claim), "AcceptanceClaimV0");
  const draft: ExecutableAcceptanceContractV0 = {
    schemaVersion: 0,
    contractId: "eac0:pending",
    contractHash: "0".repeat(64),
    snapshotId: input.snapshot.snapshotId,
    snapshotHash: input.snapshot.snapshotHash,
    taskContractId: input.snapshot.taskContractId,
    taskContractHash: input.snapshot.taskContractHash,
    ...(input.snapshot.taskRisk ? { taskRisk: input.snapshot.taskRisk } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
    claims: input.claims.map((claim) => claim),
    compiler: input.compiler ?? {
      name: "babel.acceptance.deterministic",
      version: "0",
      patchBlind: true,
    },
    patchBlindProvenance: {
      inputType: "AcceptanceInputSnapshotV0",
      origin: "pre_implementation",
      patchVisibility: "none",
      forbiddenInputs: [
        "filesystem",
        "working_tree",
        "candidate_patch",
        "implementor_messages",
        "bdns_runtime",
      ],
    },
    frozen: true,
  };
  draft.contractHash = contentHashContract(draft);
  draft.contractId = makeIdentity("eac0:", draft.contractHash);
  return freezeExecutableAcceptanceContract(draft);
}

export interface BuildOraclePlanInput {
  contract: ExecutableAcceptanceContractV0;
  steps: OracleStepV0[];
  planner?: { name: string; version: string; patchBlind?: boolean };
  createdAt?: string;
}

/** Bind pre-planned oracle steps to one frozen acceptance contract. */
export function buildOraclePlan(input: BuildOraclePlanInput): OraclePlanV0 {
  assertValid(
    input.contract,
    validateExecutableAcceptanceContractV0(input.contract),
    "ExecutableAcceptanceContractV0",
  );
  const claimIds = new Set(input.contract.claims.map((claim) => claim.claimId));
  for (const step of input.steps) {
    if (!claimIds.has(step.claimId))
      throw new Error(
        `OraclePlanV0 step ${step.oracleStepId} references unknown claim ${step.claimId}`,
      );
    if (
      step.oracleKind !== "human" &&
      input.contract.claims.find((claim) => claim.claimId === step.claimId)
        ?.epistemicStatus === "ambiguous"
    ) {
      throw new Error(
        `Ambiguous claim ${step.claimId} requires a human oracle, not ${step.oracleKind}`,
      );
    }
  }
  const draft: OraclePlanV0 = {
    schemaVersion: 0,
    planId: "op0:pending",
    planHash: "0".repeat(64),
    snapshotId: input.contract.snapshotId,
    snapshotHash: input.contract.snapshotHash,
    contractId: input.contract.contractId,
    contractHash: input.contract.contractHash,
    createdAt: input.createdAt ?? new Date().toISOString(),
    planner: {
      name: input.planner?.name ?? "babel.acceptance.oracle-planner",
      version: input.planner?.version ?? "0",
      patchBlind:
        input.planner?.patchBlind ??
        input.steps.every((step) => step.createdBeforePatch),
    },
    frozen: true,
    steps: input.steps.map((step) => ({ ...step })),
  };
  draft.planHash = contentHashOraclePlan(draft);
  draft.planId = makeIdentity("op0:", draft.planHash);
  return freezeOraclePlan(draft);
}

export function buildClaimEvidenceLink(
  input: Omit<ClaimEvidenceLinkV0, "schemaVersion" | "linkId"> & {
    linkId?: string;
  },
): ClaimEvidenceLinkV0 {
  const draft: ClaimEvidenceLinkV0 = {
    schemaVersion: 0,
    linkId: input.linkId ?? "cel0:pending",
    claimId: input.claimId,
    evidenceId: input.evidenceId,
    ...(input.oracleStepId ? { oracleStepId: input.oracleStepId } : {}),
    producerRole: input.producerRole,
    ...(input.evidenceInfluence
      ? { evidenceInfluence: input.evidenceInfluence }
      : {}),
    ...(input.patchVisibility
      ? { patchVisibility: input.patchVisibility }
      : {}),
    ...(input.implementationOrigin
      ? { implementationOrigin: input.implementationOrigin }
      : {}),
    ...(input.exactStateBinding
      ? { exactStateBinding: { ...input.exactStateBinding } }
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
    admissible: input.admissible,
    relation: input.relation,
    reason: input.reason,
  };
  if (!input.linkId)
    draft.linkId = makeIdentity("cel0:", contentHashEvidenceLink(draft));
  return freezeClaimEvidenceLink(draft);
}

export function freezeAcceptanceInputSnapshot(
  value: AcceptanceInputSnapshotV0,
): AcceptanceInputSnapshotV0 {
  return freezeArtifact(
    assertValid(
      value,
      validateAcceptanceInputSnapshotV0(value),
      "AcceptanceInputSnapshotV0",
    ),
  );
}

export function freezeAcceptanceClaim(
  value: AcceptanceClaimV0,
): AcceptanceClaimV0 {
  return freezeArtifact(
    assertValid(value, validateAcceptanceClaimV0(value), "AcceptanceClaimV0"),
  );
}

export function freezeExecutableAcceptanceContract(
  value: ExecutableAcceptanceContractV0,
): ExecutableAcceptanceContractV0 {
  return freezeArtifact(
    assertValid(
      value,
      validateExecutableAcceptanceContractV0(value),
      "ExecutableAcceptanceContractV0",
    ),
  );
}

export function freezeOraclePlan(value: OraclePlanV0): OraclePlanV0 {
  return freezeArtifact(
    assertValid(value, validateOraclePlanV0(value), "OraclePlanV0"),
  );
}

export function freezeClaimEvidenceLink(
  value: ClaimEvidenceLinkV0,
): ClaimEvidenceLinkV0 {
  return freezeArtifact(
    assertValid(
      value,
      validateClaimEvidenceLinkV0(value),
      "ClaimEvidenceLinkV0",
    ),
  );
}
