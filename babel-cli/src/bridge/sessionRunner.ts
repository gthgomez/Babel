/**
 * Session lifecycle management for the Babel IDE Bridge.
 *
 * SessionRunner maintains a registry of active bridge sessions and manages
 * their lifecycle: creation, child process spawning, heartbeat monitoring,
 * crash detection, and cleanup.
 *
 * Phase 1 — Infrastructure for session management with child process
 * abstraction. The child process communication uses NDJSON framing
 * over stdin/stdout.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  BridgeMessage,
  BridgeSession,
  BridgeTransport,
  SessionRegistryEntry,
} from './types.js';
import { encodeNdjson, tryParseNdjson } from './transport.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Heartbeat interval in milliseconds (30s). */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Crash-detection timeout: if no heartbeat from child for this long, mark crashed. */
const CRASH_DETECTION_TIMEOUT_MS = 90_000;

/** How often to check for stale sessions. */
const STALE_CHECK_INTERVAL_MS = 60_000;

/** Idle timeout: sessions inactive for this long are auto-terminated. */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Max stderr lines to buffer for crash diagnostics. */
const MAX_STDERR_LINES = 50;

/** Directory for bridge session pointer files. */
function getSessionsDir(): string {
  return join(homedir(), '.babel', 'bridge', 'sessions');
}

// ─── Pointer file helpers ──────────────────────────────────────────────────────

interface SessionPointer {
  sessionId: string;
  projectRoot: string;
  createdAt: string;
  lastActiveAt: string;
  status: string;
}

function getPointerPath(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.json`);
}

function writePointer(pointer: SessionPointer): void {
  const dir = getSessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  try {
    writeFileSync(getPointerPath(pointer.sessionId), JSON.stringify(pointer, null, 2), 'utf-8');
  } catch {
    // Best-effort — pointer is a recovery aid, not critical
  }
}

function readPointer(sessionId: string): SessionPointer | null {
  const path = getPointerPath(sessionId);
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as SessionPointer;
  } catch {
    return null;
  }
}

function clearPointer(sessionId: string): void {
  try {
    const path = getPointerPath(sessionId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort
  }
}

// ─── SessionRunner ─────────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of all bridge sessions.
 *
 * Responsibilities:
 *   - Create and register sessions
 *   - Spawn child CLI processes for session execution
 *   - Route NDJSON messages between transports and child processes
 *   - Detect crashes and timeouts
 *   - Manage crash-recovery pointer files
 *   - Heartbeat monitoring
 */
export class SessionRunner {
  /** In-memory session registry. */
  private readonly sessions = new Map<string, SessionRegistryEntry>();

  /** Stale-check interval handle. */
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Callback for session lifecycle events. */
  private onSessionEvent:
    | ((event: { type: string; sessionId: string; data?: unknown }) => void)
    | null = null;

  constructor() {
    this.startStaleCheck();
  }

  // ── Session lifecycle callbacks ──────────────────────────────────────────

  /**
   * Register a listener for session lifecycle events.
   * Currently supported event types: 'created', 'updated', 'removed', 'crashed'.
   */
  onEvent(
    handler: (event: { type: string; sessionId: string; data?: unknown }) => void,
  ): void {
    this.onSessionEvent = handler;
  }

  // ── Session CRUD ───────────────────────────────────────────────────────────

  /**
   * Create a new session and register it in the registry.
   *
   * @param projectRoot - The working directory for the session.
   * @param transport - The client transport (optional, can be attached later).
   * @returns The newly created session.
   */
  createSession(
    projectRoot: string,
    transport?: BridgeTransport,
  ): BridgeSession {
    const sessionId = `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date();
    const session: BridgeSession = {
      sessionId,
      projectRoot,
      createdAt: now,
      lastActiveAt: now,
      status: 'idle',
      transport: 'inproc',
    };

    this.sessions.set(sessionId, {
      session,
      ...(transport !== undefined ? { clientTransport: transport } : {}),
      abortController: new AbortController(),
      lastActivityMs: Date.now(),
    });

    // Write crash-recovery pointer
    writePointer({
      sessionId,
      projectRoot,
      createdAt: now.toISOString(),
      lastActiveAt: now.toISOString(),
      status: 'idle',
    });

    this.emitEvent('created', sessionId, { session });
    return session;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): BridgeSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /**
   * List all active sessions.
   */
  listSessions(): BridgeSession[] {
    const result: BridgeSession[] = [];
    for (const entry of this.sessions.values()) {
      result.push(entry.session);
    }
    return result;
  }

  /**
   * Remove and clean up a session.
   *
   * @param sessionId - The session to remove.
   * @param reason - Optional reason for removal.
   */
  removeSession(sessionId: string, reason?: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // Abort any running child process
    entry.abortController.abort();
    if (entry.childProcess) {
      try {
        // Use child.kill() which handles platform differences
        // (SIGTERM on Unix, TerminateProcess on Windows)
        entry.childProcess.kill();
      } catch {
        // Process may already be dead
      }
    }

    // Close the client transport
    entry.clientTransport?.close();

    // Close the readline interface to release internal listeners and buffers
    entry.readline?.close();

    // Clear pointer
    clearPointer(sessionId);

    this.sessions.delete(sessionId);
    this.emitEvent('removed', sessionId, { reason });
  }

  /**
   * Update a session's metadata (status, lastActiveAt, etc.).
   */
  updateSession(
    sessionId: string,
    updates: Partial<Pick<BridgeSession, 'status' | 'transport'>>,
  ): BridgeSession | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    const session = entry.session;
    if (updates.status !== undefined) session.status = updates.status;
    if (updates.transport !== undefined) session.transport = updates.transport;
    session.lastActiveAt = new Date();
    entry.lastActivityMs = Date.now();

    // Update pointer
    writePointer({
      sessionId: session.sessionId,
      projectRoot: session.projectRoot,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      status: session.status,
    });

    this.emitEvent('updated', sessionId, { session });
    return session;
  }

  /**
   * Attach a client transport to an existing session.
   */
  attachTransport(sessionId: string, transport: BridgeTransport): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    entry.clientTransport = transport;
    entry.session.lastActiveAt = new Date();
    entry.lastActivityMs = Date.now();

    // Route child stdout/NDJSON to the transport
    const messageHandler = transport.onMessage((msg: BridgeMessage) => {
      this.handleClientMessage(sessionId, msg);
    });

    // Keep reference for cleanup
    (transport as unknown as Record<string, unknown>)['_babelCleanup'] = messageHandler;

    return true;
  }

  // ── Child process management ─────────────────────────────────────────────

  /**
   * Spawn a Babel child process for a session.
   *
   * In Phase 1, this is a placeholder that spawns a long-running process
   * and communicates via NDJSON over stdin/stdout. The `--bridge` flag
   * tells the child it's in bridge mode.
   *
   * @param sessionId - The session to associate with the child process.
   * @param execPath - Path to the Babel CLI executable (e.g., 'babel' or 'node').
   * @param args - Additional arguments to pass to the child process.
   *
   * @returns The child process reference, or undefined if the session doesn't exist.
   */
  spawnChild(
    sessionId: string,
    execPath: string,
    args?: string[],
  ): ChildProcess | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    const childArgs = [
      ...(args ?? []),
      '--bridge',
      '--session-id', sessionId,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
    ];

    const child = spawn(execPath, childArgs, {
      cwd: entry.session.projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    entry.session.status = 'running';
    if (child.pid !== undefined) {
      entry.childPid = child.pid;
    }
    entry.childProcess = child;

    // Buffer stderr for crash diagnostics
    const stderrLines: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        stderrLines.push(line);
        if (stderrLines.length > MAX_STDERR_LINES) {
          stderrLines.shift();
        }
      }
    });

    // Parse NDJSON from child stdout
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      entry.readline = rl;
      rl.on('line', (line: string) => {
        if (entry.abortController.signal.aborted) return;

        const parsed = tryParseNdjson(line + '\n');
        if (!parsed) return;

        const msg = parsed.message;
        // Forward non-error system messages to the client transport
        if (msg.type !== 'error' || msg.sessionId) {
          entry.clientTransport?.send(msg);
        }

        // Update activity timestamp
        entry.lastActivityMs = Date.now();
        entry.session.lastActiveAt = new Date();
      });
    }

    // Handle child exit
    child.on('exit', (code, signal) => {
      if (entry.abortController.signal.aborted) return; // intentional teardown

      entry.session.status = 'crashed';
      writePointer({
        sessionId: entry.session.sessionId,
        projectRoot: entry.session.projectRoot,
        createdAt: entry.session.createdAt.toISOString(),
        lastActiveAt: entry.session.lastActiveAt.toISOString(),
        status: 'crashed',
      });

      const data = {
        code,
        signal,
        stderr: stderrLines.slice(-10).join('\n'),
      };
      this.emitEvent('crashed', sessionId, data);
    });

    child.on('error', (err: Error) => {
      // OS-level spawn failure (ENOENT, EACCES, etc.) — 'exit' does NOT fire
      // for these, only 'error'. Mark the session as crashed so it's detectable.
      entry.session.status = 'crashed';
      writePointer({
        sessionId: entry.session.sessionId,
        projectRoot: entry.session.projectRoot,
        createdAt: entry.session.createdAt.toISOString(),
        lastActiveAt: entry.session.lastActiveAt.toISOString(),
        status: 'crashed',
      });
      this.emitEvent('crashed', sessionId, {
        reason: 'spawn failed',
        error: err.message,
      });
    });

    return child;
  }

  /**
   * Echo a BridgeMessage back to the client transport.
   *
   * In Phase 1 the child process lifecycle is managed externally, so
   * messages are echoed to the client rather than forwarded to a child.
   *
   * TODO(feat/lsp-memory-bridge): implement child stdin forwarding when
   *   the child process communication layer is ready. This should write
   *   NDJSON-framed messages to the child's stdin pipe.
   *
   * @param sessionId - The target session.
   * @param message - The message to echo.
   * @returns true if the message was written, false if the session is gone.
   */
  echoToClient(sessionId: string, message: BridgeMessage): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    entry.clientTransport?.send(message);
    return true;
  }

  // ── Heartbeat & Crash detection ──────────────────────────────────────────

  /**
   * Start heartbeat monitoring for all sessions.
   * Checks for stale sessions and marks them as crashed if no activity.
   */
  private startStaleCheck(): void {
    this.staleCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, entry] of this.sessions.entries()) {
        // Skip sessions with active child process
        if (entry.childPid !== undefined) continue;

        const idleMs = now - entry.lastActivityMs;
        if (idleMs > CRASH_DETECTION_TIMEOUT_MS && entry.session.status === 'running') {
          entry.session.status = 'crashed';
          this.emitEvent('crashed', sessionId, { reason: 'heartbeat timeout' });
        }

        // Auto-terminate idle sessions
        if (idleMs > SESSION_IDLE_TIMEOUT_MS && entry.session.status === 'idle') {
          this.removeSession(sessionId, 'idle timeout');
        }
      }
    }, STALE_CHECK_INTERVAL_MS);

    if (this.staleCheckTimer && typeof this.staleCheckTimer === 'object' && 'unref' in this.staleCheckTimer) {
      (this.staleCheckTimer as NodeJS.Timeout).unref();
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * Handle an incoming message from a client transport.
   * Routes prompts to the session router and updates activity timestamps.
   */
  private handleClientMessage(sessionId: string, msg: BridgeMessage): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    entry.lastActivityMs = Date.now();
    entry.session.lastActiveAt = new Date();

    // In Phase 1, the message is echoed back as confirmation.
    // In later phases, this forwards the message to the child process
    // and routes the response back to the transport.
    switch (msg.type) {
      case 'prompt':
        this.echoToClient(sessionId, {
          type: 'prompt',
          text: msg.text,
          sessionId,
        });
        break;
      default:
        // Forward other messages to client
        this.echoToClient(sessionId, msg);
        break;
    }
  }

  /**
   * Emit a lifecycle event to the registered handler.
   */
  private emitEvent(
    type: string,
    sessionId: string,
    data?: unknown,
  ): void {
    this.onSessionEvent?.({ type, sessionId, data });
  }

  /**
   * Clean shutdown of all sessions.
   */
  shutdown(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    const sessionIds = [...this.sessions.keys()];
    for (const id of sessionIds) {
      this.removeSession(id, 'shutdown');
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────

/** Global session runner instance. */
export const sessionRunner = new SessionRunner();
