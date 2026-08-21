/** Canonical provider identifiers understood by Babel's model runtime. */
export const PROVIDER_IDS = [
  'deepinfra',
  'deepseek',
  'opencode',
  'openrouter',
  'openai',
  'anthropic',
  'gemini',
  'groq',
  'ollama',
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export type ProviderProtocol =
  | 'openai_compatible'
  | 'deepseek'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'ollama'

export type ProviderOperation =
  | 'structured'
  | 'raw'
  | 'raw_stream'
  | 'native_tool_stream'

/**
 * Authority-conformance certification (P0-E).
 *
 * A provider may be activated in a LIVE execution lane only when it has passed
 * the authority-conformance suite (src/agent/authorityConformance.test.ts):
 * every effect it can reach — direct API, CLI wrapper, tool path — must land
 * on Babel's authority boundary, never on the provider's own permission model.
 * Dormant/legacy providers stay `untested` and must pass the suite BEFORE being
 * revived into a live lane; they must not become live accidentally.
 */
export type AuthorityConformanceStatus = 'certified' | 'untested'

export interface ProviderSpec {
  id: ProviderId
  credentialEnvVar: string | null
  protocol: ProviderProtocol
  requiresCredential: boolean
  operations: readonly ProviderOperation[]
  /** P0-E: authority-conformance certification gate for live activation. */
  authorityConformance: AuthorityConformanceStatus
}

const PROVIDER_SPECS: Readonly<Record<ProviderId, ProviderSpec>> = Object.freeze({
  // Live lanes (authority-conformance certified — see authorityConformance.test.ts).
  deepinfra: {
    id: 'deepinfra',
    credentialEnvVar: 'DEEPINFRA_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
  },
  deepseek: {
    id: 'deepseek',
    credentialEnvVar: 'DEEPSEEK_API_KEY',
    protocol: 'deepseek',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
  },
  ollama: {
    id: 'ollama',
    credentialEnvVar: null,
    protocol: 'ollama',
    requiresCredential: false,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
  },
  // Dormant / legacy transports — NOT authority-certified. They must pass the
  // authority-conformance suite before being revived into a live lane.
  openrouter: {
    id: 'openrouter',
    credentialEnvVar: 'OPENROUTER_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'untested',
  },
  opencode: {
    id: 'opencode',
    credentialEnvVar: 'OPENCODE_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'untested',
  },
  openai: {
    id: 'openai',
    credentialEnvVar: 'OPENAI_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured'],
    authorityConformance: 'untested',
  },
  anthropic: {
    id: 'anthropic',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    protocol: 'anthropic',
    requiresCredential: true,
    operations: ['structured'],
    authorityConformance: 'untested',
  },
  gemini: {
    id: 'gemini',
    credentialEnvVar: 'GEMINI_API_KEY',
    protocol: 'gemini',
    requiresCredential: true,
    operations: ['structured'],
    authorityConformance: 'untested',
  },
  groq: {
    id: 'groq',
    credentialEnvVar: 'GROQ_API_KEY',
    protocol: 'groq',
    requiresCredential: true,
    operations: ['structured'],
    authorityConformance: 'untested',
  },
})

/** Return true when a string is a registered provider identifier. */
export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
}

/** Resolve immutable runtime metadata for a provider. */
export function getProviderSpec(provider: ProviderId): ProviderSpec {
  return PROVIDER_SPECS[provider]
}

/** Enumerate provider metadata for diagnostics and configuration UIs. */
export function listProviderSpecs(): ProviderSpec[] {
  return PROVIDER_IDS.map((provider) => PROVIDER_SPECS[provider])
}

export function providerSupportsOperation(
  provider: ProviderId,
  operation: ProviderOperation,
): boolean {
  return PROVIDER_SPECS[provider].operations.includes(operation)
}
