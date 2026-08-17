import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPatchRawTargets } from './patchTargets.js';
import { repoRelativeFromCwd } from './integrity.js';
import { join, resolve } from 'node:path';

test('extracts created, deleted, and a/b prefixes', () => {
  const patch = [
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
  ].join('\n');
  const targets = extractPatchRawTargets(patch);
  assert.ok(targets.includes('old.txt'));
  assert.ok(targets.includes('new.txt'));
  assert.ok(!targets.includes('/dev/null'));
});

test('extracts quoted paths with spaces', () => {
  const patch = [
    'diff --git "a/my file.txt" "b/my file.txt"',
    '--- "a/my file.txt"',
    '+++ "b/my file.txt"',
  ].join('\n');
  const targets = extractPatchRawTargets(patch);
  assert.deepEqual(targets, ['my file.txt']);
});

test('extracts rename and copy headers', () => {
  const patch = [
    'diff --git a/from.ts b/to.ts',
    'rename from from.ts',
    'rename to to.ts',
    'diff --git a/src.ts b/copy.ts',
    'copy from src.ts',
    'copy to copy.ts',
  ].join('\n');
  const targets = extractPatchRawTargets(patch);
  assert.ok(targets.includes('from.ts'));
  assert.ok(targets.includes('to.ts'));
  assert.ok(targets.includes('src.ts'));
  assert.ok(targets.includes('copy.ts'));
});

test('repoRelativeFromCwd uses cwd, not process.cwd()', () => {
  const root = resolve('/tmp/repo-root');
  const cwd = join(root, 'babel-cli');
  assert.equal(repoRelativeFromCwd(cwd, root, 'src/authority/pdp.ts'), 'babel-cli/src/authority/pdp.ts');
  assert.equal(repoRelativeFromCwd(cwd, root, '../AGENTS.md'), 'AGENTS.md');
});
