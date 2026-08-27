import type { WorkspaceRevision } from "../evidence/revisionBoundReceipt.js";

export const ACCEPTANCE_SCHEMA_VERSION = 0 as const;

export type AcceptanceEpistemicStatus =
  | "explicit"
  | "inferred"
  | "ambiguous"
  | "unverifiable";

export type ClaimProvenanceSourceKind =
  | "user_request"
  | "task_contract"
  | "policy"
  | "baseline_behavior"
  | "other_authoritative_input";

export type AcceptanceClaimPolarity = "must_hold" | "must_not_hold";
export type AcceptanceAssurance = "normal" | "elevated" | "high";
export type OracleKind =
  | "existing_test"
  | "hidden_test"
  | "property_probe"
  | "static_probe"
  | "runtime_probe"
  | "bdns_candidate"
  | "independent_verifier"
  | "human";

export type OracleIndependence =
  | "implementor"
  | "canonical"
  | "observer"
  | "verifier";
export type EvidenceProducerRole =
  | "canonical"
  | "observer"
  | "verifier"
  | "implementor";
export type EvidenceRelation = "supports" | "contradicts" | "inconclusive";
export type EvidenceHealth =
  | "complete"
  | "partial"
  | "truncated"
  | "dropped"
  | "source_unavailable";

export type SufficiencyVerdict =
  | "ACCEPT"
  | "REJECT"
  | "ESCALATE"
  | "INSUFFICIENT_EVIDENCE";

export type ClaimResultStatus =
  | "supported"
  | "contradicted"
  | "unproven"
  | "ambiguous";
export type AcceptanceSubsystemState = "ok" | "error";

export interface AcceptanceBaselineVerifierV0 {
  command: string;
  exitCode: number;
  digest?: string;
}

export interface AcceptancePolicySnapshotV0 {
  mode: string;
  allowedEffects: string[];
  protectedPaths: string[];
}

export interface AcceptanceAuthoritativeInputV0 {
  kind: string;
  ref: string;
  digest?: string;
}

/** Immutable pre-implementation input surface visible to the compiler. */
export interface AcceptanceInputSnapshotV0 {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  snapshotId: string;
  snapshotHash: string;
  createdAt: string;
  origin: "pre_implementation";
  patchVisibility: "none";
  taskContractId: string;
  taskContractHash: string;
  userRequest: string;
  baseline: {
    gitHead?: string;
    workspaceRevision?: WorkspaceRevision;
    treeDigest?: string;
  };
  baselineVerifiers: AcceptanceBaselineVerifierV0[];
  policies: AcceptancePolicySnapshotV0;
  authoritativeInputs?: AcceptanceAuthoritativeInputV0[];
  /** Copied from the frozen contract so compilation still receives one snapshot. */
  taskContractAcceptanceCriteria?: string[];
}

export interface ClaimProvenanceV0 {
  sourceKind: ClaimProvenanceSourceKind;
  sourceRef: string;
}

export interface AcceptanceClaimScopeV0 {
  paths?: string[];
  behaviors?: string[];
}

/** A small falsifiable statement of what must be true, not a test recipe. */
export interface AcceptanceClaimV0 {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  claimId: string;
  statement: string;
  polarity: AcceptanceClaimPolarity;
  epistemicStatus: AcceptanceEpistemicStatus;
  provenance: ClaimProvenanceV0[];
  scope: AcceptanceClaimScopeV0;
  falsifier: string;
  required: boolean;
  assurance?: AcceptanceAssurance;
}

export interface PatchBlindProvenanceV0 {
  inputType: "AcceptanceInputSnapshotV0";
  origin: "pre_implementation";
  patchVisibility: "none";
  forbiddenInputs: readonly [
    "filesystem",
    "working_tree",
    "candidate_patch",
    "implementor_messages",
    "bdns_runtime",
  ];
}

/** Frozen semantic acceptance contract; it is separate from TaskContractV1. */
export interface ExecutableAcceptanceContractV0 {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  contractId: string;
  contractHash: string;
  snapshotId: string;
  snapshotHash: string;
  taskContractId: string;
  taskContractHash: string;
  createdAt: string;
  claims: AcceptanceClaimV0[];
  compiler: {
    name: string;
    version: string;
    patchBlind: true;
  };
  patchBlindProvenance: PatchBlindProvenanceV0;
  frozen: true;
}

export interface OracleStepV0 {
  oracleStepId: string;
  claimId: string;
  oracleKind: OracleKind;
  command?: string;
  independence: OracleIndependence;
  createdBeforePatch: boolean;
  sourceRef?: string;
}

/** Frozen, claim-bound verification strategy. Planning never executes a step. */
export interface OraclePlanV0 {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  planId: string;
  planHash: string;
  snapshotId: string;
  snapshotHash: string;
  contractId: string;
  contractHash: string;
  createdAt: string;
  planner: {
    name: string;
    version: string;
    patchBlind: boolean;
  };
  frozen: true;
  steps: OracleStepV0[];
}

/** Explicit interpretation of one evidence artifact against one claim. */
export interface ClaimEvidenceLinkV0 {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  linkId: string;
  claimId: string;
  evidenceId: string;
  oracleStepId?: string;
  producerRole: EvidenceProducerRole;
  admissible: boolean;
  relation: EvidenceRelation;
  reason: string;
}

export interface AcceptanceSystemHealthV0 {
  snapshot: AcceptanceSubsystemState;
  compiler: AcceptanceSubsystemState;
  oraclePlanner: AcceptanceSubsystemState;
  evidenceAdmission: AcceptanceSubsystemState;
  sufficiency: AcceptanceSubsystemState;
}

export interface SufficiencyClaimResultV0 {
  claimId: string;
  status: ClaimResultStatus;
  evidenceIds: string[];
  reason?: string;
}

export interface SufficiencyResultV0 {
  schemaVersion: typeof ACCEPTANCE_SCHEMA_VERSION;
  contractId: string;
  contractHash: string;
  verdict: SufficiencyVerdict;
  claimResults: SufficiencyClaimResultV0[];
  systemHealth: AcceptanceSystemHealthV0;
  errors: string[];
}

/** Generic interpreted evidence input used by the pure admission layer. */
export interface InterpretedEvidenceV0 {
  claimId: string;
  evidenceId: string;
  producerRole: EvidenceProducerRole;
  relation: EvidenceRelation;
  reason: string;
  oracleStepId?: string;
  evidenceHealth?: EvidenceHealth;
  stale?: boolean;
  patchVisibility?: "none" | "candidate_visible" | "unknown";
  implementationOrigin?:
    | "pre_implementation"
    | "during_implementation"
    | "post_implementation"
    | "unknown";
}
