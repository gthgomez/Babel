import { kernelVerifierFixture } from '../testinfra/kernelVerifierFixture.js'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeExecutor } from '../sandbox.js';
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from '../config/benchmarkContainer.js';

import { classifyToolEffect, modePolicyFor } from "./contracts.js";
import { createExecutorKernel } from "./kernel.js";

test('kernel passes actual isolation facts to authority without allowing absent isolation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kernel-isolation-'));
  const names = ['BABEL_EXECUTION_PROFILE', 'BABEL_BENCHMARK_DOCKER_IMAGE', 'BABEL_DOCKER_DISABLE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_LIVE', 'BABEL_DRY_RUN'] as const;
  const previous = names.map(name => [name, process.env[name]] as const);
  let calls = 0;
  t.mock.method(SafeExecutor.prototype, 'testRunAsync', async () => {
    calls++;
    return { exit_code: 0, stdout: 'sandbox reached', stderr: '' };
  });
  try {
    process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'synthetic/kernel:unit';
    process.env['BABEL_LIVE'] = 'true';
    process.env['BABEL_DRY_RUN'] = 'false';
    delete process.env['BABEL_DOCKER_DISABLE'];
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    setDockerAvailableForTest(true);
    const kernel = createExecutorKernel('deep');
    const context = { agentId: 'kernel-isolation', runId: 'kernel-isolation', babelRoot: root, projectRoot: root };
    const allowed = await kernel.tools.execute({ tool: 'test_run', command: 'node --test' }, context);
    assert.equal(allowed.exit_code, 0, allowed.stderr);
    assert.equal(calls, 1);
    delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    const denied = await kernel.tools.execute({ tool: 'test_run', command: 'node --test' }, context);
    assert.equal(denied.exit_code, 1);
    assert.match(denied.stderr ?? '', /DENY_CAPABILITY_CONSTRAINT|isolation_unavailable/);
    assert.equal(calls, 1, 'absent image must not reach executor');
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'synthetic/kernel:unit';
    setDockerAvailableForTest(false);
    const noDocker = await kernel.tools.execute({ tool: 'test_run', command: 'node --test' }, context);
    assert.equal(noDocker.exit_code, 1);
    assert.equal(calls, 1, 'absent Docker must not reach executor');
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    resetDockerAvailabilityCache();
    t.mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mode policy preserves distinct chat, plan, and deep controllers", () => {
  assert.equal(modePolicyFor("chat").mutationPolicy, "normal");
  assert.equal(modePolicyFor("plan").mutationPolicy, "read_only");
  assert.equal(modePolicyFor("deep").mutationPolicy, "governed");
  assert.equal(modePolicyFor("plan").completionPolicy, "plan_artifact");
});

test("classifies mutation and external effects conservatively", () => {
  assert.equal(classifyToolEffect("read_file"), "read_only");
  assert.equal(classifyToolEffect("test_run"), "idempotent");
  assert.equal(classifyToolEffect("apply_patch"), "reconcilable_mutation");
  assert.equal(classifyToolEffect("shell_exec"), "non_idempotent_local_effect");
  assert.equal(classifyToolEffect("mcp_request"), "external_side_effect");
});

test("plan kernel cannot emit executor completion", () => {
  const kernel = createExecutorKernel("plan");
  const decision = kernel.completion.decide({
    mode: "plan",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "strict",
    toolCallLog: [],
    proof: { compliant: true },
  });

  assert.equal(decision.finalOutcome, "PLAN_COMPLETE");
  assert.equal(decision.allowed, false);
});

const mockGreenReceipt = {
  receiptId: 'mock-1',
  command: 'npm test',
  exitCode: 0,
  authority: true,
  authoritySource: 'built_in_runner' as const,
  boundRevision: { fileHashes: {} } as any,
  capturedAt: Date.now(),
  stale: false,
};

test("executor kernel downgrades verified completion until proof is complete", () => {
  const kernel = createExecutorKernel("chat");
  const decision = kernel.completion.decide({
    mode: "chat",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "strict",
    lastVerifierReceipt: mockGreenReceipt,
    toolCallLog: [],
    proof: { compliant: false },
  });

  assert.equal(decision.finalOutcome, "UNVERIFIED_PATCH");
  assert.equal(decision.allowed, false);
});

for (const mode of ['chat', 'deep'] as const) {
  test(`${mode} cannot certify coarse proof without trusted criterion evidence`, () => {
    const decision = createExecutorKernel(mode).completion.decide({
      ...kernelVerifierFixture(),
      mode,
      requestedOutcome: 'VERIFIED_COMPLETE',
      hasWrite: true,
      verificationPolicy: 'none',
      toolCallLog: [],
      proof: { compliant: true },
    });
    assert.equal(decision.finalOutcome, 'UNVERIFIED_PATCH');
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /acceptance/);
  });
}

test("plan kernel denies mutation tools at the shared dispatch boundary", async () => {
  const kernel = createExecutorKernel("plan");
  const result = await kernel.tools.execute(
    { tool: "file_write", path: "src/example.ts", content: "x" },
    { agentId: "plan-test", runId: "plan-test", babelRoot: process.cwd() },
  );
  assert.equal(result.exit_code, 1);
  assert.match(result.stderr ?? "", /plan_read_only/i);
});

test("executor kernel exposes sync evaluateEvidence twin", () => {
  const kernel = createExecutorKernel("chat");
  assert.equal(typeof kernel.completion.evaluateEvidenceSync, "function");
  assert.equal(typeof kernel.completion.evaluateEvidence, "function");
});

test("executor kernel rejects an incomplete proof even with a green verifier", () => {
  const kernel = createExecutorKernel("deep");
  const decision = kernel.completion.decide({
    mode: "deep",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "strict",
    lastVerifierReceipt: mockGreenReceipt,
    toolCallLog: [],
    proof: { compliant: false, errors: ["missing claim receipt"] },
  });
  assert.equal(decision.finalOutcome, "UNVERIFIED_PATCH");
  assert.match(decision.reason, /evidence_incomplete/);
});

test("executor kernel downgrades verified completion when verifierEvidenceErrors present", () => {
  const kernel = createExecutorKernel("chat");
  const decision = kernel.completion.decide({
    mode: "chat",
    requestedOutcome: "VERIFIED_COMPLETE",
    hasWrite: true,
    verificationPolicy: "none",
    verifierEvidenceErrors: ["invalid receipt format"],
    toolCallLog: [],
    proof: { compliant: true },
  });
  assert.equal(decision.finalOutcome, "UNVERIFIED_PATCH");
  assert.match(decision.reason, /verifier_receipt_invalid/);
});
