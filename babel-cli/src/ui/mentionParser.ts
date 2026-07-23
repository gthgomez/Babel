/**
 * mentionParser — detect `@` mention triggers in prompt text.
 *
 * A pure function that scans the current line backward from the cursor
 * position to find an `@` character that begins a mention (preceded by
 * whitespace or start-of-line). Returns the trigger location and the
 * partial query the user has typed after `@`.
 *
 * @module mentionParser
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MentionTrigger {
  /** Always '@' */
  trigger: string;
  /** Text after `@` before cursor (the partial file path the user is typing) */
  query: string;
  /** 1-based column where `@` was typed */
  startCol: number;
  /** 0-based line index where the trigger was found */
  cursorLine: number;
  /** 0-based column where `@` was typed */
  cursorCol: number;
}

// ─── Detector ───────────────────────────────────────────────────────────────

/**
 * Detect an `@` mention trigger at the cursor position.
 *
 * Scans backward from `cursorCol` on `lines[cursorLine]` to find `@` that
 * is either at the start of the line or preceded by whitespace. The query
 * is the text between (but not including) `@` and the cursor.
 *
 * @param lines      The full text buffer split into lines.
 * @param cursorLine 0-based line index where the cursor currently sits.
 * @param cursorCol  0-based column of the cursor on the current line.
 * @returns A `MentionTrigger` if a valid `@` is found, or `null`.
 */
export function detectMentionTrigger(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): MentionTrigger | null {
  const line = lines[cursorLine];
  if (!line || line.length === 0) return null;

  // Walk backward from cursorCol to find '@'
  for (let col = cursorCol - 1; col >= 0; col--) {
    const ch = line[col];

    if (ch === '@') {
      // Must be preceded by whitespace, another @ (for @@), or be at start of line
      if (col === 0 || line[col - 1] === ' ' || line[col - 1] === '\t' || line[col - 1] === '@') {
        // Collect the partial query between '@' and cursor
        const query = line.slice(col + 1, cursorCol);

        return {
          trigger: '@',
          query,
          startCol: col + 1, // 1-based for terminal rendering
          cursorLine,
          cursorCol: col,
        };
      }

      // If '@' is mid-word (e.g., foo@bar), stop scanning — not a trigger
      return null;
    }
  }

  // No '@' found on the current line
  return null;
}
