/**
 * memoryIndex.ts — MEMORY.md Index Management
 *
 * Manages the MEMORY.md index file that serves as a quick-scan table of contents
 * for the memory directory. Format: one line per entry:
 *   - [Title](file.md) — one-line hook
 *
 * Respects the 200-line / 25KB caps and emits truncation warnings when exceeded.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type MemoryIndex,
  type MemoryIndexEntry,
  MEMORY_INDEX_NAME,
  MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
} from './memoryTypes.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const INDEX_HEADER = `# Memory Index

This file is auto-generated. Do not edit by hand — use the memory store API.

`;

// ─── Index Parsing ─────────────────────────────────────────────────────────

/**
 * Entry regex: matches `- [Title](file.md) — one-line hook`
 */
const ENTRY_RE = /^- \[(.+?)\]\(([^)]+\.md)\) — (.+)$/;

/**
 * Read and parse a MEMORY.md index file.
 * Returns an empty index if the file does not exist or is empty.
 */
export function readIndex(indexPath: string): MemoryIndex {
  try {
    if (!existsSync(indexPath)) {
      return { entries: [], path: indexPath };
    }
    const raw = readFileSync(indexPath, 'utf-8');
    const entries: MemoryIndexEntry[] = [];

    for (const line of raw.split('\n')) {
      const match = line.match(ENTRY_RE);
      if (match) {
        entries.push({
          name: (match[1] ?? '').trim(),
          file: match[2] ?? '',
          description: match[3] ?? '',
        });
      }
    }

    return { entries, path: indexPath };
  } catch {
    return { entries: [], path: indexPath };
  }
}

/**
 * Parse the index from its file path relative to a memory root directory.
 * Convenience wrapper around readIndex.
 */
export function parseIndexFromRoot(memoryRoot: string): MemoryIndex {
  return readIndex(join(memoryRoot, MEMORY_INDEX_NAME));
}

// ─── Index Formatting ──────────────────────────────────────────────────────

/**
 * Format a single index entry line.
 */
function formatEntry(entry: MemoryIndexEntry): string {
  return `- [${escapeBrackets(entry.name)}](${entry.file}) — ${escapeBrackets(entry.description)}`;
}

/**
 * Escape square brackets in display text to prevent markdown link corruption.
 */
function escapeBrackets(text: string): string {
  return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

/**
 * Build the complete MEMORY.md content from a list of entries.
 * Entries are sorted alphabetically by name for stable ordering.
 */
function buildIndexContent(entries: MemoryIndexEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [INDEX_HEADER];
  for (const entry of sorted) {
    lines.push(formatEntry(entry));
  }
  return lines.join('\n') + '\n';
}

// ─── Mutations ─────────────────────────────────────────────────────────────

/**
 * Add or update a single entry in MEMORY.md.
 * Reads the existing index, updates the entry (by name), and rewrites the file.
 * Creates the file with a header if it does not exist.
 */
export function updateIndexEntry(memoryRoot: string, entry: MemoryIndexEntry): void {
  const indexPath = join(memoryRoot, MEMORY_INDEX_NAME);
  const index = readIndex(indexPath);

  // Find and replace existing entry by name, or append
  const existingIdx = index.entries.findIndex((e) => e.name === entry.name);
  if (existingIdx >= 0) {
    index.entries[existingIdx] = entry;
  } else {
    index.entries.push(entry);
  }

  rewriteIndexFile(indexPath, index.entries);
}

/**
 * Remove a single entry from MEMORY.md by its slug name.
 * No-op if the entry does not exist.
 */
export function removeIndexEntry(memoryRoot: string, slug: string): void {
  const indexPath = join(memoryRoot, MEMORY_INDEX_NAME);
  const index = readIndex(indexPath);

  const filtered = index.entries.filter((e) => e.name !== slug);
  if (filtered.length === index.entries.length) {
    return; // No change
  }

  rewriteIndexFile(indexPath, filtered);
}

/**
 * Fully rewrite MEMORY.md with the given entries.
 * Handles truncation warning when exceeding line or byte caps.
 */
export function rewriteIndex(memoryRoot: string, entries: MemoryIndexEntry[]): void {
  const indexPath = join(memoryRoot, MEMORY_INDEX_NAME);
  rewriteIndexFile(indexPath, entries);
}

/**
 * Internal: write the index file, applying caps and truncation warnings.
 */
function rewriteIndexFile(indexPath: string, entries: MemoryIndexEntry[]): void {
  let content = buildIndexContent(entries);
  const lines = content.split('\n');

  // Check line cap
  let warning = '';
  if (lines.length > MAX_INDEX_LINES) {
    const truncated = lines.slice(0, MAX_INDEX_LINES);
    warning = `\n> WARNING: ${MEMORY_INDEX_NAME} exceeds ${MAX_INDEX_LINES} lines. Only the first ${MAX_INDEX_LINES} entries are shown.\n`;
    content = truncated.join('\n') + warning;
  }

  // Check byte cap
  if (Buffer.byteLength(content, 'utf-8') > MAX_INDEX_BYTES) {
    // Truncate at last newline before the byte cap
    const bytes = Buffer.from(content, 'utf-8');
    const cutIndex = bytes.lastIndexOf(10, MAX_INDEX_BYTES); // 0x0A = newline
    if (cutIndex > 0) {
      warning = `\n> WARNING: ${MEMORY_INDEX_NAME} exceeds ${MAX_INDEX_BYTES} bytes. Truncated.\n`;
      content = bytes.subarray(0, cutIndex).toString('utf-8') + warning;
    }
  }

  try {
    writeFileSync(indexPath, content, 'utf-8');
  } catch {
    // Silently fail — index writes are best-effort
  }
}

/**
 * Check whether the index exceeds either cap.
 * Returns a warning string if truncated, or null if within limits.
 */
export function checkIndexCaps(memoryRoot: string): string | null {
  const indexPath = join(memoryRoot, MEMORY_INDEX_NAME);
  const index = readIndex(indexPath);

  if (index.entries.length > MAX_INDEX_LINES) {
    return `WARNING: Memory index has ${index.entries.length} entries (limit: ${MAX_INDEX_LINES}). Some entries may not be loaded.`;
  }

  try {
    const content = readFileSync(indexPath, 'utf-8');
    if (Buffer.byteLength(content, 'utf-8') > MAX_INDEX_BYTES) {
      return `WARNING: Memory index exceeds ${MAX_INDEX_BYTES} bytes. Some entries may not be loaded.`;
    }
  } catch {
    // Ignore read errors
  }

  return null;
}
