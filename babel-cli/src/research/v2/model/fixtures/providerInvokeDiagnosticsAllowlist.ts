import { PROVIDER_INVOKE_DIAGNOSTICS_ALLOWLIST_KEYS } from './emptyResponseMetadataHandoff.fixture.js'

export type ProviderInvokeDiagnosticsRecord = Record<string, unknown>

export function assertAllowlistedProviderInvokeDiagnosticsOnly(
  diagnostics: ProviderInvokeDiagnosticsRecord,
): void {
  for (const key of Object.keys(diagnostics)) {
    if (!PROVIDER_INVOKE_DIAGNOSTICS_ALLOWLIST_KEYS.has(key)) {
      throw new Error(`provider_invoke_diagnostics key not allowlisted: ${key}`)
    }
  }
}

export function assertNoForbiddenPersistenceSubstrings(serialized: string, forbidden: readonly string[]): void {
  for (const needle of forbidden) {
    if (serialized.includes(needle)) {
      throw new Error(`forbidden persistence substring present: ${needle}`)
    }
  }
}
