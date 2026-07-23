/**
 * pathScanner.ts — VCS Pre-Flight Context Scanner
 *
 * Implements the Virtual Context Sandbox (VCS) workspace resolver.
 * Given a free-form task string and a starting directory, this module:
 *
 *   1. Extracts candidate folder-name tokens from the task text.
 *   2. Searches approved workspace roots (up to depth 2) for case-insensitive
 *      matches against those tokens.
 *   3. If exactly one match is found, returns it immediately.
 *   4. If multiple matches are found AND the process is attached to a TTY,
 *      presents a numbered readline menu so the user can pick the right target.
 *   5. Returns null if no match is found (caller keeps the default startPath).
 *
 * Design constraints:
 *   - Never calls process.chdir(). The resolved path is returned and injected
 *     as `anchorPath` into AgentSessionOptions.
 *   - Only reads directories — no file I/O, no mutations.
 *   - Depth-limited (max 2 levels) to stay fast on large workspaces.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import * as readline from 'node:readline/promises';

// ─── Approved workspace roots ─────────────────────────────────────────────────

/**
 * Returns the list of approved workspace roots from the environment variable
 * `BABEL_OPENCLAW_APPROVED_ROOTS` (comma-separated), falling back to the
 * default `/tmp` on Windows.
 */
function getApprovedRoots(): string[] {
  const fromEnv = process.env['BABEL_OPENCLAW_APPROVED_ROOTS']?.trim();
  if (fromEnv) {
    return fromEnv
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return process.platform === 'win32' ? ['/tmp'] : [process.env['HOME'] ?? '/home'];
}

// ─── Token extraction ─────────────────────────────────────────────────────────

/**
 * Extracts potential folder-name tokens from a task string.
 * Strips common stop-words and punctuation, keeping tokens that look like
 * they could be directory names (≥ 2 chars, no spaces, not pure numbers).
 */
export function extractFolderTokens(task: string): string[] {
  const STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'if',
    'is',
    'are',
    'was',
    'in',
    'on',
    'of',
    'for',
    'to',
    'with',
    'this',
    'that',
    'it',
    'its',
    'be',
    'do',
    'run',
    'check',
    'fix',
    'new',
    'old',
    'get',
    'set',
    'use',
    'make',
    'have',
    'has',
    'had',
    'not',
    'but',
    'so',
    'by',
    'at',
    'from',
    'as',
    'into',
    'our',
    'we',
    'my',
    'your',
    'babel',
    'cli',
    'file',
    'files',
    'folder',
    'folders',
    'directory',
    'repo',
    'git',
  ]);

  return task
    .split(/[\s,;:"'`()[\]{}\\/|?!.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP_WORDS.has(t.toLowerCase()));
}

// ─── Fuzzy directory search ───────────────────────────────────────────────────

/**
 * Scans a single root directory up to `maxDepth` levels deep and collects
 * any subdirectory whose basename matches one of `tokens` (case-insensitive,
 * substring match).
 */
function scanRoot(root: string, tokens: string[], maxDepth = 2, currentDepth = 0): string[] {
  if (currentDepth > maxDepth || !existsSync(root)) {
    return [];
  }

  const matches: string[] = [];
  let entries: string[];

  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const fullPath = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }

    if (!isDir) continue;

    const lowerEntry = entry.toLowerCase();
    const isMatch = tokens.some(
      (token) => lowerEntry === token.toLowerCase() || lowerEntry.includes(token.toLowerCase()),
    );
    if (isMatch) {
      matches.push(fullPath);
    }

    // Only recurse if not already a match, to avoid flooding results
    if (!isMatch && currentDepth < maxDepth) {
      matches.push(...scanRoot(fullPath, tokens, maxDepth, currentDepth + 1));
    }
  }

  return matches;
}

// ─── TTY disambiguation menu ──────────────────────────────────────────────────

/**
 * Presents a numbered list of candidate directories to the user via stderr,
 * and waits for them to pick one. Returns the selected path, or null if the
 * user skips (enters 0 or invalid input).
 */
async function promptUserForDirectory(candidates: string[]): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    // Non-interactive: default to the first candidate
    process.stderr.write(
      `[VCS] Multiple target directories found. Using first match: ${candidates[0]}\n`,
    );
    return candidates[0] ?? null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    process.stderr.write(
      '\n[VCS] Multiple project directories match your task. Select a target:\n',
    );
    candidates.forEach((dir, idx) => {
      process.stderr.write(`  ${idx + 1}. ${dir}\n`);
    });
    process.stderr.write(`  0. Skip — use the current directory\n`);
    process.stderr.write('\nEnter number: ');

    const answer = (await rl.question('')).trim();
    const choice = parseInt(answer, 10);

    if (Number.isNaN(choice) || choice === 0 || choice > candidates.length) {
      process.stderr.write('[VCS] No selection made. Using current directory.\n');
      return null;
    }

    const selected = candidates[choice - 1];
    process.stderr.write(`[VCS] Context locked to: ${selected}\n`);
    return selected ?? null;
  } finally {
    rl.close();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface FuzzyResolveResult {
  /** The resolved anchor path, or null if none matched. */
  anchorPath: string | null;
  /** All candidate directories found during the scan. */
  candidates: string[];
  /** The tokens extracted from the task text. */
  tokens: string[];
}

/**
 * Resolves the most likely target workspace directory for a task.
 *
 * @param task       The user's task text (free-form).
 * @param startPath  The directory Babel was launched from (process.cwd() at boot).
 * @returns          The resolved anchor path (absolute), or null if no match.
 */
export async function resolveFuzzyWorkspaceDirectory(
  task: string,
  startPath: string,
): Promise<FuzzyResolveResult> {
  const tokens = extractFolderTokens(task);
  if (tokens.length === 0) {
    return { anchorPath: null, candidates: [], tokens };
  }

  const approvedRoots = getApprovedRoots();
  const allCandidates: string[] = [];

  for (const root of approvedRoots) {
    const found = scanRoot(root, tokens);
    allCandidates.push(...found);
  }

  // De-duplicate (case-insensitive on Windows)
  const seen = new Set<string>();
  const uniqueCandidates = allCandidates.filter((c) => {
    const key = process.platform === 'win32' ? c.toLowerCase() : c;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (uniqueCandidates.length === 0) {
    return { anchorPath: null, candidates: [], tokens };
  }

  if (uniqueCandidates.length === 1) {
    const anchor = resolve(uniqueCandidates[0]!);
    process.stderr.write(`[VCS] Context locked to: ${anchor}\n`);
    return { anchorPath: anchor, candidates: uniqueCandidates, tokens };
  }

  // Multiple matches: prefer exact basename match, then prompt
  const exactMatch = uniqueCandidates.find((c) =>
    tokens.some((t) => basename(c).toLowerCase() === t.toLowerCase()),
  );

  if (exactMatch) {
    const anchor = resolve(exactMatch);
    process.stderr.write(`[VCS] Context locked to (exact match): ${anchor}\n`);
    return { anchorPath: anchor, candidates: uniqueCandidates, tokens };
  }

  const selected = await promptUserForDirectory(uniqueCandidates);
  return {
    anchorPath: selected !== null ? resolve(selected) : null,
    candidates: uniqueCandidates,
    tokens,
  };
}
