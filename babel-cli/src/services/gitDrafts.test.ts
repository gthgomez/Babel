import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runGitDraft } from './gitDrafts.js';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-git-drafts-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Babel Test']);
  writeFileSync(join(root, 'README.md'), '# Test\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('runGitDraft writes diff summary evidence without mutating git state', () => {
  const root = initRepo();
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-git-drafts-out-'));
  const beforeHead = git(root, ['rev-parse', '--short', 'HEAD']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'feature.ts'), 'export const value = 1;\n', 'utf8');

  const report = runGitDraft('diff_summary', {
    projectRoot: root,
    outputDir,
    now: new Date('2026-04-24T12:00:00.000Z'),
  });

  assert.equal(report.draft_type, 'diff_summary');
  assert.equal(report.delivery_policy.read_only, true);
  assert.equal(report.delivery_policy.mutates_git, false);
  assert.equal(report.summary.changed_file_count, 1);
  assert.equal(report.changed_files[0]?.path, 'src/feature.ts');
  assert.equal(report.changed_files[0]?.sources.includes('untracked'), true);
  assert.equal(report.commit_draft, null);
  assert.match(report.artifact_path, /git-diff-summary-20260424T120000Z\.json$/);
  assert.equal(git(root, ['rev-parse', '--short', 'HEAD']), beforeHead);
  assert.match(git(root, ['status', '--porcelain=v1', '-uall']), /\?\? src\/feature\.ts/);
});

test('runGitDraft produces commit and PR draft metadata only', () => {
  const root = initRepo();
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-git-drafts-out-'));
  writeFileSync(join(root, 'README.md'), '# Test\n\nEdited.\n', 'utf8');

  const commit = runGitDraft('commit_draft', {
    projectRoot: root,
    outputDir,
    now: new Date('2026-04-24T12:00:00.000Z'),
  });
  const pr = runGitDraft('pr_draft', {
    projectRoot: root,
    outputDir,
    now: new Date('2026-04-24T12:00:01.000Z'),
  });

  assert.equal(commit.commit_draft?.subject, 'docs(README.md): draft 1 file change');
  assert.equal(commit.delivery_policy.draft_first, true);
  assert.equal(commit.pr_draft, null);
  assert.equal(
    pr.pr_draft?.review_notes.some((note) =>
      note.includes('no commit, push, branch, or PR side effect'),
    ),
    true,
  );
  assert.equal(git(root, ['log', '--oneline']).split(/\r?\n/).length, 1);
});
