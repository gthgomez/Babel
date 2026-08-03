import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  createVerifierOverlay,
  getHeadCommitChangedPaths,
  removeVerifierOverlay,
} from './verifierOverlay.js';

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

test('verifier overlay applies production diff but excludes protected test changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-overlay-'));
  const tests = join(root, 'tests');
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(root, 'app.py'), 'return 1\n', 'utf8');
  writeFileSync(join(tests, 'test_app.py'), 'assert True\n', 'utf8');
  assert.equal(git(root, ['init']).status, 0);
  assert.equal(git(root, ['config', 'user.email', 'babel-test@example.com']).status, 0);
  assert.equal(git(root, ['config', 'user.name', 'Babel Test']).status, 0);
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['commit', '-m', 'base']).status, 0);

  writeFileSync(join(root, 'tests', 'test_app.py'), 'assert False\n', 'utf8');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['commit', '-m', 'test patch baseline']).status, 0);
  writeFileSync(join(root, 'app.py'), 'return 2\n', 'utf8');
  writeFileSync(join(root, 'tests', 'test_app.py'), 'assert False\n# agent edit\n', 'utf8');

  const overlay = join(root, '..', `${root.split(/[\\/]/).pop()}-overlay`);
  const result = createVerifierOverlay({
    agentRoot: root,
    overlayRoot: overlay,
    protectedPaths: getHeadCommitChangedPaths(root),
  });
  assert.equal(result.ok, true, result.reason ?? 'overlay should be created');
  assert.ok(result.root);
  assert.equal(readFileSync(join(result.root!, 'app.py'), 'utf8'), 'return 2\n');
  assert.equal(readFileSync(join(result.root!, 'tests', 'test_app.py'), 'utf8'), 'assert False\n');
  assert.equal(readFileSync(join(root, 'tests', 'test_app.py'), 'utf8'), 'assert False\n# agent edit\n');

  removeVerifierOverlay(root, result.root);
  assert.equal(existsSync(overlay), false);
});

