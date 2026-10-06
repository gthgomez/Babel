/**
 * Regression: repository-scope revision evidence must bind the ACTUAL bytes,
 * existence and type of verification-relevant files — not a fingerprint of
 * Git status metadata. A metadata-only fingerprint could not see a byte
 * change A→B in a tracked file that was already dirty at capture time, nor a
 * byte change in an untracked file that already existed: the status output is
 * identical before and after, so stale evidence read as current and the
 * checker was never re-executed.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { RevisionManager, compareRevisions } from './revisionBoundReceipt.js';

describe('repository-scope revisions bind actual file bytes', { concurrency: false }, () => {
  let root: string;

  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'babel-revbytes-'));
    git(['init', '--quiet']);
    git(['config', 'user.email', 'fixture@example.test']);
    git(['config', 'user.name', 'fixture']);
    writeFileSync(join(root, 'tracked.txt'), 'committed\n', 'utf8');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'baseline']);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a byte change A→B in an already-dirty tracked file makes captured evidence stale', () => {
    writeFileSync(join(root, 'tracked.txt'), 'A\n', 'utf8'); // dirty at capture
    const capture = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    writeFileSync(join(root, 'tracked.txt'), 'B\n', 'utf8'); // same status text, different bytes
    const fresh = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    assert.notEqual(
      capture.compositeTreeHash,
      fresh.compositeTreeHash,
      'evidence must diverge when dirty tracked bytes change',
    );
    const verdict = compareRevisions(capture, fresh);
    assert.equal(verdict.stale, true, 'stale evidence must force checker re-execution');
    // Genuinely unchanged inputs must still reuse: re-capture matches.
    const again = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    assert.equal(compareRevisions(fresh, again).stale, false);
  });

  test('a byte change in an existing untracked input makes captured evidence stale', () => {
    writeFileSync(join(root, 'untracked.txt'), 'X\n', 'utf8'); // existed at capture
    const capture = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    writeFileSync(join(root, 'untracked.txt'), 'Y\n', 'utf8'); // still just "? untracked.txt"
    const fresh = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    assert.notEqual(capture.compositeTreeHash, fresh.compositeTreeHash);
    assert.equal(compareRevisions(capture, fresh).stale, true);
  });

  test('deleting a relevant input changes the revision (existence is evidence)', () => {
    writeFileSync(join(root, 'doomed.txt'), 'gone soon\n', 'utf8');
    const capture = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    unlinkSync(join(root, 'doomed.txt'));
    const fresh = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    assert.notEqual(capture.compositeTreeHash, fresh.compositeTreeHash);
    assert.equal(compareRevisions(capture, fresh).stale, true);
  });

  test('changing the type of a relevant input (file → directory) changes the revision', () => {
    writeFileSync(join(root, 'typed.txt'), 'file\n', 'utf8');
    const capture = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    unlinkSync(join(root, 'typed.txt'));
    mkdirSync(join(root, 'typed.txt'));
    writeFileSync(join(root, 'typed.txt', 'inner.txt'), 'nested\n', 'utf8');
    const fresh = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    assert.notEqual(capture.compositeTreeHash, fresh.compositeTreeHash);
    assert.equal(compareRevisions(capture, fresh).stale, true);
    rmSync(join(root, 'typed.txt'), { recursive: true, force: true });
  });

  test('genuinely unchanged inputs keep evidence current (reuse preserved)', () => {
    const capture = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    const fresh = RevisionManager.computeRevisionSync(root, [], {
      scope_kind: 'repository',
    });
    assert.equal(capture.compositeTreeHash, fresh.compositeTreeHash);
    assert.equal(compareRevisions(capture, fresh).stale, false);
  });
});
