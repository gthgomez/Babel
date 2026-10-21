import { ProviderInvokeDiagnosticsSchema } from '../../contracts/providerInvokeDiagnostics.js'
import type { ProviderInvokeDiagnostics } from '../../contracts/providerInvokeDiagnostics.js'

export function parseBoundedProviderInvokeDiagnostics(
  value: unknown,
): ProviderInvokeDiagnostics {
  return ProviderInvokeDiagnosticsSchema.parse(value)
}

export function assertNoForbiddenPersistenceSubstrings(
  serialized: string,
  forbidden: readonly string[],
): void {
  for (const needle of forbidden) {
    if (serialized.includes(needle)) {
      throw new Error(`forbidden persistence substring present: ${needle}`)
    }
  }
}
