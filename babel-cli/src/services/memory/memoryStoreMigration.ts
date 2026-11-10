/**
 * Non-destructive legacy → canonical memory store migration with provenance checks.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MEMORY_INDEX_NAME } from './memoryTypes.js';
import { copyMemoryFileExclusive } from './memoryStoreCopy.js';
import { projectRootMatches, provenanceMatchesProjectRoot } from './memoryStoreIdentity.js';
import {
  MEMORY_MIGRATION_FILE,
  MEMORY_PROVENANCE_FILE,
  MEMORY_RECONCILIATION_FILE,
  type MemoryMigrationConflict,
  type MemoryMigrationRecord,
  type MemoryProvenance,
  pathsForProject,
} from './memoryStoreLayout.js';
import { readJsonFile, writeJsonAtomic } from './memoryStoreMigrationIO.js';
import {
  readMemoryReconciliation,
  validateReconciliationBootstrap,
} from './memoryStoreReconciliation.js';

export type MemoryRootBlockerCode =
  | 'ambiguous_legacy_collision'
  | 'legacy_owner_mismatch'
  | 'shared_empty_legacy_bucket'
  | 'unproven_legacy_attribution'
  | 'migration_content_conflict'
  | 'reconciliation_invalid';

export interface MemoryRootResolution {
  memoryRoot: string | null;
  blocker?: {
    code: MemoryRootBlockerCode;
    message: string;
    legacyMemoryRoot?: string;
    manualReconciliation: string;
  };
}

export { provenanceMatchesProjectRoot } from './memoryStoreIdentity.js';

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

export function isDegenerateLegacySharedBucket(legacySlug: string): boolean {
  return legacySlug.length === 0;
}

function unprovenBlocker(layout: ReturnType<typeof pathsForProject>): MemoryRootResolution {
  return {
    memoryRoot: null,
    blocker: {
      code: 'unproven_legacy_attribution',
      message:
        'Legacy memory exists but owner was not validated. Historical slug collisions cannot be inferred.',
      legacyMemoryRoot: layout.legacyMemoryRoot,
      manualReconciliation:
        `Option A: add ${MEMORY_PROVENANCE_FILE} on the legacy project dir with exact ` +
        `"projectRoot" and retry automated copy. Option B: place memories under ` +
        `${layout.canonicalMemoryRoot}, write ${MEMORY_RECONCILIATION_FILE} attesting ` +
        'every canonical .md fingerprint (see buildMemoryReconciliationFromCanonical).',
    },
  };
}

function conflictBlocker(
  layout: ReturnType<typeof pathsForProject>,
  conflicts: MemoryMigrationConflict[],
): MemoryRootResolution {
  return {
    memoryRoot: null,
    blocker: {
      code: 'migration_content_conflict',
      message:
        `Canonical destination differs from legacy for ${conflicts.length} file(s); destination bytes preserved.`,
      legacyMemoryRoot: layout.legacyMemoryRoot,
      manualReconciliation:
        'Rename or merge conflicting memories manually, align content and re-run migration, ' +
        `or use ${MEMORY_RECONCILIATION_FILE} if canonical bytes are authoritative.`,
    },
  };
}

function runMigrationCopy(
  layout: ReturnType<typeof pathsForProject>,
  existing: MemoryMigrationRecord | null,
): MemoryMigrationRecord {
  const migrated = new Set(existing?.migratedFiles ?? []);
  const conflicts: MemoryMigrationConflict[] = [];
  const legacyNames = listMemoryFileNames(layout.legacyMemoryRoot);
  mkdirSync(layout.canonicalMemoryRoot, { recursive: true });

  for (const name of legacyNames) {
    const outcome = copyMemoryFileExclusive(
      layout.legacyMemoryRoot,
      layout.canonicalMemoryRoot,
      name,
    );
    if (outcome.status === 'created' || outcome.status === 'identical') {
      migrated.add(name);
    } else if (outcome.status === 'conflict') {
      conflicts.push({
        file: name,
        contentSha256Legacy: outcome.contentSha256Legacy,
        contentSha256Canonical: outcome.contentSha256Canonical,
      });
    }
  }

  const allPresent =
    legacyNames.length === 0 ||
    legacyNames.every((n) => migrated.has(n) && existsSync(join(layout.canonicalMemoryRoot, n)));

  const status = conflicts.length > 0 ? 'blocked_conflict' : allPresent ? 'complete' : 'partial';

  return {
    schemaVersion: 1,
    status,
    sourceLegacySlug: layout.legacySlug,
    sourceLegacyMemoryRoot: layout.legacyMemoryRoot,
    projectRoot: layout.absolute,
    migratedFiles: [...migrated],
    ...(conflicts.length > 0 ? { conflicts } : {}),
    preservedOriginal: true,
    updatedAt: new Date().toISOString(),
  };
}

function tryExplicitReconciliation(
  layout: ReturnType<typeof pathsForProject>,
): MemoryRootResolution | null {
  const record = readMemoryReconciliation(layout.canonicalProjectDir);
  if (!record || !memoryRootHasContent(layout.canonicalMemoryRoot)) return null;
  if (!validateReconciliationBootstrap(layout.absolute, layout.canonicalMemoryRoot, record)) {
    return {
      memoryRoot: null,
      blocker: {
        code: 'reconciliation_invalid',
        message:
          'Reconciliation bootstrap failed: attested files missing or bytes changed since attestation.',
        manualReconciliation:
          `Fix listed files or regenerate ${MEMORY_RECONCILIATION_FILE}; extra canonical files not in ` +
          'the attestation are allowed only after digest provenance is established.',
      },
    };
  }
  writeMemoryProvenance(layout.canonicalProjectDir, {
    slugFormat: 'digest-v1',
    projectRoot: layout.absolute,
  });
  const bootMigrated = record.memoryFiles.map((f) => f.name);
  writeJsonAtomic(join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE), {
    schemaVersion: 1,
    status: 'complete',
    sourceLegacySlug: layout.legacySlug,
    sourceLegacyMemoryRoot: layout.legacyMemoryRoot,
    projectRoot: layout.absolute,
    migratedFiles: bootMigrated,
    preservedOriginal: true,
    updatedAt: new Date().toISOString(),
  });
  return { memoryRoot: layout.canonicalMemoryRoot };
}

function openEstablishedCanonicalStore(
  layout: ReturnType<typeof pathsForProject>,
  canonicalProvenance: MemoryProvenance | null,
): MemoryRootResolution | null {
  if (!canonicalProvenance || !provenanceMatchesProjectRoot(canonicalProvenance, layout.absolute)) {
    return null;
  }
  return { memoryRoot: layout.canonicalMemoryRoot };
}

function migrateFromValidatedLegacy(layout: ReturnType<typeof pathsForProject>): MemoryRootResolution {
  const migration = readMemoryMigration(layout.canonicalProjectDir);
  let record = runMigrationCopy(layout, migration);
  writeJsonAtomic(join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE), record);
  if (record.status === 'partial') {
    record = runMigrationCopy(layout, record);
    writeJsonAtomic(join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE), record);
  }
  if (record.status === 'blocked_conflict' && record.conflicts?.length) {
    return conflictBlocker(layout, record.conflicts);
  }
  writeMemoryProvenance(layout.canonicalProjectDir, {
    slugFormat: 'digest-v1',
    projectRoot: layout.absolute,
  });
  return { memoryRoot: layout.canonicalMemoryRoot };
}

export function resolveMemoryRootWithMigration(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): MemoryRootResolution {
  const layout = pathsForProject(projectRoot, env);
  const legacyProvenance = readMemoryProvenance(layout.legacyProjectDir);
  const canonicalProvenance = readMemoryProvenance(layout.canonicalProjectDir);
  const migration = readMemoryMigration(layout.canonicalProjectDir);

  const canonicalHasContent = memoryRootHasContent(layout.canonicalMemoryRoot);
  const legacyHasContent = memoryRootHasContent(layout.legacyMemoryRoot);

  try {
    mkdirSync(layout.canonicalMemoryRoot, { recursive: true });

    const established = openEstablishedCanonicalStore(layout, canonicalProvenance);
    if (established) {
      return established;
    }

    if (migration?.status === 'complete' && projectRootMatches(migration.projectRoot, layout.absolute)) {
      writeMemoryProvenance(layout.canonicalProjectDir, {
        slugFormat: 'digest-v1',
        projectRoot: layout.absolute,
      });
      return { memoryRoot: layout.canonicalMemoryRoot };
    }

    if (
      (migration?.status === 'blocked_conflict' || migration?.status === 'partial') &&
      projectRootMatches(migration.projectRoot, layout.absolute)
    ) {
      if (!legacyProvenance || !provenanceMatchesProjectRoot(legacyProvenance, layout.absolute)) {
        if (migration.status === 'blocked_conflict') {
          return migration.conflicts?.length
            ? conflictBlocker(layout, migration.conflicts)
            : unprovenBlocker(layout);
        }
        return unprovenBlocker(layout);
      }
      return migrateFromValidatedLegacy(layout);
    }

    const reconciled = tryExplicitReconciliation(layout);
    if (reconciled?.memoryRoot) {
      return reconciled;
    }
    if (reconciled?.blocker) {
      return reconciled;
    }

    if (canonicalHasContent && !legacyHasContent) {
      if (canonicalProvenance && !provenanceMatchesProjectRoot(canonicalProvenance, layout.absolute)) {
        return {
          memoryRoot: null,
          blocker: {
            code: 'legacy_owner_mismatch',
            message: 'Canonical memory provenance does not match this project root.',
            manualReconciliation: 'Fix canonical provenance or open the owning project root.',
          },
        };
      }
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
            'Copy needed .md files into canonical memory and add reconciliation, or fix provenance on legacy.',
        },
      };
    }

    if (!legacyProvenance || !provenanceMatchesProjectRoot(legacyProvenance, layout.absolute)) {
      if (legacyProvenance && !provenanceMatchesProjectRoot(legacyProvenance, layout.absolute)) {
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
      return unprovenBlocker(layout);
    }

    return migrateFromValidatedLegacy(layout);
  } catch (err) {
    console.warn(
      `Babel memory: resolve failed for "${projectRoot}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      memoryRoot: null,
      blocker: {
        code: 'unproven_legacy_attribution',
        message: err instanceof Error ? err.message : String(err),
        manualReconciliation: 'Inspect ~/.babel/projects and memory logs.',
      },
    };
  }
}

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
