import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runCiReview } from './ciReview.js';
import { buildGitEnv, getGitCommand } from '../utils/gitExec.js';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-ci-review-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Babel Test']);
  writeFileSync(join(root, 'README.md'), '# Test\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('runCiReview writes deterministic evidence and flags source changes without tests', () => {
  const root = initRepo();
  const outputDir = join(root, '.babel-ci-review');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Test\n\nEdited.\n', 'utf8');
  writeFileSync(join(root, 'src', 'feature.ts'), 'export const value = 1;\n', 'utf8');

  const report = runCiReview({
    projectRoot: root,
    outputDir,
    now: new Date('2026-04-24T12:00:00.000Z'),
  });

  assert.equal(report.schema_version, 1);
  assert.equal(report.review_type, 'babel_ci_review');
  assert.equal(report.status, 'warn');
  assert.equal(report.delivery_policy.read_only, true);
  assert.equal(report.delivery_policy.remote_side_effects, false);
  assert.equal(report.summary.changed_file_count, 2);
  assert.equal(
    report.changed_files.some(
      (file) => file.path === 'README.md' && file.sources.includes('unstaged'),
    ),
    true,
  );
  assert.equal(
    report.changed_files.some(
      (file) => file.path === 'src/feature.ts' && file.sources.includes('untracked'),
    ),
    true,
  );
  assert.equal(report.test_signals[0]?.code, 'source_without_test_change');
  assert.match(report.artifact_path, /ci-review-20260424T120000Z\.json$/);
});

test('runCiReview flags workflow and secret-like file changes', () => {
  const root = initRepo();
  const outputDir = join(root, '.babel-ci-review');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
  writeFileSync(join(root, '.env.production'), 'TOKEN=secret\n', 'utf8');

  const report = runCiReview({
    projectRoot: root,
    outputDir,
    now: new Date('2026-04-24T12:00:00.000Z'),
  });

  assert.equal(report.summary.high_risk_count, 2);
  assert.deepEqual(report.risks.map((risk) => risk.code).sort(), [
    'ci_workflow_changed',
    'secret_candidate_changed',
  ]);
});

test('git helper preserves Windows path casing and honors explicit git path', () => {
  const env = buildGitEnv({
    Path: 'C:\\Tools\\Git\\cmd',
    BABEL_GIT_PATH: 'C:\\Custom\\git.exe',
  });

  assert.equal(env['PATH'], 'C:\\Tools\\Git\\cmd');
  assert.equal(env['Path'], 'C:\\Tools\\Git\\cmd');
  assert.equal(getGitCommand(env), 'C:\\Custom\\git.exe');
});
