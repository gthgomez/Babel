/**
 * FuzzyMatcher — thin wrapper over nucleo-matcher-wasm for Babel's TUI.
 *
 * nucleo-matcher-wasm is a Rust/WASM fuzzy matching engine that supports
 * fzf-like syntax: ^prefix, $suffix, 'substring, !negation.
 *
 * This module provides a singleton matcher with pre-compiled patterns
 * for common Babel use cases (command completion, file search, history).
 *
 * @module fuzzyMatcher
 */

import { NucleoMatcher, type IndexedMatchResult } from 'nucleo-matcher-wasm';

export interface FuzzyMatch {
  item: string;
  score: number;
  indices: number[];
}

export interface FuzzyMatchOptions {
  limit?: number;
  minScore?: number;
  /** Treat `/` and `\` as word boundaries (for file-path matching) */
  matchPaths?: boolean;
  /** Boost matches near the start of the haystack (for prefix matching) */
  preferPrefix?: boolean;
}

/**
 * Score and rank candidates against a query.
 * Returns sorted by score descending, best matches first.
 * Uses matchPatternIndexed (typed-array WASM path) for faster matching —
 * avoids copying matched strings across the WASM boundary.
 */
export function fuzzyMatch(
  query: string,
  candidates: string[],
  options?: FuzzyMatchOptions,
): FuzzyMatch[] {
  if (candidates.length === 0) return [];

  const matcherOpts: Record<string, boolean> = {};
  if (options?.matchPaths) matcherOpts.matchPaths = true;
  if (options?.preferPrefix) matcherOpts.preferPrefix = true;

  const matcher = new NucleoMatcher(
    candidates,
    Object.keys(matcherOpts).length > 0 ? matcherOpts : null,
  );
  const results: FuzzyMatch[] = [];

  try {
    // matchPatternIndexed returns { indices: Uint32Array, scores: Uint32Array }
    // parallel arrays — avoids marshaling matched strings across the WASM boundary.
    // The caller looks up items[candidates[indices[i]]] on the JS side.
    const indexed = matcher.matchPatternIndexed(query) as IndexedMatchResult;
    const { indices, scores } = indexed;
    for (let i = 0; i < indices.length; i++) {
      const score = scores[i]!;
      if (options?.minScore !== undefined && score < options.minScore) continue;
      results.push({ item: candidates[indices[i]!]!, score, indices: [] });
    }
  } catch {
    // On error, fall through and return whatever we have
  }

  matcher.free();
  return options?.limit ? results.slice(0, options.limit) : results;
}

/**
 * Check if a query matches a candidate (boolean, no scoring).
 * Use for quick filtering where ranking isn't needed.
 */
export function fuzzyTest(query: string, candidate: string): boolean {
  try {
    const matcher = new NucleoMatcher([candidate]);
    const score = matcher.score(query, candidate) as number | undefined;
    matcher.free();
    return score !== undefined && score !== null;
  } catch {
    return candidate.toLowerCase().includes(query.toLowerCase());
  }
}
