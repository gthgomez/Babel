import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IncomingMessage } from 'node:http';

import { pairingCookieToken } from './bridgeClientAuth.js';
import { REMOTE_PAIRING_COOKIE } from './devicePairing.js';

describe('pairing cookie parsing', () => {
  it('ignores malformed percent encoding instead of throwing', () => {
    assert.doesNotThrow(() => {
      assert.equal(
        pairingCookieToken({ headers: { cookie: `${REMOTE_PAIRING_COOKIE}=%E0%A4%A` } } as IncomingMessage),
        undefined,
      );
    });
  });

  it('ignores oversized pairing tokens', () => {
    const token = 'x'.repeat(8193);
    assert.equal(
      pairingCookieToken({ headers: { cookie: `${REMOTE_PAIRING_COOKIE}=${token}` } } as IncomingMessage),
      undefined,
    );
  });
});
