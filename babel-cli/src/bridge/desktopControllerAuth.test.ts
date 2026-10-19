import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeDesktopControllerProof,
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
  verifyDesktopControllerProof,
} from './desktopControllerAuth.js';

describe('desktop controller proof', () => {
  it('requires matching proof for a client id', () => {
    const id = mintDesktopControllerClientId();
    const key = mintDesktopControllerProofKey();
    const proof = computeDesktopControllerProof(key, id);
    assert.equal(verifyDesktopControllerProof(key, id, proof), true);
    assert.equal(verifyDesktopControllerProof(key, id, 'forged'), false);
    assert.equal(verifyDesktopControllerProof(key, mintDesktopControllerClientId(), proof), false);
  });
});
