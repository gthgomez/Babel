/**
 * CSRF / origin policy for browser-originated paired-device mutations.
 */

import type { IncomingMessage } from 'node:http';

import type { BridgeClientContext } from './bridgeClientAuth.js';
import { originAllowed } from './originPolicy.js';

export function pairedDeviceMutationOriginOk(
  req: IncomingMessage,
  client: BridgeClientContext,
  allowedOrigins: string[],
): boolean {
  if (client.authKind !== 'paired_device') return true;
  const origin = req.headers['origin'];
  if (!origin || typeof origin !== 'string') return false;
  return originAllowed(origin, allowedOrigins, req.socket.remoteAddress);
}
