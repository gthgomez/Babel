/**
 * TF-25 — the governed adoption path is reachable from the real CLI.
 *
 * The library regression tests cover the conflict matrix. This exercises the
 * operator/parent entry point (`babel worktree adopt`) against a real Git
 * worktree and asserts both the adopted bytes and the fail-closed exit code.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(cliRoot, 'src', 'index.ts');
const profile = mkdtempSync(join(tmpdir(), 'babel-adopt-cli-profile-'));
mkdirSync(join(profile, 'config'));
const env = {
  PATH: process.env['PATH'],
  SystemRoot: process.env['SystemRoot'],
  CI: '1',
  BABEL_CONFIG_DIR: join(profile, 'config'),
  BABEL_STATE_DIR: profile,
  BABEL_CACHE_DIR: join(profile, 'cache'),
  BABEL_RUNS_DIR: join(profile, 'runs'),
};
const roots: string[] = [];

test.after(() => {
  rmSync(profile, { recursive: true, force: true });
  for (const root of roots.splice(0)) {
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', pathToFileURL(join(cliRoot, 'scripts/block_consumer_network.mjs')).href, entry, ...args],
    { cwd: cliRoot, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fixture(): { root: string; manifest: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'babel-adopt-cli-'));
  roots.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'babel-test@example.com']);
  git(root, ['config', 'user.name', 'Babel Test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  const worktree = join(root, '.babel', 'worktrees', 'impl-cli');
  git(root, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  writeFileSync(join(worktree, 'src', 'a.txt'), 'child\n');
  const sha = git(root, ['rev-parse', 'HEAD']);
  const manifest = join(root, 'child-adoption-manifest.json');
  writeFileSync(manifest, JSON.stringify({
    schema_version: 1,
    artifact_type: 'babel_child_adoption_manifest',
    created_at: new Date().toISOString(),
    agent_id: 'cli-test',
    worktree_name: 'impl-cli',
    worktree_path: worktree,
    base_sha: sha,
    write_scope: ['src'],
    changed_files: [{
      path: 'src/a.txt',
      before_hash: createHash('sha256').update('base\n').digest('hex'),
      after_hash: createHash('sha256').update('child\n').digest('hex'),
    }],
  }));
  return { root, manifest, worktree };
}

test('babel worktree adopt applies a recorded child change after parent verification', () => {
  const { root, manifest } = fixture();
  writeFileSync(
    join(root, 'verify-adoption.mjs'),
    "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('src/a.txt', 'utf8') === 'child\\n' ? 0 : 1);\n",
  );
  const result = runCli([
    'worktree', 'adopt', 'impl-cli',
    '--manifest', manifest,
    '--project-root', root,
    '--apply',
    '--verify', 'node verify-adoption.mjs',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { status: string; adoptedPaths: string[]; verification: { ok: boolean } };
  assert.equal(payload.status, 'adopted');
  assert.deepEqual(payload.adoptedPaths, ['src/a.txt']);
  assert.equal(payload.verification.ok, true);
  assert.equal(readFileSync(join(root, 'src', 'a.txt'), 'utf-8'), 'child\n');
});

test('babel worktree adopt refuses a stale child and leaves parent bytes alone', () => {
  const { root, manifest } = fixture();
  writeFileSync(join(root, 'src', 'a.txt'), 'parent edited\n');

  const result = runCli([
    'worktree', 'adopt', 'impl-cli',
    '--manifest', manifest,
    '--project-root', root,
    '--apply',
  ]);

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout) as { status: string; conflicts: Array<{ code: string }> };
  assert.equal(payload.status, 'refused');
  assert.ok(payload.conflicts.some((conflict) => conflict.code === 'parent_preimage_conflict'));
  assert.equal(readFileSync(join(root, 'src', 'a.txt'), 'utf-8'), 'parent edited\n');
});
