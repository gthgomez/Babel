import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ControlLeaseRegistry } from './controlLease.js';

describe('ControlLeaseRegistry', () => {
  it('acquires, renews, and releases with epoch fencing', () => {
    const leases = new ControlLeaseRegistry({ ttlMs: 60_000 });
    const a = leases.acquire({ threadId: 'thr-1', clientId: 'device:a' });
    assert.equal(a.ok, true);
    if (!a.ok) return;
    assert.equal(a.epoch, 1);

    const blocked = leases.acquire({ threadId: 'thr-1', clientId: 'device:b' });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.error, 'held_by_other');

    const renewed = leases.renew({ threadId: 'thr-1', clientId: 'device:a', epoch: 1 });
    assert.equal(renewed.ok, true);

    const stale = leases.authorizeMutation({
      threadId: 'thr-1',
      clientId: 'device:a',
      controlEpoch: 0,
      allowHostAutoAcquire: false,
      requireExplicitEpoch: true,
    });
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error, 'stale_epoch');

    const released = leases.release({ threadId: 'thr-1', clientId: 'device:a', epoch: 1 });
    assert.equal(released.ok, true);
    assert.equal(leases.status('thr-1').held, false);
  });

  it('bumps epoch on reacquire after release and rejects stale same-device commands', () => {
    const leases = new ControlLeaseRegistry({ ttlMs: 60_000 });
    const first = leases.acquire({ threadId: 'thr-r', clientId: 'device:a' });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.epoch, 1);
    leases.release({ threadId: 'thr-r', clientId: 'device:a', epoch: 1 });
    const second = leases.acquire({ threadId: 'thr-r', clientId: 'device:a' });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.epoch, 2);
    const staleCmd = leases.authorizeMutation({
      threadId: 'thr-r',
      clientId: 'device:a',
      controlEpoch: 1,
      allowHostAutoAcquire: false,
      requireExplicitEpoch: true,
    });
    assert.equal(staleCmd.ok, false);
    if (staleCmd.ok) return;
    assert.equal(staleCmd.error, 'stale_epoch');
  });

  it('requires explicit epoch for paired holders', () => {
    const leases = new ControlLeaseRegistry();
    leases.acquire({ threadId: 'thr-p', clientId: 'device:x' });
    const missing = leases.authorizeMutation({
      threadId: 'thr-p',
      clientId: 'device:x',
      allowHostAutoAcquire: false,
      requireExplicitEpoch: true,
    });
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.error, 'epoch_required');
  });

  it('auto-acquires for host-local clients when no lease exists', () => {
    const leases = new ControlLeaseRegistry();
    const ok = leases.authorizeMutation({
      threadId: 'thr-2',
      clientId: 'host:local',
      allowHostAutoAcquire: true,
      requireExplicitEpoch: false,
    });
    assert.equal(ok.ok, true);
    assert.equal(leases.status('thr-2').held, true);
  });
});
