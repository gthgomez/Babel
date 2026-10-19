import { createHmac, randomUUID } from 'node:crypto';

export const DESKTOP_CLIENT_ID_HEADER = 'x-babel-desktop-client-id';
export const DESKTOP_PROOF_HEADER = 'x-babel-desktop-controller-proof';

/** Mint a Desktop controller id matching the bridge shared-session contract. */
export function mintDesktopControllerClientId() {
  return `desktop:${randomUUID().replace(/-/g, '')}`;
}

export function computeDesktopControllerProof(proofKey, desktopClientId) {
  return createHmac('sha256', proofKey).update(desktopClientId, 'utf8').digest('base64url');
}

export function loopbackProtocolHeaders(desktopClientId, proofKey, extra = {}) {
  if (typeof desktopClientId !== 'string' || !desktopClientId.startsWith('desktop:')) {
    throw new TypeError('Invalid desktop controller id');
  }
  if (typeof proofKey !== 'string' || !proofKey) {
    throw new TypeError('Desktop controller proof key is required');
  }
  return {
    [DESKTOP_CLIENT_ID_HEADER]: desktopClientId,
    [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(proofKey, desktopClientId),
    'Content-Type': 'application/json',
    ...extra,
  };
}
