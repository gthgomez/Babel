/**
 * Non-destructive legacy → canonical memory store migration with provenance checks.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { MEMORY_INDEX_NAME } from './memoryTypes.js';
import {
  MEMORY_MIGRATION_FILE,
  MEMORY_PROVENANCE_FILE,
  type MemoryMigrationRecord,
  type MemoryProvenance,
  pathsForProject,
  sanitizeGitRoot,
} from './memoryStoreLayout.js';

export type MemoryRootBlockerCode =
  | 'ambiguous_legacy_collision'
  | 'legacy_owner_mismatch'
  | 'shared_empty_legacy_bucket';

export interface MemoryRootResolution {
  memoryRoot: string | null;
  blocker?: {
    code: MemoryRootBlockerCode;
    message: string;
    legacyMemoryRoot?: string;
    manualReconciliation: string;
  };
}

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export function readMemoryProvenance(projectDir: string): MemoryProvenance | null {
  const raw = readJsonFile<MemoryProvenance>(join(projectDir, MEMORY_PROVENANCE_FILE));
  if (!raw || raw.schemaVersion !== 1 || typeof raw.projectRoot !== 'string') return null;
  return raw;
}

export function writeMemoryProvenance(
  projectDir: string,
  provenance: Omit<MemoryProvenance, 'schemaVersion' | 'establishedAt'> & { establishedAt?: string },
): void {
  const record: MemoryProvenance = {
    schemaVersion: 1,
    establishedAt: provenance.establishedAt ?? new Date().toISOString(),
    slugFormat: provenance.slugFormat,
    projectRoot: provenance.projectRoot,
  };
  writeJsonAtomic(join(projectDir, MEMORY_PROVENANCE_FILE), record);
}

export function readMemoryMigration(projectDir: string): MemoryMigrationRecord | null {
  const raw = readJsonFile<MemoryMigrationRecord>(join(projectDir, MEMORY_MIGRATION_FILE));
  if (!raw || raw.schemaVersion !== 1) return null;
  return raw;
}

function listMemoryFileNames(memoryRoot: string): string[] {
  try {
    if (!existsSync(memoryRoot)) return [];
    return readdirSync(memoryRoot).filter(
      (name) => name.endsWith('.md') && name !== MEMORY_INDEX_NAME,
    );
  } catch {
    return [];
  }
}

function memoryRootHasContent(memoryRoot: string): boolean {
  return listMemoryFileNames(memoryRoot).length > 0;
}

/**
 * True when two distinct absolute paths would share the same legacy slug (case fold).
 */
export function legacySlugCaseCollides(paths: readonly string[]): boolean {
  if (paths.length < 2) return false;
  const folded = paths.map((p) => sanitizeGitRoot(p));
  const uniqueAbs = new Set(paths.map((p) => p));
  if (uniqueAbs.size < 2) return false;
  return new Set(folded).size < paths.length;
}

/**
 * Legacy v0 used join(state, 'projects', '', 'memory') which ignores empty segments → projects/memory.
 */
export function isDegenerateLegacySharedBucket(legacySlug: string): boolean {
  return legacySlug.length === 0;
}

/** Detect a case-distinct sibling directory that shares the legacy slug fold. */
export function detectOnDiskCaseCollision(absolute: string): boolean {
  const parent = dirname(absolute);
  const base = basename(absolute);
  const folded = base.toLowerCase();
  try {
    const siblings = readdirSync(parent);
    return siblings.some((entry) => {
      if (entry === base || entry.toLowerCase() !== folded) return false;
      const other = resolvePath(parent, entry);
      return other !== absolute && sanitizeGitRoot(other) === sanitizeGitRoot(absolute);
    });
  } catch {
    return false;
  }
}

function copyMemoryFileIfAbsent(sourceRoot: string, destRoot: string, name: string): boolean {
  const src = join(sourceRoot, name);
  const dest = join(destRoot, name);
  if (existsSync(dest)) return false;
  try {
    mkdirSync(destRoot, { recursive: true });
    copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

function runMigrationCopy(
  layout: ReturnType<typeof pathsForProject>,
  existing: MemoryMigrationRecord | null,
): MemoryMigrationRecord {
  const migrated = new Set(existing?.migratedFiles ?? []);
  const legacyNames = listMemoryFileNames(layout.legacyMemoryRoot);
  mkdirSync(layout.canonicalMemoryRoot, { recursive: true });

  for (const name of legacyNames) {
    if (copyMemoryFileIfAbsent(layout.legacyMemoryRoot, layout.canonicalMemoryRoot, name)) {
      migrated.add(name);
    } else if (existsSync(join(layout.canonicalMemoryRoot, name))) {
      migrated.add(name);
    }
  }

  const legacyIndex = join(layout.legacyMemoryRoot, MEMORY_INDEX_NAME);
  const canonicalIndex = join(layout.canonicalMemoryRoot, MEMORY_INDEX_NAME);
  if (existsSync(legacyIndex) && !existsSync(canonicalIndex)) {
    try {
      copyFileSync(legacyIndex, canonicalIndex);
    } catch {
      // Index is auxiliary; memory .md files are authoritative.
    }
  }

  const complete =
    legacyNames.length === 0 ||
  legacyNames.every((n) => existsSync(join(layout.canonicalMemoryRoot, n)));

  return {
    schemaVersion: 1,
    status: complete ? 'complete' : 'partial',
    sourceLegacySlug: layout.legacySlug,
    sourceLegacyMemoryRoot: layout.legacyMemoryRoot,
    projectRoot: layout.absolute,
    migratedFiles: [...migrated],
    preservedOriginal: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Resolve canonical memory root, migrating legacy content when attribution is safe.
 * Legacy directories are always preserved on disk.
 */
export function resolveMemoryRootWithMigration(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: { caseCollisionRoots?: readonly string[] },
): MemoryRootResolution {
  const layout = pathsForProject(projectRoot, env);
  const legacyProvenance = readMemoryProvenance(layout.legacyProjectDir);
  const canonicalProvenance = readMemoryProvenance(layout.canonicalProjectDir);
  const migration = readMemoryMigration(layout.canonicalProjectDir);

  const canonicalHasContent = memoryRootHasContent(layout.canonicalMemoryRoot);
  const legacyHasContent = memoryRootHasContent(layout.legacyMemoryRoot);

  try {
    mkdirSync(layout.canonicalMemoryRoot, { recursive: true });

    if (migration?.status === 'complete') {
      writeMemoryProvenance(layout.canonicalProjectDir, {
        slugFormat: 'digest-v1',
        projectRoot: layout.absolute,
      });
      return { memoryRoot: layout.canonicalMemoryRoot };
    }

    if (migration?.status === 'partial' && legacyHasContent) {
      const record = runMigrationCopy(layout, migration);
      writeJsonAtomic(join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE), record);
      writeMemoryProvenance(layout.canonicalProjectDir, {
        slugFormat: 'digest-v1',
        projectRoot: layout.absolute,
      });
      return { memoryRoot: layout.canonicalMemoryRoot };
    }

    if (canonicalHasContent && canonicalProvenance && !legacyHasContent) {
      return { memoryRoot: layout.canonicalMemoryRoot };
    }

    if (canonicalHasContent && !legacyHasContent) {
      writeMemoryProvenance(layout.canonicalProjectDir, {
        slugFormat: 'digest-v1',
        projectRoot: layout.absolute,
      });
      return { memoryRoot: layout.canonicalMemoryRoot };
    }

    if (!legacyHasContent) {
      writeMemoryProvenance(layout.canonicalProjectDir, {
        slugFormat: 'digest-v1',
        projectRoot: layout.absolute,
      });
      return { memoryRoot: layout.canonicalMemoryRoot };
    }

    if (isDegenerateLegacySharedBucket(layout.legacySlug)) {
      return {
        memoryRoot: null,
        blocker: {
          code: 'shared_empty_legacy_bucket',
          message: 'Legacy shared memory bucket (empty slug) cannot be attributed to a single project.',
          legacyMemoryRoot: layout.legacyMemoryRoot,
          manualReconciliation:
            'Copy needed .md files from the legacy store into a new per-project directory manually, ' +
            `or add ${MEMORY_PROVENANCE_FILE} under the legacy project dir with the exact projectRoot, then retry.`,
        },
      };
    }

    const collisionRoots = options?.caseCollisionRoots ?? [];
    const caseCollides =
      (collisionRoots.length > 0 && legacySlugCaseCollides([layout.absolute, ...collisionRoots])) ||
      detectOnDiskCaseCollision(layout.absolute);

    if (caseCollides && !legacyProvenance) {
      return {
        memoryRoot: null,
        blocker: {
          code: 'ambiguous_legacy_collision',
          message:
            'Legacy memory store may have served multiple case-distinct project roots; auto-migration refused.',
          legacyMemoryRoot: layout.legacyMemoryRoot,
          manualReconciliation:
            `Inspect ${layout.legacyProjectDir}, split memories per project, write ` +
            `${MEMORY_PROVENANCE_FILE} with the correct projectRoot, or copy files into ` +
            `${layout.canonicalProjectDir} manually.`,
        },
      };
    }

    if (caseCollides && legacyProvenance && legacyProvenance.projectRoot !== layout.absolute) {
      return {
        memoryRoot: null,
        blocker: {
          code: 'legacy_owner_mismatch',
          message: 'Case-colliding roots: legacy provenance does not match this projectRoot.',
          legacyMemoryRoot: layout.legacyMemoryRoot,
          manualReconciliation:
            `Legacy store is owned by ${legacyProvenance.projectRoot}. Open that root or fix provenance.`,
        },
      };
    } else if (legacyProvenance && legacyProvenance.projectRoot !== layout.absolute) {
      return {
        memoryRoot: null,
        blocker: {
          code: 'legacy_owner_mismatch',
          message: 'Legacy memory provenance names a different projectRoot than requested.',
          legacyMemoryRoot: layout.legacyMemoryRoot,
          manualReconciliation:
            `Legacy store is owned by ${legacyProvenance.projectRoot}. ` +
            'Use that project root or relocate memories with explicit provenance before retry.',
        },
      };
    }

    if (legacyProvenance?.projectRoot === layout.absolute || !legacyProvenance) {
      if (!legacyProvenance) {
        writeMemoryProvenance(layout.legacyProjectDir, {
          slugFormat: 'legacy-v0',
          projectRoot: layout.absolute,
        });
      }

      const record = runMigrationCopy(layout, migration);
      writeJsonAtomic(join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE), record);
      writeMemoryProvenance(layout.canonicalProjectDir, {
        slugFormat: 'digest-v1',
        projectRoot: layout.absolute,
      });

      if (record.status === 'partial') {
        const resume = runMigrationCopy(layout, record);
        writeJsonAtomic(join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE), resume);
      }

      return { memoryRoot: layout.canonicalMemoryRoot };
    }

    writeMemoryProvenance(layout.canonicalProjectDir, {
      slugFormat: 'digest-v1',
      projectRoot: layout.absolute,
    });
    return { memoryRoot: layout.canonicalMemoryRoot };
  } catch (err) {
    console.warn(
      `Babel memory: resolve failed for "${projectRoot}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      memoryRoot: null,
      blocker: {
        code: 'ambiguous_legacy_collision',
        message: err instanceof Error ? err.message : String(err),
        manualReconciliation: 'Inspect ~/.babel/projects and memory logs.',
      },
    };
  }
}

/** @returns true when legacy memory files still exist (non-destructive migration). */
export function legacyMemoryPreserved(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const layout = pathsForProject(projectRoot, env);
  try {
    const legacyDir = layout.legacyMemoryRoot;
    if (!existsSync(legacyDir)) return false;
    return readdirSync(legacyDir).some((n) => n.endsWith('.md'));
  } catch {
    return false;
  }
}
