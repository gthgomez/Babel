import { test, describe } from "node:test";
import assert from "node:assert";
import { WorkspaceTransactionManager } from "./workspaceTransactions.js";
import { FileWriteMutex, findNearMissContext } from "./editReliability.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

describe("WorkspaceTransactionManager", () => {
  test("undoLastMutationBatch restores file digests to pre-images", async () => {
    const testDir = fs.mkdtempSync(path.join(process.cwd(), "test-tx-"));
    const file1 = path.join(testDir, "f1.txt");
    const file2 = path.join(testDir, "f2.txt");

    fs.writeFileSync(file1, "initial 1");
    fs.writeFileSync(file2, "initial 2");

    const tx = await WorkspaceTransactionManager.beginBatch([file1, file2]);

    fs.writeFileSync(file1, "changed 1");
    fs.writeFileSync(file2, "changed 2");

    const committedTx = await WorkspaceTransactionManager.commitBatch(tx);

    const result =
      await WorkspaceTransactionManager.undoLastMutationBatch(committedTx);
    assert.strictEqual(result.verification, true);

    const f1restored = fs.readFileSync(file1, "utf8");
    const f2restored = fs.readFileSync(file2, "utf8");
    assert.strictEqual(f1restored, "initial 1");
    assert.strictEqual(f2restored, "initial 2");

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("partial multi-file failure producing honest receipts", async () => {
    // We simulate partial failure by deleting a file after beginBatch.
    // wait, the prompt says "partial multi-file failure producing honest receipts"
    const testDir = fs.mkdtempSync(path.join(process.cwd(), "test-partial-"));
    const file1 = path.join(testDir, "f1.txt");
    const file2 = path.join(testDir, "f2.txt");

    fs.writeFileSync(file1, "initial 1");
    fs.writeFileSync(file2, "initial 2");

    const tx = await WorkspaceTransactionManager.beginBatch([file1, file2]);

    fs.writeFileSync(file1, "changed 1");
    // file2 is missing
    fs.unlinkSync(file2);

    const committedTx = await WorkspaceTransactionManager.commitBatch(tx);

    assert.strictEqual(committedTx.postImages[file1], "changed 1");
    assert.strictEqual(committedTx.postImages[file2], null); // file deleted!

    // undo
    const undoResult =
      await WorkspaceTransactionManager.undoLastMutationBatch(committedTx);
    assert.strictEqual(undoResult.verification, true);

    assert.strictEqual(fs.readFileSync(file2, "utf8"), "initial 2");
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("records workspace-derived revision hashes and changed bytes", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), "test-tx-bytes-"));
    const file = path.join(root, "tracked.txt");
    try {
      fs.writeFileSync(file, "before");
      const tx = await WorkspaceTransactionManager.beginBatch([file], {
        sessionId: "session-1",
      });
      fs.writeFileSync(file, "after content");
      const committed = await WorkspaceTransactionManager.commitBatch(tx);
      assert.notEqual(committed.preRevisionHash, committed.postRevisionHash);
      assert.ok(committed.changedBytes > 0);
      assert.equal(committed.status, "committed");
      const undone =
        await WorkspaceTransactionManager.undoLastMutationBatch("session-1");
      assert.equal(undone.verification, true);
      assert.equal(fs.readFileSync(file, "utf8"), "before");
      assert.equal(committed.status, "rolled_back");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("findNearMissContext", () => {
  test("returns diagnostic recovery context for near-miss str_replace", () => {
    const content = 'function foo() {\n  return "bar";\n}\n';
    const oldStr = 'function foo() {\n return "bar";\n}'; // different whitespace
    const result = findNearMissContext(content, oldStr);

    assert.ok(result.length > 0);
    assert.strictEqual(result[0]!.startLine, 1);
    assert.strictEqual(result[0]!.endLine, 3);
  });
});

describe("FileWriteMutex", () => {
  test("ensures concurrent writes to the same file execute sequentially", async () => {
    const p = "concurrent-test.txt";
    let sharedState = 0;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const p1 = FileWriteMutex.runExclusive(p, async () => {
      const v = sharedState;
      await sleep(10);
      sharedState = v + 1;
    });

    const p2 = FileWriteMutex.runExclusive(p, async () => {
      const v = sharedState;
      await sleep(5);
      sharedState = v + 1;
    });

    await Promise.all([p1, p2]);

    assert.strictEqual(sharedState, 2);
  });
});
