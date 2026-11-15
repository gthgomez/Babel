// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupOwnedFixture} from './owned-cleanup.mjs';

test('cleanup settles the task and kills its owned tree before releasing provider and profile', async () => {
  const order = [];
  const result = await cleanupOwnedFixture({
    settleTurn: async () => { order.push('settle'); },
    terminateTree: async () => { order.push('terminate'); return true; },
    releaseProvider: async () => { order.push('release'); },
    retainProvider: () => { order.push('retain'); },
    removeProfile: async () => { order.push('remove'); },
  });
  assert.deepEqual(order, ['settle', 'terminate', 'release', 'remove']);
  assert.equal(result.state, 'terminated');
});

test('unconfirmed tree termination retains the provider and profile', async () => {
  const order = [];
  const result = await cleanupOwnedFixture({
    settleTurn: async () => { order.push('settle'); throw new Error('timeout'); },
    terminateTree: async () => { order.push('terminate'); return false; },
    releaseProvider: async () => { order.push('release'); },
    retainProvider: () => { order.push('retain'); },
    removeProfile: async () => { order.push('remove'); },
  });
  assert.deepEqual(order, ['settle', 'terminate', 'retain']);
  assert.equal(result.state, 'unresolved');
  assert.equal(result.turnSettled, false);
});
