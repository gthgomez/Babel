/**
 * daemon/constants.ts — Shared constants for the Babel production daemon
 *
 * Phase 4A: IPC transport, versioning, timeouts, platform-aware paths.
 * Zero external dependencies — node:net is built-in.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BABEL_RUNS_DIR } from '../cli/constants.js';

/** Incremented on wire-protocol changes. Client rejects mismatched versions. */
export const DAEMON_PROTOCOL_VERSION = 1;

/** Platform-aware IPC path. Unix uses UDS, Windows uses localhost TCP. */
export const DAEMON_IPC_PATH = join(tmpdir(), 'babel-daemon.sock');
export const DAEMON_IPC_PORT = 49200;
export const DAEMON_IPC_HOST = '127.0.0.1';

/** Daemon runtime directory under BABEL_RUNS_DIR. */
export const DAEMON_DIR = join(BABEL_RUNS_DIR, 'daemon');

/** PID file written after IPC socket is ready. */
export const DAEMON_PID_FILE = join(DAEMON_DIR, 'daemon.pid');

/** How long the client waits for auto-spawned daemon to become responsive. */
export const DAEMON_AUTO_SPAWN_TIMEOUT_MS = 5000;

/** Poll interval during auto-spawn readiness check. */
export const DAEMON_POLL_INTERVAL_MS = 100;

/** How often the queue consumer ticks to check for new jobs. */
export const DAEMON_QUEUE_TICK_INTERVAL_MS = 2000;

/** Maximum time to wait for an active job to complete during graceful shutdown. */
export const DAEMON_SHUTDOWN_GRACE_MS = 1000;

/** Socket timeout for individual IPC connections (prevents hung clients). */
export const DAEMON_SOCKET_TIMEOUT_MS = 30_000;
