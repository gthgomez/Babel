import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hostStateAfterTransportEvent,
  reconcileAfterSubmitFailure,
} from './remoteReconnect.js';
import {
  canCancelTurn,
  canSendTurn,
  IllegalUiTransitionError,
  transitionApproval,
  transitionHost,
  transitionTurn,
} from './remoteUiState.js';

describe('remote reconnect and UI state', () => {
  it('does not auto-resubmit after ambiguous submit or host unavailable', () => {
    const unknown = reconcileAfterSubmitFailure({
      responseSettled: false,
      commandId: 'cmd-1',
      hostReachable: true,
    });
    assert.equal(unknown.host, 'UNKNOWN');
    assert.equal(unknown.shouldResubmit, false);
    assert.equal(unknown.ambiguity, 'ambiguous_network');

    const down = reconcileAfterSubmitFailure({
      responseSettled: false,
      hostReachable: false,
    });
    assert.equal(down.host, 'OFFLINE');
    assert.equal(down.shouldResubmit, false);

    const accepted = reconcileAfterSubmitFailure({
      responseSettled: true,
      acceptedTurnId: 3,
      hostReachable: true,
    });
    assert.equal(accepted.shouldResubmit, false);
    assert.equal(accepted.next, 'history.lookup');
  });

  it('rejects illegal host/turn/approval transitions and double-send', () => {
    assert.equal(transitionHost('UNKNOWN', 'start'), 'CONNECTING');
    assert.equal(hostStateAfterTransportEvent('CONNECTING', 'open'), 'ONLINE');
    assert.throws(() => transitionHost('ONLINE', 'start'), IllegalUiTransitionError);
    assert.equal(transitionTurn('IDLE', 'submit'), 'SUBMITTING');
    assert.throws(() => transitionTurn('STREAMING', 'submit'), IllegalUiTransitionError);
    assert.equal(canSendTurn('READY', 'IDLE'), true);
    assert.equal(canSendTurn('RUNNING', 'STREAMING'), false);
    assert.equal(canCancelTurn('STREAMING'), true);
    assert.equal(transitionApproval('NONE', 'pending'), 'PENDING');
    assert.throws(() => transitionApproval('NONE', 'allow'), IllegalUiTransitionError);
  });
});
