import type { ZodType } from 'zod'
import type {
  LlmRunner,
  ProviderMessage,
  RunnerCallbacks,
  RunnerInvocationMetadata,
  ToolDefinition,
  ToolStreamEvent,
  ChatLlmRunner,
} from './base.js'
import { AnthropicApiRunner } from './anthropicApi.js'
import { DeepInfraApiRunner } from './deepInfraApi.js'
import { DeepSeekApiRunner } from './deepSeekApi.js'
import { GeminiApiRunner } from './geminiApi.js'
import { GroqApiRunner } from './groqApi.js'
import { OllamaApiRunner } from './ollamaApi.js'
import { OpenAiApiRunner } from './openAiApi.js'
import { OpenCodeApiRunner } from './openCodeApi.js'
import { OpenCodeGoApiRunner } from './openCodeGoApi.js'
import type { OpenCodeGoCredentialSource } from './openCodeGoCredential.js'
import type { OpenCodeGoBudget } from './openCodeGoBudget.js'
import { OpenRouterApiRunner } from './openRouterApi.js'
import { CommandCodeApiRunner } from './commandCodeApi.js'
import { CompatibleApiRunner } from './compatibleApi.js'
import { resolveProviderCredential } from './credentialHub.js'
import {
  providerSupportsOperation,
  type BenchmarkProviderId,
  type ProviderId,
  type ProviderOperation,
} from './providerRegistry.js'
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js'

interface RawLlmRunner extends LlmRunner {
  executeRaw?: (
    prompt: string,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ) => Promise<string>
  executeRawStream?: (
    prompt: string,
    systemPrompt?: string,
    signal?: AbortSignal,
    callbacks?: RunnerCallbacks,
  ) => AsyncGenerator<string, void, undefined>
}

export interface ProviderEngineOptions {
  /** Production providers plus explicitly benchmark-only adapters. */
  provider: ProviderId | BenchmarkProviderId
  modelId: string
  sampling?: { maxTokens?: number; temperature?: number }
  apiKeyEnvVar?: string
  explicitCredential?: string
  env?: NodeJS.ProcessEnv
  /** Shared caller-owned allowance ledger; required for the exact V4.1 Go pilot. */
  budget?: OpenCodeGoBudget
  /** Explicit Go credential source; default remains the approved helper. */
  credentialSource?: OpenCodeGoCredentialSource
  resolvedCredential?: string
  sessionId?: string
  benchmarkRunId?: string
  requestTimeoutMs?: number
  requireExactModelId?: boolean
  /** Explicit user-owned compatible endpoint; never read from project instructions. */
  baseUrl?: string
  contextWindowTokens?: number
  authentication?: 'api-key' | 'none'
  /** Optional immutable capability-resolved policy for this invocation lane. */
  executionEnvelope?: ResolvedExecutionEnvelope
}

export function createProviderAdapter(options: ProviderEngineOptions): RawLlmRunner {
  const credential = {
    ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}),
    ...(options.explicitCredential ? { explicitCredential: options.explicitCredential } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.executionEnvelope ? { executionEnvelope: options.executionEnvelope } : {}),
  }
  const runtimeOptions = {
    modelId: options.modelId,
    ...(options.sampling?.maxTokens === undefined ? {} : { maxTokens: options.sampling.maxTokens }),
    ...(options.sampling?.temperature === undefined ? {} : { temperature: options.sampling.temperature }),
    ...credential,
    ...(options.apiKeyEnvVar ? { apiKeyEnvVar: options.apiKeyEnvVar } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.authentication ? { authentication: options.authentication } : {}),
  }
  switch (options.provider) {
    case 'openai-compatible':
      if (!options.baseUrl) throw new Error('Custom compatible connections require an explicit base URL.')
      return new CompatibleApiRunner(options.modelId, { ...runtimeOptions, baseUrl: options.baseUrl })
    case 'command-code':
      return new CommandCodeApiRunner(options.modelId, options.sampling, {
        ...(options.apiKeyEnvVar ? { apiKeyEnvVar: options.apiKeyEnvVar } : {}),
        ...credential,
      })
    case 'deepinfra':
      return new DeepInfraApiRunner(
        options.modelId,
        options.apiKeyEnvVar ?? 'DEEPINFRA_API_KEY',
        options.sampling,
        { provider: 'deepinfra', ...credential },
      )
    case 'deepseek':
      return new DeepSeekApiRunner(options.modelId, { ...credential, ...(options.apiKeyEnvVar ? { envVarOverride: options.apiKeyEnvVar } : {}), ...(options.sampling?.maxTokens ? { maxTokens: options.sampling.maxTokens } : {}) })
    case 'openrouter':
      return new OpenRouterApiRunner(options.modelId, options.sampling, {
        ...(options.apiKeyEnvVar ? { apiKeyEnvVar: options.apiKeyEnvVar } : {}),
        ...credential,
        ...(options.requireExactModelId ? { requireExactModelId: true } : {}),
      })
    case 'opencode':
      return new OpenCodeApiRunner(options.modelId, options.sampling, {
        ...(options.apiKeyEnvVar ? { apiKeyEnvVar: options.apiKeyEnvVar } : {}),
        ...credential,
      })
    case 'opencode-go': {
      // Map the selected reference only inside this transport handoff. Missing
      // selected credentials must never fall back to the canonical account/helper.
      const env = options.apiKeyEnvVar ? { ...(options.env ?? process.env),
        BABEL_OPENCODE_GO_API_KEY: resolveProviderCredential('opencode-go', { env: options.env ?? process.env,
          envVarOverride: options.apiKeyEnvVar, ...(options.explicitCredential ? { explicitCredential: options.explicitCredential } : {}) }) ?? '' } : options.env
      return new OpenCodeGoApiRunner(options.modelId, options.sampling, {
        ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.resolvedCredential ? { resolvedCredential: options.resolvedCredential } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(env ? { env } : {}),
        ...(options.executionEnvelope ? { executionEnvelope: options.executionEnvelope } : {}),
        credentialSource: options.apiKeyEnvVar ? 'network-secret' : options.credentialSource ?? (options.explicitCredential ? 'explicit-test' :
          (options.env ?? process.env)['BABEL_OPENCODE_GO_API_KEY']?.trim() ? 'network-secret' : 'opencode-auth-helper'),
        ...(options.explicitCredential ? { explicitCredential: options.explicitCredential } : {}),
        ...(options.benchmarkRunId ? { benchmarkRunId: options.benchmarkRunId } : {}),
        ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      })
    }
    case 'opencode-zen':
      throw new Error('MODEL_UNAVAILABLE: benchmark provider opencode-zen is not registered in ProviderEngine.')
    case 'openai':
      return new OpenAiApiRunner(runtimeOptions)
    case 'anthropic':
      return new AnthropicApiRunner(runtimeOptions)
    case 'gemini':
      return new GeminiApiRunner(runtimeOptions)
    case 'ollama':
      return new OllamaApiRunner(options.modelId, { ...options.sampling, ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}) })
    case 'groq':
      return new GroqApiRunner(runtimeOptions) as RawLlmRunner
  }
}

/** Provider-neutral engine that delegates wire details to protocol adapters. */
export class ProviderEngine implements LlmRunner {
  readonly provider: ProviderId | BenchmarkProviderId
  readonly modelId: string
  private readonly adapter: RawLlmRunner

  constructor(options: ProviderEngineOptions) {
    this.provider = options.provider
    this.modelId = options.modelId
    this.adapter = createProviderAdapter(options)
  }

  /** Identity of the configured route, independent of any observed response. */
  getPinnedModelId(): string { return this.modelId }

  /** Compatibility accessor for retained OpenCode conversation consumers. */
  getLastOpenCodeSessionId(): string | null {
    const adapter = this.adapter as RawLlmRunner & { getLastOpenCodeSessionId?: () => string | null }
    return adapter.getLastOpenCodeSessionId?.() ?? null
  }

  /** Preserve the explicit task-owned Go allowance across cached construction. */
  usesBudget(budget: OpenCodeGoBudget): boolean {
    return this.adapter instanceof OpenCodeGoApiRunner && this.adapter.usesBudget(budget)
  }

  /** Serialize using the same adapter as dispatch, including vendor request fields. */
  buildNativeToolsWireBody(messages: ProviderMessage[], tools: ToolDefinition[], systemPrompt?: string,
    options?: { stream?: boolean; toolChoice?: 'auto' | 'required' }): string {
    const adapter = this.adapter as RawLlmRunner & { buildNativeToolsWireBody?: ProviderEngine['buildNativeToolsWireBody'] }
    if (!adapter.buildNativeToolsWireBody) throw new Error(`[${this.provider}] Native request serialization is unsupported.`)
    return adapter.buildNativeToolsWireBody(messages, tools, systemPrompt, options)
  }

  getNativeRequestReservedCompletionTokens(): number | null {
    const adapter = this.adapter as RawLlmRunner & { getNativeRequestReservedCompletionTokens?: () => number | null }
    return adapter.getNativeRequestReservedCompletionTokens?.() ?? null
  }

  execute<T>(
    prompt: string,
    schema: ZodType<T, unknown>,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.adapter.execute(prompt, schema, callbacks, systemPrompt, signal)
  }

  executeRaw(
    prompt: string,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.adapter.executeRaw) {
      throw new Error(`[ProviderEngine] ${this.provider} does not support raw chat execution.`)
    }
    return this.adapter.executeRaw(prompt, callbacks, systemPrompt, signal)
  }

  executeRawStream(
    prompt: string,
    systemPrompt?: string,
    signal?: AbortSignal,
    callbacks?: RunnerCallbacks,
  ): AsyncGenerator<string, void, undefined> {
    if (!this.adapter.executeRawStream) {
      throw new Error(`[ProviderEngine] ${this.provider} does not support raw chat streaming.`)
    }
    return this.adapter.executeRawStream(prompt, systemPrompt, signal, callbacks)
  }

  executeWithToolsStream(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required',
    callbacks?: RunnerCallbacks,
  ): AsyncGenerator<ToolStreamEvent, void, undefined> {
    if (!this.adapter.executeWithToolsStream) {
      throw new Error(`[ProviderEngine] ${this.provider} does not support native tool streaming.`)
    }
    return this.adapter.executeWithToolsStream(messages, tools, systemPrompt, signal, toolChoice, callbacks)
  }

  getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    return this.adapter.getLastInvocationMetadata?.() ?? null
  }

  supports(operation: ProviderOperation): boolean {
    if (this.provider === 'opencode-go') {
      return ['structured', 'raw', 'raw_stream', 'native_tool_stream'].includes(operation)
    }
    if (this.provider === 'opencode-zen') return false
    return providerSupportsOperation(this.provider, operation)
  }
}

/** Construct a provider-neutral model runner. */
export function createProviderRunner(options: ProviderEngineOptions): ProviderEngine {
  return new ProviderEngine(options)
}

/** Compatibility for callers needing the concrete adapter's qualified conversation operations. */
export function createChatProviderAdapter(options: ProviderEngineOptions): ChatLlmRunner {
  const adapter = createProviderAdapter(options)
  if (!adapter.executeRaw || !adapter.executeRawStream || !adapter.executeWithToolsStream || !adapter.getLastInvocationMetadata) {
    throw new Error(`[${options.provider}] Conversation inference is unsupported.`)
  }
  return adapter as ChatLlmRunner
}
