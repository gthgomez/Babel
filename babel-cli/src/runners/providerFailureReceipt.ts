import { createHash } from 'node:crypto';
import type {
  ProviderFailureReceipt,
  ProviderFailureStage,
} from './base.js';
import type { ProviderId } from './providerRegistry.js';
import { redactSecrets } from '../utils/secretRedaction.js';

export interface ProviderFailureDetails {
  status?: number | null;
  message?: string | null;
  providerRequestId?: string | null;
  apiErrorCode?: string | null;
}

export interface ProviderFailureReceiptInput {
  inferenceId: string;
  provider: ProviderId;
  model: string;
  details?: ProviderFailureDetails | undefined;
  observedUpstream?: string | null | undefined;
  actualAttempt: number;
  maxAttempts: number;
  stream: boolean;
  failureStage: ProviderFailureStage;
  inferenceStarted: boolean;
  partialModelOutput: boolean;
  toolCallCount?: number | undefined;
  requestedOutputBudget?: number | null | undefined;
  effectiveOutputBudget?: number | null | undefined;
  wirePolicyHash?: string | null | undefined;
  executionEnvelopeHash?: string | null | undefined;
  outputMaterial?: string | undefined;
}

/** Compatibility taxonomy for the durable V1 provider-receipt event. */
export const PROVIDER_FAILURE_CLASSES = [
  'HTTP_429',
  'HTTP_4XX_OTHER',
  'HTTP_5XX',
  'CONNECT_TIMEOUT',
  'READ_TIMEOUT',
  'STREAM_IDLE_TIMEOUT',
  'STREAM_RESET',
  'MALFORMED_RESPONSE',
  'INCOMPLETE_STREAM',
  'UPSTREAM_UNAVAILABLE',
  'OPENROUTER_ROUTING_FAILURE',
  'PROVIDER_PROTOCOL_FAILURE',
  'UNKNOWN_PROVIDER_FAILURE',
] as const;

export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

export type ProviderFailureStageV1 =
  | 'request'
  | 'http_response'
  | 'stream'
  | 'normalization'
  | 'delivery';

export interface ProviderFailureReceiptV1 {
  schema_version: 1;
  kind: 'babel_provider_failure_receipt';
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
  failure_stage: ProviderFailureStageV1;
  inference_started: boolean;
  partial_model_output: boolean;
  tool_calls_emitted: number;
  task_verified: boolean | null;
  subsequent_recovery: boolean | null;
  receipt_hash: string;
}

export interface ProviderFailureReceiptInputV1 {
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
  failureStage: ProviderFailureStageV1;
  inferenceStarted: boolean;
  partialModelOutput: boolean;
  toolCallsEmitted: number;
  taskVerified?: boolean | null;
  subsequentRecovery?: boolean | null;
  receiptId?: string;
}

/** Keep provider identifiers and error codes bounded and free of response payloads. */
function bounded(value: string | null | undefined, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized.length > 0 ? normalized.slice(0, max) : null;
}

export function providerRequestIdFromResponse(response: Response | null | undefined): string | null {
  if (!response) return null;
  for (const name of [
    'x-request-id',
    'x-openrouter-request-id',
    'x-upstream-request-id',
    'request-id',
  ]) {
    const value = bounded(response.headers.get(name));
    if (value) return value;
  }
  return null;
}

/** Extract only a bounded provider error code from a JSON error envelope. */
export function providerErrorCodeFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const nested = error as Record<string, unknown>;
      return bounded(
        typeof nested.code === 'string'
          ? nested.code
          : typeof nested.type === 'string'
            ? nested.type
            : null,
      );
    }
    return bounded(
      typeof record.code === 'string'
        ? record.code
        : typeof record.type === 'string'
          ? record.type
          : null,
    );
  } catch {
    return null;
  }
}

/** Normalize the operational class used by a terminal provider receipt. */
export function providerFailureClass(details: ProviderFailureDetails = {}): string {
  const message = `${details.apiErrorCode ?? ''} ${details.message ?? ''}`.toLowerCase();
  if (details.status === 402) return 'HTTP_402';
  if (details.status === 429) return 'HTTP_429';
  if (details.status !== null && details.status !== undefined && details.status >= 500) {
    return 'HTTP_5XX';
  }
  if (details.status === 401 || details.status === 403) return `HTTP_${details.status}`;
  if (details.status !== null && details.status !== undefined && details.status >= 400) {
    return `HTTP_${details.status}`;
  }
  if (/stream idle|stream read|timeout|timed out|abort/.test(message)) return 'TIMEOUT';
  if (/network|transport|econnreset|connection/.test(message)) return 'TRANSPORT_FAILURE';
  if (/parse|malformed|protocol|normalization/.test(message)) return 'PROTOCOL_ERROR';
  return 'UNKNOWN';
}

export function outputMaterialDigest(material: string): string {
  return createHash('sha256').update(material).digest('hex');
}

function buildRuntimeProviderFailureReceipt(
  input: ProviderFailureReceiptInput,
): ProviderFailureReceipt {
  const details = input.details ?? {};
  const partial = input.partialModelOutput;
  const normalizedFailureClass = providerFailureClass(details);
  const failureClass =
    normalizedFailureClass === 'UNKNOWN' && input.failureStage === 'response_normalization'
      ? 'PROTOCOL_ERROR'
      : normalizedFailureClass;
  return {
    inference_id: input.inferenceId,
    provider: input.provider,
    model: input.model,
    provider_request_id: bounded(details.providerRequestId),
    observed_upstream: bounded(input.observedUpstream),
    http_status: details.status ?? null,
    api_error_code: bounded(details.apiErrorCode),
    failure_class: failureClass,
    actual_attempt: Math.max(1, Math.floor(input.actualAttempt)),
    max_attempts: Math.max(1, Math.floor(input.maxAttempts)),
    stream: input.stream,
    failure_stage: input.failureStage,
    inference_started: input.inferenceStarted,
    partial_model_output: partial,
    tool_call_count: Math.max(0, Math.floor(input.toolCallCount ?? 0)),
    requested_output_budget: input.requestedOutputBudget ?? null,
    effective_output_budget: input.effectiveOutputBudget ?? null,
    wire_policy_hash: input.wirePolicyHash ?? null,
    execution_envelope_hash: input.executionEnvelopeHash ?? null,
    output_digest: outputMaterialDigest(input.outputMaterial ?? ''),
    // A terminal receipt describes the final outcome, not whether an earlier
    // attempt would have been eligible for retry. Partial output is never
    // replay-safe; account/configuration/protocol failures are also terminal.
    retryable: false,
  };
}

function safeFailureMessage(message: string): string {
  return redactSecrets(message)
    .replace(/(authorization\s*:\s*)(?:bearer\s+)?[^\s;,]+/gi, '$1_REDACTED_')
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s;,]+/gi, '$1_REDACTED_');
}

function buildV1ProviderFailureReceipt(
  input: ProviderFailureReceiptInputV1,
): ProviderFailureReceiptV1 {
  const unsigned: Omit<ProviderFailureReceiptV1, 'receipt_hash'> = {
    schema_version: 1,
    kind: 'babel_provider_failure_receipt',
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
  };
  const receiptHash = createHash('sha256')
    .update(JSON.stringify(unsigned), 'utf8')
    .digest('hex');
  return { ...unsigned, receipt_hash: receiptHash };
}

/** Build either the runtime receipt or the durable V1 compatibility receipt. */
export function buildProviderFailureReceipt(
  input: ProviderFailureReceiptInput,
): ProviderFailureReceipt;
export function buildProviderFailureReceipt(
  input: ProviderFailureReceiptInputV1,
): ProviderFailureReceiptV1;
export function buildProviderFailureReceipt(
  input: ProviderFailureReceiptInput | ProviderFailureReceiptInputV1,
): ProviderFailureReceipt | ProviderFailureReceiptV1 {
  return 'exactModelId' in input
    ? buildV1ProviderFailureReceipt(input)
    : buildRuntimeProviderFailureReceipt(input);
}

/** Validate the shape and content hash of a durable V1 provider receipt. */
export function validateProviderFailureReceipt(
  value: unknown,
): asserts value is ProviderFailureReceiptV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provider failure receipt must be an object');
  }
  const receipt = value as Partial<ProviderFailureReceiptV1>;
  const retryAttempt = receipt.retry_attempt;
  const maximumAttempts = receipt.maximum_attempts;
  const toolCallsEmitted = receipt.tool_calls_emitted;
  if (
    receipt.schema_version !== 1 ||
    receipt.kind !== 'babel_provider_failure_receipt' ||
    typeof receipt.receipt_id !== 'string' ||
    typeof receipt.provider !== 'string' ||
    typeof receipt.exact_model_id !== 'string' ||
    typeof receipt.local_request_id !== 'string' ||
    typeof receipt.normalized_failure_class !== 'string' ||
    !(PROVIDER_FAILURE_CLASSES as readonly string[]).includes(
      receipt.normalized_failure_class,
    ) ||
    typeof receipt.message !== 'string' ||
    typeof receipt.retryable !== 'boolean' ||
    !Number.isInteger(retryAttempt) ||
    (retryAttempt ?? 0) < 1 ||
    !Number.isInteger(maximumAttempts) ||
    (maximumAttempts ?? 0) < 1 ||
    typeof receipt.stream !== 'boolean' ||
    typeof receipt.failure_stage !== 'string' ||
    typeof receipt.inference_started !== 'boolean' ||
    typeof receipt.partial_model_output !== 'boolean' ||
    !Number.isInteger(toolCallsEmitted) ||
    (toolCallsEmitted ?? -1) < 0 ||
    typeof receipt.receipt_hash !== 'string'
  ) {
    throw new Error('provider failure receipt has invalid fields');
  }
  const { receipt_hash: actualHash, ...unsigned } =
    receipt as ProviderFailureReceiptV1;
  const expectedHash = createHash('sha256')
    .update(JSON.stringify(unsigned), 'utf8')
    .digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error('provider failure receipt hash does not match its content');
  }
}

/** Normalize status, transport, and stream signals into the V1 taxonomy. */
export function normalizeProviderFailureClass(input: {
  httpStatus?: number | null;
  message?: string | null;
  stage?: ProviderFailureStageV1;
  stream?: boolean;
}): ProviderFailureClass {
  const status = input.httpStatus ?? null;
  if (status === 429) return 'HTTP_429';
  if (status !== null && status >= 400 && status < 500) return 'HTTP_4XX_OTHER';
  if (status !== null && status >= 500) return 'HTTP_5XX';
  const message = (input.message ?? '').toLowerCase();
  if (/openrouter.*(route|provider)|routing failure|no available provider/.test(message)) {
    return 'OPENROUTER_ROUTING_FAILURE';
  }
  if (/upstream.*unavailable|service unavailable|temporarily unavailable/.test(message)) {
    return 'UPSTREAM_UNAVAILABLE';
  }
  if (/connect.*timeout|connection timed out|econnrefused|enotfound/.test(message)) {
    return 'CONNECT_TIMEOUT';
  }
  if (/read.*timeout|request timeout|timed out/.test(message)) return 'READ_TIMEOUT';
  if (/stream.*idle|idle timeout/.test(message)) return 'STREAM_IDLE_TIMEOUT';
  if (/stream.*reset|reset by peer|socket.*closed|premature close/.test(message)) {
    return 'STREAM_RESET';
  }
  if (/incomplete|truncated|unexpected end|did not finish/.test(message)) {
    return 'INCOMPLETE_STREAM';
  }
  if (/malformed|invalid json|parse|normaliz/.test(message)) return 'MALFORMED_RESPONSE';
  if (input.stage === 'stream' || input.stream === true) return 'PROVIDER_PROTOCOL_FAILURE';
  return 'UNKNOWN_PROVIDER_FAILURE';
}

/** Return true only when the same exact request may be retried safely. */
export function isSafeProviderRetry(input: {
  httpStatus?: number | null;
  failureClass: ProviderFailureClass;
  attempt: number;
  maximumAttempts: number;
  partialModelOutput: boolean;
}): boolean {
  if (input.partialModelOutput || input.attempt >= input.maximumAttempts) return false;
  if (
    input.httpStatus === 408 ||
    input.httpStatus === 429 ||
    (input.httpStatus ?? 0) >= 500
  ) {
    return true;
  }
  return new Set<ProviderFailureClass>([
    'CONNECT_TIMEOUT',
    'READ_TIMEOUT',
    'STREAM_IDLE_TIMEOUT',
    'STREAM_RESET',
    'UPSTREAM_UNAVAILABLE',
  ]).has(input.failureClass);
}
