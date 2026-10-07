/**
 * Repository-scope revision must see the real working tree
 * (chat-reliability-20261004, P3).
 *
 * The old repository hash hashed `git ls-files -s` (the INDEX) and, without
 * Git, the directory PATH string. Neither can see an unstaged tracked edit or
 * an untracked input, so a receipt bound to such a revision stayed "current"
 * across exactly the changes it exists to detect.
 *
 * Contract under test:
 *  - an unstaged edit to a tracked file changes the repository revision;
 *  - adding a relevant untracked file changes the repository revision;
 *  - the revision is stable while the tree is untouched (same-state reuse);
 *  - the no-Git fallback no longer hashes the bare directory path, i.e. it
 *    cannot produce the same digest for a path whose contents moved
 *    (bounded-capture limitation: contents stay unverified there).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { RevisionManager } from './revisionBoundReceipt.js';

describe('repository-scope revision vs the real working tree', () => {
  let root = '';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'babel-repo-revision-'));
    const git = (args: string[], cwd = root) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Babel Tests']);
    writeFileSync(join(root, 'tracked.ts'), 'v1\n');
    git(['add', 'tracked.ts']);
    git(['commit', '-q', '-m', 'init']);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function revision(): string {
    const rev = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
      git_binding: 'optional',
    });
    return rev.compositeTreeHash;
  }

  test('unstaged tracked edit changes the repository revision', () => {
    const before = revision();
    writeFileSync(join(root, 'tracked.ts'), 'v2\n');
    assert.notEqual(revision(), before);
  });

  test('relevant untracked input changes the repository revision', () => {
    const before = revision();
    writeFileSync(join(root, 'untracked-input.txt'), 'new bytes\n');
    assert.notEqual(revision(), before);
  });

  test('untouched tree keeps the same revision (legitimate same-state reuse)', () => {
    const before = revision();
    assert.equal(revision(), before);
  });

  test('no-Git fallback is not a bare directory-path digest', () => {
    // A path-only hash is constant across content moves. The fallback must
    // carry an explicit unverified marker, so it can never equal the digest
    // of the bare path (and can never be confused with Git-derived evidence).
    const bare = mkdtempSync(join(tmpdir(), 'babel-repo-nogit-'));
    try {
      const rev = RevisionManager.computeRevisionSync(bare, [], {
        scope_kind: 'repository',
        git_binding: 'optional',
      });
      const pathDigest = createHash('sha256').update(bare).digest('hex');
      assert.notEqual(rev.fileHashes['<repository>'], pathDigest);
      assert.equal(rev.gitCommitHash, null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('nested repository scope binds dirty and untracked bytes without reading outside the package', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'babel-nested-revision-'));
    const projectRoot = join(repositoryRoot, 'packages', 'app');
    mkdirSync(projectRoot, { recursive: true });
    const git = (args: string[]) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
    try {
      writeFileSync(join(projectRoot, 'tracked.txt'), 'tracked baseline\n');
      writeFileSync(join(repositoryRoot, 'outside.txt'), 'outside baseline\n');
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Babel Tests']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'nested baseline']);

      const revision = () => RevisionManager.computeRevisionSync(projectRoot, [], {
        scope_kind: 'repository',
        git_binding: 'required',
      });

      writeFileSync(join(projectRoot, 'tracked.txt'), 'tracked A\n');
      const beforeDirtyTrackedEdit = revision();
      writeFileSync(join(projectRoot, 'tracked.txt'), 'tracked B\n');
      const afterDirtyTrackedEdit = revision();
      assert.notEqual(afterDirtyTrackedEdit.compositeTreeHash, beforeDirtyTrackedEdit.compositeTreeHash,
        'already-dirty tracked A→B bytes inside the nested project change its repository scope');

      writeFileSync(join(projectRoot, 'untracked.txt'), 'untracked A\n');
      const beforeUntrackedEdit = revision();
      writeFileSync(join(projectRoot, 'untracked.txt'), 'untracked B\n');
      const afterUntrackedEdit = revision();
      assert.notEqual(afterUntrackedEdit.compositeTreeHash, beforeUntrackedEdit.compositeTreeHash,
        'already-untracked A→B bytes inside the nested project change its repository scope');

      const beforeOutsideEdit = revision();
      writeFileSync(join(repositoryRoot, 'outside.txt'), 'outside changed\n');
      const afterOutsideEdit = revision();
      assert.equal(afterOutsideEdit.compositeTreeHash, beforeOutsideEdit.compositeTreeHash,
        'a nested project scope neither reads nor binds changes outside that projectRoot');
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  test('nested repository scope fails closed when a dirty path traverses a symlinked parent', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'babel-symlink-parent-revision-'));
    const projectRoot = join(repositoryRoot, 'packages', 'app');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'babel-symlink-parent-target-'));
    const trackedDirectory = join(projectRoot, 'src');
    const outsideFile = join(outsideRoot, 'tracked.txt');
    mkdirSync(trackedDirectory, { recursive: true });
    writeFileSync(join(trackedDirectory, 'tracked.txt'), 'baseline\n');
    const git = (args: string[]) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Babel Tests']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'symlink-parent baseline']);

      rmSync(trackedDirectory, { recursive: true, force: true });
      mkdirSync(outsideRoot, { recursive: true });
      writeFileSync(outsideFile, 'outside A\n');
      symlinkSync(outsideRoot, trackedDirectory, platform() === 'win32' ? 'junction' : 'dir');

      const requiredRevision = () => RevisionManager.computeRevisionSync(projectRoot, [], {
        scope_kind: 'repository',
        git_binding: 'required',
      });
      assert.throws(requiredRevision, /Required Git tree cannot be established/,
        'a tracked path beneath a symlinked parent cannot produce certifying content evidence');

      writeFileSync(outsideFile, 'outside B\n');
      assert.throws(requiredRevision, /Required Git tree cannot be established/,
        'changing the outside target remains unverified instead of being read into the project receipt');
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test('nested repository scope remains computable when a tracked parent directory is deleted', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'babel-deleted-parent-revision-'));
    const projectRoot = join(repositoryRoot, 'packages', 'app');
    const trackedDirectory = join(projectRoot, 'src');
    mkdirSync(trackedDirectory, { recursive: true });
    writeFileSync(join(trackedDirectory, 'tracked.txt'), 'baseline\n');
    const git = (args: string[]) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.invalid']);
      git(['config', 'user.name', 'Babel Tests']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'deleted parent baseline']);

      const revision = () => RevisionManager.computeRevisionSync(projectRoot, [], {
        scope_kind: 'repository',
        git_binding: 'required',
      });
      const beforeDeletion = revision();
      rmSync(trackedDirectory, { recursive: true, force: true });
      const afterDeletion = revision();
      assert.notEqual(afterDeletion.compositeTreeHash, beforeDeletion.compositeTreeHash,
        'a deleted tracked parent remains known missing evidence and changes the repository revision');
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
