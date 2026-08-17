/**
 * Resume identity: persisted lease + repo must match the restored session.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLeaseJson, type AutonomyLease } from './lease.js';
import {
  AUTHORITY_SESSION_FILENAME,
  establishAuthoritySession,
  restoreAuthoritySession,
} from './sessionContext.js';

function makeLease(leaseId: string): AutonomyLease {
  return (
    parseLeaseJson(
      JSON.stringify({ version: 2, leaseId, scope: { repository: 'babel', remote: 'origin' } }),
    ) as { ok: true; lease: AutonomyLease }
  ).lease;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-resume-'));
}

test('same repo + same lease → restore succeeds', () => {
  const root = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = join(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(join(root, '.gitignore'), 'orig\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('same-lease'),
      persistPath,
    });
    const restored = restoreAuthoritySession({
      repoRoot: root,
      persistPath,
      lease: makeLease('same-lease'),
    });
    assert.equal(restored.resumeFailure, undefined);
    assert.equal(restored.invalidated, false);
    assert.equal(restored.lease?.leaseId, 'same-lease');
    assert.ok(restored.baseline);
    assert.equal(session.repoRoot, restored.repoRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('same repo + different lease → fail closed', () => {
  const root = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = join(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(join(root, '.gitignore'), 'orig\n');
    establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('lease-a'),
      persistPath,
    });
    const restored = restoreAuthoritySession({
      repoRoot: root,
      persistPath,
      lease: makeLease('lease-b'),
    });
    assert.equal(restored.resumeFailure, 'lease_mismatch');
    assert.equal(restored.invalidated, true);
    assert.equal(restored.baseline, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('different repo + same lease → fail closed', () => {
  const rootA = tmpRoot();
  const rootB = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = join(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(join(rootA, '.gitignore'), 'orig\n');
    writeFileSync(join(rootB, '.gitignore'), 'orig\n');
    establishAuthoritySession({
      repoRoot: rootA,
      lease: makeLease('lease-a'),
      persistPath,
    });
    const restored = restoreAuthoritySession({
      repoRoot: rootB,
      persistPath,
      lease: makeLease('lease-a'),
    });
    assert.equal(restored.resumeFailure, 'repo_mismatch');
    assert.equal(restored.invalidated, true);
    assert.equal(restored.baseline, null);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('persisted lease but current lease missing → fail closed', () => {
  const root = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = join(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(join(root, '.gitignore'), 'orig\n');
    establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('lease-a'),
      persistPath,
    });
    const restored = restoreAuthoritySession({
      repoRoot: root,
      persistPath,
      lease: null,
    });
    assert.equal(restored.resumeFailure, 'active_lease_missing');
    assert.equal(restored.invalidated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('active lease but persisted lease missing → fail closed', () => {
  const root = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = join(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(
      persistPath,
      JSON.stringify({
        schemaVersion: 1,
        leaseId: null,
        repoRoot: root,
        baseline: { entries: [] },
        invalidated: false,
      }),
    );
    const restored = restoreAuthoritySession({
      repoRoot: root,
      persistPath,
      lease: makeLease('lease-a'),
    });
    assert.equal(restored.resumeFailure, 'persisted_lease_missing');
    assert.equal(restored.invalidated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('tampered repoRoot → fail closed', () => {
  const root = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = join(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(join(root, '.gitignore'), 'orig\n');
    establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('lease-a'),
      persistPath,
    });
    writeFileSync(
      persistPath,
      JSON.stringify({
        schemaVersion: 1,
        leaseId: 'lease-a',
        repoRoot: join(root, 'tampered'),
        baseline: { entries: [] },
        invalidated: false,
      }),
    );
    const restored = restoreAuthoritySession({
      repoRoot: root,
      persistPath,
      lease: makeLease('lease-a'),
    });
    assert.equal(restored.resumeFailure, 'repo_mismatch');
    assert.equal(restored.invalidated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('tampered leaseId → fail closed', () => {
  const root = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = join(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(join(root, '.gitignore'), 'orig\n');
    establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('lease-a'),
      persistPath,
    });
    writeFileSync(
      persistPath,
      JSON.stringify({
        schemaVersion: 1,
        leaseId: 'forged-lease',
        repoRoot: root,
        baseline: { entries: [] },
        invalidated: false,
      }),
    );
    const restored = restoreAuthoritySession({
      repoRoot: root,
      persistPath,
      lease: makeLease('lease-a'),
    });
    assert.equal(restored.resumeFailure, 'lease_mismatch');
    assert.equal(restored.invalidated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('malformed persist JSON → fail closed', () => {
  const root = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = join(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(persistPath, '{not-json');
    const restored = restoreAuthoritySession({
      repoRoot: root,
      persistPath,
      lease: makeLease('lease-a'),
    });
    assert.equal(restored.resumeFailure, 'malformed');
    assert.equal(restored.invalidated, true);
    assert.equal(restored.baseline, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
