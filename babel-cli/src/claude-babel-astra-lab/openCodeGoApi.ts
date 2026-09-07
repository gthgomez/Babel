/** Exact-model, fail-closed OpenCode Go transport for the Astra lab. */

import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import type { RunnerCallbacks, RunnerInvocationMetadata } from '../runners/base.js';
import { isOpenCodeGoModel, type OpenCodeGoModel } from './models.js';
import { resolveOpenCodeGoCredential, type OpenCodeGoCredentialSource } from './credentialResolver.js';

export const OPENCODE_GO_DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_DEFAULT_MODEL: OpenCodeGoModel = 'mimo-v2.5';
export type OpenCodeGoErrorCode = 'AUTH_FAILURE' | 'GO_QUOTA_EXHAUSTED' | 'MODEL_UNAVAILABLE' | 'MALFORMED_RESPONSE' | 'TIMEOUT' | 'ABORTED' | 'MODEL_ATTRIBUTION_FAILURE' | 'PROVIDER_FAILURE';

export class OpenCodeGoError extends Error {
  readonly code: OpenCodeGoErrorCode;
  readonly httpStatus: number | null;
  constructor(code: OpenCodeGoErrorCode, message: string, httpStatus: number | null = null, cause?: unknown) {
    super(message, cause instanceof Error ? { cause } : undefined); this.name = 'OpenCodeGoError'; this.code = code; this.httpStatus = httpStatus;
  }
}

function resolveBaseUrl(): string { return (process.env['BABEL_OPENCODE_GO_BASE_URL']?.trim() || OPENCODE_GO_DEFAULT_BASE_URL).replace(/\/$/, ''); }
function statusFromMessage(message: string): number | null { const match = message.match(/HTTP (\d{3})/i); return match ? Number(match[1]) : null; }
function classifyError(error: unknown): OpenCodeGoError {
  if (error instanceof OpenCodeGoError) return error;
  const message = error instanceof Error ? error.message : String(error); const lower = message.toLowerCase(); const status = statusFromMessage(message);
  if (lower.includes('abort') || lower.includes('timeout')) return new OpenCodeGoError(lower.includes('timeout') ? 'TIMEOUT' : 'ABORTED', message, null, error);
  if (status === 401 || status === 403 || lower.includes('unauthorized') || lower.includes('api key')) return new OpenCodeGoError('AUTH_FAILURE', 'OpenCode Go authentication failed.', status, error);
  if (status === 402 || status === 429 || /quota|balance|usage limit|rate limit/.test(lower)) return new OpenCodeGoError('GO_QUOTA_EXHAUSTED', 'OpenCode Go quota or rate limit exhausted.', status, error);
  if (status === 404 || /model.*(not found|unavailable)|unknown model/.test(lower)) return new OpenCodeGoError('MODEL_UNAVAILABLE', 'OpenCode Go model is unavailable.', status, error);
  if (/parse api response|response as json|malformed|invalid json/.test(lower)) return new OpenCodeGoError('MALFORMED_RESPONSE', 'OpenCode Go returned a malformed response.', status, error);
  return new OpenCodeGoError('PROVIDER_FAILURE', 'OpenCode Go provider request failed.', status, error);
}

export interface OpenCodeGoRunnerOptions {
  /** Explicit source boundary; environment variables are never an implicit fallback. */
  credentialSource?: OpenCodeGoCredentialSource;
  /** Test-only in-memory credential injection. */
  explicitCredential?: string;
  /** In-memory handoff from the resolver; source remains explicit and recorded. */
  resolvedCredential?: string;
  benchmarkRunId?: string;
  requestTimeoutMs?: number;
}

export class OpenCodeGoApiRunner extends DeepInfraApiRunner {
  private readonly benchmarkRunId: string; private readonly pinnedModel: OpenCodeGoModel; private readonly requestTimeoutMs: number | null; private currentSessionId: string | null = null;
  protected override get apiUrl(): string { return `${resolveBaseUrl()}/chat/completions`; }
  constructor(model: string, sampling: { maxTokens?: number; temperature?: number } = {}, options: OpenCodeGoRunnerOptions = {}) {
    if (!isOpenCodeGoModel(model)) throw new OpenCodeGoError('MODEL_UNAVAILABLE', `OpenCode Go does not allow model "${model}".`);
    const credentialSource = options.credentialSource ?? 'opencode-auth-helper';
    const resolvedCredential = options.resolvedCredential?.trim();
    const resolution = resolvedCredential
      ? { credential: resolvedCredential, authStatus: 'PRESENT' as const, credentialSource }
      : resolveOpenCodeGoCredential({
          source: credentialSource,
          ...(credentialSource === 'explicit-test' ? { explicitCredential: options.explicitCredential } : {}),
        });
    super(model, 'OPENCODE_API_KEY', sampling, {
      provider: 'opencode',
      explicitCredential: resolution.credential,
    });
    this.pinnedModel = model; this.benchmarkRunId = options.benchmarkRunId?.trim() || `run-${randomUUID()}`;
    this.requestTimeoutMs = typeof options.requestTimeoutMs === 'number' && Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
      ? Math.floor(options.requestTimeoutMs) : null;
  }
  getLastOpenCodeSessionId(): string | null { return this.currentSessionId; }
  protected override getRequestHeadersExtras(): Record<string, string> { this.currentSessionId = `${this.benchmarkRunId}-${randomUUID()}`; return { 'x-opencode-session': this.currentSessionId }; }
  protected override validateObservedModelId(observedModelId: string | null): void { if (observedModelId !== this.pinnedModel) throw new OpenCodeGoError('MODEL_ATTRIBUTION_FAILURE', `OpenCode Go returned model "${observedModelId ?? 'UNKNOWN'}" for the pinned request.`); }
  override getLastInvocationMetadata(): RunnerInvocationMetadata | null { const metadata = super.getLastInvocationMetadata(); return metadata ? { ...metadata, provider: 'opencode-go' } : null; }
  private async withConfiguredTimeout<T>(operation: () => Promise<T>): Promise<T> {
    if (this.requestTimeoutMs === null) return operation();
    const previous = process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'];
    process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'] = String(this.requestTimeoutMs);
    try { return await operation(); } finally {
      if (previous === undefined) delete process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'];
      else process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'] = previous;
    }
  }
  override async execute<T>(prompt: string, schema: ZodType<T, unknown>, callbacks?: RunnerCallbacks, systemPrompt?: string, signal?: AbortSignal): Promise<T> { try { return await this.withConfiguredTimeout(() => super.execute(prompt, schema, callbacks, systemPrompt, signal)); } catch (error) { throw classifyError(error); } }
  override async executeRaw(prompt: string, callbacks?: RunnerCallbacks, systemPrompt?: string, signal?: AbortSignal): Promise<string> { try { return await this.withConfiguredTimeout(() => super.executeRaw(prompt, callbacks, systemPrompt, signal)); } catch (error) { throw classifyError(error); } }
}
