/**
 * Device pairing landing page (no secrets embedded).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

import { resolveRemoteUiDir } from './remoteUiAssets.js';

export function writePairUiResponse(res: ServerResponse): boolean {
  const dir = resolveRemoteUiDir();
  const file = join(dir, 'pair.html');
  if (!existsSync(file)) return false;
  const body = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
  });
  res.end(body);
  return true;
}
