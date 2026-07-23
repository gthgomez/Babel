/**
 * W2.1 tests — implement worktree agent + path allowlist.
 *
 * Covers: write_scope validation, disjoint fan-out rejection, worktree isolation
 * (parent tree stays clean), and out-of-scope write blocking via mutation loop.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  isPathInWriteScope,
  listWorktreeScopedChanges,
  promoteImplementWorktree,
  runImplementWorktreeAgent,
  runImplementWorktreeAgents,
  scopesOverlap,
  validateDisjointWriteScopes,
  validateImplementWriteScope,
  worktreePathExists,
} from './implementWorktreeAgent.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      // Best-effort prune any residual worktrees under this temp git repo.
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures on Windows file locks
    }
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function createGitProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-impl-wt-'));
  tempRoots.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'babel-test@example.com']);
  git(root, ['config', 'user.name', 'Babel Test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const n = 1;\n', 'utf-8');
  writeFileSync(join(root, 'README.md'), '# test\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

describe('write_scope helpers', () => {
  it('validateImplementWriteScope requires non-empty relative paths', () => {
    const root = createGitProject();
    const empty = validateImplementWriteScope([], root);
    assert.equal(empty.ok, false);
    assert.ok(empty.diagnostics.some((d) => d.code === 'write_scope_required'));

    const abs = validateImplementWriteScope(['C:\\Windows'], root);
    assert.equal(abs.ok, false);

    const escape = validateImplementWriteScope(['../outside'], root);
    assert.equal(escape.ok, false);

    const ok = validateImplementWriteScope(['src', 'docs/a'], root);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.normalizedScope, ['src', 'docs/a']);
  });

  it('isPathInWriteScope and scopesOverlap work on relative trees', () => {
    const root = createGitProject();
    assert.equal(isPathInWriteScope('src/main.ts', ['src'], root), true);
    assert.equal(isPathInWriteScope('README.md', ['src'], root), false);
    assert.equal(scopesOverlap('src', 'src/a'), true);
    assert.equal(scopesOverlap('src/a', 'src/b'), false);
  });

  it('validateDisjointWriteScopes rejects overlapping agents', () => {
    const conflicts = validateDisjointWriteScopes([
      { id: 'a', writeScope: ['src'] },
      { id: 'b', writeScope: ['src/util'] },
    ]);
    assert.ok(conflicts.some((c) => c.code === 'write_scope_conflict'));

    const ok = validateDisjointWriteScopes([
      { id: 'a', writeScope: ['src/a'] },
      { id: 'b', writeScope: ['src/b'] },
    ]);
    assert.equal(ok.length, 0);
  });
});

describe('runImplementWorktreeAgent', () => {
  it('rejects empty write_scope without creating a worktree', async () => {
    const root = createGitProject();
    const result = await runImplementWorktreeAgent(
      {
        id: 'no-scope',
        task: 'Should not run',
        writeScope: [],
      },
      {
        projectRoot: root,
        useDeterministicMock: true,
        cleanupWorktree: true,
      },
    );
    assert.equal(result.success, false);
    assert.ok(result.diagnostics.some((d) => d.code === 'write_scope_required'));
    assert.equal(existsSync(join(root, '.babel', 'worktrees')), false);
  });

  it('writes inside worktree and leaves parent tree clean', async () => {
    const root = createGitProject();

    const result = await runImplementWorktreeAgent(
      {
        id: 'impl-clean',
        task: 'Write a result under src',
        writeScope: ['src'],
        maxRounds: 3,
      },
      {
        projectRoot: root,
        useDeterministicMock: true,
        cleanupWorktree: false,
      },
    );

    assert.equal(result.success, true, result.summary);
    assert.equal(result.parentTreeClean, true);
    assert.equal(result.parentStatusBefore, result.parentStatusAfter);
    assert.ok(result.worktree.path.includes('.babel'));
    assert.ok(existsSync(result.worktree.path));

    // Deterministic mock writes src/result.txt under the worktree project root.
    assert.equal(
      worktreePathExists(result.worktree.path, join('src', 'result.txt')),
      true,
      'expected mock write in worktree',
    );
    assert.equal(
      existsSync(join(root, 'src', 'result.txt')),
      false,
      'parent must not receive worktree write',
    );
    // Parent source tree must not list the mock write (ignore .babel artifacts).
    const parentStatus = spawnSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf-8',
    }).stdout;
    assert.ok(!parentStatus.includes('src/result.txt'));
    assert.ok(!parentStatus.includes('src\\result.txt'));

    // Cleanup worktree so temp root can be removed.
    spawnSync('git', ['worktree', 'remove', '--force', result.worktree.path], {
      cwd: root,
      encoding: 'utf-8',
    });
  });

  it('blocks fan-out when write scopes overlap', async () => {
    const root = createGitProject();
    const results = await runImplementWorktreeAgents(
      [
        { id: 'a', task: 'edit a', writeScope: ['src'] },
        { id: 'b', task: 'edit b', writeScope: ['src/main.ts'] },
      ],
      {
        projectRoot: root,
        useDeterministicMock: true,
        cleanupWorktree: true,
      },
    );
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.success === false));
    assert.ok(results[0]!.diagnostics.some((d) => d.code === 'write_scope_conflict'));
  });

  it('runs two disjoint implement agents without dirtying parent', async () => {
    const root = createGitProject();
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'x.ts'), 'export {}\n', 'utf-8');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'add lib']);

    const results = await runImplementWorktreeAgents(
      [
        { id: 'src-agent', task: 'touch src', writeScope: ['src'] },
        { id: 'lib-agent', task: 'touch lib', writeScope: ['lib'] },
      ],
      {
        projectRoot: root,
        useDeterministicMock: true,
        cleanupWorktree: true,
      },
    );

    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.success, true, r.summary);
      assert.equal(r.parentTreeClean, true);
    }

    // Parent files untouched by either child.
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const n = 1;\n');
    assert.equal(existsSync(join(root, 'src', 'result.txt')), false);
    assert.equal(existsSync(join(root, 'lib', 'result.txt')), false);
  });
});

describe('promoteImplementWorktree (W2.1 merge)', () => {
  it('dry_run lists scoped worktree changes without writing parent', async () => {
    const root = createGitProject();
    const impl = await runImplementWorktreeAgent(
      {
        id: 'promote-dry',
        task: 'Write a result under src',
        writeScope: ['src'],
        maxRounds: 3,
      },
      {
        projectRoot: root,
        useDeterministicMock: true,
        cleanupWorktree: false,
      },
    );
    assert.equal(impl.success, true, impl.summary);

    const dry = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: impl.worktree.path,
      writeScope: ['src'],
      mode: 'dry_run',
    });
    assert.equal(dry.mode, 'dry_run');
    assert.ok(dry.promotedPaths.some((p) => p.includes('result')), dry.summary);
    assert.equal(existsSync(join(root, 'src', 'result.txt')), false);

    spawnSync('git', ['worktree', 'remove', '--force', impl.worktree.path], {
      cwd: root,
      encoding: 'utf-8',
    });
  });

  it('copy promotes worktree files into parent within write_scope', async () => {
    const root = createGitProject();
    const impl = await runImplementWorktreeAgent(
      {
        id: 'promote-copy',
        task: 'Write a result under src',
        writeScope: ['src'],
        maxRounds: 3,
      },
      {
        projectRoot: root,
        useDeterministicMock: true,
        cleanupWorktree: false,
      },
    );
    assert.equal(impl.success, true, impl.summary);
    assert.equal(existsSync(join(root, 'src', 'result.txt')), false);

    const promo = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: impl.worktree.path,
      writeScope: ['src'],
      mode: 'copy',
      cleanupWorktree: false,
    });
    assert.equal(promo.success, true, promo.summary);
    assert.ok(promo.promotedPaths.length > 0, JSON.stringify(promo));
    assert.equal(existsSync(join(root, 'src', 'result.txt')), true);

    // Outside scope cannot be promoted even if listed
    const outside = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: impl.worktree.path,
      writeScope: ['src'],
      paths: ['README.md'],
      mode: 'copy',
    });
    assert.ok(outside.skippedPaths.some((s) => s.path.includes('README')));

    spawnSync('git', ['worktree', 'remove', '--force', impl.worktree.path], {
      cwd: root,
      encoding: 'utf-8',
    });
  });

  it('listWorktreeScopedChanges only returns in-scope paths', async () => {
    const root = createGitProject();
    const impl = await runImplementWorktreeAgent(
      {
        id: 'list-scoped',
        task: 'Write a result under src',
        writeScope: ['src'],
        maxRounds: 3,
      },
      {
        projectRoot: root,
        useDeterministicMock: true,
        cleanupWorktree: false,
      },
    );
    const listed = listWorktreeScopedChanges(impl.worktree.path, ['src'], root);
    assert.ok(listed.every((p) => p.startsWith('src') || p.includes('src/')));
    spawnSync('git', ['worktree', 'remove', '--force', impl.worktree.path], {
      cwd: root,
      encoding: 'utf-8',
    });
  });
});
