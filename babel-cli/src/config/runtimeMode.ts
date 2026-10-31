import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveRuntimePaths } from './runtimePaths.js';
import { type ExecutorMode } from '../sandbox.js';

function getModeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const paths = resolveRuntimePaths(env);
  // Keep the historical package-local mode file for an unconfigured source checkout.
  const configRoot = !paths.isInstalled && !env['BABEL_CONFIG_DIR'] && !env['BABEL_ROOT']
    ? join(paths.packageRoot, 'config')
    : paths.userConfigRoot;
  return join(configRoot, 'runtime-mode.json');
}

interface RuntimeModeFile {
  mode: ExecutorMode;
  updatedAt: string;
}

/**
 * Reads the current runtime mode from the persistence layer.
 * Defaults to 'act' if no mode is set.
 */
export function readRuntimeMode(env: NodeJS.ProcessEnv = process.env): ExecutorMode {
  const envMode = env['BABEL_RUNTIME_MODE']?.trim().toLowerCase();
  if (envMode === 'act' || envMode === 'plan') {
    return envMode;
  }

  const path = getModeFilePath(env);
  if (!existsSync(path)) {
    return 'act';
  }

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as RuntimeModeFile;
    return data.mode || 'act';
  } catch {
    return 'act';
  }
}

/**
 * Persists the runtime mode to the filesystem.
 */
export function writeRuntimeMode(mode: ExecutorMode): void {
  const path = getModeFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const data: RuntimeModeFile = {
    mode,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}
