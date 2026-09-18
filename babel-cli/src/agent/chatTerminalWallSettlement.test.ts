import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chatSessionDir } from "../cli/runsLayout.js";
import { ChatEngine, type ChatEvent } from "./chatEngine.js";
import { parityOnUserTurn } from "./chatEngineParityBridge.js";

type PersistedAllowance = {
  consumed: { activeWallMs: number };
  activeExecution: boolean;
};

type TerminalAccess = {
  beginActiveExecution: () => void;
  streamDone: (answer: string) => ChatEvent;
  streamFailed: (error: string) => ChatEvent;
};

function terminalAccess(engine: ChatEngine): TerminalAccess {
  return engine as unknown as TerminalAccess;
}

function persistedAllowance(engine: ChatEngine): PersistedAllowance {
  return JSON.parse(
    readFileSync(
      join(chatSessionDir(engine.getEngineRunId()), "task-budget.json"),
      "utf8",
    ),
  ) as PersistedAllowance;
}

async function withFakeClock<T>(
  startMs: number,
  run: (clock: { advance: (deltaMs: number) => void }) => Promise<T> | T,
): Promise<T> {
  const originalNow = Date.now;
  let nowMs = startMs;
  Date.now = () => nowMs;
  try {
    return await run({
      advance: (deltaMs) => {
        nowMs += deltaMs;
      },
    });
  } finally {
    Date.now = originalNow;
  }
}

test("cancellation settles the active wall interval and cold resume stays inactive", async () => {
  const runsRoot = mkdtempSync(
    join(tmpdir(), "babel-chat-terminal-wall-cancel-"),
  );
  const projectRoot = mkdtempSync(
    join(tmpdir(), "babel-chat-terminal-wall-project-"),
  );
  const previousRunsDir = process.env["BABEL_RUNS_DIR"];
  process.env["BABEL_RUNS_DIR"] = runsRoot;

  try {
    await withFakeClock(1_000_000, async ({ advance }) => {
      const engine = new ChatEngine({
        task: "cancel wall task",
        projectRoot,
        model: "deepseek-v4-flash",
      });
      engine.applyUserSubmission({ userInput: "start cancel wall task" });
      terminalAccess(engine).beginActiveExecution();
      advance(1_234);

      engine.cancel();

      const persisted = persistedAllowance(engine);
      assert.equal(persisted.consumed.activeWallMs, 1_234);
      assert.equal(persisted.activeExecution, false);

      const resumed = new ChatEngine({
        task: "cancel wall task",
        projectRoot,
        runId: engine.getEngineRunId(),
        resumeExisting: true,
        model: "deepseek-v4-flash",
      });
      const resumedSnapshot = resumed.getTaskAllowanceSnapshot()!;
      assert.equal(resumedSnapshot.consumed.activeWallMs, 1_234);
      assert.equal(resumedSnapshot.activeExecution, false);
    });
  } finally {
    if (previousRunsDir === undefined) delete process.env["BABEL_RUNS_DIR"];
    else process.env["BABEL_RUNS_DIR"] = previousRunsDir;
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("failed terminal settles active wall time without changing failure classification", async () => {
  const runsRoot = mkdtempSync(
    join(tmpdir(), "babel-chat-terminal-wall-fail-"),
  );
  const projectRoot = mkdtempSync(
    join(tmpdir(), "babel-chat-terminal-wall-project-"),
  );
  const previousRunsDir = process.env["BABEL_RUNS_DIR"];
  process.env["BABEL_RUNS_DIR"] = runsRoot;

  try {
    await withFakeClock(2_000_000, async ({ advance }) => {
      const engine = new ChatEngine({
        task: "failed wall task",
        projectRoot,
        model: "deepseek-v4-flash",
      });
      engine.applyUserSubmission({ userInput: "start failed wall task" });
      parityOnUserTurn(engine.getParityRuntime(), {
        task: "start failed wall task",
        model: "deepseek-v4-flash",
        provider: "deepseek",
        projectRoot,
      });
      terminalAccess(engine).beginActiveExecution();
      advance(2_345);

      const event = terminalAccess(engine).streamFailed(
        "[deepSeekApi] provider hard failure 500",
      );

      assert.equal(event.type, "failed");
      assert.equal(event.outcome, "INFRA_FAILURE");
      const persisted = persistedAllowance(engine);
      assert.equal(persisted.consumed.activeWallMs, 2_345);
      assert.equal(persisted.activeExecution, false);
    });
  } finally {
    if (previousRunsDir === undefined) delete process.env["BABEL_RUNS_DIR"];
    else process.env["BABEL_RUNS_DIR"] = previousRunsDir;
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("normal terminal completion settles active wall time", async () => {
  const runsRoot = mkdtempSync(
    join(tmpdir(), "babel-chat-terminal-wall-done-"),
  );
  const projectRoot = mkdtempSync(
    join(tmpdir(), "babel-chat-terminal-wall-project-"),
  );
  const previousRunsDir = process.env["BABEL_RUNS_DIR"];
  process.env["BABEL_RUNS_DIR"] = runsRoot;

  try {
    await withFakeClock(3_000_000, async ({ advance }) => {
      const engine = new ChatEngine({
        task: "completed wall task",
        projectRoot,
        model: "deepseek-v4-flash",
      });
      engine.applyUserSubmission({ userInput: "start completed wall task" });
      parityOnUserTurn(engine.getParityRuntime(), {
        task: "start completed wall task",
        model: "deepseek-v4-flash",
        provider: "deepseek",
        projectRoot,
      });
      terminalAccess(engine).beginActiveExecution();
      advance(3_456);

      const event = terminalAccess(engine).streamDone("completed");

      assert.equal(event.type, "done");
      const persisted = persistedAllowance(engine);
      assert.equal(persisted.consumed.activeWallMs, 3_456);
      assert.equal(persisted.activeExecution, false);
    });
  } finally {
    if (previousRunsDir === undefined) delete process.env["BABEL_RUNS_DIR"];
    else process.env["BABEL_RUNS_DIR"] = previousRunsDir;
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("repeated terminalization does not double-charge active wall time", async () => {
  const runsRoot = mkdtempSync(
    join(tmpdir(), "babel-chat-terminal-wall-idempotent-"),
  );
  const projectRoot = mkdtempSync(
    join(tmpdir(), "babel-chat-terminal-wall-project-"),
  );
  const previousRunsDir = process.env["BABEL_RUNS_DIR"];
  process.env["BABEL_RUNS_DIR"] = runsRoot;

  try {
    await withFakeClock(4_000_000, async ({ advance }) => {
      const engine = new ChatEngine({
        task: "idempotent wall task",
        projectRoot,
        model: "deepseek-v4-flash",
      });
      engine.applyUserSubmission({ userInput: "start idempotent wall task" });
      parityOnUserTurn(engine.getParityRuntime(), {
        task: "start idempotent wall task",
        model: "deepseek-v4-flash",
        provider: "deepseek",
        projectRoot,
      });
      terminalAccess(engine).beginActiveExecution();
      advance(4_567);
      terminalAccess(engine).streamDone("completed");
      advance(9_999);
      terminalAccess(engine).streamDone("completed again");

      const persisted = persistedAllowance(engine);
      assert.equal(persisted.consumed.activeWallMs, 4_567);
      assert.equal(persisted.activeExecution, false);
    });
  } finally {
    if (previousRunsDir === undefined) delete process.env["BABEL_RUNS_DIR"];
    else process.env["BABEL_RUNS_DIR"] = previousRunsDir;
    rmSync(runsRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
