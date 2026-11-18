/** Canonical provider identifiers understood by Babel's model runtime. */
export const PROVIDER_IDS = [
  'deepinfra',
  'deepseek',
  'opencode',
  'opencode-go',
  'openrouter',
  'command-code',
  'openai',
  'anthropic',
  'gemini',
  'groq',
  'ollama',
  'openai-compatible',
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

/** Benchmark-only identities; intentionally excluded from production ProviderId. */
export const BENCHMARK_PROVIDER_IDS = ['opencode-go', 'opencode-zen'] as const
export type BenchmarkProviderId = (typeof BENCHMARK_PROVIDER_IDS)[number]

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

/**
 * The tool protocol Chat actually uses for this provider.
 *
 * - `native`: send provider-native tool schemas and stream `tool_calls`.
 * - `text`: prompt-embedded `[TOOL:name]` text tools (used when a provider
 *   cannot be relied on to emit OpenAI-style native tool calls).
 *
 * `operations` describes transport capability; this field describes the
 * delivery the Chat controller selects. They must agree: advertising
 * `native_tool_stream` while Chat never sends native tool arrays is the
 * contradiction this field removes.
 */
export type ChatToolTransport = 'native' | 'text'

export interface ProviderSpec {
  id: ProviderId
  credentialEnvVar: string | null
  protocol: ProviderProtocol
  requiresCredential: boolean
  operations: readonly ProviderOperation[]
  /** P0-E: authority-conformance certification gate for live activation. */
  authorityConformance: AuthorityConformanceStatus
  /** Tool protocol Chat selects for this provider (single source of truth). */
  chatToolTransport: ChatToolTransport
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
    chatToolTransport: 'native',
  },
  deepseek: {
    id: 'deepseek',
    credentialEnvVar: 'DEEPSEEK_API_KEY',
    protocol: 'deepseek',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
    chatToolTransport: 'native',
  },
  ollama: {
    id: 'ollama',
    credentialEnvVar: null,
    protocol: 'ollama',
    requiresCredential: false,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
    // Ollama models are not reliably trained on OpenAI-style native tool arrays.
    // Chat deliberately uses the text-tool protocol; see shouldUseChatNativeTools.
    chatToolTransport: 'text',
  },
  openrouter: {
    id: 'openrouter',
    credentialEnvVar: 'OPENROUTER_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
    chatToolTransport: 'native',
  },
  'command-code': {
    id: 'command-code',
    credentialEnvVar: 'COMMAND_CODE_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    // Shared executor conformance plus actual Chat denial/result-delivery tests.
    // This does not certify live task quality or all models in the vendor catalog.
    authorityConformance: 'certified',
    chatToolTransport: 'native',
  },
  // Dormant / legacy transports — NOT authority-certified. They must pass the
  // authority-conformance suite before being revived into a live lane.
  opencode: {
    id: 'opencode',
    credentialEnvVar: 'OPENCODE_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'untested',
    chatToolTransport: 'native',
  },
  // Explicit Go transport; authority checks do not establish native budget/platform readiness.
  'opencode-go': {
    id: 'opencode-go',
    credentialEnvVar: 'BABEL_OPENCODE_GO_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    // Central authority suite plus Chat native-tool denial/delivery regressions.
    // Certification does not qualify model quality, budget durability or other modes.
    authorityConformance: 'certified',
    chatToolTransport: 'native',
  },
  // Native Chat denial/result delivery: directProviderAuthority.test.ts; wire: directProviderTools.test.ts.
  openai: {
    id: 'openai',
    credentialEnvVar: 'OPENAI_API_KEY',
    protocol: 'openai_compatible',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
    chatToolTransport: 'native',
  },
  anthropic: {
    id: 'anthropic',
    credentialEnvVar: 'ANTHROPIC_API_KEY',
    protocol: 'anthropic',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
    chatToolTransport: 'native',
  },
  gemini: {
    id: 'gemini',
    credentialEnvVar: 'GEMINI_API_KEY',
    protocol: 'gemini',
    requiresCredential: true,
    operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
    chatToolTransport: 'native',
  },
  groq: {
    id: 'groq',
    credentialEnvVar: 'GROQ_API_KEY',
    protocol: 'groq',
    requiresCredential: true,
    operations: ['structured'],
    authorityConformance: 'untested',
    chatToolTransport: 'native',
  },
  'openai-compatible': {
    id: 'openai-compatible', credentialEnvVar: 'BABEL_COMPATIBLE_API_KEY', protocol: 'openai_compatible',
    requiresCredential: true, operations: ['structured', 'raw', 'raw_stream', 'native_tool_stream'],
    authorityConformance: 'certified',
    chatToolTransport: 'native',
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

/**
 * Resolve the Chat tool protocol for a provider id.
 *
 * Unknown/legacy runner identities return null so callers keep their previous
 * capability-based behavior instead of guessing a transport.
 */
export function chatToolTransportForProvider(provider: string | null | undefined): ChatToolTransport | null {
  if (!provider || !isProviderId(provider)) return null
  return PROVIDER_SPECS[provider].chatToolTransport
}
