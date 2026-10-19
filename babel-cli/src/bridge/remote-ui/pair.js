(function () {
  const params = new URLSearchParams(location.search);
  const challengeId = params.get('challenge_id');
  const statusEl = document.getElementById('pair-status');
  const labelEl = document.getElementById('device-label');
  const submitBtn = document.getElementById('pair-submit');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  if (!challengeId) {
    setStatus('Missing challenge_id. Open the pairing link from the host administrator.');
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  let pollTimer = null;

  async function pollStatus() {
    const response = await fetch(
      '/pair/status?challenge_id=' + encodeURIComponent(challengeId),
      { credentials: 'include' },
    );
    const json = await response.json();
    if (json.state === 'paired') {
      setStatus('Paired successfully. Opening the supervisory console…');
      if (pollTimer) clearInterval(pollTimer);
      history.replaceState({}, '', '/pair');
      location.href = '/ui/';
      return;
    }
    if (json.state === 'awaiting_approval') {
      setStatus('Waiting for host approval for “' + (json.deviceLabel || labelEl.value) + '”.');
      return;
    }
    if (json.state === 'missing' || json.state === 'consumed') {
      setStatus('This pairing challenge expired or was already used. Request a new link on the host.');
      if (pollTimer) clearInterval(pollTimer);
      return;
    }
    setStatus('Challenge accepted. Submit a device name or wait for approval.');
  }

  async function submitRequest() {
    const label = (labelEl && labelEl.value.trim()) || 'Browser device';
    submitBtn.disabled = true;
    const response = await fetch('/pair/request', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: challengeId, device_label: label }),
    });
    if (!response.ok) {
      setStatus('Pairing request failed. The challenge may have expired.');
      submitBtn.disabled = false;
      return;
    }
    setStatus('Request sent. Confirm approval on the host.');
    if (!pollTimer) pollTimer = setInterval(pollStatus, 2000);
    pollStatus();
  }

  if (submitBtn) submitBtn.onclick = submitRequest;
  pollStatus();
  if (!pollTimer) pollTimer = setInterval(pollStatus, 3000);
})();
