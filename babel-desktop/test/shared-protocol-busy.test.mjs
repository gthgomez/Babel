import test from 'node:test';
import assert from 'node:assert/strict';

function remoteBlocksLocalAdmission(remoteBridge) {
  return Boolean(remoteBridge?.running && !remoteBridge?.sharedSession);
}

test('ready shared-session bridge does not block local admission', () => {
  assert.equal(remoteBlocksLocalAdmission({ running: true, sharedSession: true }), false);
  assert.equal(remoteBlocksLocalAdmission({ running: true, sharedSession: false }), true);
});
