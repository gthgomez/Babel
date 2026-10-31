/** DeepInfra endpoint adapter. Shared inference lives in protocol/openai-chat-completions. */
import { OpenAiCompatibleRunner } from './protocol/openai-chat-completions.js'
import type { ProviderId } from './providerRegistry.js'
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js'
export type { FetchRedirectPolicy, OpenRouterResponseMetadata } from './protocol/openai-chat-completions.js'

export class DeepInfraApiRunner extends OpenAiCompatibleRunner {
  protected override get apiUrl(): string {
    return 'https://api.deepinfra.com/v1/openai/chat/completions'
  }

  constructor(model: string, apiKeyEnvVar = 'DEEPINFRA_API_KEY',
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: { contextWindowTokens?: number; provider?: ProviderId; explicitCredential?: string; env?: NodeJS.ProcessEnv; executionEnvelope?: ResolvedExecutionEnvelope } = {}) {
    if (credential.provider && credential.provider !== 'deepinfra') {
      throw new Error('DeepInfra adapter cannot represent another provider.')
    }
    super(model, apiKeyEnvVar, sampling, { ...credential, provider: 'deepinfra' })
  }
}
