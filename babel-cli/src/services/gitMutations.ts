import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { runGitCommand } from '../utils/gitExec.js';
import { runGitDraft } from './gitDrafts.js';

export type GitMutationKind = 'branch_create' | 'commit_create' | 'pr_create';
export type GitMutationStatus = 'applied' | 'planned' | 'failed';

export interface GitMutationReport {
  schema_version: 1;
  mutation_type: GitMutationKind;
  generated_at: string;
  artifact_path: string;
  project_root: string;
  git: {
    repo_root: string;
    branch_before: string | null;
    branch_after: string | null;
    head_before: string | null;
    head_after: string | null;
    dirty_before: boolean;
    dirty_after: boolean;
  };
  policy: {
    local_git_mutation: boolean;
    remote_side_effect_allowed: boolean;
    scheduled_isolation: 'none' | 'project_copy';
  };
  action: {
    status: GitMutationStatus;
    command: string[];
    message: string;
  };
  branch: {
    name: string;
    from_ref: string;
  } | null;
  commit: {
    hash: string | null;
    message: string | null;
    stage_mode: 'staged' | 'tracked' | 'all' | null;
  } | null;
  pull_request: {
    title: string;
    body: string;
    url: string | null;
    draft: boolean;
  } | null;
}

export interface GitMutationOptions {
  projectRoot?: string;
  outputDir?: string;
  now?: Date;
  scheduledIsolation?: 'none' | 'project_copy';
}

export interface GitBranchCreateOptions extends GitMutationOptions {
  branchName: string;
  fromRef?: string;
}

export interface GitCommitCreateOptions extends GitMutationOptions {
  message?: string;
  stageMode?: 'staged' | 'tracked' | 'all';
}

export interface GitPrCreateOptions extends GitMutationOptions {
  title?: string;
  body?: string;
  draft?: boolean;
  allowRemote?: boolean;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], cwd: string, timeout = 15_000): GitResult {
  return runGitCommand(args, cwd, { timeoutMs: timeout });
}

function runCommand(command: string, args: string[], cwd: string, timeout = 30_000): GitResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function requireGitOutput(args: string[], cwd: string, label: string): string {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'unknown git error').trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function nullOnGitFailure(args: string[], cwd: string): string | null {
  const result = runGit(args, cwd);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function toArtifactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function statusDirty(repoRoot: string): boolean {
  return (nullOnGitFailure(['status', '--porcelain=v1', '-uall'], repoRoot) ?? '').length > 0;
}

function assertValidBranchName(name: string): void {
  if (name.trim() !== name || name.length === 0) {
    throw new Error('Branch name must be non-empty and must not include leading or trailing whitespace.');
  }
  const result = runGit(['check-ref-format', '--branch', name], process.cwd());
  if (result.status !== 0 || name.startsWith('-')) {
    throw new Error(`Invalid branch name: ${name}`);
  }
}

function defaultOutputDir(): string {
  return join(BABEL_RUNS_DIR, 'git-mutations');
}

function makeArtifactPath(kind: GitMutationKind, outputDir: string, generatedAt: string): string {
  return join(
    outputDir,
    `git-${kind.replace('_', '-')}-${toArtifactTimestamp(new Date(generatedAt))}.json`,
  );
}

function makeBaseReport(
  kind: GitMutationKind,
  options: GitMutationOptions,
): {
  report: GitMutationReport;
  repoRoot: string;
} {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  if (!existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }
  const repoRoot = requireGitOutput(['rev-parse', '--show-toplevel'], projectRoot, 'git repo discovery');
  const generatedAt = (options.now ?? new Date()).toISOString();
  const outputDir = resolve(options.outputDir ?? defaultOutputDir());
  const branchBefore = nullOnGitFailure(['branch', '--show-current'], repoRoot);
  const headBefore = nullOnGitFailure(['rev-parse', '--short', 'HEAD'], repoRoot);
  const report: GitMutationReport = {
    schema_version: 1,
    mutation_type: kind,
    generated_at: generatedAt,
    artifact_path: makeArtifactPath(kind, outputDir, generatedAt),
    project_root: projectRoot,
    git: {
      repo_root: normalizePath(repoRoot),
      branch_before: branchBefore,
      branch_after: branchBefore,
      head_before: headBefore,
      head_after: headBefore,
      dirty_before: statusDirty(repoRoot),
      dirty_after: statusDirty(repoRoot),
    },
    policy: {
      local_git_mutation: kind === 'branch_create' || kind === 'commit_create',
      remote_side_effect_allowed: false,
      scheduled_isolation: options.scheduledIsolation ?? 'none',
    },
    action: {
      status: 'failed',
      command: [],
      message: 'Not executed.',
    },
    branch: null,
    commit: null,
    pull_request: null,
  };
  return { report, repoRoot };
}

function refreshGitState(report: GitMutationReport, repoRoot: string): void {
  report.git.branch_after = nullOnGitFailure(['branch', '--show-current'], repoRoot);
  report.git.head_after = nullOnGitFailure(['rev-parse', '--short', 'HEAD'], repoRoot);
  report.git.dirty_after = statusDirty(repoRoot);
}

function writeReport(report: GitMutationReport): GitMutationReport {
  mkdirSync(dirname(report.artifact_path), { recursive: true });
  writeFileSync(report.artifact_path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function createGitBranch(options: GitBranchCreateOptions): GitMutationReport {
  assertValidBranchName(options.branchName);
  const { report, repoRoot } = makeBaseReport('branch_create', options);
  const fromRef = options.fromRef?.trim() || 'HEAD';
  const command = ['git', 'branch', options.branchName, fromRef];
  report.action.command = command;
  report.branch = {
    name: options.branchName,
    from_ref: fromRef,
  };

  const result = runGit(command.slice(1), repoRoot);
  refreshGitState(report, repoRoot);
  if (result.status !== 0) {
    report.action.status = 'failed';
    report.action.message = (result.stderr || result.stdout || 'git branch failed').trim();
    return writeReport(report);
  }

  report.action.status = 'applied';
  report.action.message = `Created local branch ${options.branchName} from ${fromRef}.`;
  return writeReport(report);
}

function resolveCommitMessage(repoRoot: string, options: GitCommitCreateOptions): string {
  const explicit = options.message?.trim();
  if (explicit) return explicit;
  const draft = runGitDraft('commit_draft', {
    projectRoot: repoRoot,
    outputDir: join(defaultOutputDir(), 'drafts'),
    ...(options.now ? { now: options.now } : {}),
  });
  return draft.commit_draft?.subject ?? 'chore(repo): apply local changes';
}

export function createGitCommit(options: GitCommitCreateOptions = {}): GitMutationReport {
  const { report, repoRoot } = makeBaseReport('commit_create', options);
  const stageMode = options.stageMode ?? 'staged';
  const message = resolveCommitMessage(repoRoot, options);

  if (stageMode === 'tracked') {
    const addTracked = runGit(['add', '-u'], repoRoot);
    if (addTracked.status !== 0) {
      report.action.command = ['git', 'add', '-u'];
      report.action.status = 'failed';
      report.action.message = (addTracked.stderr || addTracked.stdout || 'git add -u failed').trim();
      refreshGitState(report, repoRoot);
      return writeReport(report);
    }
  } else if (stageMode === 'all') {
    const addAll = runGit(['add', '-A'], repoRoot);
    if (addAll.status !== 0) {
      report.action.command = ['git', 'add', '-A'];
      report.action.status = 'failed';
      report.action.message = (addAll.stderr || addAll.stdout || 'git add -A failed').trim();
      refreshGitState(report, repoRoot);
      return writeReport(report);
    }
  }

  const staged = runGit(['diff', '--cached', '--name-only'], repoRoot);
  if (staged.status !== 0 || staged.stdout.trim().length === 0) {
    report.action.command = ['git', 'commit', '-m', message];
    report.action.status = 'failed';
    report.action.message = 'No staged changes to commit. Use --stage tracked or --stage all to stage changes explicitly.';
    refreshGitState(report, repoRoot);
    return writeReport(report);
  }

  const command = ['git', 'commit', '-m', message];
  report.action.command = command;
  report.commit = {
    hash: null,
    message,
    stage_mode: stageMode,
  };
  const result = runGit(command.slice(1), repoRoot, 30_000);
  refreshGitState(report, repoRoot);
  if (result.status !== 0) {
    report.action.status = 'failed';
    report.action.message = (result.stderr || result.stdout || 'git commit failed').trim();
    return writeReport(report);
  }
  report.action.status = 'applied';
  report.action.message = 'Created local Git commit.';
  report.commit.hash = nullOnGitFailure(['rev-parse', '--short', 'HEAD'], repoRoot);
  return writeReport(report);
}

export function createGitPullRequest(options: GitPrCreateOptions = {}): GitMutationReport {
  const { report, repoRoot } = makeBaseReport('pr_create', options);
  const draft = runGitDraft('pr_draft', {
    projectRoot: repoRoot,
    outputDir: join(defaultOutputDir(), 'drafts'),
    ...(options.now ? { now: options.now } : {}),
  });
  const title = options.title?.trim() || draft.pr_draft?.title || 'Babel generated PR';
  const body = options.body?.trim() || [
    ...(draft.pr_draft?.summary ?? []),
    '',
    'Test plan:',
    ...(draft.pr_draft?.test_plan ?? []).map((line) => `- ${line}`),
  ].join('\n');
  const command = [
    'gh',
    'pr',
    'create',
    '--title',
    title,
    '--body',
    body,
    ...(options.draft === false ? [] : ['--draft']),
  ];

  report.policy.remote_side_effect_allowed = options.allowRemote === true;
  report.policy.local_git_mutation = false;
  report.action.command = command;
  report.pull_request = {
    title,
    body,
    url: null,
    draft: options.draft !== false,
  };

  if (options.allowRemote !== true) {
    report.action.status = 'planned';
    report.action.message = 'Remote PR creation is gated. Re-run with --allow-remote to execute gh pr create.';
    refreshGitState(report, repoRoot);
    return writeReport(report);
  }

  const result = runCommand(command[0]!, command.slice(1), repoRoot, 60_000);
  refreshGitState(report, repoRoot);
  if (result.status !== 0) {
    report.action.status = 'failed';
    report.action.message = (result.stderr || result.stdout || 'gh pr create failed').trim();
    return writeReport(report);
  }

  report.action.status = 'applied';
  report.action.message = 'Created pull request via gh.';
  report.pull_request.url = result.stdout.trim() || null;
  return writeReport(report);
}

export function formatGitMutationHuman(report: GitMutationReport): string {
  const lines = [
    'Babel Git Mutation',
    `Type: ${report.mutation_type}`,
    `Status: ${report.action.status}`,
    `Repo: ${report.git.repo_root}`,
    `Head: ${report.git.head_before ?? 'unknown'} -> ${report.git.head_after ?? 'unknown'}`,
    `Artifact: ${report.artifact_path}`,
    '',
    report.action.message,
  ];
  if (report.branch) {
    lines.push('', `Branch: ${report.branch.name}`, `From: ${report.branch.from_ref}`);
  }
  if (report.commit) {
    lines.push('', `Commit: ${report.commit.hash ?? 'not created'}`, `Message: ${report.commit.message ?? ''}`);
  }
  if (report.pull_request) {
    lines.push('', `PR title: ${report.pull_request.title}`, `PR URL: ${report.pull_request.url ?? '(not created)'}`);
  }
  return lines.join('\n');
}
