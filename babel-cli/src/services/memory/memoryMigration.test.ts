/**
 * Legacy → digest memory store migration: validated provenance, collision families, idempotency.
 */

import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { readMemoryEstablishment } from './memoryStoreEstablishment.js';
import { MEMORY_ESTABLISHMENT_FILE } from './memoryStoreLayout.js';
import {
  buildMemoryReconciliationFromCanonical,
  writeMemoryReconciliation,
} from './memoryStoreReconciliation.js';
import { copyMemoryFileExclusive } from './memoryStoreCopy.js';

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

  it('blocks migration when same-name canonical bytes differ', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-conflict-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemoryProvenance(layout.legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: layout.absolute,
      });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'fact',
        description: 'legacy',
        metadata: { type: 'reference' },
      }, 'legacy version');
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      writeFileSync(join(layout.canonicalMemoryRoot, 'fact.md'), `---
name: fact
description: canon
metadata:
  type: reference
---

canonical version
`, 'utf-8');

      const res = resolveMemoryRootWithMigration(project);
      assert.equal(res.memoryRoot, null);
      assert.equal(res.blocker?.code, 'migration_content_conflict');
      assert.match(
        readFileSync(join(layout.canonicalMemoryRoot, 'fact.md'), 'utf-8'),
        /canonical version/,
      );
      const migration = readMemoryMigration(layout.canonicalProjectDir);
      assert.equal(migration?.status, 'blocked_conflict');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('reconcile then write/edit still resolves via established digest provenance', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-lifecycle-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'legacy-blocker',
        description: 'legacy',
        metadata: { type: 'reference' },
      }, 'blocks unproven-only path');
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      writeFileSync(
        join(layout.canonicalMemoryRoot, 'seed.md'),
        `---
name: seed
description: seed
metadata:
  type: reference
---

seed body
`,
        'utf-8',
      );
      const record = buildMemoryReconciliationFromCanonical(project);
      assert.ok(record);
      writeMemoryReconciliation(layout.canonicalProjectDir, record!);
      assert.ok(resolveMemoryRoot(project));

      assert.ok(
        writeMemory(layout.canonicalMemoryRoot, {
          name: 'added-later',
          description: 'edited',
          metadata: { type: 'reference' },
        }, 'new content'),
      );

      const third = resolveMemoryRootWithMigration(project);
      assert.ok(third.memoryRoot);
      assert.ok(findByName(third.memoryRoot!, 'added-later'));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('conflict then repair to identical bytes clears blocked_conflict on next resolve', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-repair-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemoryProvenance(layout.legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: layout.absolute,
      });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'fact',
        description: 'legacy',
        metadata: { type: 'reference' },
      }, 'aligned body');
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      writeFileSync(join(layout.canonicalMemoryRoot, 'fact.md'), `---
name: fact
description: canon
metadata:
  type: reference
---

different
`, 'utf-8');

      assert.equal(resolveMemoryRootWithMigration(project).blocker?.code, 'migration_content_conflict');
      const legacyBody = readFileSync(join(layout.legacyMemoryRoot, 'fact.md'), 'utf-8');
      writeFileSync(join(layout.canonicalMemoryRoot, 'fact.md'), legacyBody, 'utf-8');

      const repaired = resolveMemoryRoot(project);
      assert.ok(repaired);
      assert.equal(readMemoryMigration(layout.canonicalProjectDir)?.status, 'complete');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('explicit reconciliation opens canonical store without legacy provenance', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-recon-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'unproven',
        description: 'legacy',
        metadata: { type: 'reference' },
      }, 'legacy-only');
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      writeFileSync(
        join(layout.canonicalMemoryRoot, 'operator.md'),
        `---
name: operator
description: op
metadata:
  type: reference
---

operator canonical
`,
        'utf-8',
      );
      const record = buildMemoryReconciliationFromCanonical(project);
      assert.ok(record);
      writeMemoryReconciliation(layout.canonicalProjectDir, record!);

      const res = resolveMemoryRootWithMigration(project);
      assert.ok(res.memoryRoot);
      assert.ok(findByName(res.memoryRoot!, 'operator'));
      assert.equal(resolveMemoryRootWithMigration(project).blocker, undefined);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not treat differing same-name files as migrated (copy helper regression)', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-mem-migrate-helper-'));
    const src = join(root, 'src');
    const dest = join(root, 'dest');
    try {
      mkdirSync(src);
      mkdirSync(dest);
      writeFileSync(join(src, 'x.md'), 'one', 'utf-8');
      writeFileSync(join(dest, 'x.md'), 'two', 'utf-8');
      assert.equal(copyMemoryFileExclusive(src, dest, 'x.md').status, 'conflict');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects bootstrap when an extra unreviewed canonical file exists (full-set)', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-fullset-neg-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      writeFileSync(join(layout.canonicalMemoryRoot, 'attested.md'), `---
name: attested
description: a
metadata:
  type: reference
---

a
`, 'utf-8');
      writeFileSync(join(layout.canonicalMemoryRoot, 'sneaky-extra.md'), `---
name: sneaky
description: x
metadata:
  type: reference
---

x
`, 'utf-8');
      const record = buildMemoryReconciliationFromCanonical(project);
      assert.ok(record);
      writeMemoryReconciliation(layout.canonicalProjectDir, {
        ...record!,
        memoryFiles: record!.memoryFiles.filter((f) => f.name === 'attested.md'),
      });

      const res = resolveMemoryRootWithMigration(project);
      assert.equal(res.memoryRoot, null);
      assert.equal(res.blocker?.code, 'reconciliation_invalid');
      assert.equal(readMemoryEstablishment(layout.canonicalProjectDir), null);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('partial migration does not establish ownership until complete', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-partial-est-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemoryProvenance(layout.legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: layout.absolute,
      });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'one',
        description: '1',
        metadata: { type: 'reference' },
      }, '1');
      writeMemory(layout.legacyMemoryRoot, {
        name: 'two',
        description: '2',
        metadata: { type: 'reference' },
      }, '2');
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      copyFileSync(join(layout.legacyMemoryRoot, 'one.md'), join(layout.canonicalMemoryRoot, 'one.md'));
      writeFileSync(
        join(layout.canonicalProjectDir, MEMORY_MIGRATION_FILE),
        `${JSON.stringify({
          schemaVersion: 1,
          status: 'partial',
          sourceLegacySlug: layout.legacySlug,
          sourceLegacyMemoryRoot: layout.legacyMemoryRoot,
          projectRoot: layout.absolute,
          migratedFiles: ['one.md'],
          preservedOriginal: true,
          updatedAt: new Date().toISOString(),
        })}\n`,
        'utf-8',
      );

      assert.equal(readMemoryEstablishment(layout.canonicalProjectDir), null);
      const first = resolveMemoryRootWithMigration(project);
      assert.ok(first.memoryRoot);
      assert.equal(readMemoryMigration(layout.canonicalProjectDir)?.status, 'complete');
      assert.ok(readMemoryEstablishment(layout.canonicalProjectDir));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('interrupted bootstrap: corrupt establishment does not unlock store', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-interrupt-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.canonicalProjectDir, { recursive: true });
      writeFileSync(join(layout.canonicalProjectDir, MEMORY_ESTABLISHMENT_FILE), '{ broken', 'utf-8');
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'legacy',
        description: 'l',
        metadata: { type: 'reference' },
      }, 'legacy');
      const res = resolveMemoryRootWithMigration(project);
      assert.equal(readMemoryEstablishment(layout.canonicalProjectDir), null);
      assert.equal(res.memoryRoot, null);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('blocked_conflict uses full-set reconciliation to choose canonical over legacy', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-recon-override-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.legacyMemoryRoot, { recursive: true });
      writeMemoryProvenance(layout.legacyProjectDir, {
        slugFormat: 'legacy-v0',
        projectRoot: layout.absolute,
      });
      writeMemory(layout.legacyMemoryRoot, {
        name: 'fact',
        description: 'legacy',
        metadata: { type: 'reference' },
      }, 'legacy');
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      writeFileSync(join(layout.canonicalMemoryRoot, 'fact.md'), `---
name: fact
description: c
metadata:
  type: reference
---

canonical wins
`, 'utf-8');
      assert.equal(resolveMemoryRootWithMigration(project).blocker?.code, 'migration_content_conflict');

      const record = buildMemoryReconciliationFromCanonical(project);
      assert.ok(record);
      writeMemoryReconciliation(layout.canonicalProjectDir, {
        ...record!,
        canonicalAuthoritativeOverLegacy: true,
      });
      const opened = resolveMemoryRoot(project);
      assert.ok(opened);
      assert.match(readFileSync(join(opened!, 'fact.md'), 'utf-8'), /canonical wins/);
      assert.ok(readMemoryEstablishment(layout.canonicalProjectDir));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('fresh greenfield lifecycle: resolve → writeMemory → resolve → edit (public API)', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-fresh-lifecycle-'));
    try {
      const first = resolveMemoryRoot(project);
      assert.ok(first);
      assert.ok(readMemoryEstablishment(pathsForProject(project).canonicalProjectDir));

      assert.ok(
        writeMemory(first!, {
          name: 'first-write',
          description: 'fresh',
          metadata: { type: 'reference' },
        }, 'initial body'),
      );
      const second = resolveMemoryRoot(project);
      assert.ok(second);
      assert.ok(findByName(second!, 'first-write'));

      assert.ok(
        writeMemory(second!, {
          name: 'first-write',
          description: 'fresh',
          metadata: { type: 'reference' },
        }, 'edited body'),
      );
      const third = resolveMemoryRoot(project);
      assert.ok(third);
      assert.equal(findByName(third!, 'first-write')?.body.trim(), 'edited body');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('pre-existing unreviewed canonical files block without full-set reconciliation', () => {
    const project = mkdtempSync(join(tmpdir(), 'babel-mem-preexisting-unproven-'));
    try {
      const layout = pathsForProject(project);
      mkdirSync(layout.canonicalMemoryRoot, { recursive: true });
      writeFileSync(join(layout.canonicalMemoryRoot, 'dropped-in.md'), `---
name: dropped-in
description: x
metadata:
  type: reference
---

unreviewed
`, 'utf-8');

      const res = resolveMemoryRootWithMigration(project);
      assert.equal(res.memoryRoot, null);
      assert.equal(res.blocker?.code, 'reconciliation_invalid');
      assert.equal(readMemoryEstablishment(layout.canonicalProjectDir), null);
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
