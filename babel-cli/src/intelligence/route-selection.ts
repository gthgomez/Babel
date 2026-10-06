/**
 * Route selection — the single authority-aware admission gate for model routes.
 *
 * Selection is provider-qualified and exact-case for provider-defined model IDs.
 * Human aliases are normalized separately (case-insensitively) and can never be
 * confused with a provider ID. Resolution never guesses across a first match:
 * an unqualified selector that matches more than one provider/model tuple is a
 * typed ambiguity, and a broken alias chain is a typed error rather than an
 * unresolved intermediate value.
 *
 * `benchmark_strict` and `qualification` never substitute a route. Only
 * `production_resilient` may move to another configured, admitted route, and it
 * always reports an explicit fallback reason. When no route is eligible the
 * result is a typed `no_eligible_route` unavailable — never a hard-coded model.
 */

import { findModelProfile } from './catalog.js'
import { hashCanonical } from './hash.js'
import { modelRefKey, type ModelRef } from './model-ref.js'
import type { CatalogSnapshot, ExecutionMode, ProviderModelProfile } from './types.js'
import {
  BENCHMARK_PROVIDER_IDS,
  getProviderSpec,
  isProviderId,
  providerSupportsOperation,
  type ProviderId,
  type ProviderOperation,
  type ProviderProtocol,
} from '../runners/providerRegistry.js'

// ─── Declarations ─────────────────────────────────────────────────────────────

/**
 * A human-facing alias. Alias IDs are compared case-insensitively; an alias may
 * point at another alias or at a configured route/model reference.
 */
export interface ModelAliasDeclaration {
  alias: string
  target: ModelRef | string
}

/** One route as the operator declared it, before admission is applied. */
export interface ConfiguredRoute {
  /** Stable operator identifier (backend key) retained for diagnostics. */
  routeId: string
  ref: ModelRef
  /** Declared protocol; defaults to the provider's registered protocol. */
  protocol?: ProviderProtocol
  /** Endpoint/connection configuration identity, when non-default. */
  endpoint?: string
  /** Credential provenance (env var name or named source). */
  credentialProvenance?: string
  /** Operator/policy enablement flag. */
  enabled: boolean
  /** Operation the route must support for this lane. */
  requiredOperation?: ProviderOperation
}

/** Why a route was admitted or refused by the single effective gate. */
export type RouteAdmissionCode =
  | 'admitted'
  | 'route_disabled'
  | 'provider_unknown'
  | 'provider_not_production'
  | 'provider_uncertified'
  | 'operation_unsupported'
  | 'qualification_missing'
  | 'authorization_denied'

export interface RouteAdmissionDecision {
  admitted: boolean
  code: RouteAdmissionCode
  reason: string
}

/** Explicit operator/lane authorization for a not-yet-certified route. */
export interface RouteAuthorization {
  allowed: boolean
  reason?: string
}

export interface RouteAuthorizationEntry {
  ref: ModelRef
  decision: RouteAuthorization
}

export type ModelSelectionFailureCode =
  | 'ambiguous_id'
  | 'unknown_model'
  | 'alias_cycle'
  | 'alias_depth_exceeded'
  | 'duplicate_alias'
  | 'unknown_alias_target'
  | 'route_not_admitted'
  | 'no_eligible_route'

export type ModelSelectionStatus = 'resolved' | 'fallback' | 'blocked' | 'unknown'

export interface ModelSelectionSuccess {
  status: 'resolved' | 'fallback'
  requested: string
  routeId: string
  ref: ModelRef
  profile: ProviderModelProfile | null
  aliasUsed: boolean
  aliasId: string | null
  aliasTarget: ModelRef | null
  fallbackReason: string | null
  admission: RouteAdmissionDecision
}

export interface ModelSelectionFailure {
  status: 'blocked' | 'unknown'
  requested: string
  code: ModelSelectionFailureCode
  reason: string
  ref: ModelRef | null
  routeId: string | null
  aliasUsed: boolean
  aliasId: string | null
  aliasTarget: ModelRef | null
  fallbackReason: null
}

export type ModelSelectionResult = ModelSelectionSuccess | ModelSelectionFailure

export interface ModelSelectionInput {
  mode: ExecutionMode
  requested: string
  routes: readonly ConfiguredRoute[]
  aliases?: readonly ModelAliasDeclaration[]
  catalog?: CatalogSnapshot
  authorizations?: readonly RouteAuthorizationEntry[]
  /** Maximum alias hops before `alias_depth_exceeded`. Defaults to 8. */
  maxAliasDepth?: number
}

// ─── Connection identity ──────────────────────────────────────────────────────

/**
 * The stable identity a transport client may be reused under. Per-attempt
 * mutable usage/abort/owner state is deliberately absent.
 */
export interface ConnectionIdentity {
  provider: ProviderId
  modelId: string
  protocol: ProviderProtocol
  endpoint: string | null
  credentialProvenance: string
  requiredOperation: ProviderOperation | null
}

/** Derive the immutable connection identity for one configured route. */
export function connectionIdentityForRoute(route: ConfiguredRoute): ConnectionIdentity {
  const spec = isProviderId(route.ref.provider) ? getProviderSpec(route.ref.provider) : null
  return {
    provider: route.ref.provider,
    modelId: route.ref.modelId,
    protocol: route.protocol ?? spec?.protocol ?? 'openai_compatible',
    endpoint: route.endpoint ?? null,
    credentialProvenance: route.credentialProvenance ?? spec?.credentialEnvVar ?? 'none',
    requiredOperation: route.requiredOperation ?? null,
  }
}

/**
 * Stable cache key for a connection identity. Two providers, endpoints or
 * credential provenances never share a client even for the same model ID.
 */
export function connectionKey(identity: ConnectionIdentity): string {
  return hashCanonical({
    provider: identity.provider,
    modelId: identity.modelId,
    protocol: identity.protocol,
    endpoint: identity.endpoint,
    credentialProvenance: identity.credentialProvenance,
    requiredOperation: identity.requiredOperation,
  })
}

// ─── Admission gate (single effective gate) ───────────────────────────────────

const BENCHMARK_ONLY_PROVIDERS = new Set<string>(BENCHMARK_PROVIDER_IDS)

function admit(input: ModelSelectionInput, route: ConfiguredRoute): RouteAdmissionDecision {
  if (!route.enabled) {
    return {
      admitted: false,
      code: 'route_disabled',
      reason: `Route "${route.routeId}" is disabled by policy.`,
    }
  }
  const provider = route.ref.provider
  if (!isProviderId(provider)) {
    return {
      admitted: false,
      code: 'provider_unknown',
      reason: `Provider "${provider}" is not registered.`,
    }
  }
  const spec = getProviderSpec(provider)
  if (
    BENCHMARK_ONLY_PROVIDERS.has(provider) &&
    input.mode !== 'benchmark_strict' &&
    input.mode !== 'qualification'
  ) {
    return {
      admitted: false,
      code: 'provider_not_production',
      reason: `Provider "${provider}" is benchmark-only and cannot serve a ${input.mode} route.`,
    }
  }
  if (input.mode === 'production_resilient' && spec.authorityConformance !== 'certified') {
    return {
      admitted: false,
      code: 'provider_uncertified',
      reason: `Provider "${provider}" is not authority-conformance certified for a production route.`,
    }
  }
  const operation = route.requiredOperation
  if (operation && !providerSupportsOperation(provider, operation)) {
    return {
      admitted: false,
      code: 'operation_unsupported',
      reason: `Provider "${provider}" does not support the ${operation} operation.`,
    }
  }
  if (input.catalog) {
    const profile = findModelProfile(input.catalog, route.ref)
    if (profile) {
      const qualified = profile.protocolProfiles.some(
        (entry) => entry.qualificationStatus === 'qualified',
      )
      if (!qualified) {
        return {
          admitted: false,
          code: 'qualification_missing',
          reason: `Provider model "${route.ref.provider}/${route.ref.modelId}" has no qualified protocol.`,
        }
      }
    }
  }
  if (spec.authorityConformance !== 'certified') {
    const entry = input.authorizations?.find(
      (candidate) => modelRefKey(candidate.ref) === modelRefKey(route.ref),
    )
    if (!entry) {
      return {
        admitted: false,
        code: 'qualification_missing',
        reason: `Provider "${provider}" is not certified and no explicit route authorization was supplied.`,
      }
    }
    if (!entry.decision.allowed) {
      return {
        admitted: false,
        code: 'authorization_denied',
        reason: entry.decision.reason ?? `Route "${route.routeId}" was explicitly denied.`,
      }
    }
  }
  return { admitted: true, code: 'admitted', reason: '' }
}

/** Apply the single effective route-admission gate to one declared route. */
export function evaluateRouteAdmission(
  input: ModelSelectionInput,
  route: ConfiguredRoute,
): RouteAdmissionDecision {
  return admit(input, route)
}

// ─── Resolution ───────────────────────────────────────────────────────────────

interface ProviderQualifiedSelector {
  provider: ProviderId
  modelId: string
}

function parseProviderQualified(requested: string): ProviderQualifiedSelector | null {
  const separator = requested.indexOf(':')
  if (separator <= 0) return null
  const provider = requested.slice(0, separator)
  const modelId = requested.slice(separator + 1)
  if (!isProviderId(provider) || modelId.length === 0) return null
  return { provider, modelId }
}

interface Candidate {
  routeId: string
  ref: ModelRef
  route: ConfiguredRoute | null
  aliasUsed: boolean
  aliasId: string | null
  aliasTarget: ModelRef | null
}

type ResolveOutcome =
  | { kind: 'candidate'; candidate: Candidate }
  | { kind: 'failure'; status: 'blocked' | 'unknown'; code: ModelSelectionFailureCode; reason: string }

function knownRefs(input: ModelSelectionInput): ModelRef[] {
  const refs = input.routes.map((route) => route.ref)
  for (const profile of input.catalog?.providerModels ?? []) {
    refs.push({ provider: profile.provider, modelId: profile.providerModelId })
  }
  return refs
}

function routeForRef(routes: readonly ConfiguredRoute[], ref: ModelRef): ConfiguredRoute | undefined {
  return routes.find((route) => modelRefKey(route.ref) === modelRefKey(ref))
}

function resolveAlias(
  input: ModelSelectionInput,
  requested: string,
): ResolveOutcome {
  const declarations = input.aliases ?? []
  const byAlias = new Map<string, ModelAliasDeclaration[]>()
  for (const declaration of declarations) {
    const key = declaration.alias.trim().toLowerCase()
    const list = byAlias.get(key) ?? []
    list.push(declaration)
    byAlias.set(key, list)
  }
  for (const [key, list] of byAlias) {
    if (list.length > 1) {
      return {
        kind: 'failure',
        status: 'blocked',
        code: 'duplicate_alias',
        reason: `Alias "${key}" is declared more than once.`,
      }
    }
  }

  const maxDepth = input.maxAliasDepth ?? 8
  const visited = new Set<string>()
  let aliasId: string | null = null
  let current = requested.trim().toLowerCase()
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const declaration = byAlias.get(current)?.[0]
    if (!declaration) {
      if (aliasId === null) {
        return { kind: 'failure', status: 'unknown', code: 'unknown_model', reason: `Unknown selector "${requested}".` }
      }
      return {
        kind: 'failure',
        status: 'blocked',
        code: 'unknown_alias_target',
        reason: `Alias "${aliasId}" does not resolve to a known route or model.`,
      }
    }
    if (visited.has(current)) {
      return {
        kind: 'failure',
        status: 'blocked',
        code: 'alias_cycle',
        reason: `Alias chain for "${requested}" contains a cycle at "${current}".`,
      }
    }
    visited.add(current)
    if (aliasId === null) aliasId = declaration.alias
    const target = declaration.target
    if (typeof target !== 'string') {
      const route = routeForRef(input.routes, target)
      return {
        kind: 'candidate',
        candidate: {
          routeId: route?.routeId ?? `${target.provider}:${target.modelId}`,
          ref: target,
          route: route ?? null,
          aliasUsed: true,
          aliasId,
          aliasTarget: target,
        },
      }
    }
    const next = target.trim().toLowerCase()
    if (byAlias.has(next)) {
      current = next
      continue
    }
    // A string target may name a configured route id.
    const route = input.routes.find((candidate) => candidate.routeId.toLowerCase() === next)
    if (route) {
      return {
        kind: 'candidate',
        candidate: {
          routeId: route.routeId,
          ref: route.ref,
          route,
          aliasUsed: true,
          aliasId,
          aliasTarget: route.ref,
        },
      }
    }
    return {
      kind: 'failure',
      status: 'blocked',
      code: 'unknown_alias_target',
      reason: `Alias "${aliasId}" targets unknown route "${target}".`,
    }
  }
  return {
    kind: 'failure',
    status: 'blocked',
    code: 'alias_depth_exceeded',
    reason: `Alias chain for "${requested}" exceeded the maximum depth of ${maxDepth}.`,
  }
}

function resolveRequested(input: ModelSelectionInput, requested: string): ResolveOutcome {
  const qualified = parseProviderQualified(requested)
  if (qualified) {
    const route = routeForRef(input.routes, qualified)
    return {
      kind: 'candidate',
      candidate: {
        routeId: route?.routeId ?? `${qualified.provider}:${qualified.modelId}`,
        ref: qualified,
        route: route ?? null,
        aliasUsed: false,
        aliasId: null,
        aliasTarget: null,
      },
    }
  }

  const exactRoute = input.routes.find((route) => route.routeId === requested)
  if (exactRoute) {
    return {
      kind: 'candidate',
      candidate: {
        routeId: exactRoute.routeId,
        ref: exactRoute.ref,
        route: exactRoute,
        aliasUsed: false,
        aliasId: null,
        aliasTarget: null,
      },
    }
  }

  const refs = knownRefs(input)
  const exactMatches = refs.filter((ref) => ref.modelId === requested)
  const exactDistinct = new Map(exactMatches.map((ref) => [modelRefKey(ref), ref]))
  if (exactDistinct.size > 1) {
    return {
      kind: 'failure',
      status: 'blocked',
      code: 'ambiguous_id',
      reason:
        `Unqualified model ID "${requested}" matches ${exactDistinct.size} provider/model routes; ` +
        `request it provider-qualified (e.g. "${[...exactDistinct.values()][0]!.provider}:${requested}").`,
    }
  }
  if (exactDistinct.size === 1) {
    const ref = [...exactDistinct.values()][0]!
    const route = routeForRef(input.routes, ref)
    return {
      kind: 'candidate',
      candidate: {
        routeId: route?.routeId ?? `${ref.provider}:${ref.modelId}`,
        ref,
        route: route ?? null,
        aliasUsed: false,
        aliasId: null,
        aliasTarget: null,
      },
    }
  }

  return resolveAlias(input, requested)
}

function failure(
  requested: string,
  outcome: Extract<ResolveOutcome, { kind: 'failure' }>,
): ModelSelectionFailure {
  return {
    status: outcome.status,
    requested,
    code: outcome.code,
    reason: outcome.reason,
    ref: null,
    routeId: null,
    aliasUsed: false,
    aliasId: null,
    aliasTarget: null,
    fallbackReason: null,
  }
}

function success(
  input: ModelSelectionInput,
  requested: string,
  route: ConfiguredRoute,
  alias: Pick<Candidate, 'aliasUsed' | 'aliasId' | 'aliasTarget'>,
  status: 'resolved' | 'fallback',
  fallbackReason: string | null,
): ModelSelectionSuccess {
  const profile = input.catalog ? findModelProfile(input.catalog, route.ref) ?? null : null
  return {
    status,
    requested,
    routeId: route.routeId,
    ref: route.ref,
    profile,
    aliasUsed: alias.aliasUsed,
    aliasId: alias.aliasId,
    aliasTarget: alias.aliasTarget,
    fallbackReason,
    admission: admit(input, route),
  }
}

/**
 * Resolve a requested selector to one admitted route, preserving the requested
 * selector, the exact provider-qualified {@link ModelRef}, profile identity and
 * an explicit fallback reason — or a typed blocked/unknown result.
 */
export function resolveModelSelection(input: ModelSelectionInput): ModelSelectionResult {
  const requested = input.requested.trim()
  if (requested.length === 0) {
    return {
      status: 'unknown',
      requested: input.requested,
      code: 'unknown_model',
      reason: 'Requested selector is empty.',
      ref: null,
      routeId: null,
      aliasUsed: false,
      aliasId: null,
      aliasTarget: null,
      fallbackReason: null,
    }
  }

  const outcome = resolveRequested(input, requested)
  if (outcome.kind === 'failure') return failure(input.requested, outcome)

  const { candidate } = outcome
  const route = candidate.route ?? routeForRef(input.routes, candidate.ref)
  if (!route) {
    // The ref may be known from the catalog but is not a configured route.
    if (input.mode === 'production_resilient') {
      const fallback = firstAdmitted(input)
      if (fallback) {
        return success(
          input,
          input.requested,
          fallback,
          candidate,
          'fallback',
          `Requested model "${candidate.ref.provider}/${candidate.ref.modelId}" is not a configured route; selected route "${fallback.routeId}".`,
        )
      }
    }
    return {
      status: 'blocked',
      requested: input.requested,
      code: 'no_eligible_route',
      reason: `Requested model "${candidate.ref.provider}/${candidate.ref.modelId}" is not a configured eligible route.`,
      ref: candidate.ref,
      routeId: null,
      aliasUsed: candidate.aliasUsed,
      aliasId: candidate.aliasId,
      aliasTarget: candidate.aliasTarget,
      fallbackReason: null,
    }
  }

  const decision = admit(input, route)
  if (decision.admitted) {
    return success(input, input.requested, route, candidate, 'resolved', null)
  }

  if (input.mode === 'benchmark_strict' || input.mode === 'qualification') {
    return {
      status: 'blocked',
      requested: input.requested,
      code: 'route_not_admitted',
      reason: `Route "${route.routeId}" was refused: ${decision.reason}`,
      ref: candidate.ref,
      routeId: route.routeId,
      aliasUsed: candidate.aliasUsed,
      aliasId: candidate.aliasId,
      aliasTarget: candidate.aliasTarget,
      fallbackReason: null,
    }
  }

  const fallback = firstAdmitted(input)
  if (fallback) {
    return success(
      input,
      input.requested,
      fallback,
      candidate,
      'fallback',
      `Requested route "${route.routeId}" was refused (${decision.reason}); selected route "${fallback.routeId}".`,
    )
  }
  return {
    status: 'blocked',
    requested: input.requested,
    code: 'no_eligible_route',
    reason: `No eligible route is configured: requested route "${route.routeId}" was refused (${decision.reason}).`,
    ref: candidate.ref,
    routeId: route.routeId,
    aliasUsed: candidate.aliasUsed,
    aliasId: candidate.aliasId,
    aliasTarget: candidate.aliasTarget,
    fallbackReason: null,
  }
}

function firstAdmitted(input: ModelSelectionInput): ConfiguredRoute | null {
  for (const route of input.routes) {
    if (admit(input, route).admitted) return route
  }
  return null
}

// ─── Attempt isolation ────────────────────────────────────────────────────────

/** Content-free usage recorded against exactly one attempt. */
export interface AttemptUsage {
  model: string
  inputTokens: number
  outputTokens: number
}

/**
 * A per-attempt mutable view over an otherwise immutable route. The route and
 * its runner are shared; usage, abort and owner state are not.
 */
export interface RouteAttempt {
  readonly connectionKey: string
  readonly modelId: string
  readonly owner: string
  readonly controller: AbortController
  readonly signal: AbortSignal
  usage: AttemptUsage | null
  settled: boolean
}

/** Begin owner-local mutable state for one dispatch of a shared connection. */
export function beginRouteAttempt(connectionKeyValue: string, modelId: string, owner: string): RouteAttempt {
  const controller = new AbortController()
  return {
    connectionKey: connectionKeyValue,
    modelId,
    owner,
    controller,
    signal: controller.signal,
    usage: null,
    settled: false,
  }
}

/**
 * Settle usage against one attempt. Late usage after cancellation, or a second
 * settlement, is fenced and never mutates the shared route.
 */
export function recordRouteAttemptUsage(attempt: RouteAttempt, usage: AttemptUsage): boolean {
  if (attempt.settled || attempt.signal.aborted) return false
  attempt.usage = { ...usage }
  attempt.settled = true
  return true
}
