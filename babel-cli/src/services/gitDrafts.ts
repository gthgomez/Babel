import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { runGitCommand } from '../utils/gitExec.js';

export type GitDraftKind = 'diff_summary' | 'commit_draft' | 'pr_draft';
type ChangeSource = 'base' | 'staged' | 'unstaged' | 'untracked';

export interface GitDraftChangedFile {
  path: string;
  status: string;
  sources: ChangeSource[];
  additions: number | null;
  deletions: number | null;
}

export interface GitDraftDiagnostic {
  severity: 'info' | 'warn';
  code: string;
  message: string;
}

export interface GitDraftReport {
  schema_version: 1;
  draft_type: GitDraftKind;
  generated_at: string;
  artifact_path: string;
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
    dirty: boolean;
  };
  summary: {
    changed_file_count: number;
    insertions: number;
    deletions: number;
    files_with_stats: number;
    recommended_next_action: string;
  };
  changed_files: GitDraftChangedFile[];
  diffstat: string[];
  commit_draft: {
    subject: string;
    body: string[];
  } | null;
  pr_draft: {
    title: string;
    summary: string[];
    test_plan: string[];
    review_notes: string[];
  } | null;
  diagnostics: GitDraftDiagnostic[];
}

export interface GitDraftOptions {
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

interface ParsedChange {
  path: string;
  status: string;
  sources: ChangeSource[];
}

interface NumstatEntry {
  path: string;
  additions: number | null;
  deletions: number | null;
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

function nullOnGitFailure(args: string[], cwd: string): string | null {
  const result = runGit(args, cwd);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function toArtifactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function parsePorcelainStatus(stdout: string): ParsedChange[] {
  const changes: ParsedChange[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rawPath = line.slice(3).trim();
    const path = normalizePath(
      rawPath.includes(' -> ') ? (rawPath.split(' -> ').at(-1) ?? rawPath) : rawPath,
    );
    const sources: ChangeSource[] = [];
    if (x === '?' && y === '?') {
      sources.push('untracked');
    } else {
      if (x !== ' ') sources.push('staged');
      if (y !== ' ') sources.push('unstaged');
    }
    changes.push({
      path,
      status: `${x}${y}`.trim() || 'M',
      sources,
    });
  }
  return changes;
}

function parseNameStatus(stdout: string, source: ChangeSource): ParsedChange[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...pathParts] = line.split(/\s+/);
      return {
        path: normalizePath(pathParts.join(' ')),
        status: status ?? 'M',
        sources: [source],
      };
    });
}

function parseNumstat(stdout: string): NumstatEntry[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [additionsRaw, deletionsRaw, ...pathParts] = line.split(/\s+/);
      const additions = additionsRaw === '-' ? null : Number.parseInt(additionsRaw ?? '0', 10);
      const deletions = deletionsRaw === '-' ? null : Number.parseInt(deletionsRaw ?? '0', 10);
      return {
        path: normalizePath(pathParts.join(' ')),
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null,
      };
    });
}

function collectNumstats(
  repoRoot: string,
  baseRef: string | null,
  diagnostics: GitDraftDiagnostic[],
): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const specs: string[][] = [
    ['diff', '--numstat'],
    ['diff', '--cached', '--numstat'],
  ];
  if (baseRef) {
    specs.push(['diff', '--numstat', `${baseRef}...HEAD`]);
  }
  for (const args of specs) {
    const result = runGit(args, repoRoot);
    if (result.status === 0) {
      entries.push(...parseNumstat(result.stdout));
    } else if (baseRef && args.includes(`${baseRef}...HEAD`)) {
      diagnostics.push({
        severity: 'warn',
        code: 'base_ref_numstat_failed',
        message: `Unable to calculate numstat against ${baseRef}: ${(result.stderr || result.stdout).trim()}`,
      });
    }
  }
  return entries;
}

function estimateUntrackedTextStats(repoRoot: string, path: string): NumstatEntry {
  const fullPath = resolve(repoRoot, path);
  try {
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return { path, additions: null, deletions: null };
    }
    const buffer = readFileSync(fullPath);
    if (buffer.includes(0)) {
      return { path, additions: null, deletions: null };
    }
    const text = buffer.toString('utf8');
    const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    return { path, additions: lines, deletions: 0 };
  } catch {
    return { path, additions: null, deletions: null };
  }
}

function mergeChanges(changes: ParsedChange[], numstats: NumstatEntry[]): GitDraftChangedFile[] {
  const statMap = new Map<string, NumstatEntry>();
  for (const stat of numstats) {
    const current = statMap.get(stat.path);
    statMap.set(stat.path, {
      path: stat.path,
      additions:
        current?.additions === null || stat.additions === null
          ? null
          : (current?.additions ?? 0) + stat.additions,
      deletions:
        current?.deletions === null || stat.deletions === null
          ? null
          : (current?.deletions ?? 0) + stat.deletions,
    });
  }

  const map = new Map<string, GitDraftChangedFile>();
  for (const change of changes) {
    const existing = map.get(change.path);
    if (!existing) {
      const stat = statMap.get(change.path);
      map.set(change.path, {
        path: change.path,
        status: change.status,
        sources: [...new Set(change.sources)].sort() as ChangeSource[],
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
      });
      continue;
    }
    const sourceSet = new Set<ChangeSource>(existing.sources);
    for (const source of change.sources) sourceSet.add(source);
    existing.sources = [...sourceSet].sort() as ChangeSource[];
    if (!existing.status.includes(change.status)) {
      existing.status = `${existing.status},${change.status}`;
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function makeScope(files: GitDraftChangedFile[]): string {
  const topLevels = [...new Set(files.map((file) => file.path.split('/')[0] ?? file.path))]
    .filter(Boolean)
    .sort();
  if (topLevels.length === 0) return 'repo';
  if (topLevels.length === 1) return topLevels[0] ?? 'repo';
  if (topLevels.includes('babel-cli')) return 'cli';
  if (topLevels.includes('docs')) return 'docs';
  return 'workspace';
}

function makeSubject(files: GitDraftChangedFile[]): string {
  if (files.length === 0) return 'chore(repo): no changes detected';
  const scope = makeScope(files);
  const hasDocsOnly = files.every(
    (file) => file.path.startsWith('docs/') || /\.(md|txt)$/i.test(file.path),
  );
  const hasTests = files.some(
    (file) => /\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(file.path) || file.path.includes('/test_'),
  );
  const hasImplementation = files.some(
    (file) =>
      /\.(ts|tsx|js|jsx|mjs|cjs|py|kt|java|go|rs)$/i.test(file.path) &&
      !/\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(file.path) &&
      !file.path.includes('/test_'),
  );
  const type = hasDocsOnly ? 'docs' : hasImplementation ? 'feat' : hasTests ? 'test' : 'chore';
  return `${type}(${scope}): draft ${files.length} file change${files.length === 1 ? '' : 's'}`;
}

function buildCommitDraft(files: GitDraftChangedFile[]): GitDraftReport['commit_draft'] {
  const subject = makeSubject(files);
  const body =
    files.length === 0
      ? ['No changes detected.']
      : [
          `Changed files: ${files.length}`,
          ...files.slice(0, 12).map((file) => `- ${file.path}`),
          ...(files.length > 12 ? [`- ... ${files.length - 12} more`] : []),
        ];
  return { subject, body };
}

function buildPrDraft(
  files: GitDraftChangedFile[],
  commitDraft: NonNullable<GitDraftReport['commit_draft']>,
): GitDraftReport['pr_draft'] {
  return {
    title: commitDraft.subject.replace(/^[a-z]+(?:\([^)]+\))?:\s*/, ''),
    summary:
      files.length === 0
        ? ['No changes detected.']
        : [
            `Changed files: ${files.length}`,
            `Primary scope: ${makeScope(files)}`,
            `Draft commit: ${commitDraft.subject}`,
          ],
    test_plan: [
      'Run targeted tests for changed areas.',
      'Run `babel ci review --json` before merge.',
      'Attach generated Git draft evidence for reviewer context.',
    ],
    review_notes: [
      'Draft-only surface: no commit, push, branch, or PR side effect was performed.',
      'Review generated subject/body before using them in Git or GitHub.',
    ],
  };
}

function recommendedNextAction(kind: GitDraftKind, changedCount: number): string {
  if (changedCount === 0) return 'No changes detected; no draft action needed.';
  if (kind === 'diff_summary')
    return 'Review diff summary, then generate commit/PR drafts if the scope is coherent.';
  if (kind === 'commit_draft')
    return 'Review the commit draft before running any git commit command manually.';
  return 'Review PR metadata and CI evidence before opening a PR manually.';
}

export function runGitDraft(kind: GitDraftKind, options: GitDraftOptions = {}): GitDraftReport {
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
  const diagnostics: GitDraftDiagnostic[] = [];
  const changes = parsePorcelainStatus(statusOutput);
  if (baseRef) {
    const baseDiff = runGit(
      ['diff', '--name-status', '--no-renames', `${baseRef}...HEAD`],
      repoRoot,
    );
    if (baseDiff.status === 0) {
      changes.push(...parseNameStatus(baseDiff.stdout, 'base'));
    } else {
      diagnostics.push({
        severity: 'warn',
        code: 'base_ref_diff_failed',
        message: `Unable to diff against ${baseRef}: ${(baseDiff.stderr || baseDiff.stdout).trim()}`,
      });
    }
  }

  const numstats = collectNumstats(repoRoot, baseRef, diagnostics);
  for (const change of changes.filter((entry) => entry.sources.includes('untracked'))) {
    numstats.push(estimateUntrackedTextStats(repoRoot, change.path));
  }
  const changedFiles = mergeChanges(changes, numstats);
  const insertions = changedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = changedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const filesWithStats = changedFiles.filter(
    (file) => file.additions !== null && file.deletions !== null,
  ).length;
  const commitDraft =
    kind === 'commit_draft' || kind === 'pr_draft' ? buildCommitDraft(changedFiles) : null;
  const prDraft =
    kind === 'pr_draft' && commitDraft ? buildPrDraft(changedFiles, commitDraft) : null;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const outputDir = resolve(options.outputDir ?? join(BABEL_RUNS_DIR, 'git-drafts'));
  const artifactPath = join(
    outputDir,
    `git-${kind.replace('_', '-')}-${toArtifactTimestamp(new Date(generatedAt))}.json`,
  );
  const report: GitDraftReport = {
    schema_version: 1,
    draft_type: kind,
    generated_at: generatedAt,
    artifact_path: artifactPath,
    project_root: projectRoot,
    delivery_policy: {
      read_only: true,
      mutates_git: false,
      remote_side_effects: false,
      draft_first: true,
    },
    git: {
      repo_root: normalizePath(repoRoot),
      branch: nullOnGitFailure(['branch', '--show-current'], repoRoot),
      head: nullOnGitFailure(['rev-parse', '--short', 'HEAD'], repoRoot),
      base_ref: baseRef,
      dirty: changedFiles.length > 0,
    },
    summary: {
      changed_file_count: changedFiles.length,
      insertions,
      deletions,
      files_with_stats: filesWithStats,
      recommended_next_action: recommendedNextAction(kind, changedFiles.length),
    },
    changed_files: changedFiles,
    diffstat: changedFiles.map((file) => {
      const stats =
        file.additions === null || file.deletions === null
          ? 'binary/unknown'
          : `+${file.additions}/-${file.deletions}`;
      return `${file.path} ${file.status} ${stats}`;
    }),
    commit_draft: commitDraft,
    pr_draft: prDraft,
    diagnostics,
  };

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function formatGitDraftHuman(report: GitDraftReport): string {
  const lines = [
    'Babel Git Draft',
    `Type: ${report.draft_type}`,
    `Repo: ${report.git.repo_root}`,
    `Head: ${report.git.head ?? 'unknown'}${report.git.branch ? ` (${report.git.branch})` : ''}`,
    `Artifact: ${report.artifact_path}`,
    '',
    `Changed files: ${report.summary.changed_file_count}`,
    `Insertions/deletions: +${report.summary.insertions}/-${report.summary.deletions}`,
    `Next: ${report.summary.recommended_next_action}`,
  ];
  if (report.commit_draft) {
    lines.push('', 'Commit Draft:', `  ${report.commit_draft.subject}`);
    for (const line of report.commit_draft.body) {
      lines.push(`  ${line}`);
    }
  }
  if (report.pr_draft) {
    lines.push('', 'PR Draft:', `  Title: ${report.pr_draft.title}`, '  Summary:');
    for (const line of report.pr_draft.summary) {
      lines.push(`  - ${line}`);
    }
    lines.push('  Test Plan:');
    for (const line of report.pr_draft.test_plan) {
      lines.push(`  - ${line}`);
    }
  }
  if (report.diffstat.length > 0) {
    lines.push('', 'Diff Summary:');
    for (const line of report.diffstat.slice(0, 30)) {
      lines.push(`  ${line}`);
    }
    if (report.diffstat.length > 30) {
      lines.push(`  ... ${report.diffstat.length - 30} more`);
    }
  }
  if (report.diagnostics.length > 0) {
    lines.push('', 'Diagnostics:');
    for (const diagnostic of report.diagnostics) {
      lines.push(`  [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  return lines.join('\n');
}
