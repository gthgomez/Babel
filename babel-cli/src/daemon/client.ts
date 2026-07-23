/**
 * daemon/client.ts — Client-side IPC and auto-spawn
 *
 * Connects to the daemon via the platform IPC path, sends requests,
 * reads responses. Provides auto-spawn: if the daemon isn't running,
 * starts it as a child process and polls until ready.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcRequest } from './ipc.js';
import {
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

/**
 * Ensure the daemon is running. If not, spawn it and wait for readiness.
 * Idempotent — concurrent callers share the same spawn promise.
 */
export async function ensureDaemon(): Promise<void> {
  // Fast path: already running
  try {
    await pingDaemon();
    return;
  } catch {
    /* not running — spawn it */
  }

  // Serialize spawn attempts
  if (!spawnPromise) {
    spawnPromise = daemonAutoSpawn();
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
export async function daemonAutoSpawn(): Promise<void> {
  // Check if already running (race condition guard)
  try {
    await pingDaemon();
    return; // another caller already started it
  } catch {
    /* continue */
  }

  const daemonMain = resolveDaemonMain();
  console.log(`[daemon] Auto-spawning daemon: ${daemonMain}`);

  const isBun = typeof (process as any).versions?.bun !== 'undefined';
  const execPath = isBun ? 'bun' : process.execPath;
  const isTs = daemonMain.endsWith('.ts');
  const spawnArgs = !isBun && isTs ? ['--import', 'tsx', daemonMain] : [daemonMain];

  const child: ChildProcess = spawn(execPath, spawnArgs, {
    cwd: resolvePackageRoot(),
    stdio: 'pipe',
    detached: false,
  });

  // Forward daemon stdout/stderr to parent for visibility
  child.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(data);
  });
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data);
  });

  child.on('error', (err) => {
    console.error(`[daemon] Failed to spawn daemon process: ${err.message}`);
  });

  // Poll until daemon responds
  const deadline = Date.now() + DAEMON_AUTO_SPAWN_TIMEOUT_MS;
  let lastError = '';

  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS);

    // Check if child process died
    if (child.exitCode !== null) {
      throw new Error(
        `Daemon process exited with code ${child.exitCode} during startup. ` +
          `Check daemon output above for errors.`,
      );
    }

    try {
      const ping = await pingDaemon();
      if (ping.alive && ping.version === DAEMON_PROTOCOL_VERSION) {
        console.log(`[daemon] Auto-spawned daemon ready. PID: ${ping.pid}`);
        return;
      }
    } catch {
      lastError = 'not yet responding';
    }
  }

  throw new Error(
    `Daemon failed to start within ${DAEMON_AUTO_SPAWN_TIMEOUT_MS}ms. ` +
      `Last status: ${lastError || 'unknown'}`,
  );
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
