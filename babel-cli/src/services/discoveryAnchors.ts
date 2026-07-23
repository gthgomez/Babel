import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentAction } from '../agent/actions.js';

export const MAX_DISCOVERY_ANCHOR_PATHS = 6;

const STACK_MANIFEST_CANDIDATES = [
  'package.json',
  'build.gradle.kts',
  'settings.gradle.kts',
  'project.godot',
  'app/build.gradle.kts',
] as const;

const DEFAULT_ANCHOR_CANDIDATES = [
  'PROJECT_CONTEXT.md',
  ...STACK_MANIFEST_CANDIDATES,
  'README.md',
] as const;

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function anchorExists(projectRoot: string, relativePath: string): boolean {
  return existsSync(join(projectRoot, relativePath));
}

/**
 * Resolve existence-checked anchor paths for read-only discovery warmup.
 * Caller seed paths win, then PROJECT_CONTEXT, stack manifests, and README.
 */
export function resolveDiscoveryAnchorPaths(projectRoot: string, seedPaths?: string[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];

  const add = (candidate: string): void => {
    const normalized = normalizeRelativePath(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    if (anchorExists(projectRoot, normalized)) {
      resolved.push(normalized);
    }
  };

  for (const candidate of seedPaths ?? []) {
    add(candidate);
  }
  for (const candidate of DEFAULT_ANCHOR_CANDIDATES) {
    add(candidate);
  }

  return resolved.slice(0, MAX_DISCOVERY_ANCHOR_PATHS);
}

export function buildDiscoveryAnchorWarmupActions(anchorPaths: string[]): AgentAction[] {
  const actions: AgentAction[] = [{ type: 'list_dir', path: '.' }];
  for (const path of anchorPaths) {
    actions.push({ type: 'read_file', path });
  }
  return actions;
}
