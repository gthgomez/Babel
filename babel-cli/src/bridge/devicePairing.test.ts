import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DevicePairingService } from './devicePairing.js';

describe('DevicePairingService', () => {
  let tmp: string;
  let prevHome: string | undefined;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-pairing-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = tmp;
  });

  after(() => {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pairs a device through challenge, approval, and exchange', () => {
    const pairing = new DevicePairingService('test-secret');
    const challenge = pairing.createChallenge();
    assert.ok(pairing.requestPairing(challenge.challengeId, 'Pixel 8').ok);
    const approved = pairing.approveChallenge(challenge.challengeId);
    assert.equal(approved.ok, true);
    assert.equal(pairing.challengeStatus(challenge.challengeId).state, 'approved');
    const session = pairing.exchangeChallenge(challenge.challengeId);
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const verified = pairing.verifySessionToken(session.session.sessionToken);
    assert.equal(verified.ok, true);
    assert.equal(pairing.exchangeChallenge(challenge.challengeId).ok, false);
  });

  it('revokes a device and invalidates sessions', () => {
    const pairing = new DevicePairingService('test-secret-2');
    const challenge = pairing.createChallenge();
    pairing.requestPairing(challenge.challengeId, 'Browser');
    const approved = pairing.approveChallenge(challenge.challengeId);
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    const session = pairing.exchangeChallenge(challenge.challengeId);
    assert.equal(session.ok, true);
    if (!session.ok) return;
    assert.equal(pairing.revokeDevice(approved.device.deviceId), true);
    assert.equal(pairing.verifySessionToken(session.session.sessionToken).ok, false);
  });
});
