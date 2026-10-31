/** Shared lifecycle for native message protocols; adapters own only wire translation. */
import { createHash, randomUUID } from 'node:crypto'
import type { ZodType } from 'zod'
import type { ChatLlmRunner, ProviderMessage, ProviderToolCall, RunnerCallbacks, RunnerInvocationMetadata, ToolDefinition, ToolStreamEvent, ProviderInvocationCompleted } from '../base.js'
import { buildStructuredOutputError } from '../base.js'
import { resolveProviderCredential } from '../credentialHub.js'
import { prepareProviderRequest, assertPreparedProviderRequestAdmissible } from '../preparedProviderRequest.js'
import { CampaignPhysicalFetchSession } from '../providerCampaignPhysicalFetch.js'
import { buildInvocationMetadata } from '../providerResponseMetadata.js'
import { buildProviderFailureReceipt } from '../providerFailureReceipt.js'
import { getRequestTimeoutMs, getRequestMaxRetries, linkExternalAbortSignal, retryDelayMs, sleep } from '../providerResponsePolicy.js'
import { getStreamIdleTimeoutMs, readStreamWithLimits } from '../providerResponseStream.js'
import { isRetryableStatus } from '../providerNormalize.js'
import { dispatchRunOperation, RunStoppedError } from '../../runtime/run-control.js'
import { extractJson } from '../../utils/extractJson.js'
import { validateProviderBaseUrl } from '../providerEndpoint.js'

export interface NativeRunnerOptions {
  explicitCredential?: string
  env?: NodeJS.ProcessEnv
  apiKeyEnvVar?: string
  modelId?: string
  maxTokens?: number
  temperature?: number
  baseUrl?: string
  contextWindowTokens?: number
  authentication?: 'api-key' | 'none'
}
export interface NativeStreamState {
  model: string | null
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  complete: boolean
  parts: Record<string, unknown>[]
  outputMaterial: string
  calls: Map<number, { id: string; name: string; arguments: string; providerMetadata?: ProviderToolCall['providerMetadata'] }>
}

/** Require an object at JSON boundaries without exposing raw provider payloads in errors. */
export function nativeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed native provider response object.')
  return value as Record<string, unknown>
}

export abstract class NativeMessagesRunner implements ChatLlmRunner {
  protected readonly apiKey: string
  protected readonly model: string
  protected readonly maxTokens: number
  protected readonly temperature: number | undefined
  protected readonly baseUrl: string | undefined
  private readonly contextWindowTokens: number | undefined
  private metadata: RunnerInvocationMetadata | null = null

  constructor(protected readonly provider: 'gemini' | 'anthropic', defaultModel: string, options: NativeRunnerOptions = {}) {
    if (options.baseUrl) validateProviderBaseUrl(options.baseUrl)
    this.apiKey = resolveProviderCredential(provider, { ...options, ...(options.apiKeyEnvVar ? { envVarOverride: options.apiKeyEnvVar } : {}) }) ?? ''
    this.model = options.modelId ?? defaultModel
    this.maxTokens = options.maxTokens ?? 8192
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens <= 0) throw new Error('Output token budget must be a positive integer.')
    this.temperature = options.temperature
    this.baseUrl = options.baseUrl
    this.contextWindowTokens = options.contextWindowTokens
  }

  protected abstract endpoint(stream: boolean): string
  protected abstract headers(): Record<string, string>
  abstract buildNativeToolsWireBody(messages: ProviderMessage[], tools: ToolDefinition[], systemPrompt?: string,
    options?: { stream?: boolean; toolChoice?: 'auto' | 'required' }): string
  protected abstract bufferedFrames(frame: Record<string, unknown>): Record<string, unknown>[]
  protected abstract consume(frame: Record<string, unknown>, state: NativeStreamState): ToolStreamEvent[]
  getLastInvocationMetadata(): RunnerInvocationMetadata | null { return this.metadata }
  getNativeRequestReservedCompletionTokens(): number { return this.maxTokens }

  async execute<T>(prompt: string, schema: ZodType<T, unknown>, callbacks?: RunnerCallbacks, systemPrompt?: string, signal?: AbortSignal): Promise<T> {
    const text = await this.executeRaw(prompt, callbacks, `${systemPrompt ?? ''}\nReturn a single valid JSON object matching the requested schema.`, signal)
    try { return schema.parse(extractJson(text)) }
    catch (cause) { throw buildStructuredOutputError({ provider: this.provider, model: this.model, failure_kind: 'invalid_json', message: `[${this.provider}] Structured output did not match the requested schema.`, raw_output: text, ...(cause instanceof Error ? { cause } : {}) }) }
  }

  async executeRaw(prompt: string, callbacks?: RunnerCallbacks, systemPrompt?: string, signal?: AbortSignal): Promise<string> {
    let text = ''
    for await (const event of this.executeNative([{ role: 'user', content: prompt }], [], systemPrompt, signal, 'auto', callbacks, Boolean(callbacks?.onChunk))) {
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'text_delta') { text += event.text; await callbacks?.onChunk?.(event.text) }
      if (event.type === 'thought_delta') callbacks?.onThought?.(event.text)
      if (event.type === 'done' && event.finishReason === 'length') throw new Error(`[${this.provider}] Output token limit reached (finish_reason: length).`)
    }
    return text
  }

  async *executeRawStream(prompt: string, systemPrompt?: string, signal?: AbortSignal, callbacks?: RunnerCallbacks): AsyncGenerator<string, void, undefined> {
    for await (const event of this.executeWithToolsStream([{ role: 'user', content: prompt }], [], systemPrompt, signal, 'auto', callbacks)) {
      if (event.type === 'text_delta') yield event.text
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'done' && event.finishReason === 'length') throw new Error(`[${this.provider}] Output token limit reached (finish_reason: length).`)
    }
  }

  executeWithToolsStream(messages: ProviderMessage[], tools: ToolDefinition[], systemPrompt?: string,
    signal?: AbortSignal, toolChoice: 'auto' | 'required' = 'auto', callbacks?: RunnerCallbacks): AsyncGenerator<ToolStreamEvent, void, undefined> {
    return this.executeNative(messages, tools, systemPrompt, signal, toolChoice, callbacks, true)
  }

  protected async *executeNative(messages: ProviderMessage[], tools: ToolDefinition[], systemPrompt?: string,
    signal?: AbortSignal, toolChoice: 'auto' | 'required' = 'auto', callbacks?: RunnerCallbacks, stream = true): AsyncGenerator<ToolStreamEvent, void, undefined> {
    this.metadata = null
    const startedAt = Date.now()
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    const stop = callbacks?.runControl?.stop()
    if (stop) throw new RunStoppedError(stop)
    const request = prepareProviderRequest({ body: this.buildNativeToolsWireBody(messages, tools, systemPrompt, { stream, toolChoice }),
      ...(this.contextWindowTokens ? { contextLimitTokens: this.contextWindowTokens, contextLimitSource: 'explicit' as const } : {}),
      mode: 'native', provider: this.provider, requestedModelId: this.model, reservedCompletionTokens: this.maxTokens,
      ...(callbacks?.parentRequestId !== undefined ? { parentRequestId: callbacks.parentRequestId } : {}) })
    assertPreparedProviderRequestAdmissible(request)
    const session = new CampaignPhysicalFetchSession(callbacks)
    const controller = new AbortController()
    const unlink = linkExternalAbortSignal(controller, signal)
    const controlUnlink = linkExternalAbortSignal(controller, callbacks?.runControl?.signal)
    const timeout = getRequestTimeoutMs()
    const deadline = Date.now() + timeout
    const timer = setTimeout(() => controller.abort(), timeout)
    const state: NativeStreamState = { model: null, finishReason: null, inputTokens: null, outputTokens: null, complete: false, parts: [], outputMaterial: '', calls: new Map() }
    const attempts = Math.max(1, getRequestMaxRetries())
    let response: Response | undefined
    let attempt = 0
    let emittedToolCalls = 0
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let startedNotified = false
    let delivered = false
    let completion: ProviderInvocationCompleted | undefined
    let physicalAttemptId = request.attempt_id
    let pendingRetry: { attempt: number; id: string } | undefined
    const settleRetry = (outcome: 'succeeded' | 'failed' | 'cancelled'): void => {
      if (!pendingRetry) return
      const pending = pendingRetry
      pendingRetry = undefined
      callbacks?.onRetrySettled?.({ provider: this.provider, model: this.model, attempt: pending.attempt, outcome,
        request_id: request.request_id, attempt_id: pending.id, body_digest: request.body_digest })
    }
    const captureMetadata = (): void => {
      if (state.model === null && state.inputTokens === null && state.outputTokens === null) return
      this.metadata = buildInvocationMetadata(this.provider, this.model, Date.now() - startedAt,
        { ...(state.inputTokens !== null ? { prompt_tokens: state.inputTokens } : {}), ...(state.outputTokens !== null ? { completion_tokens: state.outputTokens } : {}) },
        null, null, null, state.model, null, null, state.finishReason, this.maxTokens)
    }
    const phase = (phase: import('../base.js').ProviderInvocationPhase): void => { callbacks?.onInvocationPhase?.({ inference_id: request.request_id, provider: this.provider, model: this.model, phase }) }
    try {
      callbacks?.onInvocationStarted?.({ inference_id: request.request_id, request_id: request.request_id, attempt_id: request.attempt_id,
        provider: this.provider, requested_model_id: this.model, normalized_model_id: this.model, sent_model_id: this.model,
        input_digest: request.body_digest, input_bytes: request.body_bytes, accounting_kind: request.accounting_kind,
        context_limit_tokens: request.context_limit_tokens, context_limit_source: request.context_limit_source,
        effective_output_budget: this.maxTokens, delivered_tool_call_ids: messages.filter(message => message.role === 'tool').flatMap(message => message.tool_call_id ? [message.tool_call_id] : []),
        capability_bindings: tools.map(tool => ({ capability: tool.function.name, advertised: true, authorized: null, effective: null })) })
      startedNotified = true
      phase('request_created')
      for (attempt = 1; attempt <= attempts; attempt++) {
        const attemptId = physicalAttemptId
        let transportFailed = false
        try {
          response = await session.dispatchAdmittedFetch({ basePrepared: request, physicalAttemptId: attemptId, operationId: request.request_id,
            ...(callbacks?.runControl ? { runControl: callbacks.runControl } : {}),
            fetch: () => dispatchRunOperation(callbacks?.runControl, 'model', request.request_id, async () => {
              try { phase('request_dispatched'); return await fetch(this.endpoint(stream), { method: 'POST', headers: this.headers(), body: request.body, signal: controller.signal, redirect: 'error' }) }
              catch (error) { transportFailed = true; throw error }
            }) })
          if (response.ok || !isRetryableStatus(response.status) || attempt === attempts) break
          await response.body?.cancel()
        } catch (error) {
          if (!transportFailed || controller.signal.aborted || error instanceof RunStoppedError || attempt === attempts) throw error
        }
        session.settleUnknownOnOpenAdmission()
        settleRetry('failed')
        const backoff = retryDelayMs(attempt, response)
        physicalAttemptId = randomUUID()
        pendingRetry = { attempt: attempt + 1, id: physicalAttemptId }
        callbacks?.onRetry?.({ provider: this.provider, model: this.model, attempt: attempt + 1, reason: response?.status === 429 ? 'rate_limit' : response ? 'server_error' : 'transport', backoff_ms: backoff,
          request_id: request.request_id, attempt_id: physicalAttemptId, body_digest: request.body_digest })
        await sleep(backoff, controller.signal)
      }
      phase('response_started')
      if (!response?.ok) throw new Error(`[${this.provider}] HTTP ${response?.status ?? 'unavailable'} (${this.model}).`)
      if (!response.body) throw new Error(`[${this.provider}] Streaming response had no body.`)
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      while (true) {
        const chunk = await readStreamWithLimits(reader, { idleTimeoutMs: getStreamIdleTimeoutMs(), deadlineAt: deadline, requestTimeoutMs: timeout,
          signal: controller.signal, idleMessage: `[${this.provider}] stream idle timeout`, deadlineMessage: `[${this.provider}] request timeout` })
        if (!chunk.done) phase(state.outputMaterial ? 'stream_progress' : 'first_byte')
        pending = (pending + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, '\n')
        if (pending.length > 4 * 1024 * 1024) throw new Error(`[${this.provider}] SSE frame exceeds the supported limit.`)
        if (chunk.done && pending.trim()) pending += '\n\n'
        if (!stream) {
          if (!chunk.done) continue
          for (const frame of this.bufferedFrames(nativeRecord(JSON.parse(pending)))) {
            for (const event of this.consume(frame, state)) {
              yield event
            }
          }
          break
        }
        let boundary: number
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data || data === '[DONE]') continue
          for (const event of this.consume(nativeRecord(JSON.parse(data)), state)) {
            yield event
          }
        }
        if (chunk.done) break
      }
      if (!state.complete || !state.finishReason) throw new Error(`[${this.provider}] Stream closed before a terminal event.`)
      this.metadata = buildInvocationMetadata(this.provider, this.model, Date.now() - startedAt,
        { ...(state.inputTokens !== null ? { prompt_tokens: state.inputTokens } : {}), ...(state.outputTokens !== null ? { completion_tokens: state.outputTokens } : {}) },
        null, null, null, state.model, null, null, state.finishReason, this.maxTokens)
      if (state.finishReason !== 'length') {
        const ids = new Set<string>()
        const calls: Array<Extract<ToolStreamEvent, { type: 'tool_use' }>> = []
        for (const call of state.calls.values()) {
          const input = nativeRecord(JSON.parse(call.arguments || '{}'))
          if (!call.id || !call.name || ids.has(call.id)) throw new Error(`[${this.provider}] Missing or duplicate tool identity.`)
          ids.add(call.id)
          calls.push({ type: 'tool_use', id: call.id, name: call.name, input, ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}) })
        }
        for (const call of calls) { emittedToolCalls++; yield call }
      }
      phase('stream_completed')
      phase('response_normalized')
      delivered = true
      yield { type: 'done', finishReason: state.finishReason }
    } catch (error) {
      if (startedNotified) phase('provider_error')
      captureMetadata()
      const message = controller.signal.aborted ? `[${this.provider}] ${signal?.aborted || callbacks?.runControl?.signal.aborted ? 'Request cancelled' : 'request timeout'}` : error instanceof Error ? error.message : `[${this.provider}] Provider request failed.`
      const receipt = buildProviderFailureReceipt({ inferenceId: request.request_id, provider: this.provider, model: this.model,
        details: { message, ...(response ? { status: response.status } : {}) }, actualAttempt: attempt, maxAttempts: attempts,
        stream, failureStage: response?.ok ? 'stream' : 'request', inferenceStarted: Boolean(response?.ok), partialModelOutput: Boolean(state.outputMaterial), toolCallCount: emittedToolCalls,
        requestedOutputBudget: this.maxTokens, effectiveOutputBudget: this.maxTokens, outputMaterial: state.outputMaterial })
      completion = { inference_id: request.request_id, provider: this.provider, model: this.model, status: 'failed', failure_receipt: receipt, failure_class: receipt.failure_class, failure_stage: receipt.failure_stage,
        inference_started: receipt.inference_started, partial_model_output: receipt.partial_model_output, retryable: receipt.retryable,
        actual_attempt: receipt.actual_attempt, max_attempts: receipt.max_attempts, stream: receipt.stream, tool_call_count: receipt.tool_call_count,
        usage_metadata: this.metadata, observed_model_id: state.model, http_status: response?.status ?? null }
      if (error instanceof RunStoppedError) throw error
      yield { type: 'error', message }
    } finally {
      clearTimeout(timer)
      if (signal && unlink) signal.removeEventListener('abort', unlink)
      if (callbacks?.runControl && controlUnlink) callbacks.runControl.signal.removeEventListener('abort', controlUnlink)
      captureMetadata()
      if (reader) await reader.cancel().catch(() => {})
      else await response?.body?.cancel().catch(() => {})
      if (!completion && !delivered) {
        const receipt = buildProviderFailureReceipt({ inferenceId: request.request_id, provider: this.provider, model: this.model,
          details: { message: `[${this.provider}] Provider stream was closed before delivery completed.`, ...(response ? { status: response.status } : {}) },
          actualAttempt: attempt, maxAttempts: attempts, stream, failureStage: response?.ok ? 'stream' : 'request',
          inferenceStarted: Boolean(response?.ok), partialModelOutput: Boolean(state.outputMaterial), toolCallCount: emittedToolCalls,
          requestedOutputBudget: this.maxTokens, effectiveOutputBudget: this.maxTokens, outputMaterial: state.outputMaterial })
        completion = { inference_id: request.request_id, provider: this.provider, model: this.model, status: 'failed', failure_receipt: receipt,
          failure_class: receipt.failure_class, failure_stage: receipt.failure_stage, usage_metadata: this.metadata, observed_model_id: state.model }
      }
      completion ??= { inference_id: request.request_id, provider: this.provider, model: this.model, status: delivered ? 'delivered' : 'failed',
        usage_metadata: this.metadata, observed_model_id: state.model, output_digest: createHash('sha256').update(state.outputMaterial).digest('hex'), normalized_finish_reason: state.finishReason }
      completion.output_digest ??= completion.failure_receipt?.output_digest ?? null
      completion.requested_output_budget = this.maxTokens
      completion.effective_output_budget = this.maxTokens
      completion.tool_call_count = emittedToolCalls
      if (callbacks?.campaignMeter) completion.campaign_ledger_settled_by_transport = true
      session.finalizeInvocation(completion.status, completion)
      if (startedNotified) callbacks?.onInvocationCompleted?.(completion)
      settleRetry(delivered ? 'succeeded' : controller.signal.aborted ? 'cancelled' : 'failed')
    }
  }
}
