window.runRemoteBrowserFlow = async function runRemoteBrowserFlow({ token, root }) {
  const memory = { token, sessionId: '', threadId: '' };
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
  if (!created.result || !created.result.thread_id) {
    throw new Error('thread.create failed: ' + JSON.stringify(created));
  }
  memory.threadId = created.result.thread_id;
  const ticketRes = await fetch('/ws/ticket', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ session_id: memory.sessionId, thread_id: memory.threadId }),
  });
  const ticketJson = await ticketRes.json();
  const wsUrl =
    'ws://127.0.0.1:' +
    window.location.port +
    '/ws?sessionId=' +
    encodeURIComponent(memory.sessionId) +
    '&ticket=' +
    encodeURIComponent(ticketJson.ticket);
  const collected = [];
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = () => resolve(undefined);
    socket.onerror = () => reject(new Error('ws failed'));
    setTimeout(() => reject(new Error('ws timeout')), 5000);
  });
  socket.onmessage = (event) => collected.push(String(event.data));
  await rpc(
    'turn.submit',
    { thread_id: memory.threadId, message: 'browser integration', command_id: 'browser-1' },
    2,
  );
  await new Promise((r) => setTimeout(r, 250));
  socket.close();
  return { threadId: memory.threadId, events: collected };
};
