import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { type ExecutorMode } from '../sandbox.js';

/**
 * Resolves the Babel CLI root directory.
 * Assumes the compiled file is at dist/config/runtimeMode.js
 */
function getBabelRoot(): string {
  if (process.env['BABEL_ROOT']) {
    return process.env['BABEL_ROOT'];
  }
  // From dist/config/runtimeMode.js to babel-cli/
  return resolve(__dirname, '../..');
}

function getModeFilePath(): string {
  return join(getBabelRoot(), 'config', 'runtime-mode.json');
}

interface RuntimeModeFile {
  mode: ExecutorMode;
  updatedAt: string;
}

/**
 * Reads the current runtime mode from the persistence layer.
 * Defaults to 'act' if no mode is set.
 */
export function readRuntimeMode(): ExecutorMode {
  const envMode = process.env['BABEL_RUNTIME_MODE']?.trim().toLowerCase();
  if (envMode === 'act' || envMode === 'plan') {
    return envMode;
  }

  const path = getModeFilePath();
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
