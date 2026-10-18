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
    });
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error, 'stale_epoch');

    const released = leases.release({ threadId: 'thr-1', clientId: 'device:a', epoch: 1 });
    assert.equal(released.ok, true);
    assert.equal(leases.status('thr-1').held, false);
  });

  it('auto-acquires for host-local clients when no lease exists', () => {
    const leases = new ControlLeaseRegistry();
    const ok = leases.authorizeMutation({
      threadId: 'thr-2',
      clientId: 'host:local',
      allowHostAutoAcquire: true,
    });
    assert.equal(ok.ok, true);
    assert.equal(leases.status('thr-2').held, true);
  });
});
