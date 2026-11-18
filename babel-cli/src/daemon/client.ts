/**
 * daemon/client.ts — Client-side IPC and auto-spawn
 *
 * Connects to the daemon via the platform IPC path, sends requests,
 * reads responses. Provides auto-spawn: if the daemon isn't running,
 * starts it as a child process and polls until ready.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcRequest } from './ipc.js';
import { attachDaemonDiagnosticStream, createDaemonStartupDiagnostics } from './diagnosticStream.js';
import {
  DAEMON_DIR,
  DAEMON_PID_FILE,
  DAEMON_AUTO_SPAWN_TIMEOUT_MS,
  DAEMON_POLL_INTERVAL_MS,
  DAEMON_PROTOCOL_VERSION,
} from './constants.js';

// ── Health probe ─────────────────────────────────────────────────────────────

export interface DaemonPingResult {
  alive: true;
  version: number;
  uptime: number;
  pid: number;
}

/**
 * Ping the daemon. Returns health info on success, throws on failure.
 */
export async function pingDaemon(): Promise<DaemonPingResult> {
  const result = await ipcRequest('ping', undefined, { timeoutMs: 2000 });
  return result as DaemonPingResult;
}

// ── Auto-spawn ───────────────────────────────────────────────────────────────

let spawnPromise: Promise<void> | null = null;
let ownedDaemon: ChildProcess | null = null;
export interface DaemonClientOptions {
  onDiagnostic?: (channel: 'stdout' | 'stderr' | 'status', message: string) => void;
  /** Test/qualification seam; production callers always use node:child_process.spawn. */
  spawnProcess?: typeof spawn;
}

/**
 * Ensure the daemon is running. If not, spawn it and wait for readiness.
 * Idempotent — concurrent callers share the same spawn promise.
 */
export async function ensureDaemon(options: DaemonClientOptions = {}): Promise<void> {
  // Fast path: already running
  try {
    await pingDaemon();
    return;
  } catch {
    /* not running — spawn it */
  }

  // Serialize spawn attempts
  if (!spawnPromise) {
    spawnPromise = daemonAutoSpawn(options);
  }
  try {
    await spawnPromise;
  } finally {
    spawnPromise = null;
  }
}

/**
 * Spawn the daemon as a child process and poll until it responds to ping.
 */
export async function daemonAutoSpawn(options: DaemonClientOptions = {}): Promise<void> {
  // Check if already running (race condition guard)
  try {
    await pingDaemon();
    return; // another caller already started it
  } catch {
    /* continue */
  }

  const daemonMain = resolveDaemonMain();
  // Daemon lifecycle notices are diagnostics. They must never share stdout
  // with a command's machine-readable envelope (`--json`), and a background
  // daemon must not keep this CLI's event loop alive after the request settles.
  const diagnostic = options.onDiagnostic ?? ((_channel: 'stdout' | 'stderr' | 'status', message: string) => {
    process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  });
  const startupDiagnostics = createDaemonStartupDiagnostics(diagnostic);
  diagnostic('status', `[daemon] Auto-spawning daemon: ${daemonMain}`);

  const isBun = typeof (process as any).versions?.bun !== 'undefined';
  const execPath = isBun ? 'bun' : process.execPath;
  const isTs = daemonMain.endsWith('.ts');
  const spawnArgs = !isBun && isTs ? ['--import', 'tsx', daemonMain] : [daemonMain];

  const interactive = typeof options.onDiagnostic === 'function';
  const daemonLogPath = join(DAEMON_DIR, 'daemon.log');
  const failureDetail = (message: string): string => interactive ? message : `${message}\nDaemon log: ${daemonLogPath}`;
  let logFd: number | undefined;
  if (!interactive) {
    try {
      mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 });
      logFd = openSync(daemonLogPath, 'a', 0o600);
    } catch { logFd = undefined; }
  }
  const child: ChildProcess = (options.spawnProcess ?? spawn)(execPath, spawnArgs, interactive
    ? { cwd: resolvePackageRoot(), stdio: 'pipe', detached: false, windowsHide: true }
    : { cwd: resolvePackageRoot(), stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'], detached: true, windowsHide: true });
  if (logFd !== undefined) { try { closeSync(logFd); } catch { /* owned by the child now */ } }

  ownedDaemon = child;
  let spawnError = '';
  child.once('exit', () => { if (ownedDaemon === child) ownedDaemon = null; });

  if (interactive) {
    attachDaemonDiagnosticStream(child.stdout, 'stdout', startupDiagnostics.receive);
    attachDaemonDiagnosticStream(child.stderr, 'stderr', startupDiagnostics.receive);
    child.on('error', (err) => {
      startupDiagnostics.receive('stderr', `[daemon] Failed to spawn daemon process: ${err.message}`);
    });
  } else {
    // The daemon is intentionally detached: it outlives this CLI, owns no
    // inherited pipes, and cannot hold the foreground process open. Its output
    // is retained in the daemon directory instead of the caller's stdout.
    child.on('error', (err) => {
      spawnError = `[daemon] Failed to spawn daemon process: ${err.message}`;
    });
    child.unref();
  }

  // Poll until daemon responds
  const deadline = Date.now() + DAEMON_AUTO_SPAWN_TIMEOUT_MS;
  let lastError = '';

  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS);

    if (spawnError) {
      if (ownedDaemon === child) ownedDaemon = null;
      throw new Error(startupDiagnostics.failureMessage(failureDetail(spawnError)));
    }

    // Check if child process died
    if (child.exitCode !== null) {
      throw new Error(
        startupDiagnostics.failureMessage(failureDetail(`Daemon process exited with code ${child.exitCode} during startup.`)),
      );
    }

    try {
      const ping = await pingDaemon();
      if (ping.alive && ping.version === DAEMON_PROTOCOL_VERSION) {
        diagnostic('status', `[daemon] Auto-spawned daemon ready. PID: ${ping.pid}`);
        return;
      }
    } catch {
      lastError = 'not yet responding';
    }
  }

  // A worker that never became healthy must not be left as an unowned process.
  if (ownedDaemon === child) {
    ownedDaemon = null;
    try { child.kill(); } catch { /* already exited */ }
  }
  throw new Error(
    startupDiagnostics.failureMessage(failureDetail(`Daemon failed to start within ${DAEMON_AUTO_SPAWN_TIMEOUT_MS}ms. Last status: ${lastError || 'unknown'}`)),
  );
}

/** Stop only the daemon spawned by this process, preserving external daemons. */
export async function stopOwnedDaemon(): Promise<void> {
  if (spawnPromise) {
    try { await spawnPromise; } catch { /* failed startup still needs cleanup */ }
  }
  const child = ownedDaemon;
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    const deadline = setTimeout(() => reject(new Error('Owned daemon did not exit within 3000ms')), 3000);
    child.once('exit', () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
    child.kill('SIGTERM');
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isRunningInDaemon(): boolean {
  if (process.env['BABEL_DAEMON'] !== 'true') return false;
  try {
    const pidFile = DAEMON_PID_FILE;
    if (!existsSync(pidFile)) return false;
    const daemonPid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    return process.pid === daemonPid;
  } catch {
    return false;
  }
}

function resolveDaemonMain(): string {
  const packageRoot = resolvePackageRoot();
  const distPath = join(packageRoot, 'dist', 'daemon', 'main.js');
  if (existsSync(distPath)) {
    return distPath;
  }
  return join(packageRoot, 'src', 'daemon', 'main.ts');
}

function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Legacy helpers (reused by daemon.ts) ─────────────────────────────────────

/**
 * Check if the daemon is running by looking at the PID file and
 * verifying the process is alive. Does NOT use IPC (works even if
 * the daemon is hung but the PID is alive).
 */
export function isDaemonRunningByPid(): boolean {
  if (!existsSync(DAEMON_PID_FILE)) return false;
  try {
    const pid = Number.parseInt(readFileSync(DAEMON_PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
