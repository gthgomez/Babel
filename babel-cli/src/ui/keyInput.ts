/**
 * Structured key event parser for Babel's TUI.
 *
 * Replaces fragile raw-byte stdin comparison with proper key event parsing.
 * Supports single bytes, Ctrl combos, CSI sequences, SS3 F-keys,
 * Alt+char, bracketed paste, bare-Escape disambiguation, and G7 Kitty CSI u.
 *
 * NOTE: Terminal protocol writes (bracketed paste mode, suspend/resume cursor
 * and mouse sequences) are routed through OutputBuffer for a11y stripping and
 * DEC 2026 sync. These must happen immediately (not frame-buffered) — they are
 * written outside any frame, so OutputBuffer.write() goes directly to writeRaw().
 *
 * @module keyInput
 */

import {
  parseKittyCsiU,
  kittyEnableSequence,
  kittyDisableSequence,
  shouldEnableKittyKeyboard,
} from './kittyKeyboard.js';
import { terminalCapsCompat } from './terminalProbe.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KeyEvent {
  /** Normalized key name (lowercase). Examples: 'escape', 'enter', 'a', 'up', 'f1', 'paste' */
  name: string;
  /** Whether Ctrl modifier was held */
  ctrl: boolean;
  /** Whether Alt (Meta) modifier was held */
  meta: boolean;
  /** Whether Shift modifier was held */
  shift: boolean;
  /** Raw byte sequence that produced this event (used for buffer consumption tracking) */
  sequence: string;
  /** IME composition state — true during pre-edit, undefined when not composing */
  isComposing?: boolean;
  /** The full pre-edit text so far (meaningful only during a composition session) */
  composeSequence?: string;
}

// ─── IME Composition handler ───────────────────────────────────────────────────

export interface CompositionHandler {
  /**
   * Process raw stdin data for IME composition tracking.
   * Detects bracketed paste sequences and multi-byte UTF-8 characters.
   */
  handleData(data: Buffer): void;
  /** Cancel current composition and clear all internal state. */
  reset(): void;
  /** Whether a composition session is currently in progress. */
  isComposing(): boolean;
  /**
   * Toggle manual composition mode. When active, all input is buffered
   * until Enter (0x0A/0x0D) commits it, or Escape cancels it.
   * Disabling manual mode while composing commits the current buffer.
   */
  toggleCompositionMode(): void;
  /** Whether manual composition mode is currently active. */
  isManualMode(): boolean;
}

/** Maximum pause (ms) between multi-byte characters before auto-committing composition. */
const COMPOSE_TIMEOUT_MS = 50;

/**
 * Create an IME composition handler for managing pre-edit text state.
 *
 * Provides three composition-detection strategies:
 *  1. **Bracketed paste detection** — a paste arriving via bracketed markers
 *     (`\x1b[200~` … `\x1b[201~`) is treated as a composition commit.
 *  2. **Rapid multi-byte buffering** — CJK characters typed within
 *     `COMPOSE_TIMEOUT_MS` of each other are aggregated and committed after
 *     a pause.
 *  3. **Manual composition mode** — every key is buffered until the user
 *     presses Enter or Escape (toggled via `toggleCompositionMode`).
 *
 * The handler is independent of `installKeyHandler` — pass it as the third
 * argument to wire it into the event stream, or call `handleData` manually
 * for a custom integration.
 *
 * @param onCompose  Called with the current pre-edit text on each change.
 * @param onCommit   Called with the final composed text when composition ends.
 */
export function createCompositionHandler(
  onCompose: (text: string) => void,
  onCommit: (text: string) => void,
): CompositionHandler {
  let composing = false;
  let composeBuffer = '';
  let composeTimer: ReturnType<typeof setTimeout> | null = null;
  let manualMode = false;

  function clearTimer(): void {
    if (composeTimer !== null) {
      clearTimeout(composeTimer);
      composeTimer = null;
    }
  }

  function commitFinal(): void {
    clearTimer();
    if (composing && composeBuffer) {
      const text = composeBuffer;
      composing = false;
      composeBuffer = '';
      onCommit(text);
    } else {
      composing = false;
      composeBuffer = '';
    }
  }

  function reset(): void {
    clearTimer();
    composing = false;
    composeBuffer = '';
  }

  /**
   * Accumulate data in manual mode, handling Enter (commit), Escape (cancel),
   * backspace (delete), and normal text (accumulate).
   */
  function accumulateManual(data: Buffer): void {
    // Enter commits
    if (data.length === 1 && (data[0] === 0x0a || data[0] === 0x0d)) {
      commitFinal();
      return;
    }
    // Escape cancels
    if (data.length === 1 && data[0] === 0x1b) {
      reset();
      return;
    }
    // Backspace
    if (data.length === 1 && (data[0] === 0x08 || data[0] === 0x7f)) {
      composeBuffer = composeBuffer.slice(0, -1);
      if (composeBuffer) {
        onCompose(composeBuffer);
      } else {
        composing = false;
      }
      return;
    }
    composeBuffer += data.toString('utf8');
    onCompose(composeBuffer);
  }

  /**
   * Accumulate data in auto-detect mode with a resetting commit timer.
   */
  function accumulateAuto(data: Buffer): void {
    // Escape cancels
    if (data.length === 1 && data[0] === 0x1b) {
      reset();
      return;
    }
    composeBuffer += data.toString('utf8');
    onCompose(composeBuffer);
    clearTimer();
    composeTimer = setTimeout(() => {
      composeTimer = null;
      commitFinal();
    }, COMPOSE_TIMEOUT_MS);
  }

  function processData(data: Buffer): void {
    if (data.length === 0) return;

    // ── Detect bracketed paste start ──────────────────────────────────
    if (
      data.length >= BRACKETED_PASTE_START.length &&
      data.slice(0, BRACKETED_PASTE_START.length).equals(BRACKETED_PASTE_START)
    ) {
      composing = true;
      composeBuffer = '';
      clearTimer();
      const rest = data.slice(BRACKETED_PASTE_START.length);
      if (rest.length > 0) processData(rest);
      return;
    }

    // ── If composing, check for bracketed paste end ───────────────────
    if (composing) {
      const endIdx = data.indexOf(BRACKETED_PASTE_END);
      if (endIdx !== -1) {
        composeBuffer += data.slice(0, endIdx).toString('utf8');
        commitFinal();
        const rest = data.slice(endIdx + BRACKETED_PASTE_END.length);
        if (rest.length > 0) processData(rest);
        return;
      }
    }

    // ── Manual composition mode ────────────────────────────────────────
    if (manualMode) {
      composing = true;
      accumulateManual(data);
      return;
    }

    // ── Already composing in auto-detect mode ──────────────────────────
    if (composing) {
      accumulateAuto(data);
      return;
    }

    // ── Detect multi-byte UTF-8 lead byte to start composing ──────────
    const firstByte = data[0]!;
    if (firstByte >= 0xc0 && firstByte <= 0xfd) {
      composing = true;
      composeBuffer = data.toString('utf8');
      onCompose(composeBuffer);
      clearTimer();
      composeTimer = setTimeout(() => {
        composeTimer = null;
        commitFinal();
      }, COMPOSE_TIMEOUT_MS);
      return;
    }

    // Non-IME data — pass through (caller handles via normal key processing)
  }

  return {
    handleData: processData,
    reset,
    isComposing: () => composing,
    toggleCompositionMode(): void {
      manualMode = !manualMode;
      // When exiting manual mode while composing, commit the buffer
      if (!manualMode && composing) {
        commitFinal();
      }
    },
    isManualMode: () => manualMode,
  };
}

// ─── Single-byte parsers ────────────────────────────────────────────────────

/**
 * Synchronously parse a keypress from raw stdin bytes.
 *
 * Returns null when the buffer contains an incomplete sequence that needs
 * more bytes (e.g. a bare `\x1b` waiting for continuation, or a partial CSI
 * sequence).
 *
 * Handles the following categories:
 *   - Single bytes: Enter (0x0A/0x0D), Escape (0x1B deferred to caller),
 *     Backspace (0x08/0x7F), Tab (0x09), Space (0x20)
 *   - Ctrl+A-Z (0x01-0x1A, excluding the singles above)
 *   - CSI sequences: arrow keys (A-D), Home (H), End (F),
 *     Insert/Delete/PgUp/PgDn (2~, 3~, 5~, 6~),
 *     F1-F12 (11~ ... 24~)
 *   - SS3 sequences: F1-F4 (ESC O P/Q/R/S)
 *   - Alt+char (ESC followed by printable ASCII)
 */
export function parseKeypress(data: Buffer): KeyEvent | null {
  if (data.length === 0) return null;

  const firstByte = data[0]!;

  // ── Multi-byte UTF-8 (IME/CJK input) ───────────────────────────────────────
  // Lead bytes: 0xC0-0xDF (2-byte), 0xE0-0xEF (3-byte), 0xF0-0xF7 (4-byte),
  //              0xF8-0xFD (reserved / rare)
  if (firstByte >= 0xc0 && firstByte <= 0xfd) {
    const decoded = data.toString('utf8');
    if (decoded.length > 0) {
      // Use Array.from to iterate by Unicode code points (handles surrogate
      // pairs for supplementary characters like emoji)
      const chars = Array.from(decoded);
      if (chars.length > 0) {
        const char = chars[0]!;
        return {
          name: char,
          ctrl: false,
          meta: false,
          shift: false,
          sequence: char,
        };
      }
    }
    return null; // incomplete sequence, wait for more bytes
  }

  // ── Specific single-byte mappings ──────────────────────────────────────────

  // Tab (0x09, Ctrl+I)
  if (firstByte === 0x09) {
    return { name: 'tab', ctrl: false, meta: false, shift: false, sequence: '\t' };
  }

  // LF (0x0A) and CR (0x0D) both treated as Enter in raw mode
  if (firstByte === 0x0a || firstByte === 0x0d) {
    return {
      name: 'enter',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: String.fromCharCode(firstByte),
    };
  }

  // Backspace -- terminals send either 0x7F (DEL) or 0x08 (BS)
  if (firstByte === 0x08 || firstByte === 0x7f) {
    return {
      name: 'backspace',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: String.fromCharCode(firstByte),
    };
  }

  // Escape -- defer to the caller (installKeyHandler handles bare-Escape timeout)
  if (firstByte === 0x1b) {
    return parseEscapeSequence(data);
  }

  // Ctrl+Z (0x1A) — suspend (caught before generic Ctrl handler below)
  if (firstByte === 0x1a) {
    return { name: 'suspend', ctrl: true, meta: false, shift: false, sequence: '\x1a' };
  }

  // ── Ctrl+A through Ctrl+Y (0x01-0x19, excluding ones mapped above) ──────
  if (firstByte >= 0x01 && firstByte <= 0x19) {
    // 0x01 -> 'a', 0x02 -> 'b', ..., 0x1A -> 'z'
    const letter = String.fromCharCode(0x60 + firstByte);
    return {
      name: letter,
      ctrl: true,
      meta: false,
      shift: false,
      sequence: String.fromCharCode(firstByte),
    };
  }

  // ── Space ────────────────────────────────────────────────────────────────
  if (firstByte === 0x20) {
    return { name: 'space', ctrl: false, meta: false, shift: false, sequence: ' ' };
  }

  // ── Printable ASCII (0x21-0x7E, 0x7F already handled as Backspace) ──────
  if (firstByte >= 0x21 && firstByte <= 0x7e) {
    const char = String.fromCharCode(firstByte);
    return {
      name: char.toLowerCase(),
      ctrl: false,
      meta: false,
      shift: char !== char.toLowerCase(),
      sequence: char,
    };
  }

  // Unrecognized byte -- return null (caller should discard or buffer)
  return null;
}

// ─── Escape sequence parsers ────────────────────────────────────────────────

/**
 * Parse sequences that begin with 0x1B (Escape).
 *
 * Categories:
 *   - CSI sequences: ESC [ ...  (0x1B 0x5B ...)
 *   - SS3 sequences: ESC O ...  (0x1B 0x4F ...) -- F1-F4 in some terminals
 *   - Alt+char:      ESC <printable>  (0x1B 0x21-0x7E)
 *   - Double Escape: ESC ESC -> first one emitted as bare Escape
 *   - Unrecognized:  null (needs more data or unknown)
 */
function parseEscapeSequence(data: Buffer): KeyEvent | null {
  if (data.length < 2) return null; // Need at least one byte after ESC

  const secondByte = data[1]!;

  // CSI sequence: ESC [  (0x1B 0x5B)
  if (secondByte === 0x5b) {
    return parseCSI(data.subarray(2));
  }

  // SS3 sequence: ESC O  (0x1B 0x4F) -- used by xterm for F1-F4
  if (secondByte === 0x4f) {
    if (data.length < 3) return null; // Need third byte
    const thirdByte = data[2]!;
    const ss3Map: Record<number, string> = {
      0x50: 'f1', // ESC O P
      0x51: 'f2', // ESC O Q
      0x52: 'f3', // ESC O R
      0x53: 'f4', // ESC O S
    };
    const mapped = ss3Map[thirdByte];
    if (mapped) {
      const seq = '\x1bO' + String.fromCharCode(thirdByte);
      return { name: mapped, ctrl: false, meta: false, shift: false, sequence: seq };
    }
    return null; // Unrecognized SS3
  }

  // Double Escape (ESC ESC) -- treat first as bare Escape, second stays in buffer
  if (secondByte === 0x1b) {
    return { name: 'escape', ctrl: false, meta: false, shift: false, sequence: '\x1b' };
  }

  // Alt+char: ESC followed by a printable ASCII character (0x20-0x7E)
  if (secondByte >= 0x20 && secondByte <= 0x7e) {
    const char = String.fromCharCode(secondByte);
    return {
      name: char.toLowerCase(),
      ctrl: false,
      meta: true,
      shift: char !== char.toLowerCase(),
      sequence: '\x1b' + char,
    };
  }

  // Unrecognized escape sequence (non-printable continuation byte)
  return null;
}

/**
 * Parse the payload of a CSI sequence (the part after ESC [).
 *
 * CSI sequences follow the form:
 *   parameter bytes (0x30-0x3F) + intermediate bytes (0x20-0x2F) + final byte (0x40-0x7E)
 *
 * Recognized sequences:
 *   - Arrow keys:  A (up), B (down), C (right), D (left)  -- no parameters
 *   - Home:        H  -- no parameters
 *   - End:         F  -- no parameters
 *   - Tilde keys:  N~ where N is a numeric parameter (2=insert, 3=delete, 5=pgup,
 *                  6=pgdn, 11-15=f1-f5, 17-21=f6-f10, 23-24=f11-f12)
 */
function parseCSI(params: Buffer): KeyEvent | null {
  if (params.length < 1) return null;

  // Scan for the final byte: first byte that is NOT a parameter (0x30-0x3F)
  // or intermediate (0x20-0x2F) byte.
  let i = 0;
  while (i < params.length) {
    const b = params[i]!;
    if ((b >= 0x30 && b <= 0x3f) || (b >= 0x20 && b <= 0x2f)) {
      i++;
    } else {
      break;
    }
  }

  if (i >= params.length) return null; // No final byte yet -- incomplete

  const finalByte = params[i]!;
  if (finalByte < 0x40 || finalByte > 0x7e) return null; // Invalid terminator

  const paramPart = params.slice(0, i);
  const finalChar = String.fromCharCode(finalByte);
  const seq = '\x1b[' + paramPart.toString() + finalChar;

  // ── Arrow keys (A=up, B=down, C=right, D=left) -- only when no parameters ──
  if (finalByte >= 0x41 && finalByte <= 0x44 && paramPart.length === 0) {
    const arrowNames: Record<number, string> = {
      0x41: 'up',
      0x42: 'down',
      0x43: 'right',
      0x44: 'left',
    };
    return { name: arrowNames[finalByte]!, ctrl: false, meta: false, shift: false, sequence: seq };
  }

  // ── Home / End (H / F) -- only when no parameters ──────────────────────────
  if (finalByte === 0x48 && paramPart.length === 0) {
    return { name: 'home', ctrl: false, meta: false, shift: false, sequence: seq };
  }
  if (finalByte === 0x46 && paramPart.length === 0) {
    return { name: 'end', ctrl: false, meta: false, shift: false, sequence: seq };
  }

  // ── Tilde-based sequences: Insert, Delete, PgUp, PgDn, F1-F12 ──────────────
  if (finalByte === 0x7e) {
    // May include modifier: "3;2~" — take first field for key id
    const paramStr = paramPart.toString();
    const keyId = paramStr.split(';')[0] ?? paramStr;
    const tildeNames: Record<string, string> = {
      '2': 'insert',
      '3': 'delete',
      '5': 'pageup',
      '6': 'pagedown',
      '11': 'f1',
      '12': 'f2',
      '13': 'f3',
      '14': 'f4',
      '15': 'f5',
      '17': 'f6',
      '18': 'f7',
      '19': 'f8',
      '20': 'f9',
      '21': 'f10',
      '23': 'f11',
      '24': 'f12',
    };
    const mapped = tildeNames[keyId];
    if (mapped) {
      // Parse optional kitty/xterm modifier field (`;N`)
      const modField = paramStr.includes(';') ? parseInt(paramStr.split(';')[1] ?? '1', 10) : 1;
      const m = Math.max(0, (Number.isFinite(modField) ? modField : 1) - 1);
      return {
        name: mapped,
        ctrl: (m & 4) !== 0,
        meta: (m & 2) !== 0,
        shift: (m & 1) !== 0,
        sequence: seq,
      };
    }
    return null; // Unknown tilde sequence
  }

  // ── G7: Kitty keyboard protocol CSI … u ───────────────────────────────────
  if (finalByte === 0x75) {
    return parseKittyCsiU(paramPart.toString(), seq);
  }

  // Unrecognized CSI sequence -- caller should consume and discard it
  return null;
}

// ─── Lifecycle manager ───────────────────────────────────────────────────────

import { OutputBuffer } from './outputBuffer.js';

const SGR_MOUSE_PREFIX = Buffer.from([0x1b, 0x5b, 0x3c]); // \x1b[<
const BRACKETED_PASTE_START = Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]); // \x1b[200~
const BRACKETED_PASTE_END = Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]); // \x1b[201~
const BARE_ESC_TIMEOUT_MS = 50;

/** Minimum consecutive printable ASCII characters to trigger burst paste detection (fallback for terminals without DECSET 2004). */
const BURST_THRESHOLD_CHARS = 5;

/**
 * Install a raw-mode key handler on a readable stream (typically process.stdin).
 *
 * Manages the full lifecycle:
 *   - Sets raw mode on the stream, resumes if needed
 *   - Buffers data across multiple `data` chunks
 *   - Disambiguates bare Escape from escape-sequence prefixes with a 50 ms timeout
 *   - Enables DECSET 2004 (bracketed paste mode) when the stream is a TTY
 *   - Detects bracketed paste (`\x1b[200~` ... `\x1b[201~`) and coalesces into a single
 *     `{ name: 'paste' }` event with the pasted content in `sequence`
 *   - Falls back to **burst detection** for terminals that do not support DECSET 2004:
 *     when 5+ consecutive printable ASCII characters arrive in the same data chunk
 *     without bracketed markers, they are coalesced into a paste event.
 *   - Consumes SGR mouse sequences silently (they are parsed by `mouseInput.ts`)
 *   - Optionally feeds data through an IME `CompositionHandler` for pre-edit tracking
 *   - Returns a cleanup function that restores raw mode and removes listeners
 *
 * When a `compositionHandler` is provided, each raw data chunk is also passed to
 * `handleData` before normal parsing. Key events emitted while the handler is
 * composing are tagged with `isComposing: true`. The caller is responsible for
 * routing non-composing key events to the application.
 *
 * @param stream  The readable stream (e.g. `process.stdin`).
 * @param callback  Called with each parsed `KeyEvent`.
 * @param compositionHandler  Optional IME composition handler for pre-edit tracking.
 * @returns  A cleanup function. Call it to restore the terminal and detach the handler.
 */
export function installKeyHandler(
  stream: NodeJS.ReadStream,
  callback: (event: KeyEvent) => void,
  compositionHandler?: CompositionHandler,
): () => void {
  const wasRaw = (stream as unknown as { isRaw?: boolean }).isRaw ?? false;
  const wasPaused = typeof stream.isPaused === 'function' ? stream.isPaused() : false;

  let kittyEnabled = false;
  if (stream.isTTY) {
    (stream as unknown as { setRawMode: (mode: boolean) => void }).setRawMode(true);
    stream.resume();
    // Enable bracketed paste mode (DEC private mode 2004).
    // Terminals that support this wrap pasted text in \x1b[200~ ... \x1b[201~
    // markers so we can coalesce the entire paste into a single KeyEvent.
    // Routes through OutputBuffer for a11y stripping; written outside any frame
    // so it reaches stdout immediately via writeRaw().
    OutputBuffer.getInstance().write('\x1b[?2004h');

    // G7 — Kitty keyboard protocol when capability (or env force) allows.
    try {
      const caps = terminalCapsCompat();
      if (shouldEnableKittyKeyboard(caps.kittyKbd)) {
        OutputBuffer.getInstance().write(kittyEnableSequence());
        kittyEnabled = true;
      }
    } catch {
      // Probe failure must never block input.
    }
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let buffer = Buffer.alloc(0);
  let escapeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let pasteContent: string | null = null; // null = not inside bracketed paste
  let cleanupCalled = false;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function clearEscapeTimeout(): void {
    if (escapeTimeoutId !== null) {
      clearTimeout(escapeTimeoutId);
      escapeTimeoutId = null;
    }
  }

  function emit(event: KeyEvent): void {
    try {
      let eventToEmit = event;
      if (compositionHandler?.isComposing()) {
        eventToEmit = { ...event, isComposing: true };
      }
      callback(eventToEmit);
    } catch {
      // Swallow callback errors to keep the data stream alive
    }
  }

  /**
   * Consume a complete SGR mouse sequence from the front of the buffer,
   * without emitting any key event. Returns true if a sequence was consumed.
   *
   * SGR format:  ESC [ < Btn ; Y ; X m/M
   */
  function tryConsumeMouseSequence(): boolean {
    if (
      buffer.length < 6 ||
      buffer[0] !== SGR_MOUSE_PREFIX[0] ||
      buffer[1] !== SGR_MOUSE_PREFIX[1] ||
      buffer[2] !== SGR_MOUSE_PREFIX[2]
    ) {
      return false;
    }

    // Scan for the terminator: 'm' (0x6D) or 'M' (0x4D)
    for (let j = 3; j < buffer.length; j++) {
      const b = buffer[j]!;
      if (b === 0x6d || b === 0x4d) {
        buffer = buffer.slice(j + 1);
        return true;
      }
      // If we encounter a byte that is not part of a valid SGR mouse sequence
      // (not a digit 0x30-0x39, not a semicolon 0x3B, and not M/m) before
      // finding the terminator, this is an invalid or stuck partial sequence.
      // Discard the consumed prefix bytes so the invalid/next byte can be
      // re-parsed as regular keyboard input.
      if (!((b >= 0x30 && b <= 0x39) || b === 0x3b)) {
        buffer = buffer.slice(j);
        return false;
      }
    }
    return false; // Incomplete mouse sequence -- wait for more data
  }

  /**
   * Detect a burst of consecutive printable ASCII characters in the buffer,
   * as a fallback paste-detection mechanism for terminals that do not support
   * DECSET 2004 (bracketed paste mode).
   *
   * When printable characters (0x20-0x7E) arrive in the same data chunk without
   * bracketed paste markers, they are coalesced into a single paste event if
   * the count reaches BURST_THRESHOLD_CHARS (5). This avoids false positives
   * with normal single-character typing while still catching the rapid multi-char
   * sequences typical of pastes in non-bracketed terminals.
   *
   * Single characters and chunks with fewer than the threshold characters fall
   * through to normal parseKeypress processing and are emitted instantly.
   */
  function tryConsumeBurst(): { text: string; byteLength: number } | null {
    let text = '';
    let offset = 0;

    while (offset < buffer.length) {
      const b = buffer[offset]!;
      // Printable ASCII range: space (0x20) through ~ (0x7E)
      if (b >= 0x20 && b <= 0x7e) {
        text += String.fromCharCode(b);
        offset += 1;
      } else {
        break;
      }
    }

    if (text.length >= BURST_THRESHOLD_CHARS) {
      return { text, byteLength: offset };
    }
    return null;
  }

  /**
   * Try to parse and consume as many key events from the buffer as possible.
   */
  function processBuffer(): void {
    while (buffer.length > 0) {
      // ── Bracketed paste start ──────────────────────────────────────────
      if (
        buffer.length >= BRACKETED_PASTE_START.length &&
        buffer.slice(0, BRACKETED_PASTE_START.length).equals(BRACKETED_PASTE_START)
      ) {
        pasteContent = '';
        buffer = buffer.slice(BRACKETED_PASTE_START.length);
        continue;
      }

      // ── Bracketed paste mode: accumulate until end marker ────────────
      if (pasteContent !== null) {
        const endIdx = buffer.indexOf(BRACKETED_PASTE_END);
        if (endIdx !== -1) {
          pasteContent += buffer.slice(0, endIdx).toString('utf8');
          emit({
            name: 'paste',
            ctrl: false,
            meta: false,
            shift: false,
            sequence: pasteContent,
          });
          pasteContent = null;
          buffer = buffer.slice(endIdx + BRACKETED_PASTE_END.length);
          continue;
        }
        // No end marker yet -- accumulate everything, wait for more data
        pasteContent += buffer.toString('utf8');
        buffer = Buffer.alloc(0);
        break;
      }

      // ── SGR mouse sequence: consume without emitting ────────────────
      if (tryConsumeMouseSequence()) {
        continue;
      }

      // ── Burst detection (fallback for terminals without DECSET 2004) ──
      // When printable ASCII characters arrive rapidly without bracketed paste
      // markers, coalesce consecutive characters into a paste event when the
      // count reaches the threshold. Single characters and sequences below the
      // threshold fall through to normal key parsing and emit instantly.
      if (pasteContent === null) {
        const burst = tryConsumeBurst();
        if (burst !== null) {
          emit({
            name: 'paste',
            ctrl: false,
            meta: false,
            shift: false,
            sequence: burst.text,
          });
          buffer = buffer.slice(burst.byteLength);
          continue;
        }
      }

      // ── Normal key parsing ─────────────────────────────────────────────
      const event = parseKeypress(buffer);
      if (event === null) {
        // Incomplete or unrecognized sequence
        if (buffer.length === 1 && buffer[0] === 0x1b) {
          // Bare Escape -- set timeout for disambiguation
          escapeTimeoutId = setTimeout(() => {
            escapeTimeoutId = null;
            emit({
              name: 'escape',
              ctrl: false,
              meta: false,
              shift: false,
              sequence: '\x1b',
            });
            buffer = buffer.slice(1);
            // Re-process in case more data arrived during the timeout
            if (buffer.length > 0) {
              processBuffer();
            }
          }, BARE_ESC_TIMEOUT_MS);
        }
        // For longer incomplete sequences (e.g. partial CSI), just wait
        break;
      }

      emit(event);
      const byteLen = Buffer.byteLength(event.sequence, 'utf8');
      buffer = buffer.slice(byteLen);
    }
  }

  // ── Data handler ───────────────────────────────────────────────────────────

  function onData(data: Buffer): void {
    if (cleanupCalled) return;
    // Feed raw data through the composition handler if attached
    if (compositionHandler) {
      compositionHandler.handleData(data);
    }
    buffer = Buffer.concat([buffer, data]);
    clearEscapeTimeout();
    processBuffer();
  }

  stream.on('data', onData);

  // ── Cleanup ────────────────────────────────────────────────────────────────

  return () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    clearEscapeTimeout();
    stream.off('data', onData);
    if (stream.isTTY) {
      try {
        // Disable bracketed paste mode before restoring raw mode
        // Routes through OutputBuffer for a11y stripping.
        OutputBuffer.getInstance().write('\x1b[?2004l');
        // G7 — pop kitty keyboard mode if we enabled it
        if (kittyEnabled) {
          OutputBuffer.getInstance().write(kittyDisableSequence());
        }
        (stream as unknown as { setRawMode: (mode: boolean) => void }).setRawMode(wasRaw);
        if (wasPaused) {
          stream.pause();
        }
      } catch {
        // Ignore errors during cleanup
      }
    }
  };
}

/**
 * Install SIGTSTP/SIGCONT handlers to support Ctrl+Z suspend/resume.
 *
 * On suspend: restores terminal to cooked mode, shows cursor, resets
 * scroll region and mouse tracking, then sends SIGTSTP to suspend.
 *
 * On resume (SIGCONT): re-enters raw mode and hides cursor.
 *
 * @param onSuspend  Optional callback invoked just before the process is suspended.
 * @returns  A cleanup function to remove the signal handlers.
 */
export function installSuspendHandler(onSuspend?: () => void): () => void {
  const handler = () => {
    // Restore terminal to cooked mode before suspend
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    // Immediate terminal protocol writes: these run before SIGTSTP and must
    // reach the terminal before the process is suspended. Routes through
    // OutputBuffer for a11y stripping; outside any frame, so write() is immediate.
    const buf = OutputBuffer.getInstance();
    buf.write('\x1b[?25h'); // show cursor
    buf.write('\x1b[r'); // reset scroll region
    buf.write('\x1b[?1000l'); // disable mouse tracking
    buf.write('\x1b[?2004l'); // disable bracketed paste mode

    if (onSuspend) onSuspend();

    // Send SIGTSTP to ourselves (the shell will catch it)
    process.kill(process.pid, 'SIGTSTP');
  };

  const resumeHandler = () => {
    // Re-enter raw mode on resume
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    // Immediate terminal protocol writes on SIGCONT — must reach terminal
    // before the app re-renders. OutputBuffer.write() is direct when no frame.
    const buf = OutputBuffer.getInstance();
    buf.write('\x1b[?25l'); // hide cursor again
    buf.write('\x1b[?2004h'); // re-enable bracketed paste mode
    // The app should re-render — caller is responsible for this
  };

  process.on('SIGTSTP', handler);
  process.on('SIGCONT', resumeHandler);

  return () => {
    process.off('SIGTSTP', handler);
    process.off('SIGCONT', resumeHandler);
  };
}
