/** Direct OpenAI Chat Completions adapter over the shared protocol. */
import { OpenAiCompatibleRunner } from './protocol/openai-chat-completions.js'
import type { NativeRunnerOptions } from './protocol/native-messages.js'
import type { ProviderMessage, ToolDefinition } from './base.js'
import { validateProviderBaseUrl } from './providerEndpoint.js'

export class OpenAiApiRunner extends OpenAiCompatibleRunner {
  private readonly endpointBase: string
  private readonly explicitTemperature: boolean
  protected override get apiUrl(): string { return `${this.endpointBase.replace(/\/$/, '')}/chat/completions` }
  protected override getRequestRedirect(): 'error' { return 'error' }

  constructor(options: NativeRunnerOptions = {}) {
    if (options.baseUrl) validateProviderBaseUrl(options.baseUrl)
    const env = options.env ?? process.env
    const model = options.modelId ?? env['BABEL_OPENAI_MODEL'];
    if (!model) throw new Error('SETUP_REQUIRED: Select an exact OpenAI model; no model is chosen automatically.');
    super(model, options.apiKeyEnvVar ?? 'OPENAI_API_KEY',
      { maxTokens: options.maxTokens ?? Number(env['BABEL_OPENAI_TOKENS'] ?? 8096), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}) },
      { provider: 'openai', ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}), ...(options.explicitCredential ? { explicitCredential: options.explicitCredential } : {}), ...(options.env ? { env: options.env } : {}) })
    this.endpointBase = options.baseUrl ?? 'https://api.openai.com/v1'
    this.explicitTemperature = options.temperature !== undefined
  }

  private nativeBody(body: Record<string, unknown>): Record<string, unknown> {
    const result = { ...body }
    if (result['max_tokens'] !== undefined) { result['max_completion_tokens'] = result['max_tokens']; delete result['max_tokens'] }
    if (!this.explicitTemperature) delete result['temperature']
    if (Array.isArray(result['tools']) && !result['tools'].length) { delete result['tools']; delete result['tool_choice'] }
    return result
  }
  protected override sealCampaignWireBody(body: Record<string, unknown>): Record<string, unknown> { return this.nativeBody(body) }
  override buildNativeToolsWireBody(messages: ProviderMessage[], tools: ToolDefinition[], systemPrompt?: string,
    options?: { stream?: boolean; toolChoice?: 'auto' | 'required' }): string {
    return JSON.stringify(this.nativeBody(JSON.parse(super.buildNativeToolsWireBody(messages, tools, systemPrompt, options)) as Record<string, unknown>))
  }
}
