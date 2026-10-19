import test from 'node:test';
import assert from 'node:assert/strict';

function remoteBlocksLocalRunAdmission(remoteBridge) {
  return Boolean(remoteBridge?.running && !remoteBridge?.sharedSession);
}

function hostLifecycleBusy(state) {
  return Boolean(
    state.runAdmission ||
      state.runner?.busy ||
      state.remoteBridge?.running ||
      state.updateBusy ||
      state.connectionChangeBusy,
  );
}

test('shared-session bridge blocks lifecycle guards but not local run admission', () => {
  const remoteBridge = { running: true, sharedSession: true };
  assert.equal(remoteBlocksLocalRunAdmission(remoteBridge), false);
  assert.equal(
    hostLifecycleBusy({ remoteBridge, runner: null, runAdmission: false, updateBusy: false, connectionChangeBusy: false }),
    true,
  );
});

test('non-shared remote bridge blocks both admission and lifecycle', () => {
  const remoteBridge = { running: true, sharedSession: false };
  assert.equal(remoteBlocksLocalRunAdmission(remoteBridge), true);
  assert.equal(
    hostLifecycleBusy({ remoteBridge, runner: null, runAdmission: false, updateBusy: false, connectionChangeBusy: false }),
    true,
  );
});
