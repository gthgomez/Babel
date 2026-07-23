import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { ToolCallRequest } from '../localTools.js';
import { BABEL_RUNS_DIR } from '../cli/constants.js';

export type CheckpointTool = 'file_write' | 'shell_exec' | 'test_run';
export type CheckpointRestoreStatus = 'available' | 'metadata_only';

export interface CheckpointFileSnapshot {
  path: string;
  project_relative_path: string | null;
  existed: boolean;
  size_bytes: number;
  sha256: string | null;
  mtime_ms?: number;
  content_base64: string | null;
  skipped_reason?: string;
}

export interface CheckpointFilePostState {
  path: string;
  existed: boolean;
  size_bytes: number;
  sha256: string | null;
  mtime_ms?: number;
}

export interface CheckpointFilesystemSnapshotMetadata {
  strategy: 'bounded_project_snapshot';
  root: string;
  before_artifact: string;
  file_count: number;
  overflow: boolean;
  max_files: number;
  max_file_bytes: number;
  max_total_bytes: number;
}

export interface CheckpointFilesystemDiffSummary {
  strategy: 'bounded_project_snapshot';
  modified_files: number;
  created_files: number;
  deleted_files: number;
  restore_file_count: number;
  overflow: boolean;
  notes: string[];
}

export interface CheckpointRecord {
  schema_version: 1;
  id: string;
  run_id: string;
  run_dir: string;
  created_at: string;
  updated_at: string;
  tool: CheckpointTool;
  target: string;
  project_root: string | null;
  shadow_root: string | null;
  dry_run: boolean;
  triggering_tool_call: Record<string, unknown>;
  restore_status: CheckpointRestoreStatus;
  files: CheckpointFileSnapshot[];
  post_states: CheckpointFilePostState[];
  filesystem_snapshot?: CheckpointFilesystemSnapshotMetadata;
  filesystem_diff?: CheckpointFilesystemDiffSummary;
  notes: string[];
}

export interface CheckpointIndex {
  schema_version: 1;
  run_id: string;
  run_dir: string;
  updated_at: string;
  checkpoints: Array<{
    id: string;
    created_at: string;
    tool: CheckpointTool;
    target: string;
    restore_status: CheckpointRestoreStatus;
    file_count: number;
  }>;
}

export interface ToolCheckpointContext {
  runId: string;
  runDir?: string;
  babelRoot: string;
}

export interface RestoreCheckpointOptions {
  force?: boolean;
}

export interface RestoreCheckpointResult {
  status: 'restored' | 'refused';
  checkpoint_id: string;
  run_dir: string;
  restored_files: string[];
  refused_files: Array<{
    path: string;
    reason: string;
  }>;
  notes: string[];
}

interface FilesystemSnapshotArtifact {
  schema_version: 1;
  strategy: 'bounded_project_snapshot';
  root: string;
  captured_at: string;
  overflow: boolean;
  max_files: number;
  max_file_bytes: number;
  max_total_bytes: number;
  files: CheckpointFileSnapshot[];
  notes: string[];
}

interface CaptureBudget {
  remainingTotalBytes: number;
}

const CHECKPOINT_SNAPSHOT_EXCLUDED_DIRS = new Set([
  '.git',
  '.gradle',
  '.mypy_cache',
  '.next',
  '.pytest_cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'cache',
  'node_modules',
  'runs',
  'venv',
]);

const CHECKPOINT_SENSITIVE_FILE_RE = /(^|\/)(\.env(\..*)?|.*\.(key|pem|p12|pfx|crt|cer))$/i;

function isCheckpointTool(tool: string): tool is CheckpointTool {
  return tool === 'file_write' || tool === 'shell_exec' || tool === 'test_run';
}

export function shouldCheckpointToolCall(req: ToolCallRequest): boolean {
  return isCheckpointTool(req.tool);
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function getRunDir(context: ToolCheckpointContext): string {
  return context.runDir ?? join(context.babelRoot, 'runs', context.runId);
}

function getCheckpointRoot(runDir: string): string {
  return join(runDir, 'checkpoints');
}

function getCheckpointDir(runDir: string, checkpointId: string): string {
  return join(getCheckpointRoot(runDir), checkpointId);
}

function getCheckpointMetadataPath(runDir: string, checkpointId: string): string {
  return join(getCheckpointDir(runDir, checkpointId), 'metadata.json');
}

function getCheckpointArtifactPath(runDir: string, checkpointId: string, filename: string): string {
  return join(getCheckpointDir(runDir, checkpointId), filename);
}

function getCheckpointIndexPath(runDir: string): string {
  return join(getCheckpointRoot(runDir), 'checkpoints.json');
}

function getCheckpointRelativeArtifactPath(checkpointId: string, filename: string): string {
  return `checkpoints/${checkpointId}/${filename}`;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readCheckpointIndex(runDir: string, runId: string): CheckpointIndex {
  const indexPath = getCheckpointIndexPath(runDir);
  if (!existsSync(indexPath)) {
    return {
      schema_version: 1,
      run_id: runId,
      run_dir: runDir,
      updated_at: new Date(0).toISOString(),
      checkpoints: [],
    };
  }

  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8')) as CheckpointIndex;
  } catch {
    return {
      schema_version: 1,
      run_id: runId,
      run_dir: runDir,
      updated_at: new Date(0).toISOString(),
      checkpoints: [],
    };
  }
}

function writeCheckpointRecord(record: CheckpointRecord): void {
  const checkpointDir = getCheckpointDir(record.run_dir, record.id);
  mkdirSync(checkpointDir, { recursive: true });
  // Phase 5c: Atomic write via temp-file + rename to prevent corruption on crash.
  // A crash during direct writeFileSync would leave a truncated metadata.json.
  const targetPath = getCheckpointMetadataPath(record.run_dir, record.id);
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  try {
    renameSync(tmpPath, targetPath);
  } catch {
    // Fallback: if rename fails (cross-device), write directly
    writeFileSync(targetPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
  }
}

function upsertCheckpointIndex(record: CheckpointRecord): void {
  const root = getCheckpointRoot(record.run_dir);
  mkdirSync(root, { recursive: true });
  const index = readCheckpointIndex(record.run_dir, record.run_id);
  const entry = {
    id: record.id,
    created_at: record.created_at,
    tool: record.tool,
    target: record.target,
    restore_status: record.restore_status,
    file_count: record.files.length,
  };
  const existing = index.checkpoints.findIndex((item) => item.id === record.id);
  const checkpoints =
    existing >= 0
      ? index.checkpoints.map((item, i) => (i === existing ? entry : item))
      : [...index.checkpoints, entry];

  const next: CheckpointIndex = {
    schema_version: 1,
    run_id: record.run_id,
    run_dir: record.run_dir,
    updated_at: record.updated_at,
    checkpoints,
  };
  writeFileSync(
    getCheckpointIndexPath(record.run_dir),
    `${JSON.stringify(next, null, 2)}\n`,
    'utf-8',
  );
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  if (process.platform === 'win32') {
    const normalizedRoot = root.toLowerCase();
    const normalizedCandidate = candidate.toLowerCase();
    return (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(`${normalizedRoot}\\`)
    );
  }
  return candidate === root || candidate.startsWith(`${root}/`);
}

function captureFile(
  path: string,
  projectRoot: string | null,
  options: {
    includeContent?: boolean;
    maxFileBytes?: number;
    budget?: CaptureBudget;
  } = {},
): CheckpointFileSnapshot {
  if (!existsSync(path)) {
    return {
      path,
      project_relative_path:
        projectRoot && isWithinRoot(projectRoot, path)
          ? relative(projectRoot, path).replace(/\\/g, '/')
          : null,
      existed: false,
      size_bytes: 0,
      sha256: null,
      content_base64: null,
    };
  }

  const stats = statSync(path);
  if (!stats.isFile()) {
    return {
      path,
      project_relative_path:
        projectRoot && isWithinRoot(projectRoot, path)
          ? relative(projectRoot, path).replace(/\\/g, '/')
          : null,
      existed: true,
      size_bytes: stats.size,
      sha256: null,
      mtime_ms: stats.mtimeMs,
      content_base64: null,
      skipped_reason: 'not_regular_file',
    };
  }

  const includeContent = options.includeContent !== false;
  const maxFileBytes = options.maxFileBytes ?? Number.POSITIVE_INFINITY;
  const budget = options.budget;
  const skippedReasons: string[] = [];
  if (!includeContent) {
    skippedReasons.push('content_capture_disabled');
  }
  if (stats.size > maxFileBytes) {
    skippedReasons.push(`file_exceeds_${maxFileBytes}_byte_checkpoint_limit`);
  }
  if (budget && stats.size > budget.remainingTotalBytes) {
    skippedReasons.push('checkpoint_total_content_budget_exhausted');
  }
  if (skippedReasons.length > 0) {
    return {
      path,
      project_relative_path:
        projectRoot && isWithinRoot(projectRoot, path)
          ? relative(projectRoot, path).replace(/\\/g, '/')
          : null,
      existed: true,
      size_bytes: stats.size,
      sha256: null,
      mtime_ms: stats.mtimeMs,
      content_base64: null,
      skipped_reason: skippedReasons.join('; '),
    };
  }

  const content = readFileSync(path);
  if (budget) {
    budget.remainingTotalBytes -= stats.size;
  }
  return {
    path,
    project_relative_path:
      projectRoot && isWithinRoot(projectRoot, path)
        ? relative(projectRoot, path).replace(/\\/g, '/')
        : null,
    existed: true,
    size_bytes: stats.size,
    sha256: hashBuffer(content),
    mtime_ms: stats.mtimeMs,
    content_base64: content.toString('base64'),
  };
}

function capturePostState(path: string): CheckpointFilePostState {
  if (!existsSync(path)) {
    return {
      path,
      existed: false,
      size_bytes: 0,
      sha256: null,
    };
  }

  const stats = statSync(path);
  if (!stats.isFile()) {
    return {
      path,
      existed: true,
      size_bytes: stats.size,
      sha256: null,
      mtime_ms: stats.mtimeMs,
    };
  }

  const content = readFileSync(path);
  return {
    path,
    existed: true,
    size_bytes: stats.size,
    sha256: hashBuffer(content),
    mtime_ms: stats.mtimeMs,
  };
}

function isExcludedSnapshotDirectory(name: string): boolean {
  return CHECKPOINT_SNAPSHOT_EXCLUDED_DIRS.has(name.toLowerCase());
}

function isSensitiveSnapshotFile(relativePath: string): boolean {
  return CHECKPOINT_SENSITIVE_FILE_RE.test(relativePath.replace(/\\/g, '/'));
}

function collectSnapshotFilePaths(
  root: string,
  maxFiles: number,
): { files: string[]; overflow: boolean; notes: string[] } {
  const files: string[] = [];
  const notes: string[] = [];
  let overflow = false;

  function walk(dir: string): void {
    if (files.length >= maxFiles) {
      overflow = true;
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      notes.push(
        `Unable to read checkpoint snapshot directory "${dir}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= maxFiles) {
        overflow = true;
        return;
      }

      const fullPath = join(dir, entry.name);
      const relativePath = relative(root, fullPath).replace(/\\/g, '/');
      let stats;
      try {
        stats = lstatSync(fullPath);
      } catch (err) {
        notes.push(
          `Unable to stat checkpoint snapshot path "${relativePath}": ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if (stats.isSymbolicLink()) {
        notes.push(`Skipped symlink during checkpoint snapshot: ${relativePath}`);
        continue;
      }

      if (stats.isDirectory()) {
        if (!isExcludedSnapshotDirectory(entry.name)) {
          walk(fullPath);
        }
        continue;
      }

      if (!stats.isFile()) {
        continue;
      }

      if (isSensitiveSnapshotFile(relativePath)) {
        notes.push(`Skipped sensitive-looking file during checkpoint snapshot: ${relativePath}`);
        continue;
      }

      files.push(fullPath);
    }
  }

  if (!existsSync(root)) {
    return {
      files: [],
      overflow: false,
      notes: [`Checkpoint snapshot root does not exist: ${root}`],
    };
  }

  walk(root);
  if (overflow) {
    notes.push(
      `Checkpoint snapshot reached the ${maxFiles} file limit; restore coverage is partial.`,
    );
  }
  return { files, overflow, notes };
}

function createFilesystemSnapshotArtifact(root: string): FilesystemSnapshotArtifact {
  const maxFiles = readPositiveIntegerEnv('BABEL_CHECKPOINT_MAX_FILES', 5000);
  const maxFileBytes = readPositiveIntegerEnv('BABEL_CHECKPOINT_MAX_FILE_BYTES', 1024 * 1024);
  const maxTotalBytes = readPositiveIntegerEnv(
    'BABEL_CHECKPOINT_MAX_TOTAL_BYTES',
    20 * 1024 * 1024,
  );
  const collected = collectSnapshotFilePaths(root, maxFiles);
  const budget: CaptureBudget = { remainingTotalBytes: maxTotalBytes };
  const files = collected.files.map((filePath) =>
    captureFile(filePath, root, {
      includeContent: true,
      maxFileBytes,
      budget,
    }),
  );
  const contentSkipped = files.filter(
    (file) => file.existed && file.content_base64 === null,
  ).length;
  const notes = [...collected.notes];
  if (contentSkipped > 0) {
    notes.push(
      `${contentSkipped} file(s) were tracked as metadata-only because of checkpoint snapshot limits.`,
    );
  }

  return {
    schema_version: 1,
    strategy: 'bounded_project_snapshot',
    root,
    captured_at: new Date().toISOString(),
    overflow: collected.overflow,
    max_files: maxFiles,
    max_file_bytes: maxFileBytes,
    max_total_bytes: maxTotalBytes,
    files,
    notes,
  };
}

function writeCheckpointJsonArtifact(
  runDir: string,
  checkpointId: string,
  filename: string,
  data: unknown,
): void {
  const path = getCheckpointArtifactPath(runDir, checkpointId, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function readFilesystemSnapshotArtifact(
  record: CheckpointRecord,
): FilesystemSnapshotArtifact | null {
  const artifact = record.filesystem_snapshot?.before_artifact;
  if (!artifact) {
    return null;
  }
  const path = join(record.run_dir, artifact);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as FilesystemSnapshotArtifact;
}

function postStateMatchesSnapshot(
  snapshot: CheckpointFileSnapshot,
  postState: CheckpointFilePostState,
): boolean {
  if (snapshot.existed !== postState.existed) {
    return false;
  }
  if (!snapshot.existed && !postState.existed) {
    return true;
  }
  if (snapshot.size_bytes !== postState.size_bytes) {
    return false;
  }
  if (snapshot.sha256 !== null && postState.sha256 !== null) {
    return snapshot.sha256 === postState.sha256;
  }
  if (snapshot.mtime_ms !== undefined && postState.mtime_ms !== undefined) {
    return snapshot.mtime_ms === postState.mtime_ms;
  }
  return true;
}

function createPriorMissingSnapshot(path: string, projectRoot: string): CheckpointFileSnapshot {
  return {
    path,
    project_relative_path: isWithinRoot(projectRoot, path)
      ? relative(projectRoot, path).replace(/\\/g, '/')
      : null,
    existed: false,
    size_bytes: 0,
    sha256: null,
    content_base64: null,
  };
}

function computeRestoreStatus(files: CheckpointFileSnapshot[]): CheckpointRestoreStatus {
  return files.some((file) => file.content_base64 !== null || !file.existed)
    ? 'available'
    : 'metadata_only';
}

function finalizeFilesystemDiff(record: CheckpointRecord): {
  files: CheckpointFileSnapshot[];
  filesystemDiff: CheckpointFilesystemDiffSummary;
  notes: string[];
} {
  const before = readFilesystemSnapshotArtifact(record);
  const notes: string[] = [];
  if (!before) {
    return {
      files: [],
      filesystemDiff: {
        strategy: 'bounded_project_snapshot',
        modified_files: 0,
        created_files: 0,
        deleted_files: 0,
        restore_file_count: 0,
        overflow: false,
        notes: ['Filesystem checkpoint snapshot artifact was unavailable at finalization time.'],
      },
      notes: ['Filesystem checkpoint snapshot artifact was unavailable at finalization time.'],
    };
  }

  notes.push(...before.notes);
  const afterCollected = collectSnapshotFilePaths(before.root, before.max_files);
  notes.push(...afterCollected.notes);
  const afterMap = new Map(
    afterCollected.files.map((filePath) => [resolve(filePath), capturePostState(filePath)]),
  );
  const beforeMap = new Map(before.files.map((file) => [resolve(file.path), file]));
  const restoreFiles: CheckpointFileSnapshot[] = [];
  let modifiedFiles = 0;
  let deletedFiles = 0;
  let createdFiles = 0;

  for (const [path, prior] of beforeMap.entries()) {
    const post = afterMap.get(path);
    if (!post) {
      deletedFiles += 1;
      restoreFiles.push(prior);
      continue;
    }
    if (!postStateMatchesSnapshot(prior, post)) {
      modifiedFiles += 1;
      restoreFiles.push(prior);
    }
  }

  for (const path of afterMap.keys()) {
    if (!beforeMap.has(path)) {
      createdFiles += 1;
      restoreFiles.push(createPriorMissingSnapshot(path, before.root));
    }
  }

  restoreFiles.sort((left, right) => left.path.localeCompare(right.path));
  const overflow = before.overflow || afterCollected.overflow;
  if (restoreFiles.length === 0) {
    notes.push('Filesystem checkpoint detected no restorable file changes.');
  } else if (overflow) {
    notes.push(
      'Filesystem checkpoint restore coverage is partial because the snapshot file limit was reached.',
    );
  }

  return {
    files: restoreFiles,
    filesystemDiff: {
      strategy: 'bounded_project_snapshot',
      modified_files: modifiedFiles,
      created_files: createdFiles,
      deleted_files: deletedFiles,
      restore_file_count: restoreFiles.length,
      overflow,
      notes,
    },
    notes,
  };
}

function resolveFileWriteTarget(
  inputPath: string,
  projectRoot: string,
  shadowRoot: string | null,
): string | null {
  const projectTarget = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(projectRoot, inputPath);

  if (!isWithinRoot(projectRoot, projectTarget)) {
    return null;
  }

  if (!shadowRoot) {
    return projectTarget;
  }

  return resolve(shadowRoot, relative(projectRoot, projectTarget));
}

function createCheckpointId(tool: CheckpointTool): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/Z$/, 'Z');
  const entropy = createHash('sha256')
    .update(`${stamp}:${tool}:${process.pid}:${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  return `cp_${stamp}_${entropy}`;
}

function summarizeToolTarget(req: ToolCallRequest): string {
  if (req.tool === 'file_write') return req.path;
  if (req.tool === 'shell_exec' || req.tool === 'test_run') return req.command;
  return JSON.stringify(req);
}

export function createPreMutationCheckpoint(
  req: ToolCallRequest,
  context: ToolCheckpointContext,
  options: {
    dryRun: boolean;
    projectRoot: string;
    shadowRoot?: string | null;
  },
): CheckpointRecord | null {
  if (!isCheckpointTool(req.tool)) {
    return null;
  }
  const checkpointTool = req.tool;

  const runDir = getRunDir(context);
  const checkpointId = createCheckpointId(checkpointTool);
  const now = new Date().toISOString();
  const notes: string[] = [];
  const files: CheckpointFileSnapshot[] = [];
  const shadowRoot = options.shadowRoot ?? null;
  let filesystemSnapshot: CheckpointFilesystemSnapshotMetadata | undefined;

  if (req.tool === 'file_write') {
    const targetPath = resolveFileWriteTarget(req.path, options.projectRoot, shadowRoot);
    if (targetPath) {
      files.push(captureFile(targetPath, shadowRoot ?? options.projectRoot));
    } else {
      notes.push(
        'file_write target did not resolve inside the project root; checkpoint is metadata-only because sandbox rejection is expected.',
      );
    }

    if (options.dryRun && !shadowRoot) {
      notes.push(
        'dry-run without a shadow root does not mutate the filesystem; checkpoint is metadata-only unless prior file state was captured for audit.',
      );
    }
  } else {
    if (options.dryRun) {
      notes.push(
        `${req.tool} ran in dry-run mode; Babel records the triggering command, but no filesystem diff snapshot is needed.`,
      );
    } else {
      const snapshot = createFilesystemSnapshotArtifact(options.projectRoot);
      const beforeArtifact = getCheckpointRelativeArtifactPath(
        checkpointId,
        'filesystem-before.json',
      );
      writeCheckpointJsonArtifact(runDir, checkpointId, 'filesystem-before.json', snapshot);
      filesystemSnapshot = {
        strategy: 'bounded_project_snapshot',
        root: snapshot.root,
        before_artifact: beforeArtifact,
        file_count: snapshot.files.length,
        overflow: snapshot.overflow,
        max_files: snapshot.max_files,
        max_file_bytes: snapshot.max_file_bytes,
        max_total_bytes: snapshot.max_total_bytes,
      };
      notes.push(
        `${req.tool} captured a bounded filesystem snapshot for post-command diff restore.`,
      );
      if (snapshot.overflow) {
        notes.push('Filesystem snapshot reached its file limit; restore coverage is partial.');
      }
      notes.push(...snapshot.notes);
    }
  }

  const restoreStatus = computeRestoreStatus(files);
  const record: CheckpointRecord = {
    schema_version: 1,
    id: checkpointId,
    run_id: context.runId,
    run_dir: runDir,
    created_at: now,
    updated_at: now,
    tool: checkpointTool,
    target: summarizeToolTarget(req),
    project_root: options.projectRoot,
    shadow_root: shadowRoot,
    dry_run: options.dryRun,
    triggering_tool_call: req as unknown as Record<string, unknown>,
    restore_status: restoreStatus,
    files,
    post_states: [],
    ...(filesystemSnapshot ? { filesystem_snapshot: filesystemSnapshot } : {}),
    notes,
  };

  writeCheckpointRecord(record);
  upsertCheckpointIndex(record);
  return record;
}

export function finalizeCheckpointAfterToolCall(
  checkpointId: string | null,
  context: ToolCheckpointContext,
): CheckpointRecord | null {
  if (!checkpointId) {
    return null;
  }

  const runDir = getRunDir(context);
  const metadataPath = getCheckpointMetadataPath(runDir, checkpointId);
  if (!existsSync(metadataPath)) {
    return null;
  }

  const record = JSON.parse(readFileSync(metadataPath, 'utf-8')) as CheckpointRecord;
  const now = new Date().toISOString();
  const filesystemResult =
    record.filesystem_snapshot && (record.tool === 'shell_exec' || record.tool === 'test_run')
      ? finalizeFilesystemDiff(record)
      : null;
  const files = filesystemResult ? filesystemResult.files : record.files;
  const postStates = files.map((file) => capturePostState(file.path));
  const restoreStatus = computeRestoreStatus(files);
  const next: CheckpointRecord = {
    ...record,
    updated_at: now,
    restore_status: restoreStatus,
    files,
    post_states: postStates,
    ...(filesystemResult ? { filesystem_diff: filesystemResult.filesystemDiff } : {}),
    notes: filesystemResult
      ? [...new Set([...record.notes, ...filesystemResult.notes])]
      : record.notes,
  };

  writeCheckpointRecord(next);
  upsertCheckpointIndex(next);
  return next;
}

export function listCheckpoints(runDir: string): CheckpointIndex {
  const runId = runDir.split(/[\\/]/).pop() ?? runDir;
  return readCheckpointIndex(runDir, runId);
}

export function readCheckpoint(runDir: string, checkpointId: string): CheckpointRecord {
  const metadataPath = getCheckpointMetadataPath(runDir, checkpointId);
  if (!existsSync(metadataPath)) {
    throw new Error(`Checkpoint not found: ${checkpointId}`);
  }
  return JSON.parse(readFileSync(metadataPath, 'utf-8')) as CheckpointRecord;
}

function listRunDirectories(runsDir: string): string[] {
  if (!existsSync(runsDir)) {
    return [];
  }
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsDir, entry.name))
    .sort()
    .reverse();
}

export function findCheckpoint(
  checkpointId: string,
  options: {
    runDir?: string;
    runsDir?: string;
  } = {},
): { runDir: string; record: CheckpointRecord } {
  if (options.runDir) {
    return {
      runDir: options.runDir,
      record: readCheckpoint(options.runDir, checkpointId),
    };
  }

  for (const runDir of listRunDirectories(options.runsDir ?? BABEL_RUNS_DIR)) {
    const metadataPath = getCheckpointMetadataPath(runDir, checkpointId);
    if (existsSync(metadataPath)) {
      return {
        runDir,
        record: readCheckpoint(runDir, checkpointId),
      };
    }
  }

  throw new Error(`Checkpoint not found: ${checkpointId}`);
}

function currentFileStateMatchesPostState(postState: CheckpointFilePostState): boolean {
  const current = capturePostState(postState.path);
  return (
    current.existed === postState.existed &&
    current.sha256 === postState.sha256 &&
    current.size_bytes === postState.size_bytes
  );
}

function testFileWritability(filePath: string): { writable: boolean; error?: string } {
  try {
    if (existsSync(filePath)) {
      const fd = openSync(filePath, 'r+');
      closeSync(fd);
    }
    return { writable: true };
  } catch (err: any) {
    return { writable: false, error: err.code || String(err) };
  }
}

function findLockingProcesses(filePath: string): string[] {
  if (process.platform !== 'win32') return [];
  try {
    const fileBasename = basename(filePath);
    // Phase 2b: Use escapePowerShellSingleQuoted to prevent injection.
    // A filename like "test' -or '1'" could inject arbitrary PowerShell.
    const escaped = fileBasename.replace(/'/g, "''");
    const script = `Get-Process | Where-Object { $_.Path -and (Split-Path $_.Path -Leaf) -eq '${escaped}' } | Select-Object -Property Id, ProcessName, Path | ConvertTo-Json`;
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
    });
    if (res.status === 0 && res.stdout.trim()) {
      try {
        const parsed = JSON.parse(res.stdout);
        const processes = Array.isArray(parsed) ? parsed : [parsed];
        return processes.map((p: any) => `PID ${p.Id} (${p.ProcessName})`);
      } catch {
        return [res.stdout.trim()];
      }
    }
  } catch (err) {
    // Phase 2b: Log the spawn failure instead of silently swallowing.
    // PowerShell not available, permissions, or corrupted file names should be visible.
    if (process.env['BABEL_DEBUG']) {
      console.warn(
        `[checkpoints] findLockingProcesses failed for "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return [];
}

export function restoreCheckpoint(
  record: CheckpointRecord,
  options: RestoreCheckpointOptions = {},
): RestoreCheckpointResult {
  const restoredFiles: string[] = [];
  const refusedFiles: RestoreCheckpointResult['refused_files'] = [];
  const notes = [...record.notes];

  if (record.restore_status !== 'available' || record.files.length === 0) {
    return {
      status: 'refused',
      checkpoint_id: record.id,
      run_dir: record.run_dir,
      restored_files: [],
      refused_files: [
        {
          path: record.target,
          reason: 'Checkpoint has no file snapshots to restore.',
        },
      ],
      notes,
    };
  }

  // Phase 1 (Verification): Test writability on all target files in the patchset before modifying
  const lockedFiles: string[] = [];
  const lockDiagnostics: string[] = [];
  for (const file of record.files) {
    const postState = record.post_states.find((candidate) => candidate.path === file.path);
    if (!options.force && postState && !currentFileStateMatchesPostState(postState)) {
      continue;
    }

    const testRes = testFileWritability(file.path);
    if (!testRes.writable) {
      lockedFiles.push(file.path);
      const lockingProcs = findLockingProcesses(file.path);
      const procInfo =
        lockingProcs.length > 0 ? ` (Locking process: ${lockingProcs.join(', ')})` : '';
      lockDiagnostics.push(`${file.path} is locked/unwritable: ${testRes.error}${procInfo}`);
    }
  }

  if (lockedFiles.length > 0) {
    const refused = record.files.map((file) => ({
      path: file.path,
      reason: `Checkpoint restore transaction aborted because target file(s) are locked or unwritable: ${lockDiagnostics.join('; ')}`,
    }));
    return {
      status: 'refused',
      checkpoint_id: record.id,
      run_dir: record.run_dir,
      restored_files: [],
      refused_files: refused,
      notes: [...notes, ...lockDiagnostics],
    };
  }

  for (const file of record.files) {
    const postState = record.post_states.find((candidate) => candidate.path === file.path);
    if (!options.force && postState && !currentFileStateMatchesPostState(postState)) {
      refusedFiles.push({
        path: file.path,
        reason:
          'Current file state differs from Babel post-write state. Use --force only after reviewing the diff.',
      });
      continue;
    }

    if (file.existed) {
      if (file.content_base64 === null) {
        refusedFiles.push({
          path: file.path,
          reason: 'Prior path existed but was not a regular file snapshot.',
        });
        continue;
      }
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, Buffer.from(file.content_base64, 'base64'));
      restoredFiles.push(file.path);
      continue;
    }

    if (existsSync(file.path)) {
      const stats = statSync(file.path);
      if (!stats.isFile()) {
        refusedFiles.push({
          path: file.path,
          reason: 'Prior path did not exist, but current path is not a regular file.',
        });
        continue;
      }
      unlinkSync(file.path);
    }
    restoredFiles.push(file.path);
  }

  return {
    status: refusedFiles.length > 0 ? 'refused' : 'restored',
    checkpoint_id: record.id,
    run_dir: record.run_dir,
    restored_files: restoredFiles,
    refused_files: refusedFiles,
    notes,
  };
}

export function formatCheckpointList(index: CheckpointIndex): string {
  const lines = [
    'Babel Checkpoints',
    `Run: ${index.run_dir}`,
    `Count: ${index.checkpoints.length}`,
    '',
  ];

  if (index.checkpoints.length === 0) {
    lines.push('No checkpoints recorded for this run.');
    return lines.join('\n');
  }

  for (const checkpoint of index.checkpoints) {
    lines.push(
      `${checkpoint.id}  ${checkpoint.tool}  ${checkpoint.restore_status}  ${checkpoint.target}`,
    );
  }

  return lines.join('\n');
}

export function formatCheckpointInspect(record: CheckpointRecord): string {
  const lines = [
    'Babel Checkpoint',
    `ID: ${record.id}`,
    `Run: ${record.run_dir}`,
    `Created: ${record.created_at}`,
    `Tool: ${record.tool}`,
    `Target: ${record.target}`,
    `Restore: ${record.restore_status}`,
    `Files: ${record.files.length}`,
    '',
    'Restore command:',
    `  babel checkpoint restore ${record.id} --run "${record.run_dir}"`,
    '',
    'Safety:',
    '  - Restore refuses to clobber later user edits unless --force is supplied.',
    '  - Use --force only after reviewing current diffs for every refused file.',
  ];

  if (record.filesystem_snapshot) {
    lines.push(
      '',
      'Snapshot coverage:',
      `  Strategy: ${record.filesystem_snapshot.strategy}`,
      `  Root: ${record.filesystem_snapshot.root}`,
      `  Captured files: ${record.filesystem_snapshot.file_count}`,
      `  Limits: ${record.filesystem_snapshot.max_files} files, ${record.filesystem_snapshot.max_file_bytes} bytes/file, ${record.filesystem_snapshot.max_total_bytes} bytes total`,
      `  Overflow: ${record.filesystem_snapshot.overflow ? 'yes' : 'no'}`,
    );
  }

  if (record.filesystem_diff) {
    lines.push(
      '',
      'Restore coverage:',
      `  Modified: ${record.filesystem_diff.modified_files}`,
      `  Created: ${record.filesystem_diff.created_files}`,
      `  Deleted: ${record.filesystem_diff.deleted_files}`,
      `  Restorable files: ${record.filesystem_diff.restore_file_count}`,
      `  Partial coverage: ${record.filesystem_diff.overflow ? 'yes' : 'no'}`,
    );
  }

  const skipped = record.files.filter((file) => file.skipped_reason);
  if (skipped.length > 0) {
    lines.push('', 'Metadata-only paths:');
    for (const file of skipped) {
      lines.push(`  - ${file.project_relative_path ?? file.path}: ${file.skipped_reason}`);
    }
  }

  if (record.notes.length > 0) {
    lines.push('', 'Notes:', ...record.notes.map((note) => `  - ${note}`));
  }

  return lines.join('\n');
}
