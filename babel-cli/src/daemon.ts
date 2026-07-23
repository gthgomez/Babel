/**
 * daemon.ts — Babel background daemon (public API)
 *
 * Phase 4A: Delegates to daemon/ modules for IPC transport, job queue
 * consumption, and auto-spawn. This file preserves the public API used
 * by coreCommands.ts while the implementation lives in daemon/.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BABEL_RUNS_DIR } from './cli/constants.js';
import { pingDaemon, ensureDaemon, isDaemonRunningByPid } from './daemon/client.js';
import { DAEMON_PID_FILE, DAEMON_DIR } from './daemon/constants.js';

const DAEMON_QUEUE_FILE = join(BABEL_RUNS_DIR, 'daemon', 'queue.json');

// ── Public types (unchanged for backward compat) ───────────────────────────

export interface DaemonTask {
  id: string;
  task: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  runDir?: string;
}

export interface DaemonStatus {
  pid: number;
  running: boolean;
  uptime: number;
  queueSize: number;
  activeTask: string | null;
}

function ensureDaemonDir(): void {
  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true });
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export function isDaemonRunning(): boolean {
  // Try IPC ping first (most reliable), fall back to PID file check
  return isDaemonRunningByPid();
}

export async function startDaemon(): Promise<void> {
  if (isDaemonRunning()) {
    console.log('Daemon is already running.');
    return;
  }

  ensureDaemonDir();

  try {
    await ensureDaemon();
  } catch (err: any) {
    console.error(`Failed to start daemon: ${err.message}`);
    throw err;
  }
}

export function stopDaemon(): void {
  ensureDaemonDir();

  // Try graceful shutdown via IPC
  import('./daemon/ipc.js').then(({ ipcRequest }) => {
    ipcRequest('shutdown', undefined, { timeoutMs: 2000 }).catch(() => {
      /* daemon may already be gone */
    });
  });

  // Also clean up PID file synchronously
  if (existsSync(DAEMON_PID_FILE)) {
    try {
      unlinkSync(DAEMON_PID_FILE);
    } catch {
      /* ignore if already removed */
    }
  }
  console.log('Daemon stopped.');
}

export function getDaemonStatus(): DaemonStatus {
  const running = isDaemonRunning();
  let queue: DaemonTask[] = [];
  try {
    if (existsSync(DAEMON_QUEUE_FILE)) {
      queue = JSON.parse(readFileSync(DAEMON_QUEUE_FILE, 'utf-8')) as DaemonTask[];
    }
  } catch {
    /* ignore */
  }

  const activeTask = queue.find((t) => t.status === 'running');
  let uptime = 0;
  if (running && existsSync(DAEMON_PID_FILE)) {
    try {
      uptime = Math.floor((Date.now() - statSync(DAEMON_PID_FILE).mtimeMs) / 1000);
    } catch {
      /* ignore */
    }
  }

  let pid = 0;
  if (running && existsSync(DAEMON_PID_FILE)) {
    try {
      pid = Number.parseInt(readFileSync(DAEMON_PID_FILE, 'utf-8').trim(), 10);
    } catch {
      /* ignore */
    }
  }

  return {
    pid,
    running,
    uptime,
    queueSize: queue.length,
    activeTask: activeTask?.id ?? null,
  };
}

// ── Task enqueue ───────────────────────────────────────────────────────────

export function enqueueBackgroundTask(task: string): DaemonTask {
  ensureDaemonDir();
  const queue = existsSync(DAEMON_QUEUE_FILE)
    ? (JSON.parse(readFileSync(DAEMON_QUEUE_FILE, 'utf-8')) as DaemonTask[])
    : [];

  const daemonTask: DaemonTask = {
    id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task,
    status: 'queued',
    createdAt: new Date().toISOString(),
  };

  queue.push(daemonTask);
  writeFileSync(DAEMON_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');

  return daemonTask;
}
