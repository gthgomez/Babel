/**
 * ModelRouter — per-agent model runner factory with caching.
 *
 * Sub-agents need independent model selection. Previously, all sub-agents
 * were hardcoded to Llama 4 Scout via the EXECUTOR_WATERFALL in execute.ts.
 * ModelRouter lets each sub-agent specify its own model backend key
 * (e.g. "deepseek-v4-pro", "scout", "deepseek-v4-flash") and get back
 * a cached runner instance.
 *
 * Phase 0 — additive, no breaking changes.
 */

import { createProviderRunner, type ProviderEngine } from '../runners/providerEngine.js';
import {
  isProviderId,
  providerSupportsOperation,
  type ProviderId,
  type ProviderOperation,
} from '../runners/providerRegistry.js';
import { getProviderCredentialStatus } from '../runners/credentialHub.js';
import {
  LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS,
  loadModelPolicyConfig,
  resolveOpenRouterDeepSeekBackendKey,
} from '../modelPolicy.js';
import type { ModelPolicyModelEntry } from '../modelPolicy.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelRoute {
  /** Provider discriminator for runner selection. */
  provider: ProviderId;
  /** The actual model ID to pass to the runner constructor. */
  modelId: string;
  /** Cached runner instance. */
  runner: ProviderEngine;
}

export interface ModelRouterOptions {
  /**
   * Fallback model backend key when no model is specified.
   * Defaults to the policy's cheapest enabled model.
   */
  defaultBackendKey?: string;
  /** Operation required from automatically selected providers. */
  requiredOperation?: ProviderOperation;
  /** Route legacy DeepSeek selectors through the OpenRouter live control. */
  liveOnly?: boolean;
}

// ─── ModelRouter ────────────────────────────────────────────────────────────

export class ModelRouter {
  private readonly routes = new Map<string, ModelRoute>();
  private readonly defaultBackendKey: string;
  private readonly modelConfig: ReturnType<typeof loadModelPolicyConfig>;
  private readonly requiredOperation: ProviderOperation;
  private readonly liveOnly: boolean;

  constructor(options: ModelRouterOptions = {}) {
    this.modelConfig = loadModelPolicyConfig();
    this.requiredOperation = options.requiredOperation ?? 'structured';
    this.liveOnly = options.liveOnly === true;
    this.defaultBackendKey = options.defaultBackendKey ?? this.resolveDefaultBackendKey();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Resolve a backend key to a cached model route.
   *
   * @param backendKey  e.g. "deepseek-v4-pro", "scout", "deepseek-v4-flash".
   *                    When omitted, uses the default (cheapest enabled model).
   */
  resolve(backendKey?: string): ModelRoute {
    const key = backendKey ?? this.defaultBackendKey;

    const cached = this.routes.get(key);
    if (cached) return cached;

    const route = this.createRoute(key);
    this.routes.set(key, route);
    return route;
  }

  /**
   * Pre-warm the cache with a set of backend keys.
   * Useful before spawning a team of agents to avoid sequential cold starts.
   */
  prewarm(backendKeys: string[]): void {
    for (const key of backendKeys) {
      if (!this.routes.has(key)) {
        try {
          this.routes.set(key, this.createRoute(key));
        } catch {
          // Skip keys that can't be resolved — they'll fail at resolve() time
        }
      }
    }
  }

  /** The backend key used when no model is specified. */
  getDefaultBackendKey(): string {
    return this.defaultBackendKey;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private createRoute(key: string): ModelRoute {
    const models = this.modelConfig.config.models;
    const liveBackendKey = this.liveOnly ? resolveOpenRouterDeepSeekBackendKey(key) : null;
    const effectiveKey = liveBackendKey ?? key;
    const backend: ModelPolicyModelEntry | undefined = models?.[effectiveKey];
    if (!backend) {
      throw new Error(
        `[ModelRouter] Unknown backend key "${effectiveKey}". ` +
          `Available: ${Object.keys(models ?? {}).join(', ')}`,
      );
    }

    if (this.liveOnly && backend.provider === 'deepseek') {
      throw new Error(
        `[LIVE_MODEL_POLICY] Direct DeepSeek live sub-agent route "${key}" could not be mapped to OpenRouter.`,
      );
    }

    if (!isProviderId(backend.provider)) {
      throw new Error(`[ModelRouter] Unknown provider: ${backend.provider}`);
    }
    const provider = backend.provider;
    if (!providerSupportsOperation(provider, this.requiredOperation)) {
      throw new Error(
        `[ModelRouter] Provider ${provider} does not support ${this.requiredOperation}`,
      );
    }
    const modelId = backend.model_id;
    const runner = createProviderRunner({ provider, modelId });

    return { provider, modelId, runner };
  }

  private resolveDefaultBackendKey(): string {
    if (this.liveOnly) {
      const preferred = LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS[0];
      if (this.modelConfig.config.models?.[preferred]) return preferred;
    }

    // Pick the cheapest enabled model from the policy.
    const models = this.modelConfig.config.models;
    if (!models) return 'scout';

    const entries = Object.entries(models)
      .filter(([, m]) => m.enabled !== false && m.expensive !== true)
      .filter(([, m]) =>
        isProviderId(m.provider) &&
        providerSupportsOperation(m.provider, this.requiredOperation),
      )
      .filter(([, m]) =>
        isProviderId(m.provider) &&
        getProviderCredentialStatus(m.provider, process.env).configured,
      )
      .map(([key, m]) => ({
        key,
        cost: m.estimated_cost_per_1m_output,
      }))
      .filter((e) => typeof e.cost === 'number')
      .sort((a, b) => (a.cost as number) - (b.cost as number));

    if (entries.length > 0) {
      return entries[0]!.key;
    }

    // Ultimate fallback
    return 'scout';
  }
}
