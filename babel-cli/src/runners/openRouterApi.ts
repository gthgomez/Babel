/**
 * OpenRouter API runner — OpenAI-compatible endpoint.
 *
 * OpenRouter (https://openrouter.ai) is a unified API gateway for hundreds of
 * LLMs. Its chat-completions endpoint is OpenAI-compatible, so we reuse the
 * full DeepInfraApiRunner implementation and only override the API URL and
 * API-key source.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-v1-...  // in babel-cli/.env
 */

import { DeepInfraApiRunner } from './deepInfraApi.js';
import type { RunnerInvocationMetadata } from './base.js';

export class OpenRouterApiRunner extends DeepInfraApiRunner {
  protected override get apiUrl(): string {
    return 'https://openrouter.ai/api/v1/chat/completions';
  }

  constructor(
    model: string,
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: {
      apiKeyEnvVar?: string;
      explicitCredential?: string;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    super(model, credential.apiKeyEnvVar ?? 'OPENROUTER_API_KEY', sampling, {
      provider: 'openrouter',
      ...(credential.explicitCredential
        ? { explicitCredential: credential.explicitCredential }
        : {}),
      ...(credential.env ? { env: credential.env } : {}),
    });
  }

  override getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    const metadata = super.getLastInvocationMetadata();
    return metadata ? { ...metadata, provider: 'openrouter' } : null;
  }
}
