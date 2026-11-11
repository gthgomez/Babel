import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Write JSON via temp file + rename so readers never observe a truncated payload.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 12);
  const tmp = join(dir, `.${digest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, payload, 'utf-8');
  renameSync(tmp, path);
}
