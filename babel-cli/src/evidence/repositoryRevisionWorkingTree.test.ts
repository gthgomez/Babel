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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
});
