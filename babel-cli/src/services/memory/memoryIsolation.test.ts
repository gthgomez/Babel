/**
 * Memory store isolation: distinct project roots must not share ~/.babel/projects/* stores.
 * Regression for sanitizeGitRoot slug collisions (case folding, empty slug).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  deriveMemoryProjectSlug,
  findByName,
  resolveMemoryRoot,
  sanitizeGitRoot,
  writeMemory,
} from './memoryStore.js';

describe('memory project slug isolation', () => {
  let stateDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'babel-mem-isolation-state-'));
    prevStateDir = process.env['BABEL_STATE_DIR'];
    process.env['BABEL_STATE_DIR'] = stateDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env['BABEL_STATE_DIR'];
    else process.env['BABEL_STATE_DIR'] = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('deriveMemoryProjectSlug never returns an empty slug for degenerate paths', () => {
    assert.equal(sanitizeGitRoot('///'), '');
    const slug = deriveMemoryProjectSlug('///');
    assert.ok(slug.length > 0);
    assert.match(slug, /^root--[0-9a-f]{16}$/);
  });

  it('case-only distinct absolute paths get distinct memory roots', () => {
    const parent = mkdtempSync(join(tmpdir(), 'babel-mem-case-parent-'));
    const upper = join(parent, 'CaseProject');
    const lower = join(parent, 'caseproject');
    try {
      mkdirSync(upper, { recursive: true });
      mkdirSync(lower, { recursive: true });
      assert.equal(sanitizeGitRoot(upper), sanitizeGitRoot(lower), 'slug fold collides before digest');

      const slugA = deriveMemoryProjectSlug(upper);
      const slugB = deriveMemoryProjectSlug(lower);
      assert.notEqual(slugA, slugB, 'distinct dirs must not alias after case folding');

      const rootA = resolveMemoryRoot(upper);
      const rootB = resolveMemoryRoot(lower);
      assert.ok(rootA);
      assert.ok(rootB);
      assert.notEqual(rootA, rootB);

      assert.ok(writeMemory(rootA!, {
        name: 'secret-a',
        description: 'memory for CaseProject',
        metadata: { type: 'project' },
      }, 'only in upper'));
      assert.equal(findByName(rootB!, 'secret-a'), null);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('read-only control: identical resolved paths reuse the same slug', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-mem-stable-'));
    try {
      const a = deriveMemoryProjectSlug(dir);
      const b = deriveMemoryProjectSlug(join(dir, '.'));
      assert.equal(a, b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contamination: memory written in project A is invisible under project B root', () => {
    const base = mkdtempSync(join(tmpdir(), 'babel-mem-xproj-'));
    const projectA = join(base, 'alpha');
    const projectB = join(base, 'beta');
    try {
      mkdirSync(projectA);
      mkdirSync(projectB);
      writeFileSync(join(projectA, 'package.json'), '{}');
      writeFileSync(join(projectB, 'package.json'), '{}');

      const memA = resolveMemoryRoot(projectA);
      const memB = resolveMemoryRoot(projectB);
      assert.ok(memA && memB);
      writeMemory(memA, {
        name: 'alpha-fact',
        description: 'belongs to alpha',
        metadata: { type: 'reference' },
      }, 'alpha body');

      assert.equal(findByName(memB, 'alpha-fact'), null);
      assert.ok(findByName(memA, 'alpha-fact'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
