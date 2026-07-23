/**
 * RawModeManager — shared raw-mode stdin lifecycle for TUI renderers.
 *
 * Encapsulates the common raw-mode enable/disable pattern shared by
 * WaterfallRenderer and ConversationalRenderer in waterfall.ts. Also
 * handles cursor hide/show, key handler installation/cleanup,
 * suspend-handler lifecycle, and optional TerminalRestoreGuard
 * integration.
 *
 * Usage:
 *   const manager = new RawModeManager(stdin);
 *   manager.enable((event) => { /* handle key events *\/ });
 *   // ... later ...
 *   manager.disable();
 *
 * @module rawMode
 */

import { installKeyHandler, installSuspendHandler, type KeyEvent } from './keyInput.js';
import { OutputBuffer } from './outputBuffer.js';
import { TerminalRestoreGuard, type RestoreEvent } from './terminalRestoreGuard.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface RawModeManagerOptions {
  /**
   * Whether to automatically hide the cursor on enable() and show it on
   * disable(). Default: true.
   *
   * Set to false when the caller manages cursor visibility independently.
   */
  manageCursor?: boolean;

  /**
   * Optional TerminalRestoreGuard instance. When provided, the manager
   * registers a one-shot onRestore callback that calls disable() so
   * raw mode is cleaned up on signal/exception/dispose.
   */
  restoreGuard?: TerminalRestoreGuard;
}

// ── Constants ───────────────────────────────────────────────────────────────

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';

// ── Manager ─────────────────────────────────────────────────────────────────

export class RawModeManager {
  private _isActive = false;
  private _removeKeyHandler: (() => void) | null = null;
  private _removeSuspendHandler: (() => void) | null = null;
  private _guardCleanup: (() => void) | null = null;
  private readonly _manageCursor: boolean;

  /**
   * The stdin stream to use. Defaults to process.stdin. Injected for
   * testability.
   */
  private readonly _stdin: NodeJS.ReadStream;

  constructor(stdin: NodeJS.ReadStream = process.stdin, options: RawModeManagerOptions = {}) {
    this._stdin = stdin;
    this._manageCursor = options.manageCursor ?? true;

    // Integrate with TerminalRestoreGuard if provided — register a
    // one-shot handler that disables raw mode when the guard fires
    // (signal, exception, dispose, etc.).
    if (options.restoreGuard) {
      this._guardCleanup = options.restoreGuard.onRestore((_event: RestoreEvent) => {
        if (this._isActive) {
          this.disable();
        }
      });
    }
  }

  /** Whether raw mode is currently active. */
  get isActive(): boolean {
    return this._isActive;
  }

  /**
   * Enable raw mode on stdin: set raw mode, install key handler and
   * suspend handler. Optionally hides the cursor.
   *
   * Idempotent — safe to call multiple times.
   *
   * @param keyCallback  Callback invoked for each parsed KeyEvent.
   */
  enable(keyCallback: (event: KeyEvent) => void): void {
    if (!this._stdin.isTTY || this._isActive) return;
    this._isActive = true;

    this._removeSuspendHandler = installSuspendHandler();
    this._removeKeyHandler = installKeyHandler(this._stdin, keyCallback);

    if (this._manageCursor) {
      writeCursor(CURSOR_HIDE);
    }
  }

  /**
   * Disable raw mode on stdin: remove key handler and suspend handler,
   * restore stdin to previous mode. Optionally shows the cursor.
   *
   * Idempotent — safe to call multiple times.
   */
  disable(): void {
    if (!this._isActive) return;

    this._removeKeyHandler?.();
    this._removeSuspendHandler?.();
    this._removeKeyHandler = null;
    this._removeSuspendHandler = null;
    this._isActive = false;

    if (this._manageCursor) {
      writeCursor(CURSOR_SHOW);
    }
  }

  /**
   * Force-cleanup alias for use by EPIPE handlers.
   * Identical to disable() — included for semantic clarity when
   * raw mode is being aborted due to a broken pipe.
   */
  forceCleanup(): void {
    this.disable();
  }

  /**
   * Free any resources held by the manager (guard callback).
   * Does NOT call disable() — the caller owns the raw-mode lifecycle.
   *
   * Call this after the renderer has already cleaned up raw mode
   * (e.g. in stop()), to prevent the guard from double-disabling.
   */
  dispose(): void {
    this._guardCleanup?.();
    this._guardCleanup = null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Write a cursor ANSI sequence via the OutputBuffer singleton.
 * Safe to call at any time — writes are suppressed when the output
 * stream is broken (EPIPE).
 */
function writeCursor(seq: string): void {
  const buf = OutputBuffer.getInstance();
  if (buf.canWrite) {
    buf.write(seq);
  }
}
