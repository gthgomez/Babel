import { join } from 'node:path';

import {
  MEMORY_ESTABLISHMENT_FILE,
  type MemoryEstablishment,
  type MemoryMigrationRecord,
  type MemoryProvenance,
} from './memoryStoreLayout.js';
import { projectRootMatches } from './memoryStoreIdentity.js';
import { readJsonFile, writeJsonAtomic } from './memoryStoreMigrationIO.js';

export function readMemoryEstablishment(projectDir: string): MemoryEstablishment | null {
  const raw = readJsonFile<MemoryEstablishment>(join(projectDir, MEMORY_ESTABLISHMENT_FILE));
  if (!raw || raw.schemaVersion !== 1) return null;
  if (!raw.provenance || !raw.migration) return null;
  if (raw.migration.schemaVersion !== 1 || raw.provenance.schemaVersion !== 1) return null;
  return raw;
}

export function writeMemoryEstablishmentAtomic(
  projectDir: string,
  input: {
    projectRoot: string;
    provenance: Omit<MemoryProvenance, 'schemaVersion' | 'establishedAt'> & { establishedAt?: string };
    migration: MemoryMigrationRecord;
    source: MemoryEstablishment['source'];
    establishedAt?: string;
  },
): void {
  const establishedAt = input.establishedAt ?? new Date().toISOString();
  const bundle: MemoryEstablishment = {
    schemaVersion: 1,
    projectRoot: input.projectRoot,
    establishedAt,
    source: input.source,
    provenance: {
      schemaVersion: 1,
      establishedAt: input.provenance.establishedAt ?? establishedAt,
      slugFormat: input.provenance.slugFormat,
      projectRoot: input.provenance.projectRoot,
    },
    migration: input.migration,
  };
  writeJsonAtomic(join(projectDir, MEMORY_ESTABLISHMENT_FILE), bundle);
}

export function isOwnershipEstablishmentComplete(
  absoluteProjectRoot: string,
  establishment: MemoryEstablishment | null,
): boolean {
  if (!establishment) return false;
  if (!projectRootMatches(establishment.projectRoot, absoluteProjectRoot)) return false;
  if (establishment.migration.status !== 'complete') return false;
  if (!projectRootMatches(establishment.migration.projectRoot, absoluteProjectRoot)) return false;
  if (!projectRootMatches(establishment.provenance.projectRoot, absoluteProjectRoot)) return false;
  return true;
}
