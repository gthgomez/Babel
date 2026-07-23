/**
 * fileHistory.ts — Per-task file change history tracking
 *
 * Tracks which files each Babel run touched, with before/after SHA256 hashes.
 * Supports querying by file path or run ID.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

export interface FileChangeRecord {
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  changed: boolean;
}

export interface RunFileHistory {
  schemaVersion: 1;
  runId: string;
  runDir: string;
  timestamp: string;
  projectRoot: string;
  files: FileChangeRecord[];
}

export function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

export function writeRunFileHistory(
  runId: string,
  runDir: string,
  projectRoot: string,
  touchedPaths: string[],
  preSnapshotHashes?: Map<string, string>,
): void {
  const historyDir = join(projectRoot, '.babel', 'file-history');
  if (!existsSync(historyDir)) {
    mkdirSync(historyDir, { recursive: true });
  }

  const files: FileChangeRecord[] = touchedPaths.map((relPath) => {
    const absPath = join(projectRoot, relPath);
    const before = preSnapshotHashes?.get(relPath) ?? null;
    const after = hashFile(absPath);
    return {
      path: relPath,
      beforeSha256: before,
      afterSha256: after,
      changed: before !== after,
    };
  });

  const history: RunFileHistory = {
    schemaVersion: 1,
    runId,
    runDir,
    timestamp: new Date().toISOString(),
    projectRoot,
    files,
  };

  writeFileSync(join(historyDir, `${runId}.json`), JSON.stringify(history, null, 2), 'utf-8');
}

export function getFileHistory(filePath: string, projectRoot?: string): RunFileHistory[] {
  const root = projectRoot ?? process.cwd();
  const historyDir = join(root, '.babel', 'file-history');
  if (!existsSync(historyDir)) return [];

  const results: RunFileHistory[] = [];
  const normalizedPath = relative(root, filePath).replace(/\\/g, '/');

  for (const filename of readdirSync(historyDir)) {
    if (!filename.endsWith('.json')) continue;
    try {
      const history = JSON.parse(
        readFileSync(join(historyDir, filename), 'utf-8'),
      ) as RunFileHistory;
      if (history.files.some((f) => f.path === normalizedPath)) {
        results.push(history);
      }
    } catch {
      // skip unparseable files
    }
  }

  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function getTaskFileHistory(runId: string, projectRoot?: string): RunFileHistory | null {
  const root = projectRoot ?? process.cwd();
  const historyPath = join(root, '.babel', 'file-history', `${runId}.json`);
  if (!existsSync(historyPath)) return null;
  try {
    return JSON.parse(readFileSync(historyPath, 'utf-8')) as RunFileHistory;
  } catch {
    return null;
  }
}
