import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeUserStateRoot } from '../config/runtimePaths.js';

const MAX_HISTORY = 100;

/**
 * Persist command history to disk.
 */
export function saveHistory(history: string[]): void {
  try {
    const data = JSON.stringify(history.slice(0, MAX_HISTORY));
    const stateRoot = resolveRuntimeUserStateRoot();
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, '.babel_history'), data, 'utf-8');
  } catch (err) {
    // Silent fail on history save
  }
}

/**
 * Load command history from disk.
 */
export function loadHistory(): string[] {
  try {
    const privateFile = join(resolveRuntimeUserStateRoot(), '.babel_history');
    // Retain old local history as a read-only fallback; never rewrite or remove it.
    const historyFile = existsSync(privateFile) ? privateFile : join(process.cwd(), '.babel_history');
    if (!existsSync(historyFile)) return [];
    const data = readFileSync(historyFile, 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}
