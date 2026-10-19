/**
 * Loopback-only Desktop controller identity for shared protocol-host sessions.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { BridgeClientContext } from './bridgeClientAuth.js';

export const DESKTOP_CLIENT_ID_HEADER = 'x-babel-desktop-client-id';

const DESKTOP_CLIENT_ID_RE = /^desktop:[A-Za-z0-9_-]{8,128}$/;

export function normalizeDesktopControllerClientId(value: string): string | null {
  const trimmed = value.trim();
  if (!DESKTOP_CLIENT_ID_RE.test(trimmed)) return null;
  return trimmed;
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1') {
    return true;
  }
  return remoteAddress.startsWith('::ffff:127.0.0.1');
}

export function resolveDesktopControllerContext(
  req: IncomingMessage,
  expectedClientId: string | undefined,
): BridgeClientContext | null {
  if (!expectedClientId) return null;
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return null;
  const raw = req.headers[DESKTOP_CLIENT_ID_HEADER];
  const header = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!header) return null;
  const clientId = normalizeDesktopControllerClientId(header);
  if (!clientId || clientId !== expectedClientId) return null;
  return { authKind: 'desktop_controller', clientId };
}

export function isDesktopControllerClientId(clientId: string): boolean {
  return clientId.startsWith('desktop:');
}

/** Mint a stable loopback Desktop controller id for one shared bridge launch. */
export function mintDesktopControllerClientId(): string {
  const suffix = randomUUID().replace(/-/g, '');
  return `desktop:${suffix}`;
}
