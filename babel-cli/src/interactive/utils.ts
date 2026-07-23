// ─── Utility Helpers ──────────────────────────────────────────────────────────
// Extracted from interactive.ts — pure helper functions with no class state
// dependencies: fuzzy matching, run listing, multi-line input helpers.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';
import { dim } from '../ui/theme.js';
import { INTERACTIVE_COMMAND_COMPLETIONS } from './types.js';

// ─── Run Directory Helpers ────────────────────────────────────────────────────

export function getRecentRuns(limit = 5): string[] {
  try {
    if (!fs.existsSync(BABEL_RUNS_DIR)) return [];
    return fs
      .readdirSync(BABEL_RUNS_DIR)
      .filter((d) => fs.statSync(path.join(BABEL_RUNS_DIR, d)).isDirectory())
      .sort()
      .reverse()
      .slice(0, limit)
      .map((d) => path.join(BABEL_RUNS_DIR, d));
  } catch {
    return [];
  }
}

export function userStatusForRun(status: string): 'complete' | 'blocked' | 'failed' {
  if (status === 'COMPLETE' || status === 'COMPLETE_NO_MODIFICATION' || status === 'PLAN_READY') {
    return 'complete';
  }
  if (/FAILED|FATAL|ERROR/i.test(status)) {
    return 'failed';
  }
  return 'blocked';
}

// ─── Fuzzy Command Matching ───────────────────────────────────────────────────

function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;

  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  const prev = Array.from({ length: bLen + 1 }, (_, i) => i);
  const curr = new Array<number>(bLen + 1);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= bLen; j++) {
      prev[j] = curr[j] ?? 0;
    }
  }

  return prev[bLen] ?? 0;
}

export function findClosestCommands(
  input: string,
  maxDistance: number = 2,
  maxResults: number = 3,
): string[] {
  if (!input || input.length < 2) return [];

  const known = INTERACTIVE_COMMAND_COMPLETIONS.map((c) =>
    c.replace(/^\/\w+\s.*$/, c.split(' ')[0]!),
  ).filter((c, i, arr) => c && arr.indexOf(c) === i);

  const scored = known
    .map((cmd) => {
      const name = cmd.startsWith('/') ? cmd.slice(1) : cmd;
      return { cmd, dist: levenshteinDistance(input, name) };
    })
    .filter((s) => s.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist);

  return scored.slice(0, maxResults).map((s) => s.cmd);
}

// ─── Multi-line Input Helpers ─────────────────────────────────────────────────

export function hasUnclosedBraces(line: string): boolean {
  let depth = 0;
  for (const ch of line) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
  }
  return depth > 0;
}

export { openEditor } from './openEditor.js';
