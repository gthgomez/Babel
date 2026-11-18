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
    profileAbsent: async () => true,
  });
  assert.deepEqual(order, ['settle', 'terminate', 'release', 'remove']);
  assert.equal(result.state, 'terminated');
  assert.deepEqual(result.profileCleanup, {state: 'removed', attempts: 1});
});

test('transient Windows profile removal errors retry and verify the owned profile is absent', async () => {
  let present = true;
  let attempts = 0;
  const result = await cleanupOwnedFixture({
    settleTurn: async () => {},
    terminateTree: async () => true,
    releaseProvider: async () => {},
    retainProvider: () => assert.fail('terminated tree must not retain provider'),
    removeProfile: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('private path must not escape');
        error.code = 'EPERM';
        throw error;
      }
      present = false;
    },
    profileAbsent: async () => !present,
  });

  assert.equal(attempts, 2);
  assert.equal(result.state, 'terminated');
  assert.deepEqual(result.profileCleanup, {state: 'removed', attempts: 2});
  assert.deepEqual(result.errors, []);
  assert.ok(!JSON.stringify(result).includes('private path'));
});

test('persistent transient profile removal errors stop after the bounded retry count with a sanitized code', async () => {
  let attempts = 0;
  const result = await cleanupOwnedFixture({
    settleTurn: async () => {},
    terminateTree: async () => true,
    releaseProvider: async () => {},
    retainProvider: () => assert.fail('terminated tree must not retain provider'),
    removeProfile: async () => {
      attempts += 1;
      const error = new Error('C:\\private\\profile');
      error.code = 'EPERM';
      throw error;
    },
    profileAbsent: async () => false,
  });

  assert.equal(attempts, 4);
  assert.equal(result.state, 'terminated');
  assert.deepEqual(result.errors, ['profile']);
  assert.deepEqual(result.profileCleanup, {state: 'failed', code: 'EPERM', attempts: 4});
  assert.ok(!JSON.stringify(result).includes('C:\\private\\profile'));
});

test('permanent profile removal errors are reported once without retrying', async () => {
  let attempts = 0;
  const result = await cleanupOwnedFixture({
    settleTurn: async () => {},
    terminateTree: async () => true,
    releaseProvider: async () => {},
    retainProvider: () => assert.fail('terminated tree must not retain provider'),
    removeProfile: async () => {
      attempts += 1;
      const error = new Error('private detail');
      error.code = 'EACCES';
      throw error;
    },
    profileAbsent: async () => false,
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result.errors, ['profile']);
  assert.deepEqual(result.profileCleanup, {state: 'failed', code: 'OTHER', attempts: 1});
  assert.ok(!JSON.stringify(result).includes('private detail'));
});

test('a successful remove call is not accepted while the owned profile remains present', async () => {
  const result = await cleanupOwnedFixture({
    settleTurn: async () => {},
    terminateTree: async () => true,
    releaseProvider: async () => {},
    retainProvider: () => assert.fail('terminated tree must not retain provider'),
    removeProfile: async () => {},
    profileAbsent: async () => false,
  });

  assert.equal(result.state, 'terminated');
  assert.deepEqual(result.errors, ['profile']);
  assert.deepEqual(result.profileCleanup, {state: 'failed', code: 'OTHER', attempts: 1});
});

test('unconfirmed tree termination retains the provider and profile', async () => {
  const order = [];
  const result = await cleanupOwnedFixture({
    settleTurn: async () => { order.push('settle'); throw new Error('timeout'); },
    terminateTree: async () => { order.push('terminate'); return false; },
    releaseProvider: async () => { order.push('release'); },
    retainProvider: () => { order.push('retain'); },
    removeProfile: async () => { order.push('remove'); },
    profileAbsent: async () => { order.push('verify-absent'); return false; },
  });
  assert.deepEqual(order, ['settle', 'terminate', 'retain']);
  assert.equal(result.state, 'unresolved');
  assert.equal(result.turnSettled, false);
  assert.equal(result.profileCleanup, undefined);
});
