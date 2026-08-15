/**
 * P1-F — compiler sync/async parity around the lazy-stub threshold.
 *
 * Regression for the previously verified inconsistency: the async compile path
 * used an 8,000-byte lazy-stub threshold while the sync path used 6,000, so the
 * same conceptual stack could render differently depending on the compilation
 * path. Now both share one canonical threshold (compiler.ts
 * LAZY_STUB_THRESHOLD_BYTES = 6_000). These tests pin the boundary behavior
 * (<, =, >) and the previously-divergent range (6k–8k).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearCompilerCacheForTests,
  compileContext,
  compileContextSync,
} from './compiler.js';

function withCompilerEnv<T>(cachePath: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env['BABEL_CONTEXT_CACHE_PATH'];
  process.env['BABEL_CONTEXT_CACHE_PATH'] = cachePath;
  clearCompilerCacheForTests();
  return run().finally(() => {
    clearCompilerCacheForTests();
    if (previous === undefined) {
      delete process.env['BABEL_CONTEXT_CACHE_PATH'];
    } else {
      process.env['BABEL_CONTEXT_CACHE_PATH'] = previous;
    }
  });
}

/** Build a skill file of exactly `size` bytes under a temp project. */
function makeSkillProject(sizes: number[]): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'babel-compiler-parity-'));
  const skillsDir = join(root, '02_Skills');
  mkdirSync(skillsDir, { recursive: true });
  const paths = sizes.map((size, i) => {
    // Forward slashes so the '/02_Skills/' stub trigger matches on Windows too.
    const p = join(skillsDir, `Skill-${i}.md`).replace(/\\/g, '/');
    writeFileSync(p, 'x'.repeat(size), 'utf-8');
    return p;
  });
  return { root, paths };
}

for (const size of [5_999, 6_000, 6_001, 7_999, 8_000, 8_001]) {
  test(`compiler parity: skill file at ${size} bytes renders identically sync/async`, async () => {
    const { root, paths } = makeSkillProject([size]);
    const cachePath = join(root, 'compiler-cache.json');
    try {
      await withCompilerEnv(cachePath, async () => {
        const asyncContext = await compileContext(paths, 'Task.');
        const syncContext = compileContextSync(paths, 'Task.');
        assert.equal(asyncContext, syncContext, 'sync and async must render identically');
        const stubbed = asyncContext.includes('[LAZY-STUBBED]');
        assert.equal(
          stubbed,
          size > 6_000,
          `file of ${size} bytes must be ${size > 6_000 ? 'stubbed' : 'loaded'} in BOTH paths`,
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('compiler parity: mixed sizes across the boundary render identically', async () => {
  const { root, paths } = makeSkillProject([5_000, 6_000, 6_001, 8_500]);
  const cachePath = join(root, 'compiler-cache.json');
  try {
    await withCompilerEnv(cachePath, async () => {
      const asyncContext = await compileContext(paths, 'Task.');
      const syncContext = compileContextSync(paths, 'Task.');
      assert.equal(asyncContext, syncContext);
      // 2 stubbed, 2 loaded.
      assert.equal(asyncContext.split('[LAZY-STUBBED]').length - 1, 2);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
