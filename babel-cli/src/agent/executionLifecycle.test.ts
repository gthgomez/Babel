import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createExecutionLifecycleV1,
  loadExecutionLifecycleV1,
} from "./executionLifecycle.js";

test("execution lifecycle enforces the ordered state machine and bindings", () => {
  const lifecycle = createExecutionLifecycleV1({
    task_id: "task-1",
    run_id: "run-1",
    contract_hash: "contract-1",
    assignment_id: "assignment-1",
    updated_at: "2026-08-30T00:00:00.000Z",
  });
  assert.equal(lifecycle.snapshot.state, "CREATED");
  lifecycle.transition("ASSIGNED", "2026-08-30T00:00:01.000Z");
  lifecycle.transition("RUNNING", "2026-08-30T00:00:02.000Z");
  assert.equal(lifecycle.snapshot.revision, 2);
  assert.throws(
    () => lifecycle.transition("COMPLETED"),
    /Illegal lifecycle transition/,
  );
});

test("execution lifecycle persistence rejects tampering and wrong bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "babel-lifecycle-"));
  try {
    const filePath = join(root, "lifecycle.json");
    const lifecycle = createExecutionLifecycleV1({
      task_id: "task-1",
      run_id: "run-1",
      contract_hash: "contract-1",
      assignment_id: "assignment-1",
    });
    lifecycle.save(filePath);
    const restored = loadExecutionLifecycleV1(filePath, {
      task_id: "task-1",
      run_id: "run-1",
    });
    assert.deepEqual(restored.snapshot, lifecycle.snapshot);
    assert.throws(
      () => loadExecutionLifecycleV1(filePath, { task_id: "different-task" }),
      /binding mismatch/,
    );

    const tampered = JSON.parse(readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    tampered.state = "COMPLETED";
    writeFileSync(filePath, JSON.stringify(tampered));
    assert.throws(
      () => loadExecutionLifecycleV1(filePath),
      /tampered|hash mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
