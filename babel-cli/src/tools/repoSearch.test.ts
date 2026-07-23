import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
} from './repoSearch.js';

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
