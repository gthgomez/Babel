import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  handleGetCodeOutline,
  handleFindCodeDefinition,
  handleFindCodeReferences,
  handleLoadSkillManifest,
} from './astTools.js';

test('handleGetCodeOutline outputs symbols and line numbers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ast-outline-'));
  const filePath = join(root, 'code.ts');
  writeFileSync(
    filePath,
    'export class AlphaClass {\n  constructor() {}\n}\nexport function alphaFunc() {}\n',
    'utf-8',
  );

  const res = await handleGetCodeOutline(filePath, [root]);
  assert.equal(res.exit_code, 0);
  assert.match(res.stdout, /Line 1: \[class\] AlphaClass/);
  assert.match(res.stdout, /Line 4: \[function\] alphaFunc/);
});

test('handleGetCodeOutline sandboxing blocks out-of-bounds files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ast-sandbox-'));
  const filePath = join(root, 'code.ts');
  writeFileSync(filePath, 'class Test {}', 'utf-8');

  // Request outline with approvedReadRoots set to a different root
  const res = await handleGetCodeOutline(filePath, [join(tmpdir(), 'other-dir')]);
  assert.equal(res.exit_code, 1);
  assert.match(res.stderr, /Access Denied/);
});

test('handleGetCodeOutline rejects unsupported file extensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ast-ext-'));
  const filePath = join(root, 'readme.md');
  writeFileSync(filePath, '# Readme', 'utf-8');

  const res = await handleGetCodeOutline(filePath, [root]);
  assert.equal(res.exit_code, 1);
  assert.match(res.stderr, /Unsupported file type/);
});

test('handleFindCodeDefinition extracts TS brace-balanced functions skipping template braces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ast-def-ts-'));
  const oldBabelProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = root;

  try {
    const filePath = join(root, 'code.ts');
    writeFileSync(
      filePath,
      'export function alphaFunc() {\n' +
      '  const val = `hello {\n' +
      '    not a real brace\n' +
      '  }`;\n' +
      '  if (true) {\n' +
      '    console.log("test");\n' +
      '  }\n' +
      '}\n' +
      'export class BetaClass {}\n',
      'utf-8',
    );

    const res = await handleFindCodeDefinition('alphaFunc', [root]);
    assert.equal(res.exit_code, 0);
    assert.match(res.stdout, /export function alphaFunc\(\)/);
    assert.match(res.stdout, /console\.log\("test"\)/);
    // Should end at the closing brace of function (Line 8)
    assert.doesNotMatch(res.stdout, /BetaClass/);
  } finally {
    process.env['BABEL_PROJECT_ROOT'] = oldBabelProjectRoot;
  }
});

test('handleFindCodeDefinition extracts Python indentation-balanced functions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ast-def-py-'));
  const oldBabelProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = root;

  try {
    const filePath = join(root, 'script.py');
    writeFileSync(
      filePath,
      'def alpha_func():\n' +
      '    # comment\n' +
      '    print("hello")\n' +
      '\n' +
      'def beta_func():\n' +
      '    pass\n',
      'utf-8',
    );

    const res = await handleFindCodeDefinition('alpha_func', [root]);
    assert.equal(res.exit_code, 0);
    assert.match(res.stdout, /def alpha_func\(\)/);
    assert.match(res.stdout, /print\("hello"\)/);
    assert.doesNotMatch(res.stdout, /beta_func/);
  } finally {
    process.env['BABEL_PROJECT_ROOT'] = oldBabelProjectRoot;
  }
});

test('handleFindCodeReferences locates occurrences while ignoring definition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ast-ref-'));
  const oldBabelProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = root;

  try {
    const file1 = join(root, 'code.ts');
    writeFileSync(
      file1,
      'export function alphaFunc() {}\n' +
      'const a = alphaFunc();\n',
      'utf-8',
    );
    const file2 = join(root, 'other.ts');
    writeFileSync(
      file2,
      'alphaFunc();\n',
      'utf-8',
    );

    const res = await handleFindCodeReferences('alphaFunc', [root]);
    assert.equal(res.exit_code, 0);
    // Should match references in code.ts:2 and other.ts:1
    assert.match(res.stdout, /code\.ts:2: const a = alphaFunc\(\);/);
    assert.match(res.stdout, /other\.ts:1: alphaFunc\(\);/);
    // Should NOT match definition in code.ts:1
    assert.doesNotMatch(res.stdout, /code\.ts:1: export function alphaFunc/);
  } finally {
    process.env['BABEL_PROJECT_ROOT'] = oldBabelProjectRoot;
  }
});

test('handleLoadSkillManifest loads a skill from catalog', async () => {
  const babelRoot = resolve(process.cwd(), '..');
  const res = await handleLoadSkillManifest('skill_ts_zod', babelRoot);
  assert.equal(res.exit_code, 0);
  assert.match(res.stdout, /TypeScript & Zod/);
});
