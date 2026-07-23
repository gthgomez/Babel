import { createLogUpdate } from 'log-update';
import { FrameScheduler } from './frameScheduler.js';

const BROKEN_STREAM_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ENOTCONN']);

const DEFAULT_FRAMES = ['◐', '◓', '◑', '◒'];
const DEFAULT_INTERVAL = 80;

export interface SpinnerRendererOptions {
  /** Frame characters to cycle through (default: ['◐', '◓', '◑', '◒']). */
  frames?: string[];
  /** Tick interval in ms (default: 80). */
  interval?: number;
  /** Output stream (default: process.stderr). */
  stream?: NodeJS.WriteStream;
  /**
   * Optional format function invoked on each render tick.
   * Receives the current frame character and the current text.
   * Default: `(frame, text) => \`${frame} ${text}\``
   */
  format?: (frame: string, text: string) => string;
}

type LogUpdateFn = ((...text: string[]) => void) & {
  done(): void;
  clear(): void;
  persist(): void;
};

/**
 * Singleton animated spinner backed by log-update.
 *
 * Uses the unified FrameScheduler instead of its own setInterval.
 * Handles frame cycling, cursor hide/show, stream error guards, and
 * log-update lifecycle.
 */
export class SpinnerRenderer {
  private frames: string[] = DEFAULT_FRAMES;
  private interval: number = DEFAULT_INTERVAL;
  private stream: NodeJS.WriteStream = process.stderr;
  private logUpdate: LogUpdateFn;
  private frameIndex: number = 0;
  private currentText: string = '';
  private running = false;
  private removeErrorGuard: (() => void) | null = null;
  private formatFn: (frame: string, text: string) => string;
  private unregisterScheduler: (() => void) | null = null;

  constructor(options: SpinnerRendererOptions = {}) {
    if (options.frames !== undefined) this.frames = options.frames;
    if (options.interval !== undefined) this.interval = options.interval;
    if (options.stream !== undefined) this.stream = options.stream;
    this.formatFn = options.format ?? ((frame: string, text: string): string => `${frame} ${text}`);
    this.logUpdate = createLogUpdate(this.stream);
  }

  /**
   * Start the spinner animation. Hides the cursor, installs a broken-stream
   * error guard, and registers with the unified FrameScheduler instead of
   * running its own setInterval. Safe to call multiple times (no-op if
   * already running).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      // Hide cursor
      this.stream.write('\x1b[?25l');
      this.removeErrorGuard = this.installErrorGuard();

      const scheduler = FrameScheduler.getInstance();
      scheduler.start();
      this.unregisterScheduler = scheduler.scheduleComponent('spinner', () => this.render(), {
        intervalMs: this.interval,
        priority: 5,
        label: 'spinner',
      });
      scheduler.setComponentPermanentDirty('spinner', true);
      // Render immediately for instant feedback
      this.render();
    } catch (error) {
      // Ensure cursor is restored if any setup step between hide and show fails
      this.stream.write('\x1b[?25h');
      this.running = false;
      throw error;
    }
  }

  /**
   * Stop the spinner. Persists the last rendered line, writes an optional
   * final line, shows the cursor, and removes the stream error guard.
   *
   * @param finalLine - Optional line written **after** the spinner line is
   *                    persisted so it stays visible above subsequent output.
   */
  stop(finalLine = ''): void {
    if (!this.running) return;
    this.running = false;

    FrameScheduler.getInstance().setComponentPermanentDirty('spinner', false);
    this.unregisterScheduler?.();
    this.unregisterScheduler = null;

    this.logUpdate.done();
    if (finalLine) {
      this.stream.write(finalLine + '\n');
    }
    // Show cursor
    this.stream.write('\x1b[?25h');
    this.removeErrorGuard?.();
    this.removeErrorGuard = null;
  }

  /**
   * Set the displayed text and immediately re-render (so the label change
   * is visible without waiting for the next tick).
   */
  update(text: string): void {
    this.currentText = text;
    if (this.running) {
      this.render();
    }
  }

  /**
   * Set the displayed text without triggering an immediate re-render.
   * The new text will appear on the next animation tick.
   */
  setText(text: string): void {
    this.currentText = text;
  }

  /** Return true while the spinner animation is active. */
  isRunning(): boolean {
    return this.running;
  }

  // ── private helpers ──────────────────────────────────────────────

  private render(): void {
    try {
      const idx = this.frameIndex % this.frames.length;
      const frame = this.frames[idx]!;
      this.frameIndex++;
      this.logUpdate(this.formatFn(frame, this.currentText));
    } catch (error) {
      // Stop spinner on render error to ensure cursor is restored
      this.stop();
      throw error;
    }
  }

  private installErrorGuard(): () => void {
    const handler = (error: Error & { code?: string }): void => {
      if (error?.code && BROKEN_STREAM_CODES.has(error.code)) {
        this.running = false;
        FrameScheduler.getInstance().setComponentPermanentDirty('spinner', false);
        this.unregisterScheduler?.();
        this.unregisterScheduler = null;
      }
    };
    this.stream.on('error', handler);
    return () => {
      this.stream.off('error', handler);
    };
  }
}
