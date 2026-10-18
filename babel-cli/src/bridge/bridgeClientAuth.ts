/**
 * Bridge HTTP client identity and authentication helpers.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  extractBearerToken,
  extractQueryToken,
  verifyToken,
} from './auth.js';
import type { DevicePairingService } from './devicePairing.js';
import { REMOTE_PAIRING_COOKIE } from './devicePairing.js';

export type BridgeAuthKind = 'host_bearer' | 'query_bearer' | 'paired_device' | 'none';

export interface BridgeClientContext {
  authKind: BridgeAuthKind;
  clientId: string;
  deviceId?: string;
}

interface ParsedUrl {
  pathname: string;
  searchParams: URLSearchParams;
}

export function pairingCookieToken(req: IncomingMessage): string | undefined {
  const raw = req.headers['cookie'];
  if (!raw || typeof raw !== 'string') return undefined;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${REMOTE_PAIRING_COOKIE}=`)) {
      return decodeURIComponent(trimmed.slice(REMOTE_PAIRING_COOKIE.length + 1));
    }
  }
  return undefined;
}

function hostClientIdFromBearer(token: string): string {
  const digest = createHash('sha256').update(token).digest('base64url');
  return `host:${digest}`;
}

export function resolveBridgeClientContext(
  req: IncomingMessage,
  authToken: string,
  parsedUrl?: ParsedUrl | null,
  pairing?: DevicePairingService,
): BridgeClientContext {
  const headerToken = extractBearerToken(req.headers['authorization']);
  if (headerToken && verifyToken(headerToken, authToken)) {
    return { authKind: 'host_bearer', clientId: hostClientIdFromBearer(headerToken) };
  }

  const cookieToken = pairingCookieToken(req);
  if (cookieToken && pairing) {
    const verified = pairing.verifySessionToken(cookieToken);
    if (verified.ok) {
      return {
        authKind: 'paired_device',
        clientId: `device:${verified.deviceId}`,
        deviceId: verified.deviceId,
      };
    }
  }

  if (parsedUrl) {
    const queryToken = extractQueryToken(
      new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`),
    );
    if (queryToken && verifyToken(queryToken, authToken)) {
      return { authKind: 'query_bearer', clientId: hostClientIdFromBearer(queryToken) };
    }
  }

  return { authKind: 'none', clientId: 'anonymous' };
}

export function isBridgeClientAuthenticated(
  req: IncomingMessage,
  authToken: string,
  parsedUrl?: ParsedUrl | null,
  pairing?: DevicePairingService,
): boolean {
  return resolveBridgeClientContext(req, authToken, parsedUrl, pairing).authKind !== 'none';
}

/** Host administration (pairing challenge, approve, device list) requires host bearer, not a paired cookie. */
export function isBridgeHostAdminAuthenticated(
  req: IncomingMessage,
  authToken: string,
  parsedUrl?: ParsedUrl | null,
): boolean {
  const headerToken = extractBearerToken(req.headers['authorization']);
  if (headerToken && verifyToken(headerToken, authToken)) return true;
  if (parsedUrl) {
    const queryToken = extractQueryToken(
      new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`),
    );
    if (queryToken && verifyToken(queryToken, authToken)) return true;
  }
  return false;
}

export function constantTimeEqualStrings(a: string, b: string): boolean {
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
