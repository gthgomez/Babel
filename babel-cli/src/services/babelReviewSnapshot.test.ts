import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectBabelReviewSnapshot, safeReviewPath, secretRiskReviewPath } from './babelReviewSnapshot.js';
test('review snapshot rejects traversal and credentials while permitting public templates', () => {
  for (const value of ['../x', 'a/../x', '/x', 'C:/x', 'a\\b', 'a//b']) assert.equal(safeReviewPath(value), false);
  for (const value of ['.env', 'nested/.env.local', 'auth.json', 'key.pem', '.npmrc']) assert.equal(secretRiskReviewPath(value), true);
  assert.equal(secretRiskReviewPath('babel-cli/.env.example'), false);
  assert.equal(safeReviewPath('src/add.ts'), true);
});

test('review snapshot ignores local Git replacement refs when binding the exact diff', { skip: process.platform === 'win32' ? 'POSIX scanner stub' : false }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-snapshot-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const originalPath = process.env.PATH;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  try {
    mkdirSync(bin);
    const scanner = join(bin, process.platform === 'win32' ? 'gitleaks.cmd' : 'gitleaks');
    writeFileSync(scanner, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') chmodSync(scanner, 0o755);
    process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    execFileSync('git', ['init', '-q', repo]);
    git('config', 'user.name', 'Babel Test');
    git('config', 'user.email', 'babel-test@example.invalid');
    writeFileSync(join(repo, 'change.txt'), 'before\n');
    git('add', 'change.txt');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'change.txt'), 'after\n');
    git('commit', '-qam', 'head');
    const head = git('rev-parse', 'HEAD');
    git('replace', base, head);
    const snapshot = collectBabelReviewSnapshot({ repoRoot: repo, base, head, state: join(root, 'state'), task: 'Inspect exact diff' });
    assert.deepEqual(snapshot.scope, ['change.txt']);
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});
