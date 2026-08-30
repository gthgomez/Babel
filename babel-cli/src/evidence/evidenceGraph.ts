import {
  RevisionBoundReceipt,
  RevisionManager,
  validateRevisionBoundReceipt,
} from "./revisionBoundReceipt.js";
import {
  validateTaskContractV1ForCompletion,
  type TaskContractV1,
  type AcceptanceRequirementV1,
} from "../agent/taskContract.js";
import {
  validateAcceptanceBundleForContractV1,
  type AcceptanceBundleV1,
} from "../acceptance/escrow.js";
import { canonicalJson, sha256Canonical } from "../acceptance/canonical.js";
import { redactEvidenceValue } from "../utils/redaction.js";
import {
  requiredCapabilityForAcceptanceType,
  type TrustedExecutionRegistryV1,
} from "./trustedExecutionIdentity.js";

export const EVIDENCE_GRAPH_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_GRAPH_MAX_BYTES = 256 * 1024;

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
  | "security_result"
  | "policy_result"
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
  run_id: string;
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
  /** Structured identity; producer_role alone is never a certification credential. */
  producer_identity?: EvidenceProducerIdentityV1;
}

export type EvidenceProducerRole =
  | "builder"
  | "reviewer"
  | "breaker"
  | "verifier"
  | "observer"
  | "system";

export interface EvidenceProducerIdentityV1 {
  kind: "agent_endpoint" | "execution_identity";
  endpoint_id: string;
  role: EvidenceProducerRole;
  execution_domain: string;
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

export interface EvidenceGraphDocumentV1 {
  schema_version: typeof EVIDENCE_GRAPH_SCHEMA_VERSION;
  task_id: string;
  contract_hash: string;
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
}

const CERTIFYING_TYPES: ReadonlySet<EvidenceNodeType> = new Set([
  "test_result",
  "build_result",
  "command_result",
  "verifier_receipt",
  "runtime_observation",
  "ci_result",
  "security_result",
  "policy_result",
]);

function producerIdentityError(node: EvidenceNode): string | undefined {
  const identity = node.producer_identity;
  if (!identity || typeof identity !== "object")
    return "certifying evidence requires a structured producer identity";
  if (
    !["agent_endpoint", "execution_identity"].includes(identity.kind) ||
    typeof identity.endpoint_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_./-]{2,127}$/.test(identity.endpoint_id) ||
    typeof identity.execution_domain !== "string" ||
    identity.execution_domain.trim().length === 0 ||
    !["verifier", "observer", "system"].includes(identity.role)
  ) {
    return "certifying evidence producer identity is malformed or not independent";
  }
  if (node.producer_role !== undefined && node.producer_role !== identity.role)
    return "producer_role does not match producer_identity";
  return undefined;
}

function requirementAcceptsNode(
  type: EvidenceNodeType,
  requirementType: string,
): boolean {
  const matrix: Record<string, EvidenceNodeType[]> = {
    unit_test: ["test_result", "ci_result", "verifier_receipt"],
    integration_test: ["test_result", "ci_result", "verifier_receipt"],
    e2e: ["test_result", "ci_result", "verifier_receipt"],
    build: ["build_result", "ci_result", "verifier_receipt"],
    lint: ["command_result", "ci_result", "verifier_receipt"],
    typecheck: ["command_result", "ci_result", "verifier_receipt"],
    security: ["security_result", "ci_result", "verifier_receipt"],
    policy: ["policy_result", "ci_result", "verifier_receipt"],
    runtime: ["runtime_observation"],
    custom: ["command_result", "test_result", "ci_result", "verifier_receipt"],
    manual: [],
  };
  return matrix[requirementType]?.includes(type) ?? false;
}

function verificationSpecHash(requirement: AcceptanceRequirementV1): string {
  return sha256Canonical(requirement.verification);
}

function verifierSpecError(
  node: EvidenceNode,
  requirement: AcceptanceRequirementV1,
): string | undefined {
  if (!node.data || typeof node.data !== "object" || Array.isArray(node.data))
    return "certifying evidence data is malformed";
  const data = node.data as Record<string, unknown>;
  if (data["verifier_spec_hash"] !== verificationSpecHash(requirement))
    return "evidence verifier specification is stale or mismatched";
  if (data["verifier_id"] !== requirement.verification.verifier_id)
    return "evidence verifier_id does not match the frozen requirement";
  if (
    requirement.verification.command_hash !== undefined &&
    data["command_hash"] !== requirement.verification.command_hash
  )
    return "evidence command_hash does not match the frozen verifier";
  if (
    requirement.verification.target !== undefined &&
    data["target"] !== requirement.verification.target
  )
    return "evidence target does not match the frozen verifier";
  return undefined;
}

function certifyingEvidenceError(
  node: EvidenceNode,
  requirement: AcceptanceRequirementV1,
): string | undefined {
  if (!CERTIFYING_TYPES.has(node.type))
    return `${node.type} is not a certifying evidence type`;
  const identityError = producerIdentityError(node);
  if (identityError) return identityError;
  if (!requirementAcceptsNode(node.type, requirement.type))
    return `${node.type} is incompatible with ${requirement.type}`;
  const verifierError = verifierSpecError(node, requirement);
  if (verifierError) return verifierError;
  if (!node.data || typeof node.data !== "object" || Array.isArray(node.data))
    return "certifying evidence data is malformed";
  const data = node.data as Record<string, unknown>;
  if (node.type === "verifier_receipt") {
    return undefined;
  }
  if (node.type !== "runtime_observation" && data["exit_code"] !== 0)
    return "certifying evidence has a non-zero exit_code";
  if (node.type === "runtime_observation") {
    if (
      String(data["status"] ?? "").toLowerCase() !== "observed" ||
      data["passed"] !== true
    )
      return "runtime observation is not a passing observation";
    return undefined;
  }
  const status = String(data["status"] ?? "").toLowerCase();
  const passingStatus =
    node.type === "ci_result"
      ? status === "success" || status === "passed"
      : status === "passed" || status === "success";
  if (!passingStatus && data["passed"] !== true)
    return "certifying evidence does not contain a typed passing result";
  if (
    node.type === "command_result" &&
    typeof data["verifier_kind"] !== "string"
  )
    return "command_result requires an explicit verifier_kind";
  return undefined;
}

function bindingError(
  binding: EvidenceBindingV1 | undefined,
  input: {
    taskId: string;
    runId: string;
    contractHash: string;
    repository: string;
    baseSha: string | null;
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
  if (binding.base_sha !== input.baseSha)
    return "evidence base_sha does not match";
  if (binding.candidate_sha !== input.candidateSha)
    return "evidence candidate_sha is stale";
  if (binding.run_id !== input.runId) return "evidence run_id does not match";
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
      if (
        !node.id ||
        (!CERTIFYING_TYPES.has(node.type) &&
          ![
            "claim",
            "patch",
            "env_state",
            "critic_approval",
            "source_reference",
            "artifact",
            "review_finding",
            "challenge",
            "contract_requirement",
          ].includes(node.type))
      ) {
        errors.push(`Invalid evidence node: ${node.id}`);
      }
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

export function serializeEvidenceGraphV1(input: {
  graph: EvidenceGraph;
  task_id: string;
  contract_hash: string;
}): string {
  const validation = input.graph.validate();
  if (!validation.valid)
    throw new Error(`Invalid evidence graph: ${validation.errors.join(", ")}`);
  const document: EvidenceGraphDocumentV1 = {
    schema_version: EVIDENCE_GRAPH_SCHEMA_VERSION,
    task_id: input.task_id,
    contract_hash: input.contract_hash,
    nodes: redactEvidenceValue(Array.from(input.graph.getNodesMap().values())),
    edges: input.graph.getEdges(),
  };
  const serialized = `${canonicalJson(document)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > EVIDENCE_GRAPH_MAX_BYTES)
    throw new Error(
      `Evidence graph exceeds ${EVIDENCE_GRAPH_MAX_BYTES} bytes.`,
    );
  return serialized;
}

export function parseEvidenceGraphV1(raw: string): EvidenceGraphDocumentV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid evidence graph JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid evidence graph document.");
  const document = value as Partial<EvidenceGraphDocumentV1>;
  if (canonicalJson(redactEvidenceValue(value)) !== canonicalJson(value))
    throw new Error("Evidence graph contains durable secret-like content.");
  if (
    document.schema_version !== EVIDENCE_GRAPH_SCHEMA_VERSION ||
    typeof document.task_id !== "string" ||
    typeof document.contract_hash !== "string" ||
    !Array.isArray(document.nodes) ||
    !Array.isArray(document.edges)
  ) {
    throw new Error("Invalid evidence graph schema.");
  }
  const graph = new EvidenceGraph();
  for (const node of document.nodes) graph.addNode(node);
  for (const edge of document.edges) graph.addEdge(edge);
  const validation = graph.validate();
  if (!validation.valid)
    throw new Error(`Invalid evidence graph: ${validation.errors.join(", ")}`);
  return document as EvidenceGraphDocumentV1;
}

/** Deterministic V1 gate: required acceptance needs current, independent evidence. */
export function evaluateCompletionGateV1(input: {
  contract: TaskContractV1;
  graph: EvidenceGraph;
  repository: string;
  candidate_sha: string;
  run_id: string;
  trusted_execution: TrustedExecutionRegistryV1;
  project_root?: string;
  acceptance_bundle?: AcceptanceBundleV1;
}): CompletionEvaluationV1 {
  const contractErrors = validateTaskContractV1ForCompletion(input.contract);
  if (contractErrors.length > 0) {
    return {
      status: "UNKNOWN",
      verified: false,
      satisfied_requirements: [],
      missing_requirements: [],
      errors: contractErrors.map((error) => `contract:${error}`),
    };
  }
  const bundleErrors = input.acceptance_bundle
    ? validateAcceptanceBundleForContractV1(
        input.acceptance_bundle,
        input.contract,
      )
    : [];
  if (bundleErrors.length > 0) {
    return {
      status: "UNKNOWN",
      verified: false,
      satisfied_requirements: [],
      missing_requirements: input.contract.acceptance
        .filter((requirement) => requirement.required)
        .map((requirement) => requirement.id),
      errors: bundleErrors.map((error) => `acceptance_bundle:${error}`),
    };
  }
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
    const candidates = Array.from(input.graph.getNodesMap().values()).filter(
      (node) => node.binding?.requirement_id === requirement.id,
    );
    if (candidates.length === 0) {
      missing.push(requirement.id);
      continue;
    }
    let supported = false;
    for (const node of candidates) {
      const mismatch = bindingError(node.binding, {
        taskId: input.contract.task_id,
        runId: input.run_id,
        contractHash: input.contract.contract_hash,
        repository: input.repository,
        baseSha: input.contract.base_sha,
        candidateSha: input.candidate_sha,
      });
      if (mismatch) {
        hasUnknown = true;
        errors.push(`${node.id}: ${mismatch}`);
        continue;
      }
      const certificationError = certifyingEvidenceError(node, requirement);
      const requiredCapability = requiredCapabilityForAcceptanceType(
        requirement.type,
      );
      const registryResult = certificationError
        ? null
        : input.trusted_execution.authorize({
            run_id: input.run_id,
            task_id: input.contract.task_id,
            contract_hash: input.contract.contract_hash,
            endpoint_id: node.producer_identity?.endpoint_id ?? "",
            role: node.producer_identity?.role ?? "system",
            execution_domain: node.producer_identity?.execution_domain ?? "",
            ...(requiredCapability
              ? { required_capability: requiredCapability }
              : {}),
          });
      const trustedError =
        registryResult && !registryResult.authorized
          ? `trusted producer rejected: ${registryResult.error}`
          : undefined;
      const receiptErrors =
        !certificationError && !trustedError && node.type === "verifier_receipt"
          ? validateRevisionBoundReceipt(node.data)
          : [];
      const staleReceipt =
        receiptErrors.length === 0 &&
        node.type === "verifier_receipt" &&
        input.project_root
          ? RevisionManager.isReceiptStaleSync(
              node.data as RevisionBoundReceipt,
              input.project_root,
            )
          : { stale: false };
      const effectiveCertificationError =
        certificationError ??
        trustedError ??
        (receiptErrors.length > 0
          ? `malformed revision-bound receipt: ${receiptErrors.join(", ")}`
          : staleReceipt.stale
            ? `stale revision-bound receipt: ${staleReceipt.reason ?? "unknown"}`
            : node.type === "verifier_receipt" && !input.project_root
              ? "revision-bound receipt cannot be rechecked without project_root"
              : node.type === "verifier_receipt" &&
                  (node.data as RevisionBoundReceipt).exitCode !== 0
                ? "verifier receipt has a non-zero exitCode"
                : undefined);
      if (effectiveCertificationError) {
        if (
          CERTIFYING_TYPES.has(node.type) &&
          typeof node.data === "object" &&
          node.data !== null &&
          !Array.isArray(node.data) &&
          (((node.data as Record<string, unknown>)["exit_code"] !== undefined &&
            (node.data as Record<string, unknown>)["exit_code"] !== 0) ||
            (node.type === "verifier_receipt" &&
              (node.data as Record<string, unknown>)["exitCode"] !==
                undefined &&
              (node.data as Record<string, unknown>)["exitCode"] !== 0) ||
            String(
              (node.data as Record<string, unknown>)["status"] ?? "",
            ).toLowerCase() === "failed")
        ) {
          hasContradiction = true;
        } else {
          hasUnknown = true;
        }
        errors.push(`${node.id}: ${effectiveCertificationError}`);
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
