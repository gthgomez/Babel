/**
 * sanitize.ts — Terminal escape sequence sanitization for LLM-produced text.
 *
 * All LLM output passes through these functions before reaching stdout.
 * This prevents escape-sequence injection attacks where a compromised or
 * adversarial model response could embed terminal control sequences.
 */

/** ESC character (0x1B) */
const ESC = '\x1b';

/** BEL character (0x07) */
const BEL = '\x07';

/**
 * Strip ALL terminal control sequences from text.
 *
 * Removes:
 *   - C0 control codes (0x00-0x1F) except TAB (0x09), LF (0x0A), CR (0x0D)
 *   - CSI sequences   ESC [ param-bytes* intermediate-bytes* final-byte
 *   - OSC sequences   ESC ] ... (BEL | ESC \)
 *   - DCS sequences   ESC P ... ESC \
 *   - Other C1        ESC followed by any single character
 *
 * OSC 8 hyperlinks (ESC ] 8 ; ; URI ESC \) ARE preserved — they are the
 * only terminal control sequence that carries user-visible semantics and
 * is safe to pass through.
 *
 * Implementation: OSC 8 hyperlinks are extracted and replaced with printable
 * placeholders BEFORE any stripping, then restored after all regex passes
 * complete. This avoids the C0/C1 regexes from stripping parts of the
 * preserved hyperlink sequences.
 *
 * This is stricter than stripAnsi() in theme.js which only removes
 * SGR (Select Graphic Rendition) CSI sequences ending in 'm'.
 */
export function stripControlSequences(text: string): string {
  if (!text) return text;

  // ── Step 1: Extract and protect OSC 8 hyperlinks ────────────────────────
  // Replace each OSC 8 hyperlink opener with a safe printable placeholder.
  // The opener has the form: ESC ] 8 ; ; URI ESC \
  // Closers (ESC ] 8 ; ; ESC \) are NOT extracted and will be stripped below.
  const protectedLinks: string[] = [];
  let linkIndex = 0;

  let out = text.replace(new RegExp(`${ESC}\\]8;;[^${ESC}]+${ESC}\\\\`, 'g'), (match) => {
    const idx = linkIndex++;
    protectedLinks[idx] = match;
    return `OSC8_LINK_${idx}_END`;
  });

  // ── Step 2: Strip CSI sequences ─────────────────────────────────────────
  // ESC [ optional-parameter-bytes (0x30-0x3F)
  //       optional-intermediate-bytes (0x20-0x2F)
  //       final byte (0x40-0x7E)
  out = out.replace(new RegExp(`${ESC}\\[[\\x30-\\x3F]*[\\x20-\\x2F]*[\\x40-\\x7E]`, 'g'), '');

  // ── Step 3: Strip ALL OSC sequences ─────────────────────────────────────
  // At this point, OSC 8 hyperlinks are placeholdered, so it is safe to
  // strip every remaining ESC ] ... sequence (including OSC 8 closers).
  out = out.replace(new RegExp(`${ESC}\\].*?(?:${BEL}|${ESC}\\\\)`, 'g'), '');

  // ── Step 4: Strip DCS sequences ─────────────────────────────────────────
  // ESC P … ESC \
  out = out.replace(new RegExp(`${ESC}P.*?${ESC}\\\\`, 'g'), '');

  // ── Step 5: Strip remaining C1 escapes ──────────────────────────────────
  // ESC followed by any single character (bare C1 controls)
  out = out.replace(new RegExp(`${ESC}.`, 'g'), '');

  // ── Step 6: Strip C0 control codes ──────────────────────────────────────
  // All except TAB (0x09), LF (0x0A), CR (0x0D)
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // ── Step 7: Restore OSC 8 hyperlinks ────────────────────────────────────
  for (let i = 0; i < protectedLinks.length; i++) {
    out = out.replace(new RegExp(`OSC8_LINK_${i}_END`, 'g'), protectedLinks[i]!);
  }

  return out;
}

/**
 * Sanitize LLM-produced text for safe terminal output.
 *
 * Applies stripControlSequences() and also removes any raw
 * backspace characters that could be used for text-overwrite attacks.
 */
export function sanitizeLlmOutput(text: string): string {
  return stripControlSequences(text);
}

/**
 * Sanitize a line of code for syntax-highlighted terminal output.
 * Same as sanitizeLlmOutput but preserves intentional whitespace.
 */
export function sanitizeCodeLine(line: string): string {
  return stripControlSequences(line);
}
