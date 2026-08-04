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

  /**
   * Sync graph validation for Chat finalize (streamDone/buildResult are sync).
   * Async wrapper delegates here — RevisionManager now has isReceiptStaleSync.
   */
  evaluateGraphSync(projectRoot: string): { valid: boolean; errors: string[] } {
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

    // Check for stale verifier receipts (revision recheck when boundRevision present)
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
      if (stale) {
        errors.push(`Stale receipt ${receipt.receiptId ?? receiptNode.id}: ${reason}`);
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

  async evaluateGraph(
    projectRoot: string,
  ): Promise<{ valid: boolean; errors: string[] }> {
    return this.evaluateGraphSync(projectRoot);
  }
}
