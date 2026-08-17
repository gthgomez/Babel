/**
 * Structured Origin matching for Remote Stage 1.
 * Prefix string checks are not a security decision.
 */

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.replace(/^::ffff:/, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function parseOriginUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function parseAllowed(raw: string): { protocol: string; hostname: string; anyPort: boolean; port: string } | null {
  if (raw === '*' || raw.includes('*')) return null;
  const wildcardPort = raw.endsWith(':*');
  const candidate = wildcardPort ? raw.slice(0, -2) : raw;
  const url = parseOriginUrl(candidate.includes('://') ? candidate : `http://${candidate}`);
  if (!url) return null;
  const hostname = url.hostname.toLowerCase();
  const loopbackHost = hostname === 'localhost' || hostname === '127.0.0.1';
  return {
    protocol: url.protocol,
    hostname,
    anyPort: wildcardPort || (loopbackHost && !url.port),
    port: url.port,
  };
}

/** Browser Origin must match structured policy. Missing Origin is CLI-only on loopback. */
export function originAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
  remoteAddress?: string,
): boolean {
  if (origin === 'null') return false;
  if (!origin) return isLoopbackAddress(remoteAddress);
  const got = parseOriginUrl(origin);
  if (!got) return false;
  const hostname = got.hostname.toLowerCase();
  return allowedOrigins.some((raw) => {
    const allowed = parseAllowed(raw);
    if (!allowed) return false;
    if (allowed.protocol !== got.protocol) return false;
    if (allowed.hostname !== hostname) return false;
    if (allowed.anyPort) return true;
    const expectedPort = allowed.port || (allowed.protocol === 'https:' ? '443' : '80');
    const actualPort = got.port || (got.protocol === 'https:' ? '443' : '80');
    return expectedPort === actualPort;
  });
}
