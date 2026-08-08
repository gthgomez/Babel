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

export interface ProviderSpec {
  id: ProviderId
  credentialEnvVar: string | null
  protocol: ProviderProtocol
  requiresCredential: boolean
}

const PROVIDER_SPECS: Readonly<Record<ProviderId, ProviderSpec>> = Object.freeze({
  deepinfra: {
    id: 'deepinfra',
    credentialEnvVar: 'DEEPINFRA_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
  },
  deepseek: {
    id: 'deepseek',
    credentialEnvVar: 'DEEPSEEK_API_KEY',
    protocol: 'deepseek',
    requiresCredential: true,
  },
  openrouter: {
    id: 'openrouter',
    credentialEnvVar: 'OPENROUTER_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
  },
  openai: {
    id: 'openai',
    credentialEnvVar: 'OPENAI_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
  },
  anthropic: {
    id: 'anthropic',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    protocol: 'anthropic',
    requiresCredential: true,
  },
  gemini: {
    id: 'gemini',
    credentialEnvVar: 'GEMINI_API_KEY',
    protocol: 'gemini',
    requiresCredential: true,
  },
  groq: {
    id: 'groq',
    credentialEnvVar: 'GROQ_API_KEY',
    protocol: 'groq',
    requiresCredential: true,
  },
  ollama: {
    id: 'ollama',
    credentialEnvVar: null,
    protocol: 'ollama',
    requiresCredential: false,
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
