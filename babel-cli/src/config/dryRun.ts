import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ExecutorDryRunResolution {
  dryRun: boolean;
  source: 'session' | 'persisted' | 'default';
  reason: string;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return null;
}

function findBabelRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, 'prompt_catalog.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir, '../..');
    }
    current = parent;
  }
}

function getRuntimeFlagsPath(env: NodeJS.ProcessEnv): string {
  const root = env['BABEL_ROOT'] ?? findBabelRoot(dirname(fileURLToPath(import.meta.url)));
  return join(root, 'config', 'runtime-flags.json');
}

function readPersistedDryRun(env: NodeJS.ProcessEnv): boolean | null {
  const path = getRuntimeFlagsPath(env);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { dryRun?: unknown };
    return typeof parsed.dryRun === 'boolean' ? parsed.dryRun : null;
  } catch {
    return null;
  }
}

export function resolveExecutorDryRun(
  env: NodeJS.ProcessEnv = process.env,
): ExecutorDryRunResolution {
  const explicitDryRun = parseBoolean(env['BABEL_DRY_RUN']);
  if (explicitDryRun === true) {
    return {
      dryRun: true,
      source: 'session',
      reason: 'BABEL_DRY_RUN explicitly enabled dry-run mode.',
    };
  }

  const explicitLive = parseBoolean(env['BABEL_LIVE']);
  if (explicitLive === true) {
    return {
      dryRun: false,
      source: 'session',
      reason: 'BABEL_LIVE explicitly enabled live mutation mode.',
    };
  }

  const dryRunSource = env['BABEL_DRY_RUN_SOURCE']?.trim().toLowerCase();
  if ((dryRunSource === 'session' || dryRunSource === 'persisted') && explicitDryRun === false) {
    return {
      dryRun: false,
      source: dryRunSource,
      reason: `BABEL_DRY_RUN=false came from ${dryRunSource} runtime state.`,
    };
  }

  const persisted = readPersistedDryRun(env);
  if (persisted !== null) {
    return {
      dryRun: persisted,
      source: 'persisted',
      reason: `Persisted runtime flags set dry-run mode ${persisted ? 'on' : 'off'}.`,
    };
  }

  return {
    dryRun: true,
    source: 'default',
    reason: 'No live opt-in was found; defaulting mutating tools to dry-run mode.',
  };
}

export function isDryRunEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveExecutorDryRun(env).dryRun;
}
