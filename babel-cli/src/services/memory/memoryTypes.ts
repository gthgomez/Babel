/**
 * memoryTypes.ts — Typed Memory Taxonomy
 *
 * Defines the memory type system for Babel's structured memory directory.
 * Mirrors the Claude Code memdir schema (4-type taxonomy) with frontmatter
 * validation via Zod.
 *
 * Four memory types, each capturing context NOT derivable from current project state:
 *   user      — user's role, goals, responsibilities, and knowledge
 *   feedback  — guidance/corrections about how to approach work (both avoid + keep doing)
 *   project   — ongoing work, goals, initiatives, bugs, incidents
 *   reference — pointers to where information can be found in external systems
 */

import { z } from 'zod';

// ─── Type Taxonomy ─────────────────────────────────────────────────────────

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Parse a raw value into a MemoryType.
 * Returns undefined for invalid or missing values — legacy files without a
 * `type:` field keep working, files with unknown types degrade gracefully.
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined;
  return MEMORY_TYPES.find((t) => t === raw);
}

// ─── Zod Schemas ───────────────────────────────────────────────────────────

export const MemoryFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1, 'name is required')
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'name must be kebab-case (e.g., "my-memory")'),
  description: z
    .string()
    .min(1, 'description is required — one-line summary for relevance matching'),
  metadata: z.object({
    type: z.enum(MEMORY_TYPES),
  }),
});

export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface MemoryFile {
  frontmatter: MemoryFrontmatter;
  /** Markdown body after the frontmatter block */
  body: string;
  /** Relative path within the memory directory (e.g., "user_role.md") */
  path: string;
  /** Last modification timestamp */
  mtime: Date;
}

export interface MemoryIndex {
  entries: MemoryIndexEntry[];
  /** Absolute path to the MEMORY.md file */
  path: string;
}

export interface MemoryIndexEntry {
  /** kebab-case slug (matches the frontmatter name) */
  name: string;
  /** Relative path to the .md file from the memory directory */
  file: string;
  /** One-line hook from frontmatter description */
  description: string;
}

export interface MemoryRelevanceScore {
  memory: MemoryFile;
  score: number;
  /** Why this memory matched (for debugging) */
  matchReason: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const MEMORY_INDEX_NAME = 'MEMORY.md';
export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25_000;
export const DEFAULT_MAX_RELEVANT_MEMORIES = 5;
