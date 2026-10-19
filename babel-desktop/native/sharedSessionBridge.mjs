import { randomUUID } from 'node:crypto';

export const DESKTOP_CLIENT_ID_HEADER = 'x-babel-desktop-client-id';

/** Mint a Desktop controller id matching the bridge shared-session contract. */
export function mintDesktopControllerClientId() {
  return `desktop:${randomUUID().replace(/-/g, '')}`;
}

export function loopbackProtocolHeaders(desktopClientId, extra = {}) {
  if (typeof desktopClientId !== 'string' || !desktopClientId.startsWith('desktop:')) {
    throw new TypeError('Invalid desktop controller id');
  }
  return {
    [DESKTOP_CLIENT_ID_HEADER]: desktopClientId,
    'Content-Type': 'application/json',
    ...extra,
  };
}
