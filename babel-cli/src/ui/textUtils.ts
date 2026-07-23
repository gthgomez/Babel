/**
 * Unicode-aware text utilities for Babel's TUI.
 *
 * Node.js `string-length` and `slice(0, n)` operate on UTF-16 code units,
 * which breaks for:
 *   - Emoji (e.g. 👋 = 2 code units, 👨‍👩‍👧 = 8 code units)
 *   - Combining characters (e.g. é can be 1 or 2 code units)
 *   - RTL scripts (Arabic, Hebrew) that need bidi control characters
 *
 * This module provides:
 *   1. Grapheme-cluster-aware length measurement and truncation
 *   2. RTL script detection and Unicode bidi mark insertion
 *
 * Uses Intl.Segmenter (available in Node.js 16+) with a fallback for
 * older runtimes.
 *
 * @module textUtils
 */

// ─── Grapheme cluster support ───────────────────────────────────────────────

let _segmenter: Intl.Segmenter | null = null;

function getSegmenter(): Intl.Segmenter | null {
  if (_segmenter !== null) return _segmenter;
  try {
    _segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return _segmenter;
  } catch {
    _segmenter = null;
    return null;
  }
}

/** Split text into grapheme clusters. Falls back to character array. */
export function graphemeClusters(text: string): string[] {
  const seg = getSegmenter();
  if (seg) {
    return [...seg.segment(text)].map((s) => s.segment);
  }
  // Fallback: use spread operator (handles basic multi-code-point emoji)
  return [...text];
}

/** Count grapheme clusters in text. Equivalent to visible character count. */
export function graphemeLength(text: string): number {
  const seg = getSegmenter();
  if (seg) {
    let count = 0;
    for (const _ of seg.segment(text)) count++;
    return count;
  }
  return [...text].length;
}

/**
 * Truncate text to at most `maxClusters` grapheme clusters, appending
 * an ellipsis marker if truncation occurred.
 *
 * @param text - The text to truncate
 * @param maxClusters - Maximum number of grapheme clusters (visible chars)
 * @param ellipsis - String to append if truncated (default '…')
 * @returns Truncated text
 */
export function graphemeTruncate(
  text: string,
  maxClusters: number,
  ellipsis: string = '…',
): string {
  if (maxClusters <= 0) return ellipsis;

  const clusters = graphemeClusters(text);
  if (clusters.length <= maxClusters) return text;

  return clusters.slice(0, maxClusters).join('') + ellipsis;
}

/**
 * Truncate text to fit within `maxWidth` visible columns.
 * Most emoji and CJK characters occupy 2 columns; ASCII occupies 1.
 *
 * @param text - Text to truncate (may contain ANSI escapes — stripped for measurement)
 * @param maxWidth - Maximum display width in columns
 * @param ellipsis - String to append if truncated (default '…')
 * @returns Truncated text with ellipsis if needed
 */
export function graphemeTruncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis: string = '…',
): string {
  if (maxWidth <= 0) return ellipsis;

  const clusters = graphemeClusters(text);
  let width = 0;
  const result: string[] = [];

  for (const cluster of clusters) {
    // Estimate display width: CJK and emoji typically use 2 columns
    const cp = cluster.codePointAt(0) ?? 0;
    const clusterWidth =
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2329 && cp <= 0x232a) || // Misc technical
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals through Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
      (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
      (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
      (cp >= 0x1f300 && cp <= 0x1f64f) || // Emoticons
      (cp >= 0x1f680 && cp <= 0x1f6ff) || // Transport
      (cp >= 0x1f900 && cp <= 0x1f9ff) || // Supplemental Symbols
      (cp >= 0x1fa00 && cp <= 0x1fa6f) || // Chess Symbols
      (cp >= 0x1fa70 && cp <= 0x1faff) || // Symbols Extended-A
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extension B+
      (cp >= 0x30000 && cp <= 0x3fffd) // CJK Extension G+
        ? 2
        : 1;

    if (width + clusterWidth > maxWidth) {
      result.push(ellipsis);
      break;
    }
    width += clusterWidth;
    result.push(cluster);
  }

  return result.join('');
}

// ─── RTL detection ──────────────────────────────────────────────────────────

/** Unicode ranges for RTL scripts. */
const RTL_RANGES: Array<[number, number]> = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // NKo
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A
  [0xfe70, 0xfeff], // Arabic Presentation Forms-B
  [0x1ee00, 0x1eeff], // Arabic Mathematical Alphabetic Symbols
];

/** Check if a code point belongs to an RTL script. */
function isRtlCodePoint(cp: number): boolean {
  return RTL_RANGES.some(([start, end]) => cp >= start && cp <= end);
}

/**
 * Detect whether text contains RTL script characters.
 * Returns a score: 0 = purely LTR, 1 = purely RTL, between 0-1 = mixed.
 */
export function rtlScore(text: string): number {
  if (!text) return 0;
  let rtlCount = 0;
  let totalCount = 0;

  for (const cp of text) {
    const code = cp.codePointAt(0);
    if (code === undefined) continue;
    // Only count alphabetic characters
    if (
      (code >= 0x0590 && code <= 0x08ff) ||
      (code >= 0xfb50 && code <= 0xfdff) ||
      (code >= 0xfe70 && code <= 0xfeff) ||
      (code >= 0x1ee00 && code <= 0x1eeff)
    ) {
      totalCount++;
      if (isRtlCodePoint(code)) rtlCount++;
    }
  }

  return totalCount > 0 ? rtlCount / totalCount : 0;
}

/** Returns true if text is predominantly RTL (score > 0.5). */
export function isRtl(text: string): boolean {
  return rtlScore(text) > 0.5;
}

// ─── Bidi control characters ────────────────────────────────────────────────

/** Unicode bidi control characters. */
const LRE = '\u{202A}'; // Left-to-Right Embedding
const RLE = '\u{202B}'; // Right-to-Left Embedding
const PDF = '\u{202C}'; // Pop Directional Formatting
const LRO = '\u{202D}'; // Left-to-Right Override
const RLO = '\u{202E}'; // Right-to-Left Override
const LRM = '\u{200E}'; // Left-to-Right Mark (invisible)
const RLM = '\u{200F}'; // Right-to-Left Mark (invisible)
const ALM = '\u{061C}'; // Arabic Letter Mark

/**
 * Wrap text in bidi control characters for correct display.
 *
 * - Strongly RTL text: wrapped in RLE + PDF with trailing RLM
 * - Strongly LTR text with RTL chars: LRE + PDF for the RTL segments
 * - Mixed text: each paragraph is analyzed and wrapped independently
 *
 * @param text - The text to wrap
 * @param forceDirection - Override auto-detection: 'ltr', 'rtl', or undefined (auto)
 * @returns Text with bidi control characters inserted
 */
export function applyBidiMarks(text: string, forceDirection?: 'ltr' | 'rtl'): string {
  if (!text) return text;

  const score = rtlScore(text);

  if (forceDirection === 'rtl' || (forceDirection === undefined && score > 0.5)) {
    // Strongly RTL — wrap entire text
    return RLE + text + PDF + RLM;
  }

  if (score > 0.05) {
    // Mixed or weakly RTL — embed individual RTL words
    return wrapRtlWords(text);
  }

  return text;
}

/**
 * Wrap individual RTL words in embedding marks, while keeping the
 * surrounding LTR structure intact.
 */
function wrapRtlWords(text: string): string {
  // Process word by word
  const words = text.split(/(\s+)/);
  const result: string[] = [];

  for (const word of words) {
    if (rtlScore(word) > 0.5) {
      // This word is primarily RTL — embed it
      result.push(RLE + word + PDF + LRM);
    } else {
      result.push(word);
    }
  }

  return result.join('');
}

/**
 * Strip bidi control characters from text for length measurement
 * and search operations.
 */
export function stripBidiMarks(text: string): string {
  return text.replace(/[\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{061C}]/gu, '');
}

// ─── Utility: combine grapheme-aware + bidi-aware truncation ────────────────

/**
 * Truncate text for terminal display, handling both grapheme clusters
 * and bidi marks. This is the recommended function for all TUI text
 * truncation going forward.
 *
 * @param text - Raw text (may contain ANSI, RTL chars, emoji)
 * @param maxWidth - Maximum display columns
 * @param rtl - Whether to apply RTL detection (default true)
 * @returns Truncated text safe for terminal display
 */
export function terminalTruncate(text: string, maxWidth: number, rtl: boolean = true): string {
  if (!text) return '';

  // Strip bidi marks before measuring (they're zero-width)
  const measurement = rtl ? stripBidiMarks(text) : text;

  return graphemeTruncateToWidth(measurement, maxWidth);
}

// ─── URL detection ───────────────────────────────────────────────────────────

/**
 * Returns true if any whitespace-delimited token in `text` looks like a URL.
 *
 * Recognized patterns:
 *   - Absolute URLs with a scheme (https://…, ftp://…, custom://…)
 *   - Bare domain URLs (example.com/path, www.example.com, localhost:3000/api)
 *   - IPv4 hosts with a path/port (127.0.0.1:8080/health)
 *
 * Surrounding punctuation `()[]{}<>,.;:!'"` is stripped before checking.
 * Tokens that look like file paths (src/main.rs, foo/bar) are rejected.
 */
export function textContainsUrlLike(text: string): boolean {
  return text.split(/\s+/).some(isUrlLikeToken);
}

/** Check if a single whitespace-delimited token looks like a URL. */
function isUrlLikeToken(rawToken: string): boolean {
  const token = trimUrlPunctuation(rawToken);
  if (!token) return false;
  return isAbsoluteUrl(token) || isBareUrl(token);
}

/** Strip surrounding punctuation from a URL token. */
function trimUrlPunctuation(token: string): string {
  return token.replace(/^[()\[\]{}<>,.;:!'"]+/, '').replace(/[()\[\]{}<>,.;:!'"]+$/, '');
}

/** Check for scheme://host patterns. */
function isAbsoluteUrl(token: string): boolean {
  if (!token.includes('://')) return false;
  try {
    const url = new URL(token);
    return (
      ['http:', 'https:', 'ftp:', 'ftps:', 'ws:', 'wss:'].includes(url.protocol) ||
      (url.protocol.length > 0 && !!url.hostname)
    );
  } catch {
    return /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/\S+$/.test(token);
  }
}

/** Check for bare domain URLs (host[:port]/path, host?query, host#fragment). */
function isBareUrl(token: string): boolean {
  // Find the host:port portion before any /, ?, or #
  const trailerIdx = token.search(/[\/?#]/);
  const hostPort = trailerIdx >= 0 ? token.slice(0, trailerIdx) : token;
  const hasTrailer = trailerIdx >= 0;

  // Require URL-ish trailer or www prefix for bare hosts
  if (!hasTrailer && !hostPort.toLowerCase().startsWith('www.')) return false;

  // Split host and port
  const portSep = hostPort.lastIndexOf(':');
  let host: string;
  let port: string | null;
  if (portSep > 0) {
    host = hostPort.slice(0, portSep);
    port = hostPort.slice(portSep + 1);
  } else {
    host = hostPort;
    port = null;
  }

  if (!host) return false;
  if (port !== null && !/^\d{1,5}$/.test(port)) return false;
  if (port !== null && Number.parseInt(port, 10) > 65535) return false;

  return host.toLowerCase() === 'localhost' || isIPv4(host) || isDomainName(host);
}

function isIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => p !== '' && /^\d+$/.test(p) && Number.parseInt(p, 10) <= 255);
}

function isDomainName(host: string): boolean {
  const lower = host.toLowerCase();
  if (!lower.includes('.')) return false;
  const labels = lower.split('.');
  // Must have a valid TLD (at least 2 alpha chars)
  const tld = labels[labels.length - 1];
  if (!tld || tld.length < 2 || tld.length > 63 || !/^[a-z]+$/.test(tld)) return false;
  return labels.every((label) => {
    if (!label || label.length > 63) return false;
    return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label);
  });
}

// ─── URL-aware text wrapping ─────────────────────────────────────────────────

/**
 * Wrap text to a maximum width, preserving URL tokens intact.
 *
 * Standard wrapping (via `wrap-ansi`) will break URLs at `/`, `-`, and other
 * separators. This function detects URL-like tokens and wraps differently:
 *   - URL-only lines: never broken — the URL overflows if wider than maxWidth
 *   - Mixed prose + URL lines: prose wraps normally around the preserved URL
 *   - Pure prose lines: delegates to standard wrapping unchanged
 *
 * This is the recommended wrapping function for all TUI text that may contain
 * URLs (LLM output, tool results, agent messages).
 *
 * @param text - The text to wrap
 * @param maxWidth - Maximum display width in columns
 * @returns Array of wrapped lines
 */
export function urlAwareWrapText(text: string, maxWidth: number): string[] {
  if (!text) return [''];
  if (maxWidth <= 0) return [text];

  // If no URLs, delegate to standard wrapping
  if (!textContainsUrlLike(text)) {
    return standardWrap(text, maxWidth);
  }

  // Check if this is mixed prose + URL or URL-only
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const urlTokens = tokens.filter(isUrlLikeToken);
  const nonUrlTokens = tokens.filter((t) => !isUrlLikeToken(t) && !isDecorativeMarker(t));

  if (nonUrlTokens.length === 0) {
    // URL-only: never split URLs, let them overflow
    return standardWrapPreserveUrls(text, maxWidth);
  }

  // Mixed: wrap prose around preserved URL tokens
  return mixedUrlWrap(text, maxWidth);
}

/**
 * Standard text wrapping using the simple split approach.
 * Produces same output as wrap-ansi for ANSI-free text.
 */
function standardWrap(text: string, maxWidth: number): string[] {
  // Use a simple word-boundary wrapper for predictable output
  const lines: string[] = [];
  const words = text.split(/(?<=\s)/); // split after whitespace
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine + word;
    if (graphemeLength(candidate) <= maxWidth) {
      currentLine = candidate;
    } else {
      if (currentLine) {
        lines.push(currentLine.trimEnd());
      }
      // If a single word is too long, let it overflow onto its own line
      if (graphemeLength(word.trim()) > maxWidth && currentLine === '') {
        lines.push(word.trimEnd());
        currentLine = '';
      } else {
        currentLine = word;
      }
    }
  }
  if (currentLine) lines.push(currentLine.trimEnd());
  return lines.length > 0 ? lines : [''];
}

/** Wrap preserving URLs — URLs stay intact, other tokens wrap normally. */
function standardWrapPreserveUrls(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  // Split on whitespace boundaries, preserving whitespace
  const segments = text.split(/(?<=\s)/);
  let currentLine = '';
  let urlRun = '';

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed && isUrlLikeToken(trimmed)) {
      // Accumulate consecutive URL tokens
      urlRun += seg;
      continue;
    }
    // Flush any accumulated URL run
    if (urlRun) {
      const urlWidth = graphemeLength(urlRun.trimEnd());
      if (currentLine && graphemeLength(currentLine) + 1 + urlWidth <= maxWidth) {
        currentLine += ' ' + urlRun.trimEnd();
      } else {
        if (currentLine) lines.push(currentLine.trimEnd());
        currentLine = '';
        // URL alone — let it overflow if needed
        lines.push(urlRun.trimEnd());
      }
      urlRun = '';
    }
    const candidate = currentLine + seg;
    if (graphemeLength(candidate) <= maxWidth) {
      currentLine = candidate;
    } else {
      if (currentLine) {
        lines.push(currentLine.trimEnd());
      }
      currentLine = seg;
    }
  }
  // Flush remaining
  if (urlRun) {
    if (currentLine) lines.push(currentLine.trimEnd());
    lines.push(urlRun.trimEnd());
  } else if (currentLine) {
    lines.push(currentLine.trimEnd());
  }
  return lines.length > 0 ? lines : [''];
}

/** Wrap mixed prose + URL content, keeping URLs intact. */
function mixedUrlWrap(text: string, maxWidth: number): string[] {
  // Tokenize: split into words (URLs stay as single tokens, prose splits on spaces)
  const rawTokens = text.split(/(?<=\s)/);
  const tokens: Array<{ text: string; isUrl: boolean }> = [];
  for (const t of rawTokens) {
    const trimmed = t.trim();
    tokens.push({
      text: t,
      isUrl: trimmed ? isUrlLikeToken(trimmed) : false,
    });
  }

  const lines: string[] = [];
  let currentLine = '';

  for (const token of tokens) {
    const candidate = currentLine + token.text;
    if (graphemeLength(candidate.trimEnd()) <= maxWidth) {
      currentLine = candidate;
    } else {
      if (currentLine) {
        lines.push(currentLine.trimEnd());
      }
      if (token.isUrl) {
        // URL on its own line — let it overflow
        lines.push(token.text.trimEnd());
        currentLine = '';
      } else {
        currentLine = token.text;
      }
    }
  }
  if (currentLine) lines.push(currentLine.trimEnd());
  return lines.length > 0 ? lines : [''];
}

/** Decorative markers that shouldn't count as "prose" for mixed-line detection. */
function isDecorativeMarker(token: string): boolean {
  const markers = new Set([
    '-',
    '*',
    '+',
    '•',
    '◦',
    '▪',
    '>',
    '|',
    '│',
    '┆',
    '└',
    '├',
    '┌',
    '┐',
    '┘',
    '┼',
  ]);
  if (markers.has(token)) return true;
  // Ordered list markers like "1.", "2)"
  return /^\d+[.)]$/.test(token);
}
