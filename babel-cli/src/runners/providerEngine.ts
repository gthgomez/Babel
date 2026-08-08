import type { ZodType } from 'zod'
import type {
  LlmRunner,
  ProviderMessage,
  RunnerCallbacks,
  RunnerInvocationMetadata,
  ToolDefinition,
  ToolStreamEvent,
} from './base.js'
import { ApiFallbackRunner } from './apiFallback.js'
import { DeepInfraApiRunner } from './deepInfraApi.js'
import { DeepSeekApiRunner } from './deepSeekApi.js'
import { GeminiApiRunner } from './geminiApi.js'
import { GroqApiRunner } from './groqApi.js'
import { OllamaApiRunner } from './ollamaApi.js'
import { OpenAiApiRunner } from './openAiApi.js'
import { OpenRouterApiRunner } from './openRouterApi.js'
import {
  providerSupportsOperation,
  type ProviderId,
  type ProviderOperation,
} from './providerRegistry.js'

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
  ) => AsyncGenerator<string, void, undefined>
}

export interface ProviderEngineOptions {
  provider: ProviderId
  modelId: string
  sampling?: { maxTokens?: number; temperature?: number }
  apiKeyEnvVar?: string
  explicitCredential?: string
  env?: NodeJS.ProcessEnv
}

function createAdapter(options: ProviderEngineOptions): RawLlmRunner {
  const credential = {
    ...(options.explicitCredential ? { explicitCredential: options.explicitCredential } : {}),
    ...(options.env ? { env: options.env } : {}),
  }
  const runtimeOptions = {
    modelId: options.modelId,
    ...(options.sampling?.maxTokens === undefined ? {} : { maxTokens: options.sampling.maxTokens }),
    ...(options.sampling?.temperature === undefined ? {} : { temperature: options.sampling.temperature }),
    ...credential,
  }
  switch (options.provider) {
    case 'deepinfra':
      return new DeepInfraApiRunner(
        options.modelId,
        options.apiKeyEnvVar ?? 'DEEPINFRA_API_KEY',
        options.sampling,
        { provider: 'deepinfra', ...credential },
      )
    case 'deepseek':
      return new DeepSeekApiRunner(options.modelId, credential)
    case 'openrouter':
      return new OpenRouterApiRunner(options.modelId, options.sampling, {
        ...(options.apiKeyEnvVar ? { apiKeyEnvVar: options.apiKeyEnvVar } : {}),
        ...credential,
      })
    case 'openai':
      return new OpenAiApiRunner(runtimeOptions)
    case 'anthropic':
      return new ApiFallbackRunner(runtimeOptions)
    case 'gemini':
      return new GeminiApiRunner(runtimeOptions)
    case 'ollama':
      return new OllamaApiRunner(options.modelId)
    case 'groq':
      return new GroqApiRunner(runtimeOptions) as RawLlmRunner
  }
}

/** Provider-neutral engine that delegates wire details to protocol adapters. */
export class ProviderEngine implements LlmRunner {
  readonly provider: ProviderId
  readonly modelId: string
  private readonly adapter: RawLlmRunner

  constructor(options: ProviderEngineOptions) {
    this.provider = options.provider
    this.modelId = options.modelId
    this.adapter = createAdapter(options)
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
  ): AsyncGenerator<string, void, undefined> {
    if (!this.adapter.executeRawStream) {
      throw new Error(`[ProviderEngine] ${this.provider} does not support raw chat streaming.`)
    }
    return this.adapter.executeRawStream(prompt, systemPrompt, signal)
  }

  executeWithToolsStream(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required',
  ): AsyncGenerator<ToolStreamEvent, void, undefined> {
    if (!this.adapter.executeWithToolsStream) {
      throw new Error(`[ProviderEngine] ${this.provider} does not support native tool streaming.`)
    }
    return this.adapter.executeWithToolsStream(messages, tools, systemPrompt, signal, toolChoice)
  }

  getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    return this.adapter.getLastInvocationMetadata?.() ?? null
  }

  supports(operation: ProviderOperation): boolean {
    return providerSupportsOperation(this.provider, operation)
  }
}

/** Construct a provider-neutral model runner. */
export function createProviderRunner(options: ProviderEngineOptions): ProviderEngine {
  return new ProviderEngine(options)
}
