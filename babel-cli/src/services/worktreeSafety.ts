import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export type WorktreeRollbackStatus =
  | 'rollback_applied'
  | 'rollback_not_needed'
  | 'rollback_skipped_user_dirty_target'
  | 'rollback_failed';

export interface WorktreeGitSummary {
  git_root: string | null;
  branch: string | null;
  detached: boolean;
  status_summary: string[];
  dirty_files_before_run: string[];
  untracked_files_before_run: string[];
}

export interface WorktreeSnapshotRecord {
  relative_path: string;
  existed_before: boolean;
  hash_before: string | null;
  size_before: number | null;
  mtime_ms_before: number | null;
  backup_path: string | null;
  dirty_before_run: boolean;
  protected_path: boolean;
  attempt: number | null;
}

export interface WorktreeSafetySummary {
  schema_version: 1;
  artifact_type: 'babel_worktree_safety_summary';
  project_root: string | null;
  git: WorktreeGitSummary;
  protected_paths: string[];
  touched_files: string[];
  snapshot_count: number;
  snapshots: WorktreeSnapshotRecord[];
  target_dirty_conflicts: string[];
  protected_path_conflicts: string[];
  rollback_summary_path: string | null;
  next_recommended_operator_action: string;
}

export interface WorktreeRollbackSummary {
  schema_version: 1;
  artifact_type: 'babel_rollback_summary';
  status: WorktreeRollbackStatus;
  reason: string;
  restored_files: string[];
  removed_files: string[];
  rollback_not_needed_files: string[];
  dirty_files_preserved: string[];
  unrelated_untracked_files_preserved: string[];
  target_dirty_conflicts: string[];
  protected_path_conflicts: string[];
  failed_files: Array<{ path: string; error: string }>;
  changed_files_before_rollback: string[];
  changed_files_after_rollback: string[];
  next_recommended_operator_action: string;
}

export interface SnapshotBeforeWriteResult {
  ok: boolean;
  relativePath: string | null;
  status?: 'WORKTREE_DIRTY_UNSAFE';
  reason?: string;
}

const DEFAULT_PROTECTED_PATHS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'runs',
];

export class WorktreeSafetyController {
  readonly projectRoot: string | null;
  readonly backupRoot: string;
  readonly protectedPaths: string[];
  readonly git: WorktreeGitSummary;

  private readonly snapshots = new Map<string, WorktreeSnapshotRecord>();
  private readonly refusedTargetDirtyConflicts = new Set<string>();
  private readonly refusedProtectedPathConflicts = new Set<string>();
  private rollbackSummaryPath: string | null = null;

  constructor(input: {
    projectRoot: string | null | undefined;
    runDir: string;
    protectedPaths?: readonly string[];
  }) {
    this.projectRoot = input.projectRoot ? resolve(input.projectRoot) : null;
    this.backupRoot = join(input.runDir, 'worktree-safety-backups');
    this.protectedPaths = [...new Set([...(input.protectedPaths ?? DEFAULT_PROTECTED_PATHS)])]
      .map(path => normalizeRelativePath(path).replace(/\/+$/, ''))
      .filter(Boolean);
    this.git = scanGitSummary(this.projectRoot);
    mkdirSync(this.backupRoot, { recursive: true });
  }

  snapshotBeforeWrite(target: string, attempt: number | null = null): SnapshotBeforeWriteResult {
    const resolved = resolveTargetPath(this.projectRoot, target);
    if (!resolved) {
      return {
        ok: false,
        relativePath: null,
        status: 'WORKTREE_DIRTY_UNSAFE',
        reason: `Cannot resolve write target "${target}" inside the project root.`,
      };
    }
    const { absolutePath, relativePath } = resolved;
    const protectedPath = isProtectedRelativePath(relativePath, this.protectedPaths);
    if (protectedPath) {
      const reason = `Refusing to write protected path "${relativePath}".`;
      this.refusedProtectedPathConflicts.add(relativePath);
      return {
        ok: false,
        relativePath,
        status: 'WORKTREE_DIRTY_UNSAFE',
        reason,
      };
    }
    const dirtyBeforeRun = this.isDirtyBeforeRun(relativePath);
    if (dirtyBeforeRun) {
      this.refusedTargetDirtyConflicts.add(relativePath);
      return {
        ok: false,
        relativePath,
        status: 'WORKTREE_DIRTY_UNSAFE',
        reason: `Refusing to overwrite dirty target "${relativePath}" without an explicit override.`,
      };
    }
    if (!this.snapshots.has(relativePath)) {
      this.snapshots.set(relativePath, createSnapshotRecord({
        absolutePath,
        relativePath,
        backupRoot: this.backupRoot,
        dirtyBeforeRun,
        protectedPath,
        attempt,
      }));
    }
    return { ok: true, relativePath };
  }

  rollbackTouchedFiles(reason: string): WorktreeRollbackSummary {
    const changedBefore = this.changedTouchedFiles();
    const restoredFiles: string[] = [];
    const removedFiles: string[] = [];
    const rollbackNotNeededFiles: string[] = [];
    const dirtyPreserved = [...this.git.dirty_files_before_run].sort();
    const untrackedPreserved = [...this.git.untracked_files_before_run].sort();
    const failedFiles: Array<{ path: string; error: string }> = [];
    const targetDirtyConflicts = this.targetDirtyConflicts();
    const protectedPathConflicts = this.protectedPathConflicts();

    if (targetDirtyConflicts.length > 0) {
      const summary = this.finishRollbackSummary({
        status: 'rollback_skipped_user_dirty_target',
        reason: `${reason} Rollback skipped because target files were dirty before the run.`,
        restoredFiles,
        removedFiles,
        rollbackNotNeededFiles,
        dirtyPreserved,
        untrackedPreserved,
        targetDirtyConflicts,
        protectedPathConflicts,
        failedFiles,
        changedBefore,
      });
      return summary;
    }

    for (const snapshot of this.snapshots.values()) {
      if (shouldSimulateRollbackFailure(snapshot.relative_path)) {
        failedFiles.push({
          path: snapshot.relative_path,
          error: 'Simulated rollback failure via BABEL_SIMULATE_ROLLBACK_FAILURE.',
        });
        continue;
      }
      const absolutePath = this.absolutePathFor(snapshot.relative_path);
      if (!absolutePath) {
        failedFiles.push({ path: snapshot.relative_path, error: 'Project root unavailable.' });
        continue;
      }
      try {
        const currentHash = hashFileIfExists(absolutePath);
        if (currentHash === snapshot.hash_before) {
          rollbackNotNeededFiles.push(snapshot.relative_path);
          continue;
        }
        if (snapshot.existed_before) {
          if (!snapshot.backup_path || !existsSync(snapshot.backup_path)) {
            failedFiles.push({ path: snapshot.relative_path, error: 'Snapshot backup is missing.' });
            continue;
          }
          mkdirSync(dirname(absolutePath), { recursive: true });
          copyFileSync(snapshot.backup_path, absolutePath);
          restoredFiles.push(snapshot.relative_path);
        } else if (existsSync(absolutePath)) {
          rmSync(absolutePath, { force: true });
          removedFiles.push(snapshot.relative_path);
        } else {
          rollbackNotNeededFiles.push(snapshot.relative_path);
        }
      } catch (error) {
        failedFiles.push({
          path: snapshot.relative_path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const status: WorktreeRollbackStatus = failedFiles.length > 0
      ? 'rollback_failed'
      : restoredFiles.length > 0 || removedFiles.length > 0
        ? 'rollback_applied'
        : 'rollback_not_needed';

    return this.finishRollbackSummary({
      status,
      reason,
      restoredFiles,
      removedFiles,
      rollbackNotNeededFiles,
      dirtyPreserved,
      untrackedPreserved,
      targetDirtyConflicts,
      protectedPathConflicts,
      failedFiles,
      changedBefore,
    });
  }

  buildSummary(): WorktreeSafetySummary {
    const targetDirtyConflicts = this.targetDirtyConflicts();
    const protectedPathConflicts = this.protectedPathConflicts();
    return {
      schema_version: 1,
      artifact_type: 'babel_worktree_safety_summary',
      project_root: this.projectRoot,
      git: this.git,
      protected_paths: this.protectedPaths,
      touched_files: [...this.snapshots.keys()].sort(),
      snapshot_count: this.snapshots.size,
      snapshots: [...this.snapshots.values()].sort((a, b) => a.relative_path.localeCompare(b.relative_path)),
      target_dirty_conflicts: targetDirtyConflicts,
      protected_path_conflicts: protectedPathConflicts,
      rollback_summary_path: this.rollbackSummaryPath,
      next_recommended_operator_action: targetDirtyConflicts.length > 0
        ? 'Commit, stash, or move dirty target files before rerunning Babel.'
        : protectedPathConflicts.length > 0
          ? 'Choose non-protected source targets or explicitly handle generated/protected paths outside autonomous mode.'
          : 'Review rollback_summary.json after failed repair runs; no operator action is needed for clean successful runs.',
    };
  }

  setRollbackSummaryPath(path: string): void {
    this.rollbackSummaryPath = path;
  }

  private finishRollbackSummary(input: {
    status: WorktreeRollbackStatus;
    reason: string;
    restoredFiles: string[];
    removedFiles: string[];
    rollbackNotNeededFiles: string[];
    dirtyPreserved: string[];
    untrackedPreserved: string[];
    targetDirtyConflicts: string[];
    protectedPathConflicts: string[];
    failedFiles: Array<{ path: string; error: string }>;
    changedBefore: string[];
  }): WorktreeRollbackSummary {
    const changedAfter = this.changedTouchedFiles();
    return {
      schema_version: 1,
      artifact_type: 'babel_rollback_summary',
      status: input.status,
      reason: input.reason,
      restored_files: input.restoredFiles.sort(),
      removed_files: input.removedFiles.sort(),
      rollback_not_needed_files: input.rollbackNotNeededFiles.sort(),
      dirty_files_preserved: input.dirtyPreserved,
      unrelated_untracked_files_preserved: input.untrackedPreserved,
      target_dirty_conflicts: input.targetDirtyConflicts,
      protected_path_conflicts: input.protectedPathConflicts,
      failed_files: input.failedFiles,
      changed_files_before_rollback: input.changedBefore,
      changed_files_after_rollback: changedAfter,
      next_recommended_operator_action: nextActionForRollbackStatus(input.status),
    };
  }

  private changedTouchedFiles(): string[] {
    const changed: string[] = [];
    for (const snapshot of this.snapshots.values()) {
      const absolutePath = this.absolutePathFor(snapshot.relative_path);
      const currentHash = absolutePath ? hashFileIfExists(absolutePath) : null;
      if (currentHash !== snapshot.hash_before) {
        changed.push(snapshot.relative_path);
      }
    }
    return changed.sort();
  }

  private targetDirtyConflicts(): string[] {
    return [...new Set([
      ...this.refusedTargetDirtyConflicts,
      ...[...this.snapshots.values()]
      .filter(snapshot => snapshot.dirty_before_run)
      .map(snapshot => snapshot.relative_path),
    ])].sort();
  }

  private protectedPathConflicts(): string[] {
    return [...new Set([
      ...this.refusedProtectedPathConflicts,
      ...[...this.snapshots.values()]
      .filter(snapshot => snapshot.protected_path)
      .map(snapshot => snapshot.relative_path),
    ])].sort();
  }

  private absolutePathFor(relativePath: string): string | null {
    if (!this.projectRoot) {
      return null;
    }
    const absolutePath = resolve(this.projectRoot, relativePath);
    return isWithinRoot(this.projectRoot, absolutePath) ? absolutePath : null;
  }

  private isDirtyBeforeRun(relativePath: string): boolean {
    return this.git.dirty_files_before_run.includes(relativePath) ||
      this.git.untracked_files_before_run.includes(relativePath);
  }
}

export function createWorktreeSafetyController(input: {
  projectRoot: string | null | undefined;
  runDir: string;
  protectedPaths?: readonly string[];
}): WorktreeSafetyController {
  return new WorktreeSafetyController(input);
}

function createSnapshotRecord(input: {
  absolutePath: string;
  relativePath: string;
  backupRoot: string;
  dirtyBeforeRun: boolean;
  protectedPath: boolean;
  attempt: number | null;
}): WorktreeSnapshotRecord {
  const existsBefore = existsSync(input.absolutePath);
  let hashBefore: string | null = null;
  let sizeBefore: number | null = null;
  let mtimeMsBefore: number | null = null;
  let backupPath: string | null = null;
  if (existsBefore) {
    const stat = statSync(input.absolutePath);
    hashBefore = hashFileIfExists(input.absolutePath);
    sizeBefore = stat.size;
    mtimeMsBefore = stat.mtimeMs;
    const safeName = `${createHash('sha256').update(input.relativePath).digest('hex').slice(0, 16)}-${basename(input.relativePath)}.bak`;
    backupPath = join(input.backupRoot, safeName);
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(input.absolutePath, backupPath);
  }
  return {
    relative_path: input.relativePath,
    existed_before: existsBefore,
    hash_before: hashBefore,
    size_before: sizeBefore,
    mtime_ms_before: mtimeMsBefore,
    backup_path: backupPath,
    dirty_before_run: input.dirtyBeforeRun,
    protected_path: input.protectedPath,
    attempt: input.attempt,
  };
}

function scanGitSummary(projectRoot: string | null): WorktreeGitSummary {
  const base: WorktreeGitSummary = {
    git_root: null,
    branch: null,
    detached: false,
    status_summary: [],
    dirty_files_before_run: [],
    untracked_files_before_run: [],
  };
  if (!projectRoot || !existsSync(projectRoot)) {
    return base;
  }
  const gitRootResult = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (gitRootResult.status !== 0) {
    return base;
  }
  const gitRoot = String(gitRootResult.stdout ?? '').trim();
  if (!gitRoot) {
    return base;
  }
  const prefixResult = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--show-prefix'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const projectPrefix = normalizeRelativePath(String(prefixResult.stdout ?? '').trim())
    .replace(/\/+$/, '');
  const branchResult = spawnSync('git', ['-C', projectRoot, 'symbolic-ref', '--short', '-q', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const branch = String(branchResult.stdout ?? '').trim() || null;
  const statusResult = spawnSync('git', ['-C', projectRoot, 'status', '--porcelain=v1'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const statusLines = String(statusResult.stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
  const dirtyFiles: string[] = [];
  const untrackedFiles: string[] = [];
  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const rawPath = normalizeGitStatusPath(line.slice(3));
    const relativeToProject = gitStatusPathToProjectRelative(rawPath, projectPrefix);
    if (!relativeToProject) {
      continue;
    }
    if (code === '??') {
      untrackedFiles.push(relativeToProject);
    } else {
      dirtyFiles.push(relativeToProject);
    }
  }
  return {
    git_root: gitRoot,
    branch,
    detached: branch === null,
    status_summary: statusLines,
    dirty_files_before_run: [...new Set(dirtyFiles)].sort(),
    untracked_files_before_run: [...new Set(untrackedFiles)].sort(),
  };
}

function gitStatusPathToProjectRelative(rawPath: string, projectPrefix: string): string | null {
  const normalizedPath = normalizeRelativePath(rawPath);
  if (!normalizedPath) {
    return null;
  }
  if (!projectPrefix) {
    return normalizedPath;
  }
  const prefix = `${projectPrefix}/`;
  if (!normalizedPath.startsWith(prefix)) {
    return null;
  }
  const relativeToProject = normalizedPath.slice(prefix.length);
  return relativeToProject || null;
}

function normalizeGitStatusPath(raw: string): string {
  const renamed = raw.includes(' -> ') ? raw.split(' -> ').at(-1) ?? raw : raw;
  return renamed.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function resolveTargetPath(projectRoot: string | null, target: string): {
  absolutePath: string;
  relativePath: string;
} | null {
  if (!projectRoot) {
    return null;
  }
  const normalizedTarget = target.replace(/\\/g, '/');
  const projectRelative = normalizedTarget.startsWith('/project/')
    ? normalizedTarget.slice('/project/'.length)
    : normalizedTarget.startsWith('/app/')
      ? normalizedTarget.slice('/app/'.length)
      : normalizedTarget;
  const absolutePath = isAbsolute(projectRelative)
    ? resolve(projectRelative)
    : resolve(projectRoot, projectRelative);
  if (!isWithinRoot(projectRoot, absolutePath)) {
    return null;
  }
  return {
    absolutePath,
    relativePath: relative(projectRoot, absolutePath).replace(/\\/g, '/'),
  };
}

function isProtectedRelativePath(relativePath: string, protectedPaths: readonly string[]): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return protectedPaths.some(protectedPath =>
    normalized === protectedPath || normalized.startsWith(`${protectedPath}/`)
  );
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`) ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function hashFileIfExists(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function shouldSimulateRollbackFailure(relativePath: string): boolean {
  const raw = process.env['BABEL_SIMULATE_ROLLBACK_FAILURE_FOR'] ??
    (process.env['BABEL_SIMULATE_ROLLBACK_FAILURE'] === 'true' ? relativePath : '');
  if (!raw) {
    return false;
  }
  return raw.split(',').map(value => normalizeRelativePath(value.trim())).some(value =>
    value === '*' || value === normalizeRelativePath(relativePath)
  );
}

function nextActionForRollbackStatus(status: WorktreeRollbackStatus): string {
  switch (status) {
    case 'rollback_applied':
      return 'Inspect rollback_summary.json, then retry with a revised repair strategy if the task should continue.';
    case 'rollback_not_needed':
      return 'No rollback changes were needed; inspect verifier output for the next action.';
    case 'rollback_skipped_user_dirty_target':
      return 'Commit, stash, or move dirty target files before rerunning Babel.';
    case 'rollback_failed':
      return 'Stop and manually inspect touched files; automatic rollback did not complete.';
  }
}
