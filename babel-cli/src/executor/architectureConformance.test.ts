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
import {
  evaluateExecuteCompletionHonesty,
  parseStructuredVerifierCommand,
} from "../agent/completionGatePolicy.js";

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
    lastVerifierReceipt: { command: "npm test", exit_code: 0, summary: "ok" },
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
    "babel-cli/CLAUDE.md",
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
    { file: "CLAUDE.md", mustExist: ["docs/architecture/HARNESS_ARCHITECTURE_V1.md"] },
    { file: "babel-cli/CLAUDE.md", mustExist: ["docs/architecture/HARNESS_ARCHITECTURE_V1.md"] },
    { file: "babel-cli/PROJECT_CONTEXT.md", mustExist: ["docs/architecture/HARNESS_ARCHITECTURE_V1.md"] },
  ];
  for (const p of pointers) {
    const full = path.join(REPO_ROOT, p.file);
    assert.ok(existsSync(full), `missing startup file ${p.file}`);
    for (const target of p.mustExist) {
      assert.ok(existsSync(path.join(REPO_ROOT, target)), `${p.file} → missing ${target}`);
    }
  }
  // Root CLAUDE may reference babel-cli/CLAUDE.md — that file must exist after this package
  assert.ok(existsSync(path.join(BABEL_CLI, "CLAUDE.md")));
});

test("architecture source-map paths resolve", () => {
  const sourceMap = [
    "babel-cli/src/agent/chatEngine.ts",
    "babel-cli/src/agent/completionGatePolicy.ts",
    "babel-cli/src/executor/kernel.ts",
    "babel-cli/src/executor/contracts.ts",
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

test("golden negative: stale receipt fixture matches honesty gate (flag only, not revision-binding)", () => {
  const fixture = readJson<{
    status: string;
    implemented?: { honestyRejectsStaleFlag: boolean };
    target?: { controllerDerivesStalenessFromRevision: boolean };
    receipt: { command: string; exit_code: number; summary: string; stale: boolean };
    expectHonesty: { allow: boolean; reason: string };
  }>("examples/golden-harness/negative/stale-verifier-receipt.json");
  assert.ok(
    fixture.status === "implemented" || fixture.status === "implemented_partial",
  );
  // IMPLEMENTED: honesty reacts to receipt.stale === true
  assert.equal(fixture.implemented?.honestyRejectsStaleFlag, true);
  // TARGET: automatic boundRevision vs workspace comparison is not claimed here
  assert.equal(fixture.target?.controllerDerivesStalenessFromRevision, true);
  const honesty = evaluateExecuteCompletionHonesty({
    hasWrite: true,
    policy: "required",
    lastVerifierReceipt: fixture.receipt,
    toolCallLog: [{ tool: "write_file", target: "src/add.ts" }],
  });
  assert.equal(honesty.allow, fixture.expectHonesty.allow);
  assert.equal(honesty.reason, fixture.expectHonesty.reason);
});

test("golden negative: target fixtures are labeled target (not silent pass)", () => {
  const narrow = readJson<{ status: string; expect: { requirementSatisfied: boolean } }>(
    "examples/golden-harness/negative/narrow-verifier-vs-broad-required.json",
  );
  assert.equal(narrow.status, "target");
  assert.equal(narrow.expect.requirementSatisfied, false);
  // isolation-unavailable is live-tested separately (H13 implemented).
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

test("live kernel accepts golden-shaped verified completion with proof", () => {
  const decision = createExecutorKernel("chat").completion.decide({
    mode: "chat",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "required",
    lastVerifierReceipt: {
      command: "npm test",
      exit_code: 0,
      summary: "1 passed",
    },
    toolCallLog: [
      { tool: "write_file", target: "src/add.ts" },
      { tool: "run_command", target: "npm test", exit_code: 0 },
    ],
    proof: { compliant: true },
    evidenceRefs: ["golden-receipt-final", "mutation-batch-2"],
  });
  assert.equal(decision.finalOutcome, "VERIFIED_COMPLETE");
  assert.equal(decision.allowed, true);
  assert.equal(decision.policyVersion, EXECUTOR_CONTRACT_VERSION);
});
