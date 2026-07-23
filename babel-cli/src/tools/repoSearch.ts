import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

import { collectTextFiles, type SearchHit } from '../services/indexer.js';
import { extractFolderTokens } from '../services/pathScanner.js';
import {
  detectRipgrep,
  ripgrep,
  rgGlobFiles,
  rgListFiles,
  sortPathsByDepth,
  type RipgrepOptions,
} from './ripgrep.js';

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepContentOptions {
  path?: string;
  maxMatches?: number;
  ignoreCase?: boolean;
  contextLines?: number;
}

const DEFAULT_MAX_GREP_MATCHES = 50;
const DEFAULT_MAX_GLOB_PATHS = 100;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let regex = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? '';
    if (char === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') {
      regex += '[^/]*';
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      continue;
    }
    regex += escapeRegExp(char);
  }
  return new RegExp(`${regex}$`);
}

function compileGrepPattern(pattern: string, ignoreCase = false): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid grep pattern "${pattern}": ${message}`);
  }
}

export function getApprovedReadRoots(projectRoot: string): string[] {
  const envVal =
    process.env['BABEL_OPENCLAW_APPROVED_ROOTS'] || process.env['BABEL_ALLOWED_ROOTS'] || '';
  const roots = envVal
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      try {
        if (existsSync(r)) {
          return realpathSync(r);
        }
      } catch (err) {
        // Phase 2b: Log the error instead of silently swallowing it.
        // Filesystem errors (NFS, permissions, corruption) should be visible.
        if (process.env['BABEL_DEBUG']) {
          console.warn(
            `[repoSearch] Failed to resolve approved read root "${r}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return null;
    })
    .filter((r): r is string => r !== null);

  let resolvedProjRoot = projectRoot;
  try {
    if (existsSync(projectRoot)) {
      resolvedProjRoot = realpathSync(projectRoot);
    }
  } catch (err) {
    if (process.env['BABEL_DEBUG']) {
      console.warn(
        `[repoSearch] Failed to resolve project root "${projectRoot}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const seen = new Set<string>([resolvedProjRoot]);
  const uniqueRoots: string[] = [];
  for (const r of roots) {
    if (!seen.has(r)) {
      seen.add(r);
      uniqueRoots.push(r);
    }
  }
  return uniqueRoots;
}

export async function grepContent(
  projectRoot: string,
  pattern: string,
  options: GrepContentOptions = {},
  approvedReadRoots?: string[],
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const root = resolve(projectRoot);

  // Try ripgrep first when available (much faster)
  if (detectRipgrep()) {
    const rgOptions: RipgrepOptions = {
      pattern,
      maxMatches: Math.max(1, options.maxMatches ?? DEFAULT_MAX_GREP_MATCHES),
      ...(options.ignoreCase !== undefined ? { ignoreCase: options.ignoreCase } : {}),
      ...(options.contextLines !== undefined ? { contextLines: options.contextLines } : {}),
    };
    if (options.path) {
      rgOptions.glob = options.path.endsWith('/**') ? options.path : `${options.path}/**`;
    }
    rgOptions.paths = [root];
    if (approvedReadRoots && approvedReadRoots.length > 0) {
      rgOptions.paths.push(...approvedReadRoots);
    }
    try {
      const result = await ripgrep(root, rgOptions);
      return {
        matches: result.matches.map((m) => ({
          path: relative(root, m.path).replace(/\\/g, '/'),
          line: m.line,
          text: m.text.slice(0, 200).replace(/\n$/, ''),
        })),
        truncated: result.truncated,
      };
    } catch {
      // Fall through to pure-JS fallback
    }
  }

  // Pure-JS fallback
  const regex = compileGrepPattern(pattern, options.ignoreCase === true);
  const maxMatches = Math.max(1, options.maxMatches ?? DEFAULT_MAX_GREP_MATCHES);
  const pathPrefix = options.path?.replace(/\\/g, '/').replace(/^\.\//, '');
  const matches: GrepMatch[] = [];

  const task = process.env['BABEL_TASK'] || '';
  const taskTokens = task ? extractFolderTokens(task) : undefined;

  const scanDirs =
    approvedReadRoots && approvedReadRoots.length > 0 ? [root, ...approvedReadRoots] : root;

  const collectOptions: {
    projectRoot: string;
    maxDepth?: number;
    taskTokens?: string[];
  } = {
    projectRoot,
    ...(taskTokens ? { taskTokens } : {}),
  };

  for (const filePath of await collectTextFiles(scanDirs, [], collectOptions)) {
    const relativePath = relative(root, filePath).replace(/\\/g, '/');
    if (pathPrefix && !relativePath.startsWith(pathPrefix)) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      if (!regex.test(line)) {
        continue;
      }
      matches.push({
        path: relativePath,
        line: lineIndex + 1,
        text: line.trim().slice(0, 200),
      });
      if (matches.length >= maxMatches) {
        return { matches, truncated: true };
      }
    }
  }

  return { matches, truncated: false };
}

export async function globPaths(
  projectRoot: string,
  pattern: string,
  maxPaths = DEFAULT_MAX_GLOB_PATHS,
  approvedReadRoots?: string[],
): Promise<string[]> {
  const root = resolve(projectRoot);
  const limit = Math.max(1, maxPaths);

  // Try ripgrep --files --glob when available (much faster)
  if (detectRipgrep()) {
    try {
      // rgGlobFiles already sorts by depth then alpha before truncation
      return rgGlobFiles(root, pattern, limit).paths;
    } catch {
      // Fall through to pure-JS fallback
    }
  }

  // Pure-JS fallback
  const regex = globPatternToRegExp(pattern.replace(/\\/g, '/'));
  const paths: string[] = [];

  const task = process.env['BABEL_TASK'] || '';
  const taskTokens = task ? extractFolderTokens(task) : undefined;

  const scanDirs =
    approvedReadRoots && approvedReadRoots.length > 0 ? [root, ...approvedReadRoots] : root;

  const collectOptions: {
    projectRoot: string;
    maxDepth?: number;
    taskTokens?: string[];
  } = {
    projectRoot,
    ...(taskTokens ? { taskTokens } : {}),
  };

  for (const filePath of await collectTextFiles(scanDirs, [], collectOptions)) {
    const relativePath = relative(root, filePath).replace(/\\/g, '/');
    if (!regex.test(relativePath)) continue;
    paths.push(relativePath);
  }
  // Sort by depth first so root-level matches survive truncation
  sortPathsByDepth(paths);
  return paths.slice(0, limit);
}

export function formatGrepMatches(matches: GrepMatch[], truncated: boolean): string {
  if (matches.length === 0) {
    return 'No matches found.';
  }
  const lines = matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
  if (truncated) {
    lines.push('...[truncated after match limit]');
  }
  return lines.join('\n');
}

export function formatGlobPaths(paths: string[]): string {
  if (paths.length === 0) {
    return 'No paths matched.';
  }
  return paths.join('\n');
}

export function formatSemanticSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return 'No matches found.';
  }
  return hits
    .map((hit) => {
      const snippet = hit.snippet ? `: ${hit.snippet}` : '';
      return `[${hit.score.toFixed(2)}] ${hit.id}${snippet}`;
    })
    .join('\n');
}

export async function handleGrepTool(
  input: {
    pattern: string;
    path?: string;
    ignore_case?: boolean;
    max_matches?: number;
    output_format?: 'text' | 'json';
    context_lines?: number;
  },
  approvedReadRoots?: string[],
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  try {
    const result = await grepContent(
      projectRoot,
      input.pattern,
      {
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.ignore_case === true ? { ignoreCase: true } : {}),
        ...(input.max_matches !== undefined ? { maxMatches: input.max_matches } : {}),
        ...(input.context_lines !== undefined ? { contextLines: input.context_lines } : {}),
      },
      approvedReadRoots,
    );
    const output =
      input.output_format === 'json'
        ? JSON.stringify({ matches: result.matches, truncated: result.truncated })
        : formatGrepMatches(result.matches, result.truncated);
    return {
      exit_code: 0,
      stdout: output,
      stderr: '',
    };
  } catch (error: unknown) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleGlobTool(
  input: {
    pattern: string;
    max_paths?: number;
    output_format?: 'text' | 'json';
  },
  approvedReadRoots?: string[],
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  try {
    const paths = await globPaths(projectRoot, input.pattern, input.max_paths, approvedReadRoots);
    const output =
      input.output_format === 'json'
        ? JSON.stringify({ matches: paths, truncated: false })
        : formatGlobPaths(paths);
    return {
      exit_code: 0,
      stdout: output,
      stderr: '',
    };
  } catch (error: unknown) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SymbolMatch {
  path: string;
  line: number;
  kind: string;
  name: string;
  text: string;
}

interface SymbolRule {
  pattern: RegExp;
  kind: string;
}

export const RULES_BY_EXT: Record<string, SymbolRule[]> = {
  ts: [
    { pattern: /(?:export\s+(?:default\s+)?)?class\s+([a-zA-Z0-9_$]+)/, kind: 'class' },
    { pattern: /(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/, kind: 'interface' },
    { pattern: /(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/, kind: 'type' },
    {
      pattern: /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/,
      kind: 'function',
    },
    {
      pattern:
        /(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/,
      kind: 'function',
    },
  ],
  js: [
    { pattern: /(?:export\s+(?:default\s+)?)?class\s+([a-zA-Z0-9_$]+)/, kind: 'class' },
    {
      pattern: /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/,
      kind: 'function',
    },
    {
      pattern:
        /(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/,
      kind: 'function',
    },
  ],
  py: [
    { pattern: /^\s*class\s+([a-zA-Z0-9_]+)/, kind: 'class' },
    { pattern: /^\s*def\s+([a-zA-Z0-9_]+)/, kind: 'function' },
  ],
  go: [
    { pattern: /^func\s+([a-zA-Z0-9_]+)\s*\(/, kind: 'function' },
    { pattern: /^func\s+\([^)]+\)\s+([a-zA-Z0-9_]+)\s*\(/, kind: 'method' },
    { pattern: /^type\s+([a-zA-Z0-9_]+)\s+(struct|interface)/, kind: 'type' },
  ],
  rs: [
    { pattern: /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/, kind: 'function' },
    { pattern: /(?:pub\s+)?struct\s+([a-zA-Z0-9_]+)/, kind: 'struct' },
    { pattern: /(?:pub\s+)?enum\s+([a-zA-Z0-9_]+)/, kind: 'enum' },
    { pattern: /(?:pub\s+)?trait\s+([a-zA-Z0-9_]+)/, kind: 'trait' },
  ],
  java: [
    {
      pattern: /(?:public\s+|private\s+|protected\s+|static\s+)*class\s+([a-zA-Z0-9_]+)/,
      kind: 'class',
    },
    {
      pattern: /(?:public\s+|private\s+|protected\s+|static\s+)*interface\s+([a-zA-Z0-9_]+)/,
      kind: 'interface',
    },
    {
      pattern:
        /(?:public\s+|private\s+|protected\s+|static\s+|synchronized\s+|final\s+)+[a-zA-Z0-9_<>@\[\]]+\s+([a-zA-Z0-9_]+)\s*\(/,
      kind: 'method',
    },
  ],
};

RULES_BY_EXT['tsx'] = RULES_BY_EXT['ts']!;
RULES_BY_EXT['jsx'] = RULES_BY_EXT['js']!;
RULES_BY_EXT['mjs'] = RULES_BY_EXT['js']!;
RULES_BY_EXT['cjs'] = RULES_BY_EXT['js']!;

export async function searchSymbols(
  projectRoot: string,
  query: string,
  maxMatches = 100,
  approvedReadRoots?: string[],
): Promise<{ matches: SymbolMatch[]; truncated: boolean }> {
  const root = resolve(projectRoot);
  const lowercaseQuery = query.toLowerCase();
  const matches: SymbolMatch[] = [];

  const task = process.env['BABEL_TASK'] || '';
  const taskTokens = task ? extractFolderTokens(task) : undefined;

  const scanDirs =
    approvedReadRoots && approvedReadRoots.length > 0 ? [root, ...approvedReadRoots] : root;

  const collectOptions = {
    projectRoot,
    maxDepth: 2,
    ...(taskTokens ? { taskTokens } : {}),
  };

  for (const filePath of await collectTextFiles(scanDirs, [], collectOptions)) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (!ext) continue;

    const rules = RULES_BY_EXT[ext];
    if (!rules) continue;

    const relativePath = relative(root, filePath).replace(/\\/g, '/');

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      for (const rule of rules) {
        const match = rule.pattern.exec(line);
        if (match && match[1]) {
          const symbolName = match[1];
          if (symbolName.toLowerCase().includes(lowercaseQuery)) {
            matches.push({
              path: relativePath,
              line: lineIndex + 1,
              kind: rule.kind,
              name: symbolName,
              text: line.trim(),
            });
            if (matches.length >= maxMatches) {
              return { matches, truncated: true };
            }
          }
        }
      }
    }
  }

  return { matches, truncated: false };
}

export function formatSymbolMatches(matches: SymbolMatch[], truncated: boolean): string {
  if (matches.length === 0) {
    return 'No symbols found matching query.';
  }
  const lines = matches.map(
    (match) => `${match.path}:${match.line}: [${match.kind}] ${match.name} - ${match.text}`,
  );
  if (truncated) {
    lines.push('...[truncated after symbol match limit]');
  }
  return lines.join('\n');
}

export async function handleWorkspaceSymbolSearch(
  input: {
    query: string;
    max_matches?: number;
  },
  approvedReadRoots?: string[],
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  try {
    const result = await searchSymbols(
      projectRoot,
      input.query,
      input.max_matches,
      approvedReadRoots,
    );
    return {
      exit_code: 0,
      stdout: formatSymbolMatches(result.matches, result.truncated),
      stderr: '',
    };
  } catch (error: unknown) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Workspace Map ──────────────────────────────────────────────────────────────

export interface WorkspaceMapOptions {
  maxDepth?: number; // default 6
  maxFiles?: number; // default 500
}

interface TreeNode {
  name: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
}

function buildTreeFromPaths(files: string[]): TreeNode {
  const root: TreeNode = { name: '', isDir: true, children: new Map() };

  for (const file of files) {
    const segments = file.replace(/\\/g, '/').split('/').filter(Boolean);
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] ?? '';
      const isLast = i === segments.length - 1;
      if (!current.children.has(segment)) {
        current.children.set(segment, {
          name: segment,
          isDir: !isLast,
          children: new Map(),
        });
      }
      current = current.children.get(segment)!;
    }
  }

  return root;
}

function renderTreeNode(node: TreeNode, prefix: string, isLast: boolean, lines: string[]): void {
  const connector = isLast ? '└── ' : '├── ';
  const nextPrefix = isLast ? '    ' : '│   ';

  if (node.name) {
    lines.push(`${prefix}${connector}${node.name}${node.isDir ? '/' : ''}`);
  }

  if (node.children.size > 0) {
    const children = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (let i = 0; i < children.length; i++) {
      const [, child] = children[i]!;
      const childIsLast = i === children.length - 1;
      renderTreeNode(child, node.name ? prefix + nextPrefix : prefix, childIsLast, lines);
    }
  }
}

/**
 * Build a directory tree string of the workspace using ripgrep to list files.
 * Respects .gitignore by default (ripgrep built-in).
 */
export async function buildWorkspaceMap(
  projectRoot: string,
  options?: WorkspaceMapOptions,
  approvedReadRoots?: string[],
): Promise<string> {
  const root = resolve(projectRoot);
  const maxDepth = options?.maxDepth ?? 6;
  const maxFiles = options?.maxFiles ?? 500;

  let files: string[];

  if (detectRipgrep()) {
    try {
      files = rgListFiles(root, maxDepth);
    } catch {
      // Fall through
      files = [];
    }
  } else {
    // Pure-JS fallback: collect files with no depth limit
    const task = process.env['BABEL_TASK'] || '';
    const taskTokens = task ? extractFolderTokens(task) : undefined;

    const scanDirs =
      approvedReadRoots && approvedReadRoots.length > 0 ? [root, ...approvedReadRoots] : root;

    const collectOptions: {
      projectRoot: string;
      maxDepth?: number;
      taskTokens?: string[];
    } = {
      projectRoot,
      ...(taskTokens ? { taskTokens } : {}),
    };

    const allFiles = await collectTextFiles(scanDirs, [], collectOptions);
    files = allFiles.map((f) => relative(root, f).replace(/\\/g, '/'));
  }

  if (files.length > maxFiles) {
    files = files.slice(0, maxFiles);
  }

  // Get the basename of the workspace directory for the root label
  const rootName = basename(root);
  const treeRoot = buildTreeFromPaths(files);

  // If root has no name (empty structure)
  treeRoot.name = rootName;

  const lines: string[] = [];
  renderTreeNode(treeRoot, '', true, lines);

  if (files.length >= maxFiles) {
    lines.push(`...[truncated after ${maxFiles} files]`);
  }

  return lines.join('\n');
}

export async function handleWorkspaceMapTool(
  input: {
    max_depth?: number;
    max_files?: number;
    output_format?: 'text' | 'json';
  },
  approvedReadRoots?: string[],
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  try {
    const tree = await buildWorkspaceMap(
      projectRoot,
      {
        ...(input.max_depth !== undefined ? { maxDepth: input.max_depth } : {}),
        ...(input.max_files !== undefined ? { maxFiles: input.max_files } : {}),
      },
      approvedReadRoots,
    );
    const output =
      input.output_format === 'json' ? JSON.stringify({ tree, truncated: false }) : tree;
    return {
      exit_code: 0,
      stdout: output,
      stderr: '',
    };
  } catch (error: unknown) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
