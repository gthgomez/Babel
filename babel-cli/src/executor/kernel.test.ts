import assert from "node:assert/strict";
import test from "node:test";

import { classifyToolEffect, modePolicyFor } from "./contracts.js";
import { createExecutorKernel } from "./kernel.js";

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
