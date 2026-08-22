/**
 * Central decision for destructive multi-row terminal rewrites.
 *
 * Windows Terminal / ConPTY ignores CSI cursor-up (CUU) and erase-display (ED).
 * Answer streaming already uses append-only paint on that host. Every other
 * conversational TUI writer must use the same decision.
 *
 * Harmless sequences (SGR colors, CSI K erase-line, CR) are not restricted.
 */

import { isWindowsTerminal } from './terminalProbe.js';

/** CSI n A — cursor up. Does not match SGR or EL (K). */
export const DESTRUCTIVE_CUU_RE = /\x1b\[\d*A/;
/** CSI J / CSI n J — erase in display. */
export const DESTRUCTIVE_ED_RE = /\x1b\[[0-3]?J/;

/**
 * Whether CUU/ED multi-row rewrites are safe on this terminal.
 *
 * Override with BABEL_ANSWER_REWRITE=csi (force on) or append-only (force off).
 */
export function canUseCursorRewrite(): boolean {
  const override = (process.env['BABEL_ANSWER_REWRITE'] ?? '').toLowerCase();
  if (override === 'csi') return true;
  if (override === 'append-only') return false;
  return !isWindowsTerminal();
}

/** True when `text` contains destructive CUU or ED. */
export function containsDestructiveCursorRewrite(text: string): boolean {
  return DESTRUCTIVE_CUU_RE.test(text) || DESTRUCTIVE_ED_RE.test(text);
}
