import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createGitBranch, createGitCommit, createGitPullRequest } from './gitMutations.js';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-git-mutations-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Babel Test']);
  writeFileSync(join(root, 'README.md'), '# Test\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('createGitBranch creates a local branch and writes evidence', () => {
  const root = initRepo();
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-git-mutations-out-'));
  const headBefore = git(root, ['rev-parse', '--short', 'HEAD']);

  const report = createGitBranch({
    projectRoot: root,
    outputDir,
    branchName: 'codex/test-branch',
    now: new Date('2026-04-24T12:00:00.000Z'),
  });

  assert.equal(report.action.status, 'applied');
  assert.equal(report.branch?.name, 'codex/test-branch');
  assert.equal(git(root, ['rev-parse', '--short', 'codex/test-branch']), headBefore);
  assert.equal(git(root, ['branch', '--show-current']), 'master');
  assert.equal(existsSync(report.artifact_path), true);
  assert.match(readFileSync(report.artifact_path, 'utf8'), /codex\/test-branch/);
});

test('createGitCommit commits explicitly staged changes only by default', () => {
  const root = initRepo();
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-git-mutations-out-'));
  writeFileSync(join(root, 'README.md'), '# Test\n\nEdited.\n', 'utf8');
  git(root, ['add', 'README.md']);

  const report = createGitCommit({
    projectRoot: root,
    outputDir,
    message: 'docs: update readme',
    now: new Date('2026-04-24T12:00:00.000Z'),
  });

  assert.equal(report.action.status, 'applied');
  assert.equal(report.commit?.message, 'docs: update readme');
  assert.equal(git(root, ['log', '--format=%s', '-1']), 'docs: update readme');
  assert.equal(git(root, ['status', '--porcelain=v1', '-uall']), '');
});

test('createGitCommit can explicitly stage tracked changes', () => {
  const root = initRepo();
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-git-mutations-out-'));
  writeFileSync(join(root, 'README.md'), '# Test\n\nEdited.\n', 'utf8');

  const report = createGitCommit({
    projectRoot: root,
    outputDir,
    message: 'docs: stage tracked changes',
    stageMode: 'tracked',
    now: new Date('2026-04-24T12:00:00.000Z'),
  });

  assert.equal(report.action.status, 'applied');
  assert.equal(git(root, ['log', '--format=%s', '-1']), 'docs: stage tracked changes');
});

test('createGitPullRequest is planned unless remote side effects are explicitly allowed', () => {
  const root = initRepo();
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-git-mutations-out-'));

  const report = createGitPullRequest({
    projectRoot: root,
    outputDir,
    title: 'Test PR',
    body: 'Body',
    now: new Date('2026-04-24T12:00:00.000Z'),
  });

  assert.equal(report.action.status, 'planned');
  assert.equal(report.policy.remote_side_effect_allowed, false);
  assert.equal(report.pull_request?.url, null);
  assert.deepEqual(report.action.command.slice(0, 3), ['gh', 'pr', 'create']);
});
