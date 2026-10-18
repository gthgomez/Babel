import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { resolveProjectRoot } from '../cli/helpers.js';

export interface AgentTargetContext {
  targetRoot: string;
  workspaceRoot: string | null;
  project: string | null;
  source: 'explicit_project_root' | 'current_repo' | 'named_project' | 'cwd';
  cwd: string;
}

export interface ResolveAgentTargetOptions {
  project?: string;
  projectRoot?: string;
  namedProjectRoot?: string;
  cwd?: string;
  task?: string;
}

const TARGET_MARKERS = [
  '.git',
  'package.json',
  'PROJECT_CONTEXT.md',
  'AGENTS.md',
  'README.md',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'project.godot',
  'vite.config.ts',
  'next.config.js',
];

function hasTargetMarker(dir: string): boolean {
  return TARGET_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

function parentOf(path: string): string {
  const parent = dirname(path);
  return parent === path ? path : parent;
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function findNearestAgentTargetRoot(cwd = process.cwd()): string {
  let current = resolve(cwd);
  try {
    if (existsSync(current) && !statSync(current).isDirectory()) {
      current = dirname(current);
    }
  } catch {
    current = resolve(cwd);
  }

  let cursor = current;
  while (true) {
    if (hasTargetMarker(cursor)) {
      return cursor;
    }
    const parent = parentOf(cursor);
    if (parent === cursor) {
      return current;
    }
    cursor = parent;
  }
}

const GENERIC_UMBRELLA_TERMS = new Set([
  'workspace',
  'project',
  'projects',
  'repo',
  'repository',
  'app',
  'apps',
  'code',
  'cli',
  'global',
]);

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function taskMentionsToken(task: string, token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length < 3) return false;
  const lower = trimmed.toLowerCase();
  if (GENERIC_UMBRELLA_TERMS.has(lower)) return false;
  const pattern = new RegExp(`(?<![a-z0-9_-])${escapeRegex(lower)}(?![a-z0-9_-])`, 'i');
  return pattern.test(task);
}

function resolveTaskNamedUmbrellaChild(
  currentRoot: string,
  task: string,
): { targetRoot: string; project: string } | null {
  const trimmedTask = task.trim();
  if (!trimmedTask) return null;

  const catalogPath = join(currentRoot, 'config', 'workspace-products.json');
  const matchedByTarget = new Map<string, { targetRoot: string; project: string; active: boolean }>();

  if (existsSync(catalogPath)) {
    try {
      const parsed = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
        products?: Array<{
          id?: string;
          path?: string;
          lifecycle?: string;
          aliases?: string[];
        }>;
      };
      const products = Array.isArray(parsed.products) ? parsed.products : [];
      for (const entry of products) {
        if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) continue;
        const resolved = resolve(currentRoot, entry.path);
        if (
          !isPathInside(currentRoot, resolved) ||
          resolve(currentRoot) === resolved ||
          !existsSync(resolved)
        ) {
          continue;
        }
        const names = new Set<string>();
        if (typeof entry.id === 'string' && entry.id.trim()) names.add(entry.id.trim());
        names.add(basename(resolved));
        if (Array.isArray(entry.aliases)) {
          for (const alias of entry.aliases) {
            if (typeof alias === 'string' && alias.trim()) names.add(alias.trim());
          }
        }
        const mentioned = [...names].some((name) => taskMentionsToken(trimmedTask, name));
        if (mentioned) {
          const active = entry.lifecycle === 'active';
          const key = resolved.toLowerCase();
          const existing = matchedByTarget.get(key);
          if (!existing || (active && !existing.active)) {
            matchedByTarget.set(key, {
              targetRoot: resolved,
              project: basename(resolved),
              active,
            });
          }
        }
      }
    } catch {
      // Ignore malformed catalog and fall back to Project_* directory scan.
    }
  }

  if (matchedByTarget.size === 0) {
    try {
      const topEntries = readdirSync(currentRoot, { withFileTypes: true });
      for (const entry of topEntries) {
        if (!entry.isDirectory() || !entry.name.startsWith('Project_')) continue;
        const domainDir = join(currentRoot, entry.name);
        let children;
        try {
          children = readdirSync(domainDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          if (!child.isDirectory()) continue;
          if (!taskMentionsToken(trimmedTask, child.name)) continue;
          const candidate = resolve(domainDir, child.name);
          if (!hasTargetMarker(candidate)) continue;
          matchedByTarget.set(candidate.toLowerCase(), {
            targetRoot: candidate,
            project: child.name,
            active: true,
          });
        }
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  if (matchedByTarget.size === 1) {
    const only = [...matchedByTarget.values()][0]!;
    return { targetRoot: only.targetRoot, project: only.project };
  }
  const activeMatches = [...matchedByTarget.values()].filter((m) => m.active);
  if (activeMatches.length === 1) {
    return { targetRoot: activeMatches[0]!.targetRoot, project: activeMatches[0]!.project };
  }
  return null;
}

export function resolveAgentTarget(options: ResolveAgentTargetOptions = {}): AgentTargetContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.projectRoot) {
    const targetRoot = resolve(options.projectRoot);
    const namedRoot = options.namedProjectRoot
      ? resolve(options.namedProjectRoot)
      : options.project
        ? resolveProjectRoot(options.project, cwd)
        : null;
    return {
      targetRoot,
      workspaceRoot: namedRoot && isPathInside(namedRoot, targetRoot) ? namedRoot : null,
      project: options.project ?? null,
      source: 'explicit_project_root',
      cwd,
    };
  }

  const currentRoot = findNearestAgentTargetRoot(cwd);
  const namedRoot = options.namedProjectRoot
    ? resolve(options.namedProjectRoot)
    : options.project
      ? resolveProjectRoot(options.project, currentRoot)
      : null;
  if (namedRoot) {
    if (isPathInside(namedRoot, currentRoot) && resolve(currentRoot) !== resolve(namedRoot)) {
      return {
        targetRoot: currentRoot,
        workspaceRoot: namedRoot,
        project: options.project ?? null,
        source: 'current_repo',
        cwd,
      };
    }
    if (isPathInside(currentRoot, namedRoot) && resolve(currentRoot) !== resolve(namedRoot)) {
      return {
        targetRoot: namedRoot,
        workspaceRoot: currentRoot,
        project: options.project ?? targetBasename(namedRoot),
        source: 'named_project',
        cwd,
      };
    }
    if (!isPathInside(namedRoot, cwd)) {
      return {
        targetRoot: namedRoot,
        workspaceRoot: namedRoot,
        project: options.project ?? null,
        source: 'named_project',
        cwd,
      };
    }
  }

  if (!options.project && options.task) {
    const childMatch = resolveTaskNamedUmbrellaChild(currentRoot, options.task);
    if (childMatch) {
      return {
        targetRoot: childMatch.targetRoot,
        workspaceRoot: currentRoot,
        project: childMatch.project,
        source: 'named_project',
        cwd,
      };
    }
  }

  return {
    targetRoot: currentRoot,
    workspaceRoot: namedRoot && isPathInside(namedRoot, currentRoot) ? namedRoot : null,
    project: options.project ?? null,
    source: hasTargetMarker(currentRoot) ? 'current_repo' : 'cwd',
    cwd,
  };
}

export function readShallowTargetListing(targetRoot: string, limit = 32): string[] {
  try {
    return readdirSync(targetRoot, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.git') && entry.name !== 'node_modules')
      .slice(0, limit)
      .map((entry) => `${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name}`);
  } catch {
    return [];
  }
}

export function targetBasename(targetRoot: string): string {
  return basename(resolve(targetRoot));
}
