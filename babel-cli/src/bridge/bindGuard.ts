/**
 * Fail-closed loopback bind for Babel Remote.
 * Tailscale/reachability is outside this module — this only refuses public sockets.
 */

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export class PublicBindError extends Error {
  constructor(host: string) {
    super(
      `Babel Remote refuses to bind ${host}. The process must listen on 127.0.0.1 (or ::1). ` +
        `Do not use 0.0.0.0, and do not enable Tailscale Funnel.`,
    );
    this.name = 'PublicBindError';
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
}

/**
 * Throw if configuration would expose the HTTP server on a non-loopback address.
 */
export function assertLoopbackBind(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new PublicBindError(host);
  }
}

/**
 * Env that would override the listen host to a public address.
 * Remote serve must refuse to start when these are set to non-loopback values.
 */
export function resolveConfiguredListenHost(
  env: NodeJS.ProcessEnv = process.env,
  fallback = '127.0.0.1',
): string {
  const raw = env['BABEL_BRIDGE_HOST'] ?? env['BABEL_REMOTE_LISTEN'] ?? fallback;
  return raw.trim() || fallback;
}

export function assertRemoteListenConfig(env: NodeJS.ProcessEnv = process.env): string {
  const host = resolveConfiguredListenHost(env);
  assertLoopbackBind(host);
  const funnel = env['BABEL_REMOTE_ALLOW_FUNNEL'] ?? env['TAILSCALE_FUNNEL'];
  if (funnel && funnel !== '0' && funnel.toLowerCase() !== 'false') {
    throw new PublicBindError(`funnel-flag:${funnel}`);
  }
  return host;
}
