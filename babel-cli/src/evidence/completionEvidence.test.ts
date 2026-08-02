import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateCompletionEvidence } from "./completionEvidence.js";
import { EvidenceGraph } from "./evidenceGraph.js";

test("completion evidence requires linked claims and fresh verifier evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "babel-completion-evidence-"));
  try {
    await writeFile(join(root, "file.txt"), "same");
    const graph = new EvidenceGraph();
    graph.addNode({ id: "claim-1", type: "claim", data: {}, parents: [] });
    graph.addNode({
      id: "patch-1",
      type: "patch",
      data: {},
      parents: ["claim-1"],
    });
    graph.addNode({
      id: "receipt-1",
      type: "verifier_receipt",
      data: {
        receiptId: "receipt-1",
        stale: false,
        boundRevision: {
          gitCommitHash: null,
          compositeTreeHash: "unused",
          fileHashes: { "file.txt": "wrong" },
          capturedAt: Date.now(),
        },
      },
      parents: ["claim-1"],
    });
    const result = await evaluateCompletionEvidence({
      projectRoot: root,
      graph,
      contract: {
        taskClaimId: "claim-1",
        requiredEvidenceTypes: ["patch", "verifier_receipt"],
      },
    });
    assert.equal(result.compliant, false);
    assert.ok(result.errors.some((error) => error.includes("Stale receipt")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
