import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  formatSemanticSearchHits,
  globPaths,
  globPatternToRegExp,
  grepContent,
  searchSymbols,
  handleWorkspaceSymbolSearch,
  handleGrepTool,
} from './repoSearch.js';
import { resetRipgrepDetection } from './ripgrep.js';

for (const fallback of [false, true]) {
  test(`grep file/directory scopes return exact matches${fallback ? ' without ripgrep' : ''}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-grep-scope-'));
    const priorPath = process.env['PATH'];
    try {
      mkdirSync(join(root, 'source/babel-cli/src/runners'), { recursive: true });
      mkdirSync(join(root, 'source/babel-cli/src/runners-other'), { recursive: true });
      const file = 'source/babel-cli/src/runners/deepInfraApi.ts';
      writeFileSync(join(root, file), 'export class DeepInfraApiRunner {}\n');
      writeFileSync(join(root, 'source/babel-cli/src/runners/with [brackets].ts'), 'export class OtherRunner {}\n');
      writeFileSync(join(root, 'source/babel-cli/src/runners-other/outside.ts'), 'export class UnrelatedRunner {}\n');
      if (fallback) { process.env['PATH'] = ''; resetRipgrepDetection(); }
      for (const scope of [file, file.replace(/\//g, '\\'), join(root, file)]) {
        const result = await grepContent(root, 'class', { path: scope });
        assert.equal(result.matches.length, 1);
        assert.equal(result.matches[0]?.path, file);
        assert.equal(result.matches[0]?.line, 1);
        assert.match(result.matches[0]?.text ?? '', /DeepInfraApiRunner/);
      }
      for (const scope of ['source/babel-cli/src/runners', 'source/babel-cli/src/runners/', 'source/babel-cli/src/runners/**']) {
        const result = await grepContent(root, 'class', { path: scope });
        assert.equal(result.matches.length, 2);
        assert.ok(result.matches.every(match => !match.path.includes('runners-other')));
      }
      assert.equal((await grepContent(root, 'class', { path: 'source/babel-cli/src/runners/with [brackets].ts' })).matches.length, 1);
      await assert.rejects(grepContent(root, 'class', { path: 'missing.ts' }), /ENOENT/);
    } finally {
      if (priorPath === undefined) delete process.env['PATH']; else process.env['PATH'] = priorPath;
      resetRipgrepDetection();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('grep tool reports missing scope as an error, not a successful empty search', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-grep-missing-'));
  const previousRoot = process.env['BABEL_PROJECT_ROOT'];
  try {
    process.env['BABEL_PROJECT_ROOT'] = root;
    const result = await handleGrepTool({ path: 'missing.ts', pattern: 'class' });
    assert.equal(result.exit_code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ENOENT/);
  } finally {
    if (previousRoot === undefined) delete process.env['BABEL_PROJECT_ROOT']; else process.env['BABEL_PROJECT_ROOT'] = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit grep scopes cannot escape approved roots through paths or links', async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-grep-boundary-'));
  try {
    mkdirSync(join(root, 'project'));
    writeFileSync(join(root, 'outside.ts'), 'export class Outside {}\n');
    await assert.rejects(grepContent(join(root, 'project'), 'class', { path: '../outside.ts' }), /outside approved/);
    assert.equal((await grepContent(join(root, 'project'), 'class', { path: '../outside.ts' }, [root])).matches.length, 1);
    try { symlinkSync(root, join(root, 'project/linked-root'), 'junction'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('Host lacks symlink permission; path boundary verified.'); return; }
      throw error;
    }
    await assert.rejects(grepContent(join(root, 'project'), 'class', { path: 'linked-root/outside.ts' }), /outside approved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('grepContent finds bounded matches under project root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-grep-tool-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n', 'utf-8');
    writeFileSync(join(root, 'src', 'beta.ts'), 'export const beta = 2;\n', 'utf-8');

    const result = await grepContent(root, 'export const', { maxMatches: 1 });
    assert.equal(result.matches.length, 1);
    assert.equal(result.truncated, true);
    assert.match(result.matches[0]?.path ?? '', /^src\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('globPaths returns bounded file paths for a glob pattern', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-glob-tool-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'one.ts'), 'export const one = 1;\n', 'utf-8');
    writeFileSync(join(root, 'src', 'two.md'), '# two\n', 'utf-8');

    const paths = await globPaths(root, 'src/*.ts', 10);
    assert.deepEqual(paths, ['src/one.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('globPatternToRegExp supports ** segments', () => {
  assert.equal(globPatternToRegExp('src/**/*.ts').test('src/agent/tool.ts'), true);
  assert.equal(globPatternToRegExp('src/**/*.ts').test('lib/tool.ts'), false);
});

test('formatSemanticSearchHits includes path snippets for synthesis', () => {
  const formatted = formatSemanticSearchHits([
    {
      id: 'src/parser.ts',
      name: 'parser.ts',
      score: 1.42,
      snippet: 'export function parseInput(value: string) {',
    },
  ]);
  assert.match(formatted, /src\/parser\.ts: export function parseInput/);
});

test('searchSymbols finds code symbols across multiple languages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-symbol-tool-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'code.ts'),
      'export class AlphaClass {}\nexport function alphaFunc() {}\n',
      'utf-8',
    );
    writeFileSync(join(root, 'src', 'script.py'), 'def beta_func():\n    pass\n', 'utf-8');
    writeFileSync(join(root, 'src', 'main.go'), 'package main\nfunc GammaStruct() {}\n', 'utf-8');

    // Search for alpha class
    const alphaRes = await searchSymbols(root, 'AlphaClass');
    assert.equal(alphaRes.matches.length, 1);
    assert.equal(alphaRes.matches[0]?.name, 'AlphaClass');
    assert.equal(alphaRes.matches[0]?.kind, 'class');
    assert.equal(alphaRes.matches[0]?.path, 'src/code.ts');

    // Case-insensitive check
    const lowerRes = await searchSymbols(root, 'alphafunc');
    assert.equal(lowerRes.matches.length, 1);
    assert.equal(lowerRes.matches[0]?.name, 'alphaFunc');
    assert.equal(lowerRes.matches[0]?.kind, 'function');

    // Search for Def/def across Python
    const pyRes = await searchSymbols(root, 'beta_func');
    assert.equal(pyRes.matches.length, 1);
    assert.equal(pyRes.matches[0]?.name, 'beta_func');
    assert.equal(pyRes.matches[0]?.kind, 'function');

    // Search for Go function
    const goRes = await searchSymbols(root, 'GammaStruct');
    assert.equal(goRes.matches.length, 1);
    assert.equal(goRes.matches[0]?.name, 'GammaStruct');
    assert.equal(goRes.matches[0]?.kind, 'function');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
