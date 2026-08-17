/**
 * Object-type-aware governance restore: never write through an occupant.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  inspectProtectedPath,
  reconcileGovernanceAfterEffect,
  restoreOne,
  snapshotGovernanceBytes,
  type ProtectedSnapshot,
  type ReconcileFs,
} from './governanceReconcile.js';
import { parseLeaseJson } from './lease.js';
import { establishAuthoritySession } from './sessionContext.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-gov-restore-'));
  roots.push(root);
  return root;
}

function canSymlink(dir: string): boolean {
  const link = join(dir, 'probe-link');
  const target = join(dir, 'probe-target');
  try {
    writeFileSync(target, 't');
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

type MemNode =
  | { kind: 'file'; bytes: Buffer }
  | { kind: 'symlink'; target: string }
  | { kind: 'dir' };

function enoent(): Error {
  const err = new Error('ENOENT') as Error & { code: string };
  err.code = 'ENOENT';
  return err;
}

function makeMemFs(initial: Record<string, MemNode>): ReconcileFs {
  const nodes = new Map<string, MemNode>(Object.entries(initial));
  const resolveFile = (path: string): Buffer => {
    const seen = new Set<string>();
    let cur = path;
    while (!seen.has(cur)) {
      seen.add(cur);
      const n = nodes.get(cur);
      if (!n) throw enoent();
      if (n.kind === 'file') return n.bytes;
      if (n.kind === 'symlink') {
        cur = n.target;
        continue;
      }
      throw new Error('is a directory');
    }
    throw new Error('symlink loop');
  };
  return {
    lstatSync(path) {
      const n = nodes.get(path);
      if (!n) throw enoent();
      return {
        isFile: () => n.kind === 'file',
        isSymbolicLink: () => n.kind === 'symlink',
        isDirectory: () => n.kind === 'dir',
      };
    },
    readFileSync: resolveFile,
    writeFileSync(path, data) {
      const n = nodes.get(path);
      if (n?.kind === 'symlink') {
        nodes.set(n.target, { kind: 'file', bytes: Buffer.from(data) });
        return;
      }
      nodes.set(path, { kind: 'file', bytes: Buffer.from(data) });
    },
    mkdirSync() {
      return undefined;
    },
    rmSync(path) {
      nodes.delete(path);
    },
    readlinkSync(path) {
      const n = nodes.get(path);
      if (!n || n.kind !== 'symlink') throw enoent();
      return n.target;
    },
    symlinkSync(target, path) {
      nodes.set(path, { kind: 'symlink', target });
    },
  };
}

describe('governance object restore', () => {
  test('memfs: file->symlink occupant is unlinked, file rebuilt, canary unchanged', () => {
    const pdp = 'C:/repo/babel-cli/src/authority/pdp.ts';
    const canary = 'C:/outside/canary.txt';
    const trusted = Buffer.from('trusted-pdp\n');
    const canaryBytes = Buffer.from('CANARY\n');
    const fs = makeMemFs({
      [pdp]: { kind: 'symlink', target: canary },
      [canary]: { kind: 'file', bytes: canaryBytes },
    });
    const expected: ProtectedSnapshot = { kind: 'file', key: pdp, abs: pdp, bytes: trusted };
    const recon = reconcileGovernanceAfterEffect({
      repoRoot: 'C:/repo',
      before: [expected],
      fs,
    });
    assert.equal(recon.mutated, true);
    assert.equal(recon.failed.length, 0);
    assert.equal(inspectProtectedPath(pdp, pdp, fs).kind, 'file');
    assert.ok(trusted.equals(fs.readFileSync(pdp)));
    assert.ok(canaryBytes.equals(fs.readFileSync(canary)));
  });

  test('regular file -> symlink restores file and leaves canary unchanged', (t) => {
    const root = tempRoot();
    if (!canSymlink(root)) {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    const pdp = join(root, 'babel-cli/src/authority/pdp.ts');
    mkdirSync(dirname(pdp), { recursive: true });
    const original = 'export const pdp = "trusted";\n';
    writeFileSync(pdp, original);
    const canaryDir = mkdtempSync(join(tmpdir(), 'babel-canary-'));
    roots.push(canaryDir);
    const canary = join(canaryDir, 'external-canary.txt');
    const canaryBytes = 'CANARY_UNCHANGED\n';
    writeFileSync(canary, canaryBytes);
    const before = snapshotGovernanceBytes(root);
    rmSync(pdp, { force: true });
    symlinkSync(canary, pdp);
    const persistPath = join(root, 'runs/s1/authority-session.json');
    mkdirSync(dirname(persistPath), { recursive: true });
    const parsed = parseLeaseJson(
      JSON.stringify({
        version: 2,
        leaseId: 'restore-symlink',
        scope: { repository: 'babel', remote: 'origin' },
        allowedCapabilities: ['run_local_command'],
      }),
    );
    assert.ok(parsed.ok);
    const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease, persistPath });
    const recon = reconcileGovernanceAfterEffect({ repoRoot: root, before, session });
    assert.equal(recon.mutated, true);
    assert.equal(session.invalidated, true);
    const restored = inspectProtectedPath(pdp, 'pdp');
    assert.equal(restored.kind, 'file');
    assert.equal(readFileSync(pdp, 'utf8'), original);
    assert.equal(readFileSync(canary, 'utf8'), canaryBytes);
    assert.equal(recon.failed.length, 0);
  });

  test('authority-session file -> symlink restores file and leaves canary unchanged', (t) => {
    const root = tempRoot();
    if (!canSymlink(root)) {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    const persistPath = join(root, 'runs/s1/authority-session.json');
    mkdirSync(dirname(persistPath), { recursive: true });
    writeFileSync(persistPath, '{"ok":true}');
    const canaryDir = mkdtempSync(join(tmpdir(), 'babel-canary-sess-'));
    roots.push(canaryDir);
    const canary = join(canaryDir, 'session-canary.txt');
    writeFileSync(canary, 'SESSION_CANARY\n');
    const before = snapshotGovernanceBytes(root, [persistPath]);
    rmSync(persistPath, { force: true });
    symlinkSync(canary, persistPath);
    const recon = reconcileGovernanceAfterEffect({ repoRoot: root, before });
    assert.equal(recon.mutated, true);
    assert.equal(inspectProtectedPath(persistPath, persistPath).kind, 'file');
    assert.equal(readFileSync(persistPath, 'utf8'), '{"ok":true}');
    assert.equal(readFileSync(canary, 'utf8'), 'SESSION_CANARY\n');
  });

  test('regular file -> directory is removed and the file is rebuilt', () => {
    const root = tempRoot();
    const pdp = join(root, 'babel-cli/src/authority/pdp.ts');
    mkdirSync(dirname(pdp), { recursive: true });
    writeFileSync(pdp, 'trusted-pdp\n');
    const before = snapshotGovernanceBytes(root);
    rmSync(pdp, { force: true });
    mkdirSync(pdp);
    writeFileSync(join(pdp, 'nested.txt'), 'nope');
    const recon = reconcileGovernanceAfterEffect({ repoRoot: root, before });
    assert.equal(recon.mutated, true);
    const restored = inspectProtectedPath(pdp, 'pdp');
    assert.equal(restored.kind, 'file');
    assert.equal(readFileSync(pdp, 'utf8'), 'trusted-pdp\n');
  });

  test('expected missing -> non-empty directory is removed', () => {
    const root = tempRoot();
    const missing = join(root, 'runs/s1/authority-session.json');
    const before: ProtectedSnapshot[] = [{ kind: 'missing', key: missing, abs: missing }];
    mkdirSync(missing, { recursive: true });
    writeFileSync(join(missing, 'x.txt'), 'unexpected');
    const recon = reconcileGovernanceAfterEffect({ repoRoot: root, before });
    assert.equal(recon.mutated, true);
    assert.equal(inspectProtectedPath(missing, missing).kind, 'missing');
  });

  test('forced restoration failure surfaces and still invalidates', () => {
    const root = tempRoot();
    const pdp = join(root, 'babel-cli/src/authority/pdp.ts');
    mkdirSync(dirname(pdp), { recursive: true });
    writeFileSync(pdp, 'trusted\n');
    const persistPath = join(root, 'runs/s1/authority-session.json');
    mkdirSync(dirname(persistPath), { recursive: true });
    const parsed = parseLeaseJson(
      JSON.stringify({
        version: 2,
        leaseId: 'restore-fail',
        scope: { repository: 'babel', remote: 'origin' },
        allowedCapabilities: ['run_local_command'],
      }),
    );
    assert.ok(parsed.ok);
    const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease, persistPath });
    const expected: ProtectedSnapshot = {
      kind: 'file',
      key: pdp,
      abs: pdp,
      bytes: Buffer.from('trusted\n'),
    };
    const failingFs: ReconcileFs = {
      lstatSync: () => ({
        isFile: () => false,
        isSymbolicLink: () => false,
        isDirectory: () => false,
      }),
      readFileSync: () => {
        throw new Error('should not read');
      },
      writeFileSync: () => {
        throw new Error('forced write failure');
      },
      mkdirSync: () => undefined,
      rmSync: () => undefined,
      readlinkSync: () => '',
      symlinkSync: () => undefined,
    };
    const one = restoreOne(expected, failingFs);
    assert.equal(one.verified, false);
    assert.match(one.reason ?? '', /forced write failure/);
    const recon = reconcileGovernanceAfterEffect({
      repoRoot: root,
      before: [expected],
      session,
      fs: failingFs,
    });
    assert.equal(recon.mutated, true);
    assert.equal(session.invalidated, true);
    assert.ok(recon.failed.length > 0);
  });
});
