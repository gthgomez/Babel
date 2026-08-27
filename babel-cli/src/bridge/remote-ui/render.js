(function (root) {
  function appendSafeText(target, text) {
    target.appendChild(document.createTextNode(String(text || '')));
  }

  function setText(el, text) {
    if (el) el.textContent = String(text || '');
  }

  function clear(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  function eventRole(event) {
    if (event.role) return event.role;
    if (event.type === 'tool_start' || event.tool) return 'tool';
    if (event.type === 'user') return 'user';
    if (event.type === 'answer_chunk' || event.type === 'assistant' || event.text) return 'assistant';
    return 'system';
  }

  function appendTranscriptEvent(target, event) {
    const row = document.createElement('article');
    const role = eventRole(event);
    row.className = 'event event-' + role;
    row.setAttribute('data-type', event.type || 'event');
    row.setAttribute('data-role', role);
    const label = document.createElement('span');
    label.className = 'event-label';
    appendSafeText(label, event.type || role);
    row.appendChild(label);
    const body = event.text || event.error || [event.tool, event.target].filter(Boolean).join(' ');
    if (body) {
      const pre = document.createElement('pre');
      appendSafeText(pre, body);
      row.appendChild(pre);
    }
    target.appendChild(row);
  }

  function statusLabel(value) {
    return String(value || 'UNKNOWN').replaceAll('_', ' ');
  }

  function statusTone(value) {
    const normalized = String(value || '').toLowerCase();
    if (normalized === 'online' || normalized === 'verified' || normalized === 'completed') return 'online';
    if (normalized === 'connecting' || normalized === 'reconnecting' || normalized === 'streaming' || normalized === 'waiting_approval' || normalized === 'partial') return 'connecting';
    if (normalized === 'offline' || normalized === 'failed' || normalized === 'unknown') return normalized === 'unknown' ? 'unknown' : 'offline';
    return 'unknown';
  }

  function applyStatusClasses(el, value, prefix) {
    if (!el) return;
    el.className = prefix || '';
    const tone = statusTone(value);
    if (tone === 'online') el.classList.add('pill-success');
    else if (tone === 'connecting') el.classList.add('pill-warning');
    else if (tone === 'offline' || tone === 'unknown') el.classList.add('pill-danger');
    else el.classList.add('pill-neutral');
  }

  function renderApproval(request) {
    const card = document.getElementById('approval-card');
    const details = document.getElementById('approval-details');
    clear(details);
    if (!request) {
      card.classList.add('hidden');
      return;
    }
    const values = [
      ['Action', request.actionType],
      ['Target', request.targetPath || request.command],
      ['Working dir', request.cwd],
      ['Digest', request.digest],
    ];
    values.forEach(function (entry) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      appendSafeText(dt, entry[0]);
      appendSafeText(dd, entry[1]);
      row.appendChild(dt);
      row.appendChild(dd);
      details.appendChild(row);
    });
    card.classList.remove('hidden');
  }

  function renderFiles(files) {
    const target = document.getElementById('files');
    const count = document.getElementById('files-count');
    clear(target);
    setText(count, String(files.length));
    if (!files.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      appendSafeText(empty, 'No changed files loaded.');
      target.appendChild(empty);
      return;
    }
    files.forEach(function (file) {
      const row = document.createElement('div');
      row.className = 'file-row';
      const status = document.createElement('span');
      status.className = 'file-status';
      const path = document.createElement('span');
      path.className = 'file-path';
      appendSafeText(status, file.status || '?');
      appendSafeText(path, file.path || '');
      row.appendChild(status);
      row.appendChild(path);
      target.appendChild(row);
    });
  }

  function renderVerification(snapshot) {
    const status = snapshot && snapshot.status || 'NOT_VERIFIED';
    setText(document.getElementById('verification'), snapshot && snapshot.reason || 'No verification has been recorded.');
    setText(document.getElementById('verification-badge'), statusLabel(status));
    applyStatusClasses(document.getElementById('verification-badge'), status, 'pill');
  }

  function renderFixture(scenario) {
    document.body.setAttribute('data-fixture-mode', 'true');
    document.body.setAttribute('data-scenario', scenario.id);
    setText(document.getElementById('workspace'), scenario.workspace);
    setText(document.getElementById('thread-id-display'), scenario.threadId || 'No active thread');
    setText(document.getElementById('harness-label'), scenario.harness || 'Babel native');
    setText(document.getElementById('host-state'), statusLabel(scenario.host));
    setText(document.getElementById('host-detail'), scenario.host === 'ONLINE' ? 'Private host reachable.' : scenario.actionDetail);
    setText(document.getElementById('thread-state'), scenario.thread === 'NONE' ? 'No active thread' : statusLabel(scenario.thread));
    setText(document.getElementById('thread-detail'), scenario.thread === 'READY' ? 'Session is ready for a structured prompt.' : scenario.actionDetail);
    setText(document.getElementById('turn-state'), statusLabel(scenario.turn));
    setText(document.getElementById('turn-detail'), scenario.actionDetail);
    setText(document.getElementById('action-state'), scenario.action);
    setText(document.getElementById('action-detail'), scenario.actionDetail);
    setText(document.getElementById('action-state-badge'), statusLabel(scenario.turn));
    applyStatusClasses(document.getElementById('action-state-badge'), scenario.turn, 'pill');
    const connection = document.getElementById('connection-copy');
    setText(connection, scenario.host === 'ONLINE' ? 'Host connected' : 'Host ' + statusLabel(scenario.host).toLowerCase());
    document.querySelectorAll('.topbar-status .status-dot, #host-card .status-dot').forEach(function (dot) {
      dot.className = 'status-dot ' + statusTone(scenario.host);
    });
    const transcript = document.getElementById('transcript');
    clear(transcript);
    (scenario.transcript || []).forEach(function (event) { appendTranscriptEvent(transcript, event); });
    setText(document.getElementById('transcript-count'), String((scenario.transcript || []).length) + ' events');
    renderFiles(scenario.files || []);
    setText(document.getElementById('diff'), scenario.diff || 'No diff loaded yet.');
    renderVerification(scenario.verification);
    renderApproval(scenario.approval === 'PENDING' ? scenario.approvalRequest : null);
    if (scenario.longPrompt) document.getElementById('composer').value = scenario.longPrompt;
    document.getElementById('auth-card').classList.add('hidden');
    document.getElementById('composer').disabled = scenario.host !== 'ONLINE' || scenario.thread === 'NONE';
    document.getElementById('send').disabled = scenario.host !== 'ONLINE' || scenario.thread !== 'READY';
    document.getElementById('stop').disabled = scenario.turn !== 'STREAMING';
    document.getElementById('reconnect').disabled = false;
    document.querySelectorAll('#refresh-files, #refresh-diff, #refresh-verification').forEach(function (button) { button.disabled = false; });
  }

  root.BabelRemoteRender = {
    appendSafeText: appendSafeText,
    appendTranscriptEvent: appendTranscriptEvent,
    renderApproval: renderApproval,
    renderFiles: renderFiles,
    renderFixture: renderFixture,
    setVerification: renderVerification,
    setText: setText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
