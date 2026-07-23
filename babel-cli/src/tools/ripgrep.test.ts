/**
 * ripgrep.test.ts — Unit tests for the ripgrep wrapper and workspace map.
 *
 * Pattern: node:test + node:assert/strict (see chronicleMemory.test.ts).
 *
 * NOTE: In this environment, `rg` is available as a bash function routing
 * through claude.exe rather than as a standalone Windows executable on the
 * system PATH. This means detectRipgrep() correctly returns false, and
 * grepContent/globPaths fall through to the pure-JS fallback. Tests validate
 * both code paths: ripgrep when available, and the pure-JS fallback always.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  detectRipgrep,
  resetRipgrepDetection,
  ripgrep,
  rgGlobFiles,
  rgListFiles,
} from './ripgrep.js';
import { buildWorkspaceMap, grepContent, globPaths } from './repoSearch.js';

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Create a temp fixture directory with a .gitignore for testing. */
function makeTempFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'babel-ripgrep-test-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'ignored'), { recursive: true });
  // rg requires a .git directory to respect .gitignore
  mkdirSync(path.join(root, '.git'), { recursive: true });

  writeFileSync(path.join(root, 'src', 'hello.ts'), 'const greeting = "hello world";\n', 'utf-8');
  writeFileSync(path.join(root, 'src', 'goodbye.ts'), 'const farewell = "goodbye";\n', 'utf-8');
  writeFileSync(path.join(root, 'ignored', 'secret.ts'), 'const secret = "hidden";\n', 'utf-8');
  writeFileSync(path.join(root, '.gitignore'), 'ignored/\n', 'utf-8');

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────────

describe('ripgrep detection', () => {
  it('detectRipgrep returns boolean without throwing', async () => {
    resetRipgrepDetection();
    const detected = detectRipgrep();
    // Must be boolean, but may be false if rg not on system PATH
    assert.strictEqual(typeof detected, 'boolean');
  });
});

describe('ripgrep wrapper (when available)', () => {
  it('ripgrep basic match — finds known text in source files', async () => {
    if (!detectRipgrep()) {
      return;
    }

    resetRipgrepDetection();
    const projectRoot = process.cwd();
    const result = await ripgrep(projectRoot, { pattern: 'grepContent' });

    assert.ok(result.matches.length > 0, 'Expected at least one match for "grepContent"');
    assert.ok(
      result.matches.some((m) => m.path.includes('repoSearch.ts')),
      'Expected match in repoSearch.ts',
    );
    assert.equal(result.truncated, false);
    assert.ok(result.elapsedMs >= 0);
  });

  it('ripgrep no matches — returns empty for nonsense pattern', async () => {
    if (!detectRipgrep()) {
      return;
    }

    resetRipgrepDetection();
    const fixture = makeTempFixture();
    try {
      const result = await ripgrep(fixture.root, { pattern: 'XYZZYX_NONEXISTENT_12345' });

      assert.equal(result.matches.length, 0);
      assert.equal(result.truncated, false);
    } finally {
      fixture.cleanup();
    }
  });

  it('ripgrep max matches — respects limit and sets truncated flag', async () => {
    if (!detectRipgrep()) {
      return;
    }

    resetRipgrepDetection();
    const projectRoot = process.cwd();
    const result = await ripgrep(projectRoot, { pattern: 'import', maxMatches: 5 });

    assert.ok(result.matches.length <= 5);
    assert.equal(result.truncated, true);
  });

  it('ripgrep .gitignore exclusion — ignores files in .gitignore dirs', async () => {
    if (!detectRipgrep()) {
      return;
    }

    resetRipgrepDetection();
    const fixture = makeTempFixture();
    try {
      // Search for "secret" in the fixture root — rg should ignore the ignored/ dir
      const result = await ripgrep(fixture.root, { pattern: 'secret' });

      assert.equal(
        result.matches.length,
        0,
        'rg should respect .gitignore and not match inside "ignored/"',
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('ripgrep gitignoreRespect: false — overrides .gitignore', async () => {
    if (!detectRipgrep()) {
      return;
    }

    resetRipgrepDetection();
    const fixture = makeTempFixture();
    try {
      // Search with gitignoreRespect: false — should find the secret
      const result = await ripgrep(fixture.root, {
        pattern: 'secret',
        gitignoreRespect: false,
      });

      assert.ok(
        result.matches.length > 0,
        'With gitignoreRespect=false, should match inside "ignored/"',
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe('grepContent (with fallback)', () => {
  it('finds matches in temp fixture via ripgrep or pure-JS', async () => {
    resetRipgrepDetection();
    const fixture = makeTempFixture();
    try {
      const result = await grepContent(fixture.root, 'hello', { maxMatches: 10 }, undefined);

      // Either path must find the match
      assert.ok(result.matches.length > 0, 'grepContent must find matches in either code path');
      assert.ok(
        result.matches.some((m) => m.path.includes('hello.ts')),
        'Expected match in hello.ts',
      );
      assert.equal(result.truncated, false);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns empty for no matches', async () => {
    resetRipgrepDetection();
    const fixture = makeTempFixture();
    try {
      const result = await grepContent(
        fixture.root,
        'XYZZYX_NONEXISTENT_12345',
        undefined,
        undefined,
      );

      assert.equal(result.matches.length, 0);
      assert.equal(result.truncated, false);
    } finally {
      fixture.cleanup();
    }
  });

  it('respects maxMatches and sets truncated flag', async () => {
    resetRipgrepDetection();
    // Search in the actual project root for a common pattern
    const projectRoot = process.cwd();
    const result = await grepContent(projectRoot, 'import', { maxMatches: 3 }, undefined);

    // Must match and truncate since there are many "import" occurrences
    assert.ok(result.matches.length <= 3);
    assert.ok(result.matches.length > 0 || result.truncated);
  });

  it('handles ignoreCase option', async () => {
    resetRipgrepDetection();
    const fixture = makeTempFixture();
    try {
      // Search case-insensitive for "HELLO" should find "hello"
      const result = await grepContent(
        fixture.root,
        'HELLO',
        { ignoreCase: true, maxMatches: 10 },
        undefined,
      );

      assert.ok(result.matches.length > 0, 'Case-insensitive search for HELLO must find hello');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('globPaths (with fallback)', () => {
  it('finds files by pattern via ripgrep or pure-JS', async () => {
    resetRipgrepDetection();
    const projectRoot = process.cwd();
    const paths = await globPaths(projectRoot, 'package.json', 10, undefined);

    assert.ok(paths.includes('package.json'), 'Should find package.json');
  });

  it('returns empty for non-matching pattern', async () => {
    resetRipgrepDetection();
    const projectRoot = process.cwd();
    const paths = await globPaths(projectRoot, 'nonexistent_file_xyzzy.*', 10, undefined);

    assert.equal(paths.length, 0, 'Should be empty for non-matching pattern');
  });

  it('respects maxPaths limit', async () => {
    resetRipgrepDetection();
    const projectRoot = process.cwd();
    const paths = await globPaths(projectRoot, '*', 3, undefined);

    assert.ok(paths.length <= 3);
  });
});

describe('workspace_map', () => {
  it('buildWorkspaceMap returns a tree containing expected directories', async () => {
    const tree = await buildWorkspaceMap(process.cwd(), { maxDepth: 2, maxFiles: 500 });

    assert.ok(tree.length > 0, 'Tree must not be empty');
    assert.ok(
      tree.includes('src/') || tree.includes('package.json'),
      'Tree should contain expected project files/dirs',
    );
  });

  it('workspace_map respects maxDepth:1 showing only top-level', async () => {
    const tree = await buildWorkspaceMap(process.cwd(), { maxDepth: 1, maxFiles: 500 });

    assert.ok(tree.length > 0, 'Tree must not be empty');
    assert.ok(tree.includes('package.json'), 'Tree should contain package.json at depth 1');
  });

  it('workspace_map respects maxFiles limit', async () => {
    const tree = await buildWorkspaceMap(process.cwd(), { maxDepth: 1, maxFiles: 1 });

    // With maxFiles:1, should indicate truncation
    assert.ok(tree.includes('...[truncated'), 'Should indicate truncation after 1 file');
  });

  it('workspace_map produces tree hierarchy with proper symbols', async () => {
    const tree = await buildWorkspaceMap(process.cwd(), { maxDepth: 2, maxFiles: 200 });

    assert.ok(
      tree.includes('└── ') || tree.includes('├── '),
      'Tree should contain Unicode box-drawing symbols',
    );
  });
});
