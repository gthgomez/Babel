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
  const nextToModule = join(here, 'remote-ui');
  if (existsSync(join(nextToModule, 'index.html'))) return nextToModule;
  const fromSrc = join(here, '..', '..', 'src', 'bridge', 'remote-ui');
  if (existsSync(join(fromSrc, 'index.html'))) return fromSrc;
  throw new Error('Remote UI assets not found next to the bridge module or under src/bridge/remote-ui');
}

export function remoteUiFileForPath(pathname: string): { file: string; contentType: string } | null {
  const raw = pathname === '/ui' || pathname === '/ui/' ? '/ui/index.html' : pathname;
  if (!isRemoteUiShellPath(raw) && raw !== '/ui/index.html') return null;
  const relative = raw.replace(/^\/ui\/?/, '') || 'index.html';
  if (relative.includes('..') || normalize(relative) !== relative) return null;
  const dir = resolveRemoteUiDir();
  const file = join(dir, relative);
  if (!existsSync(file)) return null;
  const ext = relative.includes('.') ? relative.slice(relative.lastIndexOf('.')) : '.html';
  return { file, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' };
}

export function writeRemoteUiResponse(pathname: string, res: ServerResponse): boolean {
  const resolved = remoteUiFileForPath(pathname);
  if (!resolved) return false;
  const body = readFileSync(resolved.file);
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
