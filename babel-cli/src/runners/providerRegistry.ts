/** Canonical provider identifiers understood by Babel's model runtime. */
export const PROVIDER_IDS = [
  'deepinfra',
  'deepseek',
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

export interface ProviderSpec {
  id: ProviderId
  credentialEnvVar: string | null
  protocol: ProviderProtocol
  requiresCredential: boolean
  operations: readonly ProviderOperation[]
}

const PROVIDER_SPECS: Readonly<Record<ProviderId, ProviderSpec>> = Object.freeze({
  deepinfra: {
    id: 'deepinfra',
    credentialEnvVar: 'DEEPINFRA_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
  },
  deepseek: {
    id: 'deepseek',
    credentialEnvVar: 'DEEPSEEK_API_KEY',
    protocol: 'deepseek',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
  },
  openrouter: {
    id: 'openrouter',
    credentialEnvVar: 'OPENROUTER_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
  },
  openai: {
    id: 'openai',
    credentialEnvVar: 'OPENAI_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured'],
  },
  anthropic: {
    id: 'anthropic',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    protocol: 'anthropic',
    requiresCredential: true,
    operations: ['structured'],
  },
  gemini: {
    id: 'gemini',
    credentialEnvVar: 'GEMINI_API_KEY',
    protocol: 'gemini',
    requiresCredential: true,
    operations: ['structured'],
  },
  groq: {
    id: 'groq',
    credentialEnvVar: 'GROQ_API_KEY',
    protocol: 'groq',
    requiresCredential: true,
    operations: ['structured'],
  },
  ollama: {
    id: 'ollama',
    credentialEnvVar: null,
    protocol: 'ollama',
    requiresCredential: false,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
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
