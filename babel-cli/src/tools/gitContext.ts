import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitContextInput {
  /** Output format: summary (status + stat), files (list only), diff (full diff) */
  format?: 'summary' | 'files' | 'diff';
  /** Limit diff to specific path (project-relative) */
  path?: string;
  /** Max lines of diff output (default 200) */
  max_lines?: number;
}

export interface GitContextResult {
  /** Current branch name */
  branch: string;
  /** Whether we're in a git repository */
  inRepo: boolean;
  /** File status entries */
  files: GitFileStatus[];
  /** Diff stat summary (--stat format) */
  diffStat: string;
  /** Full diff output (truncated to max_lines) */
  diff: string;
  /** Whether diff was truncated */
  diffTruncated: boolean;
}

export interface GitFileStatus {
  status: string;
  path: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

function runGit(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    exitCode: result.status ?? 1,
  };
}

function isGitRepo(cwd: string): boolean {
  const gitDir = resolve(cwd, '.git');
  return existsSync(gitDir);
}

function parsePorcelain(stdout: string): GitFileStatus[] {
  if (!stdout) return [];
  return stdout
    .split('\n')
    .filter((line) => line.length >= 3)
    .map((line) => {
      const status = line.slice(0, 2).trim();
      let filePath = line.slice(3).trim();
      // Handle renamed files (R old -> new)
      const arrowIndex = filePath.indexOf(' -> ');
      if (arrowIndex >= 0) {
        filePath = filePath.slice(arrowIndex + 4);
      }
      return { status: status || '?', path: filePath };
    });
}

function formatFilesHuman(files: GitFileStatus[]): string {
  if (files.length === 0) return '(clean — no changes)';

  const labels: Record<string, string> = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    U: 'unmerged',
    '?': 'untracked',
    '!!': 'ignored',
    AM: 'added/modified',
    MM: 'modified (staged + unstaged)',
  };

  return files
    .map((f) => {
      const label = labels[f.status] ?? f.status;
      return `${f.status.padEnd(4)} ${label.padEnd(20)} ${f.path}`;
    })
    .join('\n');
}

/**
 * Gather git context for the current project root.
 * Non-mutating — runs read-only git commands (status, diff).
 */
export function gitContext(projectRoot: string, input: GitContextInput = {}): GitContextResult {
  const root = resolve(projectRoot);
  const inRepo = isGitRepo(root);

  const emptyResult: GitContextResult = {
    branch: 'unknown',
    inRepo: false,
    files: [],
    diffStat: '',
    diff: '',
    diffTruncated: false,
  };

  if (!inRepo) return emptyResult;

  // Get current branch
  const branchResult = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const branch = branchResult.exitCode === 0 ? branchResult.stdout : 'unknown';
  emptyResult.branch = branch;

  // Get status
  const statusResult = runGit(['status', '--porcelain'], root);
  const files = parsePorcelain(statusResult.stdout);

  // Get diff stat
  const statArgs = ['diff', '--stat', '--ignore-submodules'];
  if (input.path) statArgs.push('--', input.path);
  const statResult = runGit(statArgs, root);
  const diffStat = statResult.exitCode === 0 ? statResult.stdout : '';

  // Get full diff
  const format = input.format ?? 'summary';
  let diff = '';
  let diffTruncated = false;
  const maxLines = input.max_lines ?? 200;

  if (format === 'diff') {
    const diffArgs = ['diff', '--ignore-submodules', '--no-color'];
    if (input.path) diffArgs.push('--', input.path);
    const diffResult = runGit(diffArgs, root);
    if (diffResult.exitCode === 0) {
      const lines = diffResult.stdout.split('\n');
      if (lines.length > maxLines) {
        diff = lines.slice(0, maxLines).join('\n');
        diffTruncated = true;
      } else {
        diff = diffResult.stdout;
      }
    }
  }

  return {
    branch,
    inRepo,
    files,
    diffStat,
    diff,
    diffTruncated,
  };
}

/**
 * Format git context for human-readable output.
 */
export function formatGitContextHuman(
  result: GitContextResult,
  input: GitContextInput = {},
): string {
  if (!result.inRepo) {
    return 'Not a git repository (no .git directory found).';
  }

  const format = input.format ?? 'summary';
  const lines: string[] = [`Branch: ${result.branch}`];

  if (format === 'files') {
    const fileOutput = formatFilesHuman(result.files);
    lines.push(fileOutput || '(clean — no changes)');
    return lines.join('\n');
  }

  if (format === 'diff') {
    lines.push('');
    if (result.diff) {
      lines.push(result.diff);
      if (result.diffTruncated) {
        lines.push(`...[truncated after ${input.max_lines ?? 200} lines]`);
      }
    } else {
      lines.push('(no unstaged changes)');
    }
    return lines.join('\n');
  }

  // Summary format (default)
  const fileOutput = formatFilesHuman(result.files);
  lines.push(fileOutput);

  if (result.diffStat) {
    lines.push('');
    lines.push(result.diffStat);
  }

  return lines.join('\n');
}

/**
 * Handle the git_context executor tool call.
 */
export async function handleGitContextTool(
  input: GitContextInput & { output_format?: 'text' | 'json' },
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();

  try {
    const result = gitContext(projectRoot, input);

    const output =
      input.output_format === 'json'
        ? JSON.stringify({
            branch: result.branch,
            inRepo: result.inRepo,
            files: result.files,
            diffStat: result.diffStat,
            diff: input.format === 'diff' ? result.diff : undefined,
            diffTruncated: result.diffTruncated,
          })
        : formatGitContextHuman(result, input);

    return {
      exit_code: 0,
      stdout: output,
      stderr: '',
    };
  } catch (error: unknown) {
    return {
      exit_code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
