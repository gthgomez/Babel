/**
 * DeepInfra compatibility wrapper around the provider-neutral transport.
 *
 * DeepInfra-specific endpoint, credential, and environment naming stays here;
 * request/response handling lives in openAiCompatibleApi.ts.
 */

import { OpenAICompatibleApiRunner } from './openAiCompatibleApi.js';
import type { ProviderId } from './providerRegistry.js';
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js';

export class DeepInfraApiRunner extends OpenAICompatibleApiRunner {
  protected override get defaultMaxTokens(): number {
    return 32000;
  }

  protected override get apiUrl(): string {
    return 'https://api.deepinfra.com/v1/openai/chat/completions';
  }

  constructor(
    model: string,
    apiKeyEnvVar = 'DEEPINFRA_API_KEY',
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: {
      provider?: ProviderId;
      explicitCredential?: string;
      env?: NodeJS.ProcessEnv;
      executionEnvelope?: ResolvedExecutionEnvelope;
    } = {},
  ) {
    super(model, apiKeyEnvVar, sampling, {
      ...credential,
      provider: credential.provider ?? 'deepinfra',
      environmentPrefix: 'BABEL_DEEPINFRA',
    });
  }
}
