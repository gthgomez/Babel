import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { runGitCommand, type GitCommandResult } from '../utils/gitExec.js';
import { runCiReview, type CiReviewReport } from './ciReview.js';
import { runGitDraft, type GitDraftReport } from './gitDrafts.js';
import { createGitCommit, createGitPullRequest, type GitMutationReport } from './gitMutations.js';
import {
  buildEvidencePrBody,
  loadImplementorShipEvidenceFromRunDir,
  mergeShipEvidenceSources,
} from './shipEvidencePrBody.js';
import {
  buildSecretScanReport,
  scanDiffForSecrets,
  secretFindingsToHardStopMessages,
  type SecretScanReport,
} from './shipSecretScan.js';

export type ShipStatus = 'dry_run' | 'blocked' | 'applied' | 'failed';

export interface ShipHardStop {
  severity: 'hard_stop';
  code: string;
  message: string;
  path?: string;
}

export interface ShipVerification {
  command: string;
  status: 'passed' | 'failed';
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

export interface ShipAction {
  name: string;
  status: 'planned' | 'applied' | 'skipped' | 'failed';
  command: string[];
  message: string;
  artifact_path?: string | null;
}

export interface ShipReport {
  schema_version: 1;
  workflow_type: 'babel_ship';
  generated_at: string;
  artifact_path: string;
  status: ShipStatus;
  project_root: string;
  dry_run: boolean;
  apply_requested: boolean;
  git: {
    repo_root: string;
    branch_before: string | null;
    branch_after: string | null;
    head_before: string | null;
    head_after: string | null;
    target_branch: string | null;
    base_ref: string | null;
  };
  policy: {
    allow_main: boolean;
    allow_mixed: boolean;
    allow_remote: boolean;
  };
  hard_stops: ShipHardStop[];
  verification: ShipVerification[];
  /** W3.1 content secret scan (diff-level). */
  secret_scan: SecretScanReport | null;
  /** W3.1 evidence-backed PR body (also used when opening draft PR). */
  evidence_pr_body: string | null;
  review: {
    ci_review_artifact: string | null;
    commit_draft_artifact: string | null;
    pr_draft_artifact: string | null;
  };
  actions: ShipAction[];
  outputs: {
    branch: string | null;
    commit_hash: string | null;
    pushed_branch: string | null;
    pr_url: string | null;
  };
  next: string[];
}

export interface ShipOptions {
  projectRoot?: string;
  outputDir?: string;
  baseRef?: string;
  branch?: string;
  message?: string;
  title?: string;
  body?: string;
  checkCommands?: string[];
  apply?: boolean;
  dryRun?: boolean;
  allowMain?: boolean;
  allowMixed?: boolean;
  allowRemote?: boolean;
  now?: Date;
  /** Optional implementor run dir for evidence PR body (W3). */
  evidenceRunDir?: string;
  /** Skip content secret scan (tests only; path-based CI risks still apply). */
  skipSecretContentScan?: boolean;
  /** Optional task label for evidence PR body. */
  task?: string;
}

interface ShipRuntime {
  runCiReview: (options: {
    projectRoot?: string;
    baseRef?: string;
    outputDir?: string;
    now?: Date;
  }) => CiReviewReport;
  runGitDraft: (
    kind: 'commit_draft' | 'pr_draft',
    options: { projectRoot?: string; baseRef?: string; outputDir?: string; now?: Date },
  ) => GitDraftReport;
  createGitCommit: (options: {
    projectRoot?: string;
    outputDir?: string;
    now?: Date;
    message?: string;
    stageMode?: 'staged' | 'tracked' | 'all';
  }) => GitMutationReport;
  createGitPullRequest: (options: {
    projectRoot?: string;
    outputDir?: string;
    now?: Date;
    title?: string;
    body?: string;
    allowRemote?: boolean;
    draft?: boolean;
  }) => GitMutationReport;
  runGit: (args: string[], cwd: string, timeoutMs?: number) => GitCommandResult;
  runVerification: (command: string, cwd: string, timeoutMs?: number) => ShipVerification;
}

function toArtifactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function pathScope(path: string): string {
  const normalized = normalizePath(path).trim();
  return normalized || '.';
}

function collectTopLevelScopes(changed: Array<{ path: string }>): string[] {
  return [...new Set(changed.map((file) => normalizedScope(file.path)))].sort();
}

function normalizedScope(path: string): string {
  const normalized = normalizePath(path).trim();
  if (!normalized) {
    return '.';
  }
  return normalized.startsWith('./')
    ? (normalized.slice(2).split('/')[0] ?? '.')
    : (normalized.split('/')[0] ?? '.');
}

function isProtectedBranch(branch: string | null | undefined): boolean {
  return branch === 'main' || branch === 'master';
}

function isGeneratedChange(path: string): boolean {
  return (
    path.startsWith('dist/') ||
    path.startsWith('build/') ||
    path.startsWith('coverage/') ||
    path.startsWith('.next/') ||
    path.startsWith('out/')
  );
}

function defaultRuntime(): ShipRuntime {
  return {
    runCiReview: ({ projectRoot, baseRef, outputDir, now }) =>
      runCiReview({
        projectRoot: projectRoot ?? process.cwd(),
        outputDir: outputDir ?? join(BABEL_RUNS_DIR, 'ci-review'),
        ...(baseRef ? { baseRef } : {}),
        ...(now ? { now } : {}),
      }),
    runGitDraft: (kind, { projectRoot, baseRef, outputDir, now }) =>
      runGitDraft(kind, {
        projectRoot: projectRoot ?? process.cwd(),
        outputDir: outputDir ?? join(BABEL_RUNS_DIR, 'git-drafts'),
        ...(baseRef ? { baseRef } : {}),
        ...(now ? { now } : {}),
      }),
    createGitCommit: ({ projectRoot, outputDir, now, message }) =>
      createGitCommit({
        projectRoot: projectRoot ?? process.cwd(),
        outputDir: outputDir ?? join(BABEL_RUNS_DIR, 'git-mutations'),
        ...(now ? { now } : {}),
        ...(message ? { message } : {}),
        stageMode: 'all',
      }),
    createGitPullRequest: ({ projectRoot, outputDir, now, title, body }) =>
      createGitPullRequest({
        projectRoot: projectRoot ?? process.cwd(),
        outputDir: outputDir ?? join(BABEL_RUNS_DIR, 'git-mutations'),
        ...(now ? { now } : {}),
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
        allowRemote: true,
        draft: true,
      }),
    runGit: (args, cwd, timeoutMs = 15_000) => runGitCommand(args, cwd, { timeoutMs }),
    runVerification: (command, cwd, timeoutMs = 120_000) => {
      const result = spawnSync(command, {
        cwd,
        shell: true,
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
      });
      return {
        command,
        status: result.status === 0 ? 'passed' : 'failed',
        exit_code: result.status,
        stdout: (result.stdout ?? '').slice(0, 12_000),
        stderr: (result.stderr ?? result.error?.message ?? '').slice(0, 12_000),
      };
    },
  };
}

function makeStop(code: string, message: string, path?: string): ShipHardStop {
  return path
    ? { severity: 'hard_stop', code, message, path }
    : { severity: 'hard_stop', code, message };
}

function collectHardStops(input: {
  ci: CiReviewReport;
  branchBefore: string | null;
  targetBranch: string | null;
  checks: ShipVerification[];
  allowMain: boolean;
  allowMixed: boolean;
  checkCommands: string[];
}): ShipHardStop[] {
  const stops: ShipHardStop[] = [];

  if (input.ci.changed_files.length === 0) {
    stops.push(makeStop('no_changes', 'No changed files were found to ship.'));
  }

  if (!input.allowMain && isProtectedBranch(input.targetBranch)) {
    stops.push(
      makeStop(
        'main_branch',
        'AGENTS hard-stop: direct shipping to main/master is blocked unless --allow-main is passed.',
      ),
    );
  }

  const scopes = collectTopLevelScopes(input.ci.changed_files);
  if (!input.allowMixed && scopes.length > 1) {
    stops.push(
      makeStop(
        'mixed_concerns',
        `Changed paths span multiple scopes: ${scopes.join(', ')}. Use --allow-mixed to proceed.`,
      ),
    );
  }

  if (input.ci.changed_files.some((file) => isGeneratedChange(file.path))) {
    stops.push(
      makeStop(
        'generated_artifact_changed',
        'AGENTS hard-stop: generated/build artifacts changed.',
      ),
    );
  }

  for (const risk of input.ci.risks) {
    if (risk.severity === 'high') {
      stops.push(makeStop(risk.code, risk.message, risk.path));
    }
    if (risk.code === 'secret_candidate_changed') {
      stops.push(makeStop('secret_candidate_changed', risk.message, risk.path));
    }
  }

  for (const check of input.checks) {
    if (check.status === 'failed') {
      stops.push(makeStop('verification_failed', `Verification failed: ${check.command}`));
    }
  }

  const sourceOnly = input.ci.test_signals.some(
    (signal) => signal.code === 'source_without_test_change',
  );
  if (sourceOnly && input.checkCommands.length === 0) {
    stops.push(
      makeStop(
        'verification_required',
        'Source-only change requires --check command(s) before apply.',
      ),
    );
  }

  return stops;
}

function gitRefExists(runGit: ShipRuntime['runGit'], repoRoot: string, branch: string): boolean {
  return runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot).status === 0;
}

function switchToBranch(deps: ShipRuntime, repoRoot: string, branchName: string): ShipAction {
  const exists = gitRefExists(deps.runGit, repoRoot, branchName);
  const args = exists ? ['switch', branchName] : ['switch', '-c', branchName];
  const result = deps.runGit(args, repoRoot);
  return {
    name: 'branch',
    status: result.status === 0 ? 'applied' : 'failed',
    command: ['git', ...args],
    message:
      result.status === 0
        ? exists
          ? `Switched to branch ${branchName}.`
          : `Created and switched to branch ${branchName}.`
        : (result.stderr || result.stdout || 'git switch failed').trim(),
  };
}

function pushBranch(deps: ShipRuntime, repoRoot: string, branch: string): ShipAction {
  const args = ['push', '-u', 'origin', branch];
  const result = deps.runGit(args, repoRoot, 60_000);
  return {
    name: 'push',
    status: result.status === 0 ? 'applied' : 'failed',
    command: ['git', ...args],
    message:
      result.status === 0
        ? `Pushed ${branch} to origin.`
        : (result.stderr || result.stdout || 'git push failed').trim(),
  };
}

function refreshGitState(
  report: ShipReport,
  repoRoot: string,
  runGit: ShipRuntime['runGit'],
): void {
  report.git.branch_after = runGit(['branch', '--show-current'], repoRoot).stdout.trim() || null;
  report.git.head_after = runGit(['rev-parse', '--short', 'HEAD'], repoRoot).stdout.trim() || null;
}

function writeReport(report: ShipReport): ShipReport {
  mkdirSync(dirname(report.artifact_path), { recursive: true });
  writeFileSync(report.artifact_path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function buildNext(report: ShipReport): string[] {
  if (report.status === 'blocked') {
    return ['Resolve hard stops and rerun with --apply.'];
  }
  if (report.status === 'dry_run') {
    return ['Re-run with --apply to perform local commit and optional remote push/PR.'];
  }
  if (report.status === 'failed') {
    return ['Review the failed action and rerun after fixing that concern.'];
  }
  if (report.outputs.pr_url) {
    return [`Review draft PR: ${report.outputs.pr_url}`];
  }
  if (report.outputs.commit_hash) {
    return [
      report.outputs.pushed_branch
        ? `Merged branch ${report.outputs.pushed_branch} and PR draft is ${report.outputs.pr_url ?? 'pending'}.`
        : 'Run --allow-remote to push and open a draft PR when ready.',
    ];
  }
  return ['Inspect artifact for the resulting state.'];
}

function resolveTargetBranch(
  rawBranch: string | undefined,
  branchBefore: string | null,
): string | null {
  return rawBranch?.trim() || branchBefore || null;
}

function baseReport(
  raw: ShipOptions,
  repoRoot: string,
  branchBefore: string | null,
  headBefore: string | null,
  ci: CiReviewReport,
  commitDraft: GitDraftReport,
  prDraft: GitDraftReport,
): ShipReport {
  const now = raw.now ?? new Date();
  const outputDir = resolve(raw.outputDir ?? join(BABEL_RUNS_DIR, 'ship'));
  const targetBranch = resolveTargetBranch(raw.branch, branchBefore);
  const applyRequested = raw.apply === true && raw.dryRun !== true;

  return {
    schema_version: 1,
    workflow_type: 'babel_ship',
    generated_at: now.toISOString(),
    artifact_path: join(outputDir, `ship-${toArtifactTimestamp(now)}.json`),
    status: 'dry_run',
    project_root: repoRoot,
    dry_run: !applyRequested,
    apply_requested: applyRequested,
    git: {
      repo_root: repoRoot,
      branch_before: branchBefore,
      branch_after: branchBefore,
      head_before: headBefore,
      head_after: headBefore,
      target_branch: targetBranch,
      base_ref: raw.baseRef?.trim() ?? null,
    },
    policy: {
      allow_main: raw.allowMain === true,
      allow_mixed: raw.allowMixed === true,
      allow_remote: raw.allowRemote === true,
    },
    hard_stops: [],
    verification: [],
    secret_scan: null,
    evidence_pr_body: null,
    review: {
      ci_review_artifact: ci.artifact_path,
      commit_draft_artifact: commitDraft.artifact_path,
      pr_draft_artifact: prDraft.artifact_path,
    },
    actions: [
      {
        name: 'review',
        status: 'applied',
        command: ['ci', 'git', 'draft'],
        message: 'CI review and draft evidence prepared.',
      },
    ],
    outputs: {
      branch: targetBranch,
      commit_hash: null,
      pushed_branch: null,
      pr_url: null,
    },
    next: [],
  };
}

export function runShip(raw: ShipOptions, overrides: Partial<ShipRuntime> = {}): ShipReport {
  const now = raw.now ?? new Date();
  const deps: ShipRuntime = {
    ...defaultRuntime(),
    ...overrides,
  };
  const projectRoot = resolve(raw.projectRoot ?? process.cwd());

  const repoRootResult = deps.runGit(['rev-parse', '--show-toplevel'], projectRoot);
  if (repoRootResult.status !== 0) {
    throw new Error(
      `Unable to resolve repository root: ${(repoRootResult.stderr || repoRootResult.stdout).trim()}`,
    );
  }

  const repoRoot = resolve(repoRootResult.stdout.trim());
  const branchBefore = deps.runGit(['branch', '--show-current'], repoRoot).stdout.trim() || null;
  const headBefore = deps.runGit(['rev-parse', '--short', 'HEAD'], repoRoot).stdout.trim() || null;
  const outputDir = resolve(raw.outputDir ?? join(BABEL_RUNS_DIR, 'ship'));

  const ci = deps.runCiReview({
    projectRoot: repoRoot,
    outputDir: join(outputDir, 'ci-review'),
    ...(raw.baseRef ? { baseRef: raw.baseRef } : {}),
    now,
  });
  const commitDraft = deps.runGitDraft('commit_draft', {
    projectRoot: repoRoot,
    outputDir: join(outputDir, 'git-drafts'),
    ...(raw.baseRef ? { baseRef: raw.baseRef } : {}),
    now,
  });
  const prDraft = deps.runGitDraft('pr_draft', {
    projectRoot: repoRoot,
    outputDir: join(outputDir, 'git-drafts'),
    ...(raw.baseRef ? { baseRef: raw.baseRef } : {}),
    now: new Date(now.getTime() + 1_000),
  });
  const prTitle = raw.title ?? prDraft.pr_draft?.title;

  const checkCommands = [
    ...new Set((raw.checkCommands ?? []).map((command) => command.trim()).filter(Boolean)),
  ];
  const verification = checkCommands.map((command) => deps.runVerification(command, repoRoot));
  const targetBranch = resolveTargetBranch(raw.branch, branchBefore);
  const hardStops = collectHardStops({
    ci,
    branchBefore,
    targetBranch,
    checks: verification,
    allowMain: raw.allowMain === true,
    allowMixed: raw.allowMixed === true,
    checkCommands,
  });

  // W3.1: content-level secret scan on working tree diff
  let secretScan: SecretScanReport | null = null;
  if (raw.skipSecretContentScan !== true) {
    const staged = deps.runGit(['diff', '--cached'], repoRoot).stdout ?? '';
    const unstaged = deps.runGit(['diff', 'HEAD'], repoRoot).stdout ?? '';
    const combinedDiff = [staged, unstaged].filter(Boolean).join('\n');
    const findings = scanDiffForSecrets(combinedDiff);
    secretScan = buildSecretScanReport(findings);
    for (const stop of secretFindingsToHardStopMessages(findings)) {
      hardStops.push(makeStop(stop.code, stop.message, stop.path));
    }
  }

  // W3.1: evidence-backed PR body from run dir + CI drafts
  const runEvidence = raw.evidenceRunDir
    ? loadImplementorShipEvidenceFromRunDir(raw.evidenceRunDir)
    : undefined;
  const mergedEvidence = mergeShipEvidenceSources({
    ...(runEvidence ? { runEvidence } : {}),
    changedFiles: ci.changed_files.map((f) => f.path),
    verification: verification.map((v) => ({
      command: v.command,
      status: v.status,
      exit_code: v.exit_code,
    })),
    ...(raw.task ? { task: raw.task } : runEvidence?.task ? { task: runEvidence.task } : {}),
    ...(prDraft.pr_draft?.summary ? { prSummary: prDraft.pr_draft.summary } : {}),
    ...(prDraft.pr_draft?.test_plan ? { prTestPlan: prDraft.pr_draft.test_plan } : {}),
  });
  const evidencePrBody = buildEvidencePrBody(mergedEvidence);

  const report = baseReport(raw, repoRoot, branchBefore, headBefore, ci, commitDraft, prDraft);
  report.verification = verification;
  report.hard_stops = hardStops;
  report.secret_scan = secretScan;
  report.evidence_pr_body = evidencePrBody;
  report.actions.push({
    name: 'secret_scan',
    status: secretScan && !secretScan.passed ? 'failed' : 'applied',
    command: ['babel', 'ship', 'secret-scan'],
    message:
      secretScan == null
        ? 'Secret content scan skipped.'
        : secretScan.passed
          ? 'Secret content scan passed.'
          : `Secret content scan found ${secretScan.finding_count} finding(s).`,
  });
  report.actions.push({
    name: 'evidence_pr_body',
    status: 'applied',
    command: ['babel', 'ship', 'evidence-pr-body'],
    message: 'Evidence PR body prepared from implementor/CI artifacts.',
  });

  const applyRequested = raw.apply === true && raw.dryRun !== true;
  if (!applyRequested || hardStops.length > 0) {
    report.status = hardStops.length > 0 ? 'blocked' : 'dry_run';
    report.next = buildNext(report);
    refreshGitState(report, repoRoot, deps.runGit);
    return writeReport(report);
  }

  if (targetBranch && targetBranch !== branchBefore) {
    const branchAction = switchToBranch(deps, repoRoot, targetBranch);
    report.actions.push(branchAction);
    if (branchAction.status !== 'applied') {
      report.status = 'failed';
      report.next = buildNext(report);
      refreshGitState(report, repoRoot, deps.runGit);
      return writeReport(report);
    }
  }

  const commit = deps.createGitCommit({
    projectRoot: repoRoot,
    outputDir: join(outputDir, 'git-mutations'),
    now: new Date(now.getTime() + 2_000),
    message:
      raw.message ?? commitDraft.commit_draft?.subject ?? 'chore(repo): ship reviewed changes',
  });
  report.actions.push({
    name: 'commit',
    status:
      commit.action.status === 'applied'
        ? 'applied'
        : commit.action.status === 'planned'
          ? 'planned'
          : 'failed',
    command: commit.action.command,
    message: commit.action.message,
    artifact_path: commit.artifact_path,
  });
  if (commit.action.status !== 'applied') {
    report.status = 'failed';
    report.next = buildNext(report);
    refreshGitState(report, repoRoot, deps.runGit);
    return writeReport(report);
  }
  report.outputs.branch =
    targetBranch || deps.runGit(['branch', '--show-current'], repoRoot).stdout.trim() || null;
  report.outputs.commit_hash = commit.commit?.hash ?? null;

  if (raw.allowRemote !== true) {
    report.actions.push({
      name: 'push',
      status: 'skipped',
      command: ['git', 'push', '-u', 'origin', report.outputs.branch ?? 'HEAD'],
      message: 'Remote mutation is disabled by default. Add --allow-remote to push and open PR.',
    });
    report.actions.push({
      name: 'pr',
      status: 'skipped',
      command: ['gh', 'pr', 'create'],
      message: 'Remote PR creation is disabled without --allow-remote.',
    });
    report.status = 'applied';
    report.next = buildNext(report);
    refreshGitState(report, repoRoot, deps.runGit);
    return writeReport(report);
  }

  const branchForPush = report.outputs.branch || targetBranch || 'HEAD';
  const push = pushBranch(deps, repoRoot, branchForPush);
  report.actions.push(push);
  if (push.status !== 'applied') {
    report.status = 'failed';
    report.next = buildNext(report);
    refreshGitState(report, repoRoot, deps.runGit);
    return writeReport(report);
  }
  report.outputs.pushed_branch = branchForPush;

  const pr = deps.createGitPullRequest({
    projectRoot: repoRoot,
    outputDir: join(outputDir, 'git-mutations'),
    now: new Date(now.getTime() + 3_000),
    allowRemote: true,
    ...(prTitle ? { title: prTitle } : {}),
    body:
      raw.body ??
      evidencePrBody ??
      [
        ...(prDraft.pr_draft?.summary ?? []),
        '',
        ...(prDraft.pr_draft?.test_plan ?? []).map((line) => `- ${line}`),
      ].join('\n'),
  });
  report.actions.push({
    name: 'pr',
    status:
      pr.action.status === 'applied'
        ? 'applied'
        : pr.action.status === 'planned'
          ? 'planned'
          : 'failed',
    command: pr.action.command,
    message: pr.action.message,
    artifact_path: pr.artifact_path,
  });
  report.outputs.pr_url = pr.pull_request?.url ?? null;
  if (pr.action.status !== 'applied') {
    report.status = pr.action.status === 'planned' ? 'blocked' : 'failed';
    report.next = buildNext(report);
    refreshGitState(report, repoRoot, deps.runGit);
    return writeReport(report);
  }

  report.status = 'applied';
  report.next = buildNext(report);
  refreshGitState(report, repoRoot, deps.runGit);
  return writeReport(report);
}

export function formatShipHuman(report: ShipReport): string {
  const lines = [
    'Babel Ship',
    `Status: ${report.status}`,
    `Project: ${report.git.repo_root}`,
    `Artifact: ${report.artifact_path}`,
    '',
    `Hard stops: ${report.hard_stops.length}`,
  ];
  for (const stop of report.hard_stops) {
    lines.push(`- ${stop.code}${stop.path ? ` ${stop.path}` : ''}: ${stop.message}`);
  }
  if (report.secret_scan) {
    lines.push(
      '',
      `Secret scan: ${report.secret_scan.passed ? 'passed' : 'FAILED'} (${report.secret_scan.finding_count} finding(s))`,
    );
  }
  if (report.verification.length > 0) {
    lines.push('', 'Verification:');
    for (const check of report.verification) {
      lines.push(`- ${check.status}: ${check.command}`);
    }
  }
  lines.push('', 'Actions:');
  for (const action of report.actions) {
    lines.push(`- ${action.name}: ${action.status} - ${action.message}`);
  }
  if (report.outputs.commit_hash || report.outputs.pushed_branch || report.outputs.pr_url) {
    lines.push('', 'Outputs:');
    if (report.outputs.branch) lines.push(`- branch: ${report.outputs.branch}`);
    if (report.outputs.commit_hash) lines.push(`- commit: ${report.outputs.commit_hash}`);
    if (report.outputs.pushed_branch) lines.push(`- pushed: ${report.outputs.pushed_branch}`);
    if (report.outputs.pr_url) lines.push(`- pr: ${report.outputs.pr_url}`);
  }
  if (report.evidence_pr_body) {
    lines.push('', 'Evidence PR body: prepared (see report JSON field evidence_pr_body)');
  }
  if (report.next.length > 0) {
    lines.push('', 'Next:');
    for (const step of report.next) {
      lines.push(`- ${step}`);
    }
  }
  return lines.join('\n');
}
