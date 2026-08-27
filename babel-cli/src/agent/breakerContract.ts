import type { CapabilityId } from "../authority/capabilities.js";
import {
  validateTaskContractV1ForCompletion,
  type AcceptanceRequirementV1,
  type TaskContractV1,
} from "./taskContract.js";
import type { EvidenceNode } from "../evidence/evidenceGraph.js";

export const BREAKER_CONTRACT_VERSION = 1 as const;
export const BREAKER_READ_ONLY_CAPABILITIES: readonly CapabilityId[] = [
  "inspect_repository",
  "search_repository",
  "run_tests",
  "run_build",
  "run_lint",
  "run_typecheck",
];

export type BreakerSeverity = "low" | "medium" | "high" | "critical";
export type BreakerFindingStatus =
  | "open"
  | "reproduced"
  | "dismissed"
  | "unknown";

export interface BreakerContractV1 {
  schema_version: typeof BREAKER_CONTRACT_VERSION;
  breaker_id: string;
  role: "breaker";
  task_id: string;
  contract_hash: string;
  repository: string;
  base_sha: string | null;
  candidate_sha: string;
  acceptance: AcceptanceRequirementV1[];
  relevant_evidence: string[];
  capabilities: readonly CapabilityId[];
  mutation_allowed: false;
}

export interface BreakerFindingV1 {
  finding_id: string;
  severity: BreakerSeverity;
  contract_requirement: string;
  counterexample: string;
  reproduction: string;
  evidence: string[];
  confidence: "low" | "medium" | "high" | "unknown";
  status: BreakerFindingStatus;
}

function isMutationCapability(capability: CapabilityId): boolean {
  return [
    "edit_task_files",
    "create_task_branch",
    "create_worktree",
    "push_feature_branch",
    "commit_ship_set",
    "stage_ship_set",
    "pr_create_draft",
    "merge",
    "production_deploy",
    "credential_access",
    "run_arbitrary_code",
    "unknown",
  ].includes(capability);
}

/** Validate that a breaker remains independently read-only even if a caller delegates mutation. */
export function assertBreakerReadOnly(
  capabilities: readonly CapabilityId[],
): void {
  if (capabilities.some(isMutationCapability)) {
    throw new Error(
      "Breaker authority widening rejected: the BREAKER role is read-only.",
    );
  }
}

export function buildBreakerContractV1(input: {
  breaker_id: string;
  taskContract: TaskContractV1;
  repository: string;
  base_sha?: string | null;
  candidate_sha: string;
  relevant_evidence?: string[];
}): BreakerContractV1 {
  const contractErrors = validateTaskContractV1ForCompletion(
    input.taskContract,
  );
  if (!input.taskContract.frozen || contractErrors.length > 0) {
    throw new Error(
      `Breaker requires a valid frozen task contract: ${contractErrors.join(", ")}`,
    );
  }
  assertBreakerReadOnly(BREAKER_READ_ONLY_CAPABILITIES);
  if (
    !input.breaker_id.trim() ||
    !input.repository.trim() ||
    !input.candidate_sha.trim()
  ) {
    throw new Error(
      "Breaker contract requires durable identity and candidate provenance.",
    );
  }
  return {
    schema_version: BREAKER_CONTRACT_VERSION,
    breaker_id: input.breaker_id,
    role: "breaker",
    task_id: input.taskContract.task_id,
    contract_hash: input.taskContract.contract_hash,
    repository: input.repository,
    base_sha: input.base_sha ?? input.taskContract.base_sha,
    candidate_sha: input.candidate_sha,
    acceptance: [...input.taskContract.acceptance],
    relevant_evidence: [...(input.relevant_evidence ?? [])],
    capabilities: BREAKER_READ_ONLY_CAPABILITIES,
    mutation_allowed: false,
  };
}

export function createBreakerFindingV1(input: {
  finding_id: string;
  severity: BreakerSeverity;
  contract_requirement: string;
  counterexample: string;
  reproduction: string;
  evidence: string[];
  confidence?: BreakerFindingV1["confidence"];
  status?: BreakerFindingStatus;
}): BreakerFindingV1 {
  if (
    !input.finding_id.trim() ||
    !input.contract_requirement.trim() ||
    !input.counterexample.trim() ||
    !input.reproduction.trim()
  ) {
    throw new Error(
      "Breaker findings require a structured requirement, counterexample, and reproduction.",
    );
  }
  return {
    finding_id: input.finding_id,
    severity: input.severity,
    contract_requirement: input.contract_requirement,
    counterexample: input.counterexample,
    reproduction: input.reproduction,
    evidence: [...input.evidence],
    confidence: input.confidence ?? "unknown",
    status: input.status ?? "open",
  };
}

/** The breaker consumes structured inputs; no builder transcript is part of this boundary. */
export function breakerInputEvidence(nodes: readonly EvidenceNode[]): string[] {
  return nodes.map((node) => node.id);
}
