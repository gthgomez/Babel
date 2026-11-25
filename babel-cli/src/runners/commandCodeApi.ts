import { OpenAiCompatibleRunner, type FetchRedirectPolicy } from './protocol/openai-chat-completions.js'
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js'
import { COMMAND_CODE_BASE_URL } from './providerEndpoint.js'

/** Command Code's native API transport; tool execution stays in Babel. */
export class CommandCodeApiRunner extends OpenAiCompatibleRunner {
  protected override get apiUrl(): string {
    return `${COMMAND_CODE_BASE_URL}/chat/completions`
  }

  constructor(
    model: string,
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: {
      apiKeyEnvVar?: string
      contextWindowTokens?: number
      explicitCredential?: string
      env?: NodeJS.ProcessEnv
      executionEnvelope?: ResolvedExecutionEnvelope
    } = {},
  ) {
    super(model, credential.apiKeyEnvVar ?? 'COMMAND_CODE_API_KEY', sampling, {
      provider: 'command-code',
      ...(credential.contextWindowTokens ? { contextWindowTokens: credential.contextWindowTokens } : {}),
      ...(credential.explicitCredential ? { explicitCredential: credential.explicitCredential } : {}),
      ...(credential.env ? { env: credential.env } : {}),
      ...(credential.executionEnvelope ? { executionEnvelope: credential.executionEnvelope } : {}),
    })
  }

  protected override getRequestRedirect(): FetchRedirectPolicy {
    return 'error'
  }

  /** Exact route identity for invalidating a prior task's cached runner. */
  getPinnedModelId(): string {
    return this.model
  }

  protected override validateObservedModelId(observedModelId: string | null): void {
    if (observedModelId !== this.model) {
      throw new Error('[LIVE_MODEL_POLICY] Command Code response model mismatch: expected the requested exact model.')
    }
  }
}
