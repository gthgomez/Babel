// ─── P-4.2 / Gap-2: BABEL.md Project Memory ──────────────────────────
//
// BABEL.md is the Babel analogue of Claude Code's CLAUDE.md — a persistent
// per-repo file that records build/test commands, conventions, and known
// pitfalls. Read once at engine construction and injected into the system
// prompt so the model has project-specific context before the first turn.
//
// After successful runs with writes, propose candidate learnings in
// BABEL.md.proposed (user-reviewable — never auto-merge into BABEL.md).
//
// Gap 2: structured memory directory (~/.babel/projects/{sanitized-git-root}/memory/)
// with typed memories and relevance search. New sessions prefer the memory
// directory; fall back to BABEL.md when the directory is empty.

import { join } from 'node:path';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

import {
  resolveMemoryRoot,
  scanMemoryDirectory,
} from './memory/memoryStore.js';
import {
  findRelevantMemories,
  formatRelevantMemoriesSection,
} from './memory/memoryRelevance.js';
import { DEFAULT_MAX_RELEVANT_MEMORIES } from './memory/memoryTypes.js';

export const BABEL_MD_NAME = 'BABEL.md';
export const BABEL_MD_PROPOSED_NAME = 'BABEL.md.proposed';

/**
 * Read the BABEL.md project memory file from the project root.
 *
 * Returns a system-prompt-ready string with a markdown header, or null
 * if the file does not exist or is empty. Never throws — filesystem
 * errors are silently swallowed and null is returned.
 */
export function readProjectMemory(projectRoot: string): string | null {
  try {
    const path = join(projectRoot, BABEL_MD_NAME);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').trim();
    if (raw.length === 0) return null;
    return `## Project Memory (BABEL.md)\n${raw}`;
  } catch {
    return null;
  }
}

/**
 * Read structured project memory from the typed memory directory with
 * fallback to BABEL.md.
 *
 * Resolution order:
 *   1. Memory directory (~/.babel/projects/{sanitized-git-root}/memory/)
 *      — scan for relevant memories based on task context
 *   2. BABEL.md (legacy single-file format) — when directory is empty or absent
 *
 * Returns a system-prompt-ready markdown section, or null if no memory is found.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskDescription - Current task text for relevance matching
 */
export function readProjectMemoryStructured(
  projectRoot: string,
  taskDescription?: string,
): string | null {
  const memoryRoot = resolveMemoryRoot(projectRoot);
  if (!memoryRoot) {
    // Fall back to BABEL.md
    return readProjectMemory(projectRoot);
  }

  const memories = scanMemoryDirectory(memoryRoot);

  if (memories.length === 0) {
    // Directory exists but is empty — fall back to BABEL.md
    return readProjectMemory(projectRoot);
  }

  // If we have a task description, do relevance search
  if (taskDescription && taskDescription.trim().length > 0) {
    const relevant = findRelevantMemories(memoryRoot, taskDescription);
    if (relevant.length > 0) {
      return formatRelevantMemoriesSection(relevant);
    }
    // No relevant memories found — return all memories summary as fallback
    return formatAllMemoriesSummary(memories);
  }

  // No task context — return all memories summary
  return formatAllMemoriesSummary(memories);
}

/**
 * Format a summary of all available memories when no task context is provided.
 */
/** Max characters for a single memory description in the summary. */
const MAX_DESCRIPTION_LENGTH = 120;

function formatAllMemoriesSummary(
  memories: Array<{ frontmatter: { name: string; description: string; metadata: { type: string } } }>,
): string {
  const lines = ['## Project Memory', ''];
  const capped = memories.slice(0, DEFAULT_MAX_RELEVANT_MEMORIES);
  for (const memory of capped) {
    const desc = memory.frontmatter.description.length > MAX_DESCRIPTION_LENGTH
      ? memory.frontmatter.description.slice(0, MAX_DESCRIPTION_LENGTH) + '…'
      : memory.frontmatter.description;
    lines.push(`- **${memory.frontmatter.name}** ([${memory.frontmatter.metadata.type}]): ${desc}`);
  }
  if (memories.length > DEFAULT_MAX_RELEVANT_MEMORIES) {
    lines.push(`_… and ${memories.length - DEFAULT_MAX_RELEVANT_MEMORIES} more_`);
  }
  lines.push('');
  lines.push(`_${memories.length} memory(s) available. Use a task description for relevance matching._`);
  return lines.join('\n');
}

export interface MemoryWritebackInput {
  projectRoot: string;
  /** Short task summary or first user message */
  taskSummary: string;
  /** Paths successfully mutated this session */
  changedFiles: string[];
  /** Optional last verifier command + exit code */
  verifierSummary?: string | null;
  /** ISO timestamp override (tests) */
  nowIso?: string;
}

export interface MemoryWritebackResult {
  wrote: boolean;
  path: string | null;
  reason?: string;
}

/**
 * Sanitize free-form text before writing into BABEL.md.proposed.
 * Strips control chars, collapses whitespace, redacts obvious secret-like tokens.
 * Exported for unit tests.
 */
export function sanitizeMemoryText(raw: string, maxLen: number): string {
  let text = raw
    // eslint-disable-next-line no-control-regex -- intentional control-char strip
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Redact common secret-shaped tokens (not exhaustive — user still reviews proposals)
  text = text
    .replace(/\b(sk|pk|rk|api|token|secret|password|passwd|bearer)[-_]?[A-Za-z0-9]{8,}\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}={0,2}\b/g, (m) =>
      /[A-Za-z]/.test(m) && /\d/.test(m) ? '[redacted]' : m,
    );
  if (text.length > maxLen) text = text.slice(0, maxLen);
  return text;
}

/**
 * Heuristic candidates worth human review — not a model call.
 * Keeps write-back cheap and deterministic.
 */
export function buildMemoryCandidates(input: MemoryWritebackInput): string[] {
  const lines: string[] = [];
  const files = input.changedFiles.filter(Boolean).slice(0, 12);
  if (files.length === 0) return lines;

  const task = sanitizeMemoryText(input.taskSummary, 200);
  if (task) {
    lines.push(`- Task context: ${task}`);
  }
  lines.push(`- Touched files: ${files.map((f) => `\`${f}\``).join(', ')}`);
  if (input.verifierSummary) {
    const v = sanitizeMemoryText(input.verifierSummary, 160);
    if (v) lines.push(`- Verifier: ${v}`);
  }
  return lines;
}

/**
 * Append a dated proposal block to BABEL.md.proposed under projectRoot.
 * Never mutates BABEL.md itself. Disable with BABEL_MEMORY_WRITEBACK=0.
 */
export function proposeProjectMemoryWriteback(
  input: MemoryWritebackInput,
): MemoryWritebackResult {
  if (process.env['BABEL_MEMORY_WRITEBACK'] === '0' || process.env['BABEL_MEMORY_WRITEBACK'] === 'false') {
    return { wrote: false, path: null, reason: 'disabled' };
  }

  const candidates = buildMemoryCandidates(input);
  if (candidates.length === 0) {
    return { wrote: false, path: null, reason: 'no_candidates' };
  }

  const outPath = join(input.projectRoot, BABEL_MD_PROPOSED_NAME);
  const stamp = input.nowIso ?? new Date().toISOString();
  const block = [
    '',
    `## Proposed ${stamp}`,
    '',
    '_Review and merge into BABEL.md manually. Auto-written by Babel after a successful run._',
    '',
    ...candidates,
    '',
  ].join('\n');

  try {
    mkdirSync(input.projectRoot, { recursive: true });
    if (existsSync(outPath)) {
      appendFileSync(outPath, block, 'utf8');
    } else {
      writeFileSync(
        outPath,
        `# BABEL.md proposals\n\nUser-reviewable learnings from successful Babel runs.\n${block}`,
        'utf8',
      );
    }
    return { wrote: true, path: outPath };
  } catch {
    return { wrote: false, path: null, reason: 'io_error' };
  }
}
