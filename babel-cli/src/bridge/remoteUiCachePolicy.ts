/**
 * Service-worker cache policy for the Remote V1 installable shell.
 * Authenticated and runtime paths are network-only.
 */

export const REMOTE_UI_SHELL_PATHS = [
  '/ui',
  '/ui/',
  '/ui/index.html',
  '/ui/app.js',
  '/ui/styles.css',
  '/ui/state.js',
  '/ui/render.js',
  '/ui/sw.js',
  '/ui/manifest.webmanifest',
  '/ui/icon.svg',
] as const;

export const REMOTE_UI_NETWORK_ONLY_PREFIXES = [
  '/rpc',
  '/ws',
  '/sessions',
  '/health',
] as const;

export function isRemoteUiShellPath(pathname: string): boolean {
  const path = pathname.split('?')[0] ?? pathname;
  return (REMOTE_UI_SHELL_PATHS as readonly string[]).includes(path);
}

export function isRemoteUiNetworkOnlyPath(pathname: string): boolean {
  const path = pathname.split('?')[0] ?? pathname;
  return REMOTE_UI_NETWORK_ONLY_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`),
  );
}

export function shouldCacheRemoteUiRequest(input: {
  pathname: string;
  method?: string;
  hasAuthorization?: boolean;
}): boolean {
  const method = (input.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return false;
  if (input.hasAuthorization) return false;
  if (isRemoteUiNetworkOnlyPath(input.pathname)) return false;
  return isRemoteUiShellPath(input.pathname);
}
