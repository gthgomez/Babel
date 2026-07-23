import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runShip, type ShipReport, type ShipVerification } from './ship.js';
import type { CiReviewChangedFile, CiReviewReport } from './ciReview.js';
import type { GitDraftReport } from './gitDrafts.js';
import type { GitMutationReport } from './gitMutations.js';
import type { GitCommandResult } from '../utils/gitExec.js';

function buildCiReview(
  overrides: {
    changedFiles?: CiReviewChangedFile[];
    risks?: CiReviewReport['risks'];
    testSignals?: CiReviewReport['test_signals'];
    changedSummary?: number;
    status?: CiReviewReport['status'];
  } = {},
): CiReviewReport {
  const changed = overrides.changedFiles ?? [];
  const risks = overrides.risks ?? [];
  const testSignals = overrides.testSignals ?? [];
  return {
    schema_version: 1,
    review_type: 'babel_ci_review',
    generated_at: '2026-06-04T12:00:00.000Z',
    artifact_path: 'ci-review.json',
    status:
      overrides.status ??
      (risks.length > 0 || testSignals.some((signal) => signal.severity !== 'info')
        ? 'warn'
        : 'pass'),
    project_root: '/repo',
    delivery_policy: {
      read_only: true,
      mutates_git: false,
      remote_side_effects: false,
      draft_first: true,
    },
    git: {
      repo_root: '/repo',
      branch: 'feature',
      head: '000001',
      base_ref: null,
      working_tree_dirty: changed.length > 0,
      staged_count: 0,
      unstaged_count: changed.length,
      untracked_count: 0,
    },
    summary: {
      changed_file_count: overrides.changedSummary ?? changed.length,
      risk_count: risks.length,
      high_risk_count: risks.filter((risk) => risk.severity === 'high').length,
      missing_test_signal_count: testSignals.filter((signal) => signal.severity !== 'info').length,
      recommended_next_action: 'test',
    },
    changed_files: changed,
    risks,
    test_signals: testSignals,
    pr_draft: {
      title: 'Draft PR',
      summary: ['summary'],
      test_plan: ['test'],
    },
    diagnostics: [],
  };
}

function buildDraft(overrides: {
  kind: 'commit_draft' | 'pr_draft';
  artifact: string;
}): GitDraftReport {
  return {
    schema_version: 1,
    draft_type: overrides.kind,
    generated_at: '2026-06-04T12:00:00.000Z',
    artifact_path: overrides.artifact,
    project_root: '/repo',
    delivery_policy: {
      read_only: true,
      mutates_git: false,
      remote_side_effects: false,
      draft_first: true,
    },
    git: {
      repo_root: '/repo',
      branch: 'feature',
      head: '000001',
      base_ref: null,
      dirty: false,
    },
    summary: {
      changed_file_count: 1,
      insertions: 1,
      deletions: 0,
      files_with_stats: 1,
      recommended_next_action: 'commit',
    },
    changed_files: [
      {
        path: 'README.md',
        status: 'M',
        sources: ['unstaged'],
        additions: 1,
        deletions: 0,
      },
    ],
    diffstat: [' 1 file changed'],
    commit_draft: {
      subject: 'docs: ship change',
      body: ['Draft body'],
    },
    pr_draft: {
      title: 'Draft PR',
      summary: ['summary'],
      test_plan: ['run tests'],
      review_notes: ['note'],
    },
    diagnostics: [],
  };
}

function buildCommitReport(overrides: {
  status: 'applied' | 'failed';
  hash?: string;
  message?: string;
}): GitMutationReport {
  return {
    schema_version: 1,
    mutation_type: 'commit_create',
    generated_at: '2026-06-04T12:00:00.000Z',
    artifact_path: 'git-commit.json',
    project_root: '/repo',
    git: {
      repo_root: '/repo',
      branch_before: 'feature',
      branch_after: 'feature',
      head_before: '000001',
      head_after: '000002',
      dirty_before: false,
      dirty_after: false,
    },
    policy: {
      local_git_mutation: true,
      remote_side_effect_allowed: false,
      scheduled_isolation: 'none',
    },
    action: {
      status: overrides.status,
      command: ['git', 'commit', '-m', overrides.message ?? 'docs: ship'],
      message: overrides.status === 'applied' ? 'Created local Git commit.' : 'commit failed',
    },
    branch: null,
    commit: {
      hash: overrides.hash ?? '000002',
      message: overrides.message ?? 'docs: ship',
      stage_mode: 'all',
    },
    pull_request: null,
  };
}

function buildPrReport(overrides: {
  status: 'applied' | 'failed' | 'planned';
  url?: string | null;
}): GitMutationReport {
  return {
    schema_version: 1,
    mutation_type: 'pr_create',
    generated_at: '2026-06-04T12:00:00.000Z',
    artifact_path: 'git-pr.json',
    project_root: '/repo',
    git: {
      repo_root: '/repo',
      branch_before: 'feature',
      branch_after: 'feature',
      head_before: '000002',
      head_after: '000002',
      dirty_before: false,
      dirty_after: false,
    },
    policy: {
      local_git_mutation: false,
      remote_side_effect_allowed: true,
      scheduled_isolation: 'none',
    },
    action: {
      status: overrides.status,
      command: ['gh', 'pr', 'create'],
      message: overrides.status === 'applied' ? 'Created pull request via gh.' : 'failed',
    },
    branch: null,
    commit: null,
    pull_request: {
      title: 'Draft PR',
      body: 'Draft PR',
      url: overrides.url ?? null,
      draft: true,
    },
  };
}

function makeGitRunner(
  state: {
    branchBefore?: string;
    headBefore?: string;
    branchExists?: boolean;
    pushStatus?: number;
  } = {},
): (args: string[], cwd: string, timeoutMs?: number) => GitCommandResult {
  let branch = state.branchBefore ?? 'feature';
  const head = state.headBefore ?? '000001';
  const branchExists = state.branchExists ?? false;
  return (args: string[], _cwd: string) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { status: 0, stdout: '/repo', stderr: '' };
    }
    if (args[0] === 'branch' && args[1] === '--show-current') {
      return { status: 0, stdout: branch, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--short') {
      return { status: 0, stdout: head, stderr: '' };
    }
    if (args[0] === 'show-ref' && args[0] === 'show-ref') {
      return { status: branchExists ? 0 : 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'switch') {
      branch = args.includes('-c') ? (args[2] ?? branch) : (args[1] ?? branch);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'push' && args[1] === '-u') {
      return {
        status: state.pushStatus ?? 0,
        stdout: state.pushStatus === 0 ? 'pushed' : '',
        stderr: state.pushStatus === 0 ? '' : 'push failed',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function mockCheck(command: string): ShipVerification {
  return {
    command,
    status: 'passed',
    exit_code: 0,
    stdout: 'ok',
    stderr: '',
  };
}

test('runShip default behavior is a dry run with evidence and no mutations', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-ship-'));
  let commits = 0;
  let prs = 0;

  const report: ShipReport = runShip(
    {
      projectRoot: '/repo',
      outputDir,
      checkCommands: ['npm test'],
      now: new Date('2026-06-04T12:00:00.000Z'),
    },
    {
      runCiReview: () =>
        buildCiReview({
          changedFiles: [
            {
              path: 'src/index.ts',
              status: 'M',
              sources: ['unstaged'],
            },
          ],
        }),
      runGitDraft: (kind) => buildDraft({ kind, artifact: join(outputDir, `draft-${kind}.json`) }),
      createGitCommit: () => {
        commits++;
        return buildCommitReport({ status: 'applied' });
      },
      createGitPullRequest: () => {
        prs++;
        return buildPrReport({ status: 'applied', url: 'https://example.com/pull/1' });
      },
      runGit: makeGitRunner(),
      runVerification: (command) => mockCheck(command),
    },
  );

  assert.equal(report.status, 'dry_run');
  assert.equal(report.dry_run, true);
  assert.equal(report.apply_requested, false);
  assert.equal(commits, 0);
  assert.equal(prs, 0);
  assert.equal(readFileSync(report.artifact_path, 'utf8').includes('"status": "dry_run"'), true);
});

test('runShip blocks hard stops for mixed scopes and secrets', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-ship-'));
  let commits = 0;

  const report = runShip(
    {
      projectRoot: '/repo',
      outputDir,
      apply: true,
      now: new Date('2026-06-04T12:00:00.000Z'),
    },
    {
      runCiReview: () =>
        buildCiReview({
          changedFiles: [
            { path: 'src/index.ts', status: 'M', sources: ['unstaged'] },
            { path: 'docs/readme.md', status: 'M', sources: ['unstaged'] },
            { path: '.env.production', status: 'M', sources: ['unstaged'] },
          ],
          risks: [
            {
              severity: 'high',
              code: 'secret_candidate_changed',
              message: 'secret-like file changed',
              path: '.env.production',
            },
          ],
        }),
      runGitDraft: (kind) => buildDraft({ kind, artifact: join(outputDir, `draft-${kind}.json`) }),
      createGitCommit: () => {
        commits++;
        return buildCommitReport({ status: 'applied' });
      },
      createGitPullRequest: () =>
        buildPrReport({ status: 'applied', url: 'https://example.com/pull/1' }),
      runGit: makeGitRunner(),
      runVerification: () => mockCheck('npm test'),
    },
  );

  assert.equal(report.status, 'blocked');
  assert.equal(
    report.hard_stops.some((stop) => stop.code === 'mixed_concerns'),
    true,
  );
  assert.equal(
    report.hard_stops.some((stop) => stop.code === 'secret_candidate_changed'),
    true,
  );
  assert.equal(commits, 0);
});

test('runShip applies locally without remote when --allow-remote is not set', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-ship-'));
  let prs = 0;
  let pushes = 0;

  const report = runShip(
    {
      projectRoot: '/repo',
      outputDir,
      branch: 'codex/ship-safe',
      apply: true,
      checkCommands: ['npm test'],
      message: 'docs: ship safe',
      now: new Date('2026-06-04T12:00:00.000Z'),
    },
    {
      runCiReview: () =>
        buildCiReview({
          changedFiles: [{ path: 'src/index.ts', status: 'M', sources: ['unstaged'] }],
        }),
      runGitDraft: (kind) => buildDraft({ kind, artifact: join(outputDir, `draft-${kind}.json`) }),
      createGitCommit: () =>
        buildCommitReport({ status: 'applied', hash: '123456', message: 'docs: ship safe' }),
      createGitPullRequest: () => {
        prs++;
        return buildPrReport({ status: 'applied', url: 'https://example.com/pull/1' });
      },
      runGit: (args, cwd, timeoutMs) => {
        if (args[0] === 'push') {
          pushes++;
        }
        return makeGitRunner({ branchBefore: 'feature' })(args, cwd, timeoutMs);
      },
      runVerification: () => mockCheck('npm test'),
    },
  );

  assert.equal(report.status, 'applied');
  assert.equal(report.outputs.commit_hash, '123456');
  assert.equal(report.outputs.pushed_branch, null);
  assert.equal(prs, 0);
  assert.equal(pushes, 0);
});

test('runShip can branch from main without direct protected-branch shipping', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-ship-'));
  let commits = 0;

  const report = runShip(
    {
      projectRoot: '/repo',
      outputDir,
      branch: 'codex/ship-safe',
      apply: true,
      checkCommands: ['npm test'],
      now: new Date('2026-06-04T12:00:00.000Z'),
    },
    {
      runCiReview: () =>
        buildCiReview({
          changedFiles: [{ path: 'src/index.ts', status: 'M', sources: ['unstaged'] }],
        }),
      runGitDraft: (kind) => buildDraft({ kind, artifact: join(outputDir, `draft-${kind}.json`) }),
      createGitCommit: () => {
        commits++;
        return buildCommitReport({ status: 'applied', hash: '123456' });
      },
      createGitPullRequest: () =>
        buildPrReport({ status: 'applied', url: 'https://example.com/pull/1' }),
      runGit: makeGitRunner({ branchBefore: 'main' }),
      runVerification: () => mockCheck('npm test'),
    },
  );

  assert.equal(report.status, 'applied');
  assert.equal(
    report.hard_stops.some((stop) => stop.code === 'main_branch'),
    false,
  );
  assert.equal(report.outputs.branch, 'codex/ship-safe');
  assert.equal(commits, 1);
});

test('runShip can push and open draft PR when --allow-remote is set', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-ship-'));
  let pushed = false;
  let prs = 0;

  const report = runShip(
    {
      projectRoot: '/repo',
      outputDir,
      branch: 'codex/ship-safe',
      apply: true,
      allowRemote: true,
      checkCommands: ['npm test'],
      now: new Date('2026-06-04T12:00:00.000Z'),
    },
    {
      runCiReview: () =>
        buildCiReview({
          changedFiles: [{ path: 'src/index.ts', status: 'M', sources: ['unstaged'] }],
        }),
      runGitDraft: (kind) => buildDraft({ kind, artifact: join(outputDir, `draft-${kind}.json`) }),
      createGitCommit: () => buildCommitReport({ status: 'applied', hash: '123456' }),
      createGitPullRequest: () => {
        prs++;
        return buildPrReport({ status: 'applied', url: 'https://example.com/pull/1' });
      },
      runGit: (args, cwd, timeoutMs) => {
        if (args[0] === 'push') {
          pushed = true;
        }
        return makeGitRunner({ branchBefore: 'feature' })(args, cwd, timeoutMs);
      },
      runVerification: () => mockCheck('npm test'),
    },
  );

  assert.equal(report.status, 'applied');
  assert.equal(report.outputs.pushed_branch, 'codex/ship-safe');
  assert.equal(report.outputs.pr_url, 'https://example.com/pull/1');
  assert.equal(pushed, true);
  assert.equal(prs, 1);
});
