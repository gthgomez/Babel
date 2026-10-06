/**
 * ModelRouter — per-agent model runner factory with connection-keyed caching.
 *
 * Sub-agents need independent model selection. ModelRouter resolves each
 * request through the shared authority-aware route-selection gate
 * (`resolveModelSelection`) and reuses a runner only while its connection
 * identity — provider, model ID, protocol, endpoint configuration and
 * credential provenance — is unchanged. Per-attempt usage/abort/owner state is
 * never stored on a cached route.
 *
 * There is no hard-coded ultimate fallback: when no configured route is
 * eligible the router throws a typed {@link RouteUnavailableError} instead of
 * guessing at a model that policy does not declare.
 */

import { createProviderRunner, type ProviderEngine } from '../runners/providerEngine.js'
import {
  getProviderSpec,
  isProviderId,
  type ProviderId,
  type ProviderOperation,
} from '../runners/providerRegistry.js'
import { getProviderCredentialStatus } from '../runners/credentialHub.js'
import {
  LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS,
  loadModelPolicyConfig,
  resolveOpenRouterDeepSeekBackendKey,
} from '../modelPolicy.js'
import type { ExecutionMode } from '../intelligence/types.js'
import type { CatalogSnapshot } from '../intelligence/types.js'
import {
  beginRouteAttempt as beginAttemptForConnection,
  connectionIdentityForRoute,
  connectionKey,
  recordRouteAttemptUsage as recordAttemptUsage,
  resolveModelSelection,
  type AttemptUsage,
  type ConfiguredRoute,
  type ModelAliasDeclaration,
  type ModelSelectionFailure,
  type ModelSelectionResult,
  type RouteAttempt,
  type RouteAuthorizationEntry,
} from '../intelligence/route-selection.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelRoute {
  /** Provider discriminator for runner selection. */
  provider: ProviderId
  /** The actual model ID to pass to the runner constructor. */
  modelId: string
  /** Operator-facing backend key that selected this route. */
  routeId: string
  /** Stable connection identity under which the runner may be reused. */
  connectionKey: string
  /** Cached runner instance — immutable transport, never per-attempt state. */
  runner: ProviderEngine
}

export interface ModelRouterOptions {
  /**
   * Explicit default backend key when no model is specified. Honored verbatim
   * (the named route is then admitted through the shared gate) and returned by
   * {@link ModelRouter.getDefaultBackendKey}. When omitted, the cheapest
   * admitted, non-expensive, credentialed route is selected.
   */
  defaultBackendKey?: string
  /** Operation required from automatically selected providers. */
  requiredOperation?: ProviderOperation
  /** Route legacy DeepSeek selectors through the OpenRouter live control. */
  liveOnly?: boolean
  /** Execution mode governing substitution. Defaults to `production_resilient`. */
  mode?: ExecutionMode
  /** Optional catalog snapshot gating qualification admission. */
  catalog?: CatalogSnapshot
  /** Endpoint/connection identity; part of the cache key. */
  endpoint?: string
  /** Credential provenance override; part of the cache key. */
  credentialProvenance?: string
  /** Explicit authorization for routes that are not yet certified. */
  authorizations?: readonly RouteAuthorizationEntry[]
  /** Policy root override for tests and installed layouts. */
  babelRoot?: string
}

/** Typed failure raised when no configured route is eligible for a request. */
export class RouteUnavailableError extends Error {
  readonly code: ModelSelectionFailure['code']
  readonly requested: string
  readonly routeId: string | null

  constructor(failure: ModelSelectionFailure) {
    super(
      `[ModelRouter] ${failure.code}: ${failure.reason} (requested "${failure.requested}")`,
    )
    this.name = 'RouteUnavailableError'
    this.code = failure.code
    this.requested = failure.requested
    this.routeId = failure.routeId
  }
}

// ─── ModelRouter ────────────────────────────────────────────────────────────

interface MaterializedPolicy {
  routes: ConfiguredRoute[]
  costs: Map<string, number>
  /** Backend keys whose policy entry is flagged `expensive: true`. */
  expensive: Set<string>
  aliases: ModelAliasDeclaration[]
}

export class ModelRouter {
  /** Route identity (routeId + connectionKey) → model route, for requested-identity fidelity. */
  private readonly routes = new Map<string, ModelRoute>()
  /** Connection identity → shared immutable runner, reused across alias backend keys. */
  private readonly runners = new Map<string, ProviderEngine>()
  private readonly options: ModelRouterOptions
  private readonly requiredOperation: ProviderOperation
  private readonly liveOnly: boolean
  private readonly mode: ExecutionMode

  constructor(options: ModelRouterOptions = {}) {
    this.options = options
    this.requiredOperation = options.requiredOperation ?? 'structured'
    this.liveOnly = options.liveOnly === true
    this.mode = options.mode ?? 'production_resilient'
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Resolve a backend key to a cached model route.
   *
   * @param backendKey  e.g. "deepseek-v4-pro", "qwen3". When omitted, uses the
   *                    default (cheapest admitted model).
   * @throws RouteUnavailableError when the selector is ambiguous, unknown or
   *         no configured route is eligible under the current mode.
   */
  resolve(backendKey?: string): ModelRoute {
    const policy = this.materializePolicy()
    const configured = backendKey ?? this.resolveDefaultBackendKey(policy)
    if (configured === null) {
      throw new RouteUnavailableError({
        status: 'blocked',
        requested: '',
        code: 'no_eligible_route',
        reason: 'No configured route is eligible for the default lane.',
        ref: null,
        routeId: null,
        aliasUsed: false,
        aliasId: null,
        aliasTarget: null,
        fallbackReason: null,
      })
    }
    // Legacy DeepSeek selectors route through the OpenRouter control in live mode.
    const requested = this.liveOnly
      ? resolveOpenRouterDeepSeekBackendKey(configured) ?? configured
      : configured
    const selection = resolveModelSelection({
      mode: this.mode,
      requested,
      routes: policy.routes,
      aliases: policy.aliases,
      ...(this.options.catalog ? { catalog: this.options.catalog } : {}),
      ...(this.options.authorizations ? { authorizations: this.options.authorizations } : {}),
    })

    if (selection.status === 'blocked' || selection.status === 'unknown') {
      throw new RouteUnavailableError(selection)
    }

    const route = policy.routes.find((candidate) => candidate.routeId === selection.routeId)
    if (!route) {
      throw new RouteUnavailableError({
        status: 'blocked',
        requested,
        code: 'no_eligible_route',
        reason: `Selected route "${selection.routeId}" is not configured.`,
        ref: selection.ref,
        routeId: selection.routeId,
        aliasUsed: selection.aliasUsed,
        aliasId: selection.aliasId,
        aliasTarget: selection.aliasTarget,
        fallbackReason: null,
      })
    }

    const identity = connectionIdentityForRoute(route)
    const key = connectionKey(identity)
    // Route identity includes the operator backend key so distinct backend keys
    // that share one connection (e.g. `deepseek` and `deepseek-v4-pro`) each
    // report their own requested routeId instead of collapsing to first-cached.
    const routeKey = `${route.routeId}\u0000${key}`
    const cached = this.routes.get(routeKey)
    if (cached) return cached

    // The transport runner is immutable and connection-scoped: alias backend
    // keys that resolve to the same connection share one runner instance.
    let runner = this.runners.get(key)
    if (!runner) {
      runner = createProviderRunner({
        provider: route.ref.provider,
        modelId: route.ref.modelId,
      })
      this.runners.set(key, runner)
    }
    const modelRoute: ModelRoute = {
      provider: route.ref.provider,
      modelId: route.ref.modelId,
      routeId: route.routeId,
      connectionKey: key,
      runner,
    }
    this.routes.set(routeKey, modelRoute)
    return modelRoute
  }

  /**
   * Pre-warm the cache with a set of backend keys. Keys that cannot be resolved
   * are skipped — they will fail with a typed error at resolve() time.
   */
  prewarm(backendKeys: string[]): void {
    for (const key of backendKeys) {
      try {
        this.resolve(key)
      } catch {
        // Skip keys that can't be resolved — they'll fail at resolve() time
      }
    }
  }

  /** The backend key used when no model is specified. */
  getDefaultBackendKey(): string {
    const requested = this.resolveDefaultBackendKey(this.materializePolicy())
    if (requested === null) {
      throw new RouteUnavailableError({
        status: 'blocked',
        requested: '',
        code: 'no_eligible_route',
        reason: 'No configured route is eligible for the default lane.',
        ref: null,
        routeId: null,
        aliasUsed: false,
        aliasId: null,
        aliasTarget: null,
        fallbackReason: null,
      })
    }
    return requested
  }

  // ── Policy materialization ────────────────────────────────────────────────

  private materializePolicy(): MaterializedPolicy {
    const { config } = loadModelPolicyConfig(this.options.babelRoot)
    const models = config.models ?? {}
    const routes: ConfiguredRoute[] = []
    const costs = new Map<string, number>()
    const expensive = new Set<string>()
    for (const [routeId, entry] of Object.entries(models)) {
      if (!isProviderId(entry.provider)) continue
      if (this.liveOnly && entry.provider === 'deepseek') continue
      const spec = getProviderSpec(entry.provider)
      routes.push({
        routeId,
        ref: { provider: entry.provider, modelId: entry.model_id },
        protocol: spec.protocol,
        enabled: entry.enabled !== false,
        requiredOperation: this.requiredOperation,
        ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
        ...(this.options.credentialProvenance
          ? { credentialProvenance: this.options.credentialProvenance }
          : {}),
      })
      if (typeof entry.estimated_cost_per_1m_output === 'number') {
        costs.set(routeId, entry.estimated_cost_per_1m_output)
      }
      if (entry.expensive === true) expensive.add(routeId)
    }

    const aliases: ModelAliasDeclaration[] = Object.entries(config.vendor_aliases ?? {}).map(
      ([alias, entry]) => ({ alias, target: entry.maps_to }),
    )
    return { routes, costs, expensive, aliases }
  }

  private resolveDefaultBackendKey(policy: MaterializedPolicy): string | null {
    // An explicit operator default is honored verbatim; admission still runs
    // when resolve() selects it. Expensive auto-selection stays opt-in only.
    if (this.options.defaultBackendKey !== undefined) {
      return this.options.defaultBackendKey
    }
    if (this.liveOnly) {
      for (const preferred of LIVE_OPENROUTER_DEEPSEEK_BACKEND_KEYS) {
        if (policy.routes.some((route) => route.routeId === preferred)) return preferred
      }
    }

    // Expensive entries are never auto-selected for the default lane; they
    // require an explicit backend key (operator opt-in).
    const ranked = policy.routes
      .filter((route) => route.enabled && !policy.expensive.has(route.routeId))
      .map((route) => ({ route, cost: policy.costs.get(route.routeId) }))
      .sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity))

    for (const candidate of ranked) {
      if (this.isDefaultEligible(candidate.route)) return candidate.route.routeId
    }
    return null
  }

  private isDefaultEligible(route: ConfiguredRoute): boolean {
    if (!this.admissionProbe(route)) return false
    return getProviderCredentialStatus(route.ref.provider, process.env).configured
  }

  private admissionProbe(route: ConfiguredRoute): boolean {
    // Reuse the single effective gate; default selection must not bypass it.
    const policy = { routes: [route] }
    const selection: ModelSelectionResult = resolveModelSelection({
      mode: this.mode,
      requested: route.routeId,
      routes: policy.routes,
      ...(this.options.catalog ? { catalog: this.options.catalog } : {}),
      ...(this.options.authorizations ? { authorizations: this.options.authorizations } : {}),
    })
    return selection.status === 'resolved' || selection.status === 'fallback'
  }
}

// ─── Per-attempt state ──────────────────────────────────────────────────────

export type { AttemptUsage, RouteAttempt }

/** Begin owner-local mutable state for one dispatch of a shared connection. */
export function beginRouteAttempt(route: ModelRoute, owner: string): RouteAttempt {
  return beginAttemptForConnection(route.connectionKey, route.modelId, owner)
}

/** Settle usage against one attempt; late or duplicate usage is fenced. */
export function recordRouteAttemptUsage(attempt: RouteAttempt, usage: AttemptUsage): boolean {
  return recordAttemptUsage(attempt, usage)
}
