import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { JsonlDecoder } from './stream.mjs';

function terminateChildTree(child) {
  if (process.platform === 'win32' && child.pid) {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkillPath = resolve(windowsRoot, 'System32', 'taskkill.exe');
    try {
      spawnSync(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 1500 });
    } catch { /* The close handler still reports the exit. */ }
  }
  try { child.kill(); } catch { /* The child may already have exited. */ }
}

/** No shell, interpolated command, automatic approval, or invented runtime flag. */
export function buildRunArgs(entry, projectRoot, {task, mode, sessionId}) {
  if (typeof entry !== 'string' || !isAbsolute(entry) || typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) throw new TypeError('CLI and project paths must be absolute');
  if (typeof task !== 'string' || !task.trim() || task.length > 24000 || task.includes('\0')) throw new TypeError('Invalid task text');
  if (!['chat', 'plan', 'deep'].includes(mode)) throw new TypeError('Invalid Babel mode');
  const args = [entry, 'run', '--mode', mode, '--project-root', projectRoot,
    '--output-format', 'stream-json', '--execution-profile', 'safe_repo'];
  if (sessionId != null && sessionId !== '') {
    if (typeof sessionId !== 'string' || !/^[\w-]{1,80}$/.test(sessionId)) throw new TypeError('Invalid chat session id');
    args.push('--resume-chat', sessionId);
  }
  args.push('--', task);
  return args;
}

/** Owns one child process, not a Babel runtime or an agent/session store. */
export class BabelChild {
  #child = null;
  constructor({executable, entry, projectRoot, env = {}, inheritEnv = true}) {
    if (!isAbsolute(executable)) throw new TypeError('The Node executable must be absolute');
    this.executable = executable; this.entry = entry; this.projectRoot = projectRoot; this.env = env; this.inheritEnv = inheritEnv;
  }
  get busy() { return this.#child !== null; }
  start(request, onPacket) {
    if (this.busy) throw new Error('A Babel child is already running');
    if (typeof request.runId !== 'string' || !/^[\w-]{1,100}$/.test(request.runId)) throw new TypeError('Invalid run ID');
    const args = buildRunArgs(this.entry, this.projectRoot, request);
    const send = packet => onPacket({runId: request.runId, ...packet});
    let stderr = ''; let stderrBytes = 0; let stdoutBytes = 0; let displayLimited = false; let errors = 0;
    const report = error => { if (errors++ < 8) send({kind:'transport-error',error}); };
    const decoder = new JsonlDecoder(event => send({kind:'event',event}), report);
    const child = spawn(this.executable, args, {
      cwd: this.projectRoot, shell: false, windowsHide: true,
      stdio: ['pipe','pipe','pipe'], env: {...(this.inheritEnv ? process.env : {}), ...this.env, BABEL_DESKTOP_IPC:'1'}
    });
    this.#child = child;
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 24 * 1024 * 1024) {
        if (!displayLimited) { displayLimited = true; report('CLI output exceeded the 24 MB display limit. The process is still running; completion will remain unverified.'); }
        return; // Continue draining; do not terminate legitimate work or infer success.
      }
      decoder.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (stderrBytes >= 32768) return;
      const remaining = 32768 - stderrBytes;
      const part = chunk.subarray(0,remaining); stderrBytes += part.length; stderr += part.toString('utf8');
    });
    child.on('error', error => report(`Could not run the selected Babel CLI: ${error.message}`));
    child.on('close', (code, signal) => {
      decoder.end();
      this.#child = null;
      // stderr may contain provider diagnostics. Never forward raw stderr, environment,
      // keys, or credentials into the renderer. The CLI's structured error is preferred.
      send({kind:'exit', code, signal, diagnosticAvailable:stderr.length > 0, displayLimited});
      stderr = '';
    });
  }
  reply(decision) {
    if (!this.#child?.stdin || this.#child.stdin.destroyed) return;
    if (decision !== 'allow_once' && decision !== 'deny') return;
    this.#child.stdin.write(`${JSON.stringify({ decision })}\n`);
  }
  whenIdle(callback) {
    if (typeof callback !== 'function') return;
    if (!this.#child) { callback(); return; }
    this.#child.once('close', callback);
  }
  cancel() {
    const child = this.#child;
    if (!child || child.desktopCancelling) return;
    child.desktopCancelling = true;
    let wrote = false;
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ decision: 'cancel' })}\n`);
        wrote = true;
      }
    } catch { /* The tree kill below is the backstop. */ }
    if (!wrote) {
      terminateChildTree(child);
      return;
    }
    const timer = setTimeout(() => {
      if (this.#child === child) terminateChildTree(child);
    }, 1500);
    child.once('close', () => clearTimeout(timer));
  }
}
