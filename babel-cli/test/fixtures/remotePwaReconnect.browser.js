/**
 * Production PWA handlers exercised in a real browser against the loopback gateway.
 * Uses window.BabelRemoteApp (installNormalHandlers) — not /fixture mode.
 */
window.runRemotePwaReconnectFlow = async function runRemotePwaReconnectFlow({ token, root }) {
  const memory = { token, sessionId: '', threadId: '', turnId: null };
  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + memory.token,
  });
  const rpc = async (method, params, id) => {
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return response.json();
  };
  const sessionRes = await fetch('/sessions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ projectRoot: root }),
  });
  const sessionJson = await sessionRes.json();
  memory.sessionId = sessionJson.sessionId;
  const created = await rpc('thread.create', { project_root: root, session_id: memory.sessionId }, 1);
  memory.threadId = created.result.thread_id;
  await rpc(
    'turn.submit',
    { thread_id: memory.threadId, message: 'first turn', command_id: 'pwa-reconnect-1' },
    2,
  );
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const catalog = await rpc('remote.catalog', {}, 90);
    const row = ((catalog.result && catalog.result.sessions) || []).find(
      (item) => item.thread_id === memory.threadId,
    );
    if (row && !row.active_turn && row.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 80));
  }
  const historyBefore = await rpc('history.lookup', { thread_id: memory.threadId }, 3);
  const cellsBefore = (historyBefore.result && historyBefore.result.cells) || [];
  const rootInput = document.getElementById('root');
  if (rootInput) rootInput.value = root;
  const app = window.BabelRemoteApp;
  if (!app || app.fixture) throw new Error('production PWA handlers are not active');
  app.configureTest({
    host: 'ONLINE',
    thread: 'READY',
    turn: 'IDLE',
    memory: {
      token: memory.token,
      sessionId: memory.sessionId,
      threadId: memory.threadId,
      turnId: null,
      authKind: 'host',
    },
  });
  await app.reconnect();
  const state = app.getState();
  const historyAfter = await rpc('history.lookup', { thread_id: memory.threadId }, 4);
  const cellsAfter = (historyAfter.result && historyAfter.result.cells) || [];
  const catalogFinal = await rpc('remote.catalog', {}, 5);
  const row = ((catalogFinal.result && catalogFinal.result.sessions) || []).find(
    (item) => item.thread_id === memory.threadId,
  );
  return {
    threadId: memory.threadId,
    host: state.host,
    turn: state.turn,
    thread: state.thread,
    historyCells: cellsAfter.length,
    historyReplayed: cellsAfter.length >= cellsBefore.length,
    catalogStatus: row ? row.status : 'missing',
    activeTurn: row ? row.active_turn : true,
  };
};
