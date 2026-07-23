/**
 * memoryStore.ts — CRUD operations on the Babel memory directory.
 *
 * Manages a per-project memory directory at ~/.babel/projects/{sanitized-git-root}/memory/.
 * Each memory is a .md file with YAML-style frontmatter parsed as structured metadata.
 * The MEMORY.md index is maintained as a quick-scan table of contents.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { z } from 'zod';

import {
  type MemoryFile,
  type MemoryFrontmatter,
  type MemoryIndex,
  type MemoryIndexEntry,
  MEMORY_INDEX_NAME,
  MemoryFrontmatterSchema,
} from './memoryTypes.js';
import {
  updateIndexEntry,
  removeIndexEntry,
  readIndex,
  rewriteIndex,
} from './memoryIndex.js';

// ─── Git Root Sanitization ─────────────────────────────────────────────────

/**
 * Sanitize a git root path to a filesystem-safe slug.
 * Replaces characters that are invalid in folder names (especially on Windows).
 */
export function sanitizeGitRoot(gitRoot: string): string {
  return gitRoot
    .replace(/^[A-Za-z]:(?=\/|\\)/, '') // Strip Windows drive letter (e.g., "C:" → "")
    .replace(/[/\\:<>"|?*]+/g, '-') // Replace invalid/special chars with hyphens
    .replace(/^[-.]+|[-.]+$/g, '') // Strip leading/trailing hyphens and dots
    .replace(/-+/g, '-') // Collapse consecutive hyphens
    .toLowerCase();
}

/**
 * Resolve the memory root directory for a given project root.
 * Creates the directory if it does not exist (idempotent).
 * Returns null on filesystem errors.
 */
export function resolveMemoryRoot(projectRoot: string): string | null {
  try {
    const sanitized = sanitizeGitRoot(resolve(projectRoot));
    const memoryRoot = join(homedir(), '.babel', 'projects', sanitized, 'memory');
    mkdirSync(memoryRoot, { recursive: true });
    return memoryRoot;
  } catch (err) {
    console.warn(
      `Babel memory: failed to resolve memory root for "${projectRoot}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ─── Frontmatter Parsing ───────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse YAML-style frontmatter from a markdown string.
 * Supports flat keys (key: value) and nested blocks via indentation (metadata:\n  type: foo).
 * Returns { frontmatter, body } or null if frontmatter is missing/invalid.
 */
export function parseMemoryFrontmatter(
  raw: string,
): { frontmatter: MemoryFrontmatter; body: string } | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;

  const rawFrontmatter = match[1] ?? '';
  const body = raw.slice(match[0].length);

  // Parse frontmatter building a nested object from indented YAML
  const parsed = parseYamlLines(rawFrontmatter);

  // Promote inline `type:` to metadata.type when metadata block is absent
  if (typeof parsed['type'] === 'string' && typeof parsed['metadata'] !== 'object') {
    parsed['metadata'] = { type: parsed['type'] };
  }

  // Ensure metadata is always an object for Zod validation
  if (typeof parsed['metadata'] !== 'object' || parsed['metadata'] === null) {
    parsed['metadata'] = {};
  }

  const result = MemoryFrontmatterSchema.safeParse(parsed);
  if (!result.success) return null;

  return { frontmatter: result.data, body };
}

/**
 * Minimal YAML line parser. Supports:
 *   - key: value
 *   - key:        (starts a nested block)
 *     subkey: value  (children at increased indent)
 *
 * Does NOT support arrays, quoted strings with colons, or multi-line scalars.
 * Returns a shallow Record<string, unknown> where nested blocks produce nested
 * Record<string, string> values.
 */
function parseYamlLines(raw: string): Record<string, unknown> {
  const lines = raw.split('\n');
  const result: Record<string, unknown> = {};
  // Track active parent key for indented (nested) children
  let activeParent: string | null = null;
  let parentIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    // Calculate indent level (number of leading spaces)
    const indent = line.length - line.trimStart().length;

    // Strip leading spaces for key matching, but track indent separately
    const content = line.trimStart();
    // Check if this is a key-value pair: `key: value` or `key:`
    const kvMatch = content.match(/^([\w-]+):(?:\s+(.*))?$/);
    if (!kvMatch) continue;

    const key = kvMatch[1]!;
    const value = (kvMatch[2] ?? '').trim();

    if (indent > 0 && activeParent !== null && indent > parentIndent) {
      // This is an indented child of the active parent
      const parent = result[activeParent];
      if (typeof parent === 'object' && parent !== null && !Array.isArray(parent)) {
        (parent as Record<string, string>)[key] = value;
      }
    } else {
      // Top-level key
      if (value.length === 0) {
        // Start a nested block — next indented lines belong here
        result[key] = {};
        activeParent = key;
        parentIndent = indent;
      } else {
        result[key] = value;
        activeParent = null;
        parentIndent = -1;
      }
    }
  }

  return result;
}

// ─── File Path Utilities ──────────────────────────────────────────────────

/**
 * Build an absolute file path inside the memory directory.
 */
function memoryFilePath(memoryRoot: string, name: string): string {
  return join(memoryRoot, `${name}.md`);
}

/**
 * Build the path to the MEMORY.md index file.
 */
function indexFilePath(memoryRoot: string): string {
  return join(memoryRoot, MEMORY_INDEX_NAME);
}

// ─── Read Operations ──────────────────────────────────────────────────────

/**
 * Scan the memory directory for all .md files and parse their frontmatter.
 * Excludes MEMORY.md itself (the index file).
 * Returns an empty array on error or empty directory.
 */
export function scanMemoryDirectory(memoryRoot: string): MemoryFile[] {
  try {
    const entries = readdirSync(memoryRoot, { withFileTypes: true });
    const results: MemoryFile[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === MEMORY_INDEX_NAME) continue;
      if (!entry.name.endsWith('.md')) continue;

      const fullPath = join(memoryRoot, entry.name);
      try {
        const raw = readFileSync(fullPath, 'utf-8');
        const parsed = parseMemoryFrontmatter(raw);
        if (!parsed) continue;

        const st = statSync(fullPath);
        results.push({
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          path: entry.name,
          mtime: st.mtime,
        });
      } catch {
        // Skip unreadable files
        continue;
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Read and parse the MEMORY.md index file.
 * Returns an empty index if the file does not exist or is malformed.
 */
export function readMemoryIndex(memoryRoot: string): MemoryIndex {
  const indexPath = indexFilePath(memoryRoot);
  return readIndex(indexPath);
}

/**
 * Find a memory file by its name/slug.
 * Returns null if not found or on error.
 */
export function findByName(memoryRoot: string, name: string): MemoryFile | null {
  try {
    const path = memoryFilePath(memoryRoot, name);
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseMemoryFrontmatter(raw);
    if (!parsed) return null;

    const st = statSync(path);
    return {
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      path: `${name}.md`,
      mtime: st.mtime,
    };
  } catch {
    return null;
  }
}

// ─── Write Operations ─────────────────────────────────────────────────────

/**
 * Write-time validation reuses the read schema's name regex to prevent
 * silent data loss: a memory written with a non-kebab-case name would be
 * invisible to scanMemoryDirectory() on the next session.
 */
const FrontmatterWriteSchema = z.object({
  name: MemoryFrontmatterSchema.shape.name,
  description: MemoryFrontmatterSchema.shape.description,
  metadata: MemoryFrontmatterSchema.shape.metadata,
});

export type FrontmatterWriteInput = z.infer<typeof FrontmatterWriteSchema>;

/**
 * Write (create or update) a memory file and update the MEMORY.md index.
 * Creates the memory directory if it does not exist.
 * Returns true on success, false on failure.
 */
export function writeMemory(
  memoryRoot: string,
  input: FrontmatterWriteInput,
  body: string,
): boolean {
  const parsed = FrontmatterWriteSchema.safeParse(input);
  if (!parsed.success) return false;

  const { name, description, metadata } = parsed.data;
  const filePath = memoryFilePath(memoryRoot, name);

  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'metadata:',
    `  type: ${metadata.type}`,
    '---',
    '',
  ].join('\n');

  try {
    mkdirSync(memoryRoot, { recursive: true });
    writeFileSync(filePath, frontmatter + body, 'utf-8');

    // Update MEMORY.md index
    updateIndexEntry(memoryRoot, {
      name,
      file: `${name}.md`,
      description,
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a memory file by its name/slug and remove its entry from MEMORY.md.
 * Returns true on success, false if the file doesn't exist or on error.
 */
export function deleteMemory(memoryRoot: string, name: string): boolean {
  const filePath = memoryFilePath(memoryRoot, name);
  try {
    if (statSync(filePath).isFile()) {
      unlinkSync(filePath);
    }
    removeIndexEntry(memoryRoot, name);
    return true;
  } catch {
    return false;
  }
}
