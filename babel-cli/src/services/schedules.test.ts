import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
} from './schedules.js';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-schedules-repo-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Babel Test']);
  writeFileSync(join(root, 'README.md'), '# Test\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('schedule registry create, list, run-now, and delete stay local and read-only', () => {
  const repo = initRepo();
  const stateRoot = mkdtempSync(join(tmpdir(), 'babel-schedules-state-'));
  const registryPath = join(stateRoot, 'registry.json');
  const runsRoot = join(stateRoot, 'runs');
  writeFileSync(join(repo, 'README.md'), '# Test\n\nEdited.\n', 'utf8');
  const beforeHead = git(repo, ['rev-parse', '--short', 'HEAD']);

  const schedule = createSchedule({
    id: 'daily-pr-draft',
    jobType: 'git_pr_draft',
    projectRoot: repo,
    registryPath,
    runsRoot,
    now: new Date('2026-04-24T12:00:00.000Z'),
  });
  assert.equal(schedule.id, 'daily-pr-draft');
  assert.equal(listSchedules({ registryPath, runsRoot }).schedules.length, 1);

  const record = runScheduleNow('daily-pr-draft', { registryPath, runsRoot });
  assert.equal(record.status, 'ok');
  assert.equal(record.job_type, 'git_pr_draft');
  assert.equal(record.result?.schema_version, 1);
  assert.equal(existsSync(record.artifact_path), true);
  assert.equal(existsSync(record.nested_artifact_path ?? ''), true);
  assert.equal(git(repo, ['rev-parse', '--short', 'HEAD']), beforeHead);
  assert.match(git(repo, ['status', '--porcelain=v1', '-uall']), /README.md/);

  const persisted = JSON.parse(readFileSync(record.artifact_path, 'utf8')) as { run_type?: string };
  assert.equal(persisted.run_type, 'schedule_run_now');
  assert.equal(deleteSchedule('daily-pr-draft', { registryPath, runsRoot }).deleted, true);
  assert.equal(listSchedules({ registryPath, runsRoot }).schedules.length, 0);
});

test('schedule creation rejects mutating or unknown job types', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'babel-schedules-state-'));
  assert.throws(() => createSchedule({
    id: 'bad',
    jobType: 'git_push' as never,
    registryPath: join(stateRoot, 'registry.json'),
  }), /Invalid schedule job type/);
});

test('mutating schedules require run-now opt-in and use an isolated project copy', () => {
  const repo = initRepo();
  const stateRoot = mkdtempSync(join(tmpdir(), 'babel-schedules-state-'));
  const registryPath = join(stateRoot, 'registry.json');
  const runsRoot = join(stateRoot, 'runs');
  const beforeHead = git(repo, ['rev-parse', '--short', 'HEAD']);

  createSchedule({
    id: 'branch-create',
    jobType: 'git_branch_create',
    branchName: 'codex/scheduled-branch',
    projectRoot: repo,
    registryPath,
    runsRoot,
  });

  const blocked = runScheduleNow('branch-create', { registryPath, runsRoot });
  assert.equal(blocked.status, 'fail');
  assert.match(blocked.error ?? '', /requires --allow-mutate/);
  assert.equal(git(repo, ['rev-parse', '--short', 'HEAD']), beforeHead);

  const applied = runScheduleNow('branch-create', { registryPath, runsRoot, allowMutate: true });
  assert.equal(applied.status, 'ok');
  assert.equal(applied.job_type, 'git_branch_create');
  assert.equal(applied.result?.schema_version, 1);
  assert.equal('mutation_type' in (applied.result ?? {}), true);
  assert.equal(git(repo, ['rev-parse', '--short', 'HEAD']), beforeHead);
  assert.throws(
    () => git(repo, ['rev-parse', '--verify', 'codex/scheduled-branch']),
    /fatal/i,
  );
  assert.equal(existsSync(applied.nested_artifact_path ?? ''), true);
});
