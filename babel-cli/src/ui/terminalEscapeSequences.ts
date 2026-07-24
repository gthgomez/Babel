/**
 * TerminalEscapeSequences — shared escape-sequence constants used across
 * the TUI subsystem (OutputBuffer, InputCoordinator, TerminalRestoreGuard,
 * FocusTracker).
 *
 * Centralizing these prevents drift between the three uncoordinated restore
 * mechanisms identified in an architectural audit.
 *
 * @module terminalEscapeSequences
 */

// ── DEC 2026 Synchronized Update ─────────────────────────────────────────────

/** Begin synchronized update frame (DEC private mode 2026). */
export const DEC_2026_BEGIN = '\x1b[?2026h';

/** End synchronized update frame (DEC private mode 2026). */
export const DEC_2026_END = '\x1b[?2026l';

// ── Terminal Focus Events ─────────────────────────────────────────────

/**
 * Enable terminal focus-event reporting (DEC private mode 1004).
 *
 * When enabled, the terminal sends:
 *   \x1b[I  (CSI I)  when the terminal window gains focus
 *   \x1b[O  (CSI O)  when the terminal window loses focus
 *
 * These sequences are detected by FocusTracker and forwarded to
 * FrameScheduler.setWindowFocused() to throttle render during inactivity.
 *
 * Supported in: xterm, kitty, WezTerm, Windows Terminal (conpty),
 * Ghostty, and most modern terminal emulators.
 */
export const FOCUS_EVENT_ENABLE = '\x1b[?1004h';

/** Disable terminal focus-event reporting (DEC private mode 1004). */
export const FOCUS_EVENT_DISABLE = '\x1b[?1004l';

/** CSI sequence sent by terminal when window gains focus. */
export const FOCUS_IN_SEQUENCE = '\x1b[I';

/** CSI sequence sent by terminal when window loses focus. */
export const FOCUS_OUT_SEQUENCE = '\x1b[O';
