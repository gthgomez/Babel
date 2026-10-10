import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

/** Build argv for `babel remote serve` without shell interpolation. */
export function buildRemoteServeArgs(entry, projectRoot, { port = 4545 } = {}) {
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

/**
 * Owns one loopback `babel remote serve` child — the shared protocol host for Desktop + phone.
 */
export class RemoteBridgeChild {
  #child = null;
  #port = null;

  constructor({ executable, entry, projectRoot, env = {}, inheritEnv = true }) {
    if (!isAbsolute(executable)) throw new TypeError('The Node executable must be absolute');
    this.executable = executable;
    this.entry = entry;
    this.projectRoot = projectRoot;
    this.env = env;
    this.inheritEnv = inheritEnv;
  }

  get running() {
    return this.#child !== null;
  }

  get port() {
    return this.#port;
  }

  start({ port = 4545, onLine } = {}) {
    if (this.running) throw new Error('Remote bridge is already running');
    const args = buildRemoteServeArgs(this.entry, this.projectRoot, { port });
    const child = spawn(this.executable, args, {
      cwd: this.projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(this.inheritEnv ? process.env : {}), ...this.env },
    });
    this.#child = child;
    this.#port = port;
    const report = (chunk, stream) => {
      const text = chunk.toString('utf8');
      if (typeof onLine === 'function') onLine({ stream, text });
    };
    child.stdout.on('data', chunk => report(chunk, 'stdout'));
    child.stderr.on('data', chunk => report(chunk, 'stderr'));
    child.on('close', () => {
      this.#child = null;
      this.#port = null;
    });
    return { port };
  }

  stop() {
    if (!this.#child) return;
    try {
      this.#child.kill();
    } catch {
      /* already exited */
    }
    this.#child = null;
    this.#port = null;
  }
}
