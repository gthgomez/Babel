/**
 * Toast notification system for Babel's TUI.
 *
 * Provides non-blocking transient notifications that appear at the top-right
 * of the screen, stack vertically, and auto-dismiss after a configurable
 * duration. Uses Component lifecycle and OutputBuffer for tear-free rendering.
 *
 * Usage:
 *   import { toast } from './toast.js';
 *   toast.info('Indexing complete');
 *   toast.success('Saved 42 files');
 *   toast.warning('Disk space low');
 *   toast.error('Connection lost');
 *
 * Architecture:
 *   - ToastManager: singleton queue, FrameScheduler-driven rendering
 *   - Toast: individual notification with duration, type, message
 *   - Integrates with OutputBuffer for DEC 2026 synchronized updates
 *
 * @module toast
 */

import { OutputBuffer } from './outputBuffer.js';
import {
  getEffectiveTerminalWidth,
  accent,
  success,
  warning,
  error,
  visibleLength,
} from './theme.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  /** Toast message text (single line, truncated to fit) */
  message: string;
  /** Toast style variant */
  type?: ToastType;
  /** Auto-dismiss duration in ms (default: 3000, 0 = sticky until dismissed) */
  durationMs?: number;
}

interface ActiveToast {
  id: number;
  message: string;
  type: ToastType;
}

// ─── ToastManager ───────────────────────────────────────────────────────────

export class ToastManager {
  private static instance: ToastManager | null = null;

  private queue: ActiveToast[] = [];
  private nextId = 1;
  private dismissTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();

  /** Maximum number of visible toasts before older ones are dismissed. */
  private static readonly MAX_VISIBLE = 5;

  /** Default toast duration. */
  private static readonly DEFAULT_DURATION_MS = 3000;

  /** Horizontal margin from right edge. */
  private static readonly MARGIN_RIGHT = 2;

  /** Maximum toast width as fraction of terminal width. */
  private static readonly MAX_WIDTH_RATIO = 0.4;

  static getInstance(): ToastManager {
    if (!ToastManager.instance) {
      ToastManager.instance = new ToastManager();
    }
    return ToastManager.instance;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    if (ToastManager.instance) {
      ToastManager.instance.dismissAll();
      ToastManager.instance = null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Show a toast notification.
   * @returns The toast ID (can be used to dismiss early).
   */
  show(options: ToastOptions): number {
    const id = this.nextId++;
    const durationMs = options.durationMs ?? ToastManager.DEFAULT_DURATION_MS;
    const toast: ActiveToast = {
      id,
      message: options.message,
      type: options.type ?? 'info',
    };

    this.queue.push(toast);

    // Enforce max visible
    while (this.queue.length > ToastManager.MAX_VISIBLE) {
      const removed = this.queue.shift();
      if (removed) this.clearDismissTimer(removed.id);
    }

    // Schedule auto-dismiss for non-sticky toasts
    if (durationMs > 0) {
      const timer = setTimeout(() => this.dismiss(id), durationMs);
      this.dismissTimers.set(id, timer);
    }

    this.render();
    return id;
  }

  /** Dismiss a specific toast by ID. */
  dismiss(id: number): void {
    this.clearDismissTimer(id);
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.render();
    }
  }

  /** Dismiss all toasts immediately. */
  dismissAll(): void {
    for (const [id] of this.dismissTimers) {
      clearTimeout(this.dismissTimers.get(id));
    }
    this.dismissTimers.clear();
    this.queue = [];
    this.clearToastArea();
  }

  private clearDismissTimer(id: number): void {
    const timer = this.dismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.dismissTimers.delete(id);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      if (this.queue.length === 0) {
        this.clearToastArea();
        return;
      }

      const termWidth = getEffectiveTerminalWidth();
      const maxToastWidth = Math.floor(termWidth * ToastManager.MAX_WIDTH_RATIO);
      const toastWidth = Math.min(maxToastWidth, 50);

      // Render toasts bottom-up from the right edge of the screen
      // Row 1 = top of screen, toasts stack downward
      const rows = process.stdout.rows || 24;
      const startRow = 2; // leave room below any top bar

      for (let i = 0; i < Math.min(this.queue.length, ToastManager.MAX_VISIBLE); i++) {
        const toast = this.queue[i]!;
        const row = startRow + i;
        if (row > rows) break;

        const leftCol = Math.max(1, termWidth - toastWidth - ToastManager.MARGIN_RIGHT + 1);

        // Build toast: icon + styled message
        const icon = this.typeIcon(toast.type);
        const displayText = this.truncateMessage(toast.message, toastWidth - 4); // icon + padding
        const content = `${icon} ${displayText}`;
        const padded = content + ' '.repeat(Math.max(0, toastWidth - visibleLength(content) - 2));

        // Style the entire toast with the type color
        const styled = this.styleToast(toast.type, ` ${padded} `);
        buf.writeLine(row, leftCol, styled);
      }

      // Clear any remaining rows from previous (larger) toast stack
      const lastVisibleRow = startRow + this.queue.length;
      const prevLastRow = startRow + ToastManager.MAX_VISIBLE;
      for (let r = lastVisibleRow; r < prevLastRow; r++) {
        const leftCol = Math.max(1, termWidth - toastWidth - ToastManager.MARGIN_RIGHT + 1);
        buf.writeLine(r, leftCol, '');
      }
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  private clearToastArea(): void {
    if (this.queue.length > 0) return; // Don't clear if toasts exist
    const buf = OutputBuffer.getInstance();
    const termWidth = getEffectiveTerminalWidth();
    const maxToastWidth = Math.floor(termWidth * ToastManager.MAX_WIDTH_RATIO);
    const toastWidth = Math.min(maxToastWidth, 50);
    const rows = process.stdout.rows || 24;
    const startRow = 2;
    const leftCol = Math.max(1, termWidth - toastWidth - ToastManager.MARGIN_RIGHT + 1);
    for (let r = startRow; r < startRow + ToastManager.MAX_VISIBLE; r++) {
      buf.writeLine(r, leftCol, '');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private typeIcon(type: ToastType): string {
    switch (type) {
      case 'success':
        return success('✓');
      case 'warning':
        return warning('!');
      case 'error':
        return error('✗');
      default:
        return accent('i');
    }
  }

  private styleToast(type: ToastType, text: string): string {
    switch (type) {
      case 'success':
        return `\x1b[42m\x1b[30m${text}\x1b[0m`;
      case 'warning':
        return `\x1b[43m\x1b[30m${text}\x1b[0m`;
      case 'error':
        return `\x1b[41m\x1b[37m${text}\x1b[0m`;
      default:
        return `\x1b[100m\x1b[37m${text}\x1b[0m`; // bright black bg
    }
  }

  private truncateMessage(message: string, maxLen: number): string {
    const visible = visibleLength(message);
    if (visible <= maxLen) return message;
    // Truncate and add ellipsis
    let result = '';
    let count = 0;
    for (const char of message) {
      if (count >= maxLen - 1) break;
      result += char;
      count++;
    }
    return result + '…';
  }
}

// ─── Convenience API ────────────────────────────────────────────────────────

/** Show an informational toast. */
function buildToastOptions(message: string, type: ToastType, durationMs?: number): ToastOptions {
  const opts: ToastOptions = { message, type };
  if (durationMs !== undefined) opts.durationMs = durationMs;
  return opts;
}

/** Show an informational toast. */
export function toastInfo(message: string, durationMs?: number): number {
  return ToastManager.getInstance().show(buildToastOptions(message, 'info', durationMs));
}

/** Show a success toast. */
export function toastSuccess(message: string, durationMs?: number): number {
  return ToastManager.getInstance().show(buildToastOptions(message, 'success', durationMs));
}

/** Show a warning toast. */
export function toastWarn(message: string, durationMs?: number): number {
  return ToastManager.getInstance().show(buildToastOptions(message, 'warning', durationMs));
}

/** Show an error toast. */
export function toastError(message: string, durationMs?: number): number {
  return ToastManager.getInstance().show(buildToastOptions(message, 'error', durationMs));
}

/** Convenience: named export matching idiomatic usage. */
export const toast = {
  info: toastInfo,
  success: toastSuccess,
  warn: toastWarn,
  error: toastError,
  dismiss: (id: number) => ToastManager.getInstance().dismiss(id),
  dismissAll: () => ToastManager.getInstance().dismissAll(),
};
