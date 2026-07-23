/**
 * Paste-burst detection for terminals without reliable bracketed paste (C1).
 *
 * Ported from Codex `paste_burst.rs`. On Windows (and some terminals), pastes
 * arrive as rapid single-character key events rather than one `paste` event.
 * This state machine:
 *
 * - Holds the first fast ASCII char briefly to avoid flicker before classifying a burst
 * - Buffers paste-like streams and flushes them as a single paste
 * - Suppresses Enter-as-submit during multiline paste bursts (Enter → newline)
 * - Retro-captures already-inserted prefix when a burst is detected late
 *
 * Callers feed plain chars and apply decisions; this module does not mutate UI text.
 */

export const PASTE_BURST_MIN_CHARS = 3;
export const PASTE_ENTER_SUPPRESS_WINDOW_MS = 120;
export const PASTE_BURST_CHAR_INTERVAL_MS = 8;
export const PASTE_BURST_ACTIVE_IDLE_TIMEOUT_MS =
  process.platform === 'win32' ? 60 : 8;

export type CharDecision =
  | { type: 'retainFirstChar' }
  | { type: 'beginBufferFromPending' }
  | { type: 'bufferAppend' }
  | { type: 'beginBuffer'; retroChars: number };

export type FlushResult =
  | { type: 'none' }
  | { type: 'typed'; char: string }
  | { type: 'paste'; text: string };

export interface RetroGrab {
  startByte: number;
  grabbed: string;
}

/** Byte index in `before` to start retro-capture (UTF-8 safe via char indices). */
export function retroStartIndex(before: string, retroChars: number): number {
  if (retroChars <= 0) return before.length;
  const indices = [...before].map((_, i) => i);
  const charIndex = indices.length - retroChars;
  if (charIndex <= 0) return 0;
  let byteOffset = 0;
  let chars = 0;
  for (const ch of before) {
    if (chars === charIndex) break;
    byteOffset += Buffer.byteLength(ch, 'utf8');
    chars++;
  }
  return byteOffset;
}

export class PasteBurst {
  private lastPlainCharTime: number | null = null;
  private consecutivePlainCharBurst = 0;
  private burstWindowUntil: number | null = null;
  private buffer = '';
  private active = false;
  private pendingFirstChar: { char: string; at: number } | null = null;

  static recommendedFlushDelayMs(): number {
    return PASTE_BURST_CHAR_INTERVAL_MS + 1;
  }

  static recommendedActiveFlushDelayMs(): number {
    return PASTE_BURST_ACTIVE_IDLE_TIMEOUT_MS + 1;
  }

  /** Decide how to treat a plain ASCII char. */
  onPlainChar(ch: string, now: number): CharDecision {
    this.notePlainChar(now);

    if (this.active) {
      this.burstWindowUntil = now + PASTE_ENTER_SUPPRESS_WINDOW_MS;
      return { type: 'bufferAppend' };
    }

    if (this.pendingFirstChar) {
      const held = this.pendingFirstChar;
      if (now - held.at <= PASTE_BURST_CHAR_INTERVAL_MS) {
        this.active = true;
        this.pendingFirstChar = null;
        this.buffer += held.char;
        this.burstWindowUntil = now + PASTE_ENTER_SUPPRESS_WINDOW_MS;
        return { type: 'beginBufferFromPending' };
      }
    }

    if (this.consecutivePlainCharBurst >= PASTE_BURST_MIN_CHARS) {
      return {
        type: 'beginBuffer',
        retroChars: Math.max(0, this.consecutivePlainCharBurst - 1),
      };
    }

    this.pendingFirstChar = { char: ch, at: now };
    return { type: 'retainFirstChar' };
  }

  /** Non-ASCII / IME path — never holds the first char. */
  onPlainCharNoHold(now: number): CharDecision | null {
    this.notePlainChar(now);

    if (this.active) {
      this.burstWindowUntil = now + PASTE_ENTER_SUPPRESS_WINDOW_MS;
      return { type: 'bufferAppend' };
    }

    if (this.consecutivePlainCharBurst >= PASTE_BURST_MIN_CHARS) {
      return {
        type: 'beginBuffer',
        retroChars: Math.max(0, this.consecutivePlainCharBurst - 1),
      };
    }

    return null;
  }

  private notePlainChar(now: number): void {
    if (
      this.lastPlainCharTime !== null &&
      now - this.lastPlainCharTime <= PASTE_BURST_CHAR_INTERVAL_MS
    ) {
      this.consecutivePlainCharBurst = Math.min(
        this.consecutivePlainCharBurst + 1,
        0xffff,
      );
    } else {
      this.consecutivePlainCharBurst = 1;
    }
    this.lastPlainCharTime = now;
  }

  flushIfDue(now: number): FlushResult {
    const timeout = this.isActiveInternal()
      ? PASTE_BURST_ACTIVE_IDLE_TIMEOUT_MS
      : PASTE_BURST_CHAR_INTERVAL_MS;
    const timedOut =
      this.lastPlainCharTime !== null && now - this.lastPlainCharTime > timeout;

    if (timedOut && this.isActiveInternal()) {
      this.active = false;
      const text = this.buffer;
      this.buffer = '';
      return text ? { type: 'paste', text } : { type: 'none' };
    }

    if (timedOut && this.pendingFirstChar) {
      const ch = this.pendingFirstChar.char;
      this.pendingFirstChar = null;
      return { type: 'typed', char: ch };
    }

    return { type: 'none' };
  }

  appendNewlineIfActive(now: number): boolean {
    if (!this.isActive()) return false;
    this.buffer += '\n';
    this.burstWindowUntil = now + PASTE_ENTER_SUPPRESS_WINDOW_MS;
    return true;
  }

  newlineShouldInsertInsteadOfSubmit(now: number): boolean {
    const inWindow =
      this.burstWindowUntil !== null && now <= this.burstWindowUntil;
    return this.isActive() || inWindow;
  }

  directInsertNewlineShouldInsert(now: number): boolean {
    return (
      this.newlineShouldInsertInsteadOfSubmit(now) ||
      (this.lastPlainCharTime !== null &&
        now - this.lastPlainCharTime <= PASTE_BURST_CHAR_INTERVAL_MS)
    );
  }

  extendWindow(now: number): void {
    this.burstWindowUntil = now + PASTE_ENTER_SUPPRESS_WINDOW_MS;
  }

  beginWithRetroGrabbed(grabbed: string, now: number): void {
    if (grabbed) this.buffer += grabbed;
    this.active = true;
    this.burstWindowUntil = now + PASTE_ENTER_SUPPRESS_WINDOW_MS;
  }

  appendCharToBuffer(ch: string, now: number): void {
    this.buffer += ch;
    this.burstWindowUntil = now + PASTE_ENTER_SUPPRESS_WINDOW_MS;
  }

  decideBeginBuffer(
    now: number,
    before: string,
    retroChars: number,
  ): RetroGrab | null {
    const startByte = retroStartIndex(before, retroChars);
    const grabbed = before.slice(startByte);
    const looksPastey =
      /\s/.test(grabbed) || [...grabbed].length >= 16;
    if (!looksPastey) return null;
    this.beginWithRetroGrabbed(grabbed, now);
    return { startByte, grabbed };
  }

  flushBeforeModifiedInput(): string | null {
    if (!this.isActive()) return null;
    this.active = false;
    let out = this.buffer;
    this.buffer = '';
    if (this.pendingFirstChar) {
      out += this.pendingFirstChar.char;
      this.pendingFirstChar = null;
    }
    return out || null;
  }

  clearWindowAfterNonChar(): void {
    this.consecutivePlainCharBurst = 0;
    this.lastPlainCharTime = null;
    this.burstWindowUntil = null;
    this.active = false;
    this.pendingFirstChar = null;
  }

  clearAfterExplicitPaste(): void {
    this.lastPlainCharTime = null;
    this.consecutivePlainCharBurst = 0;
    this.burstWindowUntil = null;
    this.active = false;
    this.buffer = '';
    this.pendingFirstChar = null;
  }

  isActive(): boolean {
    return this.isActiveInternal() || this.pendingFirstChar !== null;
  }

  private isActiveInternal(): boolean {
    return this.active || this.buffer.length > 0;
  }
}