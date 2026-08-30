import { createHash } from 'node:crypto';
import type {
  ProviderFailureReceipt,
  ProviderFailureStage,
} from './base.js';
import type { ProviderId } from './providerRegistry.js';

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

export function buildProviderFailureReceipt(
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
