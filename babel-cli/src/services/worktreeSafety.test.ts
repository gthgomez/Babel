import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createWorktreeSafetyController } from './worktreeSafety.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-worktree-safety-'));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

test('snapshot creation records backup and restores touched file', () => {
  const root = tempRoot();
  try {
    const runDir = join(root, '.run');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.js'), 'before\n', 'utf8');
    const safety = createWorktreeSafetyController({ projectRoot: root, runDir });

    const snapshot = safety.snapshotBeforeWrite('src/math.js', 1);
    assert.equal(snapshot.ok, true);
    writeFileSync(join(root, 'src', 'math.js'), 'after\n', 'utf8');

    const rollback = safety.rollbackTouchedFiles('unit test rollback');
    assert.equal(rollback.status, 'rollback_applied');
    assert.deepEqual(rollback.restored_files, ['src/math.js']);
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'before\n');

    const summary = safety.buildSummary();
    assert.equal(summary.snapshot_count, 1);
    assert.ok(summary.snapshots[0]?.backup_path);
  } finally {
    cleanup(root);
  }
});

test('rollback removes files created by Babel', () => {
  const root = tempRoot();
  try {
    const runDir = join(root, '.run');
    const safety = createWorktreeSafetyController({ projectRoot: root, runDir });

    assert.equal(safety.snapshotBeforeWrite('created.txt', 1).ok, true);
    writeFileSync(join(root, 'created.txt'), 'new\n', 'utf8');

    const rollback = safety.rollbackTouchedFiles('unit test remove created file');
    assert.equal(rollback.status, 'rollback_applied');
    assert.deepEqual(rollback.removed_files, ['created.txt']);
    assert.equal(existsSync(join(root, 'created.txt')), false);
  } finally {
    cleanup(root);
  }
});

test('nested directory restore restores tracked file changes', () => {
  const root = tempRoot();
  try {
    const runDir = join(root, '.run');
    mkdirSync(join(root, 'src', 'generated'), { recursive: true });
    writeFileSync(join(root, 'src', 'generated', 'bundle.js'), 'before\n', 'utf8');

    const safety = createWorktreeSafetyController({ projectRoot: root, runDir });

    assert.equal(safety.snapshotBeforeWrite('src/generated/bundle.js', 1).ok, true);
    writeFileSync(join(root, 'src', 'generated', 'bundle.js'), 'after\n', 'utf8');

    const rollback = safety.rollbackTouchedFiles('unit test nested directory restore');
    assert.equal(rollback.status, 'rollback_applied');
    assert.deepEqual(rollback.restored_files, ['src/generated/bundle.js']);
    assert.equal(readFileSync(join(root, 'src', 'generated', 'bundle.js'), 'utf8'), 'before\n');
  } finally {
    cleanup(root);
  }
});

test('dirty target detection refuses tracked user changes', { skip: !gitAvailable() }, () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.js'), 'committed\n', 'utf8');
    spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'baseline'], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, 'src', 'math.js'), 'user dirty\n', 'utf8');

    const safety = createWorktreeSafetyController({ projectRoot: root, runDir: join(root, '.run') });
    const result = safety.snapshotBeforeWrite('src/math.js', 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'WORKTREE_DIRTY_UNSAFE');
    assert.deepEqual(safety.buildSummary().git.dirty_files_before_run, ['src/math.js']);
    assert.deepEqual(safety.buildSummary().target_dirty_conflicts, ['src/math.js']);
  } finally {
    cleanup(root);
  }
});

test('rollback preserves unrelated tracked and untracked files', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.js'), 'before\n', 'utf8');
    writeFileSync(join(root, 'src', 'dirty.txt'), 'do not touch\n', 'utf8');
    const safety = createWorktreeSafetyController({ projectRoot: root, runDir: join(root, '.run') });

    assert.equal(safety.snapshotBeforeWrite('src/math.js', 1).ok, true);
    writeFileSync(join(root, 'src', 'math.js'), 'bad patch\n', 'utf8');
    const untrackedPath = join(root, 'src', 'untracked.txt');
    writeFileSync(untrackedPath, 'fresh\n', 'utf8');
    writeFileSync(join(root, 'src', 'unrelated.tmp'), 'untouched\n', 'utf8');

    const rollback = safety.rollbackTouchedFiles('unit test dirty preservation');
    assert.equal(rollback.status, 'rollback_applied');
    assert.equal(readFileSync(join(root, 'src', 'dirty.txt'), 'utf8'), 'do not touch\n');
    assert.equal(readFileSync(untrackedPath, 'utf8'), 'fresh\n');
    assert.equal(readFileSync(join(root, 'src', 'unrelated.tmp'), 'utf8'), 'untouched\n');
  } finally {
    cleanup(root);
  }
});

test('rollback failure status is specific and leaves evidence', () => {
  const root = tempRoot();
  const previous = process.env['BABEL_SIMULATE_ROLLBACK_FAILURE_FOR'];
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'math.js'), 'before\n', 'utf8');
    const safety = createWorktreeSafetyController({ projectRoot: root, runDir: join(root, '.run') });
    assert.equal(safety.snapshotBeforeWrite('src/math.js', 1).ok, true);
    writeFileSync(join(root, 'src', 'math.js'), 'bad patch\n', 'utf8');

    process.env['BABEL_SIMULATE_ROLLBACK_FAILURE_FOR'] = 'src/math.js';
    const rollback = safety.rollbackTouchedFiles('unit test simulated failure');
    assert.equal(rollback.status, 'rollback_failed');
    assert.equal(rollback.failed_files[0]?.path, 'src/math.js');
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'bad patch\n');
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_SIMULATE_ROLLBACK_FAILURE_FOR'];
    } else {
      process.env['BABEL_SIMULATE_ROLLBACK_FAILURE_FOR'] = previous;
    }
    cleanup(root);
  }
});

test('protected paths are refused before snapshot', () => {
  const root = tempRoot();
  try {
    const safety = createWorktreeSafetyController({ projectRoot: root, runDir: join(root, '.run') });
    const result = safety.snapshotBeforeWrite('.git/config', 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'WORKTREE_DIRTY_UNSAFE');
    assert.match(result.reason ?? '', /protected path/);
    assert.deepEqual(safety.buildSummary().protected_path_conflicts, ['.git/config']);
  } finally {
    cleanup(root);
  }
});
