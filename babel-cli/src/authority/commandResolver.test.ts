import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyResolvedCommand, commandControlledRoots, isCanonicalWindowsSystemShell, isResolvedCommandCurrent, resolveCommandExecutable } from './commandResolver.js';

test('controlled roots include configured repository and shadow paths only', () => {
  assert.deepEqual(commandControlledRoots('/workspace/repo', '/tmp/shadow'), ['/workspace/repo', '/tmp/shadow']);
  assert.deepEqual(commandControlledRoots('/workspace/repo'), ['/workspace/repo']);
  assert.deepEqual(commandControlledRoots(undefined, '/tmp/shadow'), ['/tmp/shadow']);
  assert.deepEqual(commandControlledRoots(), []);
});

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
    isOwnedByCurrentUser: () => false,
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

test('privileged runtimes may trust a root-owned system tool with a protected path chain', () => {
  const resolution = resolveCommandExecutable('/usr/bin/git', {
    platform: 'linux', cwd: '/workspace/repo', env: { PATH: '/usr/bin' },
    trustedRoots: ['/usr/bin'], effectiveUid: 0,
    isFile: (path) => path === '/usr/bin/git', realpath: (path) => path,
    fileIdentity: () => 'root-system-git-v1',
    isWritableByCurrentUser: () => true,
    isWritableByOtherPrincipal: () => false,
    ownerUid: () => 0,
  });
  assert.equal(resolution?.trusted, true);
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'intrinsic');
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
    isOwnedByCurrentUser: () => false,
  });
  assert.equal(resolution?.path, canonicalNode);
  assert.equal(resolution?.trusted, true);
});

test('a host-selected active Node runtime stays project code even when its identity is pinned', () => {
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
  if (process.platform === 'win32') {
    assert.equal(resolution?.trusted, true, 'captured host PATH identity may pin the active runtime without DACL proof');
    assert.equal(classifyResolvedCommand(resolution!, ['-e', 'process.exit(0)']).executionRisk, 'project_code');
  } else {
    assert.equal(resolution?.trusted, false, 'POSIX current-user writable path remains untrusted');
  }
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

test('Windows resolution reads PATH and PATHEXT case-insensitively from child environments', () => {
  const resolution = resolveCommandExecutable('node', {
    platform: 'win32',
    cwd: 'C:\\repo',
    env: { Path: 'C:\\hostedtoolcache\\node', PathExt: '.EXE' },
    trustedRoots: ['C:\\Program Files\\NodeJS'],
    isFile: (path) => path.toLowerCase() === 'c:\\hostedtoolcache\\node\\node.exe',
    realpath: (path) => path,
    isWritableByCurrentUser: () => true,
  });

  assert.equal(resolution?.path.toLowerCase(), 'c:\\hostedtoolcache\\node\\node.exe');
  assert.equal(resolution?.trusted, false);
  assert.equal(classifyResolvedCommand(resolution!, ['--version']).reason, 'untrusted_executable_identity');
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

test('host PATH can select a user-installed Git tool without making arbitrary paths trusted', () => {
  const resolution = resolveCommandExecutable('git', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/opt/external-tools/bin:/usr/bin' },
    hostPath: '/opt/external-tools/bin:/usr/bin',
    controlledRoots: ['/workspace/repo', '/tmp/babel-shadow'],
    isFile: (path) => path === '/opt/external-tools/bin/git',
    realpath: (path) => path,
    fileIdentity: () => 'operator-installed-git-v1',
    isWritableByCurrentUser: () => true,
    isWritableByOtherPrincipal: () => false,
    effectiveUid: 1000,
    ownerUid: () => 1000,
  });
  assert.equal(resolution?.trusted, true);
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'intrinsic');

  const ripgrep = resolveCommandExecutable('rg', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/opt/external-tools/bin' }, hostPath: '/opt/external-tools/bin',
    controlledRoots: ['/workspace/repo', '/tmp/babel-shadow'],
    isFile: (path) => path === '/opt/external-tools/bin/rg',
    realpath: (path) => path,
    fileIdentity: () => 'operator-installed-rg-v1',
    isWritableByOtherPrincipal: () => false,
    effectiveUid: 1000,
    ownerUid: () => 1000,
  });
  assert.equal(ripgrep?.trusted, true);
  assert.equal(classifyResolvedCommand(ripgrep!, ['--version']).executionRisk, 'intrinsic');

  const explicitLookalike = resolveCommandExecutable('/opt/attacker/bin/git', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/opt/external-tools/bin' },
    hostPath: '/opt/external-tools/bin',
    isFile: (path) => path === '/opt/attacker/bin/git',
    realpath: (path) => path,
    fileIdentity: () => 'arbitrary-external-git',
    isWritableByCurrentUser: () => false,
    isOwnedByCurrentUser: () => false,
  });
  assert.equal(explicitLookalike?.trusted, false);
});

test('host PATH identity never makes a project lookalike or symlink target trusted', () => {
  const projectTool = resolveCommandExecutable('rg', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/workspace/repo/.tools:/usr/bin' },
    hostPath: '/workspace/repo/.tools:/usr/bin',
    controlledRoots: ['/workspace/repo'],
    isFile: (path) => path === '/workspace/repo/.tools/rg',
    realpath: (path) => path,
    fileIdentity: () => 'project-rg-v1',
  });
  assert.equal(projectTool?.trusted, false);

  const shadowTool = resolveCommandExecutable('git', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/tmp/babel-shadow/bin' }, hostPath: '/tmp/babel-shadow/bin',
    controlledRoots: ['/workspace/repo', '/tmp/babel-shadow'],
    isFile: (path) => path === '/tmp/babel-shadow/bin/git',
    realpath: (path) => path,
    fileIdentity: () => 'shadow-git-v1',
  });
  assert.equal(shadowTool?.trusted, false);

  const symlinkedTool = resolveCommandExecutable('rg', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/opt/external-tools/bin' }, hostPath: '/opt/external-tools/bin',
    controlledRoots: ['/workspace/repo'],
    isFile: (path) => path === '/opt/external-tools/bin/rg',
    realpath: (path) => path === '/opt/external-tools/bin/rg' ? '/workspace/repo/.tools/rg' : path,
    fileIdentity: () => 'project-rg-via-link',
  });
  assert.equal(symlinkedTool?.path, '/workspace/repo/.tools/rg');
  assert.equal(symlinkedTool?.trusted, false);

  const projectSymlinkToHostTool = resolveCommandExecutable('git', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/workspace/repo/.tools' }, hostPath: '/opt/host/bin',
    controlledRoots: ['/workspace/repo'], effectiveUid: 1000,
    isFile: (path) => path === '/workspace/repo/.tools/git' || path === '/opt/host/bin/git',
    realpath: (path) => path === '/workspace/repo/.tools/git' ? '/opt/host/bin/git' : path,
    fileIdentity: () => 'project-symlink-to-host-git',
    isWritableByCurrentUser: () => false,
    isWritableByOtherPrincipal: () => false,
    ownerUid: () => 1000,
  });
  assert.equal(projectSymlinkToHostTool?.path, '/opt/host/bin/git');
  assert.equal(projectSymlinkToHostTool?.trusted, false, 'the searched path remains controlled despite its host target');
});

test('custom Node identity stays project code even when resolved through host PATH', () => {
  const resolution = resolveCommandExecutable('node', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/opt/external-tools/bin' }, hostPath: '/opt/external-tools/bin',
    controlledRoots: ['/workspace/repo'],
    isFile: (path) => path === '/opt/external-tools/bin/node',
    realpath: (path) => path,
    fileIdentity: () => 'custom-node-v1',
    isWritableByOtherPrincipal: () => false,
    effectiveUid: 1000,
    ownerUid: () => 1000,
  });
  assert.equal(resolution?.trusted, true);
  assert.equal(classifyResolvedCommand(resolution!, ['script.js']).executionRisk, 'project_code');
});

test('host PATH identity is rejected when an external path chain is group or world writable', () => {
  const resolution = resolveCommandExecutable('git', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/tmp/shared-tools/bin' }, hostPath: '/tmp/shared-tools/bin',
    controlledRoots: ['/workspace/repo'],
    isFile: (path) => path === '/tmp/shared-tools/bin/git',
    realpath: (path) => path,
    fileIdentity: () => 'shared-path-git-v1',
    isWritableByCurrentUser: () => true,
    isWritableByOtherPrincipal: (path) => path === '/tmp/shared-tools' || path === '/tmp/shared-tools/bin',
    effectiveUid: 1000,
    ownerUid: () => 1000,
  });
  assert.equal(resolution?.trusted, false);
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'project_code');
});

test('privileged host PATH trust requires runtime or designated host ownership through the path chain', () => {
  const trustedInstall = resolveCommandExecutable('git', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/opt/external-tools/bin' }, hostPath: '/opt/external-tools/bin',
    hostPathOwnerUid: 1000,
    isFile: (path) => path === '/opt/external-tools/bin/git',
    realpath: (path) => path,
    fileIdentity: () => 'operator-owned-git-v1',
    isWritableByOtherPrincipal: () => false,
    effectiveUid: 0,
    ownerUid: (path) => path === '/' || path === '/opt' ? 0 : path.startsWith('/opt/external-tools') ? 1000 : undefined,
  });
  assert.equal(trustedInstall?.trusted, true);

  const otherUserInstall = resolveCommandExecutable('git', {
    platform: 'linux', cwd: '/workspace/repo',
    env: { PATH: '/opt/other-principal-tools/bin' }, hostPath: '/opt/other-principal-tools/bin',
    hostPathOwnerUid: 1000,
    isFile: (path) => path === '/opt/other-principal-tools/bin/git',
    realpath: (path) => path,
    fileIdentity: () => 'other-user-git-v1',
    isWritableByOtherPrincipal: () => false,
    effectiveUid: 0,
    ownerUid: (path) => path === '/' || path === '/opt' ? 0 : path.startsWith('/opt/other-principal-tools') ? 2000 : undefined,
  });
  assert.equal(otherUserInstall?.trusted, false);
});

test('Windows captured host PATH can identify known tools without trusting child-only paths', () => {
  const resolution = resolveCommandExecutable('git', {
    platform: 'win32', cwd: 'C:\\repo',
    env: { Path: 'c:\\toolchain\\shims', PathExt: '.EXE;.CMD' },
    hostPath: 'C:\\Toolchain\\shims',
    controlledRoots: ['C:\\repo'],
    isFile: (path) => path.toLowerCase() === 'c:\\toolchain\\shims\\git.exe',
    realpath: (path) => path,
    fileIdentity: () => 'windows-user-git-v1',
  });
  assert.equal(resolution?.trusted, true);
  assert.equal(classifyResolvedCommand(resolution!, ['status']).executionRisk, 'intrinsic');
  assert.equal(isResolvedCommandCurrent(resolution!, {
    platform: 'win32',
    realpath: (path) => path.toUpperCase(),
    fileIdentity: () => 'windows-user-git-v1',
  }), true, 'Windows canonical path aliases are compared without case sensitivity');
  const childOnly = resolveCommandExecutable('git', {
    platform: 'win32', cwd: 'C:\\repo',
    env: { Path: 'C:\\ProjectTools\\bin', PathExt: '.EXE' },
    hostPath: 'C:\\Toolchain\\shims', hostPathExt: '.EXE',
    controlledRoots: ['C:\\repo', 'C:\\ProjectTools'],
    isFile: (path) => path.toLowerCase() === 'c:\\projecttools\\bin\\git.exe',
    realpath: (path) => path,
    fileIdentity: () => 'windows-child-only-git-v1',
  });
  assert.equal(childOnly?.trusted, false);

  const node = resolveCommandExecutable('node', {
    platform: 'win32', cwd: 'C:\\repo',
    env: { Path: 'C:\\Toolchain\\node', PathExt: '.EXE' },
    hostPath: 'C:\\Toolchain\\node', hostPathExt: '.EXE',
    controlledRoots: ['C:\\repo'],
    isFile: (path) => path.toLowerCase() === 'c:\\toolchain\\node\\node.exe',
    realpath: (path) => path,
    fileIdentity: () => 'windows-user-node-v1',
  });
  assert.equal(node?.trusted, true, 'startup-captured host PATH may identify the selected runtime');
  assert.equal(classifyResolvedCommand(node!, ['-e', 'process.exit(0)']).executionRisk, 'project_code',
    'runtime identity does not make Node scripts intrinsic');

  const programFilesGit = resolveCommandExecutable('git', {
    platform: 'win32', cwd: 'C:\\repo',
    env: { Path: 'C:\\Program Files\\Git\\cmd' },
    hostPath: 'C:\\Program Files\\Git\\cmd',
    trustedRoots: ['C:\\Program Files\\Git\\cmd'],
    controlledRoots: ['C:\\repo'],
    isFile: (path) => path.toLowerCase() === 'c:\\program files\\git\\cmd\\git.exe',
    realpath: (path) => path,
    fileIdentity: () => 'program-files-git-v1',
    isWritableByCurrentUser: () => true,
  });
  assert.equal(programFilesGit?.trusted, true,
    'the exact known tool selected by captured host PATH remains resolvable despite Windows W_OK reporting writable');
  assert.equal(classifyResolvedCommand(programFilesGit!, ['status']).executionRisk, 'intrinsic');
});

test('canonical System32 cmd identity stays trusted when W_OK reports writable', () => {
  assert.equal(isCanonicalWindowsSystemShell('c:\\windows\\system32\\CMD.EXE', 'C:\\Windows\\System32'), true);
  assert.equal(isCanonicalWindowsSystemShell('C:\\repo\\cmd.exe', 'C:\\Windows\\System32'), false);
  const resolution = resolveCommandExecutable('C:\\Windows\\System32\\cmd.exe', {
    platform: 'win32', cwd: 'C:\\repo', env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' },
    trustedRoots: ['C:\\Windows\\System32'], hostWindowsSystem32: 'C:\\Windows\\System32',
    isFile: (path) => path.toLowerCase() === 'c:\\windows\\system32\\cmd.exe',
    realpath: (path) => path,
    fileIdentity: () => 'system-cmd-v1',
    isWritableByCurrentUser: () => true,
  });
  assert.equal(resolution?.trusted, true);
  assert.equal(isResolvedCommandCurrent(resolution!, { realpath: (path) => path, fileIdentity: () => 'system-cmd-v2' }), false);
  const withoutIdentity = resolveCommandExecutable('C:\\Windows\\System32\\cmd.exe', {
    platform: 'win32', cwd: 'C:\\repo', env: { SystemRoot: 'C:\\Windows' },
    trustedRoots: ['C:\\Windows\\System32'], hostWindowsSystem32: 'C:\\Windows\\System32',
    isFile: (path) => path.toLowerCase() === 'c:\\windows\\system32\\cmd.exe',
    realpath: (path) => path,
    fileIdentity: () => undefined,
    isWritableByCurrentUser: () => true,
  });
  assert.equal(withoutIdentity?.trusted, false, 'System32 shell trust requires a pinned file identity');

  const controlledSystemRoot = resolveCommandExecutable('C:\\Task\\System32\\cmd.exe', {
    platform: 'win32', cwd: 'C:\\Task', env: { SystemRoot: 'C:\\Task' },
    trustedRoots: ['C:\\Task\\System32'], hostWindowsSystem32: 'C:\\Task\\System32',
    controlledRoots: ['C:\\Task'],
    isFile: (path) => path.toLowerCase() === 'c:\\task\\system32\\cmd.exe',
    realpath: (path) => path,
    fileIdentity: () => 'controlled-system-cmd-v1',
    isWritableByCurrentUser: () => false,
  });
  assert.equal(controlledSystemRoot?.trusted, false, 'captured SystemRoot under a task-controlled root is never accepted');
});

test('child SystemRoot and reparse targets cannot establish the host cmd identity', () => {
  const childSystemRoot = resolveCommandExecutable('C:\\Project\\System32\\cmd.exe', {
    platform: 'win32', cwd: 'C:\\repo', env: { SystemRoot: 'C:\\Project', Path: 'C:\\Project\\System32' },
    trustedRoots: ['C:\\Windows\\System32'], hostWindowsSystem32: 'C:\\Windows\\System32',
    controlledRoots: ['C:\\Project', 'C:\\repo'],
    isFile: (path) => path.toLowerCase() === 'c:\\project\\system32\\cmd.exe',
    realpath: (path) => path,
    fileIdentity: () => 'project-cmd-v1',
  });
  assert.equal(childSystemRoot?.trusted, false);

  const reparseTarget = resolveCommandExecutable('C:\\Windows\\System32\\cmd.exe', {
    platform: 'win32', cwd: 'C:\\repo', env: { SystemRoot: 'C:\\Windows' },
    trustedRoots: ['C:\\Windows\\System32'], hostWindowsSystem32: 'C:\\Windows\\System32',
    controlledRoots: ['C:\\repo'],
    isFile: (path) => path.toLowerCase() === 'c:\\windows\\system32\\cmd.exe',
    realpath: (path) => path.toLowerCase() === 'c:\\windows\\system32\\cmd.exe'
      ? 'C:\\repo\\cmd.exe'
      : path,
    fileIdentity: () => 'project-reparse-cmd-v1',
  });
  assert.equal(reparseTarget?.trusted, false);
});

test('Windows child PATHEXT changes cannot manufacture a trusted host PATH identity', () => {
  const resolution = resolveCommandExecutable('git', {
    platform: 'win32', cwd: 'C:\\repo',
    env: { Path: 'C:\\Toolchain\\bin', PathExt: '.CMD' },
    hostPath: 'C:\\Toolchain\\bin', hostPathExt: '.EXE',
    controlledRoots: ['C:\\repo'],
    isFile: (path) => path.toLowerCase() === 'c:\\toolchain\\bin\\git.cmd',
    realpath: (path) => path,
    fileIdentity: () => 'altered-pathext-git-v1',
  });
  assert.equal(resolution?.path.toLowerCase(), 'c:\\toolchain\\bin\\git.cmd');
  assert.equal(resolution?.trusted, false);
});

test('conflicting Windows PATH spellings resolve fail-closed', () => {
  const resolution = resolveCommandExecutable('git', {
    platform: 'win32', cwd: 'C:\\repo',
    env: { Path: 'C:\\Toolchain\\bin', PATH: 'C:\\repo\\.bin', PathExt: '.EXE' },
    hostPath: 'C:\\Toolchain\\bin', hostPathExt: '.EXE',
    controlledRoots: ['C:\\repo'],
    isFile: (path) => path.toLowerCase() === 'c:\\repo\\git.exe',
    realpath: (path) => path,
    fileIdentity: () => 'conflicting-path-git-v1',
  });
  assert.equal(resolution?.trusted, false);
});

test('unresolved executables fail closed', () => {
  assert.equal(resolveCommandExecutable('missing-command', {
    platform: 'linux', cwd: '/workspace/repo', env: { PATH: '/usr/bin' },
    trustedRoots: ['/usr/bin'], isFile: () => false, realpath: (path) => path,
  }), null);
});
