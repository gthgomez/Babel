import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ShadowDiffResult {
  status: 'ok' | 'error';
  diff?: string;
  error?: string;
}

/**
 * Compares a shadow root directory with a project root directory using git diff.
 * Returns a colorized diff string if differences are found.
 */
export function getShadowDiff(shadowRoot: string, projectRoot: string): ShadowDiffResult {
  if (!existsSync(shadowRoot)) {
    return { status: 'error', error: `Shadow root does not exist: ${shadowRoot}` };
  }
  if (!existsSync(projectRoot)) {
    return { status: 'error', error: `Project root does not exist: ${projectRoot}` };
  }

  // Use git diff --no-index to compare directories.
  // --no-index is a standalone mode that compares two paths on the filesystem.
  const result = spawnSync(
    'git',
    ['diff', '--no-index', '--color=always', projectRoot, shadowRoot],
    { encoding: 'utf-8' },
  );

  // git diff --no-index status codes:
  // 0: no changes
  // 1: changes found
  // other: error
  if (result.status === 0) {
    return { status: 'ok', diff: 'No changes detected between shadow and project root.' };
  } else if (result.status === 1) {
    return { status: 'ok', diff: result.stdout };
  } else {
    const error = result.stderr?.trim() || result.error?.message || 'Unknown git diff error';
    return { status: 'error', error };
  }
}
