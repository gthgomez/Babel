import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadOwnershipRegistry } from './threadOwnership.js';

test('unknown thread cannot mint; first claim binds; other session denied; stale denied', () => {
  const reg = new ThreadOwnershipRegistry();
  assert.equal(
    reg.authorizeMint({ threadId: 't1', sessionId: 'sA', threadExists: false }).ok,
    false,
  );
  const first = reg.authorizeMint({ threadId: 't1', sessionId: 'sA', threadExists: true });
  assert.equal(first.ok, true);
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
