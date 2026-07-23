/**
 * FocusTracker — terminal window focus detection (R4.7/D2).
 *
 * Detects when the terminal window gains or loses focus and forwards the
 * event to FrameScheduler.setWindowFocused() so the render loop can
 * throttle down while the user is looking at another window.
 *
 * Detection strategy:
 *   - Enables DEC private mode 1004 (Focus Events) on the terminal
 *   - Subscribes to `process.stdin` keypress events (emitted by Node.js
 *     readline after emitKeypressEvents is called)
 *   - Recognizes `\x1b[I` (focus in) and `\x1b[O` (focus out) sequences
 *   - On focus loss → doubles frame interval (FrameScheduler.setWindowFocused(false))
 *   - On focus gain → restores normal interval (FrameScheduler.setWindowFocused(true))
 *
 * Why keypress events instead of raw stdin data:
 *   Adding a `process.stdin.on('data', ...)` listener while Node.js readline
 *   is active would switch stdin into flowing mode, breaking readline's
 *   'readable' event processing. The `keypress` event is emitted by readline
 *   on the same process.stdin stream and interleaves cleanly with readline's
 *   own processing.
 *
 * @module focusTracker
 */

import type { Key } from 'node:readline';
import { FrameScheduler } from './frameScheduler.js';
import {
  FOCUS_EVENT_ENABLE,
  FOCUS_EVENT_DISABLE,
  FOCUS_IN_SEQUENCE,
  FOCUS_OUT_SEQUENCE,
} from './terminalEscapeSequences.js';

/**
 * Singleton focus tracker that monitors terminal window focus.
 *
 * Use `FocusTracker.getInstance().start()` to begin monitoring and
 * `FocusTracker.getInstance().stop()` to disable.
 */
export class FocusTracker {
  private static instance: FocusTracker | null = null;

  /** Whether focus reporting has been enabled on the terminal. */
  private _active = false;

  /** Bound keypress handler for easy add/remove. */
  private boundHandler: ((str: string, key: Key) => void) | null = null;

  private constructor() {}

  /** Get the singleton FocusTracker instance. */
  static getInstance(): FocusTracker {
    if (!FocusTracker.instance) {
      FocusTracker.instance = new FocusTracker();
    }
    return FocusTracker.instance;
  }

  /**
   * Whether the focus tracker is currently active (monitoring for events).
   */
  get active(): boolean {
    return this._active;
  }

  /**
   * Start monitoring terminal focus events.
   *
   * Sends the DEC 1004 enable sequence and subscribes to keypress events
   * on process.stdin. Idempotent — safe to call multiple times.
   */
  start(): void {
    if (this._active) return;

    // Enable focus reporting on the terminal
    if (process.stdout.isTTY) {
      process.stdout.write(FOCUS_EVENT_ENABLE);
    }

    // Subscribe to keypress events for focus sequence detection
    this.boundHandler = (str: string, _key: Key) => {
      this.handleKeypress(str);
    };
    process.stdin.on('keypress', this.boundHandler);
    this._active = true;
  }

  /**
   * Stop monitoring terminal focus events.
   *
   * Sends the DEC 1004 disable sequence and removes the keypress listener.
   * Idempotent.
   */
  stop(): void {
    if (!this._active) return;

    // Disable focus reporting on the terminal
    if (process.stdout.isTTY) {
      process.stdout.write(FOCUS_EVENT_DISABLE);
    }

    // Remove keypress listener
    if (this.boundHandler) {
      process.stdin.off('keypress', this.boundHandler);
      this.boundHandler = null;
    }
    this._active = false;
  }

  /**
   * Reset the singleton for testing.
   */
  resetForTest(): void {
    this.stop();
  }

  /**
   * Handle a keypress event by checking for focus sequences.
   *
   * @param str - The raw keypress string (empty for most keys).
   */
  private handleKeypress(str: string): void {
    if (str === FOCUS_IN_SEQUENCE) {
      FrameScheduler.getInstance().setWindowFocused(true);
    } else if (str === FOCUS_OUT_SEQUENCE) {
      FrameScheduler.getInstance().setWindowFocused(false);
    }
  }
}
