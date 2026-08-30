import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRetentionMatrix,
  validateRetentionConsistency,
} from "./retention.js";
import { parseTestCount } from "./verification.js";

test("certifies every canonical retention field only when present and valid", () => {
  const matrix = buildRetentionMatrix({
    cellId: "L01-glm",
    evidence: {
      wireModelId: "z-ai/glm-5.3-flash",
      resolvedExecutionEnvelopeHash: "env",
      generationPolicy: { maxOutputTokens: 8192 },
      finishReason: "NATURAL_COMPLETION",
      taskResult: "verified_success",
      verificationEvidence: { exitCode: 0 },
      failureAttribution: "NONE",
      providerEndpoint: undefined,
    },
    optionalFields: { providerEndpoint: "NOT_APPLICABLE" },
  });
  assert.equal(matrix.status, "RETENTION_CERTIFIED");
  assert.equal(matrix.criticalValid, matrix.criticalExpected);
  assert.equal(
    matrix.fields.find((field) => field.field === "providerEndpoint")?.status,
    "NOT_APPLICABLE",
  );
});

test("fails retention when canonical evidence is missing or inconsistent", () => {
  const matrix = buildRetentionMatrix({
    cellId: "L01-deepseek",
    evidence: { wireModelId: "deepseek/deepseek-v4-flash-0731" },
  });
  assert.equal(matrix.status, "RETENTION_FAILED");
  const errors = validateRetentionConsistency({
    manifestWireModelId: "deepseek/deepseek-v4-flash-0731",
    requestWireModelId: "deepseek/deepseek-v4-flash-latest",
    effectiveOutputBudget: 8192,
    serializedOutputBudget: 4096,
    finishReason: "NATURAL_COMPLETION",
    terminalFinishReason: "OUTPUT_BUDGET_EXHAUSTED",
    taskResult: "verified_failure",
    verificationResult: "exit=1",
  });
  assert.equal(errors.length, 4);
});

test("reports machine-produced test counts without inventing them", () => {
  assert.equal(parseTestCount("ℹ tests 40\nℹ pass 40"), 40);
  assert.equal(parseTestCount("typecheck completed"), null);
});
