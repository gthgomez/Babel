/**
 * Renderer-side IPC contracts for shared-session Electron acceptance.
 * Every babelDesktop method that returns ipcRenderer.invoke(...) must be awaited
 * inside page.evaluate before reading properties.
 */

/** Trust project; returns normalized authority snapshot for assertions. */
export const EVAL_TRUST_PROJECT = async () => {
  const bd = window.babelDesktop;
  if (!bd?.trustProject) throw new Error('babelDesktop.trustProject missing');
  const info = await bd.trustProject();
  const authority = info?.projectAuthority;
  return {
    trusted: authority?.trusted === true,
    scope: authority?.scope ?? null,
    reason: authority?.reason ?? null,
  };
};

/** Start shared remote bridge on loopback port. */
export const EVAL_START_REMOTE_BRIDGE = async (port) => {
  const bd = window.babelDesktop;
  if (!bd?.startRemoteBridge) throw new Error('babelDesktop.startRemoteBridge missing');
  const result = await bd.startRemoteBridge({ port });
  return result ?? null;
};

/** Read remoteBridge slice from getInfo(). */
export const EVAL_GET_REMOTE_BRIDGE = async () => {
  const bd = window.babelDesktop;
  if (!bd?.getInfo) throw new Error('babelDesktop.getInfo missing');
  const info = await bd.getInfo();
  const bridge = info?.remoteBridge ?? null;
  return bridge
    ? {
        running: bridge.running === true,
        sharedSession: bridge.sharedSession === true,
        state: bridge.state ?? null,
        port: bridge.port ?? null,
      }
    : null;
};

/**
 * Run one shared-session turn; resolves on run_complete for matching runId.
 * Awaits babelDesktop.run() before asserting started.
 */
export const EVAL_RUN_SHARED_TURN = async ({ runId, task, sessionId }) => {
  const bd = window.babelDesktop;
  if (!bd?.run || !bd?.onEvent) throw new Error('babelDesktop.run/onEvent missing');

  return await new Promise((resolve, reject) => {
    const seen = [];
    const timeout = setTimeout(() => {
      reject(new Error(`run ${runId} missing terminal event; seen=${JSON.stringify(seen)}`));
    }, 25_000);

    const unsubscribe = bd.onEvent((packet) => {
      if (packet.runId !== runId) return;
      const eventType = packet.event?.type ?? packet.kind;
      seen.push(eventType);
      if (packet.event?.type === 'run_complete') {
        clearTimeout(timeout);
        unsubscribe();
        resolve({ result: packet.event.result, seen });
      }
      if (packet.event?.type === 'run_error') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(String(packet.event.error ?? 'run_error')));
      }
      if (packet.kind === 'exit' && packet.code !== 0) {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(`host-run child exit code ${packet.code}`));
      }
    });

    void bd
      .run({
        runId,
        task,
        mode: 'chat',
        ...(sessionId ? { sessionId } : {}),
      })
      .then((started) => {
        if (!started?.started) {
          clearTimeout(timeout);
          unsubscribe();
          reject(new Error(`run ${runId} was not started by the host: ${JSON.stringify(started)}`));
        }
      })
      .catch((error) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      });
  });
};
