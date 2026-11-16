/** Offline authority applies to every provider request, including cached runners. */
export class OfflineModeError extends Error {
  constructor(message: string) { super(message); this.name = 'OfflineModeError' }
}

export function isOfflineMode(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
  return env['BABEL_OFFLINE'] === '1' || env['BABEL_OFFLINE'] === 'true' ||
    env['BABEL_DESKTOP_PROVIDER'] === 'ollama' || argv.includes('--offline')
}

export function isOfflineRequested(env?: NodeJS.ProcessEnv): boolean {
  return isOfflineMode() || Boolean(env && isOfflineMode(env, []))
}

/** Only explicitly local endpoints may be contacted while offline. */
export function isLoopbackEndpoint(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

/** Reject remote providers before creating or invoking a transport in offline mode. */
export function assertOfflineProviderAllowed(provider: string, baseUrl?: string, env?: NodeJS.ProcessEnv): void {
  if (!isOfflineRequested(env) || provider === 'ollama' || (provider === 'openai-compatible' && isLoopbackEndpoint(baseUrl))) return
  throw new OfflineModeError(`Offline mode cannot use remote provider ${provider}. Choose a local connection or leave offline mode.`)
}

/** Reject a remote compatible endpoint at the final fetch boundary. */
export function assertOfflineEndpointAllowed(url: string, env?: NodeJS.ProcessEnv): void {
  if (isOfflineRequested(env) && !isLoopbackEndpoint(url)) {
    throw new OfflineModeError('Offline mode cannot contact a remote provider endpoint.')
  }
}
