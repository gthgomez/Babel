import { randomUUID } from 'node:crypto';
import {
  accountProviderRequest,
  type ProviderRequestAccounting,
} from './providerMessages.js';

export type PreparedProviderRequestMode = 'native' | 'text' | 'legacy';

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
  readonly context_limit_source: string;
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
  readonly inputLimitTokens?: number | null;
  readonly contextLimitSource?: string;
}

/**
 * Freeze the exact serialized provider body and derive every local accounting
 * field from that same immutable representation. Credentials are intentionally
 * not accepted here; they remain transport-only.
 */
export function prepareProviderRequest(input: PrepareProviderRequestInput): PreparedProviderRequest {
  const accounting = Object.freeze(accountProviderRequest(input.body, {
    ...(input.reservedCompletionTokens === undefined
      ? {}
      : { reservedCompletionTokens: input.reservedCompletionTokens }),
    ...(input.inputLimitTokens === undefined ? {} : { inputLimitTokens: input.inputLimitTokens }),
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
    context_limit_tokens: input.inputLimitTokens ?? null,
    context_limit_source: input.contextLimitSource ?? 'unknown',
  });
}
