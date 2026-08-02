import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { IndependentVerifier } from "./independentVerifier.js";
import { RevisionManager } from "./revisionBoundReceipt.js";
import { EvidenceGraph } from "./evidenceGraph.js";
import { ContractEvaluator } from "./acceptanceContracts.js";
import { evaluateExecuteCompletionHonesty } from "../agent/completionGatePolicy.js";

describe("Proof-Carrying Completion", () => {
  it("verifies IndependentVerifier execution leaves primary workspace un-mutated", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "babel-test-"));
    try {
      const filePath = path.join(tempDir, "file.txt");
      await fs.writeFile(filePath, "original");

      const receipt = await IndependentVerifier.runIsolatedVerification(
        tempDir,
        "node -e \"require('node:fs').writeFileSync('file.txt', 'mutated')\"",
        ["file.txt"],
      );

      const content = await fs.readFile(filePath, "utf-8");
      assert.strictEqual(content.trim(), "original");
      assert.strictEqual(receipt.exitCode, 0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("verifies workspace changes after verifier execution invalidate receipts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "babel-test2-"));
    try {
      const filePath = path.join(tempDir, "file.txt");
      await fs.writeFile(filePath, "v1");

      const receipt = await IndependentVerifier.runIsolatedVerification(
        tempDir,
        "node -e \"process.stdout.write('ok')\"",
        ["file.txt"],
      );

      // Verify not stale yet
      const { stale: stale1 } = await RevisionManager.isReceiptStale(
        receipt,
        tempDir,
      );
      assert.strictEqual(stale1, false);

      // Mutate
      await fs.writeFile(filePath, "v2");

      // Verify stale
      const { stale: stale2, reason } = await RevisionManager.isReceiptStale(
        receipt,
        tempDir,
      );
      assert.strictEqual(stale2, true);
      assert.match(reason!, /File modified after verification/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("verifies VERIFIED_COMPLETE requires claim coverage and valid evidence graph nodes", async () => {
    const graph = new EvidenceGraph();
    graph.addNode({
      id: "claim-1",
      type: "claim",
      data: { desc: "Fix bug" },
      parents: [],
    });

    // Contract requires patch and verifier
    const contract = {
      taskClaimId: "claim-1",
      requiredEvidenceTypes: ["patch", "verifier_receipt"] as (
        | "patch"
        | "verifier_receipt"
      )[],
    };

    const res1 = ContractEvaluator.evaluateContract(contract, graph);
    assert.strictEqual(res1.compliant, false);

    graph.addNode({
      id: "patch-1",
      type: "patch",
      data: {},
      parents: ["claim-1"],
    });

    const res2 = ContractEvaluator.evaluateContract(contract, graph);
    assert.strictEqual(res2.compliant, false);

    graph.addNode({
      id: "receipt-1",
      type: "verifier_receipt",
      data: {
        receiptId: "receipt-1",
        stale: false,
        boundRevision: { fileHashes: {} },
      },
      parents: ["claim-1"],
    });

    const res3 = ContractEvaluator.evaluateContract(contract, graph);
    assert.strictEqual(res3.compliant, true);
  });
});
