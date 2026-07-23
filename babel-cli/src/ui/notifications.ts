/**
 * Desktop notifications via terminal escape sequences.
 *
 * - OSC 9:  iTerm2, Kitty, WezTerm, Ghostty
 * - OSC 777: terminal-notifier fallback on macOS
 * - BEL:     basic terminal fallback (audible beep)
 *
 * These notification sequences are routed through OutputBuffer so a11y mode
 * strips them (screen readers should not hear terminal bells or OSC payloads).
 * The catch handler is retained as a belt-and-suspenders safety net.
 */

import { OutputBuffer } from './outputBuffer.js';

let notificationsEnabled = true;

/**
 * Send a desktop notification.
 * No-op on non-TTY environments or when notifications are disabled.
 */
export function sendNotification(title: string, body?: string): void {
  if (!notificationsEnabled) return;
  if (!process.stdout.isTTY) return;

  const message = body ? `${title}: ${body}` : title;

  try {
    const buf = OutputBuffer.getInstance();
    // OSC 9 — iTerm2 / Kitty / WezTerm / Ghostty
    buf.write(`\x1b]9;${message}\x07`);
    // OSC 777 — terminal-notifier fallback on macOS
    buf.write(`\x1b]777;${message}\x07`);
    // BEL — basic terminal fallback (audible beep)
    buf.write('\x07');
  } catch {
    // Silently ignore — broken stdout is not a reason to crash
  }
}

/**
 * Notify that a task has completed, including elapsed time.
 */
export function notifyTaskComplete(task: string, elapsedMs: number): void {
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const elapsed = minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
  sendNotification(`"${task}" completed`, elapsed);
}

export function enableNotifications(): void {
  notificationsEnabled = true;
}

export function disableNotifications(): void {
  notificationsEnabled = false;
}
