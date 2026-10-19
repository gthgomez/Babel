/**
 * Loopback-only Desktop controller identity for shared protocol-host sessions.
 * Public client id is a correlation handle only; authentication requires a
 * per-launch proof secret never exposed as holder identity to remote clients.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { BridgeClientContext } from './bridgeClientAuth.js';

export const DESKTOP_CLIENT_ID_HEADER = 'x-babel-desktop-client-id';
export const DESKTOP_PROOF_HEADER = 'x-babel-desktop-controller-proof';

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

export function mintDesktopControllerProofKey(): string {
  return randomBytes(32).toString('base64url');
}

export function computeDesktopControllerProof(proofKey: string, clientId: string): string {
  return createHmac('sha256', proofKey).update(clientId, 'utf8').digest('base64url');
}

export function verifyDesktopControllerProof(
  proofKey: string,
  clientId: string,
  proofHeader: string | undefined,
): boolean {
  if (!proofHeader || !proofKey) return false;
  const expected = computeDesktopControllerProof(proofKey, clientId);
  return timingSafeEqualProof(expected, proofHeader.trim());
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw[0]) return raw[0];
  return undefined;
}

export function resolveDesktopControllerContext(
  req: IncomingMessage,
  expectedClientId: string | undefined,
  proofKey: string | undefined,
): BridgeClientContext | null {
  if (!expectedClientId || !proofKey) return null;
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return null;
  const header = headerValue(req, DESKTOP_CLIENT_ID_HEADER);
  if (!header) return null;
  const clientId = normalizeDesktopControllerClientId(header);
  if (!clientId || clientId !== expectedClientId) return null;
  const proof = headerValue(req, DESKTOP_PROOF_HEADER);
  if (!verifyDesktopControllerProof(proofKey, clientId, proof)) return null;
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

/** @internal test helper */
export function timingSafeEqualProof(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) {
      timingSafeEqual(right, right);
      return false;
    }
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}
