import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listProjectTemplates, normalizeProjectTemplate, scaffoldProject } from './projectScaffold.js';

function makeTempParent(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-scaffold-test-'));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('template names normalize and list deterministically', () => {
  assert.deepEqual(listProjectTemplates(), ['node-cli', 'python-cli', 'vite-react']);
  assert.equal(normalizeProjectTemplate('node-cli'), 'node-cli');
  assert.equal(normalizeProjectTemplate('missing'), null);
});

test('node-cli scaffold writes runnable starter files', () => {
  const fixture = makeTempParent();
  try {
    const targetRoot = join(fixture.root, 'hello-cli');
    const result = scaffoldProject({ template: 'node-cli', targetRoot });

    assert.equal(result.template, 'node-cli');
    assert.ok(existsSync(join(targetRoot, 'package.json')));
    assert.ok(existsSync(join(targetRoot, 'src', 'index.js')));
    assert.match(readFileSync(join(targetRoot, 'test', 'smoke.test.js'), 'utf-8'), /greet returns/);
    assert.ok(result.next_commands.includes('npm test'));
  } finally {
    fixture.cleanup();
  }
});
test('scaffold refuses nonempty target unless force is set', () => {
  const fixture = makeTempParent();
  try {
    const targetRoot = join(fixture.root, 'existing');
    scaffoldProject({ template: 'node-cli', targetRoot });
    writeFileSync(join(targetRoot, 'custom.txt'), 'keep\n', 'utf-8');

    assert.throws(
      () => scaffoldProject({ template: 'python-cli', targetRoot }),
      /not empty/,
    );
    const forced = scaffoldProject({ template: 'python-cli', targetRoot, force: true });
    assert.equal(forced.template, 'python-cli');
    assert.ok(existsSync(join(targetRoot, 'pyproject.toml')));
  } finally {
    fixture.cleanup();
  }
});
