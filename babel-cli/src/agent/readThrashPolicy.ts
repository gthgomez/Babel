/**
 * Read-thrash fuse + full-file re-read limits.
 * Pure helpers; path normalization is the only FS-facing concern (no I/O here).
 */

import { isDirectMutationTool } from './mutationTools.js';

const READ_TOOLS = new Set(['read_file', 'read_range']);

export function isReadExplorationTool(tool: string): boolean {
  return READ_TOOLS.has(tool) || tool === 'grep' || tool === 'glob' || tool === 'semantic_search' || tool === 'list_dir';
}

const SHELL_THRASH_TOOLS = new Set(['run_command', 'shell_exec', 'test_run', 'await_command']);

/**
 * Tools that count against the exploration fuse budget.
 * Read/search always count. When the session still has zero successful
 * mutations, shell/verifier tools also count — pure run_command thrash
 * must not bypass the fuse (SWE-A08 zero-write smoke class).
 */
export function isExplorationBudgetTool(
  tool: string,
  hasSuccessfulWrites: boolean,
): boolean {
  if (isReadExplorationTool(tool)) return true;
  if (!hasSuccessfulWrites && SHELL_THRASH_TOOLS.has(tool)) return true;
  return false;
}

/**
 * Normalize path keys so absolute/relative and slash variants share one cache slot.
 */
export function normalizeReadCacheKey(filePath: string, projectRoot?: string): string {
  let p = filePath.trim().replace(/\\/g, '/');
  if (!p) return p;
  // Strip file:// prefix
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // /C:/... → C:/...
  }
  // Lowercase Windows drive letters
  if (/^[A-Za-z]:\//.test(p)) {
    p = p[0]!.toLowerCase() + p.slice(1);
  }
  // If relative and projectRoot given, join for stable key
  if (projectRoot && !/^[A-Za-z]:\//.test(p) && !p.startsWith('/')) {
    const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const rootKey = /^[A-Za-z]:\//.test(root) ? root[0]!.toLowerCase() + root.slice(1) : root;
    p = `${rootKey}/${p}`.replace(/\/+/g, '/');
  }
  // Collapse /./ segments lightly
  p = p.replace(/\/\.\//g, '/');
  // Case-fold for Windows-ish absolute paths
  if (/^[A-Za-z]:\//.test(p) || p.includes('/Workspace/') || p.includes('/workspace/')) {
    p = p.toLowerCase();
  }
  return p;
}

/**
 * After a tool executes: update consecutive read-only counter.
 * Mutations reset; read/search increment; zero-write shell thrash increments;
 * other tools leave count unchanged.
 */
export function nextReadOnlyStreak(
  current: number,
  tool: string,
  opts?: { error?: string; hasSuccessfulWrites?: boolean },
): number {
  if (isDirectMutationTool(tool) && opts?.error !== 'blocked' && opts?.error !== 'error') {
    return 0;
  }
  // sub_agent with changes is handled by caller as mutation
  if (tool === 'sub_agent' && opts?.error !== 'blocked') {
    // detail "N changed" handled by caller if needed
  }
  const hasWrites = opts?.hasSuccessfulWrites === true;
  if (isExplorationBudgetTool(tool, hasWrites)) {
    return current + 1;
  }
  return current;
}

export function shouldFireReadThrashFuse(opts: {
  executeIntent: boolean;
  consecutiveReadOnlyTools: number;
  budget: number;
}): boolean {
  if (!opts.executeIntent) return false;
  if (opts.budget <= 0) return false;
  return opts.consecutiveReadOnlyTools >= opts.budget;
}

export function buildReadThrashFuseMessage(consecutive: number): string {
  return [
    `READ_THRASH FUSE: ${consecutive} reads without writing. You have enough information.`,
    '',
    'Do NOT read any more files. You understand the bug — apply the fix:',
    '',
    '1. Use str_replace on the file you have been reading',
    '2. Make the minimal code change (typically 1-5 lines)',
    '3. After the patch succeeds, verify with the test command',
    '',
    'If you read again instead of editing, the run will be BLOCKED.',
  ].join('\n');
}

export function shouldSkipFullReread(opts: {
  fullReadCount: number;
  maxFullReads: number;
}): boolean {
  return opts.fullReadCount >= opts.maxFullReads;
}

export function buildFullRereadSkipObservation(
  target: string,
  fullReadCount: number,
  maxFullReads: number,
): string {
  return (
    `### read_file ${target}\nexit_code: 0\n\`\`\`\n` +
    `READ_LIMIT: this file has already been read ${fullReadCount}/${maxFullReads} times. ` +
    `You have the content in context. Do NOT try to read it again. ` +
    `Apply your fix with str_replace now.\n\`\`\``
  );
}
