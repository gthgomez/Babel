import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { OrchestratorManifest } from '../schemas/agentContracts.js';
import { hasPlaceholderProjectPath } from '../taskCompletion.js';
import { isWithinProjectRootPath } from '../stages/executorHelpers.js';
import { logDetail } from './logging.js';
import { BABEL_ROOT } from './paths.js';

export function inferProjectRoot(manifest: OrchestratorManifest): string | undefined {
  const explicit = manifest.target_project_path?.trim();
  if (explicit && explicit.length > 0 && !hasPlaceholderProjectPath(explicit)) {
    return explicit;
  }

  const envProjectRoot = process.env['BABEL_PROJECT_ROOT']?.trim();
  if (envProjectRoot && envProjectRoot.length > 0) {
    return envProjectRoot;
  }

  if (manifest.target_project === 'global') {
    return undefined;
  }

  const candidate = resolve(BABEL_ROOT, '..', manifest.target_project);
  return existsSync(candidate) ? candidate : undefined;
}

export function readSessionStartProjectPath(sessionStartPath?: string): string | null {
  const candidate = sessionStartPath?.trim();
  if (!candidate || !existsSync(candidate)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { ProjectPath?: unknown };
    if (typeof parsed.ProjectPath !== 'string' || parsed.ProjectPath.trim().length === 0) {
      return null;
    }

    const resolved = resolve(parsed.ProjectPath.trim());
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function normalizeManifestProjectRoot(
  manifest: OrchestratorManifest,
  sessionStartPath?: string,
  options: {
    authoritativeProjectRoot?: string | null;
    workspaceRoot?: string | null;
  } = {},
): OrchestratorManifest {
  const authoritativeRoot = options.authoritativeProjectRoot?.trim();
  if (authoritativeRoot) {
    const normalizedAuthoritativeRoot = resolve(authoritativeRoot);
    const explicit = manifest.target_project_path?.trim();
    const normalizedExplicitRoot = explicit && !hasPlaceholderProjectPath(explicit)
      ? resolve(explicit)
      : null;
    if (normalizedExplicitRoot && normalizedExplicitRoot !== normalizedAuthoritativeRoot) {
      logDetail(`Manifest target clamped to authoritative project root: ${normalizedAuthoritativeRoot}`);
    }
    return {
      ...manifest,
      target_project_path: normalizedAuthoritativeRoot,
    };
  }

  const sessionProjectRoot = readSessionStartProjectPath(sessionStartPath);
  if (!sessionProjectRoot) {
    return manifest;
  }

  const normalizedSessionRoot = resolve(sessionProjectRoot);
  const explicit = manifest.target_project_path?.trim();
  if (!explicit || hasPlaceholderProjectPath(explicit)) {
    return {
      ...manifest,
      target_project_path: normalizedSessionRoot,
    };
  }

  const normalizedExplicitRoot = resolve(explicit);
  if (normalizedExplicitRoot === normalizedSessionRoot) {
    return {
      ...manifest,
      target_project_path: normalizedSessionRoot,
    };
  }

  const canonicalProjectFamilyRoot = manifest.target_project === 'global'
    ? null
    : resolve(BABEL_ROOT, '..', manifest.target_project);

  if (
    (canonicalProjectFamilyRoot && normalizedExplicitRoot === canonicalProjectFamilyRoot) ||
    isWithinProjectRootPath(normalizedExplicitRoot, normalizedSessionRoot)
  ) {
    return {
      ...manifest,
      target_project_path: normalizedSessionRoot,
    };
  }

  return manifest;
}

export function resolveConcreteProjectRoot(
  manifest: OrchestratorManifest,
  sessionStartPath?: string,
): string | undefined {
  return inferProjectRoot(normalizeManifestProjectRoot(manifest, sessionStartPath));
}

export function configureToolProjectRoot(manifest: OrchestratorManifest): void {
  const root = inferProjectRoot(manifest);
  if (!root) return;
  process.env['BABEL_PROJECT_ROOT'] = root;
  logDetail(`Tool project root: ${root}`);
}
