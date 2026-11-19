/** RT-09 — workspace change snapshots must not advertise changes with no diff. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectWorkspaceChanges } from './workspaceChanges.js';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
}

test('RT-09: staged and untracked changes are present in the returned diff', { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-changes-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'tracked.txt'), 'tracked v1\n');
    writeFileSync(join(root, 'staged.txt'), 'staged v1\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'initial']);

    writeFileSync(join(root, 'tracked.txt'), 'tracked v2 unstaged\n');
    writeFileSync(join(root, 'staged.txt'), 'staged v2 staged\n');
    git(root, ['add', 'staged.txt']);
    writeFileSync(join(root, 'untracked.txt'), 'new untracked file\n');

    const snapshot = collectWorkspaceChanges(root);
    assert.equal(snapshot.available, true);
    assert.deepEqual(
      snapshot.files.map((file) => file.path).sort(),
      ['staged.txt', 'tracked.txt', 'untracked.txt'],
    );
    assert.match(snapshot.diff, /staged v2 staged/);
    assert.match(snapshot.diff, /tracked v2 unstaged/);
    assert.match(snapshot.diff, /# Untracked file: "untracked\.txt"/);
    assert.match(snapshot.diff, /new untracked file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RT-09 positive control: a clean workspace reports no files and no diff', { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-clean-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'tracked.txt'), 'tracked\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'initial']);

    const snapshot = collectWorkspaceChanges(root);
    assert.equal(snapshot.available, true);
    assert.deepEqual(snapshot.files, []);
    assert.equal(snapshot.diff, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RT-09: a non-repository path is explicitly unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-norepo-'));
  try {
    const snapshot = collectWorkspaceChanges(root);
    assert.equal(snapshot.available, false);
    assert.ok(snapshot.reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
