import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  detectMultiFileSmallFix,
  extractPathsFromDiscovery,
  hasFixIntent,
  listSequentialFixTargets,
  resolveFixScopeFromDiscovery,
} from './fixScopeResolver.js';

test('hasFixIntent recognizes daily repair tasks', () => {
  assert.equal(hasFixIntent('fix the failing parser test'), true);
  assert.equal(hasFixIntent('what is this repo about?'), false);
});

test('extractPathsFromDiscovery reads tool targets and observation headers', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-scope-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.js'), 'export const add = () => 0;\n', 'utf-8');

    const paths = extractPathsFromDiscovery({
      projectRoot: root,
      observations: '### read_file src/math.js\nexit_code: 0',
      toolCallLog: [
        {
          step: 1,
          tool: 'grep',
          target: 'src/math.js',
          exit_code: 0,
          stdout: 'match',
          stderr: '',
          verified: true,
        },
      ],
    });

    assert.deepEqual(paths, ['src/math.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detectMultiFileSmallFix resolves explicit multi-file scopes', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-scope-multi-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
      'utf-8',
    );
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
    writeFileSync(join(root, 'src', 'b.js'), 'export const b = 2;\n', 'utf-8');

    const scope = detectMultiFileSmallFix(
      'Only edit src/a.js and src/b.js. Run npm test before completing.',
      root,
    );
    assert.ok(scope);
    assert.equal(scope.mode, 'multi');
    if (scope.mode === 'multi') {
      assert.deepEqual(scope.targetFiles, ['src/a.js', 'src/b.js']);
      assert.equal(scope.verifierCommand, 'npm test');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detectMultiFileSmallFix resolves implicit paths and blocks broad refactors', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-scope-implicit-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
      'utf-8',
    );
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n', 'utf-8');
    writeFileSync(join(root, 'src', 'b.js'), 'export const b = 2;\n', 'utf-8');

    // Test implicit lookup
    const scope = detectMultiFileSmallFix(
      'Edit a.js and b.js. Run npm test before completing.',
      root,
    );
    assert.ok(scope);
    assert.equal(scope.mode, 'multi');
    if (scope.mode === 'multi') {
      assert.deepEqual(scope.targetFiles, ['src/a.js', 'src/b.js']);
      assert.equal(scope.verifierCommand, 'npm test');
    }

    // Test broad refactor block
    const broadScope = detectMultiFileSmallFix('refactor the codebase. Run npm test.', root);
    assert.equal(broadScope, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveFixScopeFromDiscovery infers a single source file with package test command', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-scope-infer-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
      'utf-8',
    );
    writeFileSync(join(root, 'src', 'math.js'), 'export const add = () => 0;\n', 'utf-8');

    const scope = resolveFixScopeFromDiscovery({
      task: 'fix the failing math test',
      projectRoot: root,
      observations: '### read_file src/math.js\nexit_code: 0',
      toolCallLog: [
        {
          step: 1,
          tool: 'file_read',
          target: 'src/math.js',
          exit_code: 0,
          stdout: 'export const add = () => 0;',
          stderr: '',
          verified: true,
        },
      ],
    });

    assert.ok(scope);
    assert.equal(scope.mode, 'single');
    if (scope.mode === 'single') {
      assert.equal(scope.targetFile, 'src/math.js');
      assert.equal(scope.verifierCommand, 'npm test');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSequentialFixTargets preserves dual and multi ordering', () => {
  assert.deepEqual(
    listSequentialFixTargets({
      mode: 'dual',
      sourceFile: 'src/a.js',
      testFile: 'src/a.test.js',
      verifierCommand: 'npm test',
      projectRoot: '/tmp',
    }),
    ['src/a.js', 'src/a.test.js'],
  );
  assert.deepEqual(
    listSequentialFixTargets({
      mode: 'multi',
      targetFiles: ['src/a.js', 'src/b.js', 'src/c.js'],
      verifierCommand: 'npm test',
      projectRoot: '/tmp',
    }),
    ['src/a.js', 'src/b.js', 'src/c.js'],
  );
});
