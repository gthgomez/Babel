import { loopbackProtocolHeaders } from './sharedSessionBridge.mjs';

function mapTurnEventToCliEvent(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'answer_chunk':
      return { type: 'assistant_chunk', chunk: event.text ?? '' };
    case 'thought':
    case 'thinking':
      return { type: 'thought', line: event.text ?? '' };
    case 'done':
      return {
        type: 'run_complete',
        result: {
          answer: event.answer,
          usage: event.usage,
          terminal_outcome: event.outcome ?? 'COMPLETED',
          user_status: event.status ?? 'completed',
        },
      };
    case 'failed':
      return { type: 'run_error', error: event.error ?? 'Turn failed' };
    case 'cancelled':
      return { type: 'cancelled' };
    default:
      return null;
  }
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload?.error?.message ??
      payload?.message ??
      `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function rpc(baseUrl, headers, method, params, id) {
  const payload = await postJson(`${baseUrl}/rpc`, headers, {
    jsonrpc: '2.0',
    id,
    method,
    params,
  });
  if (payload?.error) {
    throw new Error(payload.error.message ?? String(payload.error.code ?? 'rpc_error'));
  }
  return payload.result;
}

/**
 * Runs chat turns on the loopback shared protocol host (same executor as Remote/PWA).
 */
export class SharedProtocolRun {
  #active = false;
  #ws = null;
  #cancelled = false;

  constructor({ port, desktopClientId, projectRoot }) {
    if (!Number.isInteger(port) || port < 1024) throw new TypeError('Invalid bridge port');
    if (typeof desktopClientId !== 'string') throw new TypeError('desktopClientId is required');
    if (typeof projectRoot !== 'string' || !projectRoot) throw new TypeError('projectRoot is required');
    this.port = port;
    this.desktopClientId = desktopClientId;
    this.projectRoot = projectRoot;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.headers = () => loopbackProtocolHeaders(this.desktopClientId);
  }

  get busy() {
    return this.#active;
  }

  get awaitingApproval() {
    return false;
  }

  cancel() {
    this.#cancelled = true;
    try {
      this.#ws?.close();
    } catch {
      /* already closed */
    }
  }

  reply() {
    return false;
  }

  whenIdle(callback) {
    if (!this.#active) callback();
  }

  async start(request, onPacket) {
    if (this.#active) throw new Error('A shared protocol run is already active');
    if (request.mode !== 'chat') {
      throw new Error('Shared remote sessions support chat mode only. Stop the bridge or use a local run for other modes.');
    }
    this.#active = true;
    this.#cancelled = false;
    const send = packet => onPacket({ runId: request.runId, ...packet });
    send({ kind: 'event', event: { type: 'run_start' } });
    try {
      const session = await postJson(`${this.baseUrl}/sessions`, this.headers(), {
        projectRoot: this.projectRoot,
      });
      const sessionId = session.sessionId;
      let threadId = request.sessionId;
      if (threadId) {
        await rpc(this.baseUrl, this.headers(), 'thread.resume', {
          thread_id: threadId,
          session_id: sessionId,
        }, 1);
      } else {
        const created = await rpc(this.baseUrl, this.headers(), 'thread.create', {
          project_root: this.projectRoot,
          session_id: sessionId,
          task: request.task,
        }, 1);
        threadId = created.thread_id;
      }
      const lease = await rpc(this.baseUrl, this.headers(), 'control.acquire', {
        thread_id: threadId,
        force: false,
      }, 2);
      const ticket = await postJson(`${this.baseUrl}/ws/ticket`, this.headers(), {
        session_id: sessionId,
        thread_id: threadId,
      });
      const wsUrl = `ws://127.0.0.1:${this.port}/ws?ticket=${encodeURIComponent(ticket.ticket)}`;
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        this.#ws = ws;
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('Shared protocol WebSocket failed')));
      });
      const submitPromise = rpc(this.baseUrl, this.headers(), 'turn.submit', {
        thread_id: threadId,
        message: request.task,
        control_epoch: lease.epoch,
      }, 3);
      const ws = this.#ws;
      await new Promise((resolve, reject) => {
        const onMessage = event => {
          try {
            const message = JSON.parse(String(event.data));
            if (message.method === 'turn.event' && message.params?.event) {
              const mapped = mapTurnEventToCliEvent(message.params.event);
              if (mapped) send({ kind: 'event', event: mapped });
              if (['done', 'failed', 'cancelled'].includes(message.params.event.type)) {
                cleanup();
                resolve();
              }
            }
          } catch {
            /* ignore malformed frames */
          }
        };
        const onClose = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          ws.removeEventListener('message', onMessage);
          ws.removeEventListener('close', onClose);
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        };
        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
        submitPromise.catch(err => {
          cleanup();
          reject(err);
        });
        if (this.#cancelled) {
          cleanup();
          resolve();
        }
      });
      if (!this.#cancelled) {
        send({ kind: 'exit', code: 0 });
      }
    } catch (error) {
      send({ kind: 'event', event: { type: 'run_error', error: error.message ?? String(error) } });
      send({ kind: 'exit', code: 1 });
    } finally {
      this.#active = false;
      this.#ws = null;
    }
  }
}
