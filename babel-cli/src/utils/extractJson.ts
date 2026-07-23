/**
 * extractJson.ts — Robust JSON extractor for noisy LLM stdout
 *
 * Consumer CLIs and even API responses routinely wrap JSON in one or more
 * layers of noise:
 *   - ANSI colour/cursor escape codes from terminal spinners
 *   - Startup banners or rate-limit warnings printed before the payload
 *   - Markdown code fences (```json … ```) that models add by default
 *   - Explanatory prose before or after the JSON block
 *
 * This module strips all of that and returns the first valid JSON value found,
 * using balanced-brace walking rather than a greedy regex so nested objects
 * and arrays with embedded strings are handled correctly.
 *
 * Both `ClaudeCliRunner` and `ApiFallbackRunner` import from here — it is the
 * single, tested JSON extraction path for the entire harness.
 */

// ─── ANSI stripping ───────────────────────────────────────────────────────────

/**
 * Removes ANSI CSI escape sequences (SGR colour codes, cursor movement, etc.)
 * and OSC sequences that some terminals emit. Covers the vast majority of
 * terminal noise produced by interactive CLIs run in headless mode.
 */
function stripAnsi(text: string): string {
  return (
    text
      // ESC [ … m  (Select Graphic Rendition — colour, bold, etc.)
      // ESC [ … A-Z  (cursor movement, erase, etc.)
      .replace(/\x1b\[[0-9;]*[mA-Za-z]/g, '')
      // ESC ] … BEL  (OSC sequences — window title, hyperlinks)
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // Bare ESC followed by single char (VT100 2-char escapes)
      .replace(/\x1b[@-Z\\-_]/g, '')
  );
}

// ─── Comment stripping ─────────────────────────────────────────────────────────

/**
 * Strips single-line (`//`) and multi-line (slash-asterisk ... asterisk-slash)
 * comments from text. Used as a pre-pass before the balanced-brace walker so
 * that inline comments inside JSON-like blocks don't confuse brace/string parsing.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\/.*$/gm, '') // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // multi-line comments
}

// ─── Balanced brace walker ────────────────────────────────────────────────────

/**
 * Starting at `startIdx` (which must be `{` or `[`), walks forward through
 * `text` counting open/close pairs while respecting string literals and
 * backslash escapes. Returns the index of the matching closing bracket, or
 * `null` if the text ends before the structure closes.
 */
function findClosingBracket(
  text: string,
  startIdx: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return null; // unbalanced — truncated output
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extracts the first structurally valid JSON value (object or array) from a
 * raw string of LLM output, returning it as an `unknown` ready for Zod parsing.
 *
 * Extraction order (first match wins):
 *   1. Content of a Markdown code fence (```json … ``` or ``` … ```)
 *   2. First outermost `{…}` or `[…]` found via balanced-brace walking
 *
 * @throws {Error} If no valid JSON is found anywhere in the string.
 */
export function extractJson(raw: string): unknown {
  const clean = stripAnsi(raw);

  // ── Pass 1: Markdown code fences ────────────────────────────────────────────
  // Match ``` optionally followed by "json", then capture content until ```.
  const fenceRe = /```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/g;
  let fenceMatch: RegExpExecArray | null;

  while ((fenceMatch = fenceRe.exec(clean)) !== null) {
    const candidate = fenceMatch[1]!.trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // This fence block isn't valid JSON; try the next one.
    }
  }

  // ── Pass 2: Balanced brace search ───────────────────────────────────────────
  // Walk character by character looking for the first `{` or `[` that opens a
  // complete, parseable JSON structure.
  // Strip comments first so // and /* */ blocks don't confuse the brace walker.
  const stripped = stripComments(clean);
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch !== '{' && ch !== '[') continue;

    const close = ch === '{' ? '}' : ']';
    const end = findClosingBracket(stripped, i, ch, close);
    if (end === null) continue; // unterminated — skip and keep looking

    try {
      return JSON.parse(stripped.slice(i, end + 1));
    } catch {
      // Not valid JSON at this position (e.g. `{key: value}` without quotes).
      // Continue searching further in the string.
    }
  }

  // ── Nothing found ────────────────────────────────────────────────────────────
  const preview = clean.slice(0, 300).replace(/\n/g, '↵');
  throw new Error(
    `[extractJson] No valid JSON found in LLM output.\n` +
      `Output preview (first 300 chars): ${preview}`,
  );
}

/**
 * Returns ALL valid JSON objects/arrays found in the raw string, in encounter
 * order. Useful when the model emits a preamble object before the intended
 * output — callers can try the Nth candidate if the 1st fails schema validation.
 */
export function extractAllJson(raw: string): unknown[] {
  const clean = stripAnsi(raw);
  const results: unknown[] = [];

  // ── Pass 1: Markdown code fences ──────────────────────────────────────────
  const fenceRe = /```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/g;
  let fenceMatch: RegExpExecArray | null;

  while ((fenceMatch = fenceRe.exec(clean)) !== null) {
    const candidate = fenceMatch[1]!.trim();
    try {
      results.push(JSON.parse(candidate));
    } catch {
      // Not valid JSON in this fence block; keep going.
    }
  }

  // ── Pass 2: Balanced brace search ─────────────────────────────────────────
  // Strip comments so // and /* */ blocks don't confuse the brace walker.
  const stripped = stripComments(clean);
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch !== '{' && ch !== '[') continue;

    const close = ch === '{' ? '}' : ']';
    const end = findClosingBracket(stripped, i, ch, close);
    if (end === null) continue;

    try {
      results.push(JSON.parse(stripped.slice(i, end + 1)));
      i = end; // Skip past this object to find the next one.
    } catch {
      // Not valid JSON at this position; keep looking.
    }
  }

  return results;
}
