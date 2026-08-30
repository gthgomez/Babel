import { createHash } from "node:crypto";
import { redactSecrets } from "../utils/secretRedaction.js";
import type { ProviderId } from "./providerRegistry.js";

/** Provider failure classes recorded by the live inference boundary. */
export const PROVIDER_FAILURE_CLASSES = [
  "HTTP_402",
  "HTTP_408",
  "HTTP_429",
  "HTTP_4XX_OTHER",
  "HTTP_5XX",
  "CONNECT_TIMEOUT",
  "READ_TIMEOUT",
  "STREAM_IDLE_TIMEOUT",
  "STREAM_RESET",
  "MALFORMED_RESPONSE",
  "INCOMPLETE_STREAM",
  "UPSTREAM_UNAVAILABLE",
  "OPENROUTER_ROUTING_FAILURE",
  "PROVIDER_PROTOCOL_FAILURE",
  "UNKNOWN_PROVIDER_FAILURE",
] as const;

export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

/** Stage at which a provider failure became observable. */
export type ProviderFailureStage =
  | "request"
  | "http_response"
  | "stream"
  | "normalization"
  | "delivery";

/** Secret-safe, content-free provider failure receipt. */
export interface ProviderFailureReceiptV1 {
  schema_version: 1;
  kind: "babel_provider_failure_receipt";
  receipt_id: string;
  provider: ProviderId;
  exact_model_id: string;
  upstream_provider: string | null;
  openrouter_request_id: string | null;
  local_request_id: string;
  http_status: number | null;
  api_error_code: string | null;
  normalized_failure_class: ProviderFailureClass;
  message: string;
  retryable: boolean;
  retry_attempt: number;
  maximum_attempts: number;
  stream: boolean;
  failure_stage: ProviderFailureStage;
  inference_started: boolean;
  partial_model_output: boolean;
  tool_calls_emitted: number;
  task_verified: boolean | null;
  subsequent_recovery: boolean | null;
  requested_output_budget?: number | null;
  effective_output_budget?: number | null;
  wire_policy_hash?: string | null;
  execution_envelope_hash?: string | null;
  output_digest?: string | null;
  receipt_hash: string;
}

/** Inputs used to construct a provider failure receipt. */
export interface ProviderFailureReceiptInput {
  provider: ProviderId;
  exactModelId: string;
  localRequestId: string;
  upstreamProvider?: string | null;
  openrouterRequestId?: string | null;
  httpStatus?: number | null;
  apiErrorCode?: string | null;
  normalizedFailureClass: ProviderFailureClass;
  message: string;
  retryable: boolean;
  retryAttempt: number;
  maximumAttempts: number;
  stream: boolean;
  failureStage: ProviderFailureStage;
  inferenceStarted: boolean;
  partialModelOutput: boolean;
  toolCallsEmitted: number;
  taskVerified?: boolean | null;
  subsequentRecovery?: boolean | null;
  requestedOutputBudget?: number | null;
  effectiveOutputBudget?: number | null;
  wirePolicyHash?: string | null;
  executionEnvelopeHash?: string | null;
  outputDigest?: string | null;
  receiptId?: string;
}

function unsignedReceipt(
  input: Omit<ProviderFailureReceiptV1, "receipt_hash">,
): Omit<ProviderFailureReceiptV1, "receipt_hash"> {
  return input;
}

function safeFailureMessage(message: string): string {
  return redactSecrets(message)
    .replace(/(authorization\s*:\s*)(?:bearer\s+)?[^\s;,]+/gi, "$1_REDACTED_")
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s;,]+/gi, "$1_REDACTED_");
}

/** Build a deterministic, redacted provider failure receipt. */
export function buildProviderFailureReceipt(
  input: ProviderFailureReceiptInput,
): ProviderFailureReceiptV1 {
  const unsigned: Omit<ProviderFailureReceiptV1, "receipt_hash"> = {
    schema_version: 1,
    kind: "babel_provider_failure_receipt",
    receipt_id: input.receiptId ?? `pfr_${input.localRequestId}`,
    provider: input.provider,
    exact_model_id: input.exactModelId,
    upstream_provider: input.upstreamProvider ?? null,
    openrouter_request_id: input.openrouterRequestId ?? null,
    local_request_id: input.localRequestId,
    http_status: input.httpStatus ?? null,
    api_error_code: input.apiErrorCode ?? null,
    normalized_failure_class: input.normalizedFailureClass,
    message: safeFailureMessage(input.message).slice(0, 500),
    retryable: input.retryable,
    retry_attempt: input.retryAttempt,
    maximum_attempts: input.maximumAttempts,
    stream: input.stream,
    failure_stage: input.failureStage,
    inference_started: input.inferenceStarted,
    partial_model_output: input.partialModelOutput,
    tool_calls_emitted: input.toolCallsEmitted,
    task_verified: input.taskVerified ?? null,
    subsequent_recovery: input.subsequentRecovery ?? null,
    ...(input.requestedOutputBudget === undefined ? {} : { requested_output_budget: input.requestedOutputBudget }),
    ...(input.effectiveOutputBudget === undefined ? {} : { effective_output_budget: input.effectiveOutputBudget }),
    ...(input.wirePolicyHash === undefined ? {} : { wire_policy_hash: input.wirePolicyHash }),
    ...(input.executionEnvelopeHash === undefined ? {} : { execution_envelope_hash: input.executionEnvelopeHash }),
    ...(input.outputDigest === undefined ? {} : { output_digest: input.outputDigest }),
  };
  const receiptHash = createHash("sha256")
    .update(JSON.stringify(unsigned), "utf8")
    .digest("hex");
  return { ...unsignedReceipt(unsigned), receipt_hash: receiptHash };
}

/** Validate the shape and content hash of a provider failure receipt. */
export function validateProviderFailureReceipt(
  value: unknown,
): asserts value is ProviderFailureReceiptV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider failure receipt must be an object");
  }
  const receipt = value as Partial<ProviderFailureReceiptV1>;
  const retryAttempt = receipt.retry_attempt;
  const maximumAttempts = receipt.maximum_attempts;
  const toolCallsEmitted = receipt.tool_calls_emitted;
  if (
    receipt.schema_version !== 1 ||
    receipt.kind !== "babel_provider_failure_receipt" ||
    typeof receipt.receipt_id !== "string" ||
    typeof receipt.provider !== "string" ||
    typeof receipt.exact_model_id !== "string" ||
    typeof receipt.local_request_id !== "string" ||
    typeof receipt.normalized_failure_class !== "string" ||
    !(PROVIDER_FAILURE_CLASSES as readonly string[]).includes(
      receipt.normalized_failure_class,
    ) ||
    typeof receipt.message !== "string" ||
    typeof receipt.retryable !== "boolean" ||
    !Number.isInteger(retryAttempt) ||
    (retryAttempt ?? 0) < 1 ||
    !Number.isInteger(maximumAttempts) ||
    (maximumAttempts ?? 0) < 1 ||
    typeof receipt.stream !== "boolean" ||
    typeof receipt.failure_stage !== "string" ||
    typeof receipt.inference_started !== "boolean" ||
    typeof receipt.partial_model_output !== "boolean" ||
    !Number.isInteger(toolCallsEmitted) ||
    (toolCallsEmitted ?? -1) < 0 ||
    typeof receipt.receipt_hash !== "string"
  ) {
    throw new Error("provider failure receipt has invalid fields");
  }
  const { receipt_hash: actualHash, ...unsigned } =
    receipt as ProviderFailureReceiptV1;
  const expectedHash = createHash("sha256")
    .update(JSON.stringify(unsigned), "utf8")
    .digest("hex");
  if (actualHash !== expectedHash)
    throw new Error("provider failure receipt hash does not match its content");
}

/** Normalize status, transport, and stream signals into the receipt taxonomy. */
export function normalizeProviderFailureClass(input: {
  httpStatus?: number | null;
  message?: string | null;
  stage?: ProviderFailureStage;
  stream?: boolean;
}): ProviderFailureClass {
  const status = input.httpStatus ?? null;
  if (status === 402) return "HTTP_402";
  if (status === 408) return "HTTP_408";
  if (status === 429) return "HTTP_429";
  if (status !== null && status >= 400 && status < 500) return "HTTP_4XX_OTHER";
  if (status !== null && status >= 500) return "HTTP_5XX";
  const message = (input.message ?? "").toLowerCase();
  if (
    /openrouter.*(route|provider)|routing failure|no available provider/.test(
      message,
    )
  )
    return "OPENROUTER_ROUTING_FAILURE";
  if (
    /upstream.*unavailable|service unavailable|temporarily unavailable/.test(
      message,
    )
  )
    return "UPSTREAM_UNAVAILABLE";
  if (
    /connect.*timeout|connection timed out|econnrefused|enotfound/.test(message)
  )
    return "CONNECT_TIMEOUT";
  if (/read.*timeout|request timeout|timed out/.test(message))
    return "READ_TIMEOUT";
  if (/stream.*idle|idle timeout/.test(message)) return "STREAM_IDLE_TIMEOUT";
  if (
    /stream.*reset|reset by peer|socket.*closed|premature close/.test(message)
  )
    return "STREAM_RESET";
  if (/incomplete|truncated|unexpected end|did not finish/.test(message))
    return "INCOMPLETE_STREAM";
  if (/malformed|invalid json|parse|normaliz/.test(message))
    return "MALFORMED_RESPONSE";
  if (input.stage === "stream" || input.stream === true)
    return "PROVIDER_PROTOCOL_FAILURE";
  return "UNKNOWN_PROVIDER_FAILURE";
}

/** Return true only when the same exact request may be retried safely. */
export function isSafeProviderRetry(input: {
  httpStatus?: number | null;
  failureClass: ProviderFailureClass;
  attempt: number;
  maximumAttempts: number;
  partialModelOutput: boolean;
}): boolean {
  if (input.partialModelOutput || input.attempt >= input.maximumAttempts)
    return false;
  if (
    input.httpStatus === 408 ||
    input.httpStatus === 429 ||
    (input.httpStatus ?? 0) >= 500
  ) {
    return true;
  }
  return new Set<ProviderFailureClass>([
    "CONNECT_TIMEOUT",
    "READ_TIMEOUT",
    "STREAM_IDLE_TIMEOUT",
    "STREAM_RESET",
    "UPSTREAM_UNAVAILABLE",
  ]).has(input.failureClass);
}
