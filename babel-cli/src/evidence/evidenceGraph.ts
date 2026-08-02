import {
  RevisionBoundReceipt,
  RevisionManager,
} from "./revisionBoundReceipt.js";

export type EvidenceNodeType =
  | "claim"
  | "patch"
  | "verifier_receipt"
  | "env_state"
  | "critic_approval";

export interface EvidenceNode {
  id: string;
  type: EvidenceNodeType;
  data: any;
  parents: string[];
}

export class EvidenceGraph {
  private nodes: Map<string, EvidenceNode> = new Map();

  addNode(node: EvidenceNode) {
    this.nodes.set(node.id, node);
  }

  getNode(id: string): EvidenceNode | undefined {
    return this.nodes.get(id);
  }

  getNodesByType(type: EvidenceNodeType): EvidenceNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.type === type);
  }

  getNodesMap(): Map<string, EvidenceNode> {
    return this.nodes;
  }

  async evaluateGraph(
    projectRoot: string,
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check for missing dependencies (broken DAG links)
    for (const node of this.nodes.values()) {
      for (const parentId of node.parents) {
        if (!this.nodes.has(parentId)) {
          errors.push(
            `Broken link: Node ${node.id} references missing parent ${parentId}`,
          );
        }
      }
    }

    // Check for stale verifier receipts
    const receipts = this.getNodesByType("verifier_receipt");
    for (const receiptNode of receipts) {
      const receipt = receiptNode.data as RevisionBoundReceipt;
      const { stale, reason } = await RevisionManager.isReceiptStale(
        receipt,
        projectRoot,
      );
      if (stale) {
        errors.push(`Stale receipt ${receipt.receiptId}: ${reason}`);
      }
    }

    // Check for unverified claims (claims with no child verifier_receipt)
    const claims = this.getNodesByType("claim");
    for (const claim of claims) {
      const hasReceipt = receipts.some((r) => r.parents.includes(claim.id));
      if (!hasReceipt) {
        errors.push(`Unverified claim: ${claim.id}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
