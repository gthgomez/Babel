import {
  RevisionBoundReceipt,
  RevisionManager,
} from "./revisionBoundReceipt.js";
import type { TaskContractV1 } from "../agent/taskContract.js";

export type EvidenceNodeType =
  | "claim"
  | "patch"
  | "verifier_receipt"
  | "env_state"
  | "critic_approval"
  | "test_result"
  | "build_result"
  | "command_result"
  | "source_reference"
  | "artifact"
  | "review_finding"
  | "challenge"
  | "runtime_observation"
  | "ci_result"
  | "contract_requirement";

export type EvidenceRelation =
  | "supports"
  | "contradicts"
  | "verifies"
  | "challenges"
  | "satisfies"
  | "produced_by"
  | "applies_to"
  | "derived_from";

export interface EvidenceBindingV1 {
  task_id: string;
  contract_hash: string;
  repository: string;
  base_sha: string | null;
  candidate_sha: string;
  requirement_id?: string;
  artifact_hash?: string;
}

export interface EvidenceNode {
  id: string;
  type: EvidenceNodeType;
  data: unknown;
  parents: string[];
  binding?: EvidenceBindingV1;
  producer_role?:
    | "builder"
    | "reviewer"
    | "breaker"
    | "verifier"
    | "observer"
    | "system";
}

export interface EvidenceEdge {
  id: string;
  from: string;
  to: string;
  relation: EvidenceRelation;
}

export type CompletionStatusV1 =
  | "UNVERIFIED"
  | "PARTIAL"
  | "FAILED"
  | "VERIFIED"
  | "UNKNOWN";

export interface CompletionEvaluationV1 {
  status: CompletionStatusV1;
  verified: boolean;
  satisfied_requirements: string[];
  missing_requirements: string[];
  errors: string[];
}

function isPassingEvidence(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if (record["exit_code"] !== undefined && record["exit_code"] !== 0)
    return false;
  if (record["passed"] === true || record["verified"] === true) return true;
  return [
    "pass",
    "passed",
    "success",
    "succeeded",
    "verified",
    "green",
  ].includes(
    String(
      record["status"] ?? record["result"] ?? record["outcome"],
    ).toLowerCase(),
  );
}

function bindingError(
  binding: EvidenceBindingV1 | undefined,
  input: {
    taskId: string;
    contractHash: string;
    repository: string;
    candidateSha: string;
  },
): string | undefined {
  if (!binding) return "evidence is missing content provenance";
  if (binding.task_id !== input.taskId)
    return "evidence task_id does not match";
  if (binding.contract_hash !== input.contractHash)
    return "evidence contract_hash does not match";
  if (binding.repository !== input.repository)
    return "evidence repository does not match";
  if (binding.candidate_sha !== input.candidateSha)
    return "evidence candidate_sha is stale";
  return undefined;
}

export class EvidenceGraph {
  private readonly nodes: Map<string, EvidenceNode> = new Map();
  private readonly edges: Map<string, EvidenceEdge> = new Map();

  addNode(node: EvidenceNode): void {
    if (this.nodes.has(node.id))
      throw new Error(`Evidence node already exists: ${node.id}`);
    this.nodes.set(node.id, { ...node, parents: [...node.parents] });
  }

  addEdge(edge: EvidenceEdge): void {
    if (this.edges.has(edge.id))
      throw new Error(`Evidence edge already exists: ${edge.id}`);
    this.edges.set(edge.id, { ...edge });
  }

  getNode(id: string): EvidenceNode | undefined {
    return this.nodes.get(id);
  }
  getNodesByType(type: EvidenceNodeType): EvidenceNode[] {
    return Array.from(this.nodes.values()).filter((node) => node.type === type);
  }
  getNodesMap(): Map<string, EvidenceNode> {
    return this.nodes;
  }
  getEdges(): EvidenceEdge[] {
    return Array.from(this.edges.values());
  }

  /** Validate graph references without converting malformed data into success. */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const node of this.nodes.values()) {
      for (const parentId of node.parents) {
        if (!this.nodes.has(parentId))
          errors.push(`Dangling parent: ${node.id} -> ${parentId}`);
      }
    }
    for (const edge of this.edges.values()) {
      if (!this.nodes.has(edge.from))
        errors.push(`Dangling edge source: ${edge.id}`);
      if (!this.nodes.has(edge.to))
        errors.push(`Dangling edge target: ${edge.id}`);
    }
    return { valid: errors.length === 0, errors };
  }

  /** Existing Chat completion validation, retained for compatibility. */
  evaluateGraphSync(projectRoot: string): { valid: boolean; errors: string[] } {
    const errors = [...this.validate().errors];
    const receipts = this.getNodesByType("verifier_receipt");
    for (const receiptNode of receipts) {
      const receipt = receiptNode.data as RevisionBoundReceipt;
      if (!receipt?.boundRevision) {
        errors.push(
          `Verifier receipt ${receiptNode.id} missing boundRevision for H7 recheck`,
        );
        continue;
      }
      const { stale, reason } = RevisionManager.isReceiptStaleSync(
        {
          receiptId: receipt.receiptId ?? receiptNode.id,
          command: receipt.command ?? "",
          exitCode: receipt.exitCode ?? 1,
          boundRevision: receipt.boundRevision,
          stale: receipt.stale === true,
          ...(receipt.staleReason ? { staleReason: receipt.staleReason } : {}),
        },
        projectRoot,
      );
      if (stale)
        errors.push(
          `Stale receipt ${receipt.receiptId ?? receiptNode.id}: ${reason}`,
        );
    }
    for (const claim of this.getNodesByType("claim")) {
      const hasReceipt = receipts.some((receipt) =>
        receipt.parents.includes(claim.id),
      );
      if (!hasReceipt) errors.push(`Unverified claim: ${claim.id}`);
    }
    return { valid: errors.length === 0, errors };
  }

  async evaluateGraph(
    projectRoot: string,
  ): Promise<{ valid: boolean; errors: string[] }> {
    return this.evaluateGraphSync(projectRoot);
  }
}

/** Deterministic V1 gate: required acceptance needs current, independent evidence. */
export function evaluateCompletionGateV1(input: {
  contract: TaskContractV1;
  graph: EvidenceGraph;
  repository: string;
  candidate_sha: string;
}): CompletionEvaluationV1 {
  const graphValidation = input.graph.validate();
  const errors = [...graphValidation.errors];
  const required = input.contract.acceptance.filter(
    (requirement) => requirement.required,
  );
  const satisfied: string[] = [];
  const missing: string[] = [];
  let hasUnknown = false;
  let hasContradiction = false;

  for (const requirement of required) {
    const candidates = input.graph
      .getNodesByType("test_result")
      .concat(input.graph.getNodesByType("build_result"))
      .concat(input.graph.getNodesByType("command_result"))
      .concat(input.graph.getNodesByType("verifier_receipt"))
      .concat(input.graph.getNodesByType("runtime_observation"))
      .concat(input.graph.getNodesByType("ci_result"))
      .concat(input.graph.getNodesByType("source_reference"))
      .concat(input.graph.getNodesByType("artifact"))
      .concat(input.graph.getNodesByType("challenge"))
      .concat(input.graph.getNodesByType("review_finding"))
      .filter((node) => node.binding?.requirement_id === requirement.id);
    if (candidates.length === 0) {
      missing.push(requirement.id);
      continue;
    }
    let supported = false;
    for (const node of candidates) {
      if (node.producer_role === "builder") {
        hasUnknown = true;
        errors.push(`${node.id}: builder evidence cannot self-certify`);
        continue;
      }
      const mismatch = bindingError(node.binding, {
        taskId: input.contract.task_id,
        contractHash: input.contract.contract_hash,
        repository: input.repository,
        candidateSha: input.candidate_sha,
      });
      if (mismatch) {
        hasUnknown = true;
        errors.push(`${node.id}: ${mismatch}`);
        continue;
      }
      if (!isPassingEvidence(node.data)) {
        hasContradiction = true;
        errors.push(`${node.id}: required evidence is failed or contradictory`);
        continue;
      }
      supported = true;
    }
    if (supported) satisfied.push(requirement.id);
    else if (!missing.includes(requirement.id)) missing.push(requirement.id);
  }

  if (hasContradiction)
    return {
      status: "FAILED",
      verified: false,
      satisfied_requirements: satisfied,
      missing_requirements: missing,
      errors,
    };
  if (
    required.length > 0 &&
    satisfied.length === required.length &&
    !hasUnknown &&
    errors.length === 0
  ) {
    return {
      status: "VERIFIED",
      verified: true,
      satisfied_requirements: satisfied,
      missing_requirements: [],
      errors: [],
    };
  }
  if (hasUnknown && satisfied.length === 0)
    return {
      status: "UNKNOWN",
      verified: false,
      satisfied_requirements: satisfied,
      missing_requirements: missing,
      errors,
    };
  if (satisfied.length > 0)
    return {
      status: "PARTIAL",
      verified: false,
      satisfied_requirements: satisfied,
      missing_requirements: missing,
      errors,
    };
  return {
    status: "UNVERIFIED",
    verified: false,
    satisfied_requirements: satisfied,
    missing_requirements: missing,
    errors,
  };
}
