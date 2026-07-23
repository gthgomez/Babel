import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { runGitCommand } from '../utils/gitExec.js';

export type CiReviewStatus = 'pass' | 'warn';
export type CiReviewSeverity = 'info' | 'medium' | 'high';
export type CiReviewChangeSource = 'base' | 'staged' | 'unstaged' | 'untracked';

export interface CiReviewChangedFile {
  path: string;
  status: string;
  sources: CiReviewChangeSource[];
}

export interface CiReviewFinding {
  severity: CiReviewSeverity;
  code: string;
  message: string;
  path?: string | undefined;
}

export interface CiReviewReport {
  schema_version: 1;
  review_type: 'babel_ci_review';
  generated_at: string;
  artifact_path: string;
  status: CiReviewStatus;
  project_root: string;
  delivery_policy: {
    read_only: true;
    mutates_git: false;
    remote_side_effects: false;
    draft_first: true;
  };
  git: {
    repo_root: string;
    branch: string | null;
    head: string | null;
    base_ref: string | null;
    working_tree_dirty: boolean;
    staged_count: number;
    unstaged_count: number;
    untracked_count: number;
  };
  summary: {
    changed_file_count: number;
    risk_count: number;
    high_risk_count: number;
    missing_test_signal_count: number;
    recommended_next_action: string;
  };
  changed_files: CiReviewChangedFile[];
  risks: CiReviewFinding[];
  test_signals: CiReviewFinding[];
  pr_draft: {
    title: string;
    summary: string[];
    test_plan: string[];
  };
  diagnostics: CiReviewFinding[];
}

export interface CiReviewOptions {
  projectRoot?: string;
  outputDir?: string;
  baseRef?: string;
  now?: Date;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface ParsedStatusLine {
  path: string;
  status: string;
  sources: CiReviewChangeSource[];
}

function runGit(args: string[], cwd: string): GitResult {
  return runGitCommand(args, cwd);
}

function requireGitOutput(args: string[], cwd: string, label: string): string {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'unknown git error').trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout.trim();
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

function relativeGitPath(repoRoot: string, path: string): string {
  return normalizePath(relative(repoRoot, resolve(repoRoot, path)));
}

function parseNameStatus(stdout: string, source: CiReviewChangeSource): ParsedStatusLine[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...pathParts] = line.split(/\s+/);
      const rawPath = pathParts.join(' ');
      return {
        path: normalizePath(
          rawPath.includes('\t') ? (rawPath.split('\t').at(-1) ?? rawPath) : rawPath,
        ),
        status: status ?? 'M',
        sources: [source],
      };
    });
}

function parsePorcelainStatus(stdout: string): ParsedStatusLine[] {
  const entries: ParsedStatusLine[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rawPath = line.slice(3).trim();
    const path = normalizePath(
      rawPath.includes(' -> ') ? (rawPath.split(' -> ').at(-1) ?? rawPath) : rawPath,
    );
    const sources: CiReviewChangeSource[] = [];
    if (x === '?' && y === '?') {
      sources.push('untracked');
    } else {
      if (x !== ' ') sources.push('staged');
      if (y !== ' ') sources.push('unstaged');
    }
    entries.push({
      path,
      status: `${x}${y}`.trim() || 'M',
      sources,
    });
  }
  return entries;
}

function mergeChangedFiles(entries: ParsedStatusLine[]): CiReviewChangedFile[] {
  const map = new Map<string, CiReviewChangedFile>();
  for (const entry of entries) {
    const existing = map.get(entry.path);
    if (!existing) {
      map.set(entry.path, {
        path: entry.path,
        status: entry.status,
        sources: [...new Set(entry.sources)].sort() as CiReviewChangeSource[],
      });
      continue;
    }
    const sourceSet = new Set<CiReviewChangeSource>(existing.sources);
    for (const source of entry.sources) sourceSet.add(source);
    existing.sources = [...sourceSet].sort() as CiReviewChangeSource[];
    if (!existing.status.includes(entry.status)) {
      existing.status = `${existing.status},${entry.status}`;
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function pathMatches(path: string, pattern: RegExp): boolean {
  return pattern.test(normalizePath(path));
}

function collectRisks(files: CiReviewChangedFile[]): CiReviewFinding[] {
  const risks: CiReviewFinding[] = [];
  for (const file of files) {
    const path = file.path;
    const name = basename(path).toLowerCase();
    if (pathMatches(path, /(^|\/)\.github\/workflows\//)) {
      risks.push({
        severity: 'high',
        code: 'ci_workflow_changed',
        path,
        message:
          'CI workflow changed; review runner permissions, triggers, and secret exposure before merge.',
      });
    }
    if (pathMatches(path, /(^|\/)(prisma\/)?migrations?\//i)) {
      risks.push({
        severity: 'high',
        code: 'migration_changed',
        path,
        message: 'Database migration changed; require rollback/deploy sequencing review.',
      });
    }
    if (
      name === '.env' ||
      name.startsWith('.env.') ||
      /\.(pem|p12|pfx|key)$/i.test(name) ||
      pathMatches(path, /(^|\/)(secrets?|credentials?)\//i)
    ) {
      risks.push({
        severity: 'high',
        code: 'secret_candidate_changed',
        path,
        message:
          'Secret-like file changed; verify it is ignored, redacted, or intentionally test-only.',
      });
    }
    if (
      /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock)$/i.test(
        name,
      )
    ) {
      risks.push({
        severity: 'medium',
        code: 'lockfile_changed',
        path,
        message:
          'Dependency lockfile changed; review package provenance and install reproducibility.',
      });
    }
    if (
      /^(package\.json|pyproject\.toml|Cargo\.toml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts)$/i.test(
        name,
      )
    ) {
      risks.push({
        severity: 'medium',
        code: 'build_or_dependency_manifest_changed',
        path,
        message: 'Build or dependency manifest changed; confirm matching verification was run.',
      });
    }
  }
  return risks;
}

function isTestPath(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|specs?)\//i.test(path) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) ||
    /^tools\/test-/i.test(path) ||
    /^babel-cli\/scripts\/test_/i.test(path)
  );
}

function isSourcePath(path: string): boolean {
  return (
    /\.(ts|tsx|js|jsx|mjs|cjs|py|kt|java|go|rs)$/i.test(path) &&
    !isTestPath(path) &&
    !pathMatches(path, /(^|\/)(dist|node_modules|build|coverage)\//)
  );
}

function collectTestSignals(files: CiReviewChangedFile[]): CiReviewFinding[] {
  const paths = files.map((file) => file.path);
  const sourcePaths = paths.filter(isSourcePath);
  const testPaths = paths.filter(isTestPath);
  const signals: CiReviewFinding[] = [];
  if (sourcePaths.length > 0 && testPaths.length === 0) {
    signals.push({
      severity: 'medium',
      code: 'source_without_test_change',
      message:
        'Source files changed without an accompanying test or smoke harness change in this diff.',
    });
  }
  if (
    paths.some((path) => path === 'babel-cli/package.json') &&
    !paths.some((path) => path === 'babel-cli/package-lock.json')
  ) {
    signals.push({
      severity: 'info',
      code: 'package_manifest_without_lockfile',
      message:
        'babel-cli/package.json changed without package-lock.json; confirm dependency graph did not change.',
    });
  }
  return signals;
}

function buildPrDraft(
  files: CiReviewChangedFile[],
  risks: CiReviewFinding[],
  testSignals: CiReviewFinding[],
): CiReviewReport['pr_draft'] {
  const changed = files.length;
  const title =
    changed === 0
      ? 'No code changes detected'
      : `Review ${changed} changed file${changed === 1 ? '' : 's'}`;
  const summary =
    changed === 0
      ? ['No tracked, untracked, staged, or base-ref changes were detected.']
      : [
          `Changed files: ${changed}`,
          `Risk flags: ${risks.length}`,
          `Test signals: ${testSignals.length}`,
        ];
  const testPlan = [
    'Review this deterministic CI report.',
    risks.length > 0
      ? 'Manually inspect high/medium risk files before merge.'
      : 'No risk flags were detected by the deterministic scan.',
    testSignals.length > 0
      ? 'Run or document targeted tests for changed source paths.'
      : 'No missing-test signals were detected by the deterministic scan.',
  ];
  return { title, summary, test_plan: testPlan };
}

function recommendedNextAction(risks: CiReviewFinding[], testSignals: CiReviewFinding[]): string {
  if (risks.some((risk) => risk.severity === 'high')) {
    return 'Manual review required for high-risk files before merge.';
  }
  if (risks.length > 0 || testSignals.some((signal) => signal.severity !== 'info')) {
    return 'Review risk/test signals and attach verification evidence before merge.';
  }
  return 'No deterministic blockers found; proceed with normal review.';
}

function nullOnGitFailure(args: string[], cwd: string): string | null {
  const result = runGit(args, cwd);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

export function runCiReview(options: CiReviewOptions = {}): CiReviewReport {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  if (!existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }

  const repoRoot = requireGitOutput(
    ['rev-parse', '--show-toplevel'],
    projectRoot,
    'git repo discovery',
  );
  const statusResult = runGit(['status', '--porcelain=v1', '-uall'], repoRoot);
  if (statusResult.status !== 0) {
    const detail = (statusResult.stderr || statusResult.stdout || 'unknown git error').trim();
    throw new Error(`git status failed: ${detail}`);
  }
  const statusOutput = statusResult.stdout;
  const baseRef = options.baseRef?.trim() || null;
  const entries: ParsedStatusLine[] = parsePorcelainStatus(statusOutput);
  const diagnostics: CiReviewFinding[] = [];

  if (baseRef) {
    const baseDiff = runGit(
      ['diff', '--name-status', '--no-renames', `${baseRef}...HEAD`],
      repoRoot,
    );
    if (baseDiff.status === 0) {
      entries.push(...parseNameStatus(baseDiff.stdout, 'base'));
    } else {
      diagnostics.push({
        severity: 'medium',
        code: 'base_ref_diff_failed',
        message: `Unable to diff against base ref "${baseRef}": ${(baseDiff.stderr || baseDiff.stdout).trim()}`,
      });
    }
  }

  const changedFiles = mergeChangedFiles(
    entries.map((entry) => ({
      ...entry,
      path: entry.path.startsWith(repoRoot)
        ? relativeGitPath(repoRoot, entry.path)
        : normalizePath(entry.path),
    })),
  );
  const risks = collectRisks(changedFiles);
  const testSignals = collectTestSignals(changedFiles);
  const highRiskCount = risks.filter((risk) => risk.severity === 'high').length;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const outputDir = resolve(options.outputDir ?? join(BABEL_RUNS_DIR, 'ci-review'));
  const artifactPath = join(
    outputDir,
    `ci-review-${toArtifactTimestamp(new Date(generatedAt))}.json`,
  );
  const stagedCount = changedFiles.filter((file) => file.sources.includes('staged')).length;
  const unstagedCount = changedFiles.filter((file) => file.sources.includes('unstaged')).length;
  const untrackedCount = changedFiles.filter((file) => file.sources.includes('untracked')).length;
  const report: CiReviewReport = {
    schema_version: 1,
    review_type: 'babel_ci_review',
    generated_at: generatedAt,
    artifact_path: artifactPath,
    status:
      risks.length > 0 ||
      testSignals.some((signal) => signal.severity !== 'info') ||
      diagnostics.length > 0
        ? 'warn'
        : 'pass',
    project_root: projectRoot,
    delivery_policy: {
      read_only: true,
      mutates_git: false,
      remote_side_effects: false,
      draft_first: true,
    },
    git: {
      repo_root: repoRoot,
      branch: nullOnGitFailure(['branch', '--show-current'], repoRoot),
      head: nullOnGitFailure(['rev-parse', '--short', 'HEAD'], repoRoot),
      base_ref: baseRef,
      working_tree_dirty: changedFiles.length > 0,
      staged_count: stagedCount,
      unstaged_count: unstagedCount,
      untracked_count: untrackedCount,
    },
    summary: {
      changed_file_count: changedFiles.length,
      risk_count: risks.length,
      high_risk_count: highRiskCount,
      missing_test_signal_count: testSignals.filter((signal) => signal.severity !== 'info').length,
      recommended_next_action: recommendedNextAction(risks, testSignals),
    },
    changed_files: changedFiles,
    risks,
    test_signals: testSignals,
    pr_draft: buildPrDraft(changedFiles, risks, testSignals),
    diagnostics,
  };

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function formatCiReviewHuman(report: CiReviewReport): string {
  const lines = [
    'Babel CI Review',
    `Status: ${report.status}`,
    `Repo: ${report.git.repo_root}`,
    `Head: ${report.git.head ?? 'unknown'}${report.git.branch ? ` (${report.git.branch})` : ''}`,
    `Artifact: ${report.artifact_path}`,
    '',
    `Changed files: ${report.summary.changed_file_count}`,
    `Risk flags: ${report.summary.risk_count} (${report.summary.high_risk_count} high)`,
    `Missing-test signals: ${report.summary.missing_test_signal_count}`,
    `Next: ${report.summary.recommended_next_action}`,
  ];

  if (report.risks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of report.risks) {
      lines.push(
        `  [${risk.severity}] ${risk.code}${risk.path ? ` ${risk.path}` : ''}: ${risk.message}`,
      );
    }
  }
  if (report.test_signals.length > 0) {
    lines.push('', 'Test Signals:');
    for (const signal of report.test_signals) {
      lines.push(`  [${signal.severity}] ${signal.code}: ${signal.message}`);
    }
  }
  if (report.changed_files.length > 0) {
    lines.push('', 'Changed Files:');
    for (const file of report.changed_files.slice(0, 30)) {
      lines.push(`  ${file.path} (${file.sources.join(', ')})`);
    }
    if (report.changed_files.length > 30) {
      lines.push(`  ... ${report.changed_files.length - 30} more`);
    }
  }
  return lines.join('\n');
}
