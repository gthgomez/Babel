/**
 * D04 — resume repository-root identity.
 *
 * Root identity must reflect physical identity, not a case-folded string.
 * Two distinct case-sensitive directories (`.../Repo` vs `.../repo`) are
 * different repositories; a symlink to the same physical root is the same
 * repository; an unresolvable root fails closed; and a session with no durable
 * identity is reported as unproven (`unknown`), never as verified.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createThreadEventLog,
  resolveRepoIdentityOnResume,
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
  test('the same existing root is verified', () => {
    const root = mkdtempSync(join(tmpdir(), 'd04-same-'));
    try {
      const check = validateRepoIdentityOnResume(logWithRoot(root), root);
      assert.equal(check.ok, true);
      assert.equal(check.status, 'verified');
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
      assert.equal(check.status, 'mismatch');
      if (!check.ok) assert.match(check.reason, /root changed/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('a symlink alias of the same physical root is verified', (t) => {
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
      const check = validateRepoIdentityOnResume(logWithRoot(real), link);
      assert.equal(check.ok, true, 'a symlink to the same physical root is the same repository');
      assert.equal(check.status, 'verified');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('a symlink to a different repository is rejected', (t) => {
    if (process.platform === 'win32') {
      t.skip('symlink semantics differ on Windows');
      return;
    }
    const parent = mkdtempSync(join(tmpdir(), 'd04-link-other-'));
    try {
      const realA = join(parent, 'real-a');
      const realB = join(parent, 'real-b');
      const linkToB = join(parent, 'link-to-b');
      mkdirSync(realA);
      mkdirSync(realB);
      symlinkSync(realB, linkToB, 'dir');
      const check = validateRepoIdentityOnResume(logWithRoot(realA), linkToB);
      assert.equal(check.ok, false, 'a symlink to a different repository must not match');
      assert.equal(check.status, 'mismatch');
      if (!check.ok) assert.equal(check.savedRoot, realA);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('saved root missing, current present fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'd04-saved-missing-'));
    try {
      const check = validateRepoIdentityOnResume(logWithRoot(join(root, 'gone')), root);
      assert.equal(check.ok, false, 'identity cannot be established -> require confirmation');
      assert.equal(check.status, 'mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('saved root present, current missing fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'd04-current-missing-'));
    try {
      const check = validateRepoIdentityOnResume(logWithRoot(root), join(root, 'gone'));
      assert.equal(check.ok, false, 'identity cannot be established -> require confirmation');
      assert.equal(check.status, 'mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('both roots unresolved do not silently claim physical identity', () => {
    const check = validateRepoIdentityOnResume(
      logWithRoot('/nonexistent/d04-old-root'),
      '/nonexistent/d04-new-root',
    );
    assert.equal(check.ok, false, 'lexical equality must not prove physical identity');
    assert.equal(check.status, 'unknown');
    if (!check.ok) assert.match(check.reason, /root changed/i);
  });

  test('no durable repo identity is unproven, never verified', () => {
    const log = createThreadEventLog();
    const check = validateRepoIdentityOnResume(log, '/tmp/some-root');
    assert.equal(check.ok, false, 'absence of identity must not be treated as proof');
    assert.equal(check.status, 'unknown');
    if (!check.ok) assert.equal(check.savedRoot, null);
  });

  test('fallback saved root is used when the log has no identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'd04-fallback-'));
    try {
      const viaValidator = validateRepoIdentityOnResume(createThreadEventLog(), root, root);
      assert.equal(viaValidator.ok, true);
      const core = resolveRepoIdentityOnResume(root, root);
      assert.equal(core.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
