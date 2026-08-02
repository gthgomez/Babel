import { EvidenceGraph, EvidenceNode } from "./evidenceGraph.js";

export interface AcceptanceContract {
  taskClaimId: string;
  requiredEvidenceTypes: (
    | "patch"
    | "verifier_receipt"
    | "env_state"
    | "critic_approval"
  )[];
}

export class ContractEvaluator {
  static evaluateContract(
    contract: AcceptanceContract,
    graph: EvidenceGraph,
  ): { compliant: boolean; missing: string[] } {
    const claimNode = graph.getNode(contract.taskClaimId);
    if (!claimNode || claimNode.type !== "claim") {
      return { compliant: false, missing: ["claim"] };
    }

    const childNodes = Array.from(graph.getNodesMap().values()).filter(
      (n: EvidenceNode) => n.parents.includes(contract.taskClaimId),
    );

    const foundTypes = new Set(childNodes.map((n: EvidenceNode) => n.type));
    const missing = contract.requiredEvidenceTypes.filter(
      (req) => !foundTypes.has(req),
    );

    return {
      compliant: missing.length === 0,
      missing,
    };
  }
}
