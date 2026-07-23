import { existsSync, readdirSync, statSync } from 'node:fs';
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

export function resolveAgentTarget(options: ResolveAgentTargetOptions = {}): AgentTargetContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.projectRoot) {
    const targetRoot = resolve(options.projectRoot);
    const namedRoot = options.namedProjectRoot
      ? resolve(options.namedProjectRoot)
      : options.project
        ? resolveProjectRoot(options.project)
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
      ? resolveProjectRoot(options.project)
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
