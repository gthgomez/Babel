/**
 * Offline authority: one local-only decision for routing and dispatch.
 *
 * Offline mode is a claim that no remote provider is contacted. A saved HTTPS
 * connection, a cached runner or an ambient environment credential must not
 * widen it. These helpers are deliberately pure so routing surfaces and
 * transports can share the same answer without network or credential reads.
 */

/** Raised before constructing or invoking a remote transport while offline. */
export class OfflineModeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfflineModeError'
  }
}

/** Local loopback hosts that may still be contacted while offline. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const

/** Recognized offline sources, in precedence order. */
export type OfflineModeSource = 'babel-offline' | 'desktop-local-provider' | null

/** Return the first explicit offline source, or null for normal online routing. */
export function offlineModeSource(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): OfflineModeSource {
  if (env['BABEL_OFFLINE'] === '1' || env['BABEL_OFFLINE'] === 'true') return 'babel-offline'
  if (argv.includes('--offline')) return 'babel-offline'
  if (env['BABEL_DESKTOP_PROVIDER'] === 'ollama') return 'desktop-local-provider'
  // Lite/pipeline fixture flags select local fixture behavior inside their own
  // lanes; they are not user statements that every Babel surface is offline.
  return null
}

/**
 * True when the process or an explicitly supplied environment is offline.
 * Process-level offline authority is never weakened by a caller-provided env,
 * and an explicitly offline env cannot be bypassed by an online process.
 */
export function isOfflineMode(
  env?: NodeJS.ProcessEnv,
  argv: readonly string[] = process.argv,
): boolean {
  if (offlineModeSource(process.env, argv) !== null) return true
  return env !== undefined && offlineModeSource(env, []) !== null
}

/** True when offline mode is in force for this process or explicit environment. */
export function isOfflineRequested(env?: NodeJS.ProcessEnv): boolean {
  return isOfflineMode(env)
}

/** Accept only loopback HTTP(S) endpoints for local providers. */
export function isLoopbackEndpoint(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (LOOPBACK_HOSTS as readonly string[]).includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * Whether a provider may be used while offline.
 *
 * Ollama is local by definition; an explicit OpenAI-compatible connection is
 * local only when its declared endpoint is loopback. Every other registered
 * provider is remote-shaped and stays blocked.
 */
export function isProviderLocal(provider: string, baseUrl?: string): boolean {
  if (provider === 'ollama') return true
  return provider === 'openai-compatible' && isLoopbackEndpoint(baseUrl)
}

/** Reject a remote provider before a transport is created or invoked. */
export function assertOfflineProviderAllowed(
  provider: string,
  baseUrl?: string,
  env?: NodeJS.ProcessEnv,
): void {
  if (!isOfflineRequested(env) || isProviderLocal(provider, baseUrl)) return
  throw new OfflineModeError(
    `OFFLINE_MODE_UNAVAILABLE: Offline mode cannot use remote provider "${provider}". ` +
      'Run online, or select a local Ollama or loopback-compatible connection. ' +
      'Babel made no provider request.',
  )
}

/** Reject a non-loopback URL at the final fetch boundary, including cached runners. */
export function assertOfflineEndpointAllowed(url: string, env?: NodeJS.ProcessEnv): void {
  if (!isOfflineRequested(env) || isLoopbackEndpoint(url)) return
  throw new OfflineModeError(
    'OFFLINE_MODE_UNAVAILABLE: Offline mode cannot contact a remote provider endpoint. ' +
      'Use a loopback endpoint or run online. Babel made no provider request.',
  )
}

/** Add resolved route truth to any policy-shaped object without exposing secrets. */
export function describeOfflineRoute(input: {
  provider: string
  baseUrl?: string
  env?: NodeJS.ProcessEnv
}): { offline: boolean; source: string | null; provider_local: boolean; usable_offline: boolean } {
  const env = input.env ?? process.env
  const source = offlineModeSource(env, process.argv)
  const offline = isOfflineMode(env)
  const providerLocal = isProviderLocal(input.provider, input.baseUrl)
  return { offline, source, provider_local: providerLocal, usable_offline: !offline || providerLocal }
}
