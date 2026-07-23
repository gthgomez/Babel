/**
 * OSC 8 terminal hyperlink support for the Babel TUI.
 *
 * Ported from codex `terminal_hyperlinks.rs`. Hyperlink annotations are tracked
 * separately from visible text so OSC 8 bytes never affect `string-width`
 * calculations or text layout.
 *
 * OSC 8 format: ESC ] 8 ; ; URI ST  visible-text  ESC ] 8 ; ; ST
 * (ST = \x07 or ESC \)
 *
 * Supported terminals: iTerm2, WezTerm, kitty, Ghostty, Windows Terminal,
 * VS Code integrated terminal, and any terminal implementing the OSC 8 spec.
 *
 * Usage:
 *   import { osc8Hyperlink, findWebLinks, annotateText } from './hyperlinks.js';
 *
 * @module hyperlinks
 */

import { sanitizeHyperlinkUri } from './outputBuffer.js';

// ── OSC 8 escape sequences ──────────────────────────────────────────────────

const OSC8_ST = '\x07';

function osc8Open(uri: string): string {
  return `\x1b]8;;${uri}${OSC8_ST}`;
}

const OSC8_CLOSE = `\x1b]8;;${OSC8_ST}`;

// ── URL detection in text ───────────────────────────────────────────────────

/** A detected hyperlink with its column range in the text. */
export interface TerminalHyperlink {
  columns: { start: number; end: number };
  destination: string;
}

/**
 * Find all web URLs in plain text and return their column positions.
 *
 * Surrounding punctuation (`()[]{}<>,.;:!'"`) is stripped. Balanced
 * parentheses are preserved (e.g. Wikipedia URLs with `(mathematics)`).
 *
 * @param text - Plain text to scan for URLs
 * @returns Array of detected hyperlinks with column positions
 */
export function findWebLinks(text: string): TerminalHyperlink[] {
  const links: TerminalHyperlink[] = [];
  let searchFrom = 0;

  for (const rawToken of text.split(/\s+/)) {
    const relativeStart = text.indexOf(rawToken, searchFrom);
    if (relativeStart < 0) continue;
    const rawStart = relativeStart;

    // Strip leading punctuation
    const leadingTrimmed = rawToken.replace(/^[()\[\]{}<>,.;:!'"]+/, '');
    const trimmedStart = rawToken.length - leadingTrimmed.length;

    // Strip trailing punctuation (balanced delimiters preserved)
    const trailingEnd = findTrailingUrlEnd(leadingTrimmed);

    if (trimmedStart >= trimmedStart + trailingEnd) {
      searchFrom = rawStart + rawToken.length;
      continue;
    }

    const candidate = leadingTrimmed.slice(0, trailingEnd);
    const destination = sanitizeHyperlinkUri(candidate);
    if (!destination) {
      searchFrom = rawStart + rawToken.length;
      continue;
    }

    // Column position: count display width up to the URL
    const prefix = text.slice(0, rawStart + trimmedStart);
    const start = [...prefix].length; // grapheme-cluster count ≈ display columns for ASCII prefix
    const end = start + candidate.length;

    links.push({
      columns: { start, end },
      destination,
    });

    searchFrom = rawStart + rawToken.length;
  }

  return links;
}

/** Find the end of a URL token after stripping trailing punctuation. */
function findTrailingUrlEnd(candidate: string): number {
  let end = candidate.length;
  while (end > 0) {
    const ch = candidate[end - 1]!;
    const trim =
      ch === ',' ||
      ch === '.' ||
      ch === ';' ||
      ch === '!' ||
      ch === "'" ||
      ch === '"' ||
      ((ch === ')' || ch === ']' || ch === '}' || ch === '>') &&
        hasUnmatchedClosingDelimiter(candidate.slice(0, end), ch));
    if (!trim) break;
    end--;
  }
  return end;
}

function hasUnmatchedClosingDelimiter(candidate: string, closing: string): boolean {
  const opening = { ')': '(', ']': '[', '}': '{', '>': '<' }[closing];
  if (!opening) return false;
  const closeCount = [...candidate].filter((c) => c === closing).length;
  const openCount = [...candidate].filter((c) => c === opening).length;
  return closeCount > openCount;
}

// ── Hyperlink rendering ─────────────────────────────────────────────────────

/**
 * Wrap text in OSC 8 hyperlink escape sequences.
 *
 * Only emits OSC 8 for valid http/https URLs. Non-web destinations
 * return plain text.
 *
 * @param destination - The URL to link to
 * @param text - The visible text to display
 * @returns ANSI-escaped text with OSC 8 hyperlink, or plain text
 */
export function osc8Hyperlink(destination: string, text: string): string {
  const safe = sanitizeHyperlinkUri(destination);
  if (!safe) return text;
  return `${osc8Open(safe)}${text}${OSC8_CLOSE}`;
}

/**
 * Annotate plain text with OSC 8 hyperlinks for all detected URLs.
 *
 * URLs are detected in the text and wrapped in OSC 8 sequences.
 * Non-URL text passes through unchanged.
 *
 * @param text - Plain text that may contain URLs
 * @returns Text with OSC 8 hyperlink sequences around URLs
 */
export function annotateText(text: string): string {
  const links = findWebLinks(text);
  if (links.length === 0) return text;

  // Sort links by start position so we process left to right
  const sorted = [...links].sort((a, b) => a.columns.start - b.columns.start);

  let result = '';
  let cursor = 0;
  const chars = [...text]; // grapheme-cluster array for column-accurate positioning

  for (const link of sorted) {
    // Text before the link
    if (link.columns.start > cursor) {
      result += chars.slice(cursor, link.columns.start).join('');
    }
    // The link text with OSC 8
    const linkText = chars.slice(link.columns.start, link.columns.end).join('');
    result += osc8Hyperlink(link.destination, linkText);
    cursor = link.columns.end;
  }

  // Trailing text
  if (cursor < chars.length) {
    result += chars.slice(cursor).join('');
  }

  return result;
}

/**
 * Strip OSC 8 hyperlink sequences from text, leaving only the visible content.
 * Useful for length measurement, snapshot testing, and accessibility mode.
 *
 * @param text - Text that may contain OSC 8 sequences
 * @returns Text with all OSC 8 sequences removed
 */
export function stripOsc8(text: string): string {
  // Match ESC ] 8 ; ; <uri> ST or ESC ] 8 ; ; ST
  return text
    .replace(/\x1b\]8;;[^\x07\x1b]*\x07/g, '')
    .replace(/\x1b\]8;;[^\x07\x1b]*\x1b\\/g, '')
    .replace(/\x1b\]8;;\x07/g, '')
    .replace(/\x1b\]8;;\x1b\\/g, '');
}
