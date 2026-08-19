/** Minimal spike PWA. No secrets in this document — the operator pastes the bearer token. */

export const REMOTE_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="theme-color" content="#111"/>
  <title>Babel Remote</title>
  <style>
    body { font: 16px/1.4 system-ui, sans-serif; margin: 0; padding: 12px; max-width: 40rem; }
    textarea, input, button { width: 100%; box-sizing: border-box; margin: 6px 0; padding: 8px; }
    textarea { min-height: 8rem; }
    pre { white-space: pre-wrap; background: #f4f4f4; padding: 8px; }
    .row { display: flex; gap: 8px; }
    .row > * { flex: 1; }
  </style>
</head>
<body>
  <h1>Babel Remote</h1>
  <p>Loopback ADR-010 control surface. Paste the host token. This page stores nothing in a server cookie.</p>
  <label>Token <input id="token" type="password" autocomplete="off"/></label>
  <label>Workspace root <input id="root" placeholder="registered host workspace"/></label>
  <div class="row">
    <button id="create">Create thread</button>
    <button id="stop">Stop</button>
  </div>
  <textarea id="msg" placeholder="Paste the full prompt. Do not type it through remote desktop."></textarea>
  <button id="send">Send</button>
  <pre id="log"></pre>
  <script>
    const log = (t) => { const el = document.getElementById('log'); el.textContent += t + '\\n'; };
    let threadId = null;
    const headers = () => ({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + document.getElementById('token').value
    });
    async function rpc(method, params, id) {
      const res = await fetch('/rpc', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: id || Date.now(), method, params })
      });
      return res.json();
    }
    document.getElementById('create').onclick = async () => {
      const r = await rpc('thread.create', { project_root: document.getElementById('root').value });
      threadId = r.result && r.result.thread_id;
      log(JSON.stringify(r, null, 2));
    };
    document.getElementById('send').onclick = async () => {
      if (!threadId) { log('create a thread first'); return; }
      const r = await rpc('turn.submit', {
        thread_id: threadId,
        message: document.getElementById('msg').value,
        command_id: crypto.randomUUID()
      });
      log(JSON.stringify(r, null, 2));
    };
    document.getElementById('stop').onclick = async () => {
      if (!threadId) return;
      const r = await rpc('turn.cancel', { thread_id: threadId });
      log(JSON.stringify(r, null, 2));
    };
  </script>
</body>
</html>
`;
