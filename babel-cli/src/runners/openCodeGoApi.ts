import { OpenCodeGoBudget, OpenCodeGoBudgetError } from './openCodeGoBudget.js'
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js'
import { randomUUID } from 'node:crypto'
import type { ZodType } from 'zod'

import type {
  ProviderMessage,
  RunnerCallbacks,
  RunnerInvocationMetadata,
  ToolDefinition,
  ToolStreamEvent,
} from './base.js'
import { DeepInfraApiRunner, type FetchRedirectPolicy } from './deepInfraApi.js'
import {
  resolveOpenCodeGoCredential,
  type OpenCodeGoCredentialSource,
} from './openCodeGoCredential.js'

/** The only OpenCode Go model identifiers accepted by this direct transport. */
export const OPENCODE_GO_MODELS = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'mimo-v2.5',
  'longcat-2.0',
] as const

export type OpenCodeGoModel = (typeof OPENCODE_GO_MODELS)[number]

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
/** Identifies Babel's explicit-only OpenCode Go transport to the provider. */
export const OPENCODE_GO_USER_AGENT = 'Babel/OpenCode-Go'
const OPENCODE_GO_DEFAULT_TIMEOUT_MS = 85_000
const OPENCODE_GO_MAX_TIMEOUT_MS = 120_000

export type OpenCodeGoErrorCode =
  | 'GO_BUDGET_DENIED'
  | 'AUTH_FAILURE'
  | 'GO_QUOTA_EXHAUSTED'
  | 'MODEL_UNAVAILABLE'
  | 'MALFORMED_RESPONSE'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'MODEL_ATTRIBUTION_FAILURE'
  | 'PROVIDER_FAILURE'

/** Typed, content-free failure from the direct OpenCode Go transport. */
export class OpenCodeGoError extends Error {
  readonly code: OpenCodeGoErrorCode
  readonly httpStatus: number | null

  constructor(
    code: OpenCodeGoErrorCode,
    message: string,
    httpStatus: number | null = null,
  ) {
    super(message)
    this.name = 'OpenCodeGoError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface OpenCodeGoRunnerOptions {
  /** Default production source; never falls back to an environment key. */
  budget?: OpenCodeGoBudget
  env?: NodeJS.ProcessEnv
  executionEnvelope?: ResolvedExecutionEnvelope
  benchmarkRunId?: string
  credentialSource?: OpenCodeGoCredentialSource
  /** Test-only in-memory credential injection. */
  explicitCredential?: string
  /** In-memory handoff from an approved resolver. */
  resolvedCredential?: string
  /** Stable provider session identity, injectable for deterministic callers. */
  sessionId?: string
  /** Per-request timeout, capped locally for this transport only. */
  requestTimeoutMs?: number
}

/** Return whether a model id is an exact supported OpenCode Go model. */
export function isOpenCodeGoModel(value: string): value is OpenCodeGoModel {
  return (OPENCODE_GO_MODELS as readonly string[]).includes(value)
}

function statusFromMessage(message: string): number | null {
  const match = message.match(/HTTP (\d{3})/i)
  return match ? Number(match[1]) : null
}

function classifyError(error: unknown): OpenCodeGoError {
  if (error instanceof OpenCodeGoError) return error
  if (error instanceof OpenCodeGoBudgetError) return new OpenCodeGoError('GO_BUDGET_DENIED', error.message)
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('opencode go budget denied')) return new OpenCodeGoError('GO_BUDGET_DENIED', 'OpenCode Go budget denied the request.')
  const status = statusFromMessage(message)
  if (lower.includes('abort') || lower.includes('timeout')) {
    return new OpenCodeGoError(lower.includes('timeout') ? 'TIMEOUT' : 'ABORTED', 'OpenCode Go request was interrupted.', status)
  }
  if (status === 401 || status === 403 || lower.includes('unauthorized') || lower.includes('api key')) {
    return new OpenCodeGoError('AUTH_FAILURE', 'OpenCode Go authentication failed.', status)
  }
  if (status === 402 || status === 429 || /quota|balance|usage limit|rate limit/.test(lower)) {
    return new OpenCodeGoError('GO_QUOTA_EXHAUSTED', 'OpenCode Go quota or rate limit exhausted.', status)
  }
  if (status === 404 || /model.*(not found|unavailable)|unknown model/.test(lower)) {
    return new OpenCodeGoError('MODEL_UNAVAILABLE', 'OpenCode Go model is unavailable.', status)
  }
  if (/parse api response|response as json|malformed|invalid json/.test(lower)) {
    return new OpenCodeGoError('MALFORMED_RESPONSE', 'OpenCode Go returned a malformed response.', status)
  }
  return new OpenCodeGoError('PROVIDER_FAILURE', 'OpenCode Go provider request failed.', status)
}

/**
 * OpenAI-compatible direct transport for explicit OpenCode Go use. It pins
 * both the endpoint and model allowlist, and maintains one session header for
 * the runner lifetime without selecting any fallback provider.
 */
export class OpenCodeGoApiRunner extends DeepInfraApiRunner {
  private readonly budget: OpenCodeGoBudget | undefined
  private readonly outputTokenLimit: number
  private readonly pinnedModel: OpenCodeGoModel
  private readonly sessionId: string
  private readonly requestTimeoutMs: number

  protected override get apiUrl(): string {
    return `${OPENCODE_GO_BASE_URL}/chat/completions`
  }

  constructor(
    model: string,
    sampling: { maxTokens?: number; temperature?: number } = {},
    options: OpenCodeGoRunnerOptions = {},
  ) {
    if (!isOpenCodeGoModel(model)) {
      throw new OpenCodeGoError('MODEL_UNAVAILABLE', `OpenCode Go does not allow model "${model}".`)
    }
    if (model === 'deepseek-v4.1-flash' && !options.budget) throw new OpenCodeGoBudgetError()
    const credentialSource = options.credentialSource ?? 'opencode-auth-helper'
    const resolvedCredential = credentialSource === 'network-secret' ? undefined : options.resolvedCredential?.trim()
    const resolution = resolvedCredential
      ? { credential: resolvedCredential }
      : resolveOpenCodeGoCredential({
          source: credentialSource,
          ...(options.env ? { env: options.env } : {}),
          ...(credentialSource === 'explicit-test' ? { explicitCredential: options.explicitCredential } : {}),
        })
    super(model, 'OPENCODE_GO_AUTH_HELPER', sampling, {
      provider: 'opencode-go',
      explicitCredential: resolution.credential,
      ...(options.executionEnvelope ? { executionEnvelope: options.executionEnvelope } : {}),
    })
    this.outputTokenLimit = options.executionEnvelope?.output.effective ?? sampling.maxTokens ?? Number.MAX_SAFE_INTEGER
    this.budget = options.budget
    this.pinnedModel = model
    this.sessionId = options.sessionId?.trim() || options.benchmarkRunId?.trim() || `opencode-go-${randomUUID()}`
    this.requestTimeoutMs = typeof options.requestTimeoutMs === 'number' &&
      Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
      ? Math.min(Math.floor(options.requestTimeoutMs), OPENCODE_GO_MAX_TIMEOUT_MS)
      : OPENCODE_GO_DEFAULT_TIMEOUT_MS
  }

  protected override async dispatchFetch(url: string, init: RequestInit): Promise<Response> {
    if (url !== this.apiUrl || init.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string') {
      throw new OpenCodeGoBudgetError()
    }
    let body: { model?: unknown; max_tokens?: unknown }
    try { body = JSON.parse(init.body) as typeof body } catch { throw new OpenCodeGoBudgetError() }
    if (body.model !== this.pinnedModel || !Number.isSafeInteger(body.max_tokens) ||
      (body.max_tokens as number) <= 0 || (body.max_tokens as number) > this.outputTokenLimit) {
      throw new OpenCodeGoBudgetError()
    }
    if (this.pinnedModel === 'deepseek-v4.1-flash' && !this.budget) throw new OpenCodeGoBudgetError()
    if (init.signal?.aborted) throw new OpenCodeGoError('ABORTED', 'OpenCode Go request was interrupted.')
    await this.budget?.reserve(Buffer.byteLength(init.body, 'utf8'), body.max_tokens as number)
    if (init.signal?.aborted) throw new OpenCodeGoError('ABORTED', 'OpenCode Go request was interrupted.')
    return super.dispatchFetch(url, init)
  }

  /** Return the stable session header assigned to this runner. */
  getLastOpenCodeSessionId(): string {
    return this.sessionId
  }

  /** Content-free configured identity for secondary calls that must retain this route. */
  getPinnedModelId(): OpenCodeGoModel {
    return this.pinnedModel
  }

  protected override getRequestHeadersExtras(): Record<string, string> {
    return {
      'x-opencode-session': this.sessionId,
      'User-Agent': OPENCODE_GO_USER_AGENT,
    }
  }

  protected override getRequestTimeoutMs(): number {
    return this.requestTimeoutMs
  }

  protected override getRequestMaxRetries(): number {
    // The shared runner uses this legacy-named setting as an attempt ceiling.
    // One attempt means the initial request only: no automatic retry.
    return 1
  }

  protected override getStreamMaxRetries(): number {
    return 0
  }

  protected override getRequestRedirect(): FetchRedirectPolicy {
    return 'error'
  }

  protected override validateObservedModelId(observedModelId: string | null): void {
    if (!observedModelId?.trim() || observedModelId !== this.pinnedModel) {
      throw new OpenCodeGoError(
        'MODEL_ATTRIBUTION_FAILURE',
        'OpenCode Go did not return the requested model identity.',
      )
    }
  }

  override getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    const metadata = super.getLastInvocationMetadata()
    return metadata ? { ...metadata, provider: 'opencode-go' } : null
  }

  override async execute<T>(
    prompt: string,
    schema: ZodType<T, unknown>,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      if (signal?.aborted) throw new OpenCodeGoError('ABORTED', 'OpenCode Go request was interrupted.')
      return await super.execute(prompt, schema, callbacks, systemPrompt, signal)
    } catch (error) {
      throw classifyError(error)
    }
  }

  override async executeRaw(
    prompt: string,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      if (signal?.aborted) throw new OpenCodeGoError('ABORTED', 'OpenCode Go request was interrupted.')
      return await super.executeRaw(prompt, callbacks, systemPrompt, signal)
    } catch (error) {
      throw classifyError(error)
    }
  }

  override async *executeRawStream(
    prompt: string,
    systemPrompt?: string,
    signal?: AbortSignal,
    callbacks?: RunnerCallbacks,
  ): AsyncGenerator<string, void, undefined> {
    try {
      if (signal?.aborted) throw new OpenCodeGoError('ABORTED', 'OpenCode Go request was interrupted.')
      yield* super.executeRawStream(prompt, systemPrompt, signal, callbacks)
    } catch (error) {
      throw classifyError(error)
    }
  }

  override async *executeWithToolsStream(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required',
    callbacks?: RunnerCallbacks,
  ): AsyncGenerator<ToolStreamEvent, void, undefined> {
    try {
      if (signal?.aborted) throw new OpenCodeGoError('ABORTED', 'OpenCode Go request was interrupted.')
      yield* super.executeWithToolsStream(messages, tools, systemPrompt, signal, toolChoice, callbacks)
    } catch (error) {
      throw classifyError(error)
    }
  }
}
