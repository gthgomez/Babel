/**
 * Explicit operator reconciliation for canonical memory (no legacy ownership inference).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MEMORY_INDEX_NAME } from './memoryTypes.js';
import {
  MEMORY_RECONCILIATION_FILE,
  type MemoryReconciliation,
  pathsForProject,
} from './memoryStoreLayout.js';
import { sha256File } from './memoryStoreCopy.js';
import { projectRootMatches } from './memoryStoreIdentity.js';
import { readJsonFile, writeJsonAtomic } from './memoryStoreMigrationIO.js';

export function readMemoryReconciliation(projectDir: string): MemoryReconciliation | null {
  const raw = readJsonFile<MemoryReconciliation>(join(projectDir, MEMORY_RECONCILIATION_FILE));
  if (!raw || raw.schemaVersion !== 1 || raw.kind !== 'explicit_operator') return null;
  if (!Array.isArray(raw.memoryFiles) || typeof raw.projectRoot !== 'string') return null;
  return raw;
}

function listMdMemoryNames(memoryRoot: string): string[] {
  try {
    if (!existsSync(memoryRoot)) return [];
    return readdirSync(memoryRoot).filter((n) => n.endsWith('.md') && n !== MEMORY_INDEX_NAME);
  } catch {
    return [];
  }
}

export function buildMemoryReconciliationFromCanonical(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  nowIso?: string,
): MemoryReconciliation | null {
  const layout = pathsForProject(projectRoot, env);
  const names = listMdMemoryNames(layout.canonicalMemoryRoot);
  if (names.length === 0) return null;
  const memoryFiles: Array<{ name: string; contentSha256: string }> = [];
  for (const name of names) {
    const digest = sha256File(join(layout.canonicalMemoryRoot, name));
    if (!digest) return null;
    memoryFiles.push({ name, contentSha256: digest });
  }
  return {
    schemaVersion: 1,
    projectRoot: layout.absolute,
    kind: 'explicit_operator',
    establishedAt: nowIso ?? new Date().toISOString(),
    memoryFiles,
  };
}

/**
 * Bootstrap gate: every attested file must match on disk; additional canonical files are allowed
 * after unlock (digest provenance becomes the ongoing authority).
 */
export function validateReconciliationBootstrap(
  absoluteProjectRoot: string,
  canonicalMemoryRoot: string,
  record: MemoryReconciliation,
): boolean {
  if (!projectRootMatches(record.projectRoot, absoluteProjectRoot)) return false;
  if (record.memoryFiles.length === 0) return false;
  for (const { name, contentSha256 } of record.memoryFiles) {
    if (!existsSync(join(canonicalMemoryRoot, name))) return false;
    const actual = sha256File(join(canonicalMemoryRoot, name));
    if (actual !== contentSha256) return false;
  }
  return true;
}

/** @deprecated Prefer validateReconciliationBootstrap for resolve-time gates. */
export function validateMemoryReconciliation(
  absoluteProjectRoot: string,
  canonicalMemoryRoot: string,
  record: MemoryReconciliation,
): boolean {
  return validateReconciliationBootstrap(absoluteProjectRoot, canonicalMemoryRoot, record);
}

export function writeMemoryReconciliation(
  projectDir: string,
  record: MemoryReconciliation,
): void {
  writeJsonAtomic(join(projectDir, MEMORY_RECONCILIATION_FILE), record);
}
