/**
 * Non-destructive legacy → canonical memory store migration with provenance checks.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { MEMORY_INDEX_NAME } from './memoryTypes.js';
import { copyMemoryFileExclusive } from './memoryStoreCopy.js';
import {
  isOwnershipEstablishmentComplete,
  readMemoryEstablishment,
  writeMemoryEstablishmentAtomic,
} from './memoryStoreEstablishment.js';
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

export function readMemoryProvenance(projectDir: string): MemoryProvenance | null {
  const establishment = readMemoryEstablishment(projectDir);
  if (establishment) return establishment.provenance;
  const raw = readJsonFile<MemoryProvenance>(join(projectDir, MEMORY_PROVENANCE_FILE));
  if (!raw || raw.schemaVersion !== 1 || typeof raw.projectRoot !== 'string') return null;
  return raw;
}

export function readMemoryMigration(projectDir: string): MemoryMigrationRecord | null {
  const establishment = readMemoryEstablishment(projectDir);
  if (establishment) return establishment.migration;
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
        `Option A: legacy ${MEMORY_PROVENANCE_FILE} + automated copy. Option B: full-set ` +
        `${MEMORY_RECONCILIATION_FILE} on canonical (all .md files attested) to choose canonical bytes.`,
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
        'Align bytes and retry legacy migration, or write a full-set reconciliation file choosing canonical.',
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

function persistMigrationProgress(
  layout: ReturnType<typeof pathsForProject>,
  record: MemoryMigrationRecord,
): void {
  writeJsonAtomic(join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE), record);
}

function commitReconciliationBootstrap(
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
          'Reconciliation must attest every canonical memory file (full set) with matching fingerprints.',
        manualReconciliation:
          `Regenerate ${MEMORY_RECONCILIATION_FILE} via buildMemoryReconciliationFromCanonical, ` +
          'or remove extra unreviewed canonical files before bootstrap.',
      },
    };
  }
  const onDisk = listMemoryFileNames(layout.canonicalMemoryRoot);
  const migration: MemoryMigrationRecord = {
    schemaVersion: 1,
    status: 'complete',
    sourceLegacySlug: layout.legacySlug,
    sourceLegacyMemoryRoot: layout.legacyMemoryRoot,
    projectRoot: layout.absolute,
    migratedFiles: onDisk,
    preservedOriginal: true,
    updatedAt: new Date().toISOString(),
  };
  writeMemoryEstablishmentAtomic(layout.canonicalProjectDir, {
    projectRoot: layout.absolute,
    source: 'reconciliation',
    provenance: { slugFormat: 'digest-v1', projectRoot: layout.absolute },
    migration,
  });
  return { memoryRoot: layout.canonicalMemoryRoot };
}

function openEstablishedCanonicalStore(
  layout: ReturnType<typeof pathsForProject>,
): MemoryRootResolution | null {
  const establishment = readMemoryEstablishment(layout.canonicalProjectDir);
  if (isOwnershipEstablishmentComplete(layout.absolute, establishment)) {
    return { memoryRoot: layout.canonicalMemoryRoot };
  }

  const migration = readMemoryMigration(layout.canonicalProjectDir);
  if (migration?.status === 'partial' || migration?.status === 'blocked_conflict') {
    return null;
  }

  const canonicalProvenance = readMemoryProvenance(layout.canonicalProjectDir);
  if (!canonicalProvenance || !provenanceMatchesProjectRoot(canonicalProvenance, layout.absolute)) {
    return null;
  }

  if (migration?.status === 'complete' && projectRootMatches(migration.projectRoot, layout.absolute)) {
    return { memoryRoot: layout.canonicalMemoryRoot };
  }

  if (!migration && !memoryRootHasContent(layout.legacyMemoryRoot)) {
    return { memoryRoot: layout.canonicalMemoryRoot };
  }

  return null;
}

function migrateFromValidatedLegacy(layout: ReturnType<typeof pathsForProject>): MemoryRootResolution {
  const migration = readMemoryMigration(layout.canonicalProjectDir);
  let record = runMigrationCopy(layout, migration);
  persistMigrationProgress(layout, record);
  if (record.status === 'partial') {
    record = runMigrationCopy(layout, record);
    persistMigrationProgress(layout, record);
  }
  if (record.status === 'blocked_conflict' && record.conflicts?.length) {
    return conflictBlocker(layout, record.conflicts);
  }
  if (record.status !== 'complete') {
    return {
      memoryRoot: null,
      blocker: {
        code: 'unproven_legacy_attribution',
        message: 'Legacy migration incomplete; ownership not established.',
        manualReconciliation: 'Retry resolve after legacy copy completes; partial stores stay blocked.',
      },
    };
  }
  writeMemoryEstablishmentAtomic(layout.canonicalProjectDir, {
    projectRoot: layout.absolute,
    source: 'legacy_migration',
    provenance: { slugFormat: 'digest-v1', projectRoot: layout.absolute },
    migration: record,
  });
  return { memoryRoot: layout.canonicalMemoryRoot };
}

function retryPendingMigration(
  layout: ReturnType<typeof pathsForProject>,
  migration: MemoryMigrationRecord,
  legacyProvenance: MemoryProvenance | null,
): MemoryRootResolution | null {
  if (!projectRootMatches(migration.projectRoot, layout.absolute)) return null;
  if (migration.status !== 'partial' && migration.status !== 'blocked_conflict') return null;

  const recon = commitReconciliationBootstrap(layout);
  if (recon?.memoryRoot) return recon;
  if (recon?.blocker?.code === 'reconciliation_invalid') return recon;

  if (!legacyProvenance || !provenanceMatchesProjectRoot(legacyProvenance, layout.absolute)) {
    if (migration.status === 'blocked_conflict' && migration.conflicts?.length) {
      return conflictBlocker(layout, migration.conflicts);
    }
    return unprovenBlocker(layout);
  }
  return migrateFromValidatedLegacy(layout);
}

export function resolveMemoryRootWithMigration(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): MemoryRootResolution {
  const layout = pathsForProject(projectRoot, env);
  const legacyProvenance = readMemoryProvenance(layout.legacyProjectDir);
  const migration = readMemoryMigration(layout.canonicalProjectDir);

  const canonicalHasContent = memoryRootHasContent(layout.canonicalMemoryRoot);
  const legacyHasContent = memoryRootHasContent(layout.legacyMemoryRoot);

  try {
    mkdirSync(layout.canonicalMemoryRoot, { recursive: true });

    if (migration) {
      const pending = retryPendingMigration(layout, migration, legacyProvenance);
      if (pending) return pending;
    }

    const established = openEstablishedCanonicalStore(layout);
    if (established) return established;

    if (canonicalHasContent && !legacyHasContent) {
      const reconOnly = commitReconciliationBootstrap(layout);
      if (reconOnly?.memoryRoot) return reconOnly;
      if (reconOnly?.blocker) return reconOnly;
    }

    if (!legacyHasContent) {
      if (canonicalHasContent) {
        return commitReconciliationBootstrap(layout) ?? {
          memoryRoot: null,
          blocker: {
            code: 'reconciliation_invalid',
            message: 'Canonical memory requires full-set reconciliation before first use.',
            manualReconciliation: `Write ${MEMORY_RECONCILIATION_FILE} attesting every file.`,
          },
        };
      }
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
            'Copy needed .md files into canonical memory and add full-set reconciliation.',
        },
      };
    }

    if (legacyHasContent && canonicalHasContent) {
      const recon = commitReconciliationBootstrap(layout);
      if (recon?.memoryRoot) return recon;
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
              `Legacy store is owned by ${legacyProvenance.projectRoot}.`,
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
