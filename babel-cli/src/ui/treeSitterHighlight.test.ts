/**
 * treeSitterHighlight.test.ts — tests for the optional tree-sitter backend.
 *
 * Pure functions (isTreeSitterAvailable, getTreeSitterLanguages) are tested
 * inline.  ANSI-producing paths use subprocess spawning with FORCE_COLOR=1
 * so that colour output is deterministic regardless of the test runner's TTY.
 *
 * All tests are designed to pass whether or not tree-sitter is installed —
 * the optional nature of the backend is itself part of the contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  isTreeSitterAvailable,
  getTreeSitterLanguages,
  highlightWithTreeSitter,
} from './treeSitterHighlight.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Pure-API tests (no subprocess needed — no ANSI output)
// ═══════════════════════════════════════════════════════════════════════════════

test('isTreeSitterAvailable returns a boolean', () => {
  const result = isTreeSitterAvailable();
  assert.equal(typeof result, 'boolean');
});

test('getTreeSitterLanguages returns an array', () => {
  const result = getTreeSitterLanguages();
  assert.ok(Array.isArray(result));
  // Every entry is a non-empty string
  for (const lang of result) {
    assert.equal(typeof lang, 'string');
    assert.ok(lang.length > 0);
  }
});

test('highlightWithTreeSitter returns string when tree-sitter available and language supported', () => {
  const available = isTreeSitterAvailable();
  if (!available) {
    // Graceful skip — tree-sitter not installed in this environment
    assert.ok(true, 'tree-sitter not available, skipping');
    return;
  }
  const langs = getTreeSitterLanguages();
  if (langs.length === 0) {
    // No grammars installed — null is the expected contract
    const result = highlightWithTreeSitter('const x = 1', 'typescript');
    assert.equal(result, null);
    return;
  }
  // At least one grammar is available — highlighting should produce ANSI
  const result = highlightWithTreeSitter('const x = 1', langs[0]!);
  assert.notEqual(result, null);
  assert.equal(typeof result, 'string');
  // Plain-text content must be preserved
  const plain = result!.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert.ok(plain.includes('const x = 1'));
});

test('highlightWithTreeSitter with unsupported language returns null', () => {
  const available = isTreeSitterAvailable();
  if (!available) {
    assert.ok(true, 'tree-sitter not available, skipping');
    return;
  }
  // "fortran" is not in our grammar list — must return null
  const result = highlightWithTreeSitter('program hello', 'fortran');
  assert.equal(result, null);
});

test('highlightWithTreeSitter with empty string returns unchanged', () => {
  const result = highlightWithTreeSitter('', 'typescript');
  // Should either return null (tree-sitter unavailable) or empty string
  if (result === null) return;
  assert.equal(result, '');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Subprocess: integration with highlight.ts highlightLine
// ═══════════════════════════════════════════════════════════════════════════════

const SUBPROCESS_CWD = process.cwd();

function subprocessEval(scriptBody: string): string {
  const script = [`import { highlightLine } from './src/ui/highlight.js';`, scriptBody].join('\n');

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: SUBPROCESS_CWD,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      NO_COLOR: '',
      PATH: process.env.PATH,
    },
    timeout: 15_000,
  });

  if (result.status !== 0) {
    throw new Error(
      `Subprocess exited with status ${result.status}\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`,
    );
  }

  return JSON.parse(result.stdout.trim());
}

function assertHasAnsi(output: string): void {
  assert.match(output, /\x1b\[/, 'Expected ANSI escape codes to be present');
}

function assertTextContent(output: string, text: string): void {
  const plain = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x1b\\/g, '');
  assert.ok(plain.includes(text), `Expected "${text}" in plain text "${plain}"`);
}

test('highlightLine with preferTreeSitter: true (default) still produces ANSI', () => {
  const out = subprocessEval(
    `console.log(JSON.stringify(highlightLine('const x = 1', 'ts', { preferTreeSitter: true })));`,
  );
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1');
});

test('highlightLine with preferTreeSitter: false falls back to regex', () => {
  const out = subprocessEval(
    `console.log(JSON.stringify(highlightLine('const x = 1', 'ts', { preferTreeSitter: false })));`,
  );
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1');
});

test('highlightLine without options defaults to tree-sitter first', () => {
  const out = subprocessEval(`console.log(JSON.stringify(highlightLine('const x = 1', 'ts')));`);
  assertHasAnsi(out);
  assertTextContent(out, 'const x = 1');
});

test('highlightLine with unsupported TS language falls back to regex', () => {
  // Tree-sitter may not have every grammar — the fallback must always work
  const out = subprocessEval(
    `console.log(JSON.stringify(highlightLine('def foo():', 'py', { preferTreeSitter: true })));`,
  );
  assertHasAnsi(out);
  assertTextContent(out, 'def foo():');
});
