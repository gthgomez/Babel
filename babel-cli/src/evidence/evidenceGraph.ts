import {
  RevisionBoundReceipt,
  RevisionManager,
  VerifierReceiptEvidenceV1Schema,
} from "./revisionBoundReceipt.js";
import {
  validateTaskContractV1ForCompletion,
  type TaskContractV1,
} from "../agent/taskContract.js";
import {
  getAuthoritativeTrustedExecutionResolver,
  trustedIdentityHasCapability,
  type TrustedExecutionContextV1,
  type TrustedExecutionResolver,
} from "../authority/trustedExecution.js";
import {
  validateAcceptanceBundleForContractV1,
  type AcceptanceBundleV1,
} from "../acceptance/escrow.js";
import { canonicalJson } from "../acceptance/canonical.js";
import { redactEvidenceValue } from "../utils/redaction.js";

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
  /** Structured identity; producer_role alone is never a certification credential. */
  producer_identity?: EvidenceProducerIdentityV1;
  /** Opaque supervisor-issued identity reference used by V1.1 certification. */
  producer_identity_ref?: string;
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

export interface VerifierReceiptEvidenceV1 {
  schema_version: 1;
  receipt: RevisionBoundReceipt;
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

function sameRevisionIdentity(
  left: RevisionBoundReceipt["boundRevision"],
  right: RevisionBoundReceipt["boundRevision"],
): boolean {
  const leftFiles = Object.keys(left.fileHashes).sort();
  const rightFiles = Object.keys(right.fileHashes).sort();
  return (
    left.gitCommitHash === right.gitCommitHash &&
    left.compositeTreeHash === right.compositeTreeHash &&
    leftFiles.length === rightFiles.length &&
    leftFiles.every(
      (file, index) =>
        file === rightFiles[index] &&
        left.fileHashes[file] === right.fileHashes[file],
    )
  );
}

const CERTIFYING_TYPES: ReadonlySet<EvidenceNodeType> = new Set([
  "test_result",
  "build_result",
  "command_result",
  "verifier_receipt",
  "runtime_observation",
  "ci_result",
]);

function producerIdentityError(
  node: EvidenceNode,
  context: TrustedExecutionContextV1,
  resolver: TrustedExecutionResolver,
): string | undefined {
  const identityRef = node.producer_identity_ref;
  if (!identityRef)
    return "certifying evidence requires a supervisor-issued identity reference";
  if (identityRef !== context.execution_identity_ref)
    return "evidence identity is not the identity bound to the trusted context";
  const identity = resolver.resolveExecutionIdentity(identityRef);
  if (!identity) return "evidence identity is unknown, expired, or revoked";
  if (!["verifier", "observer", "system"].includes(identity.role))
    return "evidence identity is not independently authorized to certify";
  if (identity.task_id !== context.task_id)
    return "evidence identity task binding does not match";
  if (identity.contract_hash !== context.contract_hash)
    return "evidence identity contract binding does not match";
  if (!trustedIdentityHasCapability(identity, "certify_evidence"))
    return "evidence identity lacks the certify_evidence capability";
  if (
    identity.role === "verifier" &&
    identity.execution_domain !== "isolated-verifier"
  )
    return "verifier identity execution domain is not authorized";
  const claimed = node.producer_identity;
  if (
    claimed &&
    (claimed.kind !== "execution_identity" ||
      claimed.endpoint_id !== identity.endpoint_id ||
      claimed.role !== identity.role ||
      claimed.execution_domain !== identity.execution_domain)
  )
    return "descriptive producer identity contradicts trusted identity";
  if (node.producer_role !== undefined && node.producer_role !== identity.role)
    return "producer_role does not match trusted identity";
  return undefined;
}

function requirementAcceptsNode(
  type: EvidenceNodeType,
  requirementType: string,
): boolean {
  if (type === "test_result")
    return ["unit_test", "integration_test", "e2e", "custom"].includes(
      requirementType,
    );
  if (type === "build_result") return requirementType === "build";
  if (type === "ci_result")
    return [
      "security",
      "policy",
      "custom",
      "unit_test",
      "integration_test",
      "e2e",
      "build",
    ].includes(requirementType);
  if (type === "runtime_observation") return requirementType === "runtime";
  if (type === "command_result") return requirementType === "custom";
  return true;
}

function certifyingEvidenceError(
  node: EvidenceNode,
  requirementType: string,
  context: TrustedExecutionContextV1,
  resolver: TrustedExecutionResolver,
): string | undefined {
  if (!CERTIFYING_TYPES.has(node.type))
    return `${node.type} is not a certifying evidence type`;
  const identityError = producerIdentityError(node, context, resolver);
  if (identityError) return identityError;
  if (!requirementAcceptsNode(node.type, requirementType))
    return `${node.type} is incompatible with ${requirementType}`;
  if (!node.data || typeof node.data !== "object" || Array.isArray(node.data))
    return "certifying evidence data is malformed";
  const data = node.data as Record<string, unknown>;
  if (node.type === "verifier_receipt") {
    const parsed = VerifierReceiptEvidenceV1Schema.safeParse(data);
    if (!parsed.success) return "verifier receipt is malformed";
    const receipt: RevisionBoundReceipt = {
      receiptId: parsed.data.receipt.receiptId,
      command: parsed.data.receipt.command,
      exitCode: parsed.data.receipt.exitCode,
      boundRevision: parsed.data.receipt.boundRevision,
      stale: parsed.data.receipt.stale,
      ...(parsed.data.receipt.staleReason !== undefined
        ? { staleReason: parsed.data.receipt.staleReason }
        : {}),
    };
    if (receipt.exitCode !== 0 || receipt.stale === true)
      return "verifier receipt is not a current passing receipt";
    if (receipt.boundRevision.gitCommitHash !== null) {
      if (receipt.boundRevision.gitCommitHash !== context.candidate_sha)
        return "verifier receipt revision does not match the trusted candidate";
      if (!context.project_root && !context.candidate_revision)
        return "verifier receipt has no trusted live or captured revision proof";
    } else {
      if (!context.candidate_revision)
        return "uncommitted verifier receipt lacks trusted workspace revision proof";
      if (
        context.candidate_revision.gitCommitHash !== null ||
        !sameRevisionIdentity(receipt.boundRevision, context.candidate_revision)
      )
        return "uncommitted verifier receipt does not match the trusted workspace revision";
    }
    if (
      context.candidate_revision &&
      !sameRevisionIdentity(receipt.boundRevision, context.candidate_revision)
    )
      return "verifier receipt does not match the trusted candidate revision";
    if (context.project_root) {
      const stale = RevisionManager.isReceiptStaleSync(
        receipt,
        context.project_root,
      );
      if (stale.stale)
        return (
          "verifier receipt is stale" +
          (stale.reason ? ": " + stale.reason : "")
        );
    }
    return undefined;
  }
  if (node.type !== "runtime_observation" && data["exit_code"] !== 0)
    return "certifying evidence has a non-zero exit_code";
  const status = String(data["status"] ?? "").toLowerCase();
  const passingStatus =
    node.type === "ci_result"
      ? status === "success" || status === "passed"
      : node.type === "runtime_observation"
        ? status === "observed" && data["passed"] === true
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
      const parsed = VerifierReceiptEvidenceV1Schema.safeParse(receiptNode.data);
      if (!parsed.success) {
        errors.push(`Malformed verifier receipt ${receiptNode.id}`);
        continue;
      }
      const receipt: RevisionBoundReceipt = {
        receiptId: parsed.data.receipt.receiptId,
        command: parsed.data.receipt.command,
        exitCode: parsed.data.receipt.exitCode,
        boundRevision: parsed.data.receipt.boundRevision,
        stale: parsed.data.receipt.stale,
        ...(parsed.data.receipt.staleReason !== undefined
          ? { staleReason: parsed.data.receipt.staleReason }
          : {}),
      };
      const { stale, reason } = RevisionManager.isReceiptStaleSync(
        receipt,
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
  repository?: string;
  candidate_sha?: string;
  acceptance_bundle?: AcceptanceBundleV1;
  /** Legacy compatibility input; it is deliberately ignored. */
  trusted_resolver?: TrustedExecutionResolver;
  /** Opaque context reference resolved outside the evidence graph. */
  trusted_context_ref?: string;
}): CompletionEvaluationV1 {
  const trustedResolver = getAuthoritativeTrustedExecutionResolver();
  const trustedContext =
    input.trusted_context_ref
      ? trustedResolver.resolveExecutionContext(input.trusted_context_ref)
      : undefined;
  if (!trustedContext) {
    return {
      status: "UNKNOWN",
      verified: false,
      satisfied_requirements: [],
      missing_requirements: [],
      errors: ["trusted_execution_context:missing_or_invalid"],
    };
  }
  const contractErrors = validateTaskContractV1ForCompletion(input.contract, {
    trustedAuthorityResolver: trustedResolver,
  });
  if (contractErrors.length > 0) {
    return {
      status: "UNKNOWN",
      verified: false,
      satisfied_requirements: [],
      missing_requirements: [],
      errors: contractErrors.map((error) => `contract:${error}`),
    };
  }
  const contextErrors: string[] = [];
  if (trustedContext.task_id !== input.contract.task_id)
    contextErrors.push("task_id");
  if (trustedContext.contract_hash !== input.contract.contract_hash)
    contextErrors.push("contract_hash");
  if (trustedContext.base_sha !== input.contract.base_sha)
    contextErrors.push("base_sha");
  if (
    input.contract.scope.repository &&
    input.contract.scope.repository !== trustedContext.repository
  )
    contextErrors.push("repository");
  if (
    input.repository !== undefined &&
    input.repository !== trustedContext.repository
  )
    contextErrors.push("caller_repository");
  if (
    input.candidate_sha !== undefined &&
    input.candidate_sha !== trustedContext.candidate_sha
  )
    contextErrors.push("caller_candidate_sha");
  if (contextErrors.length > 0) {
    return {
      status: "UNKNOWN",
      verified: false,
      satisfied_requirements: [],
      missing_requirements: input.contract.acceptance
        .filter((requirement) => requirement.required)
        .map((requirement) => requirement.id),
      errors: contextErrors.map((error) => `trusted_context:${error}`),
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
        contractHash: input.contract.contract_hash,
        repository: trustedContext.repository,
        baseSha: trustedContext.base_sha,
        candidateSha: trustedContext.candidate_sha,
      });
      if (mismatch) {
        hasUnknown = true;
        errors.push(`${node.id}: ${mismatch}`);
        continue;
      }
      const certificationError = certifyingEvidenceError(
        node,
        requirement.type,
        trustedContext,
        trustedResolver,
      );
      if (certificationError) {
        const malformedReceipt =
          node.type === "verifier_receipt" &&
          !VerifierReceiptEvidenceV1Schema.safeParse(node.data).success;
        if (
          !malformedReceipt &&
          CERTIFYING_TYPES.has(node.type) &&
          typeof node.data === "object" &&
          node.data !== null &&
          !Array.isArray(node.data) &&
          (((node.data as Record<string, unknown>)["exit_code"] !== undefined &&
            (node.data as Record<string, unknown>)["exit_code"] !== 0) ||
            ((node.data as Record<string, unknown>)["schema_version"] === 1 &&
              typeof (node.data as Record<string, unknown>)["receipt"] ===
                "object" &&
              (node.data as { receipt?: { exitCode?: unknown } }).receipt
                ?.exitCode !== 0) ||
            String(
              (node.data as Record<string, unknown>)["status"] ?? "",
            ).toLowerCase() === "failed")
        ) {
          hasContradiction = true;
        } else {
          hasUnknown = true;
        }
        errors.push(`${node.id}: ${certificationError}`);
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
