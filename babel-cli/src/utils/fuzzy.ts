/**
 * Fuzzy string matching utility.
 *
 * Scores how well `query` matches `target` using character-order matching.
 * Used by the command palette, mention popup, tab completion, and REPL
 * completer for search-as-you-type filtering.
 *
 * @module fuzzy
 */

/**
 * Score how well `query` matches `target` using character-order matching.
 *
 * Scoring heuristics:
 *   +5  contiguous match (characters adjacent in target)
 *   +3  word-boundary match (start of word or after `/` or `[`)
 *   +1  loose character match
 *
 * Returns 0 when not all query characters can be matched in order.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let qi = 0;
  let lastMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (lastMatch >= 0 && ti === lastMatch + 1) {
        score += 5; // Contiguous match
      } else if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '/' || t[ti - 1] === '[') {
        score += 3; // Word-boundary match
      } else {
        score += 1; // Loose match
      }
      lastMatch = ti;
      qi++;
    }
  }

  return qi === q.length ? score : 0;
}
