import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBaseline } from './integrity.js';
import { snapshotGovernanceBytes } from './governanceReconcile.js';

test('self-consistent external Git pointers cannot grant snapshot or restoration authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-forged-git-'));
  try {
    const project = join(root, 'project');
    const unrelated = join(root, 'unrelated');
    const admin = join(unrelated, 'worktrees', 'forged');
    mkdirSync(project); mkdirSync(admin, { recursive: true });
    writeFileSync(join(project, '.git'), `gitdir: ${admin}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'gitdir'), `${join(project, '.git')}\n`);
    writeFileSync(join(unrelated, 'config'), 'outside-original');
    assert.throws(() => buildBaseline(project), /trusted Git common directory/);
    assert.throws(() => snapshotGovernanceBytes(project), /trusted Git common directory/);
    assert.throws(() => buildBaseline(project, join(root, 'authorized', '.git')), /outside trusted Git common directory/);
    assert.equal(readFileSync(join(unrelated, 'config'), 'utf8'), 'outside-original');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cross-drive manifest resolution preserves the external target used by restore', async () => {
  const { win32 } = await import('node:path');
  const { resolveGovernancePath } = await import('./gitGovernance.js');
  const { inspectProtectedPath, restoreOne } = await import('./governanceReconcile.js');
  const root = 'D:\\linked';
  const actual = 'C:\\main\\.git\\config';
  const key = win32.relative(root, actual).replace(/\\/g, '/');
  const resolved = resolveGovernancePath(root, key, 'win32');
  assert.equal(resolved, actual);
  let bytes: Buffer = Buffer.from('original');
  const touched: string[] = [];
  const fs = {
    lstatSync: (path: string) => { touched.push(path); return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }; },
    readFileSync: (path: string) => { touched.push(path); return bytes; },
    writeFileSync: (path: string, data: Buffer) => { touched.push(path); bytes = data; },
    mkdirSync: () => {}, rmSync: (path: string) => { touched.push(path); },
    readlinkSync: () => '', symlinkSync: () => {},
  };
  const before = inspectProtectedPath(resolved, key, fs);
  bytes = Buffer.from('changed');
  assert.equal(restoreOne(before, fs).verified, true);
  assert.equal(bytes.toString(), 'original');
  assert.ok(touched.length > 0);
  assert.ok(touched.every((path) => path === actual));
});
