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
import type { ProviderRoutingPolicy, ResolvedExecutionEnvelope } from '../intelligence/types.js';
import { normalizeOpenRouterExecutionObservation, validateOpenRouterExecutionObservation } from '../intelligence/routing.js';

export interface OpenRouterRoutingPolicy extends ProviderRoutingPolicy {}

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
      executionEnvelope?: ResolvedExecutionEnvelope;
    } = {},
  ) {
    super(model, credential.apiKeyEnvVar ?? 'OPENROUTER_API_KEY', sampling, {
      provider: 'openrouter',
      ...(credential.explicitCredential
        ? { explicitCredential: credential.explicitCredential }
        : {}),
      ...(credential.env ? { env: credential.env } : {}),
      ...(credential.executionEnvelope ? { executionEnvelope: credential.executionEnvelope } : {}),
    });
    this.environment = credential.env ?? process.env;
  }

  protected override getRequestBodyExtras(): Record<string, unknown> {
    if (this.executionEnvelope) return {};
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
    if (this.executionEnvelope && !this.executionEnvelope.routing.metadataEnabled) return {};
    return { 'X-OpenRouter-Metadata': 'enabled' };
  }

  override getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    const metadata = super.getLastInvocationMetadata();
    return metadata ? { ...metadata, provider: 'openrouter' } : null;
  }

  protected override validateObservedModelId(observedModelId: string | null): void {
    if (this.executionEnvelope?.mode === 'benchmark_strict') {
      if (observedModelId === null) {
        throw new Error('[LIVE_MODEL_POLICY] Strict OpenRouter execution omitted observed model identity.')
      }
      if (observedModelId !== this.executionEnvelope.model.resolved) {
        throw new Error(
          `[LIVE_MODEL_POLICY] Strict OpenRouter execution observed model "${observedModelId}" ` +
            `but expected "${this.executionEnvelope.model.resolved}".`,
        )
      }
      return
    }
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

  protected override validateObservedUpstream(upstreamProvider: string | null): void {
    if (!this.executionEnvelope || this.executionEnvelope.mode !== 'benchmark_strict') return;
    if (!upstreamProvider) {
      throw new Error('[LIVE_MODEL_POLICY] Strict OpenRouter execution omitted observed upstream identity.');
    }
    if (
      this.executionEnvelope.provider.upstream &&
      upstreamProvider !== this.executionEnvelope.provider.upstream
    ) {
      throw new Error(
        `[LIVE_MODEL_POLICY] Strict OpenRouter execution observed upstream "${upstreamProvider}" ` +
          `but expected "${this.executionEnvelope.provider.upstream}".`,
      );
    }
  }

  protected override validateObservedRouterMetadata(
    routerMetadata: unknown,
    observedModelId: string | null,
    upstreamProvider: string | null,
  ): void {
    if (!this.executionEnvelope || this.executionEnvelope.mode !== 'benchmark_strict') return;
    const observation = normalizeOpenRouterExecutionObservation({
      requestedModel: this.executionEnvelope.model.requested,
      resolvedModel: this.executionEnvelope.model.resolved,
      requestedProviderPolicy: this.executionEnvelope.routing,
      response: {
        model: observedModelId ?? undefined,
        provider: upstreamProvider ?? undefined,
        openrouter_metadata: routerMetadata,
      },
      routerMetadataRequired: true,
    });
    const validation = {
      mode: this.executionEnvelope.mode,
      observation,
      ...(this.executionEnvelope.provider.upstream === undefined
        ? {}
        : { requestedUpstream: this.executionEnvelope.provider.upstream }),
    } as const;
    validateOpenRouterExecutionObservation(validation);
  }
}
