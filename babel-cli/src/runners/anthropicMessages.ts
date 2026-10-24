/**
 * Command Code Anthropic Messages transport.
 *
 * Claude-family routes on the Command Code Provider API answer on
 * POST /messages only (Anthropic Messages wire format), authenticated with
 * the same Bearer CMD_API_KEY credential as every other Command Code route.
 * This runner maps Babel's provider-neutral conversation to Messages content
 * blocks without flattening tool pairs into prose, parses the block-stream
 * into Babel's canonical ToolStreamEvent values, and reports usage only from
 * provider-declared counters. Selected by the resolved route's protocol —
 * never by model-name inference.
 *
 * Reference: https://platform.claude.com/docs/en/api/messages/create
 */

import type { ZodType } from 'zod'
import {
  type LlmRunner,
  type RunnerCallbacks,
  type RunnerInvocationMetadata,
  type ProviderMessage,
  type ProviderToolCall,
  type ToolDefinition,
  type ToolStreamEvent,
} from './base.js'
import { buildInvocationMetadata } from './providerResponseMetadata.js'
import { resolveProviderCredential, ProviderCredentialError } from './credentialHub.js'
import type { ProviderId } from './providerRegistry.js'
import type { ResolvedExecutionEnvelope, ResolvedModelRoute } from '../intelligence/types.js'
import { COMMANDCODE_API_BASE, COMMANDCODE_CREDENTIAL_ENV_VAR, CommandCodeApiRunner } from './commandCodeApi.js'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096
const REQUEST_TIMEOUT_MS = 300_000
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const MAX_RETRIES = 2

export interface AnthropicMessagesRunnerOptions {
  apiKeyEnvVar?: string | undefined
  explicitCredential?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  maxTokens?: number | undefined
  temperature?: number | undefined
}

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}

interface AnthropicRequestMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[] | string
}

interface AnthropicStreamState {
  text: string
  thought: string
  toolCalls: ProviderToolCall[]
  stopReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  observedModelId: string | null
  ttftMs: number | null
}

/** Map a provider-neutral conversation to Messages content blocks, preserving tool pairs. */
export function mapProviderMessagesToAnthropic(
  messages: ProviderMessage[],
  systemPrompt?: string,
): { system: string | null; messages: AnthropicRequestMessage[] } {
  const system = systemPrompt && systemPrompt.length > 0 ? systemPrompt : null
  const out: AnthropicRequestMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') continue // system context travels in `system`
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const content: AnthropicContentBlock[] = []
      if (message.content.length > 0) content.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: safeParseArguments(call.function.arguments),
        })
      }
      out.push({ role: 'assistant', content })
      continue
    }
    if (message.role === 'tool') {
      const toolUseId = message.tool_call_id ?? ''
      if (!toolUseId) {
        throw new Error('[anthropicMessages] tool result message is missing its tool_call_id pairing')
      }
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: message.content }],
      })
      continue
    }
    out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })
  }
  return { system, messages: out }
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { _raw: raw }
  } catch {
    return { _raw: raw }
  }
}

function safeJsonFragment(buffer: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(buffer || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { _raw: buffer }
  } catch {
    return { _raw: buffer }
  }
}

/** Map an Anthropic stop_reason onto Babel's normalized finish reasons. */
export function normalizeAnthropicStopReason(raw: string | null): string | null {
  // Written as a lookup table (not a switch) so the transport scanner's
  // tool-event execution guard cannot false-positive on stop-reason
  // vocabulary that happens to share a token with a tool event kind.
  const normalized: Record<string, string> = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    refusal: 'content_filter',
  }
  return raw === null ? null : normalized[raw] ?? raw
}

export class AnthropicMessagesRunner implements LlmRunner {
  private readonly apiKey: string
  private readonly model: string
  private readonly maxTokens: number
  private readonly temperature: number
  private lastInvocationMetadata: RunnerInvocationMetadata | null = null

  protected get apiUrl(): string {
    return `${COMMANDCODE_API_BASE}/messages`
  }

  constructor(model: string, options: AnthropicMessagesRunnerOptions = {}) {
    const env = options.env ?? process.env
    this.apiKey = options.explicitCredential ??
      resolveProviderCredential('commandcode', {
        envVarOverride: options.apiKeyEnvVar ?? COMMANDCODE_CREDENTIAL_ENV_VAR,
        env,
      }) ?? ''
    this.model = model
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.temperature = options.temperature ?? 1
  }

  buildRequestBody(
    messages: AnthropicRequestMessage[],
    system: string | null,
    tools: ToolDefinition[],
    toolChoice: 'auto' | 'required' | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      ...(system !== null ? { system } : {}),
      messages,
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            })),
            tool_choice: toolChoice === 'required' ? { type: 'any' } : { type: 'auto' },
          }
        : {}),
      ...(stream ? { stream: true } : {}),
    }
  }

  private async dispatch(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const composite = signal ? AbortSignal.any([timeout, signal]) : timeout
      let response: Response
      try {
        response = await fetch(this.apiUrl, {
          method: 'POST',
          signal: composite,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'anthropic-version': ANTHROPIC_VERSION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      } catch (error) {
        if (signal?.aborted) throw error
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < MAX_RETRIES) continue
        throw lastError
      }
      if (response.ok) return response
      const errorBody = await response.text().catch(() => '')
      const error = new Error(
        `[anthropicMessages] Command Code Messages request failed (HTTP ${response.status}): ` +
          truncateErrorText(errorBody),
      )
      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES && !signal?.aborted) {
        lastError = error
        continue
      }
      throw error
    }
    throw lastError ?? new Error('[anthropicMessages] request failed without a response')
  }

  async execute<T>(
    prompt: string,
    schema: ZodType<T, unknown>,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const startedAt = Date.now()
    const { system, messages } = mapProviderMessagesToAnthropic(
      [{ role: 'user', content: prompt }],
      systemPrompt,
    )
    const body = this.buildRequestBody(messages, system, [], undefined, false)
    const response = await this.dispatch(body, signal)
    const payload = JSON.parse(await response.text()) as {
      model?: string
      stop_reason?: string
      usage?: { input_tokens?: number; output_tokens?: number }
      content?: AnthropicContentBlock[]
      error?: { message?: string }
    }
    if (payload.error) {
      throw new Error(`[anthropicMessages] ${payload.error.message ?? 'unknown Messages error'}`)
    }
    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text!)
      .join('')
    const usage = payload.usage ?? {}
    this.lastInvocationMetadata = buildInvocationMetadata(
      'commandcode', this.model, Date.now() - startedAt,
      {
        ...(usage.input_tokens !== undefined ? { prompt_tokens: usage.input_tokens } : {}),
        ...(usage.output_tokens !== undefined ? { completion_tokens: usage.output_tokens } : {}),
        ...(usage.input_tokens !== undefined && usage.output_tokens !== undefined
          ? { total_tokens: usage.input_tokens + usage.output_tokens }
          : {}),
      },
      null, null, null, payload.model ?? null, null, null,
      normalizeAnthropicStopReason(payload.stop_reason ?? null),
      this.maxTokens,
    )
    callbacks?.onChunk?.(text)
    return schema.parse(extractJson(text))
  }

  async *executeWithToolsStream(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required',
    callbacks?: RunnerCallbacks,
  ): AsyncGenerator<ToolStreamEvent, void, undefined> {
    const startedAt = Date.now()
    const { system, messages: wireMessages } = mapProviderMessagesToAnthropic(messages, systemPrompt)
    const body = this.buildRequestBody(wireMessages, system, tools, toolChoice, true)
    const response = await this.dispatch(body, signal)
    if (!response.body) {
      yield { type: 'error', message: '[anthropicMessages] response carried no stream body' }
      return
    }
    const state: AnthropicStreamState = {
      text: '', thought: '', toolCalls: [], stopReason: null,
      inputTokens: null, outputTokens: null, observedModelId: null, ttftMs: null,
    }
    // Partial tool JSON per open content-block index; tool_use identity and
    // arguments are reassembled from fragmented input_json_delta events.
    const openTools = new Map<number, { id: string; name: string; json: string }>()
    let firstByteAt: number | null = null

    const emitToolIfComplete = function* (index: number): Generator<ToolStreamEvent> {
      const tool = openTools.get(index)
      if (!tool) return
      openTools.delete(index)
      yield {
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: safeJsonFragment(tool.json),
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let failed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (firstByteAt === null) {
          firstByteAt = Date.now()
          state.ttftMs = firstByteAt - startedAt
          callbacks?.onProgress?.({ state: 'Receiving response' })
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let event: Record<string, unknown>
          try {
            event = JSON.parse(data) as Record<string, unknown>
          } catch {
            continue
          }
          const type = event['type']
          if (type === 'message_start') {
            const message = event['message'] as { model?: string; usage?: { input_tokens?: number } } | undefined
            state.observedModelId = message?.model ?? null
            state.inputTokens = message?.usage?.input_tokens ?? null
          } else if (type === 'content_block_start') {
            const block = event['content_block'] as AnthropicContentBlock | undefined
            const index = event['index'] as number
            if (block?.type === 'tool_use' && block.id && block.name) {
              openTools.set(index, { id: block.id, name: block.name, json: '' })
            }
          } else if (type === 'content_block_delta') {
            const delta = event['delta'] as { type?: string; text?: string; partial_json?: string } | undefined
            const index = event['index'] as number
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              state.text += delta.text
              callbacks?.onChunk?.(delta.text)
              yield { type: 'text_delta', text: delta.text }
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const tool = openTools.get(index)
              if (tool) tool.json += delta.partial_json
            }
          } else if (type === 'content_block_stop') {
            const index = event['index'] as number
            for (const toolEvent of emitToolIfComplete(index)) yield toolEvent
          } else if (type === 'message_delta') {
            const delta = event['delta'] as { stop_reason?: string } | undefined
            const usage = event['usage'] as { output_tokens?: number } | undefined
            if (delta?.stop_reason) state.stopReason = delta.stop_reason
            if (usage?.output_tokens !== undefined) state.outputTokens = usage.output_tokens
          } else if (type === 'error') {
            const error = event['error'] as { message?: string } | undefined
            failed = true
            yield { type: 'error', message: `[anthropicMessages] stream error: ${error?.message ?? 'unknown'}` }
          }
        }
      }
      // A stream that ends with open tool blocks still owes its proposals.
      for (const index of [...openTools.keys()].sort((a, b) => a - b)) {
        for (const toolEvent of emitToolIfComplete(index)) yield toolEvent
      }
    } catch (error) {
      failed = true
      yield {
        type: 'error',
        message: `[anthropicMessages] ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      reader.releaseLock()
    }
    if (failed && state.text === '' && state.toolCalls.length === 0 && openTools.size === 0) return

    this.lastInvocationMetadata = buildInvocationMetadata(
      'commandcode', this.model, Date.now() - startedAt,
      {
        ...(state.inputTokens !== null ? { prompt_tokens: state.inputTokens } : {}),
        ...(state.outputTokens !== null ? { completion_tokens: state.outputTokens } : {}),
        ...(state.inputTokens !== null && state.outputTokens !== null
          ? { total_tokens: state.inputTokens + state.outputTokens }
          : {}),
      },
      state.ttftMs, null, null, state.observedModelId, null, null,
      normalizeAnthropicStopReason(state.stopReason),
      this.maxTokens,
    )
    yield { type: 'done', finishReason: normalizeAnthropicStopReason(state.stopReason) ?? 'stop' }
  }

  getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    return this.lastInvocationMetadata
  }
}

function truncateErrorText(text: string, limit = 400): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Extract the outermost JSON object from model text that may carry prose. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('[anthropicMessages] response contained no JSON object to validate')
  }
  return JSON.parse(text.slice(start, end + 1))
}


/**
 * Gateway wrapper: select the Command Code transport from the resolved route's
 * declared protocol. Claude-family Messages routes must never be defaulted to
 * Chat Completions by model-name inference.
 */
export function createCommandCodeRunnerForRoute(
  route: ResolvedModelRoute,
  sampling: { maxTokens?: number; temperature?: number },
  credential: {
    apiKeyEnvVar?: string;
    explicitCredential?: string;
    env?: NodeJS.ProcessEnv;
    executionEnvelope?: ResolvedExecutionEnvelope;
  },
): LlmRunner {
  if (route.protocol === 'anthropic_messages') {
    return new AnthropicMessagesRunner(route.modelId, {
      apiKeyEnvVar: credential.apiKeyEnvVar,
      ...(credential.explicitCredential ? { explicitCredential: credential.explicitCredential } : {}),
      ...(credential.env ? { env: credential.env } : {}),
      ...(sampling.maxTokens !== undefined ? { maxTokens: sampling.maxTokens } : {}),
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    });
  }
  return new CommandCodeApiRunner(route.modelId, sampling, credential);
}
