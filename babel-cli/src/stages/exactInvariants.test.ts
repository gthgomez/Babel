import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractExactInvariants,
  resolveFileLiteralBinding,
  summarizeExactInvariantFailure,
  verifyExactInvariants,
} from './exactInvariants.js';

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test('exact invariant extraction preserves exact strings', () => {
  const registry = extractExactInvariants(
    'Create src/verifiedMode.js exporting getStatus() that returns the exact string verified live ok.',
  );

  assert.equal(
    registry.invariants.some(invariant =>
      invariant.kind === 'literal_string' && invariant.value === 'verified live ok',
    ),
    true,
  );
});

test('exact invariant verification accepts preserved exact string in requested file', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-exact-invariant-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'verifiedMode.js'),
      'export function getStatus() { return "verified live ok"; }\n',
      'utf-8',
    );
    const registry = extractExactInvariants(
      'Create src/verifiedMode.js exporting getStatus() that returns the exact string verified live ok.',
    );

    const result = verifyExactInvariants({ registry, projectRoot: root });

    assert.equal(result.passed, true);
    assert.equal(summarizeExactInvariantFailure(result), null);
  } finally {
    cleanup(root);
  }
});

test('exact invariant verification accepts exact filename creation', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-exact-filename-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'verifiedMode.js'), 'export const ok = true;\n', 'utf-8');
    const registry = extractExactInvariants('Create a new file named src/verifiedMode.js.');

    const result = verifyExactInvariants({ registry, projectRoot: root });

    assert.equal(result.passed, true);
  } finally {
    cleanup(root);
  }
});

test('exact invariant verification rejects semantic paraphrase when exact text was requested', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-exact-paraphrase-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'verifiedMode.js'),
      'export function getStatus() { return "System operating in verified mode"; }\n',
      'utf-8',
    );
    const registry = extractExactInvariants(
      'Create src/verifiedMode.js exporting getStatus() that returns the exact string verified live ok.',
    );

    const result = verifyExactInvariants({ registry, projectRoot: root });

    assert.equal(result.passed, false);
    assert.match(summarizeExactInvariantFailure(result) ?? '', /EXACT_INSTRUCTION_DRIFT/);
    assert.match(summarizeExactInvariantFailure(result) ?? '', /verified live ok/);
  } finally {
    cleanup(root);
  }
});

test('extracts contains file-literal constraints', () => {
  const registry = extractExactInvariants(
    'Create exact-status.txt containing the exact string "autonomous exact ok".',
  );

  assert.deepEqual(registry.file_literal_constraints, [
    {
      kind: 'file_literal_constraint',
      path: 'exact-status.txt',
      literal: 'autonomous exact ok',
      relation: 'contains',
      source: 'bound_phrase',
      required: true,
      case_sensitive: true,
      reason: 'file path bound to contained exact literal',
    },
  ]);
});

test('extracts entire-file file-literal constraints', () => {
  const registry = extractExactInvariants(
    'Update exact-status.txt so its entire contents are the exact string autonomous exact ok.',
  );

  assert.deepEqual(registry.file_literal_constraints, [
    {
      kind: 'file_literal_constraint',
      path: 'exact-status.txt',
      literal: 'autonomous exact ok',
      relation: 'entire_file_equals',
      source: 'bound_phrase',
      required: true,
      case_sensitive: true,
      reason: 'file path bound to exact entire-file content literal',
    },
  ]);
});

test('file-literal constraints reject paraphrase and pass exact entire-file content', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-exact-file-literal-'));
  try {
    writeFileSync(join(root, 'exact-status.txt'), 'System operating autonomously.\n', 'utf-8');
    const registry = extractExactInvariants(
      'Update exact-status.txt so its entire contents are the exact string autonomous exact ok.',
    );

    const failed = verifyExactInvariants({ registry, projectRoot: root });
    assert.equal(failed.passed, false);
    assert.match(summarizeExactInvariantFailure(failed) ?? '', /entire content does not exactly equal/);

    writeFileSync(join(root, 'exact-status.txt'), 'autonomous exact ok', 'utf-8');
    const passed = verifyExactInvariants({ registry, projectRoot: root });
    assert.equal(passed.passed, true);
  } finally {
    cleanup(root);
  }
});

test('ambiguous file/literal binding is not guessed', () => {
  const registry = extractExactInvariants(
    'Create a.txt and b.txt containing the exact strings alpha and beta.',
  );

  assert.equal(resolveFileLiteralBinding(registry, 'a.txt').status, 'ambiguous');
  assert.equal(resolveFileLiteralBinding(registry, 'b.txt').status, 'ambiguous');
  const root = mkdtempSync(join(tmpdir(), 'babel-exact-ambiguous-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'alpha', 'utf-8');
    writeFileSync(join(root, 'b.txt'), 'beta', 'utf-8');
    const result = verifyExactInvariants({ registry, projectRoot: root });

    assert.equal(result.passed, false);
    assert.match(summarizeExactInvariantFailure(result) ?? '', /AMBIGUOUS_LITERAL_BINDING/);
  } finally {
    cleanup(root);
  }
});
