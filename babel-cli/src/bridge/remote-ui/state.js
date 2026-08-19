(function (root) {
  const HOST = {
    UNKNOWN: ['start', 'health_fail'],
    CONNECTING: ['open', 'error', 'health_fail'],
    ONLINE: ['close', 'health_fail'],
    OFFLINE: ['start'],
    RECONNECTING: ['open', 'health_fail', 'error'],
  };
  const THREAD = {
    NONE: ['create', 'resume'],
    CREATING: ['ready', 'fail'],
    READY: ['submit', 'recover', 'fail'],
    RUNNING: ['waiting_approval', 'ready', 'fail', 'recover'],
    WAITING_APPROVAL: ['running', 'ready', 'stale', 'fail'],
    RECOVERING: ['ready', 'running', 'fail'],
    FAILED: ['create', 'resume'],
  };
  const TURN = {
    IDLE: ['submit'],
    SUBMITTING: ['ack', 'fail', 'unknown'],
    ACKNOWLEDGED: ['stream', 'complete', 'fail', 'cancel'],
    STREAMING: ['complete', 'fail', 'cancel'],
    CANCELLING: ['complete', 'fail'],
    COMPLETED: ['submit'],
    FAILED: ['submit'],
    UNKNOWN: ['recover', 'fail', 'complete'],
  };
  const APPROVAL = {
    NONE: ['pending'],
    PENDING: ['allow', 'deny', 'stale', 'expire', 'resolve'],
    ALLOWING: ['resolve', 'stale', 'expire'],
    DENYING: ['resolve', 'stale'],
    RESOLVED: ['pending', 'clear'],
    STALE: ['clear', 'pending'],
    EXPIRED: ['clear', 'pending'],
  };

  function apply(machine, from, event) {
    const table = machine === 'host' ? HOST : machine === 'thread' ? THREAD : machine === 'turn' ? TURN : APPROVAL;
    if (!table[from] || table[from].indexOf(event) === -1) {
      throw new Error('Illegal ' + machine + ' transition: ' + from + ' + ' + event);
    }
    if (machine === 'host') {
      if (event === 'start') return 'CONNECTING';
      if (event === 'open') return 'ONLINE';
      if (event === 'health_fail' && from === 'CONNECTING') return 'OFFLINE';
      if (event === 'health_fail') return 'RECONNECTING';
      if (event === 'close') return 'RECONNECTING';
      if (event === 'error' && from === 'CONNECTING') return 'OFFLINE';
      return 'UNKNOWN';
    }
    if (machine === 'thread') {
      if (event === 'create') return 'CREATING';
      if (event === 'resume' || event === 'ready') return 'READY';
      if (event === 'submit' || event === 'running') return 'RUNNING';
      if (event === 'waiting_approval') return 'WAITING_APPROVAL';
      if (event === 'recover') return 'RECOVERING';
      if (event === 'fail') return 'FAILED';
      return 'READY';
    }
    if (machine === 'turn') {
      if (event === 'submit') return 'SUBMITTING';
      if (event === 'ack') return 'ACKNOWLEDGED';
      if (event === 'stream') return 'STREAMING';
      if (event === 'cancel') return 'CANCELLING';
      if (event === 'complete') return 'COMPLETED';
      if (event === 'fail') return 'FAILED';
      if (event === 'unknown') return 'UNKNOWN';
      return 'STREAMING';
    }
    if (event === 'pending') return 'PENDING';
    if (event === 'allow') return 'ALLOWING';
    if (event === 'deny') return 'DENYING';
    if (event === 'resolve') return 'RESOLVED';
    if (event === 'stale') return 'STALE';
    if (event === 'expire') return 'EXPIRED';
    return 'NONE';
  }

  function canSendTurn(thread, turn) {
    return (thread === 'READY' || thread === 'FAILED') &&
      (turn === 'IDLE' || turn === 'COMPLETED' || turn === 'FAILED');
  }

  function canCancelTurn(turn) {
    return turn === 'ACKNOWLEDGED' || turn === 'STREAMING' || turn === 'SUBMITTING';
  }

  function reconcileAfterSubmitFailure(input) {
    if (!input.hostReachable) {
      return { host: 'OFFLINE', shouldResubmit: false, ambiguity: 'host_unavailable' };
    }
    if (input.responseSettled && input.acceptedTurnId !== undefined) {
      return { host: 'ONLINE', shouldResubmit: false, ambiguity: 'accepted' };
    }
    if (input.responseSettled) {
      return { host: 'ONLINE', shouldResubmit: false, ambiguity: 'rejected' };
    }
    return { host: 'UNKNOWN', shouldResubmit: false, ambiguity: 'ambiguous_network' };
  }

  root.BabelRemoteState = {
    apply: apply,
    canSendTurn: canSendTurn,
    canCancelTurn: canCancelTurn,
    reconcileAfterSubmitFailure: reconcileAfterSubmitFailure,
  };
})(typeof window !== 'undefined' ? window : globalThis);
