import { z } from "zod";
import type {
  AcceptanceClaimV0,
  AcceptanceInputSnapshotV0,
  ClaimEvidenceLinkV0,
  ExecutableAcceptanceContractV0,
  OraclePlanV0,
  SufficiencyResultV0,
} from "./types.js";
import {
  contentHashClaim,
  contentHashContract,
  contentHashEvidenceLink,
  contentHashOraclePlan,
  contentHashSnapshot,
  hasIdentityPrefix,
  isSha256,
} from "./integrity.js";

const WorkspaceRevisionSchema = z
  .object({
    gitCommitHash: z.string().nullable(),
    compositeTreeHash: z.string().min(1),
    fileHashes: z.record(z.string(), z.string()),
    capturedAt: z.number().finite(),
  })
  .strict();

const SnapshotSchema = z
  .object({
    schemaVersion: z.literal(0),
    snapshotId: z.string().min(1),
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().datetime(),
    origin: z.literal("pre_implementation"),
    patchVisibility: z.literal("none"),
    taskContractId: z.string().min(1),
    taskContractHash: z.string().regex(/^[0-9a-f]{32,64}$/),
    userRequest: z.string().min(1),
    baseline: z
      .object({
        gitHead: z.string().optional(),
        workspaceRevision: WorkspaceRevisionSchema.optional(),
        treeDigest: z.string().optional(),
      })
      .strict(),
    baselineVerifiers: z.array(
      z
        .object({
          command: z.string().min(1),
          exitCode: z.number().int(),
          digest: z.string().optional(),
        })
        .strict(),
    ),
    policies: z
      .object({
        mode: z.string().min(1),
        allowedEffects: z.array(z.string()),
        protectedPaths: z.array(z.string()),
      })
      .strict(),
    authoritativeInputs: z
      .array(
        z
          .object({
            kind: z.string().min(1),
            ref: z.string().min(1),
            digest: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    taskContractAcceptanceCriteria: z.array(z.string()).optional(),
  })
  .strict();

const ClaimSchema = z
  .object({
    schemaVersion: z.literal(0),
    claimId: z.string().min(1),
    statement: z.string().min(1),
    polarity: z.enum(["must_hold", "must_not_hold"]),
    epistemicStatus: z.enum([
      "explicit",
      "inferred",
      "ambiguous",
      "unverifiable",
    ]),
    provenance: z
      .array(
        z
          .object({
            sourceKind: z.enum([
              "user_request",
              "task_contract",
              "policy",
              "baseline_behavior",
              "other_authoritative_input",
            ]),
            sourceRef: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    scope: z
      .object({
        paths: z.array(z.string()).optional(),
        behaviors: z.array(z.string()).optional(),
      })
      .strict(),
    falsifier: z.string().min(1),
    required: z.boolean(),
    assurance: z.enum(["normal", "elevated", "high"]).optional(),
  })
  .strict();

const PatchBlindProvenanceSchema = z
  .object({
    inputType: z.literal("AcceptanceInputSnapshotV0"),
    origin: z.literal("pre_implementation"),
    patchVisibility: z.literal("none"),
    forbiddenInputs: z.tuple([
      z.literal("filesystem"),
      z.literal("working_tree"),
      z.literal("candidate_patch"),
      z.literal("implementor_messages"),
      z.literal("bdns_runtime"),
    ]),
  })
  .strict();

const ContractSchema = z
  .object({
    schemaVersion: z.literal(0),
    contractId: z.string().min(1),
    contractHash: z.string().regex(/^[0-9a-f]{64}$/),
    snapshotId: z.string().min(1),
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    taskContractId: z.string().min(1),
    taskContractHash: z.string().regex(/^[0-9a-f]{32,64}$/),
    createdAt: z.string().datetime(),
    claims: z.array(ClaimSchema).min(1),
    compiler: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        patchBlind: z.literal(true),
      })
      .strict(),
    patchBlindProvenance: PatchBlindProvenanceSchema,
    frozen: z.literal(true),
  })
  .strict();

const OracleStepSchema = z
  .object({
    oracleStepId: z.string().min(1),
    claimId: z.string().min(1),
    oracleKind: z.enum([
      "existing_test",
      "hidden_test",
      "property_probe",
      "static_probe",
      "runtime_probe",
      "bdns_candidate",
      "independent_verifier",
      "human",
    ]),
    command: z.string().min(1).optional(),
    independence: z.enum(["implementor", "canonical", "observer", "verifier"]),
    createdBeforePatch: z.boolean(),
    sourceRef: z.string().min(1).optional(),
  })
  .strict();

const OraclePlanSchema = z
  .object({
    schemaVersion: z.literal(0),
    planId: z.string().min(1),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    snapshotId: z.string().min(1),
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    contractId: z.string().min(1),
    contractHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().datetime(),
    planner: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        patchBlind: z.boolean(),
      })
      .strict(),
    frozen: z.literal(true),
    steps: z.array(OracleStepSchema),
  })
  .strict();

const LinkSchema = z
  .object({
    schemaVersion: z.literal(0),
    linkId: z.string().min(1),
    claimId: z.string().min(1),
    evidenceId: z.string().min(1),
    oracleStepId: z.string().min(1).optional(),
    producerRole: z.enum(["canonical", "observer", "verifier", "implementor"]),
    admissible: z.boolean(),
    relation: z.enum(["supports", "contradicts", "inconclusive"]),
    reason: z.string().min(1),
  })
  .strict();

const SufficiencySchema = z
  .object({
    schemaVersion: z.literal(0),
    contractId: z.string().min(1),
    contractHash: z.string().regex(/^[0-9a-f]{64}$/),
    verdict: z.enum(["ACCEPT", "REJECT", "ESCALATE", "INSUFFICIENT_EVIDENCE"]),
    claimResults: z.array(
      z
        .object({
          claimId: z.string().min(1),
          status: z.enum([
            "supported",
            "contradicted",
            "unproven",
            "ambiguous",
          ]),
          evidenceIds: z.array(z.string()),
          reason: z.string().optional(),
        })
        .strict(),
    ),
    systemHealth: z
      .object({
        snapshot: z.enum(["ok", "error"]),
        compiler: z.enum(["ok", "error"]),
        oraclePlanner: z.enum(["ok", "error"]),
        evidenceAdmission: z.enum(["ok", "error"]),
        sufficiency: z.enum(["ok", "error"]),
      })
      .strict(),
    errors: z.array(z.string()),
  })
  .strict();

export const AcceptanceInputSnapshotSchema = SnapshotSchema;
export const AcceptanceClaimSchema = ClaimSchema;
export const ExecutableAcceptanceContractSchema = ContractSchema;
export const OraclePlanSchemaV0 = OraclePlanSchema;
export const ClaimEvidenceLinkSchema = LinkSchema;
export const SufficiencyResultSchema = SufficiencySchema;

const FORBIDDEN_KEYS = new Set([
  "candidatePatch",
  "candidate_patch",
  "patchPath",
  "patch_path",
  "workingTree",
  "working_tree",
  "filesystem",
  "fileSystem",
  "implementorMessages",
  "implementor_messages",
  "bdns",
  "bdnsRuntime",
  "chatEngine",
  "chat_engine",
  "claimSatisfied",
  "requirementMet",
  "acceptanceVerdict",
]);

function forbiddenKeys(value: unknown, path = "$"): string[] {
  if (!value || typeof value !== "object") return [];
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      found.push(...forbiddenKeys(item, `${path}[${index}]`)),
    );
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) found.push(`${path}.${key}`);
    found.push(...forbiddenKeys(item, `${path}.${key}`));
  }
  return found;
}

function zodErrors(result: { success: false; error: z.ZodError }): string[] {
  return result.error.issues.map(
    (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
  );
}

export function acceptanceInputSnapshotSchema(): typeof SnapshotSchema {
  return SnapshotSchema;
}
export function acceptanceClaimSchema(): typeof ClaimSchema {
  return ClaimSchema;
}
export function executableAcceptanceContractSchema(): typeof ContractSchema {
  return ContractSchema;
}
export function oraclePlanSchema(): typeof OraclePlanSchema {
  return OraclePlanSchema;
}
export function claimEvidenceLinkSchema(): typeof LinkSchema {
  return LinkSchema;
}
export function sufficiencyResultSchema(): typeof SufficiencySchema {
  return SufficiencySchema;
}

export function validateAcceptanceInputSnapshotV0(value: unknown): string[] {
  const parsed = SnapshotSchema.safeParse(value);
  if (!parsed.success) return zodErrors(parsed);
  const snapshot = parsed.data as AcceptanceInputSnapshotV0;
  const errors = forbiddenKeys(value);
  if (
    !isSha256(snapshot.snapshotHash) ||
    contentHashSnapshot(snapshot) !== snapshot.snapshotHash
  )
    errors.push("snapshotHash");
  if (!hasIdentityPrefix(snapshot.snapshotId, "as0:", snapshot.snapshotHash))
    errors.push("snapshotId");
  if (
    !snapshot.taskContractId.startsWith(
      `tc1:${snapshot.taskContractHash.slice(0, 16)}:`,
    )
  )
    errors.push("taskContractId");
  if (
    new Set(snapshot.baselineVerifiers.map((item) => item.command)).size !==
    snapshot.baselineVerifiers.length
  )
    errors.push("baselineVerifiers.duplicate_command");
  return errors;
}

export function validateAcceptanceClaimV0(value: unknown): string[] {
  const parsed = ClaimSchema.safeParse(value);
  if (!parsed.success) return zodErrors(parsed);
  const claim = parsed.data as AcceptanceClaimV0;
  const errors = forbiddenKeys(value);
  const claimHash = contentHashClaim(claim);
  if (
    !/^ac0:[0-9a-f]{16}:[^:]+$/.test(claim.claimId) ||
    !claim.claimId.startsWith(`ac0:${claimHash.slice(0, 16)}:`)
  )
    errors.push("claimId");
  return errors;
}

export function validateExecutableAcceptanceContractV0(
  value: unknown,
): string[] {
  const parsed = ContractSchema.safeParse(value);
  if (!parsed.success) return zodErrors(parsed);
  const contract = parsed.data as ExecutableAcceptanceContractV0;
  const errors = forbiddenKeys(value);
  if (contentHashContract(contract) !== contract.contractHash)
    errors.push("contractHash");
  if (!hasIdentityPrefix(contract.contractId, "eac0:", contract.contractHash))
    errors.push("contractId");
  if (
    !contract.taskContractId.startsWith(
      `tc1:${contract.taskContractHash.slice(0, 16)}:`,
    )
  )
    errors.push("taskContractId");
  const claimIds = contract.claims.map((claim) => claim.claimId);
  if (new Set(claimIds).size !== claimIds.length)
    errors.push("claims.duplicate_claimId");
  for (const claim of contract.claims)
    errors.push(
      ...validateAcceptanceClaimV0(claim).map((error) => `claims.${error}`),
    );
  return errors;
}

export function validateOraclePlanV0(value: unknown): string[] {
  const parsed = OraclePlanSchema.safeParse(value);
  if (!parsed.success) return zodErrors(parsed);
  const plan = parsed.data as OraclePlanV0;
  const errors = forbiddenKeys(value);
  if (contentHashOraclePlan(plan) !== plan.planHash) errors.push("planHash");
  if (!hasIdentityPrefix(plan.planId, "op0:", plan.planHash))
    errors.push("planId");
  if (
    plan.planner.patchBlind &&
    plan.steps.some(
      (step) =>
        step.createdBeforePatch === false &&
        step.sourceRef?.includes("candidate"),
    )
  )
    errors.push("post_patch_provenance");
  if (
    new Set(plan.steps.map((step) => step.oracleStepId)).size !==
    plan.steps.length
  )
    errors.push("steps.duplicate_oracleStepId");
  return errors;
}

/** Validate a plan's parent identities and claim references together. */
export function validateOraclePlanAgainstContractV0(
  value: unknown,
  contract: ExecutableAcceptanceContractV0,
): string[] {
  const errors = validateOraclePlanV0(value);
  if (errors.length > 0) return errors;
  const plan = value as OraclePlanV0;
  if (plan.snapshotId !== contract.snapshotId) errors.push("snapshotId");
  if (plan.snapshotHash !== contract.snapshotHash) errors.push("snapshotHash");
  if (plan.contractId !== contract.contractId) errors.push("contractId");
  if (plan.contractHash !== contract.contractHash) errors.push("contractHash");
  const claimIds = new Set(contract.claims.map((claim) => claim.claimId));
  for (const step of plan.steps) {
    if (!claimIds.has(step.claimId))
      errors.push(`steps.${step.oracleStepId}.claimId`);
    const claim = contract.claims.find(
      (candidate) => candidate.claimId === step.claimId,
    );
    if (claim?.epistemicStatus === "ambiguous" && step.oracleKind !== "human")
      errors.push(`steps.${step.oracleStepId}.ambiguous_claim`);
  }
  return errors;
}

export function validateClaimEvidenceLinkV0(value: unknown): string[] {
  const parsed = LinkSchema.safeParse(value);
  if (!parsed.success) return zodErrors(parsed);
  const link = parsed.data as ClaimEvidenceLinkV0;
  const errors = forbiddenKeys(value);
  if (!hasIdentityPrefix(link.linkId, "cel0:", contentHashEvidenceLink(link)))
    errors.push("linkId");
  if (link.admissible && link.producerRole === "implementor")
    errors.push("implementor_evidence");
  if (
    link.admissible &&
    link.relation === "supports" &&
    link.reason.trim().length === 0
  )
    errors.push("reason");
  return errors;
}

export function validateSufficiencyResultV0(value: unknown): string[] {
  const parsed = SufficiencySchema.safeParse(value);
  if (!parsed.success) return zodErrors(parsed);
  const result = parsed.data as SufficiencyResultV0;
  const errors = forbiddenKeys(value);
  if (!isSha256(result.contractHash)) errors.push("contractHash");
  return errors;
}

export function assertValid<T>(value: T, errors: string[], kind: string): T {
  if (errors.length > 0)
    throw new Error(`${kind} validation failed: ${errors.join(", ")}`);
  return value;
}
