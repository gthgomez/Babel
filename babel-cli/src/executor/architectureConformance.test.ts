import { kernelVerifierFixture } from '../testinfra/kernelVerifierFixture.js'
/**
 * Harness architecture conformance — executable invariants for harness-v1.
 *
 * Normative: docs/architecture/HARNESS_ARCHITECTURE_V1.md
 * Golden fixtures: examples/golden-harness/
 *
 * Live tests assert currently implemented behavior.
 * Target/audit fixtures are loaded and labeled; they must not silently pass
 * when the architecture only documents a gap.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyToolEffect,
  EXECUTOR_CONTRACT_VERSION,
  EXECUTOR_EVENT_SCHEMA_VERSION,
  EXECUTOR_KERNEL_VERSION,
  modePolicyFor,
  type BabelMode,
} from "./contracts.js";
import { createExecutorKernel } from "./kernel.js";
import { createRuntimeCoordinator } from "../runtime/coordinator.js";
import { createRunControl } from "../runtime/run-control.js";
import {
  evaluateExecuteCompletionHonesty,
  parseStructuredVerifierCommand,
} from "../agent/completionGatePolicy.js";
import {
  analyzeVerifierIdentity,
  classifyVerifierScope,
  satisfiesVerifierRequirement,
} from "../services/verifierIdentity.js";
import {
  buildVerifierPlan,
  reconcileVerifierPlan,
  summarizeVerifierContract,
} from "../services/requiredVerifierContract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const BABEL_CLI = path.resolve(HERE, "../..");
const GOLDEN = path.join(REPO_ROOT, "examples", "golden-harness");

function readJson<T>(relFromRepo: string): T {
  const full = path.join(REPO_ROOT, relFromRepo);
  return JSON.parse(readFileSync(full, "utf8")) as T;
}

// ── Mode policies (H1–H4) ──────────────────────────────────────────────────

test("H1 plan mode policy is read-only", () => {
  assert.equal(modePolicyFor("plan").mutationPolicy, "read_only");
});

test("H1 plan uses plan-artifact completion policy", () => {
  assert.equal(modePolicyFor("plan").completionPolicy, "plan_artifact");
});

test("H3/H4 deep uses governed mutation and proof-carrying completion", () => {
  const deep = modePolicyFor("deep");
  assert.equal(deep.mutationPolicy, "governed");
  assert.equal(deep.completionPolicy, "proof_carrying");
});

test("H3 chat, plan, deep receive fixed distinct mode policies", () => {
  const modes: BabelMode[] = ["chat", "plan", "deep"];
  const policies = Object.fromEntries(modes.map((m) => [m, modePolicyFor(m)]));
  assert.equal(policies.chat!.mutationPolicy, "normal");
  assert.equal(policies.chat!.approvalPolicy, "interactive");
  assert.equal(policies.chat!.completionPolicy, "executor");
  assert.equal(policies.plan!.mutationPolicy, "read_only");
  assert.equal(policies.deep!.mutationPolicy, "governed");
  // Controllers remain distinct
  assert.notDeepEqual(policies.chat, policies.plan);
  assert.notDeepEqual(policies.plan, policies.deep);
});

// ── Proxy/runtime facade (P03) ─────────────────────────────────────────────

test("H19/H20 a stopped submission cannot dispatch or accept a late completion reset", async () => {
  const control = createRunControl({ runId: "conformance", turnId: "existing-turn", generation: 1 });
  control.requestStop({ owner: control.owner, kind: "blocked", source: "executor", reasonCode: "permission_denied" });
  const winner = control.stop();
  assert.equal(control.requestStop({ owner: control.owner, kind: "completed", source: "completion", reasonCode: "completed" }), false);
  const dispatch = await control.dispatchIfRunning({ owner: control.owner, kind: "tool", operationId: "proposed-tool" }, async () => {
    assert.fail("a terminal submission cannot start a new effect");
  });
  assert.equal(dispatch.kind, "not_started");
  assert.equal(control.stop(), winner);
});

test("H21 ending continuation does not certify task correctness", () => {
  const control = createRunControl({ runId: "conformance", turnId: "existing-turn", generation: 1 });
  control.requestStop({ owner: control.owner, kind: "completed", source: "completion", reasonCode: "completed" });
  const decision = createExecutorKernel("chat").completion.decide({
    mode: "chat", requestedOutcome: "VERIFIED_COMPLETE", hasWrite: true,
    verificationPolicy: "strict", requiredVerifierCommands: ["npm test"],
    toolCallLog: [], proof: { compliant: false, errors: ["No independent mutation or verifier evidence"] },
  });
  assert.notEqual(decision.finalOutcome, "VERIFIED_COMPLETE");
  assert.equal(decision.allowed, false);
});

// ── Recovery (P06) ─────────────────────────────────────────────────────────

test("P06 recovery disables automatic resume and never auto-retries ambiguous effects", async () => {
  const { buildRestoreReport } = await import("../runtime/restoreReport.js");
  const report = buildRestoreReport({
    threadId: "thread-1",
    interruptionClass: "process_restart",
    operations: [
      {
        operationId: "op-external",
        effectClass: "external_side_effect",
        effectState: "intent",
        reconciliation: "manual_review",
      },
    ],
  });
  assert.equal(report.automaticResume, false);
  assert.equal(report.operations[0]!.automaticRetryAllowed, false);
  assert.equal(report.operations[0]!.action, "operator_reconciliation_required");
});

test("P03 runtime coordinator keeps controllers distinct behind one facade", () => {
  const coordinator = createRuntimeCoordinator();
  assert.equal(coordinator.capabilities("chat").controller, "chat_engine");
  assert.equal(coordinator.capabilities("plan").controller, "chat_engine");
  assert.equal(coordinator.capabilities("deep").controller, "v9_pipeline");
  assert.equal(
    coordinator.capabilities("deep").submission,
    false,
    "deep must stay explicitly unsupported until the V9 adapter is wired",
  );
  // A shared facade must not collapse mode policy.
  assert.notDeepEqual(modePolicyFor("chat"), modePolicyFor("plan"));
  assert.notDeepEqual(modePolicyFor("plan"), modePolicyFor("deep"));
  assert.equal(modePolicyFor("plan").mutationPolicy, "read_only");
  assert.equal(modePolicyFor("deep").completionPolicy, "proof_carrying");
});

// ── Completion authority (H2, H5, H6) ──────────────────────────────────────

test("H2 plan cannot authorize executor-style VERIFIED_COMPLETE", () => {
  const decision = createExecutorKernel("plan").completion.decide({
    mode: "plan",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "strict",
    toolCallLog: [],
    proof: { compliant: true },
    evidenceRefs: ["e1"],
  });
  assert.equal(decision.finalOutcome, "PLAN_COMPLETE");
  assert.equal(decision.allowed, false);
});

test("H5/H6 failed honesty downgrades VERIFIED_COMPLETE", () => {
  const decision = createExecutorKernel("chat").completion.decide({
    mode: "chat",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "strict",
    lastVerifierReceipt: {
      receiptId: "r-mock-1",
      command: "npm test",
      exitCode: 0,
      authority: true,
      authoritySource: "built_in_runner",
      boundRevision: { fileHashes: {} } as any,
      capturedAt: Date.now(),
      stale: false,
    },
    toolCallLog: [],
    proof: { compliant: false, errors: ["missing mutation evidence"] },
    evidenceRefs: ["r1"],
  });
  assert.equal(decision.finalOutcome, "UNVERIFIED_PATCH");
  assert.equal(decision.allowed, false);
});

test("H6 completion decisions include policy version and evidence refs", () => {
  const decision = createExecutorKernel("chat").completion.decide({
    mode: "chat",
    requestedOutcome: "UNVERIFIED_PATCH",
    hasWrite: true,
    verificationPolicy: "none",
    toolCallLog: [],
    evidenceRefs: ["mutation-1", "receipt-1"],
  });
  assert.equal(decision.policyVersion, EXECUTOR_CONTRACT_VERSION);
  assert.deepEqual(decision.evidenceRefs, ["mutation-1", "receipt-1"]);
});

test("H8 honesty rejects stale verifier receipt", () => {
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: "required",
    lastVerifierReceipt: {
      command: "npm test",
      exit_code: 0,
      summary: "ok",
      stale: true,
      authority: true,
    },
    toolCallLog: [
      { tool: "write_file", target: "src/add.ts" },
      { tool: "run_command", target: "npm test", exit_code: 0 },
    ],
  });
  assert.equal(honesty.allow, false);
  assert.equal(honesty.reason, "verifier_stale");
});

// ── Tool effects (H10) ─────────────────────────────────────────────────────

test("H10 tool effects have deterministic classifications", () => {
  assert.equal(classifyToolEffect("read_file"), "read_only");
  assert.equal(classifyToolEffect("file_read"), "read_only");
  assert.equal(classifyToolEffect("test_run"), "idempotent");
  assert.equal(classifyToolEffect("write_file"), "reconcilable_mutation");
  assert.equal(classifyToolEffect("shell_exec"), "non_idempotent_local_effect");
});

test("H10 unknown tool effects are classified conservatively", () => {
  assert.equal(classifyToolEffect("mcp_request"), "external_side_effect");
  assert.equal(classifyToolEffect("totally_unknown_tool_xyz"), "external_side_effect");
});

// ── Versioning (H15) ───────────────────────────────────────────────────────

test("H15 canonical event and executor versions are explicit", () => {
  assert.equal(EXECUTOR_EVENT_SCHEMA_VERSION, 1);
  assert.equal(EXECUTOR_CONTRACT_VERSION, "executor-contract-v1");
  assert.equal(EXECUTOR_KERNEL_VERSION, "executor-kernel-v1");
});

// ── Structured verifier (identity foundation) ──────────────────────────────

test("structured verifier commands preserve executable and argv", () => {
  const structured = parseStructuredVerifierCommand(
    'pytest "tests/test_a.py::test_case" -q',
    { authoritySource: "project_discovery" },
  );
  assert.ok(structured);
  assert.equal(structured!.executable, "pytest");
  assert.deepEqual(structured!.args, ["tests/test_a.py::test_case", "-q"]);
  assert.equal(structured!.authoritySource, "project_discovery");
});

// ── Documentation authority ────────────────────────────────────────────────

test("canonical harness documents exist", () => {
  const required = [
    "docs/architecture/HARNESS_ARCHITECTURE_V1.md",
    "docs/architecture/HARNESS_OVERVIEW.md",
    "docs/adr/ADR-012-canonical-harness-architecture-v1.md",
    "AGENTS.md",
    "tools/check-harness-architecture.ps1",
  ];
  for (const rel of required) {
    assert.ok(existsSync(path.join(REPO_ROOT, rel)), `missing ${rel}`);
  }
});

test("only HARNESS_ARCHITECTURE_V1 claims normative harness authority", () => {
  const archDir = path.join(REPO_ROOT, "docs", "architecture");
  const mdFiles = readdirSync(archDir).filter((f) => f.endsWith(".md"));
  const normativeClaims: string[] = [];
  for (const file of mdFiles) {
    const text = readFileSync(path.join(archDir, file), "utf8");
    // Match YAML-style or prose claims of primary/normative harness authority
    if (
      /authority:\s*normative/i.test(text) ||
      /single normative specification/i.test(text) ||
      /primary.*canonical harness specification/i.test(text)
    ) {
      if (file !== "HARNESS_ARCHITECTURE_V1.md") {
        // Overview may mention the normative file; only fail if *it* claims authority: normative
        if (/authority:\s*normative/i.test(text) && !/This document is explanatory/i.test(text)) {
          normativeClaims.push(file);
        } else if (
          /single normative specification/i.test(text) &&
          !/normative authority is/i.test(text) &&
          file !== "HARNESS_ARCHITECTURE_V1.md"
        ) {
          normativeClaims.push(file);
        }
      }
    }
  }
  // Spec itself must claim normative
  const v1 = readFileSync(
    path.join(archDir, "HARNESS_ARCHITECTURE_V1.md"),
    "utf8",
  );
  assert.match(v1, /authority:\s*normative/i);
  assert.match(v1, /architecture_version:\s*harness-v1/);
  assert.deepEqual(normativeClaims, []);
});

test("startup documents do not point to missing files", () => {
  const pointers = [
    { file: "AGENTS.md", mustExist: ["docs/architecture/HARNESS_ARCHITECTURE_V1.md"] },
    { file: "babel-cli/PROJECT_CONTEXT.md", mustExist: ["docs/architecture/HARNESS_ARCHITECTURE_V1.md"] },
  ];
  for (const p of pointers) {
    const full = path.join(REPO_ROOT, p.file);
    assert.ok(existsSync(full), `missing startup file ${p.file}`);
    for (const target of p.mustExist) {
      assert.ok(existsSync(path.join(REPO_ROOT, target)), `${p.file} → missing ${target}`);
    }
  }
  const entries = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: REPO_ROOT, encoding: "utf8",
  }).split("\0").filter((entry) => entry && existsSync(path.join(REPO_ROOT, entry)));
  const instructions = entries.filter((entry) =>
    /(^|\/)(AGENTS|CLAUDE|GEMINI|ENGINEERING)\.md$/.test(entry) || /^\.agents\/rules\/.*\.md$/.test(entry),
  );
  assert.deepEqual([...new Set(instructions)], ["AGENTS.md"]);
  const referencePaths = entries.filter((entry) =>
    entry.endsWith(".md") && (entry.startsWith(".agents/") ||
      ["AGENTS.md", "CONTRIBUTING.md", "PROJECT_CONTEXT.md", "STRUCTURE.md", "babel-cli/PROJECT_CONTEXT.md"].includes(entry)),
  );
  for (const entry of referencePaths) {
    const text = readFileSync(path.join(REPO_ROOT, entry), "utf8");
    assert.doesNotMatch(text, /(?:CLAUDE|GEMINI|ENGINEERING)\.md|(?:\.agents\/|\.\.\/)rules\/\d{2}-/,
      `${entry} points to retired contributor guidance`);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]?.split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(path.resolve(REPO_ROOT, path.dirname(entry), target)), `${entry} → missing ${target}`);
    }
  }
});

test("architecture source-map paths resolve", () => {
  const sourceMap = [
    "babel-cli/src/agent/chatEngine.ts",
    "babel-cli/src/agent/completionGatePolicy.ts",
    "babel-cli/src/executor/kernel.ts",
    "babel-cli/src/executor/contracts.ts",
    "babel-cli/src/executor/modeAdapters.ts",
    "babel-cli/src/runtime/coordinator.ts",
    "babel-cli/src/runtime/contracts.ts",
    "babel-cli/src/runtime/events.ts",
    "babel-cli/src/runtime/projection.ts",
    "babel-cli/src/runtime/legacyEventAdapters.ts",
    "babel-cli/src/runtime/recovery.ts",
    "babel-cli/src/runtime/restoreReport.ts",
    "babel-cli/src/runtime/adapters/chat.ts",
    "babel-cli/src/runtime/adapters/plan.ts",
    "babel-cli/src/runtime/adapters/deep.ts",
    "babel-cli/src/interactive/execution/chatCore.ts",
    "babel-cli/src/pipeline.ts",
    "babel-cli/src/sandbox.ts",
    "babel-cli/src/services/requiredVerifierContract.ts",
    "babel-cli/src/schemas/agentContracts.ts",
  ];
  for (const rel of sourceMap) {
    assert.ok(existsSync(path.join(REPO_ROOT, rel)), `source map missing ${rel}`);
  }
});

// ── Golden harness fixtures ────────────────────────────────────────────────

test("golden harness positive fixtures exist and are versioned", () => {
  const files = [
    "task-contract.json",
    "initial-workspace.json",
    "expected-events.jsonl",
    "expected-patch.diff",
    "verifier-receipt.json",
    "final-workspace-revision.json",
    "completion-decision.json",
  ];
  for (const f of files) {
    const full = path.join(GOLDEN, "fixture", f);
    assert.ok(existsSync(full), `missing golden fixture ${f}`);
  }
  const contract = readJson<{ architecture_version: string }>(
    "examples/golden-harness/fixture/task-contract.json",
  );
  assert.equal(contract.architecture_version, "harness-v1");
  const decision = readJson<{
    finalOutcome: string;
    policyVersion: string;
    allowed: boolean;
  }>("examples/golden-harness/fixture/completion-decision.json");
  assert.equal(decision.finalOutcome, "VERIFIED_COMPLETE");
  assert.equal(decision.policyVersion, EXECUTOR_CONTRACT_VERSION);
  assert.equal(decision.allowed, true);

  const eventsPath = path.join(GOLDEN, "fixture", "expected-events.jsonl");
  const lines = readFileSync(eventsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(lines.length >= 10);
  const types = lines.map((l) => (JSON.parse(l) as { eventType: string }).eventType);
  assert.ok(types.includes("TASK_CONTRACT_FROZEN"));
  assert.ok(types.includes("VERIFIED_COMPLETE"));
});

test("golden negative: plan mutation denied aligns with live kernel", () => {
  const fixture = readJson<{ status: string }>(
    "examples/golden-harness/negative/plan-mutation-denied.json",
  );
  assert.equal(fixture.status, "implemented");
  const decision = createExecutorKernel("plan").completion.decide({
    mode: "plan",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "strict",
    toolCallLog: [],
    proof: { compliant: true },
  });
  assert.equal(decision.finalOutcome, "PLAN_COMPLETE");
  assert.equal(decision.allowed, false);
  assert.equal(modePolicyFor("plan").mutationPolicy, "read_only");
});

test("golden negative: stale receipt fixture matches honesty gate + Chat revision recheck", () => {
  const fixture = readJson<{
    status: string;
    implemented?: {
      honestyRejectsStaleFlag: boolean;
      controllerDerivesStalenessFromRevision?: boolean;
    };
    target?: { independentIsolatedVerifierOnChatFinalizeDefault?: boolean };
    live?: {
      systematicRevisionBinding?: boolean;
      independentIsolatedVerifierOptIn?: boolean;
      independentIsolatedVerifierOnChatFinalizeDefault?: boolean;
    };
    receipt: { command: string; exit_code: number; summary: string; stale: boolean };
    expectHonesty: { allow: boolean; reason: string };
  }>("examples/golden-harness/negative/stale-verifier-receipt.json");
  assert.ok(
    fixture.status === "implemented" || fixture.status === "implemented_partial",
  );
  // IMPLEMENTED: honesty reacts to receipt.stale === true
  assert.equal(fixture.implemented?.honestyRejectsStaleFlag, true);
  // IMPLEMENTED: Chat binds boundRevision and rechecks at finalize
  assert.equal(fixture.implemented?.controllerDerivesStalenessFromRevision, true);
  assert.equal(fixture.live?.systematicRevisionBinding, true);
  // IndependentVerifier is opt-in, not default finalize path
  assert.equal(fixture.live?.independentIsolatedVerifierOnChatFinalizeDefault, false);
  assert.equal(fixture.live?.independentIsolatedVerifierOptIn, true);
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: "required",
    lastVerifierReceipt: fixture.receipt,
    toolCallLog: [{ tool: "write_file", target: "src/add.ts" }],
  });
  assert.equal(honesty.allow, fixture.expectHonesty.allow);
  assert.equal(honesty.reason, fixture.expectHonesty.reason);
});

test("golden negative: narrow verifier does not satisfy full-suite requirement", () => {
  const narrow = readJson<{
    status: string;
    required: { displayCommand: string; expectedScope: string; expectedFamily: string };
    actual: { displayCommand: string; expectedScope: string; expectedFamily: string };
    sameFamilyDirectional: {
      required: string;
      targetedActual: string;
      expectFullSatisfiesTargeted: boolean;
      expectTargetedSatisfiesFull: boolean;
    };
    implemented?: {
      structuralIdentity: boolean;
      directionalCoverage: boolean;
      chatHonestyRequiredCommandScope?: boolean;
    };
    expect: { requirementSatisfied: boolean };
  }>("examples/golden-harness/negative/narrow-verifier-vs-broad-required.json");

  assert.equal(narrow.status, "implemented");
  assert.equal(narrow.implemented?.structuralIdentity, true);
  assert.equal(narrow.implemented?.directionalCoverage, true);
  assert.equal(narrow.implemented?.chatHonestyRequiredCommandScope, true);

  assert.equal(classifyVerifierScope(narrow.required.displayCommand), narrow.required.expectedScope);
  assert.equal(classifyVerifierScope(narrow.actual.displayCommand), narrow.actual.expectedScope);
  assert.equal(
    analyzeVerifierIdentity(narrow.required.displayCommand)?.family,
    narrow.required.expectedFamily,
  );
  assert.equal(
    analyzeVerifierIdentity(narrow.actual.displayCommand)?.family,
    narrow.actual.expectedFamily,
  );

  // Cross-family targeted must not satisfy full npm suite.
  assert.equal(
    satisfiesVerifierRequirement(narrow.required.displayCommand, narrow.actual.displayCommand),
    narrow.expect.requirementSatisfied,
  );

  // Directional coverage within same family.
  assert.equal(
    satisfiesVerifierRequirement(
      narrow.sameFamilyDirectional.targetedActual,
      narrow.sameFamilyDirectional.required,
    ),
    narrow.sameFamilyDirectional.expectFullSatisfiesTargeted,
  );
  assert.equal(
    satisfiesVerifierRequirement(
      narrow.sameFamilyDirectional.required,
      narrow.sameFamilyDirectional.targetedActual,
    ),
    narrow.sameFamilyDirectional.expectTargetedSatisfiesFull,
  );

  // Pipeline required-verifier contract: only targeted run → missing required full suite.
  const plan = buildVerifierPlan(`Run ${narrow.required.displayCommand} before completing.`);
  const summary = summarizeVerifierContract(
    reconcileVerifierPlan(plan, [
      {
        step: 1,
        tool: "test_run",
        target: narrow.actual.displayCommand,
        exit_code: 0,
        stdout: "ok",
        stderr: "",
        verified: true,
      },
    ]),
  );
  assert.equal(summary.verifierCompletionSatisfied, false);
  assert.equal(summary.completionBlockingStatus, "REQUIRED_VERIFIER_MISSING");

  // Chat honesty scope: same fixture shape rejects with verifier_scope
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: "strict",
    lastVerifierReceipt: {
      command: narrow.actual.displayCommand,
      exit_code: 0,
      summary: "1 passed",
      authority: true,
    },
    toolCallLog: [],
    requiredVerifierCommands: [narrow.required.displayCommand],
  });
  assert.equal(honesty.allow, false);
  assert.equal(honesty.reason, "verifier_scope");
});

test("golden negative: isolation-unavailable matches live H13 fail-closed decision", async () => {
  const { evaluateGovernedIsolation, setDockerAvailableForTest, resetDockerAvailabilityCache } =
    await import("../config/benchmarkContainer.js");
  const isolation = readJson<{
    status: string;
    targetBehavior: string;
    currentBehavior: string;
    profile: string;
  }>("examples/golden-harness/negative/isolation-unavailable.json");
  assert.equal(isolation.status, "implemented");
  assert.equal(isolation.targetBehavior, "fail_closed_or_explicit_escalation");
  assert.equal(isolation.currentBehavior, "fail_closed_or_explicit_escalation");

  setDockerAvailableForTest(false);
  try {
    const decision = evaluateGovernedIsolation(isolation.profile, "", {});
    assert.equal(decision.kind, "fail_closed");
    const escalated = evaluateGovernedIsolation(isolation.profile, "", {
      BABEL_ALLOW_HOST_FALLBACK: "1",
    } as NodeJS.ProcessEnv);
    assert.equal(escalated.kind, "host_escalated");
  } finally {
    resetDockerAvailabilityCache();
  }
});

test("live kernel rejects coarse golden proof without owned criterion evidence", () => {
  const decision = createExecutorKernel("chat").completion.decide({
    mode: "chat",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "required",
    toolCallLog: [
      { tool: "write_file", target: "src/add.ts" },
      { tool: "run_command", target: "npm test", exit_code: 0 },
    ],
    ...kernelVerifierFixture(),
    proof: { compliant: true },
    evidenceRefs: ["golden-receipt-final", "mutation-batch-2"],
  });
  assert.equal(decision.finalOutcome, "UNVERIFIED_PATCH");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "completion_downgraded:acceptance_unknown");
  assert.equal(decision.policyVersion, EXECUTOR_CONTRACT_VERSION);
});

test("canonical kernel requires coverage for all required verifiers in multi-verifier mode", () => {
  const kernel = createExecutorKernel("chat");
  const executionContext = {
    workspaceRoot: "/fixture",
    taskId: "task",
    contractHash: "contract",
    workingDirectory: "/fixture",
    environmentFingerprint: "environment",
    targetSelectors: [] as string[],
  };
  const verifierOwner = { ...executionContext, sessionId: "session" };
  const greenNpm = {
    receiptId: "r-npm",
    command: "npm test",
    argv: ["npm", "test"],
    exitCode: 0,
    authority: true,
    authoritySource: "built_in_runner" as const,
    boundRevision: {
      gitCommitHash: null,
      compositeTreeHash: "fixture-revision",
      fileHashes: {},
      capturedAt: 1,
    },
    capturedAt: 1,
    stale: false,
    scope: "full_suite" as const,
    tests_total: 1,
    tests_passed: 1,
    tests_failed: 0,
    tests_skipped: 0,
    executionContext,
    order: { sessionId: "session", seq: 1 },
  };
  const requiredVerifiers = [
    {
      command: "npm test",
      executionContext,
      requiredScope: "full_suite" as const,
      greenRequired: true,
    },
    {
      command: "pytest",
      executionContext,
      requiredScope: "full_suite" as const,
      greenRequired: true,
    },
  ];

  const decision = kernel.completion.decide({
    mode: "chat",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "strict",
    requiredVerifierCommands: ["npm test", "pytest"],
    requiredVerifiers,
    verifierOwner,
    executedVerifierLedger: [greenNpm],
    currentWorkspaceRevisionHash: "fixture-revision",
    toolCallLog: [],
    proof: { compliant: true },
  });

  assert.equal(decision.finalOutcome, "UNVERIFIED_PATCH");
  assert.match(decision.reason, /verifier_scope|verifier_missing/);
});

// ── Source ownership and audit reconciliation (W14) ────────────────────────

interface OwnershipComponent {
  id: string;
  responsibility: string;
  paths: string[];
}

interface OwnershipManifest {
  schemaVersion: number;
  components: OwnershipComponent[];
}

interface ReconciliationWorkstream {
  id: string;
  issue: string;
  scope: string;
  findingCount: number;
  dispositionFile: string;
}

interface ReconciliationManifest {
  schemaVersion: number;
  register: { path: string; ownerIssue: string; disposition: string };
  statusVocabulary: string[];
  requiredEvidence: Record<string, string[]>;
  workstreams: ReconciliationWorkstream[];
}

const OWNERSHIP_PATH = "config/architecture-ownership.json";
const RECONCILIATION_PATH = "config/audit-reconciliation.json";
const CAMPAIGN_DOCS = "docs/campaigns/babel-reliability-2026-11";
const DISPOSITION_HEADER = [
  "finding_id",
  "stream",
  "disposition",
  "head_sha",
  "evidence",
  "reviewed_head_sha",
  "branch",
  "commit_sha",
  "merged_sha",
  "artifact_kind",
  "artifact_digest",
  "test_evidence",
  "closed_on",
] as const;

function topLevelSourceEntries(): string[] {
  const srcDir = path.join(BABEL_CLI, "src");
  const entries: string[] = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const rel = `babel-cli/src/${entry.name}`;
    if (entry.isDirectory()) {
      entries.push(rel);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|js|mjs)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|js|mjs)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    entries.push(rel);
  }
  return entries.sort();
}

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSourceFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Minimal RFC 4180 parser for the disposition/register ledgers (no embedded newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

test("source trees do not ship a legacy .js twin for a TypeScript module", () => {
  const srcDir = path.join(BABEL_CLI, "src");
  const shadowed: string[] = [];
  for (const file of walkSourceFiles(srcDir)) {
    if (!file.endsWith(".js")) continue;
    const tsTwin = `${file.slice(0, -3)}.ts`;
    if (existsSync(tsTwin)) {
      shadowed.push(path.relative(REPO_ROOT, file).replace(/\\/g, "/"));
    }
  }
  assert.deepEqual(
    shadowed.sort(),
    [],
    "remove legacy .js twins; TypeScript is the only compiled source (see docs/architecture/SOURCE_OWNERSHIP.md)",
  );
});

test("architecture ownership assigns every top-level source entry exactly once", () => {
  const manifest = readJson<OwnershipManifest>(OWNERSHIP_PATH);
  assert.equal(manifest.schemaVersion, 1);
  const seen = new Map<string, string>();
  const ids = new Set<string>();
  for (const component of manifest.components) {
    assert.ok(component.responsibility.trim().length > 0, `${component.id} lacks a responsibility`);
    assert.ok(!ids.has(component.id), `duplicate ownership component ${component.id}`);
    ids.add(component.id);
    assert.ok(component.paths.length > 0, `${component.id} has no paths`);
    for (const rel of component.paths) {
      assert.ok(existsSync(path.join(REPO_ROOT, rel)), `${component.id} lists missing path ${rel}`);
      const prior = seen.get(rel);
      assert.equal(prior, undefined, `${rel} is owned twice (${prior} and ${component.id})`);
      seen.set(rel, component.id);
    }
  }
  const unowned = topLevelSourceEntries().filter((rel) => !seen.has(rel));
  assert.deepEqual(unowned, [], "top-level source entries without an ownership component");
});

test("audit reconciliation declares all fourteen workstreams exactly once", () => {
  const manifest = readJson<ReconciliationManifest>(RECONCILIATION_PATH);
  assert.equal(manifest.schemaVersion, 1);
  const expected = Array.from({ length: 14 }, (_, i) => `W${String(i + 1).padStart(2, "0")}`);
  assert.deepEqual(manifest.workstreams.map((w) => w.id), expected);
  const issues = new Set<string>();
  const files = new Set<string>();
  for (const workstream of manifest.workstreams) {
    assert.match(workstream.issue, /^#\d+$/, `${workstream.id} issue must be a GitHub reference`);
    assert.ok(!issues.has(workstream.issue), `duplicate issue ${workstream.issue}`);
    issues.add(workstream.issue);
    assert.ok(workstream.scope.trim().length > 0, `${workstream.id} lacks a scope`);
    assert.ok(Number.isInteger(workstream.findingCount) && workstream.findingCount >= 0);
    assert.match(
      workstream.dispositionFile,
      new RegExp(`^${CAMPAIGN_DOCS}/dispositions/${workstream.id}\\.csv$`),
    );
    assert.ok(!files.has(workstream.dispositionFile), `duplicate disposition file ${workstream.dispositionFile}`);
    files.add(workstream.dispositionFile);
  }
  assert.equal(
    manifest.workstreams.reduce((sum, workstream) => sum + workstream.findingCount, 0),
    100,
    "workstream finding counts must add up to the 100-item register",
  );
});

test("audit reconciliation vocabulary separates merged code from qualified artifacts", () => {
  const manifest = readJson<ReconciliationManifest>(RECONCILIATION_PATH);
  assert.deepEqual(manifest.statusVocabulary, [
    "audited",
    "reproduced_on_head",
    "historical",
    "disproven",
    "coded",
    "reviewed",
    "merged",
    "package_qualified",
    "closed",
  ]);
  const merged = manifest.requiredEvidence.merged ?? [];
  const qualified = manifest.requiredEvidence.package_qualified ?? [];
  const closed = manifest.requiredEvidence.closed ?? [];
  assert.ok(!merged.includes("artifact_digest"), "merged must not imply an artifact was qualified");
  assert.ok(qualified.includes("artifact_digest"));
  assert.ok(qualified.includes("artifact_kind"));
  assert.ok(closed.includes("artifact_digest"));
  assert.ok(closed.includes("test_evidence"));
  for (const status of manifest.statusVocabulary) {
    assert.ok(Array.isArray(manifest.requiredEvidence[status]), `missing evidence rules for ${status}`);
  }
  const doc = readFileSync(path.join(REPO_ROOT, "docs/architecture/AUDIT_RECONCILIATION.md"), "utf8");
  for (const status of manifest.statusVocabulary) {
    assert.ok(doc.includes(`\`${status}\``), `AUDIT_RECONCILIATION.md must define ${status}`);
  }
  assert.ok(doc.includes("FINDINGS_INDEX.csv"), "reconciliation doc must point at the canonical register");
  assert.ok(doc.includes("AGENTS.md"), "reconciliation doc must defer contributor policy to AGENTS.md");
});

test("ownership doc references the manifest and the hot-path boundaries", () => {
  const doc = readFileSync(path.join(REPO_ROOT, "docs/architecture/SOURCE_OWNERSHIP.md"), "utf8");
  assert.ok(doc.includes(OWNERSHIP_PATH));
  for (const hotPath of [
    "babel-cli/src/agent/chatEngine.ts",
    "babel-cli/src/pipeline.ts",
    "babel-cli/src/executor/kernel.ts",
    "babel-cli/src/ui/waterfall.ts",
  ]) {
    assert.ok(doc.includes(hotPath), `SOURCE_OWNERSHIP.md must name ${hotPath}`);
  }
});

test("W14 disposition ledger uses the shared vocabulary and evidence rules", () => {
  const manifest = readJson<ReconciliationManifest>(RECONCILIATION_PATH);
  const w14 = manifest.workstreams.find((workstream) => workstream.id === "W14");
  assert.ok(w14, "W14 must be declared");
  const rows = parseCsv(readFileSync(path.join(REPO_ROOT, w14.dispositionFile), "utf8"));
  assert.deepEqual(rows[0], [...DISPOSITION_HEADER], "disposition ledger header drifted");
  const records = rows.slice(1).map((values) =>
    Object.fromEntries(DISPOSITION_HEADER.map((header, index) => [header, values[index] ?? ""])),
  );
  assert.ok(records.length > 0, "W14 must record its five assigned findings");
  for (const record of records) {
    assert.match(record.finding_id!, /^AR-0[1-5]$/);
    assert.equal(record.stream, "W14");
    assert.ok(manifest.statusVocabulary.includes(record.disposition!),
      `${record.finding_id} has unknown disposition ${record.disposition}`);
    for (const field of manifest.requiredEvidence[record.disposition!] ?? []) {
      assert.ok(record[field]?.trim().length, `${record.finding_id} (${record.disposition}) missing ${field}`);
    }
  }
  const ids = records.map((record) => record.finding_id).sort();
  assert.deepEqual(ids, ["AR-01", "AR-02", "AR-03", "AR-04", "AR-05"]);
});

test("proposed finding register assigns all 100 IDs to declared workstreams", (t) => {
  const manifest = readJson<ReconciliationManifest>(RECONCILIATION_PATH);
  const registerPath = path.join(REPO_ROOT, manifest.register.path);
  if (!existsSync(registerPath)) {
    t.skip(`register not present at ${manifest.register.path} (proposed PR #536)`);
    return;
  }
  const rows = parseCsv(readFileSync(registerPath, "utf8"));
  const header = rows[0]!;
  const idColumn = header.indexOf("ID");
  const ownerColumn = header.indexOf("Primary workstream");
  assert.ok(idColumn >= 0 && ownerColumn >= 0, "register header must expose ID and Primary workstream");
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const row of rows.slice(1)) {
    const id = row[idColumn]!;
    const owner = row[ownerColumn]!;
    assert.ok(!ids.has(id), `duplicate register ID ${id}`);
    ids.add(id);
    const workstream = manifest.workstreams.find((candidate) => candidate.id === owner);
    assert.ok(workstream, `${id} assigned to undeclared workstream ${owner}`);
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  assert.equal(ids.size, 100, "register must keep 100 unique IDs");
  for (const workstream of manifest.workstreams) {
    assert.equal(
      counts.get(workstream.id) ?? 0,
      workstream.findingCount,
      `${workstream.id} count disagrees with the reconciliation manifest`,
    );
  }
});
