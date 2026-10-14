import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { createWorktreeSafetyController } from './worktreeSafety.js';

test('shared-parent rollback refuses restoration after the comparison race and preserves external bytes', () => {
  const root = tempRoot();
  try {
    const target = join(root, 'target.txt');
    writeFileSync(target, 'original');
    const safety = createWorktreeSafetyController({ projectRoot: root, runDir: join(root, '.run') });
    assert.equal(safety.snapshotBeforeWrite('target.txt').ok, true);
    writeFileSync(target, 'child');
    assert.equal(safety.recordConfirmedPostimage('target.txt', createHash('sha256').update('child').digest('hex')), true);
    const internal = safety as any;
    const check = internal.matchesConfirmedPostimage.bind(safety);
    internal.matchesConfirmedPostimage = (path: string) => {
      const matches = check(path);
      if (matches) writeFileSync(target, 'external');
      return matches;
    };
    const rollback = safety.rollbackTouchedFiles('race fixture');
    assert.equal(readFileSync(target, 'utf8'), 'external');
    assert.equal(rollback.status, 'rollback_failed');
    assert.deepEqual(rollback.restored_files, []);
  } finally { cleanup(root); }
});

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-worktree-safety-'));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function gitAvailable(): boolean {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
}

test('snapshot creation retains backup while unowned restoration is refused', () => {
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
    assert.equal(rollback.status, 'rollback_failed');
    assert.deepEqual(rollback.restored_files, []);
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'after\n');

    const summary = safety.buildSummary();
    assert.equal(summary.snapshot_count, 1);
    assert.ok(summary.snapshots[0]?.backup_path);
    assert.equal(readFileSync(summary.snapshots[0]!.backup_path!, 'utf8'), 'before\n');
  } finally {
    cleanup(root);
  }
});

test('unowned rollback preserves created files', () => {
  const root = tempRoot();
  try {
    const runDir = join(root, '.run');
    const safety = createWorktreeSafetyController({ projectRoot: root, runDir });

    assert.equal(safety.snapshotBeforeWrite('created.txt', 1).ok, true);
    writeFileSync(join(root, 'created.txt'), 'new\n', 'utf8');

    const rollback = safety.rollbackTouchedFiles('unit test remove created file');
    assert.equal(rollback.status, 'rollback_failed');
    assert.deepEqual(rollback.removed_files, []);
    assert.equal(existsSync(join(root, 'created.txt')), true);
  } finally {
    cleanup(root);
  }
});

test('nested targets retain current bytes when rollback lacks writer ownership', () => {
  const root = tempRoot();
  try {
    const runDir = join(root, '.run');
    mkdirSync(join(root, 'src', 'generated'), { recursive: true });
    writeFileSync(join(root, 'src', 'generated', 'bundle.js'), 'before\n', 'utf8');

    const safety = createWorktreeSafetyController({ projectRoot: root, runDir });

    assert.equal(safety.snapshotBeforeWrite('src/generated/bundle.js', 1).ok, true);
    writeFileSync(join(root, 'src', 'generated', 'bundle.js'), 'after\n', 'utf8');

    const rollback = safety.rollbackTouchedFiles('unit test nested directory restore');
    assert.equal(rollback.status, 'rollback_failed');
    assert.deepEqual(rollback.restored_files, []);
    assert.equal(readFileSync(join(root, 'src', 'generated', 'bundle.js'), 'utf8'), 'after\n');
  } finally {
    cleanup(root);
  }
});

test('dirty target detection refuses tracked user changes', { skip: !gitAvailable() ? 'Git unavailable on this local host' : false }, () => {
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

    const safety = createWorktreeSafetyController({
      projectRoot: root,
      runDir: join(root, '.run'),
    });
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
    const safety = createWorktreeSafetyController({
      projectRoot: root,
      runDir: join(root, '.run'),
    });

    assert.equal(safety.snapshotBeforeWrite('src/math.js', 1).ok, true);
    writeFileSync(join(root, 'src', 'math.js'), 'bad patch\n', 'utf8');
    const untrackedPath = join(root, 'src', 'untracked.txt');
    writeFileSync(untrackedPath, 'fresh\n', 'utf8');
    writeFileSync(join(root, 'src', 'unrelated.tmp'), 'untouched\n', 'utf8');

    const rollback = safety.rollbackTouchedFiles('unit test dirty preservation');
    assert.equal(rollback.status, 'rollback_failed');
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'bad patch\n');
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
    const safety = createWorktreeSafetyController({
      projectRoot: root,
      runDir: join(root, '.run'),
    });
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
    const safety = createWorktreeSafetyController({
      projectRoot: root,
      runDir: join(root, '.run'),
    });
    const result = safety.snapshotBeforeWrite('.git/config', 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'WORKTREE_DIRTY_UNSAFE');
    assert.match(result.reason ?? '', /protected path/);
    assert.deepEqual(safety.buildSummary().protected_path_conflicts, ['.git/config']);
  } finally {
    cleanup(root);
  }
});
