/**
 * semanticContext.ts — Semantic Index Context Injection (P1.4)
 *
 * Pre-emptively searches the FTS5 semantic index with task keywords and
 * injects the top results as additional context into the executor prompt.
 * This gives the LLM relevant file references without requiring explicit
 * semantic_search tool calls, reducing turn count and token spend.
 *
 * The index must already be built (via ensureSemanticIndexForProject or
 * the indexer service). If the index is unavailable, this degrades
 * gracefully to an empty result.
 */

import { globalIndexer } from './indexer.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SemanticContextResult {
  /** Formatted context lines ready for prompt injection */
  lines: string[];
  /** Raw search hits for debugging */
  hits: Array<{ name: string; snippet: string; score: number }>;
  /** Whether the index was available */
  indexAvailable: boolean;
}

// ── Keyword Extraction ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'shall',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'over',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'and',
  'but',
  'or',
  'not',
  'no',
  'if',
  'then',
  'else',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'just',
  'now',
  'also',
  'any',
  'here',
  'there',
]);

function extractTaskKeywords(task: string): string[] {
  return task
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter((w) => !STOP_WORDS.has(w))
    .slice(0, 8); // Max 8 keywords
}

// ── Context Injection ────────────────────────────────────────────────────────

/**
 * Search the semantic index with task-derived keywords and return formatted
 * context lines for prompt injection.
 *
 * Call this once before building the executor prompt. Results are cached
 * in-memory by the FTS5 index. Subsequent calls with the same keywords
 * are nearly free.
 */
export function buildSemanticContext(
  task: string,
  _projectRoot?: string,
  maxHits = 5,
): SemanticContextResult {
  const keywords = extractTaskKeywords(task);

  if (keywords.length === 0) {
    return { lines: [], hits: [], indexAvailable: false };
  }

  try {
    const indexer = globalIndexer;
    if (!indexer || indexer.count === 0) {
      return { lines: [], hits: [], indexAvailable: indexer !== undefined };
    }

    // Search with each keyword and collect unique hits (dedup by name)
    const hitMap = new Map<string, { name: string; snippet: string; score: number }>();

    for (const keyword of keywords.slice(0, 4)) {
      try {
        const results = indexer.search(keyword, 3);
        for (const hit of results) {
          const existing = hitMap.get(hit.name);
          if (!existing || hit.score > existing.score) {
            hitMap.set(hit.name, {
              name: hit.name,
              snippet: hit.snippet ?? '',
              score: hit.score,
            });
          }
        }
      } catch {
        // individual keyword search failure is non-fatal
      }
    }

    // Sort by score descending, take top N
    const hits = [...hitMap.values()].sort((a, b) => b.score - a.score).slice(0, maxHits);

    if (hits.length === 0) {
      return { lines: [], hits: [], indexAvailable: true };
    }

    // Format as context lines
    const lines = [
      '',
      '/* ── Semantic Index Context (auto-discovered) ── */',
      ...hits.map(
        (h, i) =>
          `// [${i + 1}] ${h.name} (relevance: ${Math.round(h.score * 100)}%) — ${h.snippet.slice(0, 120)}`,
      ),
    ];

    return { lines, hits, indexAvailable: true };
  } catch {
    return { lines: [], hits: [], indexAvailable: false };
  }
}
