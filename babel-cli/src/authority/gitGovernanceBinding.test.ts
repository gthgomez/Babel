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
    mkdirSync(join(root, 'authorized', '.git', 'worktrees'), { recursive: true });
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

test('Windows short aliases resolve physical identity without accepting escapes or links', async () => {
  const { sameGovernancePath } = await import('./gitGovernance.js');
  const { win32 } = await import('node:path');
  const short = 'C:\\fixture\\LONGPA~1\\Temp\\main\\.git\\worktrees';
  const long = 'C:\\fixture\\LongPathDirectory\\Temp\\main\\.git\\worktrees';
  let blocked: string | undefined;
  let unreadable: string | undefined;
  let canonicalCalls = 0;
  const fs = {
    lstatSync: (path: string) => {
      if (path === unreadable) throw new Error('comparison unavailable');
      return { isDirectory: () => path !== blocked, isSymbolicLink: () => path === blocked };
    },
    realpathSync: (path: string) => { canonicalCalls++; return path.replace('LONGPA~1', 'LongPathDirectory'); },
  };
  assert.equal(sameGovernancePath(short, long, fs, 'win32'), true);
  assert.equal(sameGovernancePath(short, long.replace('main', 'outside'), fs, 'win32'), false);
  assert.equal(sameGovernancePath(short, long.replace('C:', 'D:'), fs, 'win32'), false);
  for (const link of [short, long, win32.dirname(short), win32.dirname(long)]) {
    blocked = link; canonicalCalls = 0;
    assert.throws(() => sameGovernancePath(short, long, fs, 'win32'), /Invalid governance ancestor/);
    assert.ok(canonicalCalls < 2, 'a linked path never reaches canonical comparison');
    assert.throws(() => sameGovernancePath(link, link, fs, 'win32'), /Invalid governance ancestor/);
  }
  blocked = undefined; unreadable = short;
  assert.throws(() => sameGovernancePath(short, long, fs, 'win32'), /comparison unavailable/);
});

test('production governance identity uses the native OS canonical resolver', async t => {
  const { realpathSync } = await import('node:fs');
  const { sameGovernancePath } = await import('./gitGovernance.js');
  const root = mkdtempSync(join(tmpdir(), 'babel-native-identity-'));
  try {
    const native = realpathSync.native;
    let calls = 0;
    t.mock.method(realpathSync, 'native', (path: string) => { calls++; return native(path); });
    assert.equal(sameGovernancePath(root, root), true);
    assert.equal(calls, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows mutation aliases preserve missing protected children and reject cross-drive substitution', async () => {
  const { isProtectedGovernanceAlias } = await import('./gitGovernance.js');
  const short = 'C:\\fixture\\LONGPA~1\\Temp';
  const long = 'C:\\fixture\\LongPathDirectory\\Temp';
  const missing = new Set([`${short}\\main\\.git\\hooks\\new-hook`, `${short}\\linked\\new-source.ts`]);
  const fs = {
    lstatSync: (path: string) => { if (missing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isDirectory: () => true, isSymbolicLink: () => false }; },
    realpathSync: (path: string) => path.replace('LONGPA~1', 'LongPathDirectory'),
  };
  const entries = [{ path: `${long}\\main\\.git\\hooks` }];
  assert.equal(isProtectedGovernanceAlias(`${short}\\linked`, `${short}\\linked`, `${short}\\main\\.git\\hooks\\new-hook`, entries, fs, 'win32'), true);
  assert.equal(isProtectedGovernanceAlias(`${short}\\linked`, `${short}\\linked`, 'new-source.ts', entries, fs, 'win32'), false);
  assert.equal(isProtectedGovernanceAlias(`${short}\\linked`, `${short}\\linked`, `D:${short.slice(2)}\\main\\.git\\hooks\\new-hook`, entries, fs, 'win32'), false);
});
