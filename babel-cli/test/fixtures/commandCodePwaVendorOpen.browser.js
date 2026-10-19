/**
 * Cold-restart PWA journey: production catalog → picker → open/history → reconnect → continue.
 */
window.runCommandCodePwaColdRestartJourney = async function runCommandCodePwaColdRestartJourney({
  token,
  root,
  nativeId,
  seedThread,
  transportSessionId,
}) {
  const waitFor = async (predicate, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error('Timed out: ' + label);
  };

  const rootInput = document.getElementById('root');
  const harnessSelect = document.getElementById('harness-adapter');
  const vendorSelect = document.getElementById('vendor-session');
  const createBtn = document.getElementById('create');
  const reconnectBtn = document.getElementById('reconnect');
  const transcript = document.getElementById('transcript');
  const threadInput = document.getElementById('thread-id');
  const composer = document.getElementById('composer');
  const sendBtn = document.getElementById('send');
  if (
    !rootInput ||
    !harnessSelect ||
    !vendorSelect ||
    !createBtn ||
    !reconnectBtn ||
    !transcript ||
    !threadInput ||
    !composer ||
    !sendBtn
  ) {
    throw new Error('PWA DOM controls missing');
  }
  rootInput.value = root;
  const app = window.BabelRemoteApp;
  if (!app || app.fixture) throw new Error('production PWA handlers are not active');
  app.configureTest({
    host: 'ONLINE',
    thread: 'NONE',
    turn: 'IDLE',
    memory: {
      token,
      sessionId: transportSessionId,
      threadId: '',
      turnId: null,
      authKind: 'host',
    },
  });
  harnessSelect.value = 'command-code';
  harnessSelect.dispatchEvent(new Event('change'));
  await waitFor(
    () => Array.from(vendorSelect.options).some((opt) => opt.value === nativeId),
    'vendor picker populated from production catalog',
  );
  vendorSelect.value = nativeId;
  createBtn.click();
  await waitFor(
    () =>
      threadInput.value === seedThread &&
      (transcript.textContent || '').includes('fixture:history-replay'),
    'open/history before prompt',
  );
  const historyBeforePrompt = transcript.textContent || '';
  app.configureTest({
    memory: {
      token,
      sessionId: transportSessionId,
      threadId: seedThread,
      turnId: null,
      authKind: 'host',
    },
  });
  await app.reconnect();
  await waitFor(() => app.getState().host === 'ONLINE', 'reconnect completes');
  if (typeof app.observeThread === 'function') await app.observeThread();
  await waitFor(
    () => app.getState().thread === 'READY' && (app.getState().turn === 'IDLE' || app.getState().turn === 'COMPLETED'),
    'thread ready after reconnect',
  );
  const takeControl = document.getElementById('take-control');
  if (takeControl && !takeControl.disabled) takeControl.click();
  await new Promise((r) => setTimeout(r, 100));
  composer.value = 'continue-same-native';
  sendBtn.click();
  await waitFor(
    () => (transcript.textContent || '').includes('fixture:continue-same-native'),
    'immediate continuation turn output',
  );
  const fullText = transcript.textContent || '';
  return {
    threadId: threadInput.value,
    pickerFromCatalog: true,
    historyBeforePrompt,
    resumedSameThread: threadInput.value === seedThread,
    continuationSeen: fullText.includes('fixture:continue-same-native'),
    staleLeak: fullText.includes('fixture:block-open'),
  };
};

/** Paired controller (cookie session): must acquire lease before harness.command_code.open. */
window.runCommandCodePwaPairedVendorOpenJourney = async function runCommandCodePwaPairedVendorOpenJourney({
  root,
  nativeId,
  seedThread,
  transportSessionId,
}) {
  const waitFor = async (predicate, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error('Timed out: ' + label);
  };

  const rootInput = document.getElementById('root');
  const harnessSelect = document.getElementById('harness-adapter');
  const vendorSelect = document.getElementById('vendor-session');
  const createBtn = document.getElementById('create');
  const transcript = document.getElementById('transcript');
  const threadInput = document.getElementById('thread-id');
  if (!rootInput || !harnessSelect || !vendorSelect || !createBtn || !transcript || !threadInput) {
    throw new Error('PWA DOM controls missing');
  }
  const app = window.BabelRemoteApp;
  if (!app || app.fixture) throw new Error('production PWA handlers are not active');
  const authRes = await fetch('/auth/session', { credentials: 'include' });
  const authJson = await authRes.json();
  if (!authJson.ok || authJson.auth !== 'paired_device') throw new Error('paired auth missing');
  app.configureTest({
    host: 'ONLINE',
    thread: 'NONE',
    turn: 'IDLE',
    memory: {
      pairedDevice: true,
      authKind: 'paired',
      clientId: authJson.deviceId ? 'device:' + authJson.deviceId : null,
      sessionId: transportSessionId,
      threadId: '',
      turnId: null,
      controlEpoch: null,
    },
  });
  rootInput.value = root;
  harnessSelect.value = 'command-code';
  harnessSelect.dispatchEvent(new Event('change'));
  await waitFor(
    () => Array.from(vendorSelect.options).some((opt) => opt.value === nativeId),
    'paired vendor picker populated from catalog',
  );
  vendorSelect.value = nativeId;
  createBtn.click();
  await waitFor(
    () => {
      const text = transcript.textContent || '';
      if (text.includes('Thread creation failed')) return true;
      return threadInput.value === seedThread && text.includes('fixture:history-replay');
    },
    'paired open/history',
  );
  if ((transcript.textContent || '').includes('Thread creation failed')) {
    throw new Error('paired createThread failed');
  }
  return {
    authKind: app.getAuthKind(),
    controlEpoch: app.getControlEpoch(),
    resumedSameThread: threadInput.value === seedThread,
  };
};
