/**
 * Serve the Remote V1 supervisory PWA shell. No secrets in these files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

import { isRemoteUiShellPath } from './remoteUiCachePolicy.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function resolveRemoteUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(here, '..', '..');
  const candidates = [
    // Compiled/runtime layout: dist/bridge/remote-ui (build copies assets here).
    join(here, 'remote-ui'),
    // Installed package layout: staged runtime resources.
    join(packageRoot, 'resources', 'bridge', 'remote-ui'),
    // Source checkout without a staging step (tsx and vitest).
    join(here, '..', '..', 'src', 'bridge', 'remote-ui'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  throw new Error(
    'Remote UI assets are missing from this installation (expected dist/bridge/remote-ui or resources/bridge/remote-ui). Reinstall the package or omit the remote UI surface.',
  );
}

export function remoteUiDirAvailable(): boolean {
  try {
    resolveRemoteUiDir();
    return true;
  } catch {
    return false;
  }
}

export function remoteUiFileForPath(pathname: string): { file: string; contentType: string } | null {
  const raw = pathname === '/ui' || pathname === '/ui/' ? '/ui/index.html' : pathname;
  if (
    !isRemoteUiShellPath(raw) &&
    raw !== '/ui/index.html' &&
    raw !== '/ui/pair.js'
  ) {
    return null;
  }
  const relative = raw.replace(/^\/ui\/?/, '') || 'index.html';
  if (relative.includes('..') || normalize(relative) !== relative) return null;
  const dir = resolveRemoteUiDir();
  const file = join(dir, relative);
  if (!existsSync(file)) return null;
  const ext = relative.includes('.') ? relative.slice(relative.lastIndexOf('.')) : '.html';
  return { file, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' };
}

export function writeRemoteUiResponse(pathname: string, res: ServerResponse): boolean {
  let resolved: { file: string; contentType: string } | null;
  try {
    resolved = remoteUiFileForPath(pathname);
  } catch {
    // A packaged install without staged shell assets must degrade to 404, not
    // a 500 that makes the bridge look unhealthy to the PWA and to /health
    // consumers reading the same process.
    return false;
  }
  if (!resolved) return false;
  let body: Buffer;
  try {
    body = readFileSync(resolved.file);
  } catch {
    return false;
  }
  const headers: Record<string, string> = {
    'Content-Type': resolved.contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'",
  };
  if (pathname.endsWith('/sw.js') || pathname === '/ui/sw.js') {
    headers['Service-Worker-Allowed'] = '/ui';
  }
  res.writeHead(200, headers);
  res.end(body);
  return true;
}
