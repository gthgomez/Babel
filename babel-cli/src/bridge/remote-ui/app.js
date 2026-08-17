(function () {
  const S = window.BabelRemoteState;
  const R = window.BabelRemoteRender;
  const tokenEl = document.getElementById('token');
  const rootEl = document.getElementById('root');
  const composer = document.getElementById('composer');
  const threadInput = document.getElementById('thread-id');
  const transcript = document.getElementById('transcript');
  const approvalCard = document.getElementById('approval-card');
  const approvalBody = document.getElementById('approval-body');

  const memory = {
    token: '',
    sessionId: '',
    threadId: '',
    turnId: null,
    commandId: '',
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

  function setHost(event) {
    host = S.apply('host', host, event);
    renderChrome();
  }
  function setThread(event) {
    thread = S.apply('thread', thread, event);
    renderChrome();
  }
  function setTurn(event) {
    turn = S.apply('turn', turn, event);
    renderChrome();
  }
  function setApproval(event) {
    approval = S.apply('approval', approval, event);
    renderChrome();
  }

  function renderChrome() {
    R.setText(document.getElementById('host-state'), host);
    R.setText(document.getElementById('thread-state'), 'thread: ' + thread + (memory.threadId ? ' ' + memory.threadId : ''));
    R.setText(document.getElementById('turn-state'), 'turn: ' + turn);
    R.setText(document.getElementById('workspace'), 'workspace: ' + (rootEl.value || '—'));
    document.getElementById('create').disabled = !memory.token;
    document.getElementById('resume').disabled = !memory.token;
    document.getElementById('send').disabled = !S.canSendTurn(thread, turn) || !memory.token || sendInFlight;
    document.getElementById('stop').disabled = !S.canCancelTurn(turn);
    document.getElementById('reconnect').disabled = !memory.token;
    document.getElementById('composer').disabled = !memory.token;
    document.getElementById('refresh-files').disabled = !memory.token || !memory.threadId;
    document.getElementById('refresh-diff').disabled = !memory.token || !memory.threadId;
    document.getElementById('refresh-verification').disabled = !memory.token || !memory.threadId;
    approvalCard.classList.toggle('hidden', approval !== 'PENDING' && approval !== 'ALLOWING' && approval !== 'DENYING');
  }

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + memory.token,
    };
  }

  async function rpc(method, params, id) {
    const res = await fetch('/rpc', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: id || Date.now(), method: method, params: params }),
    });
    if (!res.ok) throw new Error('rpc ' + res.status);
    return res.json();
  }

  async function ensureSession() {
    if (memory.sessionId) return memory.sessionId;
    const res = await fetch('/sessions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ projectRoot: rootEl.value }),
    });
    if (!res.ok) throw new Error('session auth failed');
    const json = await res.json();
    if (!json.sessionId) throw new Error('session missing');
    memory.sessionId = json.sessionId;
    return memory.sessionId;
  }

  async function mintTicket() {
    const sessionId = await ensureSession();
    const res = await fetch('/ws/ticket', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ session_id: sessionId, thread_id: memory.threadId }),
    });
    if (!res.ok) throw new Error('ticket mint failed');
    return res.json();
  }

  function connectSocket(ticket) {
    if (socket) {
      socket.close();
      socket = null;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = proto + '://' + location.host + '/ws?sessionId=' + encodeURIComponent(memory.sessionId) + '&ticket=' + encodeURIComponent(ticket.ticket);
    socket = new WebSocket(url);
    socket.onopen = function () {
      try { setHost('open'); } catch (e) { /* already online */ }
    };
    socket.onclose = function () {
      try { setHost('close'); } catch (e) { /* ignore illegal */ }
    };
    socket.onerror = function () {
      try { setHost('error'); } catch (e) { /* ignore */ }
    };
    socket.onmessage = function (ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.method === 'turn.event' && msg.params) {
        const event = msg.params.event || {};
        if (turn === 'ACKNOWLEDGED' || turn === 'SUBMITTING') {
          try { setTurn('stream'); } catch (e) { /* ignore */ }
        }
        if (thread === 'READY') {
          try { setThread('submit'); } catch (e) { /* ignore */ }
        }
        R.appendTranscriptEvent(transcript, event);
        if (event.type === 'tool_start') {
          R.setText(document.getElementById('action-state'), (event.tool || 'tool') + ' ' + (event.target || ''));
        }
        if (event.type === 'done') {
          try { setTurn('complete'); } catch (e) { /* ignore */ }
          try { setThread('ready'); } catch (e) { /* ignore */ }
        }
        if (event.type === 'failed') {
          try { setTurn('fail'); } catch (e) { /* ignore */ }
          try { setThread('fail'); } catch (e) { /* ignore */ }
        }
        if (event.type === 'cancelled') {
          try { setTurn('complete'); } catch (e) { /* ignore */ }
          try { setThread('ready'); } catch (e) { /* ignore */ }
        }
        if (event.type === 'file_changed') {
          document.getElementById('files').textContent += (event.path || '') + '\n';
        }
      }
      if (msg.method === 'permission.request' && msg.params) {
        memory.pendingApproval = msg.params;
        if (approval === 'NONE' || approval === 'RESOLVED' || approval === 'STALE' || approval === 'EXPIRED') {
          setApproval('pending');
        }
        if (thread === 'RUNNING' || thread === 'READY') {
          try { setThread('waiting_approval'); } catch (e) { /* ignore */ }
        }
        const shown = [
          'action: ' + (msg.params.action_type || msg.params.permission || ''),
          'command: ' + (msg.params.command || ''),
          'cwd: ' + (msg.params.cwd || ''),
          'path: ' + (msg.params.target_path || ''),
          'digest: ' + (msg.params.operation_digest || ''),
        ].join('\n');
        R.setText(approvalBody, shown);
      }
    };
  }

  async function observeThread() {
    if (!memory.threadId) return;
    const ticket = await mintTicket();
    connectSocket(ticket);
  }

  document.getElementById('connect').onclick = async function () {
    memory.token = tokenEl.value;
    tokenEl.value = '';
    try {
      setHost('start');
      const health = await fetch('/health');
      const json = await health.json();
      if (!json.ok) throw new Error('health');
      await ensureSession();
      setHost('open');
    } catch (e) {
      try { setHost('error'); } catch (err) { /* ignore */ }
    }
    renderChrome();
  };

  document.getElementById('reconnect').onclick = async function () {
    try {
      if (host === 'ONLINE') setHost('close');
      if (host === 'UNKNOWN' || host === 'OFFLINE') setHost('start');
      await observeThread();
      if (memory.threadId) {
        setThread('recover');
        await rpc('thread.resume', { thread_id: memory.threadId, project_root: rootEl.value });
        const history = await rpc('history.lookup', { thread_id: memory.threadId });
        const cells = (history.result && history.result.cells) || [];
        R.setText(transcript, '');
        cells.forEach(function (cell) {
          R.appendTranscriptEvent(transcript, { type: cell.kind || 'cell', text: JSON.stringify(cell.payload || {}) });
        });
        setThread('ready');
      }
    } catch (e) {
      try { setHost('error'); } catch (err) { /* ignore */ }
    }
  };

  document.getElementById('create').onclick = async function () {
    try {
      setThread('create');
      const r = await rpc('thread.create', { project_root: rootEl.value });
      memory.threadId = r.result && r.result.thread_id;
      threadInput.value = memory.threadId || '';
      setThread('ready');
      await observeThread();
    } catch (e) {
      try { setThread('fail'); } catch (err) { /* ignore */ }
    }
  };

  document.getElementById('resume').onclick = async function () {
    try {
      setThread('resume');
      memory.threadId = threadInput.value;
      const r = await rpc('thread.resume', { thread_id: memory.threadId, project_root: rootEl.value });
      if (r.error) throw new Error(r.error.message);
      setThread('ready');
      await observeThread();
    } catch (e) {
      try { setThread('fail'); } catch (err) { /* ignore */ }
    }
  };

  document.getElementById('send').onclick = async function () {
    if (sendInFlight || !S.canSendTurn(thread, turn)) return;
    sendInFlight = true;
    renderChrome();
    const message = composer.value;
    const commandId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
    memory.lastCommandId = commandId;
    memory.lastMessage = message;
    try {
      setTurn('submit');
      setThread('submit');
      const r = await rpc('turn.submit', {
        thread_id: memory.threadId,
        message: message,
        command_id: commandId,
      });
      if (r.error) {
        setTurn('fail');
        R.appendTranscriptEvent(transcript, { type: 'failed', error: r.error.message });
      } else {
        memory.turnId = r.result.turn_id;
        setTurn('ack');
      }
    } catch (e) {
      const decision = S.reconcileAfterSubmitFailure({
        responseSettled: false,
        commandId: commandId,
        hostReachable: host === 'ONLINE',
      });
      if (decision.ambiguity === 'ambiguous_network') {
        try { setTurn('unknown'); } catch (err) { /* ignore */ }
      } else {
        try { setTurn('fail'); } catch (err) { /* ignore */ }
      }
      R.appendTranscriptEvent(transcript, { type: 'failed', error: 'Submit status ' + decision.ambiguity + '; not auto-resubmitted' });
    } finally {
      sendInFlight = false;
      renderChrome();
    }
  };

  document.getElementById('stop').onclick = async function () {
    if (!S.canCancelTurn(turn)) return;
    try {
      setTurn('cancel');
      await rpc('turn.cancel', { thread_id: memory.threadId });
    } catch (e) {
      try { setTurn('fail'); } catch (err) { /* ignore */ }
    }
  };

  async function decide(decision) {
    if (!memory.pendingApproval || approval !== 'PENDING') return;
    setApproval(decision === 'allow_once' ? 'allow' : 'deny');
    const r = await rpc('approval.decide', {
      approval_id: memory.pendingApproval.approval_id,
      decision: decision,
      thread_id: memory.pendingApproval.thread_id || memory.threadId,
      turn_id: String(memory.pendingApproval.turn_id || memory.turnId || ''),
      operation_digest: memory.pendingApproval.operation_digest,
    });
    if (r.error) {
      setApproval('stale');
      R.appendTranscriptEvent(transcript, { type: 'failed', error: r.error.message });
    } else {
      setApproval('resolve');
      memory.pendingApproval = null;
      try { setThread('running'); } catch (e) { /* ignore */ }
    }
  }

  document.getElementById('allow-once').onclick = function () { decide('allow_once'); };
  document.getElementById('deny').onclick = function () { decide('deny'); };

  document.getElementById('refresh-files').onclick = async function () {
    const r = await rpc('workspace.changes', { thread_id: memory.threadId });
    const files = (r.result && r.result.files) || [];
    R.setText(document.getElementById('files'), files.map(function (f) { return (f.status || '') + ' ' + (f.path || ''); }).join('\n'));
  };
  document.getElementById('refresh-diff').onclick = async function () {
    const r = await rpc('workspace.changes', { thread_id: memory.threadId });
    R.setText(document.getElementById('diff'), (r.result && r.result.diff) || '');
  };
  document.getElementById('refresh-verification').onclick = async function () {
    const r = await rpc('verification.lookup', { thread_id: memory.threadId });
    const snap = r.result || { status: 'NOT_VERIFIED' };
    R.setText(document.getElementById('verification'), snap.status + ' — ' + (snap.reason || ''));
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' }).catch(function () { /* install optional */ });
  }

  window.BabelRemoteApp = {
    getState: function () { return { host: host, thread: thread, turn: turn, approval: approval }; },
    memoryHasToken: function () { return Boolean(memory.token); },
  };
  renderChrome();
})();
