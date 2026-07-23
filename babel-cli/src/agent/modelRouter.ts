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

import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { OllamaApiRunner } from '../runners/ollamaApi.js';
import { OpenRouterApiRunner } from '../runners/openRouterApi.js';
import { loadModelPolicyConfig } from '../modelPolicy.js';
import type { ModelPolicyModelEntry } from '../modelPolicy.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelRoute {
  /** Provider discriminator for runner selection. */
  provider: 'deepinfra' | 'deepseek' | 'ollama' | 'openrouter';
  /** The actual model ID to pass to the runner constructor. */
  modelId: string;
  /** Cached runner instance. */
  runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | OpenRouterApiRunner;
}

export interface ModelRouterOptions {
  /**
   * Fallback model backend key when no model is specified.
   * Defaults to the policy's cheapest enabled model.
   */
  defaultBackendKey?: string;
}

// ─── ModelRouter ────────────────────────────────────────────────────────────

export class ModelRouter {
  private readonly routes = new Map<string, ModelRoute>();
  private readonly defaultBackendKey: string;
  private readonly modelConfig: ReturnType<typeof loadModelPolicyConfig>;

  constructor(options: ModelRouterOptions = {}) {
    this.modelConfig = loadModelPolicyConfig();
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
    const backend: ModelPolicyModelEntry | undefined = models?.[key];
    if (!backend) {
      throw new Error(
        `[ModelRouter] Unknown backend key "${key}". ` +
          `Available: ${Object.keys(models ?? {}).join(', ')}`,
      );
    }

    const provider = backend.provider as 'deepinfra' | 'deepseek' | 'ollama' | 'openrouter';
    const modelId = backend.model_id;

    let runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | OpenRouterApiRunner;
    if (provider === 'deepseek') {
      runner = new DeepSeekApiRunner(modelId);
    } else if (provider === 'ollama') {
      runner = new OllamaApiRunner(modelId);
    } else if (provider === 'openrouter') {
      runner = new OpenRouterApiRunner(modelId);
    } else {
      throw new Error(`[ModelRouter] Unknown provider: ${provider}`);
    }

    return { provider, modelId, runner };
  }

  private resolveDefaultBackendKey(): string {
    // Pick the cheapest enabled model from the policy.
    const models = this.modelConfig.config.models;
    if (!models) return 'scout';

    const entries = Object.entries(models)
      .filter(([, m]) => m.enabled !== false && m.expensive !== true)
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
