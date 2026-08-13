import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  collectWorkspaceDiff,
  getLastReviewDiff,
  openDiffReview,
  rememberReviewDiff,
  resetReviewDiffForTests,
} from './diffReview.js';
import { PagerOverlay } from './pagerOverlay.js';
import { runGitCommand } from '../utils/gitExec.js';

describe('diff review roundtrip', () => {
  it('restores composer text exactly after opening and closing the diff', async () => {
    resetReviewDiffForTests();
    let draft = 'follow-up: also rename the helper';
    const shown: string[] = [];
    const originalShow = PagerOverlay.show;
    PagerOverlay.show = async () => {
      shown.push('pager opened');
      draft = 'pager must not keep this';
    };
    let result;
    try {
      result = await openDiffReview({
        getDiff: () => 'diff --git a/src/foo.ts b/src/foo.ts\n+ok',
        getComposerDraft: () => draft,
        setComposerDraft: (text) => {
          draft = text;
        },
      });
    } finally {
      PagerOverlay.show = originalShow;
    }
    assert.equal(result.restoredDraft, 'follow-up: also rename the helper');
    assert.equal(draft, 'follow-up: also rename the helper');
    assert.equal(shown[0], 'pager opened');
  });

  it('collects tracked, staged, and untracked changes without including ignored files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-diff-review-'));
    try {
      const git = (args: string[]) => runGitCommand(args, root);
      assert.equal(git(['init', '-q']).status, 0);
      assert.equal(git(['config', 'user.email', 'test@example.com']).status, 0);
      assert.equal(git(['config', 'user.name', 'Babel Test']).status, 0);
      writeFileSync(join(root, 'tracked.txt'), 'base\n');
      writeFileSync(join(root, 'staged.txt'), 'base\n');
      assert.equal(git(['add', '--', 'tracked.txt', 'staged.txt']).status, 0);
      assert.equal(git(['commit', '-qm', 'base']).status, 0);

      writeFileSync(join(root, 'tracked.txt'), 'unstaged change\n');
      writeFileSync(join(root, 'staged.txt'), 'staged change\n');
      assert.equal(git(['add', '--', 'staged.txt']).status, 0);
      writeFileSync(join(root, 'untracked file.txt'), 'new text\n');
      writeFileSync(join(root, 'ignored.txt'), 'must stay hidden\n');
      writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');

      const diff = await collectWorkspaceDiff(root);
      assert.match(diff, /unstaged change/);
      assert.match(diff, /staged change/);
      assert.match(diff, /Untracked file: "untracked file\.txt"/);
      assert.match(diff, /new text/);
      assert.doesNotMatch(diff, /must stay hidden/);

      const binaryPath = join(root, 'binary.bin');
      writeFileSync(binaryPath, Buffer.from([0, 1, 2, 255]));
      const binaryDiff = await collectWorkspaceDiff(root);
      assert.match(binaryDiff, /GIT binary patch/);
      assert.doesNotMatch(binaryDiff, /\u0000\u0001\u0002/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no changes for a clean repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-diff-clean-'));
    try {
      const git = (args: string[]) => runGitCommand(args, root);
      assert.equal(git(['init', '-q']).status, 0);
      assert.equal(git(['config', 'user.email', 'test@example.com']).status, 0);
      assert.equal(git(['config', 'user.name', 'Babel Test']).status, 0);
      writeFileSync(join(root, 'tracked.txt'), 'base\n');
      assert.equal(git(['add', '--', 'tracked.txt']).status, 0);
      assert.equal(git(['commit', '-qm', 'base']).status, 0);
      assert.equal(await collectWorkspaceDiff(root), '(no unstaged or staged changes)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('remembers last review files for /diff', () => {
    rememberReviewDiff({ files: ['a.ts', 'b.ts'], draft: 'x', cwd: '/repo' });
    const last = getLastReviewDiff();
    assert.deepEqual(last.files, ['a.ts', 'b.ts']);
    assert.equal(last.cwd, '/repo');
  });
});
