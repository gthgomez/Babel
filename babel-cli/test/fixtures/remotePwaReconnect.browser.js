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
  const submit = await rpc(
    'turn.submit',
    { thread_id: memory.threadId, message: 'first turn', command_id: 'pwa-reconnect-1' },
    2,
  );
  memory.turnId = submit.result.turn_id;
  await new Promise((r) => setTimeout(r, 300));
  const historyBefore = await rpc('history.lookup', { thread_id: memory.threadId }, 3);
  const cellsBefore = (historyBefore.result && historyBefore.result.cells) || [];
  const rootInput = document.getElementById('root');
  if (rootInput) rootInput.value = root;
  const app = window.BabelRemoteApp;
  if (!app || app.fixture) throw new Error('production PWA handlers are not active');
  app.configureTest({
    host: 'ONLINE',
    thread: 'RUNNING',
    turn: 'STREAMING',
    memory: {
      token: memory.token,
      sessionId: memory.sessionId,
      threadId: memory.threadId,
      turnId: memory.turnId,
      authKind: 'host',
    },
  });
  await app.reconnect();
  const state = app.getState();
  const historyAfter = await rpc('history.lookup', { thread_id: memory.threadId }, 4);
  const cellsAfter = (historyAfter.result && historyAfter.result.cells) || [];
  const catalog = await rpc('remote.catalog', {}, 5);
  const row = ((catalog.result && catalog.result.sessions) || []).find(
    (item) => item.thread_id === memory.threadId,
  );
  return {
    threadId: memory.threadId,
    host: state.host,
    turn: state.turn,
    historyCells: cellsAfter.length,
    historyReplayed: cellsAfter.length >= cellsBefore.length,
    catalogStatus: row ? row.status : 'missing',
    activeTurn: row ? row.active_turn : false,
  };
};
