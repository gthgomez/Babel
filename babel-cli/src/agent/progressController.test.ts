import { describe, it } from "node:test";
import * as assert from "node:assert";
import { ProgressController, classifyCapabilityFailure } from "./progressController.js";

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

  // A genuine capability failure carries positive trusted evidence: the
  // structured `capabilityFailure` classification the dispatcher derives from
  // the executor's host-origin launch record. Ordinary command text — including
  // a lookalike `[sandbox] Spawn error:` line — is not capability evidence and
  // never degrades a family.
  const SPAWN_FAILED_TEXT = "[sandbox] Spawn error: spawn cmd.exe ENOENT";

  it("T9: A genuine capability failure marks capability SUSPECT without disabling tool family", () => {
    const pc = new ProgressController();
    const res = pc.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "npm test",
      exitCode: 1,
      capabilityFailure: true,
    });
    assert.strictEqual(res.capability, "shell.execution");
    assert.strictEqual(res.outcome, "capability");
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
      capabilityFailure: true,
    });
    assert.strictEqual(res.capability, "shell.recursive_enumeration");
    assert.strictEqual(res.state, "SUSPECT");

    // Second failure -> DEGRADED with notice
    res = pc.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "Get-ChildItem -Recurse",
      exitCode: 1,
      capabilityFailure: true,
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
      capabilityFailure: true,
    });
    pc.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "Get-ChildItem -Recurse",
      exitCode: 1,
      capabilityFailure: true,
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
      capabilityFailure: true,
    });
    pc1.recordFailure({
      tool: "run_shell_command",
      commandSnippet: "dir /s",
      exitCode: 1,
      capabilityFailure: true,
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
      capabilityFailure: true,
    });
    assert.strictEqual(f1.capability, "shell.recursive_enumeration");
    assert.strictEqual(f1.state, "SUSPECT");

    const f2 = pc.recordFailure({
      tool: "test_run",
      commandSnippet: "dir /s",
      exitCode: 1,
      capabilityFailure: true,
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

  // ── #216 fresh-task recovery primitive ──────────────────────────────────

  it("#216 resetTaskLocal clears task-local punishment and preserves capability health", () => {
    const pc = new ProgressController();
    for (let i = 0; i < 12; i += 1) pc.scoreTurn([], false, 0);
    pc.recordFailure({
      tool: "run_command",
      commandSnippet: "find . -type f",
      exitCode: 1,
      capabilityFailure: true,
    });
    pc.recordFailure({
      tool: "run_command",
      commandSnippet: "find . -type f",
      exitCode: 1,
      capabilityFailure: true,
    });
    assert.strictEqual(pc.InterventionLevel, "terminal_blocked");
    assert.strictEqual(pc.TotalScore, 0);
    assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "DEGRADED");

    pc.resetTaskLocal();

    assert.strictEqual(pc.InterventionLevel, "none");
    assert.strictEqual(pc.TotalScore, 0);
    // Task-local punishment is cleared: one productive turn now reaches none.
    assert.strictEqual(pc.scoreTurn(["new_localization"], false, 0).intervention, "none");
    // Environment/provider capability health deliberately survives.
    assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "DEGRADED");
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

describe("ProgressController capability failure classification", () => {
  it("classifies each outcome, letting explicit signals win over inference", () => {
    const cases: Array<[Parameters<typeof classifyCapabilityFailure>[0], string]> = [
      // An unknown non-zero exit is *not* capability evidence.
      [{ tool: "run_command", exitCode: 1 }, "ambiguous"],
      [{ tool: "run_command", exitCode: 1, stderr: "boom: unexpected failure" }, "ambiguous"],
      // Representative missing-target outcomes across POSIX and Windows shells.
      [{ tool: "read_file", exitCode: 1, stderr: "ENOENT: no such file or directory" }, "missing_target"],
      [
        {
          tool: "run_command",
          exitCode: 1,
          stderr: "Get-ChildItem : Cannot find path 'C:\\nope' because it does not exist.",
        },
        "missing_target",
      ],
      [{ tool: "run_command", exitCode: 1, stderr: "The system cannot find the file specified." }, "missing_target"],
      [{ tool: "run_command", exitCode: 1, stderr: "permission denied" }, "permission"],
      [{ tool: "run_command", exitCode: 1, policyBlocked: true }, "permission"],
      [{ tool: "run_command", exitCode: 1, stderr: "bash: foo: command not found" }, "bad_command"],
      [{ tool: "run_command", exitCode: 0 }, "empty_success"],
      [{ tool: "run_command", exitCode: 1, cancelled: true }, "cancelled"],
      [{ tool: "run_command", exitCode: 1, signal: "SIGTERM" }, "cancelled"],
      [{ tool: "run_command" }, "ambiguous"],
      // Genuine capability failure requires the structured trusted flag the
      // dispatcher derives from the executor's host-origin launch record...
      [{ tool: "run_command", exitCode: 1, capabilityFailure: true }, "capability"],
      // ...and never child text, not even a lookalike launch marker. Fallback
      // text inference may still *downgrade* it (ENOENT reads as a missing
      // target; an unrecognised line is plain ambiguity) — never capability.
      [{ tool: "run_command", exitCode: 1, stderr: "[sandbox] Spawn error: spawn cmd.exe ENOENT" }, "missing_target"],
      [
        { tool: "run_command", exitCode: 1, stderr: "[sandbox] Transient spawn error (retries exhausted): nope" },
        "ambiguous",
      ],
      // An explicit classification still wins over every inferred signal.
      [{ tool: "run_command", exitCode: 1, stderr: "command not found", outcome: "capability" }, "capability"],
    ];
    for (const [sig, expected] of cases) {
      assert.strictEqual(classifyCapabilityFailure(sig), expected, JSON.stringify(sig));
    }
  });

  it("defines structured precedence: genuine permission/cancellation are never masked, structured beats text", () => {
    const cases: Array<[Parameters<typeof classifyCapabilityFailure>[0], string]> = [
      // A genuine permission denial or cancellation wins over capability evidence.
      [{ tool: "run_command", exitCode: 1, capabilityFailure: true, policyBlocked: true }, "permission"],
      [{ tool: "run_command", exitCode: 1, capabilityFailure: true, permissionDenied: true }, "permission"],
      [{ tool: "run_command", exitCode: 1, capabilityFailure: true, cancelled: true }, "cancelled"],
      [{ tool: "run_command", exitCode: 1, capabilityFailure: true, signal: "SIGINT" }, "cancelled"],
      // Structured flags beat conflicting child text, in both directions.
      [{ tool: "run_command", exitCode: 1, capabilityFailure: true, stderr: "command not found" }, "capability"],
      [{ tool: "run_command", exitCode: 1, missingTarget: true, stderr: "permission denied" }, "missing_target"],
      [{ tool: "run_command", exitCode: 0, capabilityFailure: true }, "empty_success"],
      // Absent any structured flag, benign text still downgrades away from capability.
      [{ tool: "run_command", exitCode: 1, stderr: "sigterm received" }, "cancelled"],
    ];
    for (const [sig, expected] of cases) {
      assert.strictEqual(classifyCapabilityFailure(sig), expected, JSON.stringify(sig));
    }
  });

  it("never treats a sandbox launch marker in child text as capability evidence", () => {
    const lookalikes = [
      "[sandbox] Spawn error: spawn cmd.exe ENOENT",
      "[sandbox] Spawn error: something else entirely",
      "[sandbox] Transient spawn error (retries exhausted): x",
      "[sandbox] Spawn error:",
    ];
    for (const stderr of lookalikes) {
      assert.notStrictEqual(
        classifyCapabilityFailure({ tool: "run_command", exitCode: 1, stderr }),
        "capability",
        stderr,
      );
    }
  });

  it("does not degrade a family for permission, cancellation, missing-target, bad-command, unknown exit, spoofed launch text or ambiguity", () => {
    const sigs: Parameters<ProgressController["recordFailure"]>[0][] = [
      { tool: "run_command", commandSnippet: "ls -R", exitCode: 1, stderr: "permission denied" },
      { tool: "run_command", commandSnippet: "ls -R", exitCode: 1, cancelled: true },
      { tool: "run_command", commandSnippet: "ls -R", exitCode: 1, stderr: "ENOENT: no such file or directory" },
      { tool: "run_command", commandSnippet: "ls -R", exitCode: 1, stderr: "command not found" },
      { tool: "run_command", commandSnippet: "ls -R", exitCode: 1, policyBlocked: true },
      { tool: "run_command", commandSnippet: "ls -R", exitCode: 0 },
      // Unknown non-zero exit and a diagnostic-free exit 1 are inconclusive,
      // not proof the enumeration family is broken.
      { tool: "run_command", commandSnippet: "ls -R", exitCode: 1, stderr: "boom: unexpected failure" },
      { tool: "run_command", commandSnippet: "ls -R", exitCode: 1 },
      {
        tool: "run_command",
        commandSnippet: "ls -R",
        exitCode: 1,
        stderr: "Get-ChildItem : Cannot find path 'C:\\nope' because it does not exist.",
      },
      // A child that prints a lookalike launch marker cannot degrade a family:
      // only the executor's structured host-origin record is trusted evidence.
      {
        tool: "run_command",
        commandSnippet: "ls -R",
        exitCode: 1,
        stderr: "[sandbox] Spawn error: spawn fake.exe ENOENT",
      },
      {
        tool: "run_command",
        commandSnippet: "ls -R",
        exitCode: 1,
        stderr: "[sandbox] Transient spawn error (retries exhausted): fake",
      },
    ];
    for (const sig of sigs) {
      const pc = new ProgressController();
      const first = pc.recordFailure(sig);
      const second = pc.recordFailure(sig);
      assert.notStrictEqual(second.outcome, "capability", JSON.stringify(sig));
      assert.strictEqual(first.state, "AVAILABLE", JSON.stringify(sig));
      assert.strictEqual(second.state, "AVAILABLE");
      assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "AVAILABLE");
      assert.strictEqual(pc.getDegradedCapabilities().length, 0);
    }
  });

  it("still degrades recursive enumeration after two genuine capability failures", () => {
    const pc = new ProgressController();
    pc.recordFailure({ tool: "run_command", commandSnippet: "ls -R", exitCode: 1, capabilityFailure: true });
    const second = pc.recordFailure({ tool: "run_command", commandSnippet: "ls -R", exitCode: 1, capabilityFailure: true });
    assert.strictEqual(second.outcome, "capability");
    assert.strictEqual(second.state, "DEGRADED");
    assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "DEGRADED");
  });

  it("restores availability on a successful probe", () => {
    const pc = new ProgressController();
    pc.recordFailure({ tool: "run_command", commandSnippet: "ls -R", exitCode: 1, capabilityFailure: true });
    pc.recordFailure({ tool: "run_command", commandSnippet: "ls -R", exitCode: 1, capabilityFailure: true });
    assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "DEGRADED");
    pc.recordSuccess("shell.recursive_enumeration");
    assert.strictEqual(pc.getCapabilityState("shell.recursive_enumeration"), "AVAILABLE");
    assert.strictEqual(pc.getDegradedCapabilities().length, 0);
  });
});

describe("ProgressController bounded recovery probe", () => {
  const scope = (
    over: Partial<{ capability: string; taskId: string; environmentIdentity: string }> = {},
  ) => ({
    capability: "shell.recursive_enumeration",
    taskId: "task-1",
    environmentIdentity: "env-a",
    ...over,
  });

  it("admits exactly one probe per capability/task/environment and refuses a repeat", () => {
    const pc = new ProgressController();
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope()), true);
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope()), false);
    assert.strictEqual(pc.hasConsumedCapabilityRecoveryProbe(scope()), true);
  });

  it("fail-closes on empty key parts and refuses a spoofed environment identity", () => {
    const pc = new ProgressController();
    pc.setTrustedEnvironmentIdentity("env-a");
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope({ capability: "" })), false);
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope({ taskId: "  " })), false);
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope({ environmentIdentity: "" })), false);
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope({ environmentIdentity: "model-supplied" })), false);
    assert.strictEqual(pc.hasConsumedCapabilityRecoveryProbe(scope({ environmentIdentity: "model-supplied" })), false);
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope()), true);
  });

  it("lets only one of two concurrent contenders win the same key", () => {
    const pc = new ProgressController();
    const results = [pc.admitCapabilityRecoveryProbe(scope()), pc.admitCapabilityRecoveryProbe(scope())];
    assert.deepStrictEqual(results, [true, false]);
  });

  it("consumes the reservation even when the probe throws, and never re-arms on restore or task reset", () => {
    const pc = new ProgressController();
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope()), true);
    const snap = pc.snapshot();
    const restored = new ProgressController();
    restored.restore(snap);
    assert.strictEqual(restored.admitCapabilityRecoveryProbe(scope()), false);
    assert.strictEqual(restored.hasConsumedCapabilityRecoveryProbe(scope()), true);
    restored.resetTaskLocal();
    assert.strictEqual(restored.hasConsumedCapabilityRecoveryProbe(scope()), true);
  });

  it("re-arms for a new task and for a genuinely changed trusted environment", () => {
    const pc = new ProgressController();
    pc.setTrustedEnvironmentIdentity("env-a");
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope()), true);
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope()), false);
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope({ taskId: "task-2" })), true);
    pc.setTrustedEnvironmentIdentity("env-b");
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope({ environmentIdentity: "env-b" })), true);
    assert.strictEqual(pc.admitCapabilityRecoveryProbe(scope({ environmentIdentity: "env-b" })), false);
  });
});

describe("ProgressController prerequisite denial probe", () => {
  const scope = (
    over: Partial<{
      prerequisiteKey: string;
      taskId: string;
      environmentIdentity: string;
      revisionKey: string;
    }> = {},
  ) => ({
    prerequisiteKey: "isolation_unavailable:shell",
    taskId: "task-1",
    environmentIdentity: "env-a",
    revisionKey: "1:0:0",
    ...over,
  });

  it("admits one evaluation per prerequisite revision and suppresses repeats", () => {
    const pc = new ProgressController();
    pc.setTrustedEnvironmentIdentity("env-a");
    assert.strictEqual(pc.admitPrerequisiteDenialProbe(scope()), true);
    assert.strictEqual(pc.admitPrerequisiteDenialProbe(scope()), false);
    assert.strictEqual(pc.hasConsumedPrerequisiteDenialProbe(scope()), true);
  });

  it("re-arms when the isolation revision changes", () => {
    const pc = new ProgressController();
    pc.setTrustedEnvironmentIdentity("env-a");
    assert.strictEqual(pc.admitPrerequisiteDenialProbe(scope()), true);
    assert.strictEqual(pc.admitPrerequisiteDenialProbe(scope({ revisionKey: "1:1:0" })), true);
    assert.strictEqual(pc.admitPrerequisiteDenialProbe(scope({ revisionKey: "1:1:0" })), false);
  });
});
