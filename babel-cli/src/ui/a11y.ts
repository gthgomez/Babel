/**
 * Accessibility mode for Babel's TUI.
 *
 * When `BABEL_A11Y=1` is set, Babel switches to feed-only output:
 *   - All ANSI styling (colors, bold, dim, reverse video) is suppressed
 *   - Alternate screen is disabled — output flows linearly
 *   - Cursor positioning and screen-clearing escape sequences are stripped
 *   - Complex TUI layouts (HUD, spinners, progress bars) are replaced
 *     with plain-text equivalents
 *   - Interactive dialogs fall back to plain-text prompts
 *
 * This mode is designed for screen readers, Braille displays, and other
 * assistive technologies that work best with unadorned text streams.
 *
 * Usage:
 *   import { isA11yMode, stripAnsiForA11y, a11yWrap } from './a11y.js';
 *   if (isA11yMode()) { ... }
 *
 * @module a11y
 */

// ─── Detection ──────────────────────────────────────────────────────────────

/**
 * Check whether accessibility mode is active.
 *
 * Activated by:
 *   BABEL_A11Y=1  (or 'true' / 'yes' / 'on')
 *
 * NOTE: NO_COLOR is intentionally NOT treated as a11y mode.
 * NO_COLOR only disables color (see theme.supportsColor). Coupling it to
 * full a11y caused OutputBuffer to strip clear/alt-screen CSI sequences,
 * which turned every SessionPicker redraw into scrollback spam.
 * Use BABEL_A11Y=1 for linear screen-reader mode.
 */
export function isA11yMode(): boolean {
  const val = process.env['BABEL_A11Y'];
  if (val === '1' || val === 'true' || val === 'yes' || val === 'on') return true;
  return false;
}

/**
 * Returns true if the session should avoid alternate-screen mode.
 * In a11y mode, output should scroll linearly in the main buffer.
 */
export function shouldAvoidAltScreen(): boolean {
  return isA11yMode();
}

/**
 * Returns true if interactive TUI elements (dialogs, palettes, spinners)
 * should fall back to plain-text equivalents.
 */
export function shouldUsePlainTextUI(): boolean {
  return isA11yMode();
}

// ─── Output filtering ───────────────────────────────────────────────────────

/**
 * Strip all ANSI escape sequences and cursor control sequences from a string.
 * More aggressive than simple SGR stripping — removes cursor positioning,
 * screen clearing, scroll regions, and alternate screen sequences.
 *
 * Preserves only printable text, newlines, tabs, and carriage returns.
 */
export function sanitizeForA11y(text: string): string {
  if (!text) return text;
  return (
    text
      // CSI sequences: SGR, cursor movement, screen modes, etc.
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      // OSC sequences (hyperlink, title, etc.)
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      // DCS, SOS, PM, APC sequences
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
      // Standalone ESC sequences (cursor save/restore, charset, etc.)
      .replace(/\x1b[()*+][0-9A-Z]/g, '')
      .replace(/\x1b[=>]/g, '')
      .replace(/\x1b[78]/g, '')
      // Carriage return without newline (used by spinners) → skip
      .replace(/\r(?!\n)/g, '')
  );
}

// ─── Content wrapping ───────────────────────────────────────────────────────

/**
 * Wrap a plain-text message with optional semantic label.
 * In a11y mode, visual indicators (icons, ANSI colors) are replaced
 * with text prefixes like "[INFO]", "[ERROR]", etc.
 */
export function a11yLabel(type: 'info' | 'success' | 'warning' | 'error', text: string): string {
  if (!isA11yMode()) return text;
  const labels: Record<string, string> = {
    info: '[INFO] ',
    success: '[OK] ',
    warning: '[WARN] ',
    error: '[ERROR] ',
  };
  return (labels[type] ?? '') + text;
}

/**
 * Return a plain-text spinner replacement for a11y mode.
 * Instead of animated spinner glyphs, returns a fixed status message.
 */
export function a11yActivity(label: string): string {
  if (!isA11yMode()) return label;
  return `... ${label}`;
}

// ─── Dialog fallback ────────────────────────────────────────────────────────

/**
 * In a11y mode, generate a plain-text permission prompt instead of
 * using the full PermissionDialog overlay.
 */
export function a11yPermissionPrompt(action: string, detail: string): string {
  if (!isA11yMode()) return '';
  return `\n[PERMISSION] ${action}: ${detail}\n  Type 'y' to approve or 'n' to deny.\n`;
}

// ─── Structured output events ──────────────────────────────────────────────

/**
 * Structured event emitted to stdout when BABEL_A11Y=1 for machine consumers.
 */
export interface A11yStructuredEvent {
  /** ISO-8601 timestamp of the event. */
  ts: string;
  /** Event category. */
  type: 'stage' | 'activity' | 'tool_call' | 'tool_result' | 'error' | 'complete' | 'summary';
  /** Human-readable message (ANSI-stripped). */
  message?: string;
  /** Pipeline stage index (0-based), if applicable. */
  stage_index?: number;
  /** Tool name, if a tool call event. */
  tool?: string;
  /** Elapsed time in milliseconds, if applicable. */
  elapsed_ms?: number;
  /** Cost in USD, if applicable. */
  cost_usd?: number;
}

/**
 * Emit a structured JSON-line event for a11y consumers.
 * Only active when isA11yMode() returns true.
 * Prefixes each line with A11Y: so consumers can filter from mixed output.
 */
export function emitA11yEvent(event: A11yStructuredEvent): void {
  if (!isA11yMode()) return;
  const line = `A11Y:${JSON.stringify(event)}\n`;
  try {
    // Direct process.stdout.write — OutputBuffer already imports isA11yMode and
    // sanitizeForA11y from this module. Re-importing OutputBuffer here would
    // create a circular dependency (outputBuffer → a11y → outputBuffer).
    // This is acceptable because emitA11yEvent is the a11y output channel
    // itself — the one special place that feeds structured events to screen
    // readers. Its output is intentionally unfiltered.
    process.stdout.write(line);
  } catch {
    // Silently drop on EPIPE — don't crash the TUI for logging failure
  }
}

/** Emit a stage transition event. */
export function a11yStageEvent(stageIndex: number, label: string): void {
  emitA11yEvent({
    ts: new Date().toISOString(),
    type: 'stage',
    stage_index: stageIndex,
    message: label,
  });
}

/** Emit an activity line event (content already ANSI-stripped). */
export function a11yActivityEvent(message: string): void {
  emitA11yEvent({
    ts: new Date().toISOString(),
    type: 'activity',
    message: sanitizeForA11y(message),
  });
}

/** Emit a tool call event. */
export function a11yToolEvent(tool: string, target?: string): void {
  emitA11yEvent({
    ts: new Date().toISOString(),
    type: 'tool_call',
    tool,
    message: target ? `${tool} ${target}` : tool,
  });
}
