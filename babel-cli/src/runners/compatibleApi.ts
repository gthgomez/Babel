/** Explicit custom Chat Completions connection; no vendor or endpoint guessing. */
import { OpenAiCompatibleRunner } from './protocol/openai-chat-completions.js'
import type { NativeRunnerOptions } from './protocol/native-messages.js'
import { validateProviderBaseUrl } from './providerEndpoint.js'

export class CompatibleApiRunner extends OpenAiCompatibleRunner {
  private readonly endpoint: string
  private readonly authentication: 'api-key' | 'none'
  protected override get apiUrl(): string { return this.endpoint }
  protected override getRequestRedirect(): 'error' { return 'error' }
  protected override getAuthenticationHeaders(): Record<string, string> { return this.authentication === 'none' ? {} : super.getAuthenticationHeaders() }
  constructor(model: string, options: NativeRunnerOptions & { baseUrl: string }) {
    validateProviderBaseUrl(options.baseUrl)
    super(model, options.apiKeyEnvVar ?? 'BABEL_COMPATIBLE_API_KEY',
      { ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}) },
      { provider: 'openai-compatible', ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}), ...(options.authentication === 'none' ? { explicitCredential: 'no-auth-required' } : {}), ...(options.explicitCredential ? { explicitCredential: options.explicitCredential } : {}), ...(options.env ? { env: options.env } : {}) })
    this.authentication = options.authentication ?? 'api-key'
    this.endpoint = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`
  }
}
