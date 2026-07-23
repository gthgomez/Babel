/**
 * TerminalRestoreGuard — RAII-style terminal state guard.
 *
 * Captures terminal state on construction and guarantees restoration on
 * cleanup, crash, or signal. Mirrors the TerminalRestoreGuard pattern from
 * codex-tui (Rust) and is a prerequisite for safe TUI development.
 *
 * Usage:
 *   // Explicit lifecycle
 *   const guard = new TerminalRestoreGuard();
 *   try { ... } finally { guard.restore(); }
 *
 *   // TypeScript 5.2+ `using` statement
 *   {
 *     using guard = new TerminalRestoreGuard();
 *     // ... TUI code that might throw ...
 *   } // guard.restore() called automatically
 *
 *   // One-shot: restore and disarm all handlers
 *   guard.disarm();
 *
 * @module terminalRestoreGuard
 */

// ── Types ───────────────────────────────────────────────────────────────────────

export interface TerminalState {
  wasRaw: boolean;
  cursorVisible: boolean;
  altScreenActive: boolean;
  mouseTrackingEnabled: boolean;
  scrollRegionSet: boolean;
}

export interface RestoreEvent {
  reason: 'normal' | 'signal' | 'exception' | 'dispose';
  timestamp: number;
}

export type RestoreCallback = (event: RestoreEvent) => void;

// ── Constants ───────────────────────────────────────────────────────────────────

import { OutputBuffer } from './outputBuffer.js';
import { DEC_2026_END } from './terminalEscapeSequences.js';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

// ── Guard ───────────────────────────────────────────────────────────────────────

export class TerminalRestoreGuard {
  private state: TerminalState;
  private restored = false;
  private disarmed = false;
  private onRestoreCallbacks: RestoreCallback[] = [];
  private signalHandlers: Map<string, NodeJS.SignalsListener> = new Map();
  private uncaughtExceptionHandler: NodeJS.UncaughtExceptionListener | null = null;
  private unhandledRejectionHandler: NodeJS.UnhandledRejectionListener | null = null;
  private exitHandler: (() => void) | null = null;

  constructor() {
    this.state = this.captureState();
    this.installSignalHandlers();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Current captured state (snapshot at construction time). */
  get capturedState(): Readonly<TerminalState> {
    return { ...this.state };
  }

  /** Whether restore() has already been called. */
  get isRestored(): boolean {
    return this.restored;
  }

  /** Whether the guard has been disarmed (no auto-restore). */
  get isDisarmed(): boolean {
    return this.disarmed;
  }

  /**
   * Register a callback that fires when restoration happens.
   * Useful for components that need to clean up their own state.
   * Returns a function to unregister.
   */
  onRestore(cb: RestoreCallback): () => void {
    this.onRestoreCallbacks.push(cb);
    return () => {
      const idx = this.onRestoreCallbacks.indexOf(cb);
      if (idx >= 0) this.onRestoreCallbacks.splice(idx, 1);
    };
  }

  /**
   * Restore terminal to the captured state. Idempotent — safe to call
   * multiple times. Fires all onRestore callbacks.
   */
  restore(reason: RestoreEvent['reason'] = 'normal'): void {
    if (this.restored) return;
    this.restored = true;

    const event: RestoreEvent = { reason, timestamp: Date.now() };

    // Fire callbacks before restoring terminal (so they can still write)
    for (const cb of this.onRestoreCallbacks) {
      try {
        cb(event);
      } catch {
        // Swallow — cannot allow a callback error to block terminal restore
      }
    }

    this.restoreTerminalState();
    this.removeSignalHandlers();
  }

  /**
   * Permanently disarm the guard. No automatic restoration will occur on
   * signal/exit/crash after this. Call this only when you've taken over
   * terminal management yourself (e.g., handing off to a child process).
   */
  disarm(): void {
    if (this.disarmed) return;
    this.disarmed = true;
    this.removeSignalHandlers();
  }

  // ── Symbol.dispose (TypeScript 5.2+ `using` statement) ──────────────────

  [Symbol.dispose](): void {
    if (!this.disarmed && !this.restored) {
      this.restore('dispose');
    }
  }

  // ── Private: state capture ─────────────────────────────────────────────────

  private captureState(): TerminalState {
    const stdin = process.stdin;
    return {
      wasRaw: stdin.isTTY ? ((stdin as unknown as { isRaw?: boolean }).isRaw ?? false) : false,
      cursorVisible: true, // We assume visible; most TUI code hides it
      altScreenActive: false, // Tracked separately by InputCoordinator
      mouseTrackingEnabled: false,
      scrollRegionSet: false,
    };
  }

  // ── Private: terminal restore ──────────────────────────────────────────────

  private restoreTerminalState(): void {
    try {
      // Show cursor (in case it was hidden)
      // Immediate write via raw stdout: this runs during terminal recovery
      // (signal/exception/exit) where we must guarantee the write reaches the
      // terminal even if OutputBuffer's internal state is compromised.
      process.stdout.write('\x1b[?25h');

      // Reset SGR attributes
      process.stdout.write('\x1b[0m');

      // Reset scroll region to full screen
      process.stdout.write('\x1b[r');

      // Disable mouse tracking (all modes)
      process.stdout.write('\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l');

      // Disable bracketed paste mode
      process.stdout.write('\x1b[?2004l');

      // Exit alternate screen if we think we're in one
      // (InputCoordinator handles this more precisely, but belt-and-suspenders)
      process.stdout.write('\x1b[?1049l');

      // Restore cursor position to bottom
      const rows = process.stdout.rows || 24;
      process.stdout.write(`\x1b[${rows};1H`);

      // End synchronized update if active
      process.stdout.write(DEC_2026_END);

      // Restore raw mode
      if (process.stdin.isTTY && this.state.wasRaw) {
        try {
          (process.stdin as unknown as { setRawMode: (mode: boolean) => void }).setRawMode(
            this.state.wasRaw,
          );
        } catch {
          // Terminal may already be closed
        }
      }
    } catch {
      // Terminal may already be destroyed — nothing we can do
    }
  }

  // ── Private: signal handlers ───────────────────────────────────────────────

  private installSignalHandlers(): void {
    // Signal handlers: restore then re-raise
    for (const sig of SIGNALS) {
      const handler: NodeJS.SignalsListener = () => {
        this.restore('signal');
        // Re-raise after a short delay to let our writes flush
        setTimeout(() => {
          process.kill(process.pid, sig);
        }, 50);
      };
      process.on(sig, handler);
      this.signalHandlers.set(sig, handler);
    }

    // Uncaught exception
    this.uncaughtExceptionHandler = (err: Error) => {
      this.restore('exception');
      console.error('\nUncaught Exception:', err.message);
      process.exit(1);
    };
    process.on('uncaughtException', this.uncaughtExceptionHandler);

    // Unhandled rejection
    this.unhandledRejectionHandler = (reason: unknown) => {
      this.restore('exception');
      const msg = reason instanceof Error ? reason.message : String(reason);
      console.error('\nUnhandled Rejection:', msg);
      process.exit(1);
    };
    process.on('unhandledRejection', this.unhandledRejectionHandler);

    // Normal exit — restore but don't prevent exit
    this.exitHandler = () => {
      if (!this.restored && !this.disarmed) {
        this.restore('normal');
      }
    };
    process.on('exit', this.exitHandler);
  }

  private removeSignalHandlers(): void {
    for (const [sig, handler] of this.signalHandlers) {
      process.off(sig, handler);
    }
    this.signalHandlers.clear();

    if (this.uncaughtExceptionHandler) {
      process.off('uncaughtException', this.uncaughtExceptionHandler);
      this.uncaughtExceptionHandler = null;
    }
    if (this.unhandledRejectionHandler) {
      process.off('unhandledRejection', this.unhandledRejectionHandler);
      this.unhandledRejectionHandler = null;
    }
    if (this.exitHandler) {
      process.off('exit', this.exitHandler);
      this.exitHandler = null;
    }
  }
}
