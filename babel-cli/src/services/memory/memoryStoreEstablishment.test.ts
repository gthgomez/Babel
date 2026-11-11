import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { pathsForProject } from './memoryStoreLayout.js';
import {
  isOwnershipEstablishmentComplete,
  readMemoryEstablishment,
  writeMemoryEstablishmentAtomic,
} from './memoryStoreEstablishment.js';

describe('memoryStoreEstablishment', () => {
  it('writes and reads a single atomic establishment bundle', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-est-'));
    const layout = pathsForProject(project);
    try {
      mkdirSync(layout.canonicalProjectDir, { recursive: true });
      const migration = {
        schemaVersion: 1 as const,
        status: 'complete' as const,
        sourceLegacySlug: layout.legacySlug,
        sourceLegacyMemoryRoot: layout.legacyMemoryRoot,
        projectRoot: layout.absolute,
        migratedFiles: ['a.md'],
        preservedOriginal: true as const,
        updatedAt: new Date().toISOString(),
      };
      writeMemoryEstablishmentAtomic(layout.canonicalProjectDir, {
        projectRoot: layout.absolute,
        source: 'reconciliation',
        provenance: { slugFormat: 'digest-v1', projectRoot: layout.absolute },
        migration,
      });
      const est = readMemoryEstablishment(layout.canonicalProjectDir);
      assert.ok(est);
      assert.ok(isOwnershipEstablishmentComplete(layout.absolute, est));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
