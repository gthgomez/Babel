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

test('a missing path and an empty file never share a digest', async () => {
  const testDir = fs.mkdtempSync(path.join(process.cwd(), 'test-tx-missing-'));
  const absent = path.join(testDir, 'absent.txt');
  const empty = path.join(testDir, 'empty.txt');
  fs.writeFileSync(empty, '', 'utf8');
  const tx = await WorkspaceTransactionManager.beginBatch([absent, empty]);
  assert.notEqual(tx.preBatchHash[absent], tx.preBatchHash[empty]);
  try {
    const expected = await WorkspaceTransactionManager.commitBatch(tx, {
      expectedPostImages: { [absent]: '', [empty]: '' },
    });
    // Expecting content '' at the ABSENT path must not verify: absent !== empty.
    assert.equal(expected.verified, false);
    assert.equal(expected.status, 'conflicted');
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('rollback preserves paths that appeared after an absent pre-image without ownership evidence', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'test-tx-created-outsider-'));
  try {
    for (const [name, content] of [['nonempty', 'concurrent bytes\n'], ['empty', '']] as const) {
      const target = path.join(root, name);
      const tx = await WorkspaceTransactionManager.beginBatch([target]);
      fs.writeFileSync(target, content);
      const result = await WorkspaceTransactionManager.undoLastMutationBatch(tx);
      assert.equal(result.verification, false);
      assert.equal(fs.readFileSync(target, 'utf8'), content);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollback removes a confirmed creation only while identity and content match', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'test-tx-owned-create-'));
  try {
    const target = path.join(root, 'created.txt');
    const expected = 'created by this dispatch\n';
    const tx = await WorkspaceTransactionManager.beginBatch([target]);
    fs.writeFileSync(target, expected);
    const stat = fs.statSync(target);
    WorkspaceTransactionManager.recordCreatedFileOwnership(tx, target, {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      expectedContent: expected,
    });
    const result = await WorkspaceTransactionManager.undoLastMutationBatch(tx);
    assert.equal(result.verification, true);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollback preserves edited, same-byte replacement, and partial creation contents', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'test-tx-created-conflict-'));
  try {
    for (const scenario of ['edited', 'same_bytes_replaced', 'partial'] as const) {
      const target = path.join(root, `${scenario}.txt`);
      const expected = 'expected creation bytes\n';
      const tx = await WorkspaceTransactionManager.beginBatch([target]);
      fs.writeFileSync(target, expected);
      const original = fs.statSync(target);
      WorkspaceTransactionManager.recordCreatedFileOwnership(tx, target, {
        device: original.dev.toString(),
        inode: original.ino.toString(),
        expectedContent: expected,
      });
      if (scenario === 'edited') {
        fs.writeFileSync(target, 'edited bytes\n');
      } else if (scenario === 'same_bytes_replaced') {
        const replacement = path.join(root, `${scenario}.replacement`);
        fs.writeFileSync(replacement, expected);
        assert.notEqual(fs.statSync(replacement).ino, original.ino);
        fs.renameSync(replacement, target);
      } else {
        fs.writeFileSync(target, 'partial');
      }
      const content = fs.readFileSync(target, 'utf8');
      const result = await WorkspaceTransactionManager.undoLastMutationBatch(tx);
      assert.equal(result.verification, false, scenario);
      assert.equal(fs.readFileSync(target, 'utf8'), content, scenario);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
