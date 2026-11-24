/** RT-09 — workspace change snapshots must not advertise changes with no diff. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildReadOnlyGitArgs,
  buildReadOnlyGitEnvironment,
  collectWorkspaceChanges,
} from './workspaceChanges.js';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

test('read-only Git invocation clears inherited helper controls and disables execution features', () => {
  const emptyConfig = join(tmpdir(), 'fixture-empty-gitconfig');
  const env = buildReadOnlyGitEnvironment(
    {
      PATH: '/usr/bin',
      GIT_CONFIG_GLOBAL: '/fixture/untrusted.gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/fixture/fsmonitor',
      GIT_EXTERNAL_DIFF: '/fixture/external-diff',
      ANTHROPIC_API_KEY: 'synthetic-secret',
      LANG: 'C.UTF-8',
    },
    emptyConfig,
  );
  const args = buildReadOnlyGitArgs(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', '.']);

  assert.equal(env['GIT_CONFIG_GLOBAL'], emptyConfig);
  assert.equal(env['GIT_CONFIG_NOSYSTEM'], '1');
  assert.equal(env['GIT_EXTERNAL_DIFF'], undefined);
  assert.equal(env['GIT_CONFIG_COUNT'], undefined);
  assert.equal(env['GIT_CONFIG_KEY_0'], undefined);
  assert.equal(env['ANTHROPIC_API_KEY'], undefined);
  assert.equal(env['PATH'], '/usr/bin');
  assert.equal(env['LANG'], 'C.UTF-8');
  assert.equal(args.includes('core.fsmonitor=false'), true);
  assert.equal(args.includes('diff.external='), true);
  assert.equal(args.includes('--no-ext-diff'), true);
  assert.equal(args.includes('--no-textconv'), true);
});

test('repository clean/process/smudge filters fail closed before status or diff', { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-git-filter-'));
  try {
    git(root, ['init', '--quiet']);
    writeFileSync(join(root, 'tracked.txt'), 'fixture\n');
    git(root, ['add', '.']);
    git(root, ['config', 'filter.fixture.process', '/fixture/unsafe-helper']);

    const snapshot = collectWorkspaceChanges(root);

    assert.equal(snapshot.available, false);
    assert.deepEqual(snapshot.files, []);
    assert.equal(snapshot.diff, '');
    assert.match(snapshot.reason ?? '', /filter configuration is unsupported/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
}

test('RT-09: staged and untracked changes are present in the returned diff', { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-changes-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'tracked.txt'), 'tracked v1\n');
    writeFileSync(join(root, 'staged.txt'), 'staged v1\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'initial']);

    writeFileSync(join(root, 'tracked.txt'), 'tracked v2 unstaged\n');
    writeFileSync(join(root, 'staged.txt'), 'staged v2 staged\n');
    git(root, ['add', 'staged.txt']);
    writeFileSync(join(root, 'untracked.txt'), 'new untracked file\n');

    const snapshot = collectWorkspaceChanges(root);
    assert.equal(snapshot.available, true);
    assert.deepEqual(
      snapshot.files.map((file) => file.path).sort(),
      ['staged.txt', 'tracked.txt', 'untracked.txt'],
    );
    assert.match(snapshot.diff, /staged v2 staged/);
    assert.match(snapshot.diff, /tracked v2 unstaged/);
    assert.match(snapshot.diff, /# Untracked file: "untracked\.txt"/);
    assert.match(snapshot.diff, /new untracked file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('external diff, textconv, and fsmonitor helpers do not execute', {
  skip: !gitAvailable || process.platform === 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-git-helper-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'tracked.txt'), 'before\n');
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=fixture\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'initial']);
    writeFileSync(join(root, 'tracked.txt'), 'after\n');

    const helper = (name: string) => {
      const marker = join(root, `${name}.executed`);
      const script = join(root, `${name}.sh`);
      writeFileSync(script, `#!/bin/sh\nprintf x >> '${marker}'\n`);
      chmodSync(script, 0o700);
      return { marker, script };
    };
    const external = helper('external-diff');
    const textconv = helper('textconv');
    const fsmonitor = helper('fsmonitor');
    git(root, ['config', 'diff.external', external.script]);
    git(root, ['config', 'diff.fixture.textconv', textconv.script]);
    git(root, ['config', 'core.fsmonitor', fsmonitor.script]);

    const snapshot = collectWorkspaceChanges(root);

    assert.equal(snapshot.available, true);
    assert.deepEqual(
      [external.marker, textconv.marker, fsmonitor.marker].map((path) => existsSync(path)),
      [false, false, false],
      'Git helpers configured by the project must remain inert during read-only inspection',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace inspection fails closed when diff output exceeds its byte budget', { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-large-diff-'));
  try {
    git(root, ['init', '--quiet']);
    writeFileSync(join(root, 'large-untracked.txt'), `${'x'.repeat(1_050_000)}\n`);

    const snapshot = collectWorkspaceChanges(root);

    assert.equal(snapshot.available, false);
    assert.equal(snapshot.diff, '');
    assert.deepEqual(snapshot.files, []);
    assert.match(snapshot.reason ?? '', /output limit|buffer|ENOBUFS/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace inspection refuses a file list larger than its count budget', { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-many-files-'));
  try {
    git(root, ['init', '--quiet']);
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(join(root, `untracked-${index}.txt`), 'fixture\n');
    }

    const snapshot = collectWorkspaceChanges(root);

    assert.equal(snapshot.available, false);
    assert.equal(snapshot.diff, '');
    assert.deepEqual(snapshot.files, []);
    assert.match(snapshot.reason ?? '', /file limit/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RT-09 positive control: a clean workspace reports no files and no diff', { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-clean-'));
  try {
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'tracked.txt'), 'tracked\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'initial']);

    const snapshot = collectWorkspaceChanges(root);
    assert.equal(snapshot.available, true);
    assert.deepEqual(snapshot.files, []);
    assert.equal(snapshot.diff, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RT-09: a non-repository path is explicitly unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-norepo-'));
  try {
    const snapshot = collectWorkspaceChanges(root);
    assert.equal(snapshot.available, false);
    assert.ok(snapshot.reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
