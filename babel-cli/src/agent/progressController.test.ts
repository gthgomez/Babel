import { describe, it } from "node:test";
import * as assert from "node:assert";
import { ProgressController } from "./progressController.js";

describe("ProgressController", () => {
  it("should start at none and accumulate strikes to escalate levels", () => {
    const pc = new ProgressController();

    let res = pc.scoreTurn([], false, 0);
    assert.strictEqual(res.intervention, "none");
    assert.strictEqual(res.transitioned, false);

    // Strike 2
    res = pc.scoreTurn([], false, 0);
    assert.strictEqual(res.intervention, "none");

    // Strike 3 -> nudge
    res = pc.scoreTurn([], false, 0);
    assert.strictEqual(res.intervention, "nudge");
    assert.strictEqual(res.transitioned, true);

    // Strike 4
    res = pc.scoreTurn([], false, 0);
    assert.strictEqual(res.intervention, "nudge");
    assert.strictEqual(res.transitioned, false);

    // Strike 5, 6 -> restricted_tools
    res = pc.scoreTurn([], false, 0);
    res = pc.scoreTurn([], false, 0);
    assert.strictEqual(res.intervention, "restricted_tools");
    assert.strictEqual(res.transitioned, true);

    // 7,8,9 -> last_chance_repair
    pc.scoreTurn([], false, 0);
    pc.scoreTurn([], false, 0);
    res = pc.scoreTurn([], false, 0);
    assert.strictEqual(res.intervention, "last_chance_repair");

    // 10,11,12 -> terminal_blocked
    pc.scoreTurn([], false, 0);
    pc.scoreTurn([], false, 0);
    res = pc.scoreTurn([], false, 0);
    assert.strictEqual(res.intervention, "terminal_blocked");
  });

  it("should reduce strikes and recover when progress signals are seen", () => {
    const pc = new ProgressController();
    // 3 strikes -> nudge
    pc.scoreTurn([], false, 0);
    pc.scoreTurn([], false, 0);
    let res = pc.scoreTurn([], false, 0);
    assert.strictEqual(res.intervention, "nudge");

    // recovery
    res = pc.scoreTurn(["production_mutation"], false, 0);
    assert.strictEqual(res.intervention, "none"); // strikes reduced by 2 (3-2 = 1) -> none
    assert.strictEqual(res.transitioned, true);
    assert.strictEqual(res.score, 10);
  });

  it("should soften text-only and gate-strike penalties if there is sufficient prior progress score", () => {
    const pc = new ProgressController();

    // give it some score first
    pc.scoreTurn(["production_mutation"], false, 0); // score 10
    pc.scoreTurn(["new_error_signature"], false, 0); // score 15

    // now text-only turn should have softened penalty
    // normal text-only penalty = 1 (base) + 2 (textOnly) = 3
    // softened = max(0, 3 - 1) = 2
    // strike count before = 0
    let res = pc.scoreTurn([], true, 0); // strike 2 -> none
    assert.strictEqual(res.intervention, "none");

    // normal gate-strike penalty = 1 (base) + 2 (gateStrikes) = 3
    // softened = max(0, 3 - 1) = 2
    // total strikes = 2 + 2 = 4 -> nudge
    res = pc.scoreTurn([], false, 2);
    assert.strictEqual(res.intervention, "nudge");
  });

  it("scores correctly for all signal types", () => {
    const pc = new ProgressController();

    let res = pc.scoreTurn(["production_mutation"], false, 0);
    assert.strictEqual(res.score, 10);

    res = pc.scoreTurn(["new_error_signature"], false, 0);
    assert.strictEqual(res.score, 15);

    res = pc.scoreTurn(["reduced_failing_tests"], false, 0);
    assert.strictEqual(res.score, 30);

    res = pc.scoreTurn(["verifier_advanced"], false, 0);
    assert.strictEqual(res.score, 40);

    res = pc.scoreTurn(["env_blocker_resolved"], false, 0);
    assert.strictEqual(res.score, 60);
  });
  // ── Acceptance Tests T9–T12: Capability Degradation & Quiet Recovery ────

  it("T9: Transient shell failure marks capability SUSPECT without disabling tool family", () => {
    const pc = new ProgressController();
    const res = pc.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "npm test",
      exitCode: 1,
    });
    assert.strictEqual(res.capability, "shell.execution");
    assert.strictEqual(res.state, "SUSPECT");
    assert.strictEqual(pc.getCapabilityState("shell.execution"), "SUSPECT");
    assert.strictEqual(pc.getDegradedCapabilities().length, 0);
  });

  it("T10: Repeated recursive enumeration failure marks capability DEGRADED and suggests filesystem alternative", () => {
    const pc = new ProgressController();
    // First failure -> SUSPECT
    let res = pc.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "Get-ChildItem -Recurse",
      exitCode: 1,
    });
    assert.strictEqual(res.capability, "shell.recursive_enumeration");
    assert.strictEqual(res.state, "SUSPECT");

    // Second failure -> DEGRADED with notice
    res = pc.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "Get-ChildItem -Recurse",
      exitCode: 1,
    });
    assert.strictEqual(res.capability, "shell.recursive_enumeration");
    assert.strictEqual(res.state, "DEGRADED");
    assert.ok(res.notice?.includes("filesystem tools"));

    const degraded = pc.getDegradedCapabilities();
    assert.strictEqual(degraded.length, 1);
    assert.strictEqual(degraded[0]?.capability, "shell.recursive_enumeration");
    assert.strictEqual(degraded[0]?.preferredAlternative, "list_dir / directory_list tool");
  });

  it("T11: Recovery or explicit success restores capability to AVAILABLE", () => {
    const pc = new ProgressController();
    pc.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "Get-ChildItem -Recurse",
      exitCode: 1,
    });
    pc.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "Get-ChildItem -Recurse",
      exitCode: 1,
    });
    assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "DEGRADED");

    pc.recordSuccess("shell.recursive_enumeration");
    assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "AVAILABLE");
    assert.strictEqual(pc.getDegradedCapabilities().length, 0);
  });

  it("T12: Snapshot and restore preserve capability health state", () => {
    const pc1 = new ProgressController();
    pc1.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "dir /s",
      exitCode: 1,
    });
    pc1.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "dir /s",
      exitCode: 1,
    });
    const snap = pc1.snapshot();

    const pc2 = new ProgressController();
    pc2.restore(snap);
    assert.strictEqual(pc2.getCapabilityState("shell.recursive_enumeration"), "DEGRADED");
  });

  it("T12b: Canonical tool names (run_command, test_run) trigger capability degradation with list_dir alternative", () => {
    const pc = new ProgressController();
    const f1 = pc.recordFailure({
      tool: "run_command",
      commandSnippet: "Get-ChildItem -Recurse",
      exitCode: 1,
    });
    assert.strictEqual(f1.capability, "shell.recursive_enumeration");
    assert.strictEqual(f1.state, "SUSPECT");

    const f2 = pc.recordFailure({
      tool: "test_run",
      commandSnippet: "dir /s",
      exitCode: 1,
    });
    assert.strictEqual(f2.capability, "shell.recursive_enumeration");
    assert.strictEqual(f2.state, "DEGRADED");
    assert.ok(f2.notice?.includes("list_dir") || f2.notice?.includes("filesystem"));
    assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "DEGRADED");
  });

  it("T13: classifyShellCapability differentiates recursive from non-recursive commands safely", async () => {
    const { classifyShellCapability } = await import("./progressController.js");

    // Non-recursive Get-ChildItem must NOT be classified as recursive enumeration
    const nonRecGci = classifyShellCapability("run_command", "Get-ChildItem -Path ./src");
    assert.strictEqual(nonRecGci.isRecursiveEnum, false);
    assert.strictEqual(nonRecGci.capability, "shell.execution");

    // Recursive Get-ChildItem with -Recurse must be classified as recursive enumeration
    const recGci = classifyShellCapability("run_command", "Get-ChildItem -Path . -Recurse");
    assert.strictEqual(recGci.isRecursiveEnum, true);
    assert.strictEqual(recGci.capability, "shell.recursive_enumeration");

    // POSIX ls -r (lowercase: reverse sort) must NOT be classified as recursive enumeration
    const lsReverse = classifyShellCapability("run_command", "ls -r");
    assert.strictEqual(lsReverse.isRecursiveEnum, false);
    assert.strictEqual(lsReverse.capability, "shell.execution");

    // POSIX ls -R (uppercase: recursive) must be classified as recursive enumeration
    const lsRec = classifyShellCapability("run_command", "ls -lR ./src");
    assert.strictEqual(lsRec.isRecursiveEnum, true);
    assert.strictEqual(lsRec.capability, "shell.recursive_enumeration");

    // Windows dir /s must be classified as recursive enumeration
    const dirS = classifyShellCapability("run_command", "dir /s");
    assert.strictEqual(dirS.isRecursiveEnum, true);
    assert.strictEqual(dirS.capability, "shell.recursive_enumeration");

    // Non-shell tool must not be shell
    const nonShell = classifyShellCapability("read_file", "foo.txt");
    assert.strictEqual(nonShell.isShellTool, false);
    assert.strictEqual(nonShell.isRecursiveEnum, false);
  });
});

describe("ConversationalRenderer - ProgressRecovery", () => {
  it("renders nudge, restriction, repair, blocked, and ENV_BLOCKED states", async () => {
    const { ConversationalRenderer } = await import("../ui/waterfall.js");
    const renderer = new ConversationalRenderer({ isTTY: true });

    renderer.onProgressRecovery("nudge", "test", 5, "nudge hint");
    renderer.onProgressRecovery(
      "restricted_tools",
      "test",
      5,
      "restriction hint",
    );
    renderer.onProgressRecovery("last_chance_repair", "test", 5, "repair hint");
    renderer.onProgressRecovery("terminal_blocked", "test", 5, "blocked hint");
    renderer.onProgressRecovery("terminal_blocked", "test", 5, "ENV_BLOCKED");

    assert.ok(true);
  });
});
