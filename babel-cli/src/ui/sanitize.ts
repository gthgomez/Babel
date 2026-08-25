/**
 * sanitize.ts — Terminal escape sequence sanitization for LLM-produced text.
 *
 * Untrusted model/LLM output passes through these functions before reaching stdout.
 * Security invariant: Untrusted/model text NEVER supplies raw terminal control sequences.
 * All raw CSI, OSC (including raw OSC 8), DCS, and dangerous control codes are stripped.
 * Babel alone validates Markdown hrefs and emits safe OSC 8 hyperlinks via encodeHyperlink().
 */

import { scanTerminalTokens, ESC } from './terminalSequenceScanner.js';

/**
 * Sanitize a URI for use in OSC 8 hyperlink escape sequences.
 * Only http and https URLs with valid hostnames are considered safe for terminal hyperlinks.
 * Returns null for non-web or dangerous destinations (javascript:, file:, mailto:, data:, etc.).
 */
export function sanitizeHyperlinkUri(uri: string): string | null {
  if (!uri) return null;
  const safe = uri.replace(/[\x00-\x1f\x7f]/g, '').trim();
  try {
    const url = new URL(safe);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) {
      return safe;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encode a safe terminal hyperlink using OSC 8 escape sequences.
 * Validates the URI with sanitizeHyperlinkUri(); if valid, wraps the label
 * in an OSC 8 opener and closer. If invalid or unsupported, returns the label verbatim.
 *
 * @param uri Target destination URL
 * @param label Visible label text
 */
export function encodeHyperlink(uri: string, label: string): string {
  const safeUri = sanitizeHyperlinkUri(uri);
  if (!safeUri) return label;
  return `${ESC}]8;;${safeUri}${ESC}\\${label}${ESC}]8;;${ESC}\\`;
}

/**
 * Strip ALL terminal control sequences from untrusted text.
 *
 * Removes:
 *   - C0 control codes (0x00-0x1F) except TAB (0x09), LF (0x0A), CR (0x0D)
 *   - CSI sequences (including colors, cursor movement, screen erasure)
 *   - OSC sequences (including raw OSC 8 hyperlinks from untrusted sources)
 *   - DCS sequences
 *   - Other C1 / bare ESC controls
 */
export function stripControlSequences(text: string): string {
  if (!text) return text;

  let out = '';
  for (const token of scanTerminalTokens(text)) {
    if (token.type === 'text' || token.type === 'newline' || token.type === 'carriage_return') {
      out += token.raw;
    }
  }
  return out;
}

/**
 * Sanitize LLM-produced text for safe terminal output.
 * Primary terminal trust boundary entry point.
 */
export function sanitizeUntrustedTerminalText(text: string): string {
  return stripControlSequences(text);
}

/**
 * Backward-compatible alias for sanitizeUntrustedTerminalText.
 */
export function sanitizeLlmOutput(text: string): string {
  return sanitizeUntrustedTerminalText(text);
}

/**
 * Sanitize a line of code for terminal output.
 */
export function sanitizeCodeLine(line: string): string {
  return stripControlSequences(line);
}
