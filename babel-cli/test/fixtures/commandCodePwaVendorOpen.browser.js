/**
 * Production PWA Command Code DOM leg (setup via host RPC before invoke).
 */
window.runCommandCodePwaVendorOpenDomLeg = async function runCommandCodePwaVendorOpenDomLeg({
  token,
  root,
  nativeId,
  seedThread,
  transportSessionId,
}) {
  const rootInput = document.getElementById('root');
  const harnessSelect = document.getElementById('harness-adapter');
  const vendorSelect = document.getElementById('vendor-session');
  const createBtn = document.getElementById('create');
  const transcript = document.getElementById('transcript');
  const threadInput = document.getElementById('thread-id');
  if (!rootInput || !harnessSelect || !vendorSelect || !createBtn || !transcript || !threadInput) {
    throw new Error('PWA DOM controls missing');
  }
  rootInput.value = root;
  const app = window.BabelRemoteApp;
  if (!app || app.fixture) throw new Error('production PWA handlers are not active');
  app.configureTest({
    host: 'ONLINE',
    thread: 'IDLE',
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
  await new Promise((r) => setTimeout(r, 150));
  let option = Array.from(vendorSelect.options).find((opt) => opt.value === nativeId);
  if (!option) {
    option = document.createElement('option');
    option.value = nativeId;
    option.textContent = nativeId;
    vendorSelect.appendChild(option);
  }
  vendorSelect.value = nativeId;
  createBtn.click();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (threadInput.value && (transcript.textContent || '').length > 0) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  const historyText = transcript.textContent || '';
  const hasReplay = historyText.includes('fixture:history-replay') || historyText.includes('user-history');
  const state = app.getState();
  return {
    threadId: threadInput.value,
    historyDomHasReplay: hasReplay,
    thread: state.thread,
    host: state.host,
    resumedSameThread: threadInput.value === seedThread,
  };
};
