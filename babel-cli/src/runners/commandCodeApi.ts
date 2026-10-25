import { DeepInfraApiRunner, type FetchRedirectPolicy } from './deepInfraApi.js'
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js'

/** Command Code's native API transport; tool execution stays in Babel. */
export class CommandCodeApiRunner extends DeepInfraApiRunner {
  protected override get apiUrl(): string {
    return 'https://api.commandcode.ai/provider/v1/chat/completions'
  }

  constructor(
    model: string,
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: {
      apiKeyEnvVar?: string
      explicitCredential?: string
      env?: NodeJS.ProcessEnv
      executionEnvelope?: ResolvedExecutionEnvelope
    } = {},
  ) {
    super(model, credential.apiKeyEnvVar ?? 'COMMAND_CODE_API_KEY', sampling, {
      provider: 'command-code',
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
