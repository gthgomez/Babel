import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyResolvedCommand, isResolvedCommandCurrent, resolveCommandExecutable } from './commandResolver.js';

test('PATH shadow is resolved and classified as project code without executing it', () => {
  const resolution = resolveCommandExecutable('git', {
    platform: 'linux',
    cwd: '/workspace/repo',
    env: { PATH: '/tmp/shadow:/usr/bin' },
    trustedRoots: ['/usr/bin'],
    isFile: (path) => path === '/tmp/shadow/git' || path === '/usr/bin/git',
    realpath: (path) => path,
  });

  assert.equal(resolution?.path, '/tmp/shadow/git');
  assert.equal(resolution?.trusted, false);
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'project_code');
});

test('trusted resolved Git keeps its ordinary command policy', () => {
  const resolution = resolveCommandExecutable('git', {
    platform: 'linux',
    cwd: '/workspace/repo',
    env: { PATH: '/usr/bin' },
    trustedRoots: ['/usr/bin'],
    isFile: (path) => path === '/usr/bin/git',
    realpath: (path) => path,
    fileIdentity: () => 'file-v1',
    isWritableByCurrentUser: () => false,
  });

  assert.equal(resolution?.path, '/usr/bin/git');
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'intrinsic');
  assert.equal(isResolvedCommandCurrent(resolution!, { realpath: (path) => path, fileIdentity: () => 'file-v2' }), false);
});

test('common protected absolute system paths keep trusted command policy', () => {
  const resolution = resolveCommandExecutable('/usr/local/bin/git', {
    platform: 'linux',
    cwd: '/workspace/repo',
    env: { PATH: '/usr/local/bin' },
    isFile: (path) => path === '/usr/local/bin/git',
    realpath: (path) => path,
    fileIdentity: () => 'system-git-v1',
    isWritableByCurrentUser: () => false,
  });
  assert.equal(resolution?.trusted, true);
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'intrinsic');
});

test('common system-tool roots are untrusted when a parent in the resolved path chain is writable', () => {
  const resolution = resolveCommandExecutable('git', {
    platform: 'linux', cwd: '/workspace/repo', env: { PATH: '/usr/local/bin' },
    isFile: (path) => path === '/usr/local/bin/git', realpath: (path) => path,
    fileIdentity: () => 'user-writable-git',
    isWritableByCurrentUser: (path) => path === '/usr/local/bin',
  });
  assert.equal(resolution?.trusted, false);
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'project_code');
});

test('user-owned executable paths are untrusted even when current mode bits are read-only', {
  skip: process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-owned-tool-'));
  const executable = join(root, 'git');
  writeFileSync(executable, 'fixture', { mode: 0o555 });
  chmodSync(root, 0o555);
  chmodSync(executable, 0o555);
  try {
    const resolution = resolveCommandExecutable('git', {
      platform: process.platform,
      cwd: process.cwd(),
      env: { PATH: root },
      trustedRoots: [root],
      isWritableByCurrentUser: () => false,
    });
    assert.equal(resolution?.trusted, false);
    assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'project_code');
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical targets outside a trusted system root remain untrusted', () => {
  const resolution = resolveCommandExecutable('/usr/local/bin/git', {
    platform: 'linux', cwd: '/workspace/repo', env: { PATH: '/usr/local/bin' },
    isFile: (path) => path === '/usr/local/bin/git',
    realpath: (path) => path === '/usr/local/bin/git' ? '/tmp/git-target' : path,
    fileIdentity: () => 'external-symlink-target', isWritableByCurrentUser: () => false,
  });
  assert.equal(resolution?.path, '/tmp/git-target');
  assert.equal(resolution?.trusted, false);
});

test('a sibling executable beside a custom Node runtime is not trusted by directory', () => {
  const sibling = '/opt/custom-node/bin/git';
  const resolution = resolveCommandExecutable('git', {
    platform: 'linux',
    cwd: '/workspace/repo',
    env: { PATH: '/opt/custom-node/bin' },
    isFile: (path) => path === sibling,
    realpath: (path) => path,
    fileIdentity: () => 'sibling-v1',
  });
  assert.equal(resolution?.path, sibling);
  assert.equal(resolution?.trusted, false);
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'project_code');
});

test('the active Node executable is trusted exactly by canonical identity', () => {
  const canonicalNode = realpathSync(process.execPath);
  const resolution = resolveCommandExecutable(process.execPath, {
    platform: process.platform,
    cwd: process.cwd(),
    env: { PATH: '' },
    isFile: (path) => path === process.execPath,
    realpath: () => canonicalNode,
    fileIdentity: () => 'active-node-runtime',
    isWritableByCurrentUser: () => false,
  });
  assert.equal(resolution?.path, canonicalNode);
  assert.equal(resolution?.trusted, true);
});

test('the active Node executable is not trusted if its canonical path chain is writable', () => {
  const canonicalNode = realpathSync(process.execPath);
  const resolution = resolveCommandExecutable(process.execPath, {
    platform: process.platform,
    cwd: process.cwd(),
    env: { PATH: '' },
    isFile: (path) => path === process.execPath,
    realpath: () => canonicalNode,
    fileIdentity: () => 'active-node-runtime',
    isWritableByCurrentUser: () => true,
  });
  assert.equal(resolution?.trusted, false);
});

test('Windows resolution checks cwd before PATH and honors PATHEXT', () => {
  const resolution = resolveCommandExecutable('where', {
    platform: 'win32',
    cwd: 'C:\\repo',
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE;.CMD' },
    trustedRoots: ['C:\\Windows\\System32'],
    isFile: (path) => path.toLowerCase() === 'c:\\repo\\where.exe',
    realpath: (path) => path,
  });

  assert.equal(resolution?.path.toLowerCase(), 'c:\\repo\\where.exe');
  assert.equal(resolution?.trusted, false);
});

test('Windows trusted system tools are rejected when a canonical ancestor is writable', () => {
  const resolution = resolveCommandExecutable('where', {
    platform: 'win32',
    cwd: 'C:\\repo',
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE' },
    trustedRoots: ['C:\\Windows\\System32'],
    isFile: (path) => path.toLowerCase() === 'c:\\windows\\system32\\where.exe',
    realpath: (path) => path,
    isWritableByCurrentUser: (path) => path.toLowerCase() === 'c:\\windows\\system32',
  });
  assert.equal(resolution?.trusted, false);
});

test('unresolved executables fail closed', () => {
  assert.equal(resolveCommandExecutable('missing-command', {
    platform: 'linux', cwd: '/workspace/repo', env: { PATH: '/usr/bin' },
    trustedRoots: ['/usr/bin'], isFile: () => false, realpath: (path) => path,
  }), null);
});
