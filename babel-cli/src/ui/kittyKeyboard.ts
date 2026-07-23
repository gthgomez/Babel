/**
 * Kitty keyboard protocol helpers (G7).
 *
 * Progressive enhancement for disambiguated key reporting where supported.
 * Sequences:
 *   enable:  CSI > flags u   (flags bitmask)
 *   disable: CSI < u
 *
 * Default flags: 1 | 2 = disambiguate escape + report event types
 * (see https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
 *
 * Parse path for CSI unicode-key-code ; modifiers u  (final byte 'u').
 *
 * @module kittyKeyboard
 */

import type { KeyEvent } from './keyInput.js';

/** Disambiguate escape (1) + report event types (2) */
export const KITTY_FLAGS_DEFAULT = 1 | 2;

/** CSI > {flags} u — push/enable kitty keyboard protocol. */
export function kittyEnableSequence(flags: number = KITTY_FLAGS_DEFAULT): string {
  return `\x1b[>${flags}u`;
}

/** CSI < u — pop/disable kitty keyboard protocol. */
export function kittyDisableSequence(): string {
  return '\x1b[<u';
}

/**
 * Whether kitty keyboard should be enabled for this session.
 * Honors capability bit and optional force env BABEL_KITTY_KBD=1/0.
 */
export function shouldEnableKittyKeyboard(capsKittyKbd: boolean): boolean {
  if (process.env['BABEL_KITTY_KBD'] === '0') return false;
  if (process.env['BABEL_KITTY_KBD'] === '1') return true;
  return capsKittyKbd;
}

/**
 * Parse a CSI parameter string that ends with final byte `u` (already stripped).
 * Forms:
 *   - CSI unicode-key-code u
 *   - CSI unicode-key-code ; modifier u
 *   - CSI unicode-key-code ; modifier ; event-type u
 *
 * Modifier encoding (kitty): value = 1 + bitfield(shift=1, alt=2, ctrl=4, super=8)
 */
export function parseKittyCsiU(paramPart: string, fullSequence: string): KeyEvent | null {
  if (!paramPart) return null;
  // Skip progressive-enhancement push/pop forms: >flags or <
  if (paramPart.startsWith('>') || paramPart.startsWith('<')) return null;

  const parts = paramPart.split(';');
  const codePoint = parseInt(parts[0] ?? '', 10);
  if (!Number.isFinite(codePoint) || codePoint <= 0) return null;

  const modField = parts[1] !== undefined ? parseInt(parts[1], 10) : 1;
  const mods = Number.isFinite(modField) ? modField : 1;
  // event type 1=press (default), 2=repeat, 3=release — ignore release
  const eventType = parts[2] !== undefined ? parseInt(parts[2], 10) : 1;
  if (eventType === 3) return null;

  const m = Math.max(0, mods - 1);
  const isShift = (m & 1) !== 0;
  const isAlt = (m & 2) !== 0;
  const isCtrl = (m & 4) !== 0;

  const special: Record<number, string> = {
    27: 'escape',
    9: 'tab',
    13: 'enter',
    127: 'backspace',
  };

  let name = special[codePoint];
  if (!name) {
    try {
      const ch = String.fromCodePoint(codePoint);
      if (!ch) return null;
      name = ch.toLowerCase();
    } catch {
      return null;
    }
  }

  // Printable uppercase letter under shift
  let shift = isShift;
  if (!special[codePoint] && name.length === 1) {
    const orig = String.fromCodePoint(codePoint);
    if (orig !== orig.toLowerCase()) shift = true;
  }

  return {
    name,
    ctrl: isCtrl,
    meta: isAlt,
    shift,
    sequence: fullSequence,
  };
}
