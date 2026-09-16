import { randomUUID } from 'node:crypto';
import {
  accountProviderRequest,
  type ProviderRequestAccounting,
} from './providerMessages.js';
import { getAvailableModels, getNormalizedModelCapabilities } from '../modelPolicy.js';

export type PreparedProviderRequestMode = 'native' | 'text' | 'legacy';
export type ContextLimitSource = 'policy' | 'explicit' | 'unknown';
export type PreparedRequestAdmission = 'qualified' | 'over_limit' | 'unknown';

export interface PreparedProviderRequest {
  readonly body: string;
  readonly body_bytes: number;
  readonly body_digest: string;
  readonly accounting: ProviderRequestAccounting;
  readonly accounting_kind: 'exact_serialized_body';
  readonly mode: PreparedProviderRequestMode;
  readonly provider: string;
  readonly requested_model_id: string;
  readonly normalized_model_id: string;
  readonly sent_model_id: string;
  readonly request_id: string;
  readonly attempt_id: string;
  readonly parent_request_id: string | null;
  readonly context_limit_tokens: number | null;
  readonly context_limit_source: ContextLimitSource;
  /** Admission is evaluated from the exact final body, never from a draft. */
  readonly admission: PreparedRequestAdmission;
}

export interface PrepareProviderRequestInput {
  readonly body: string;
  readonly mode: PreparedProviderRequestMode;
  readonly provider: string;
  readonly requestedModelId: string;
  readonly normalizedModelId?: string;
  readonly sentModelId?: string;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly parentRequestId?: string | null;
  readonly reservedCompletionTokens?: number | null;
  /** Explicit context ceiling; null deliberately records an unknown ceiling. */
  readonly contextLimitTokens?: number | null;
  /** @deprecated Use contextLimitTokens. Retained as an input-limit alias. */
  readonly inputLimitTokens?: number | null;
  readonly contextLimitSource?: ContextLimitSource;
}

function normalizeTokenLimit(value: number | null | undefined, field: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer or null`);
  }
  return value;
}

function resolveContextLimit(input: PrepareProviderRequestInput): {
  tokens: number | null;
  source: ContextLimitSource;
} {
  const explicitLimit = input.contextLimitTokens ?? input.inputLimitTokens;
  const hasExplicitLimit = input.contextLimitTokens !== undefined || input.inputLimitTokens !== undefined;
  if (hasExplicitLimit) {
    const tokens = normalizeTokenLimit(explicitLimit, 'contextLimitTokens') ?? null;
    return {
      tokens,
      source: tokens === null ? 'unknown' : input.contextLimitSource ?? 'explicit',
    };
  }

  const modelId = input.sentModelId ?? input.normalizedModelId ?? input.requestedModelId;
  const policyCapabilities = getNormalizedModelCapabilities(modelId);
  const reverseLookupLimit = policyCapabilities === null
    ? getAvailableModels().find(({ entry }) => entry.model_id === modelId)?.entry.context_window
    : undefined;
  const policyLimit = normalizeTokenLimit(
    policyCapabilities?.contextWindow ?? reverseLookupLimit,
    'policy context window',
  );
  if (policyLimit !== undefined && policyLimit !== null) {
    return { tokens: policyLimit, source: input.contextLimitSource ?? 'policy' };
  }
  return { tokens: null, source: 'unknown' };
}

/**
 * Freeze the exact serialized provider body and derive every local accounting
 * field from that same immutable representation. Credentials are intentionally
 * not accepted here; they remain transport-only.
 */
export function prepareProviderRequest(input: PrepareProviderRequestInput): PreparedProviderRequest {
  const contextLimit = resolveContextLimit(input);
  const accounting = Object.freeze(accountProviderRequest(input.body, {
    ...(input.reservedCompletionTokens === undefined
      ? {}
      : { reservedCompletionTokens: input.reservedCompletionTokens }),
    ...(contextLimit.tokens === null ? {} : { inputLimitTokens: contextLimit.tokens }),
  }));
  return Object.freeze({
    body: input.body,
    body_bytes: accounting.request_bytes,
    body_digest: accounting.request_digest,
    accounting,
    accounting_kind: 'exact_serialized_body' as const,
    mode: input.mode,
    provider: input.provider,
    requested_model_id: input.requestedModelId,
    normalized_model_id: input.normalizedModelId ?? input.requestedModelId,
    sent_model_id: input.sentModelId ?? input.requestedModelId,
    request_id: input.requestId ?? randomUUID(),
    attempt_id: input.attemptId ?? randomUUID(),
    parent_request_id: input.parentRequestId ?? null,
    context_limit_tokens: contextLimit.tokens,
    context_limit_source: contextLimit.source,
    admission:
      accounting.within_limit === true
        ? 'qualified'
        : accounting.within_limit === false
          ? 'over_limit'
          : 'unknown',
  });
}

/**
 * Fail closed when an authoritative context limit proves that the final body
 * cannot fit. Unknown limits remain observable and are not treated as a pass.
 */
export function assertPreparedProviderRequestAdmissible(
  request: PreparedProviderRequest,
): void {
  if (request.admission !== 'over_limit') return;
  throw new Error(
    `[provider request admission] final ${request.provider}/${request.sent_model_id} body exceeds ` +
      `${request.context_limit_tokens} token context limit (${request.body_digest})`,
  );
}
