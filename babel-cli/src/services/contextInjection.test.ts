import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareContextInjection } from './contextInjection.js';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-context-injection-'));
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\nnode_modules/\n', 'utf8');
  writeFileSync(join(root, 'README.md'), 'hello context\n', 'utf8');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(root, 'src', 'ignored.txt'), 'not ignored by root pattern\n', 'utf8');
  writeFileSync(join(root, 'ignored.txt'), 'secret-ish scratch\n', 'utf8');
  return root;
}

test('injects @file context into the task and evidence payload', () => {
  const projectRoot = makeProject();
  const result = prepareContextInjection('Review @file README.md', { projectRoot });

  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.status, 'included');
  assert.equal(result.attachments[0]?.files[0]?.path, 'README.md');
  assert.match(result.task, /BABEL ATTACHED CONTEXT/);
  assert.match(result.task, /hello context/);
});

test('injects @directory context with git-aware filtering', () => {
  const projectRoot = makeProject();
  const result = prepareContextInjection('Review @directory .', {
    projectRoot,
    maxFilesPerDirectory: 10,
  });

  const includedPaths = result.attachments.flatMap((attachment) => attachment.files.map((file) => file.path));
  const skippedPaths = result.attachments.flatMap((attachment) => attachment.skipped.map((file) => `${file.path}:${file.reason}`));
  assert.ok(includedPaths.includes('README.md'));
  assert.ok(includedPaths.includes('src/a.ts'));
  assert.ok(skippedPaths.includes('ignored.txt:git_ignored'));
});

test('rejects context paths outside the project root', () => {
  const projectRoot = makeProject();
  assert.throws(
    () => prepareContextInjection('Review @file ../outside.txt', { projectRoot }),
    /escapes project root/,
  );
});
