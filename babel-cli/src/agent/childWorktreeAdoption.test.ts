/**
 * TF-25 / Q12 — governed parent adoption of child worktree output.
 *
 * The mutation child runs in an isolated git worktree. Its result previously
 * exposed only a worktree path and `incorporation: not_applied_to_parent`;
 * the only promotion helper verified neither the recorded child base nor the
 * child postimage, promoted files partially, and could remove the worktree
 * (dropping the child patch) even when some paths were skipped.
 *
 * These tests drive the real implement-worktree child (deterministic offline
 * mock) and the parent adoption entry point with a dirty parent, stale base,
 * tampered postimage, scope escape and a deletion.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  promoteImplementWorktree,
  runImplementWorktreeAgent,
  type ImplementWorktreeAgentResult,
} from './implementWorktreeAgent.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows file locks are best-effort during cleanup.
    }
  }
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createGitProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-child-adoption-'));
  tempRoots.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'babel-test@example.com']);
  git(root, ['config', 'user.name', 'Babel Test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'README.md'), '# test\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

async function childWorktree(
  root: string,
  id: string,
  options: { cleanupWorktree?: boolean; discardChildChanges?: boolean } = {},
): Promise<ImplementWorktreeAgentResult> {
  return runImplementWorktreeAgent(
    { id, task: 'Write a result under src', writeScope: ['src'], maxRounds: 3 },
    { projectRoot: root, useDeterministicMock: true, cleanupWorktree: false, ...options },
  );
}

function changedFile(
  root: string,
  worktreePath: string,
  relativePath: string,
  before: string | null,
  after: string | null,
): { path: string; before_hash: string | null; after_hash: string | null } {
  // Custom manifests define their own change set; remove the deterministic
  // mock's result so it is not reported as an unrecorded worktree change.
  rmSync(join(worktreePath, 'src', 'result.txt'), { force: true });
  const parentPath = join(root, relativePath);
  if (before !== null && !existsSync(parentPath)) writeFileSync(parentPath, before);
  const worktreeFile = join(worktreePath, relativePath);
  mkdirSync(join(worktreeFile, '..'), { recursive: true });
  if (after === null) {
    rmSync(worktreeFile, { force: true });
  } else {
    writeFileSync(worktreeFile, after);
  }
  return {
    path: relativePath,
    before_hash: before === null ? null : hash(before),
    after_hash: after === null ? null : hash(after),
  };
}

describe('governed child worktree adoption', () => {
  it('adopts the recorded child postimage and reverifies it in the parent', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-success');
    assert.equal(child.success, true, child.summary);
    assert.ok(child.baseSha, 'child result records its base SHA');
    assert.ok(child.adoptionManifestPath, 'child result records the adoption manifest path');
    assert.ok(existsSync(child.adoptionManifestPath!), 'manifest is durable next to the run');

    const manifest = JSON.parse(readFileSync(child.adoptionManifestPath!, 'utf-8')) as {
      base_sha: string;
      write_scope: string[];
      changed_files: Array<{ path: string; before_hash: string | null; after_hash: string | null }>;
      worktree_path: string;
    };
    assert.equal(manifest.base_sha, child.baseSha);
    assert.deepEqual(manifest.changed_files.map((entry) => entry.path), ['src/result.txt']);

    // Unrelated parent work must be preserved, not overwritten or reverted.
    writeFileSync(join(root, 'README.md'), '# local notes\n');

    const promises: string[] = [];
    const adopted = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      worktreeName: child.worktree.name,
      writeScope: manifest.write_scope,
      baseSha: manifest.base_sha,
      expectedChanges: manifest.changed_files,
      mode: 'copy',
      cleanupWorktree: false,
      verify: (context) => {
        promises.push(...context.adoptedPaths);
        const body = readFileSync(join(context.projectRoot, 'src', 'result.txt'), 'utf-8');
        return { ok: body === 'Mutation agent result\n', summary: 'readback matched child postimage' };
      },
    });

    assert.equal(adopted.status, 'adopted', JSON.stringify(adopted, null, 2));
    assert.equal(adopted.success, true, adopted.summary);
    assert.deepEqual(adopted.adoptedPaths, ['src/result.txt']);
    assert.equal(adopted.verification?.ok, true);
    assert.deepEqual(promises, ['src/result.txt']);
    assert.equal(readFileSync(join(root, 'src', 'result.txt'), 'utf-8'), 'Mutation agent result\n');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf-8'), '# local notes\n');
    assert.ok(existsSync(join(child.worktree.path, 'src', 'result.txt')), 'worktree is retained by default');
  });

  it('refuses a stale child when the parent changed the same path', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-conflict');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');

    writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 99; // parent edit\n');

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
    });

    assert.equal(refused.status, 'refused');
    assert.equal(refused.success, false);
    assert.ok(refused.conflicts.some((c) => c.code === 'parent_preimage_conflict'), JSON.stringify(refused));
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 99; // parent edit\n');
    assert.equal(readFileSync(join(child.worktree.path, 'src', 'main.ts'), 'utf-8'), 'export const value = 2;\n');
  });

  it('refuses a child postimage that no longer matches the recorded hash', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-tampered');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');

    writeFileSync(join(child.worktree.path, 'src', 'main.ts'), 'export const value = 666; // changed after record\n');

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
    });

    assert.equal(refused.status, 'refused');
    assert.ok(refused.conflicts.some((c) => c.code === 'child_postimage_mismatch'), JSON.stringify(refused));
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 1;\n');
  });

  it('refuses paths outside the declared write scope', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-scope');
    const change = changedFile(root, child.worktree.path, 'README.md', '# test\n', '# child readme\n');

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
    });

    assert.equal(refused.status, 'refused');
    assert.ok(refused.conflicts.some((c) => c.code === 'outside_write_scope'), JSON.stringify(refused));
    assert.equal(readFileSync(join(root, 'README.md'), 'utf-8'), '# test\n');
  });

  it('refuses a stale base after the parent advanced', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-advanced');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');

    writeFileSync(join(root, 'CHANGELOG.md'), 'parent advanced\n');
    git(root, ['add', 'CHANGELOG.md']);
    git(root, ['commit', '-m', 'parent advanced']);

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
    });

    assert.equal(refused.status, 'refused');
    assert.ok(refused.conflicts.some((c) => c.code === 'stale_child_base'), JSON.stringify(refused));
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 1;\n');

    // An explicit override is still bound to the recorded preimage/postimage.
    const adopted = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
      allowAdvancedBase: true,
    });
    assert.equal(adopted.status, 'adopted', JSON.stringify(adopted, null, 2));
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 2;\n');
  });

  it('adopts a child deletion instead of silently skipping it', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-delete');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', null);

    const adopted = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
    });

    assert.equal(adopted.status, 'adopted', JSON.stringify(adopted, null, 2));
    assert.deepEqual(adopted.deletedPaths, ['src/main.ts']);
    assert.equal(existsSync(join(root, 'src', 'main.ts')), false);
  });

  it('keeps adopted bytes when parent verification fails and reports the failure', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-verify-fail');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');

    const result = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
      verify: () => ({ ok: false, summary: 'parent typecheck failed' }),
    });

    assert.equal(result.status, 'verification_failed');
    assert.equal(result.success, false);
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 2;\n');
  });

  it('refuses a worktree from a different repository', async () => {
    const root = createGitProject();
    const foreign = createGitProject();
    const child = await childWorktree(foreign, 'adopt-foreign');
    const change = changedFile(foreign, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
      allowAdvancedBase: true,
    });

    assert.equal(refused.status, 'refused');
    assert.ok(refused.conflicts.some((c) => c.code === 'foreign_worktree'), JSON.stringify(refused));
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 1;\n');
  });

  it('refuses cleanup when run_command-only writes are absent from the manifest', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-run-command');
    // The mutation loop cannot attribute shell writes; the worktree is dirty
    // but the manifest's changed_files is empty.
    writeFileSync(join(child.worktree.path, 'src', 'shell-only.txt'), 'written by run_command\n');

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      worktreeName: child.worktree.name,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [],
      mode: 'copy',
      cleanupWorktree: true,
    });

    assert.equal(refused.status, 'refused', JSON.stringify(refused, null, 2));
    assert.equal(refused.success, false);
    assert.ok(refused.conflicts.some((c) => c.code === 'unrecorded_worktree_change'));
    assert.ok(existsSync(child.worktree.path), 'worktree must be retained');
    assert.equal(
      readFileSync(join(child.worktree.path, 'src', 'shell-only.txt'), 'utf-8'),
      'written by run_command\n',
    );
    assert.equal(existsSync(join(root, 'src', 'shell-only.txt')), false);
  });

  it('refuses a path traversal and a credential path', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-unsafe');

    const traversal = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [{
        path: '../outside.txt',
        before_hash: null,
        after_hash: hash('escaped\n'),
      }],
      mode: 'copy',
    });
    assert.equal(traversal.status, 'refused');
    assert.ok(traversal.conflicts.some((c) => c.code === 'invalid_path'), JSON.stringify(traversal));
    assert.equal(existsSync(join(root, '..', 'outside.txt')), false);

    const credential = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['.env'],
      baseSha: child.baseSha!,
      expectedChanges: [{
        path: '.env',
        before_hash: null,
        after_hash: hash('SYNTHETIC_ONLY=1\n'),
      }],
      mode: 'copy',
    });
    assert.equal(credential.status, 'refused');
    assert.ok(credential.conflicts.some((c) => c.code === 'credential_path'), JSON.stringify(credential));
  });

  it('refuses duplicate manifest paths', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-duplicate');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change, change],
      mode: 'copy',
    });

    assert.equal(refused.status, 'refused');
    assert.ok(refused.conflicts.some((c) => c.code === 'duplicate_change'), JSON.stringify(refused));
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 1;\n');
  });

  it('refuses a recorded child postimage that is missing', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-missing');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');
    rmSync(join(child.worktree.path, 'src', 'main.ts'));

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
    });

    assert.equal(refused.status, 'refused');
    assert.ok(refused.conflicts.some((c) => c.code === 'child_postimage_missing'), JSON.stringify(refused));
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 1;\n');
  });

  it('refuses a child path that traverses a symlink', async (t) => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-symlink');
    const outside = mkdtempSync(join(tmpdir(), 'babel-adopt-outside-'));
    tempRoots.push(outside);
    try {
      symlinkSync(outside, join(child.worktree.path, 'src', 'linked'), 'dir');
    } catch {
      t.skip('symlink creation is not permitted on this host');
      return;
    }
    writeFileSync(join(outside, 'escaped.txt'), 'escaped\n');

    const refused = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [{
        path: 'src/linked/escaped.txt',
        before_hash: null,
        after_hash: hash('escaped\n'),
      }],
      mode: 'copy',
    });

    assert.equal(refused.status, 'refused');
    assert.ok(refused.conflicts.some((c) => c.code === 'unsafe_symlink'), JSON.stringify(refused));
    assert.equal(existsSync(join(root, 'src', 'linked')), false);
  });

  it('rolls back already-adopted bytes when a later write fails', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX directory modes are required to force a write failure');
      return;
    }
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-rollback');
    const first = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');
    const lockedDir = join(root, 'src', 'locked');
    mkdirSync(lockedDir, { recursive: true });
    const second = changedFile(root, child.worktree.path, 'src/locked/two.txt', null, 'two\n');
    chmodSync(lockedDir, 0o500);
    try {
      const refused = promoteImplementWorktree({
        projectRoot: root,
        worktreePath: child.worktree.path,
        writeScope: ['src'],
        baseSha: child.baseSha!,
        expectedChanges: [first, second],
        mode: 'copy',
      });

      assert.equal(refused.status, 'refused', JSON.stringify(refused, null, 2));
      assert.ok(refused.diagnostics.some((d) => d.code === 'adoption_rolled_back'), JSON.stringify(refused));
      assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 1;\n');
      assert.equal(existsSync(join(root, 'src', 'locked', 'two.txt')), false);
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });

  it('reports parent status after adoption', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-status');
    const manifest = JSON.parse(readFileSync(child.adoptionManifestPath!, 'utf-8')) as {
      base_sha: string;
      write_scope: string[];
      changed_files: Array<{ path: string; before_hash: string | null; after_hash: string | null }>;
    };

    const adopted = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      writeScope: manifest.write_scope,
      baseSha: manifest.base_sha,
      expectedChanges: manifest.changed_files,
      mode: 'copy',
    });

    assert.equal(adopted.status, 'adopted', JSON.stringify(adopted, null, 2));
    assert.match(adopted.parentStatusAfter, /src\/result\.txt/);
  });

  it('removes the worktree only after a fully adopted and verified change', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-cleanup');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');

    const adopted = promoteImplementWorktree({
      projectRoot: root,
      worktreePath: child.worktree.path,
      worktreeName: child.worktree.name,
      writeScope: ['src'],
      baseSha: child.baseSha!,
      expectedChanges: [change],
      mode: 'copy',
      cleanupWorktree: true,
      verify: () => ({ ok: true, summary: 'readback matched' }),
    });

    assert.equal(adopted.status, 'adopted', JSON.stringify(adopted, null, 2));
    assert.equal(adopted.worktreeRemoved, true);
    assert.equal(existsSync(child.worktree.path), false);
    assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 2;\n');
  });

  it('reports cleanup failure as a failed adoption result', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX directory modes are required to force worktree removal failure');
      return;
    }
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-cleanup-fail');
    const change = changedFile(root, child.worktree.path, 'src/main.ts', 'export const value = 1;\n', 'export const value = 2;\n');
    const adminRoot = join(root, '.git', 'worktrees');
    chmodSync(adminRoot, 0o500);
    try {
      const result = promoteImplementWorktree({
        projectRoot: root,
        worktreePath: child.worktree.path,
        writeScope: ['src'],
        baseSha: child.baseSha!,
        expectedChanges: [change],
        mode: 'copy',
        cleanupWorktree: true,
        verify: () => ({ ok: true, summary: 'readback matched' }),
      });

      assert.equal(result.status, 'cleanup_failed', JSON.stringify(result, null, 2));
      assert.equal(result.success, false);
      assert.ok(result.diagnostics.some((d) => d.code === 'worktree_cleanup_failed'));
      assert.equal(readFileSync(join(root, 'src', 'main.ts'), 'utf-8'), 'export const value = 2;\n');
    } finally {
      chmodSync(adminRoot, 0o700);
    }
  });

  it('retains the worktree when cleanup is requested but changes are unadopted', async () => {
    const root = createGitProject();
    const child = await childWorktree(root, 'adopt-retain', { cleanupWorktree: true });

    assert.equal(child.success, true, child.summary);
    assert.ok(existsSync(child.worktree.path), 'unadopted child changes must not be discarded');
    assert.ok(
      child.diagnostics.some((d) => d.code === 'worktree_retained_unadopted_changes'),
      JSON.stringify(child.diagnostics),
    );
  });
});
