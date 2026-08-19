import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadOwnershipRegistry } from './threadOwnership.js';

test('mint fails closed until bind-at-create; other session and stale denied', () => {
  const reg = new ThreadOwnershipRegistry();
  assert.equal(
    reg.authorizeMint({ threadId: 't1', sessionId: 'sA', threadExists: false }).ok,
    false,
  );
  const unowned = reg.authorizeMint({ threadId: 't1', sessionId: 'sA', threadExists: true });
  assert.equal(unowned.ok, false);
  if (!unowned.ok) assert.equal(unowned.error, 'unowned_thread');
  reg.bind('t1', 'sA');
  const owner = reg.authorizeMint({ threadId: 't1', sessionId: 'sA', threadExists: true });
  assert.equal(owner.ok, true);
  const resume = reg.authorizeMint({ threadId: 't1', sessionId: 'sA', threadExists: true });
  assert.equal(resume.ok, true);
  const cross = reg.authorizeMint({ threadId: 't1', sessionId: 'sB', threadExists: true });
  assert.equal(cross.ok, false);
  if (!cross.ok) assert.equal(cross.error, 'owned_by_other');
  reg.deactivate('t1');
  const stale = reg.authorizeMint({ threadId: 't1', sessionId: 'sA', threadExists: true });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error, 'inactive_thread');
});
