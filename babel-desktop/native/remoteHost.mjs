import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

const LISTENING_RE = /Babel Remote listening on http:\/\/127\.0\.0\.1:(\d+)/;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 2_000;

function terminateChildTree(child) {
  if (process.platform === 'win32' && child.pid) {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkillPath = resolve(windowsRoot, 'System32', 'taskkill.exe');
    try {
      spawnSync(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore', timeout: 1500});
    } catch {
      /* close handler still reports exit */
    }
  }
  try {
    child.kill();
  } catch {
    /* already exited */
  }
}

/** Build argv for `babel remote serve` without shell interpolation. */
export function buildRemoteServeArgs(entry, projectRoot, {port = 4545} = {}) {
  if (typeof entry !== 'string' || !isAbsolute(entry)) throw new TypeError('CLI entry must be an absolute path');
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new TypeError('Project root must be an absolute path');
  }
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
    throw new TypeError('Invalid remote listen port');
  }
  return [entry, 'remote', 'serve', '--port', String(listenPort), '--project', projectRoot];
}

async function waitForBridgeHealth(port, {timeoutMs = DEFAULT_READY_TIMEOUT_MS} = {}) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(1500)});
      if (response.ok) return true;
    } catch {
      /* retry until deadline */
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Owns one loopback `babel remote serve` child — the shared protocol host for Desktop + phone.
 */
export class RemoteBridgeChild {
  #child = null;
  #port = null;
  #state = 'stopped';
  #generation = 0;
  #stopTimer = null;

  constructor({executable, entry, projectRoot, env = {}, inheritEnv = true}) {
    if (!isAbsolute(executable)) throw new TypeError('The Node executable must be absolute');
    this.executable = executable;
    this.entry = entry;
    this.projectRoot = projectRoot;
    this.env = env;
    this.inheritEnv = inheritEnv;
  }

  get state() {
    return this.#state;
  }

  get running() {
    return this.#state === 'starting' || this.#state === 'ready';
  }

  get port() {
    return this.#port;
  }

  async start({port = 4545, onLine, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS} = {}) {
    if (this.running) throw new Error('Remote bridge is already running');
    const generation = ++this.#generation;
    this.#state = 'starting';
    this.#port = port;

    const child = spawn(this.executable, buildRemoteServeArgs(this.entry, this.projectRoot, {port}), {
      cwd: this.projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...(this.inheritEnv ? process.env : {}), ...this.env, BABEL_DESKTOP_IPC: '1'},
    });
    this.#child = child;

    let listenPort = port;
    const onStdout = chunk => {
      const text = chunk.toString('utf8');
      if (typeof onLine === 'function') onLine({stream: 'stdout', text});
      const match = text.match(LISTENING_RE);
      if (match?.[1]) listenPort = Number(match[1]);
    };
    const onStderr = chunk => {
      if (typeof onLine === 'function') onLine({stream: 'stderr', text: chunk.toString('utf8')});
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    const earlyExit = new Promise((_, reject) => {
      child.once('error', error => {
        reject(new Error(`Could not start remote bridge: ${error.message}`));
      });
      child.once('close', (code, signal) => {
        reject(new Error(`Remote bridge exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      });
    });

    try {
      const ready = await Promise.race([
        waitForBridgeHealth(listenPort, {timeoutMs: readyTimeoutMs}).then(ok => {
          if (!ok) throw new Error(`Remote bridge did not become ready on port ${listenPort}`);
          return true;
        }),
        earlyExit,
      ]);
      if (!ready || generation !== this.#generation) {
        throw new Error('Remote bridge start was superseded');
      }
      child.removeAllListeners('close');
      child.removeAllListeners('error');
      child.on('close', () => {
        if (generation !== this.#generation) return;
        this.#resetChild();
        this.#state = 'stopped';
      });
      this.#state = 'ready';
      this.#port = listenPort;
      return {port: listenPort, url: `http://127.0.0.1:${listenPort}`, uiPath: '/ui'};
    } catch (error) {
      if (generation === this.#generation) {
        this.#state = 'failed';
        terminateChildTree(child);
        this.#resetChild();
      }
      throw error;
    } finally {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
    }
  }

  stop() {
    if (this.#stopTimer) {
      clearTimeout(this.#stopTimer);
      this.#stopTimer = null;
    }
    if (!this.#child) {
      this.#state = 'stopped';
      this.#port = null;
      return;
    }
    this.#state = 'stopping';
    this.#generation += 1;
    const child = this.#child;
    terminateChildTree(child);
    this.#stopTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }, STOP_GRACE_MS);
    child.once('close', () => {
      if (this.#stopTimer) {
        clearTimeout(this.#stopTimer);
        this.#stopTimer = null;
      }
      this.#resetChild();
      this.#state = 'stopped';
    });
  }

  #resetChild() {
    this.#child = null;
    this.#port = null;
  }
}
