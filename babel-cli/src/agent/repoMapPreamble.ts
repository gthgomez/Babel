/**
 * Compact repository map injected into the chat system prompt (R4 / L17).
 * Pure helper so unit tests can cover the preamble without spinning ChatEngine.
 *
 * Primary path (packet B1): tree-sitter + personalized PageRank repo map under
 * a token budget (services/repoMap/graph.ts, algorithm ported from Aider,
 * Apache-2.0). The legacy directory-listing preamble remains the fallback
 * when the graph pipeline fails (no parseable files, repo over the size cap).
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildRepoMapGraph } from '../services/repoMap/graph.js';

export interface RepoMapPreambleOptions {
  /** Token budget for the rendered map (default 1_000; expanded when no seeds). */
  budgetTokens?: number;
  /** Absolute paths of files currently in chat context (PageRank seeds). */
  seedFiles?: string[];
  /** Identifiers mentioned in chat that boost matching symbols. */
  mentionedIdents?: Set<string>;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'runs',
  'artifacts',
  'runtime',
  '.claude',
  '.cursor',
  'coverage',
  '.nyc_output',
  'tmp',
]);

function isKeyConfigFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'package.json' ||
    lower === 'tsconfig.json' ||
    lower === 'claude.md' ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower === '.gitignore' ||
    lower === 'dockerfile' ||
    lower === 'makefile' ||
    lower.endsWith('.toml') ||
    lower.endsWith('.cfg')
  );
}

/** Repos with more source files than this use the legacy preamble. */
const REPO_MAP_FILE_CAP = 4_000;

const SEED_PATH_PATTERN = /[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go)\b/g;

/**
 * Collect source-file paths referenced in the chat conversation so far —
 * these seed the personalized PageRank (Aider "files in chat" behavior).
 */
export function collectChatSeedFiles(
  conversation: ReadonlyArray<{ content: unknown }>,
  projectRoot: string,
): string[] {
  const seeds = new Set<string>();
  for (const message of conversation) {
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content) continue;
    for (const match of content.matchAll(SEED_PATH_PATTERN)) {
      const candidate = match[0].replace(/\\/g, '/');
      // Only repo-relative paths count; strip a leading ./ or project prefix.
      const normalized = candidate.replace(/^\.\//, '');
      if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
        const rel = normalized.toLowerCase().replace(/\\/g, '/').split('/').pop();
        void rel; // absolute paths outside the root are ignored below
        continue;
      }
      if (normalized.includes('/') || existsSync(join(projectRoot, normalized))) {
        seeds.add(normalized);
      }
    }
  }
  return [...seeds].slice(0, 64);
}

export async function buildRepoMapPreamble(
  projectRoot: string,
  options: RepoMapPreambleOptions = {},
): Promise<string> {
  // Primary: tree-sitter + PageRank map under a token budget. When no files
  // are seeded from chat, expand the budget (Aider behavior) so the map still
  // orients the model.
  const seedCount = options.seedFiles?.length ?? 0;
  const budget =
    options.budgetTokens ?? (seedCount > 0 ? 1_000 : 2_000);
  try {
    const graphMap = await buildRepoMapGraph(projectRoot, {
      budgetTokens: budget,
      maxFiles: REPO_MAP_FILE_CAP,
      ...(options.seedFiles ? { seedFiles: options.seedFiles } : {}),
      ...(options.mentionedIdents ? { mentionedIdents: options.mentionedIdents } : {}),
    });
    if (graphMap && graphMap.map.trim().length > 0) {
      return graphMap.map.trimEnd();
    }
  } catch {
    // Fall through to legacy directory-listing preamble.
  }
  return buildLegacyRepoMapPreamble(projectRoot);
}

/**
 * Legacy fallback preamble: top-level dirs + config files + npm scripts.
 */
export async function buildLegacyRepoMapPreamble(projectRoot: string): Promise<string> {
  try {
    let topDirs: string[] = [];
    let keyFiles: string[] = [];

    try {
      const entries = await readdir(projectRoot, { withFileTypes: true });
      topDirs = entries
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
        .map((e) => `${e.name}/`)
        .sort();
      keyFiles = entries
        .filter((e) => e.isFile() && !SKIP_DIRS.has(e.name))
        .filter((e) => isKeyConfigFile(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      // readdir failed — use empty lists
    }

    const lines: string[] = ['## Repository Map'];
    if (topDirs.length > 0) {
      lines.push(`- Top-level: ${topDirs.join(' ')}`);
    }
    if (keyFiles.length > 0) {
      lines.push(`- Key files: ${keyFiles.join(', ')}`);
    }
    const testDirs = topDirs.filter((d) => /test/i.test(d));
    if (testDirs.length > 0) {
      lines.push(`- Tests: ${testDirs.join(' ')}`);
    }

    try {
      const pkgPath = join(projectRoot, 'package.json');
      if (existsSync(pkgPath)) {
        const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8')) as Record<string, unknown>;
        const scripts = pkgJson['scripts'] as Record<string, string> | undefined;
        if (scripts) {
          if (scripts['build']) lines.push('- Build: npm run build');
          if (scripts['test']) lines.push('- Test: npm test');
          if (scripts['typecheck']) lines.push('- TypeCheck: npm run typecheck');
        }
      }
    } catch {
      // Best-effort
    }

    try {
      const tsconfigPath = join(projectRoot, 'tsconfig.json');
      if (existsSync(tsconfigPath)) {
        const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        const compilerOptions = tsconfig['compilerOptions'] as Record<string, unknown> | undefined;
        if (compilerOptions && compilerOptions['strict'] === true) {
          lines.push('- TypeScript strict mode: true');
        }
      }
    } catch {
      // Best-effort
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}
