/**
 * MentionPopup — lightweight popup controller for @mention file/command results.
 *
 * Follows the same popup pattern as the slash command popup in PromptInput
 * but as a standalone class with no rendering logic. It manages the result
 * list, selection state, and visibility, leaving rendering to the caller.
 *
 * Results are sorted by fuzzy-match score (descending) when set.
 * The popup shows at most `maxVisible` items at a time, scrolling the
 * selection window as the user navigates.
 *
 * @module mentionPopup
 */

import { fuzzyMatch } from './fuzzyMatcher.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Directories to skip during the glob fallback file search. */
const GLOB_SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.next',
  '.turbo',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'coverage',
  '.terraform',
  '.godot',
  'runs',
]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MentionResult {
  type: 'file' | 'command';
  /** Display name (e.g. "src/ui/sanitize.ts") */
  label: string;
  /** Subtitle / description (e.g. "83 lines — escape sequence sanitization") */
  description: string;
  /** Text inserted into the prompt when selected */
  insertText: string;
  /** Fuzzy match score (higher = better match) */
  score: number;
}

// ─── MentionPopup ───────────────────────────────────────────────────────────

export class MentionPopup {
  private results: MentionResult[] = [];
  private selectedIndex = 0;
  private maxVisible: number;

  constructor(config?: { maxVisible?: number }) {
    this.maxVisible = config?.maxVisible ?? 8;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Set the result list. Sorts by score descending and resets selection
   * to the first item (if any).
   */
  setResults(results: MentionResult[]): void {
    // Sort by score descending; stable sort preserves input order for ties
    this.results = [...results].sort((a, b) => b.score - a.score);
    this.selectedIndex = 0;
  }

  /**
   * Get the currently selected result, or `null` if there are no results.
   */
  getSelected(): MentionResult | null {
    if (this.results.length === 0) return null;
    return this.results[this.selectedIndex] ?? null;
  }

  /**
   * Move the selection by `delta` lines (+1 = down, -1 = up).
   * Wraps around at the boundaries.
   */
  moveSelection(delta: number): void {
    if (this.results.length === 0) return;
    const maxIndex = this.results.length - 1;
    this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
  }

  /**
   * Reset the popup: clear all results and reset selection.
   */
  reset(): void {
    this.results = [];
    this.selectedIndex = 0;
  }

  /**
   * Get the subset of results that should be visible in the popup,
   * based on the current selection and `maxVisible`.
   */
  getVisibleResults(): MentionResult[] {
    if (this.results.length === 0) return [];

    // Compute the window start so the selected item stays at the bottom
    // of the visible window as the user scrolls down, and at the top
    // when at or near the beginning.
    let start = this.selectedIndex - this.maxVisible + 1;
    if (start < 0) start = 0;
    if (start > this.results.length - this.maxVisible) {
      start = this.results.length - this.maxVisible;
    }

    return this.results.slice(start, start + this.maxVisible);
  }

  /**
   * Get the current selection index (0-based) within the full result list.
   */
  getSelectionIndex(): number {
    return this.selectedIndex;
  }

  /**
   * Whether there are any results to display.
   */
  hasResults(): boolean {
    return this.results.length > 0;
  }

  /**
   * The total number of results.
   */
  get resultCount(): number {
    return this.results.length;
  }
}

// ─── Filesystem Glob Fallback ─────────────────────────────────────────────────

/**
 * Filesystem glob fallback for @mention popup.
 *
 * Synchronously walks the directory tree starting from `rootDir`, collecting
 * file paths whose relative name fuzzy-matches `query`. This is a lightweight,
 * self-contained alternative to the FTS index for cases where the index is
 * unavailable or returns no results.
 *
 * Uses nucleo-matcher-wasm with `matchPaths: true` so `/` and `\` are treated
 * as word boundaries — matching on individual path segments rather than the
 * full path string.
 *
 * @param query   The partial file path the user typed after `@`.
 * @param rootDir Absolute path to the project root to search under.
 * @param options Optional `maxResults` (default 20) and `maxDepth` (default 10).
 * @returns A sorted array of `MentionResult` with fuzzy scores, capped at
 *          `maxResults`. Returns an empty array on any I/O error.
 */
export function searchFilesGlob(
  query: string,
  rootDir: string,
  options?: { maxResults?: number; maxDepth?: number },
): MentionResult[] {
  const maxResults = options?.maxResults ?? 20;
  const maxDepth = options?.maxDepth ?? 10;
  const allPaths: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied, missing dir, etc. -- skip silently
    }

    for (const entry of entries) {
      if (GLOB_SKIPPED_DIRECTORIES.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const relPath = fullPath.startsWith(rootDir)
          ? fullPath.slice(rootDir.length + 1).replace(/\\/g, '/')
          : fullPath.replace(/\\/g, '/');
        allPaths.push(relPath);
      }
    }
  }

  try {
    if (fs.existsSync(rootDir) && fs.statSync(rootDir).isDirectory()) {
      walk(rootDir, 0);
    }
  } catch {
    // Ignore rootDir validation errors
  }

  if (allPaths.length === 0) return [];

  // Use fuzzyMatch with matchPaths so path separators are treated as word
  // boundaries — queries like "ui/Button" match "src/ui/Button.tsx" better.
  const matches = fuzzyMatch(query, allPaths, { limit: maxResults, matchPaths: true });

  return matches.map((m) => ({
    type: 'file' as const,
    label: m.item,
    description: '',
    insertText: m.item,
    score: m.score,
  }));
}
