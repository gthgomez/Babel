import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { resolveProjectRoot } from './helpers.js';

test('project IDs use the current project instead of assuming a sibling workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-current-project-'));
  const previous = process.cwd();
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"current-project"}');
    process.chdir(root);
    assert.equal(resolveProjectRoot(basename(root)), root);
    assert.equal(resolveProjectRoot('unrelated-semantic-project'), null);
    assert.equal(resolveProjectRoot(root), root);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
