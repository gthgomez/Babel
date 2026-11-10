/**
 * Legacy → digest memory store migration: validated provenance, collision families, idempotency.
 */

import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { findByName, resolveMemoryRoot, writeMemory } from './memoryStore.js';
import {
  legacySlugCaseCollides,
  legacySlugSanitizeCollides,
} from './memoryStoreCollision.js';
import {
  MEMORY_MIGRATION_FILE,
  MEMORY_PROVENANCE_FILE,
  legacyMemoryProjectSlug,
  memoryRootForSlug,
  pathsForProject,
} from './memoryStoreLayout.js';
import {
  legacyMemoryPreserved,
  provenanceMatchesProjectRoot,
  readMemoryMigration,
  readMemoryProvenance,
  resolveMemoryRootWithMigration,
  writeMemoryProvenance,
} from './memoryStoreMigration.js';

describe('memory legacy migration', () => {
  let stateDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-state-'));
    prevStateDir = process.env['BABEL_STATE_DIR'];
    process.env['BABEL_STATE_DIR'] = stateDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env['BABEL_STATE_DIR'];
    else process.env['BABEL_STATE_DIR'] = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('migrates a provenanced legacy store without destroying originals', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-proj-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemoryProvenance(layout.legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: layout.absolute,
      });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'build-cmd',
        description: 'how to build',
        metadata: { type: 'reference' },
      }, 'npm run build');

      const resolved = resolveMemoryRoot(project);
      assert.ok(resolved);
      assert.equal(findByName(resolved!, 'build-cmd')?.body.trim(), 'npm run build');
      assert.ok(existsSync(join(layout.legacyMemoryRoot, 'build-cmd.md')));
      const migration = readMemoryMigration(layout.canonicalProjectDir);
      assert.equal(migration?.status, 'complete');
      assert.equal(migration?.preservedOriginal, true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('refuses legacy content without validated provenance (no inference stamping)', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-unproven-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'lint-cmd',
        description: 'lint',
        metadata: { type: 'reference' },
      }, 'npm run lint');

      const res = resolveMemoryRootWithMigration(project);
      assert.equal(res.memoryRoot, null);
      assert.equal(res.blocker?.code, 'unproven_legacy_attribution');
      assert.ok(existsSync(join(layout.legacyMemoryRoot, 'lint-cmd.md')));
      assert.ok(legacyMemoryPreserved(project));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('matches provenance under Windows-style path identity (resolve-normalized)', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-winid-'));
    try {
      const layout = pathsForProject(project);
      const viaDot = resolve(layout.absolute, '.');
      writeMemoryProvenance(layout.legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: viaDot,
      });
      assert.ok(provenanceMatchesProjectRoot(readMemoryProvenance(layout.legacyProjectDir)!, layout.absolute));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('refuses shared legacy store for sanitize-colliding roots without provenance', () => {
    const parent = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-case-'));
    const upper = join(parent, 'CaseProject');
    const lower = join(parent, 'caseproject');
    try {
      assert.ok(legacySlugSanitizeCollides([upper, lower]));
      const legacySlug = legacyMemoryProjectSlug(upper);
      const legacyRoot = memoryRootForSlug(legacySlug);
      mkdirSync(legacyRoot, { recursive: true });
      writeMemory(legacyRoot, {
        name: 'shared-fact',
        description: 'ambiguous',
        metadata: { type: 'project' },
      }, 'mixed ownership');

      const upperRes = resolveMemoryRootWithMigration(upper);
      const lowerRes = resolveMemoryRootWithMigration(lower);
      assert.equal(upperRes.memoryRoot, null);
      assert.equal(lowerRes.memoryRoot, null);
      assert.equal(upperRes.blocker?.code, 'unproven_legacy_attribution');
      assert.equal(lowerRes.blocker?.code, 'unproven_legacy_attribution');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('detects punctuation collision family in legacy slug fold', () => {
    const a = '/tmp/demo/proj/foo:bar';
    const b = '/tmp/demo/proj/foo-bar';
    assert.ok(legacySlugSanitizeCollides([a, b]));
    assert.ok(legacySlugCaseCollides([a, b]));
  });

  it('migrates for proven owner when sanitize-colliding siblings exist', () => {
    const parent = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-proven-'));
    const upper = join(parent, 'CaseProject');
    const lower = join(parent, 'caseproject');
    try {
      mkdirSync(upper, { recursive: true });
      try {
        mkdirSync(lower, { recursive: true });
      } catch {
        // Case-insensitive volume: single directory covers both names.
      }
      const legacySlug = legacyMemoryProjectSlug(upper);
      const legacyProjectDir = join(stateDir, 'projects', legacySlug);
      const legacyRoot = join(legacyProjectDir, 'memory');
      mkdirSync(legacyRoot, { recursive: true });
      writeMemoryProvenance(legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: upper,
      });
      writeMemory(legacyRoot, {
        name: 'owner-only',
        description: 'for upper',
        metadata: { type: 'project' },
      }, 'upper body');

      const upperResolved = resolveMemoryRoot(upper);
      assert.ok(upperResolved);
      assert.ok(findByName(upperResolved!, 'owner-only'));
      const lowerRes = resolveMemoryRootWithMigration(lower);
      assert.equal(lowerRes.memoryRoot, null);
      assert.ok(['legacy_owner_mismatch', 'unproven_legacy_attribution'].includes(lowerRes.blocker?.code ?? ''));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('migration is idempotent across repeated resolve', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-idem-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemoryProvenance(layout.legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: layout.absolute,
      });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'once',
        description: 'once',
        metadata: { type: 'reference' },
      }, 'body');
      const first = resolveMemoryRoot(project);
      const second = resolveMemoryRoot(project);
      assert.equal(first, second);
      const migration = readMemoryMigration(layout.canonicalProjectDir);
      assert.equal(migration?.status, 'complete');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('resumes partial migration without losing legacy originals when provenance validates', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-partial-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemoryProvenance(layout.legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: layout.absolute,
      });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'first',
        description: 'first',
        metadata: { type: 'reference' },
      }, 'one');
      writeMemory(layout.legacyMemoryRoot, {
        name: 'second',
        description: 'second',
        metadata: { type: 'reference' },
      }, 'two');

      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      copyFileSync(
        join(layout.legacyMemoryRoot, 'first.md'),
        join(layout.canonicalMemoryRoot, 'first.md'),
      );
      writeFileSync(
        join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE),
        `${JSON.stringify({
          schemaVersion: 1,
          status: 'partial',
          sourceLegacySlug: layout.legacySlug,
          sourceLegacyMemoryRoot: layout.legacyMemoryRoot,
          projectRoot: layout.absolute,
          migratedFiles: ['first.md'],
          preservedOriginal: true,
          updatedAt: new Date().toISOString(),
        })}\n`,
        'utf-8',
      );

      const resolved = resolveMemoryRoot(project);
      assert.ok(resolved);
      assert.ok(findByName(resolved!, 'first'));
      assert.ok(findByName(resolved!, 'second'));
      assert.ok(existsSync(join(layout.legacyMemoryRoot, 'second.md')));
      assert.equal(readMemoryMigration(layout.canonicalProjectDir)?.status, 'complete');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('refuses partial resume without validated legacy provenance', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-partial-block-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'solo',
        description: 'solo',
        metadata: { type: 'reference' },
      }, 'solo');
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      writeFileSync(
        join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE),
        `${JSON.stringify({
          schemaVersion: 1,
          status: 'partial',
          sourceLegacySlug: layout.legacySlug,
          sourceLegacyMemoryRoot: layout.legacyMemoryRoot,
          projectRoot: layout.absolute,
          migratedFiles: [],
          preservedOriginal: true,
          updatedAt: new Date().toISOString(),
        })}\n`,
        'utf-8',
      );

      const res = resolveMemoryRootWithMigration(project);
      assert.equal(res.memoryRoot, null);
      assert.equal(res.blocker?.code, 'unproven_legacy_attribution');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('refuses degenerate legacy shared bucket with content', () => {
    const degenerate = memoryRootForSlug('');
    mkdirSync(degenerate, { recursive: true });
    writeMemory(degenerate, {
      name: 'shared',
      description: 'shared',
      metadata: { type: 'project' },
    }, 'shared body');

    const res = resolveMemoryRootWithMigration('///');
    assert.equal(res.memoryRoot, null);
    assert.equal(res.blocker?.code, 'shared_empty_legacy_bucket');
    assert.ok(existsSync(join(degenerate, 'shared.md')));
  });
});
