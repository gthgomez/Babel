/**
 * One truthful route report shared by CLI, TUI and (via JSON) Desktop.
 *
 * Reports requested vs resolved identity, credential presence (never value),
 * transport capabilities, offline usability and budget enforcement. A
 * configured or saved route is never reported as authenticated or verified.
 */
import { getProviderSpec, isProviderId, providerSupportsOperation, type ProviderOperation } from './providerRegistry.js'
import { describeOfflineRoute, type OfflineModeSource } from '../config/offlineMode.js'
import { isProfileAccountReference, readProviderKeyReference } from '../config/providerAccountKeys.js'

export interface ProviderRouteReport {
  requested_model: string | null
  resolved_provider: string | null
  resolved_model: string | null
  alias: { from: string; to: string; notice: string | null } | null
  operations: readonly ProviderOperation[]
  capabilities: {
    structured: boolean
    raw: boolean
    raw_stream: boolean
    native_tool_stream: boolean
    native_tools_qualified: boolean
    authority_conformance: 'certified' | 'untested' | 'unknown'
  }
  credential: {
    required: boolean
    variable: string | null
    present: boolean
    source: 'environment' | 'private-profile' | 'none' | 'unknown'
  }
  offline: {
    active: boolean
    source: OfflineModeSource
    provider_local: boolean
    usable: boolean
  }
  budget: {
    requested_usd: number | 'unlimited' | null
    source: string | null
    enforcement: 'unlimited' | 'standard-work-task-allowance' | 'unsupported-lane' | 'not-set'
    unsupported_lanes: readonly string[]
  }
  connectivity: 'unverified'
  observed_model: null
}

export interface ProviderRouteReportInput {
  requestedModel?: string | null
  provider: string | null
  model: string | null
  baseUrl?: string | undefined
  apiKeyEnvVar?: string | null
  authentication?: 'api-key' | 'none' | undefined
  aliasFrom?: string | undefined
  aliasTo?: string | undefined
  aliasNotice?: string | undefined
  budgetUsd?: number | 'unlimited' | null
  budgetSource?: string | null
  env?: NodeJS.ProcessEnv
}

const UNSUPPORTED_FINITE_BUDGET_LANES = ['plan', 'thorough work', 'apply'] as const

/** Resolve a shared report from local configuration only; performs no I/O. */
export function buildProviderRouteReport(input: ProviderRouteReportInput): ProviderRouteReport {
  const env = input.env ?? process.env
  const provider = input.provider
  const knownProvider = provider !== null && isProviderId(provider) ? provider : null
  const spec = knownProvider ? getProviderSpec(knownProvider) : null
  const operations = spec?.operations ?? []
  const keyName = input.apiKeyEnvVar ?? spec?.credentialEnvVar ?? null
  const credentialRequired = input.authentication !== 'none' && Boolean(spec?.requiresCredential)
  const credentialPresent = input.authentication === 'none' || !credentialRequired ||
    Boolean(knownProvider && keyName && readProviderKeyReference(knownProvider, keyName, env))
  const offline = describeOfflineRoute({
    provider: provider ?? 'unknown',
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    env,
  })
  const budget = input.budgetUsd ?? null
  const budgetEnforcement = budget === null
    ? 'not-set' as const
    : budget === 'unlimited'
      ? 'unlimited' as const
      : provider === null
        ? 'not-set' as const
        : 'standard-work-task-allowance' as const
  return {
    requested_model: input.requestedModel ?? input.model,
    resolved_provider: input.provider,
    resolved_model: input.model,
    alias: input.aliasFrom && input.aliasTo
      ? { from: input.aliasFrom, to: input.aliasTo, notice: input.aliasNotice ?? null }
      : null,
    operations,
    capabilities: {
      structured: knownProvider ? providerSupportsOperation(knownProvider, 'structured') : false,
      raw: knownProvider ? providerSupportsOperation(knownProvider, 'raw') : false,
      raw_stream: knownProvider ? providerSupportsOperation(knownProvider, 'raw_stream') : false,
      native_tool_stream: knownProvider ? providerSupportsOperation(knownProvider, 'native_tool_stream') : false,
      native_tools_qualified: Boolean(spec && spec.authorityConformance === 'certified' && operations.includes('native_tool_stream')),
      authority_conformance: spec?.authorityConformance ?? 'unknown',
    },
    credential: {
      required: credentialRequired,
      variable: input.authentication === 'none' ? null : keyName,
      present: credentialPresent,
      source: input.authentication === 'none' ? 'none' : !credentialRequired ? 'unknown'
        : keyName && isProfileAccountReference(keyName) ? 'private-profile' : 'environment',
    },
    offline: {
      active: offline.offline,
      source: offline.source as OfflineModeSource,
      provider_local: offline.provider_local,
      usable: offline.usable_offline,
    },
    budget: {
      requested_usd: budget,
      source: input.budgetSource ?? null,
      enforcement: budgetEnforcement,
      unsupported_lanes: budgetEnforcement === 'standard-work-task-allowance' ? UNSUPPORTED_FINITE_BUDGET_LANES : [],
    },
    connectivity: 'unverified',
    observed_model: null,
  }
}
