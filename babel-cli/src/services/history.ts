import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HISTORY_FILE = join(process.cwd(), '.babel_history');
const MAX_HISTORY = 100;

/**
 * Persist command history to disk.
 */
export function saveHistory(history: string[]): void {
  try {
    const data = JSON.stringify(history.slice(0, MAX_HISTORY));
    writeFileSync(HISTORY_FILE, data, 'utf-8');
  } catch (err) {
    // Silent fail on history save
  }
}

/**
 * Load command history from disk.
 */
export function loadHistory(): string[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const data = readFileSync(HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}
