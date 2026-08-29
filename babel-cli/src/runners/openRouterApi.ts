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
import {
  isOpenRouterDeepSeekLiveModelId,
  LIVE_OPENROUTER_MODEL_ID,
} from '../modelPolicy.js';

export interface OpenRouterRoutingPolicy {
  /** Prevent OpenRouter from silently moving the request to another upstream. */
  allowFallbacks?: boolean;
  /** Optional ordered upstream provider allow-list. */
  order?: readonly string[];
  /** Require an upstream to honor all requested parameters. */
  requireParameters?: boolean;
}

export class OpenRouterApiRunner extends DeepInfraApiRunner {
  private readonly environment: NodeJS.ProcessEnv;

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
    this.environment = credential.env ?? process.env;
  }

  protected override getRequestBodyExtras(): Record<string, unknown> {
    const allowFallbacks = this.environment['BABEL_OPENROUTER_ALLOW_FALLBACKS'];
    const requireParameters = this.environment['BABEL_OPENROUTER_REQUIRE_PARAMETERS'];
    const order = this.environment['BABEL_OPENROUTER_PROVIDER_ORDER']
      ?.split(',')
      .map((provider) => provider.trim())
      .filter((provider) => provider.length > 0);
    if (allowFallbacks === undefined && requireParameters === undefined && !order?.length) {
      return {};
    }
    return {
      provider: {
        ...(allowFallbacks !== undefined ? { allow_fallbacks: allowFallbacks !== '0' } : {}),
        ...(requireParameters !== undefined ? { require_parameters: requireParameters === '1' } : {}),
        ...(order?.length ? { order } : {}),
      },
    };
  }

  protected override getRequestHeadersExtras(): Record<string, string> {
    // Router metadata is content-free and exposes the selected upstream,
    // attempts, and routing strategy for post-run causal analysis.
    return { 'X-OpenRouter-Metadata': 'enabled' };
  }

  override getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    const metadata = super.getLastInvocationMetadata();
    return metadata ? { ...metadata, provider: 'openrouter' } : null;
  }

  protected override validateObservedModelId(observedModelId: string | null): void {
    const isExactExperimentalRoute =
      this.model === LIVE_OPENROUTER_MODEL_ID || isOpenRouterDeepSeekLiveModelId(this.model);
    if (!isExactExperimentalRoute) return;
    if (observedModelId === null) {
      throw new Error(
        '[LIVE_MODEL_POLICY] OpenRouter exact GLM response omitted observed model identity; ' +
          'refusing to certify an unidentifiable provider response.',
      );
    }
    if (observedModelId !== this.model) {
      throw new Error(
        `[LIVE_MODEL_POLICY] OpenRouter observed model "${observedModelId}" ` +
          `but the exact GLM route sent "${this.model}"; refusing model substitution.`,
      );
    }
  }
}
