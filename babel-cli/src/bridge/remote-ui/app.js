(function () {
  const S = window.BabelRemoteState;
  const R = window.BabelRemoteRender;
  const byId = function (id) { return document.getElementById(id); };
  const tokenEl = byId('token');
  const rootEl = byId('root');
  const harnessEl = byId('harness-adapter');
  const vendorSessionEl = byId('vendor-session');
  const composer = byId('composer');
  const threadInput = byId('thread-id');
  const transcript = byId('transcript');

  const LEASE_RENEW_MS = 10000;
  const memory = {
    token: '',
    pairedDevice: false,
    clientId: null,
    sessionId: '',
    threadId: '',
    turnId: null,
    pendingApproval: null,
    lastCommandId: '',
    lastMessage: '',
    controlEpoch: null,
    controlExpiresAtMs: null,
    leaseRenewTimer: null,
    authKind: 'none',
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

  function renderChrome() {
    R.setText(byId('host-state'), label(host));
    R.setText(byId('host-detail'), host === 'ONLINE' ? 'Private host reachable.' : host === 'RECONNECTING' ? 'Recovering without resubmitting.' : 'Reachability is not confirmed.');
    R.setText(byId('thread-state'), thread === 'NONE' ? 'No active thread' : label(thread));
    R.setText(byId('thread-detail'), thread === 'READY' ? 'Session is ready for a structured prompt.' : thread === 'NONE' ? 'Create or resume a session to begin.' : 'Thread state: ' + label(thread));
    R.setText(byId('turn-state'), label(turn));
    R.setText(byId('turn-detail'), turn === 'UNKNOWN' ? 'Outcome is ambiguous. Do not resubmit automatically.' : label(turn) + ' turn state.');
    R.setText(byId('thread-id-display'), memory.threadId || 'No active thread');
    R.setText(byId('workspace'), rootEl.value || '—');
    const harnessLabel = harnessEl && harnessEl.value === 'command-code' ? 'Command Code CLI' : 'Babel native';
    R.setText(byId('harness-label'), harnessLabel);
    if (vendorSessionEl) {
      const cc = harnessEl && harnessEl.value === 'command-code';
      vendorSessionEl.disabled = !cc || !memory.token && !memory.pairedDevice;
    }
    R.setText(byId('connection-copy'), host === 'ONLINE' ? 'Host connected' : 'Host ' + label(host).toLowerCase());
    document.querySelectorAll('.topbar-status .status-dot, #host-card .status-dot').forEach(function (dot) {
      dot.className = 'status-dot ' + String(host).toLowerCase();
    });
    const authed = memory.token || memory.pairedDevice;
    const canMutate = authed && (memory.authKind === 'host' || (memory.controlEpoch !== null && memory.clientId));
    byId('create').disabled = !authed;
    byId('resume').disabled = !authed;
    byId('send').disabled = !S.canSendTurn(thread, turn) || !canMutate || sendInFlight;
    byId('stop').disabled = !S.canCancelTurn(turn) || !canMutate;
    byId('reconnect').disabled = !authed;
    byId('take-control').disabled = !authed || !memory.threadId || memory.authKind === 'host';
    composer.disabled = !canMutate;
    byId('refresh-files').disabled = !authed || !memory.threadId;
    byId('refresh-diff').disabled = !authed || !memory.threadId;
    byId('refresh-verification').disabled = !authed || !memory.threadId;
    R.setText(byId('action-state-badge'), label(turn));
    R.setText(byId('action-state'), byId('action-state').textContent || 'Ready for your next instruction');
    const controlCopy = memory.authKind === 'host'
      ? 'Host administrator session (local control).'
      : memory.controlEpoch !== null
        ? 'You hold the control lease for this thread.'
        : 'View-only until you take control.';
    R.setText(byId('control-copy'), controlCopy);
    R.setText(byId('composer-status'), !authed ? 'Connect or complete pairing to enable the composer.' : !canMutate ? controlCopy : !memory.threadId ? 'Create or resume a thread.' : S.canSendTurn(thread, turn) ? 'Ready to send.' : 'Turn is ' + label(turn).toLowerCase() + '.');
    if (approval === 'NONE' || approval === 'RESOLVED' || approval === 'STALE' || approval === 'EXPIRED') byId('approval-card').classList.add('hidden');
  }

  function authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (memory.token) headers.Authorization = 'Bearer ' + memory.token;
    return headers;
  }

  function rpcParams(params) {
    const next = Object.assign({}, params || {});
    if (memory.controlEpoch !== null && next.control_epoch === undefined) {
      next.control_epoch = memory.controlEpoch;
    }
    return next;
  }

  async function rpc(method, params, id) {
    if (typeof window.__babelRemoteRpc === 'function') {
      return window.__babelRemoteRpc(method, params, id);
    }
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
      body: JSON.stringify({ jsonrpc: '2.0', id: id || Date.now(), method: method, params: rpcParams(params) }),
    });
    const payload = await response.json();
    const classified = S.classifyRpcResponse(payload);
    if (classified.kind === 'malformed') throw new Error('rpc malformed');
    if (!response.ok && classified.kind !== 'rejected') throw new Error('rpc ' + response.status);
    return { payload: payload, classified: classified };
  }

  function clearControlLease(reason) {
    memory.controlEpoch = null;
    memory.controlExpiresAtMs = null;
    if (memory.leaseRenewTimer) clearInterval(memory.leaseRenewTimer);
    memory.leaseRenewTimer = null;
    if (reason) appendEvent({ type: 'connection', error: reason });
  }

  function startLeaseRenewal() {
    if (memory.leaseRenewTimer) clearInterval(memory.leaseRenewTimer);
    if (memory.authKind !== 'paired' || memory.controlEpoch === null || !memory.threadId) return;
    memory.leaseRenewTimer = setInterval(function () {
      rpc('control.renew', { thread_id: memory.threadId, control_epoch: memory.controlEpoch }).then(function (res) {
        if (res.classified.kind === 'success' && res.payload.result) {
          memory.controlExpiresAtMs = res.payload.result.expires_at_ms;
        } else {
          clearControlLease('Control lease expired or was lost.');
          renderChrome();
        }
      }).catch(function () {
        clearControlLease('Control lease renewal failed.');
        renderChrome();
      });
    }, LEASE_RENEW_MS);
  }

  async function syncControlLeaseFromHost() {
    if (!memory.threadId || memory.authKind !== 'paired' || !memory.clientId) {
      clearControlLease();
      return;
    }
    try {
      const res = await rpc('control.status', { thread_id: memory.threadId });
      if (res.classified.kind !== 'success' || !res.payload.result) {
        clearControlLease();
        return;
      }
      const st = res.payload.result;
      if (st.held && st.holder_client_id === memory.clientId && typeof st.epoch === 'number') {
        memory.controlEpoch = st.epoch;
        memory.controlExpiresAtMs = st.expires_at_ms || null;
        startLeaseRenewal();
      } else {
        clearControlLease();
      }
    } catch (error) {
      clearControlLease();
    }
  }

  async function refreshAuthSession() {
    const response = await fetch('/auth/session', { credentials: 'include' });
    if (!response.ok) return;
    const json = await response.json();
    if (json.ok && json.auth === 'paired_device') {
      memory.pairedDevice = true;
      memory.authKind = 'paired';
      memory.clientId = json.deviceId ? 'device:' + json.deviceId : null;
    } else if (json.ok && json.auth === 'host') {
      memory.authKind = 'host';
      memory.clientId = 'host:session';
    }
  }

  async function takeControl() {
    if (!memory.threadId) return;
    try {
      const result = await rpc('control.acquire', { thread_id: memory.threadId, force: false });
      if (result.classified.kind !== 'success' || !result.payload.result) throw new Error('acquire failed');
      memory.controlEpoch = result.payload.result.epoch;
      memory.controlExpiresAtMs = result.payload.result.expires_at_ms || null;
      startLeaseRenewal();
      R.setText(byId('action-state'), 'Remote control acquired');
      R.setText(byId('action-detail'), 'This device may send prompts and approvals until the lease expires.');
    } catch (error) {
      appendEvent({ type: 'failed', error: 'Could not take control. Another client may hold the lease.' });
    }
    renderChrome();
  }

  async function ensureSession() {
    if (memory.sessionId) return memory.sessionId;
    const response = await fetch('/sessions', {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
      body: JSON.stringify({ projectRoot: rootEl.value }),
    });
    if (!response.ok) throw new Error('session auth failed');
    const json = await response.json();
    if (!json.sessionId) throw new Error('session missing');
    memory.sessionId = json.sessionId;
    return memory.sessionId;
  }

  async function mintTicket() {
    const sessionId = await ensureSession();
    const response = await fetch('/ws/ticket', {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
      body: JSON.stringify({ session_id: sessionId, thread_id: memory.threadId }),
    });
    if (!response.ok) throw new Error('ticket mint failed');
    return response.json();
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
      try { message = JSON.parse(event.data); } catch (error) { appendEvent({ type: 'protocol_error', error: 'Invalid server message ignored.' }); return; }
      if (message.method === 'turn.event' && message.params) {
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
      if (message.method === 'permission.request' && message.params) {
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

  let lastCatalogResult = null;

  function refreshVendorSessions(catalogResult) {
    if (!vendorSessionEl) return;
    const harness = harnessEl && harnessEl.value === 'command-code';
    vendorSessionEl.disabled = !harness;
    const previous = vendorSessionEl.value;
    while (vendorSessionEl.options.length > 1) vendorSessionEl.remove(1);
    if (catalogResult) lastCatalogResult = catalogResult;
    if (!harness || !lastCatalogResult || !Array.isArray(lastCatalogResult.vendor_sessions)) return;
    lastCatalogResult.vendor_sessions.forEach(function (row) {
      if (!row || !row.session_id) return;
      const opt = document.createElement('option');
      opt.value = row.session_id;
      const owned = row.bound && row.canonical_thread_id ? ' [Babel ' + row.canonical_thread_id + ']' : '';
      opt.textContent = (row.title ? row.title + ' ' : '') + row.session_id + owned;
      vendorSessionEl.appendChild(opt);
    });
    if (previous && vendorSessionEl.querySelector('option[value="' + previous + '"]')) {
      vendorSessionEl.value = previous;
    }
  }

  async function renderHistoryCells(threadId) {
    const history = await rpc('history.lookup', { thread_id: threadId });
    if (history.classified.kind !== 'success') return;
    const cells = (history.payload.result && history.payload.result.cells) || [];
    transcript.textContent = '';
    cells.forEach(function (cell) {
      appendEvent({ type: cell.kind || 'cell', text: JSON.stringify(cell.payload || {}) });
    });
  }

  async function observeThread() {
    if (memory.threadId) connectSocket(await mintTicket());
  }

  async function connect() {
    if (tokenEl.value) memory.token = tokenEl.value;
    tokenEl.value = '';
    memory.authKind = memory.token ? 'host' : 'none';
    try {
      host = transition('host', host, 'start');
      renderChrome();
      await refreshAuthSession();
      const health = await fetch('/health');
      const json = await health.json();
      if (!json.ok) throw new Error('health');
      await ensureSession();
      host = transition('host', host, 'open');
      R.setText(byId('action-state'), 'Connected to Babel host');
      R.setText(byId('action-detail'), 'Create or resume a thread to begin.');
      try {
        const catalog = await rpc('remote.catalog', {});
        const sessions = (catalog.payload.result && catalog.payload.result.sessions) || [];
        refreshVendorSessions(catalog.payload.result);
        if (sessions.length && byId('thread-id')) {
          byId('thread-id').placeholder = sessions.length + ' session(s) on host';
        }
      } catch (catalogError) { /* catalog is optional during connect */ }
    } catch (error) {
      host = transition('host', host, 'error');
      appendEvent({ type: 'connection', error: 'Connection failed. Check the host and private route.' });
    }
    renderChrome();
  }

  async function reconcileAuthoritativeTaskState() {
    if (!memory.threadId) return;
    try {
      const catalog = await rpc('remote.catalog', {});
      if (catalog.classified.kind === 'success') {
        refreshVendorSessions(catalog.payload.result);
        const sessions = (catalog.payload.result && catalog.payload.result.sessions) || [];
        const row = sessions.find(function (item) { return item.thread_id === memory.threadId; });
        if (row) {
          if (row.active_turn) {
            turn = transition('turn', turn, 'stream');
            thread = transition('thread', thread, 'running');
          } else if (row.status === 'waiting_approval') {
            thread = transition('thread', thread, 'waiting_approval');
          }
        }
      }
    } catch (catalogError) { /* catalog is optional during reconnect */ }
    const applyTerminalRecord = function (terminal) {
      const recovered = S.applyTurnTerminalRecovery(terminal);
      if (!recovered) return;
      turn = recovered.turn;
      thread = recovered.thread;
      if (turn === 'COMPLETED' || turn === 'FAILED') {
        if (approval === 'PENDING') approval = transition('approval', approval, 'expire');
        memory.turnId = null;
      }
    };
    if (memory.threadId && S.turnNeedsTerminalReconcile(turn)) {
      try {
        let turnIdForTerminal = memory.turnId;
        const scan = await rpc('history.lookup', { thread_id: memory.threadId, limit: 200 });
        if (scan.classified.kind === 'success') {
          const latest = scan.payload.result && scan.payload.result.latest_turn_id;
          if (
            (turnIdForTerminal === null || turnIdForTerminal === undefined) &&
            typeof latest === 'number'
          ) {
            turnIdForTerminal = latest;
          }
        }
        if (turnIdForTerminal !== null && turnIdForTerminal !== undefined) {
          const history = await rpc('history.lookup', {
            thread_id: memory.threadId,
            turn_id: turnIdForTerminal,
            limit: 1,
          });
          if (history.classified.kind === 'success') {
            const terminal = history.payload.result && history.payload.result.turn_terminal;
            if (terminal && terminal.turn_id === turnIdForTerminal) {
              applyTerminalRecord(terminal);
            }
          }
        }
      } catch (historyError) { /* history terminal is optional during reconnect */ }
    }
    try {
      const lookup = await rpc('approval.lookup', {
        thread_id: memory.threadId,
        ...(memory.turnId !== undefined && memory.turnId !== null
          ? { turn_id: String(memory.turnId) }
          : {}),
      });
      if (lookup.classified.kind !== 'success') return;
      const pending = ((lookup.payload.result && lookup.payload.result.pending) || []).find(function (item) {
        return item.state === 'pending';
      });
      if (!pending) {
        if (approval === 'PENDING') approval = transition('approval', approval, 'expire');
        return;
      }
      memory.pendingApproval = {
        approval_id: pending.approval_id,
        thread_id: pending.thread_id,
        turn_id: pending.turn_id,
        operation_digest: pending.operation_digest,
      };
      approval = transition('approval', approval, 'pending');
      thread = transition('thread', thread, 'waiting_approval');
      R.renderApproval({
        actionType: pending.command || 'approval',
        command: pending.command,
        cwd: pending.cwd,
        targetPath: '',
        digest: pending.operation_digest,
      });
      appendEvent({ type: 'permission', role: 'system', text: 'Pending approval reconciled from host without resubmitting the task.' });
    } catch (lookupError) {
      if (turn === 'STREAMING' || turn === 'ACKNOWLEDGED') {
        turn = transition('turn', turn, 'unknown');
        appendEvent({ type: 'connection', error: 'Active turn state is UNKNOWN until the host confirms pending work.' });
      }
    }
  }

  async function reconnect() {
    try {
      if (host === 'ONLINE') host = transition('host', host, 'close');
      if (host === 'UNKNOWN' || host === 'OFFLINE') host = transition('host', host, 'start');
      renderChrome();
      await refreshAuthSession();
      const health = await fetch('/health');
      const healthJson = await health.json();
      if (!healthJson.ok) throw new Error('health');
      if (host === 'RECONNECTING' || host === 'CONNECTING') host = transition('host', host, 'open');
      await observeThread();
      if (memory.threadId) {
        thread = transition('thread', thread, 'recover');
        const resumed = await rpc('thread.resume', {
          thread_id: memory.threadId,
          project_root: rootEl.value,
          session_id: memory.sessionId,
        });
        if (resumed.classified.kind !== 'success') throw new Error('resume rejected');
        const history = await rpc('history.lookup', { thread_id: memory.threadId });
        if (history.classified.kind !== 'success') throw new Error('history rejected');
        const cells = (history.payload.result && history.payload.result.cells) || [];
        transcript.textContent = '';
        cells.forEach(function (cell) { appendEvent({ type: cell.kind || 'cell', text: JSON.stringify(cell.payload || {}) }); });
        await syncControlLeaseFromHost();
        await reconcileAuthoritativeTaskState();
        thread = transition('thread', thread, 'ready');
      }
      host = transition('host', host, 'open');
    } catch (error) {
      const recovery = S.reconcileAfterProtocolError({ host: host, activeTurn: turn !== 'IDLE' && turn !== 'COMPLETED' });
      host = recovery.host;
      if (recovery.turn !== 'UNCHANGED') turn = recovery.turn;
      if (recovery.thread !== 'UNCHANGED') thread = recovery.thread;
      appendEvent({ type: 'connection', error: 'Reconnect failed. The state remains fail-closed.' });
    }
    renderChrome();
  }

  async function createThread() {
    try {
      thread = transition('thread', thread, 'create');
      const sessionId = await ensureSession();
      const harness = harnessEl && harnessEl.value ? harnessEl.value : 'babel-native';
      const createParams = { project_root: rootEl.value, session_id: sessionId };
      if (harness === 'command-code' && vendorSessionEl && vendorSessionEl.value) {
        const nativeId = vendorSessionEl.value;
        const selected = (lastCatalogResult && lastCatalogResult.vendor_sessions || []).find(function (row) {
          return row && row.session_id === nativeId;
        });
        createParams.harness_adapter_id = 'command-code';
        if (selected && selected.canonical_thread_id) {
          memory.threadId = selected.canonical_thread_id;
          const resumed = await rpc('thread.resume', {
            thread_id: memory.threadId,
            project_root: rootEl.value,
            session_id: sessionId,
          });
          if (resumed.classified.kind !== 'success') throw new Error('thread.resume rejected');
        } else {
          createParams.harness_native_session_id = nativeId;
          const result = await rpc('thread.create', createParams);
          if (result.classified.kind !== 'success') throw new Error('thread.create rejected');
          memory.threadId = result.payload.result && result.payload.result.thread_id;
        }
        if (memory.authKind === 'paired') {
          const acquired = await rpc('control.acquire', { thread_id: memory.threadId, force: false });
          if (acquired.classified.kind !== 'success' || !acquired.payload.result) {
            throw new Error('control.acquire rejected before open');
          }
          memory.controlEpoch = acquired.payload.result.epoch;
          memory.controlExpiresAtMs = acquired.payload.result.expires_at_ms || null;
          startLeaseRenewal();
        } else {
          await syncControlLeaseFromHost();
        }
        const opened = await rpc('harness.command_code.open', {
          thread_id: memory.threadId,
          project_root: rootEl.value,
          harness_native_session_id: nativeId,
        });
        if (opened.classified.kind !== 'success') throw new Error('harness.command_code.open rejected');
        await renderHistoryCells(memory.threadId);
      } else {
        if (harness === 'command-code') createParams.harness_adapter_id = 'command-code';
        const result = await rpc('thread.create', createParams);
        if (result.classified.kind !== 'success') throw new Error('thread.create rejected');
        memory.threadId = result.payload.result && result.payload.result.thread_id;
      }
      threadInput.value = memory.threadId || '';
      thread = transition('thread', thread, 'ready');
      await observeThread();
    } catch (error) { thread = transition('thread', thread, 'fail'); appendEvent({ type: 'failed', error: 'Thread creation failed.' }); }
    renderChrome();
  }

  async function resumeThread() {
    try {
      thread = transition('thread', thread, 'resume');
      memory.threadId = threadInput.value;
      clearControlLease();
      const sessionId = await ensureSession();
      const result = await rpc('thread.resume', {
        thread_id: memory.threadId,
        project_root: rootEl.value,
        session_id: sessionId,
      });
      if (result.classified.kind !== 'success') throw new Error('thread.resume rejected');
      thread = transition('thread', thread, 'ready');
      await observeThread();
      await syncControlLeaseFromHost();
    } catch (error) { thread = transition('thread', thread, 'fail'); appendEvent({ type: 'failed', error: 'Thread resume failed.' }); }
    renderChrome();
  }

  async function send() {
    if (sendInFlight || !S.canSendTurn(thread, turn)) return;
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
      const result = await rpc('turn.submit', { thread_id: memory.threadId, message: message, command_id: commandId });
      if (result.classified.kind === 'rejected') {
        const msg = result.classified.message || '';
        if (msg.indexOf('lease') !== -1 || msg.indexOf('epoch') !== -1) clearControlLease('Lost control lease before submit completed.');
        const decision = S.reconcileAfterSubmitFailure({ responseSettled: true, commandId: commandId, hostReachable: host === 'ONLINE' });
        turn = transition('turn', turn, 'fail');
        thread = transition('thread', thread, 'ready');
        appendEvent({ type: 'failed', error: 'Submit rejected: ' + msg + ' (' + decision.ambiguity + ').' });
        return;
      }
      if (result.classified.kind !== 'success') throw new Error('submit ambiguous');
      memory.turnId = result.payload.result.turn_id;
      turn = transition('turn', turn, 'ack');
    } catch (error) {
      const decision = S.reconcileAfterSubmitFailure({ responseSettled: false, commandId: commandId, hostReachable: host === 'ONLINE' });
      turn = transition('turn', turn, decision.ambiguity === 'ambiguous_network' ? 'unknown' : 'fail');
      appendEvent({ type: 'failed', error: 'Submit status ' + decision.ambiguity + '; not auto-resubmitted.' });
    } finally {
      sendInFlight = false;
      renderChrome();
    }
  }

  async function stop() {
    if (!S.canCancelTurn(turn)) return;
    turn = transition('turn', turn, 'cancel');
    renderChrome();
    try {
      const result = await rpc('turn.cancel', { thread_id: memory.threadId });
      if (result.classified.kind === 'rejected') {
        const msg = result.classified.message || 'rejected';
        if (msg.indexOf('lease') !== -1 || msg.indexOf('epoch') !== -1) clearControlLease('Lost control lease before cancel completed.');
        const decision = S.reconcileAfterCancelRejection({ responseSettled: true, hostReachable: host === 'ONLINE' });
        turn = transition('turn', turn, decision.turn === 'STREAMING' ? 'recover' : 'fail');
        appendEvent({ type: 'failed', error: 'Cancel rejected: ' + msg + ' (' + decision.ambiguity + ').' });
        renderChrome();
        return;
      }
      if (result.classified.kind !== 'success') {
        const decision = S.reconcileAfterCancelRejection({ responseSettled: false, hostReachable: host === 'ONLINE' });
        turn = transition('turn', turn, decision.turn === 'UNKNOWN' ? 'unknown' : 'fail');
        appendEvent({ type: 'failed', error: 'Cancel status ' + decision.ambiguity + '.' });
        renderChrome();
        return;
      }
    } catch (error) {
      const decision = S.reconcileAfterCancelRejection({ responseSettled: false, hostReachable: host === 'ONLINE' });
      turn = transition('turn', turn, decision.turn === 'UNKNOWN' ? 'unknown' : 'fail');
      appendEvent({ type: 'failed', error: 'Cancel status ' + decision.ambiguity + '.' });
    }
    renderChrome();
  }

  async function decide(decision) {
    if (!memory.pendingApproval || approval !== 'PENDING') return;
    approval = transition('approval', approval, decision === 'allow_once' ? 'allow' : 'deny');
    renderChrome();
    try {
      const result = await rpc('approval.decide', {
        approval_id: memory.pendingApproval.approval_id,
        decision: decision,
        thread_id: memory.pendingApproval.thread_id || memory.threadId,
        turn_id: String(memory.pendingApproval.turn_id || memory.turnId || ''),
        operation_digest: memory.pendingApproval.operation_digest,
      });
      if (result.classified.kind === 'rejected') {
        const msg = result.classified.message || 'rejected';
        if (msg.indexOf('lease') !== -1 || msg.indexOf('epoch') !== -1) clearControlLease('Lost control lease during approval.');
        approval = transition('approval', approval, msg.indexOf('expired') !== -1 ? 'expire' : 'stale');
        appendEvent({ type: 'failed', error: msg });
      } else if (result.classified.kind === 'success') {
        approval = transition('approval', approval, 'resolve');
        memory.pendingApproval = null;
        thread = transition('thread', thread, 'running');
        appendEvent({ type: 'permission', role: 'system', text: decision === 'allow_once' ? 'ALLOW ONCE recorded.' : 'DENY recorded. No mutation was performed.' });
      } else {
        approval = transition('approval', approval, 'stale');
        appendEvent({ type: 'failed', error: 'Approval response was ambiguous.' });
      }
    } catch (error) {
      approval = transition('approval', approval, 'stale');
      appendEvent({ type: 'failed', error: 'Approval request failed before a definitive host response.' });
    }
    renderChrome();
  }

  function installNormalHandlers() {
    byId('connect').onclick = connect;
    byId('take-control').onclick = takeControl;
    byId('reconnect').onclick = reconnect;
    byId('create').onclick = createThread;
    byId('resume').onclick = resumeThread;
    byId('send').onclick = send;
    byId('stop').onclick = stop;
    byId('allow-once').onclick = function () { decide('allow_once'); };
    byId('deny').onclick = function () { decide('deny'); };
    byId('refresh-files').onclick = async function () {
      try {
        const result = await rpc('workspace.changes', { thread_id: memory.threadId });
        const files = (result.payload.result && result.payload.result.files) || [];
        R.renderFiles(files);
      } catch (error) { appendEvent({ type: 'failed', error: 'Changed files unavailable.' }); }
    };
    byId('refresh-diff').onclick = async function () {
      try {
        const result = await rpc('workspace.changes', { thread_id: memory.threadId });
        R.setText(byId('diff'), result.payload.result && result.payload.result.diff || 'No diff available.');
      } catch (error) { appendEvent({ type: 'failed', error: 'Diff unavailable.' }); }
    };
    byId('refresh-verification').onclick = async function () {
      try {
        const result = await rpc('verification.lookup', { thread_id: memory.threadId });
        const snapshot = result.payload.result || { status: 'NOT_VERIFIED', reason: 'No verification recorded.' };
        R.setVerification(snapshot);
      } catch (error) { appendEvent({ type: 'failed', error: 'Verification unavailable.' }); }
    };
    rootEl.oninput = renderChrome;
    if (harnessEl) {
      harnessEl.onchange = async function () {
        renderChrome();
        if (harnessEl.value === 'command-code' && (memory.token || memory.pairedDevice)) {
          try {
            const catalog = await rpc('remote.catalog', {});
            if (catalog.classified.kind === 'success') refreshVendorSessions(catalog.payload.result);
          } catch (catalogError) { /* optional */ }
        }
      };
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        void syncControlLeaseFromHost().then(function () { renderChrome(); });
      }
    });
    window.addEventListener('focus', function () {
      if (memory.controlEpoch !== null && memory.authKind === 'paired') {
        void rpc('control.renew', { thread_id: memory.threadId, control_epoch: memory.controlEpoch }).then(function (res) {
          if (res.classified.kind !== 'success') clearControlLease('Control lease lost while backgrounded.');
          renderChrome();
        }).catch(function () { clearControlLease('Control lease renewal failed after resume.'); renderChrome(); });
      }
    });
    window.BabelRemoteApp = {
      getState: function () {
        return { host: host, thread: thread, turn: turn, approval: approval, sendInFlight: sendInFlight };
      },
      memoryHasToken: function () { return Boolean(memory.token) || memory.pairedDevice; },
      send: send,
      stop: stop,
      decide: decide,
      configureTest: function (patch) {
        if (patch && patch.host !== undefined) host = patch.host;
        if (patch && patch.thread !== undefined) thread = patch.thread;
        if (patch && patch.turn !== undefined) turn = patch.turn;
        if (patch && patch.approval !== undefined) approval = patch.approval;
        if (patch && patch.memory) Object.assign(memory, patch.memory);
      },
      reconnect: reconnect,
      observeThread: observeThread,
      reconcileAuthoritativeTaskState: reconcileAuthoritativeTaskState,
    };
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
    await refreshAuthSession();
    if (memory.pairedDevice) {
      host = transition('host', host, 'open');
      R.setText(byId('action-state'), 'Paired device session');
      R.setText(byId('action-detail'), 'Cookie authentication restored. Connect workspace to continue.');
      renderChrome();
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' }).catch(function () { /* optional install */ });
  }

  boot().catch(function () {
    R.setText(byId('connection-copy'), 'Fixture or host unavailable');
    R.setText(byId('action-state'), 'Unable to load Remote');
    R.setText(byId('action-detail'), 'The client failed closed before opening a session.');
  });
})();
