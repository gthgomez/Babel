import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildProviderFailureReceipt,
  isSafeProviderRetry,
  normalizeProviderFailureClass,
  validateProviderFailureReceipt,
} from "./providerFailureReceipt.js";
import {
  appendSessionEvent,
  createSessionEventLog,
  parseSessionEventLog,
  recordProviderFailureReceipt,
  serializeSessionEventLog,
} from "../agent/sessionEvents.js";

test("provider failure receipts are hashed and secret-safe", () => {
  const receipt = buildProviderFailureReceipt({
    provider: "openrouter",
    exactModelId: "z-ai/glm-5.3-flash",
    localRequestId: "inference-1",
    openrouterRequestId: "req-1",
    httpStatus: 429,
    apiErrorCode: "rate_limit",
    normalizedFailureClass: "HTTP_429",
    message: "Authorization: Bearer super-secret; retry later",
    retryable: true,
    retryAttempt: 1,
    maximumAttempts: 3,
    stream: false,
    failureStage: "http_response",
    inferenceStarted: true,
    partialModelOutput: false,
    toolCallsEmitted: 0,
  });
  validateProviderFailureReceipt(receipt);
  assert.doesNotMatch(receipt.message, /super-secret|Bearer/i);
  assert.equal(receipt.normalized_failure_class, "HTTP_429");
  assert.equal(
    normalizeProviderFailureClass({
      message: "stream idle timeout",
      stage: "stream",
      stream: true,
    }),
    "STREAM_IDLE_TIMEOUT",
  );
  assert.equal(
    isSafeProviderRetry({
      httpStatus: 401,
      failureClass: "HTTP_4XX_OTHER",
      attempt: 1,
      maximumAttempts: 3,
      partialModelOutput: false,
    }),
    false,
  );
  assert.equal(
    isSafeProviderRetry({
      httpStatus: 429,
      failureClass: "HTTP_429",
      attempt: 1,
      maximumAttempts: 3,
      partialModelOutput: false,
    }),
    true,
  );
  assert.throws(
    () => validateProviderFailureReceipt({ ...receipt, receipt_hash: "bad" }),
    /hash/,
  );
});

test("provider failure receipts are causally linked in the durable session log", () => {
  const receipt = buildProviderFailureReceipt({
    provider: "openrouter",
    exactModelId: "z-ai/glm-5.3-flash",
    localRequestId: "inference-2",
    normalizedFailureClass: "INCOMPLETE_STREAM",
    message: "terminal marker was not received",
    retryable: false,
    retryAttempt: 1,
    maximumAttempts: 1,
    stream: true,
    failureStage: "stream",
    inferenceStarted: true,
    partialModelOutput: true,
    toolCallsEmitted: 0,
  });
  const log = createSessionEventLog("session-2");
  appendSessionEvent(log, {
    kind: "model_input_receipt",
    turn_id: "turn-2",
    inference_id: "inference-2",
    provider: "openrouter",
    requested_model_id: "z-ai/glm-5.3-flash",
    normalized_model_id: "z-ai/glm-5.3-flash",
    sent_model_id: "z-ai/glm-5.3-flash",
    input_digest: "a".repeat(64),
    input_ref: "thread_events.json",
  });
  recordProviderFailureReceipt(log, {
    turn_id: "turn-2",
    inference_id: "inference-2",
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    receipt,
  });
  const parsed = parseSessionEventLog(serializeSessionEventLog(log));
  assert.equal(
    parsed.events.filter((event) => event.kind === "provider_failure_receipt")
      .length,
    1,
  );
  assert.throws(
    () =>
      appendSessionEvent(log, {
        kind: "provider_failure_receipt",
        turn_id: "turn-2",
        inference_id: "other-inference",
        provider: "openrouter",
        model: "z-ai/glm-5.3-flash",
        receipt,
      }),
    /identity|matching model input/,
  );
});
