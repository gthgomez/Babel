import { getProviderSpec, type ProviderId } from './providerRegistry.js'

export class ProviderCredentialError extends Error {
  readonly code = 'PROVIDER_CREDENTIAL_MISSING'
  readonly provider: ProviderId
  readonly envVar: string

  constructor(provider: ProviderId, envVar: string) {
    super(`[provider:${provider}] ${envVar} is not set. Add it to babel-cli/.env or the host environment.`)
    this.name = 'ProviderCredentialError'
    this.provider = provider
    this.envVar = envVar
  }
}

export interface ResolveCredentialOptions {
  env?: NodeJS.ProcessEnv
  envVarOverride?: string
  explicitCredential?: string
}

export interface CredentialStatus {
  provider: ProviderId
  envVar: string | null
  configured: boolean
  required: boolean
}

function normalizeEnvVarName(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid provider credential environment variable name: ${value}`)
  }
  return normalized
}

/** Resolve a credential at the transport boundary without logging or persisting it. */
export function resolveProviderCredential(
  provider: ProviderId,
  options: ResolveCredentialOptions = {},
): string | null {
  const spec = getProviderSpec(provider)
  if (!spec.requiresCredential) return null

  const explicit = options.explicitCredential?.trim()
  if (explicit) return explicit

  const envVar = normalizeEnvVarName(options.envVarOverride ?? spec.credentialEnvVar ?? '')
  const value = (options.env ?? process.env)[envVar]?.trim()
  if (!value) throw new ProviderCredentialError(provider, envVar)
  return value
}

/** Report credential presence without returning, hashing, or logging secret values. */
export function getProviderCredentialStatus(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): CredentialStatus {
  const spec = getProviderSpec(provider)
  const envVar = spec.credentialEnvVar
  return {
    provider,
    envVar,
    configured: envVar === null || Boolean(env[envVar]?.trim()),
    required: spec.requiresCredential,
  }
}
