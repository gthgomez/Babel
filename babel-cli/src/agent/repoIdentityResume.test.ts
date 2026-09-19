/**
 * D04 — resume repository-root identity.
 *
 * Root identity must reflect physical identity, not a case-folded string.
 * Two distinct case-sensitive directories (`.../Repo` vs `.../repo`) are
 * different repositories; a symlink to the same physical root is the same
 * repository; an unresolvable root fails closed.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createThreadEventLog,
  startTurn,
  validateRepoIdentityOnResume,
} from './threadEventLog.js';

function logWithRoot(projectRoot: string) {
  const log = createThreadEventLog();
  startTurn(log, {
    task: 't',
    model: 'm',
    provider: 'p',
    projectRoot,
    policyPreset: 'workspace_write',
  });
  return log;
}

describe('D04 resume repository-root identity', () => {
  test('the same existing root is accepted', () => {
    const root = mkdtempSync(join(tmpdir(), 'd04-same-'));
    try {
      assert.equal(validateRepoIdentityOnResume(logWithRoot(root), root).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('distinct case-sensitive roots are not the same repository', (t) => {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      t.skip('requires a case-sensitive filesystem');
      return;
    }
    const parent = mkdtempSync(join(tmpdir(), 'd04-case-'));
    try {
      const upper = join(parent, 'Repo');
      const lower = join(parent, 'repo');
      mkdirSync(upper);
      mkdirSync(lower);
      const check = validateRepoIdentityOnResume(logWithRoot(upper), lower);
      assert.equal(check.ok, false, 'case-distinct physical roots must require confirmation');
      if (!check.ok) assert.match(check.reason, /root changed/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('a symlink alias of the same physical root is accepted', (t) => {
    if (process.platform === 'win32') {
      t.skip('symlink semantics differ on Windows');
      return;
    }
    const parent = mkdtempSync(join(tmpdir(), 'd04-link-'));
    try {
      const real = join(parent, 'real');
      const link = join(parent, 'link');
      mkdirSync(real);
      symlinkSync(real, link, 'dir');
      assert.equal(
        validateRepoIdentityOnResume(logWithRoot(real), link).ok,
        true,
        'a symlink to the same physical root is the same repository',
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('unresolvable roots fall back to lexical comparison (preserves prior behavior)', () => {
    const check = validateRepoIdentityOnResume(
      logWithRoot('/nonexistent/d04-old-root'),
      '/nonexistent/d04-new-root',
    );
    assert.equal(check.ok, false);
    if (!check.ok) assert.match(check.reason, /root changed/i);
  });

  test('one resolvable and one missing root fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'd04-one-missing-'));
    try {
      const check = validateRepoIdentityOnResume(logWithRoot(root), join(root, 'does-not-exist'));
      assert.equal(check.ok, false, 'identity cannot be established -> require confirmation');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
