(function () {
  const S = window.BabelRemoteState;
  const R = window.BabelRemoteRender;
  const byId = function (id) { return document.getElementById(id); };
  const tokenEl = byId('token');
  const rootEl = byId('root');
  const composer = byId('composer');
  const threadInput = byId('thread-id');
  const transcript = byId('transcript');

  const memory = {
    token: '',
    sessionId: '',
    threadId: '',
    turnId: null,
    pendingApproval: null,
    lastCommandId: '',
    lastMessage: '',
  };

  let host = 'UNKNOWN';
  let thread = 'NONE';
  let turn = 'IDLE';
  let approval = 'NONE';
  let socket = null;
  let sendInFlight = false;
  const MAX_TRANSCRIPT_EVENTS = 200;

  function label(value) {
    return String(value || 'UNKNOWN').replaceAll('_', ' ');
  }

  function appendEvent(event) {
    R.appendTranscriptEvent(transcript, event);
    while (transcript.children.length > MAX_TRANSCRIPT_EVENTS) transcript.removeChild(transcript.firstElementChild);
    R.setText(byId('transcript-count'), transcript.children.length + ' events');
  }

  function transition(machine, current, event) {
    try { return S.apply(machine, current, event); } catch (error) { return current; }
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function makeRpcError(message, responseSettled) {
    const error = new Error(message);
    error.responseSettled = responseSettled;
    return error;
  }

  function errorText(error) {
    return error && error.message ? String(error.message) : 'Unknown Remote error';
  }

  function rpcResult(method, response) {
    if (!isRecord(response.result)) throw makeRpcError(method + ' returned a malformed result.', false);
    return response.result;
  }

  function requireString(value, method, field) {
    if (typeof value !== 'string' || !value) throw makeRpcError(method + ' returned an invalid ' + field + '.', false);
    return value;
  }

  function protocolErrorState(reason) {
    const recovery = S.reconcileAfterProtocolError({ host: host, activeTurn: S.canCancelTurn(turn) });
    host = recovery.host;
    if (recovery.turn === 'UNKNOWN') turn = transition('turn', turn, 'unknown');
    if (recovery.thread === 'FAILED') thread = transition('thread', thread, 'fail');
    appendEvent({ type: 'protocol_error', role: 'system', error: reason + ' State is fail-closed; reconnect before acting.' });
    renderChrome();
  }

  function renderChrome() {
    R.setText(byId('host-state'), label(host));
    R.setText(byId('host-detail'), host === 'ONLINE' ? 'Private host reachable.' : host === 'RECONNECTING' ? 'Recovering without resubmitting.' : 'Reachability is not confirmed.');
    R.setText(byId('thread-state'), thread === 'NONE' ? 'No active thread' : label(thread));
    R.setText(byId('thread-detail'), thread === 'READY' ? 'Session is ready for a structured prompt.' : thread === 'NONE' ? 'Create or resume a session to begin.' : 'Thread state: ' + label(thread));
    R.setText(byId('turn-state'), label(turn));
    R.setText(byId('turn-detail'), turn === 'UNKNOWN' ? 'Outcome is ambiguous. Do not resubmit automatically.' : label(turn) + ' turn state.');
    R.setText(byId('thread-id-display'), memory.threadId || 'No active thread');
    R.setText(byId('workspace'), rootEl.value || '—');
    R.setText(byId('connection-copy'), host === 'ONLINE' ? 'Host connected' : 'Host ' + label(host).toLowerCase());
    document.querySelectorAll('.topbar-status .status-dot, #host-card .status-dot').forEach(function (dot) {
      dot.className = 'status-dot ' + String(host).toLowerCase();
    });
    byId('create').disabled = !memory.token;
    byId('resume').disabled = !memory.token;
    byId('send').disabled = host !== 'ONLINE' || !S.canSendTurn(thread, turn) || !memory.token || sendInFlight;
    byId('stop').disabled = !S.canCancelTurn(turn);
    byId('reconnect').disabled = !memory.token;
    composer.disabled = !memory.token;
    byId('refresh-files').disabled = !memory.token || !memory.threadId;
    byId('refresh-diff').disabled = !memory.token || !memory.threadId;
    byId('refresh-verification').disabled = !memory.token || !memory.threadId;
    R.setText(byId('action-state-badge'), label(turn));
    R.setText(byId('action-state'), byId('action-state').textContent || 'Ready for your next instruction');
    R.setText(byId('composer-status'), !memory.token ? 'Connect to enable the composer.' : !memory.threadId ? 'Create or resume a thread.' : S.canSendTurn(thread, turn) ? 'Ready to send.' : 'Turn is ' + label(turn).toLowerCase() + '.');
    if (approval === 'NONE' || approval === 'RESOLVED' || approval === 'STALE' || approval === 'EXPIRED') byId('approval-card').classList.add('hidden');
  }

  function authHeaders() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + memory.token };
  }

  async function rpc(method, params, id) {
    const requestId = id || Date.now();
    let response;
    try {
      response = await fetch('/rpc', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: method, params: params }),
      });
    } catch (error) {
      throw makeRpcError('Transport failed while calling ' + method + '.', false);
    }
    if (!response.ok) throw makeRpcError('RPC transport returned HTTP ' + response.status + '.', false);
    let payload;
    try { payload = await response.json(); } catch (error) { throw makeRpcError(method + ' returned invalid JSON.', false); }
    if (!isRecord(payload) || payload.id !== requestId) throw makeRpcError(method + ' returned a mismatched JSON-RPC response.', false);
    const classification = S.classifyRpcResponse(payload);
    if (classification.kind === 'malformed') {
      throw makeRpcError(method + ' returned a malformed JSON-RPC response.', false);
    }
    if (classification.kind === 'rejected') {
      const code = typeof classification.code === 'number' ? ' (' + classification.code + ')' : '';
      throw makeRpcError(method + ' rejected' + code + ': ' + classification.message, true);
    }
    return payload;
  }

  async function ensureSession() {
    if (memory.sessionId) return memory.sessionId;
    const response = await fetch('/sessions', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ projectRoot: rootEl.value }) });
    if (!response.ok) throw new Error('session auth failed');
    const json = await response.json();
    if (!json.sessionId) throw new Error('session missing');
    memory.sessionId = json.sessionId;
    return memory.sessionId;
  }

  async function mintTicket() {
    const sessionId = await ensureSession();
    const response = await fetch('/ws/ticket', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ session_id: sessionId, thread_id: memory.threadId }) });
    if (!response.ok) throw new Error('ticket mint failed');
    const ticket = await response.json();
    if (!isRecord(ticket)) throw new Error('ticket response malformed');
    requireString(ticket.ticket, 'ws ticket', 'ticket');
    return ticket;
  }

  function connectSocket(ticket) {
    if (socket) socket.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = proto + '://' + location.host + '/ws?sessionId=' + encodeURIComponent(memory.sessionId) + '&ticket=' + encodeURIComponent(ticket.ticket);
    socket = new WebSocket(url);
    socket.onopen = function () { host = transition('host', host, 'open'); renderChrome(); };
    socket.onclose = function () { host = transition('host', host, 'close'); renderChrome(); };
    socket.onerror = function () { host = transition('host', host, 'error'); renderChrome(); };
    socket.onmessage = function (event) {
      let message;
      try { message = JSON.parse(event.data); } catch (error) { protocolErrorState('Invalid server message received.'); return; }
      if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        protocolErrorState('Malformed server message received.');
        return;
      }
      if (message.method === 'turn.event') {
        if (!isRecord(message.params) || !isRecord(message.params.event) || typeof message.params.event.type !== 'string') {
          protocolErrorState('Malformed turn event received.');
          return;
        }
        const item = message.params.event || {};
        if (turn === 'ACKNOWLEDGED' || turn === 'SUBMITTING') turn = transition('turn', turn, 'stream');
        if (thread === 'READY') thread = transition('thread', thread, 'submit');
        appendEvent(item);
        if (item.type === 'tool_start') {
          R.setText(byId('action-state'), item.tool || 'Working');
          R.setText(byId('action-detail'), item.target || 'Structured tool activity');
        }
        if (item.type === 'done') { turn = transition('turn', turn, 'complete'); thread = transition('thread', thread, 'ready'); }
        if (item.type === 'failed') { turn = transition('turn', turn, 'fail'); thread = transition('thread', thread, 'fail'); }
        if (item.type === 'cancelled') { turn = transition('turn', turn, 'complete'); thread = transition('thread', thread, 'ready'); }
        if (item.type === 'file_changed') appendEvent({ type: 'file_changed', text: item.path || '' });
        renderChrome();
      }
      if (message.method === 'permission.request') {
        if (!isRecord(message.params)) { protocolErrorState('Malformed permission request received.'); return; }
        memory.pendingApproval = message.params;
        approval = transition('approval', approval, 'pending');
        if (thread === 'RUNNING' || thread === 'READY') thread = transition('thread', thread, 'waiting_approval');
        R.renderApproval({
          actionType: message.params.action_type || message.params.permission,
          command: message.params.command,
          cwd: message.params.cwd,
          targetPath: message.params.target_path,
          digest: message.params.operation_digest,
        });
        renderChrome();
      }
    };
  }

  async function observeThread() {
    if (memory.threadId) connectSocket(await mintTicket());
  }

  async function connect() {
    memory.token = tokenEl.value;
    tokenEl.value = '';
    try {
      host = transition('host', host, 'start');
      renderChrome();
      const health = await fetch('/health');
      if (!health.ok) throw new Error('health ' + health.status);
      const json = await health.json();
      if (!json.ok) throw new Error('health');
      await ensureSession();
      host = transition('host', host, 'open');
      R.setText(byId('action-state'), 'Connected to Babel host');
      R.setText(byId('action-detail'), 'Create or resume a thread to begin.');
    } catch (error) {
      host = transition('host', host, 'error');
      appendEvent({ type: 'connection', error: 'Connection failed. Check the host and private route.' });
    }
    renderChrome();
  }

  async function reconnect() {
    try {
      if (host === 'ONLINE') host = transition('host', host, 'close');
      if (host === 'UNKNOWN' || host === 'OFFLINE') host = transition('host', host, 'start');
      renderChrome();
      await observeThread();
      if (memory.threadId) {
        thread = transition('thread', thread, thread === 'FAILED' || thread === 'NONE' ? 'resume' : 'recover');
        const resumed = rpcResult('thread.resume', await rpc('thread.resume', { thread_id: memory.threadId, project_root: rootEl.value }));
        if (resumed.thread_id !== memory.threadId) throw makeRpcError('thread.resume returned the wrong thread.', false);
        const history = rpcResult('history.lookup', await rpc('history.lookup', { thread_id: memory.threadId }));
        if (!Array.isArray(history.cells)) throw makeRpcError('history.lookup returned malformed cells.', false);
        const cells = history.cells;
        transcript.textContent = '';
        cells.forEach(function (cell) { appendEvent({ type: cell.kind || 'cell', text: JSON.stringify(cell.payload || {}) }); });
        thread = transition('thread', thread, 'ready');
      }
      host = transition('host', host, 'open');
    } catch (error) {
      if (thread === 'RECOVERING' || thread === 'READY') thread = transition('thread', thread, 'fail');
      host = transition('host', host, 'health_fail');
      appendEvent({ type: 'connection', error: 'Reconnect failed. The state remains fail-closed.' });
    }
    renderChrome();
  }

  async function createThread() {
    try {
      thread = transition('thread', thread, 'create');
      const result = rpcResult('thread.create', await rpc('thread.create', { project_root: rootEl.value }));
      memory.threadId = requireString(result.thread_id, 'thread.create', 'thread_id');
      threadInput.value = memory.threadId;
      thread = transition('thread', thread, 'ready');
      await observeThread();
    } catch (error) { thread = transition('thread', thread, 'fail'); appendEvent({ type: 'failed', error: 'Thread creation failed.' }); }
    renderChrome();
  }

  async function resumeThread() {
    try {
      thread = transition('thread', thread, 'resume');
      memory.threadId = threadInput.value;
      const result = rpcResult('thread.resume', await rpc('thread.resume', { thread_id: memory.threadId, project_root: rootEl.value }));
      if (result.thread_id !== memory.threadId) throw makeRpcError('thread.resume returned the wrong thread.', false);
      thread = transition('thread', thread, 'ready');
      await observeThread();
    } catch (error) { thread = transition('thread', thread, 'fail'); appendEvent({ type: 'failed', error: 'Thread resume failed.' }); }
    renderChrome();
  }

  async function send() {
    if (sendInFlight || host !== 'ONLINE' || !S.canSendTurn(thread, turn)) return;
    if (!composer.value.trim()) { R.setText(byId('composer-status'), 'Write an instruction before sending.'); return; }
    sendInFlight = true;
    const message = composer.value;
    const commandId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    memory.lastCommandId = commandId;
    memory.lastMessage = message;
    appendEvent({ type: 'user', role: 'user', text: message });
    try {
      turn = transition('turn', turn, 'submit');
      thread = transition('thread', thread, 'submit');
      renderChrome();
      const result = rpcResult('turn.submit', await rpc('turn.submit', { thread_id: memory.threadId, message: message, command_id: commandId }));
      if (!Number.isSafeInteger(result.turn_id) || result.turn_id < 1 || result.thread_id !== memory.threadId) throw makeRpcError('turn.submit returned a malformed acknowledgement.', false);
      memory.turnId = result.turn_id;
      turn = transition('turn', turn, 'ack');
    } catch (error) {
      const decision = S.reconcileAfterSubmitFailure({ responseSettled: Boolean(error && error.responseSettled), commandId: commandId, hostReachable: host === 'ONLINE' });
      host = decision.host;
      turn = transition('turn', turn, decision.ambiguity === 'ambiguous_network' ? 'unknown' : 'fail');
      if (decision.ambiguity === 'rejected' || decision.ambiguity === 'host_unavailable') thread = transition('thread', thread, 'fail');
      appendEvent({ type: 'failed', error: decision.ambiguity === 'rejected' ? errorText(error) : 'Submit status ' + decision.ambiguity + '; not auto-resubmitted.' });
    } finally {
      sendInFlight = false;
      renderChrome();
    }
  }

  async function stop() {
    if (!S.canCancelTurn(turn)) return;
    try {
      turn = transition('turn', turn, 'cancel');
      renderChrome();
      const result = rpcResult('turn.cancel', await rpc('turn.cancel', { thread_id: memory.threadId }));
      if (result.cancelled !== true || result.thread_id !== memory.threadId) throw makeRpcError('turn.cancel returned a malformed result.', false);
      turn = transition('turn', turn, 'complete');
      thread = transition('thread', thread, 'ready');
    } catch (error) {
      turn = transition('turn', turn, 'fail');
      thread = transition('thread', thread, 'fail');
      appendEvent({ type: 'failed', error: 'Cancel status unknown: ' + errorText(error) });
    }
    renderChrome();
  }

  async function decide(decision) {
    if (!memory.pendingApproval || approval !== 'PENDING') return;
    approval = transition('approval', approval, decision === 'allow_once' ? 'allow' : 'deny');
    renderChrome();
    try {
      const result = rpcResult('approval.decide', await rpc('approval.decide', {
        approval_id: memory.pendingApproval.approval_id,
        decision: decision,
        thread_id: memory.pendingApproval.thread_id || memory.threadId,
        turn_id: String(memory.pendingApproval.turn_id || memory.turnId || ''),
        operation_digest: memory.pendingApproval.operation_digest,
      }));
      if (result.approval_id !== memory.pendingApproval.approval_id || typeof result.consumed !== 'boolean') throw makeRpcError('approval.decide returned a malformed result.', false);
      approval = transition('approval', approval, 'resolve');
      memory.pendingApproval = null;
      thread = transition('thread', thread, 'running');
      appendEvent({ type: 'permission', role: 'system', text: decision === 'allow_once' ? 'ALLOW ONCE recorded.' : 'DENY recorded. No mutation was performed.' });
    } catch (error) {
      approval = transition('approval', approval, 'stale');
      if (thread === 'WAITING_APPROVAL') thread = transition('thread', thread, 'fail');
      appendEvent({ type: 'failed', error: 'Approval was not recorded: ' + errorText(error) });
    }
    renderChrome();
  }

  function installNormalHandlers() {
    byId('connect').onclick = connect;
    byId('reconnect').onclick = reconnect;
    byId('create').onclick = createThread;
    byId('resume').onclick = resumeThread;
    byId('send').onclick = send;
    byId('stop').onclick = stop;
    byId('allow-once').onclick = function () { decide('allow_once'); };
    byId('deny').onclick = function () { decide('deny'); };
    byId('refresh-files').onclick = async function () {
      try {
        const result = rpcResult('workspace.changes', await rpc('workspace.changes', { thread_id: memory.threadId }));
        if (!Array.isArray(result.files)) throw makeRpcError('workspace.changes returned malformed files.', false);
        const files = result.files;
        R.renderFiles(files);
      } catch (error) { appendEvent({ type: 'failed', error: 'Changed files unavailable.' }); }
    };
    byId('refresh-diff').onclick = async function () {
      try {
        const result = rpcResult('workspace.changes', await rpc('workspace.changes', { thread_id: memory.threadId }));
        if (typeof result.diff !== 'string') throw makeRpcError('workspace.changes returned malformed diff.', false);
        R.setText(byId('diff'), result.diff || 'No diff available.');
      } catch (error) { appendEvent({ type: 'failed', error: 'Diff unavailable.' }); }
    };
    byId('refresh-verification').onclick = async function () {
      try {
        const snapshot = rpcResult('verification.lookup', await rpc('verification.lookup', { thread_id: memory.threadId }));
        if (typeof snapshot.status !== 'string' || typeof snapshot.reason !== 'string' || typeof snapshot.has_machine_evidence !== 'boolean') throw makeRpcError('verification.lookup returned malformed evidence.', false);
        R.setVerification(snapshot);
      } catch (error) {
        R.setVerification({ status: 'UNKNOWN', reason: 'Verification lookup failed; evidence is unavailable.', has_machine_evidence: false });
        appendEvent({ type: 'failed', error: 'Verification unavailable: ' + errorText(error) });
      }
    };
    rootEl.oninput = renderChrome;
    renderChrome();
  }

  function installFixtureHandlers(scenario) {
    let current = scenario;
    function redraw() { R.renderFixture(current); }
    byId('reconnect').disabled = false;
    byId('reconnect').onclick = function () {
      current = Object.assign({}, current, { host: 'ONLINE', action: 'Session recovered', actionDetail: 'History was reconciled. No request was resubmitted.', reconnectLabel: 'Connected' });
      redraw();
    };
    byId('send').onclick = function () {
      if (!composer.value.trim()) return;
      current = Object.assign({}, current, { thread: 'RUNNING', turn: 'STREAMING', action: 'Streaming response', actionDetail: 'Fixture response is streaming; no provider was called.', transcript: current.transcript.concat([{ type: 'user', role: 'user', text: composer.value }, { type: 'answer_chunk', role: 'assistant', text: 'Deterministic fixture response. No network or provider call was made.' }]) });
      redraw();
    };
    byId('stop').onclick = function () {
      current = Object.assign({}, current, { thread: 'READY', turn: 'COMPLETED', action: 'Turn canceled', actionDetail: 'Cancellation is represented locally in fixture mode.', transcript: current.transcript.concat([{ type: 'cancelled', role: 'system', text: 'Turn canceled.' }]) });
      redraw();
    };
    byId('allow-once').onclick = function () {
      current = Object.assign({}, current, { approval: 'RESOLVED', thread: 'RUNNING', action: 'One-time approval recorded', actionDetail: 'The fixture shows the safe approval transition without executing a mutation.', transcript: current.transcript.concat([{ type: 'permission', role: 'system', text: 'ALLOW ONCE recorded. No real action was executed.' }]) });
      redraw();
    };
    byId('deny').onclick = function () {
      current = Object.assign({}, current, { approval: 'RESOLVED', thread: 'READY', turn: 'COMPLETED', action: 'Action denied', actionDetail: 'The requested operation was not executed.', transcript: current.transcript.concat([{ type: 'permission', role: 'system', text: 'DENY recorded. No mutation was performed.' }]) });
      redraw();
    };
    byId('refresh-files').onclick = redraw;
    byId('refresh-diff').onclick = redraw;
    byId('refresh-verification').onclick = redraw;
    composer.oninput = function () { R.setText(byId('composer-status'), composer.value.length + ' characters ready'); };
    window.BabelRemoteApp = { getState: function () { return { host: current.host, thread: current.thread, turn: current.turn, approval: current.approval }; }, memoryHasToken: function () { return false; }, fixture: true };
    redraw();
  }

  async function boot() {
    if (location.pathname === '/fixture' || location.pathname === '/fixture/') {
      const requested = new URLSearchParams(location.search).get('scenario') || 'connected-idle';
      const response = await fetch('/fixture/config?scenario=' + encodeURIComponent(requested));
      if (!response.ok) throw new Error('fixture config unavailable');
      const payload = await response.json();
      if (payload.mode !== 'remote-ui-fixture' || !payload.scenario) throw new Error('invalid fixture mode');
      installFixtureHandlers(payload.scenario);
      return;
    }
    installNormalHandlers();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' }).catch(function () { /* optional install */ });
    window.BabelRemoteApp = { getState: function () { return { host: host, thread: thread, turn: turn, approval: approval }; }, memoryHasToken: function () { return Boolean(memory.token); } };
  }

  boot().catch(function () {
    R.setText(byId('connection-copy'), 'Fixture or host unavailable');
    R.setText(byId('action-state'), 'Unable to load Remote');
    R.setText(byId('action-detail'), 'The client failed closed before opening a session.');
  });
})();
