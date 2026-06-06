import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readLatestRunPointer } from '../../cli/helpers.js';
import type { LiteResultPayload } from '../../cli/structuredOutput.js';
import {
  findCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from '../../services/checkpoints.js';
import { buildRecoveryAssessment } from '../../services/recovery.js';
import {
  baseReadOnlyLitePayload,
  type AgentLaneContext,
} from '../contracts.js';
import {
  beginLiteArtifactRun,
  defaultArtifactRoot,
  listArtifactPaths,
  resolveLiteRepoRoot,
  writeLiteManifest,
  writeLiteRequest,
} from '../liteArtifacts.js';
import { writeLiteJsonArtifact, writeLiteTextArtifact } from '../../lite/artifacts.js';

export interface UndoLaneResult {
  payload: LiteResultPayload;
  humanText: string;
  exitCode: number;
}

function listRepoLiteFixRuns(projectRoot?: string): string[] {
  if (!projectRoot) {
    return [];
  }
  const liteRoot = defaultArtifactRoot(projectRoot);
  if (!existsSync(liteRoot)) {
    return [];
  }
  return readdirSync(liteRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(liteRoot, entry.name))
    .filter((runDir) => existsSync(join(runDir, 'small_fix_checkpoint.json')))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function resolveUndoRunDir(project?: string, projectRoot?: string): string | null {
  const candidates: string[] = [];
  const scopedPointer = project ? readLatestRunPointer(project) : null;
  if (scopedPointer?.run_dir) {
    candidates.push(scopedPointer.run_dir);
  }

  const repoScopedRuns = listRepoLiteFixRuns(projectRoot);
  candidates.push(...repoScopedRuns);

  if (!scopedPointer?.run_dir) {
    const latestPointer = readLatestRunPointer();
    if (latestPointer?.run_dir) {
      candidates.push(latestPointer.run_dir);
    }
  }

  const assessment = buildRecoveryAssessment({
    run: 'latest',
    ...(project !== undefined ? { project } : {}),
  });
  if (assessment.run_dir) {
    candidates.push(assessment.run_dir);
  }

  for (const runDir of [...new Set(candidates)]) {
    if (resolveLatestCheckpointId(runDir)) {
      return runDir;
    }
  }
  return null;
}

function resolveLatestCheckpointId(runDir: string): string | null {
  const smallFixPath = join(runDir, 'small_fix_checkpoint.json');
  if (existsSync(smallFixPath)) {
    try {
      const parsed = JSON.parse(readFileSync(smallFixPath, 'utf-8')) as { checkpoint_id?: string };
      if (typeof parsed.checkpoint_id === 'string' && parsed.checkpoint_id.length > 0) {
        return parsed.checkpoint_id;
      }
    } catch {
      // fall through
    }
  }
  const index = listCheckpoints(runDir);
  const latest = index.checkpoints.at(-1);
  return latest?.id ?? null;
}

export function runUndoLane(context: AgentLaneContext): UndoLaneResult {
  const repoPath = resolveLiteRepoRoot(context.projectRoot);
  const runDir = resolveUndoRunDir(context.project, repoPath);
  if (!runDir) {
    throw new Error('No recoverable run found for bl undo. Run bl fix first or pass --project.');
  }

  const checkpointId = resolveLatestCheckpointId(runDir);
  if (!checkpointId) {
    throw new Error(`No checkpoint found for run ${runDir}. Mutation lanes create checkpoints before writes.`);
  }

  const { record } = findCheckpoint(checkpointId, { runDir });
  const restore = restoreCheckpoint(record);

  const artifacts = beginLiteArtifactRun({ command: 'undo', repoPath });
  writeLiteRequest(artifacts, {
    schema_version: 1,
    command: 'undo',
    checkpoint_id: checkpointId,
    source_run_dir: runDir,
  });
  writeLiteManifest(artifacts, {
    schema_version: 1,
    command: 'undo',
    status: restore.status === 'restored' ? 'UNDO_COMPLETE' : 'UNDO_REFUSED',
    checkpoint_id: checkpointId,
    source_run_dir: runDir,
  });
  writeLiteJsonArtifact(artifacts, 'checkpoint.json', {
    checkpoint_id: checkpointId,
    restore,
  });
  writeLiteTextArtifact(artifacts, 'response.md', [
    `Undo ${restore.status}`,
    `Checkpoint: ${checkpointId}`,
    `Source run: ${runDir}`,
    restore.restored_files.length > 0
      ? `Restored: ${restore.restored_files.join(', ')}`
      : 'No files restored.',
  ].join('\n'));

  const base = baseReadOnlyLitePayload({
    command: 'undo',
    task: context.task || 'Restore last checkpoint',
    project: context.project ?? null,
    runDir: artifacts.runDir,
    projectRoot: repoPath,
    status: restore.status === 'restored' ? 'UNDO_COMPLETE' : 'UNDO_REFUSED',
    userStatus: restore.status === 'restored' ? 'success' : 'failed',
    selectedLane: 'lite_undo',
    executionPath: 'undo_lane',
    next: restore.status === 'restored'
      ? ['Verify the workspace state.', 'Re-run your normal project checks.']
      : ['Inspect checkpoint metadata.', `babel checkpoint restore ${checkpointId} --run "${runDir}" --force`],
  });

  const payload: LiteResultPayload = {
    ...base,
    schema_retries: 0,
    recovered_after_schema_retry: false,
    changed_files: restore.restored_files,
    checkpoint: {
      required: true,
      available: true,
      restore_command: `bl undo`,
      inspect_command: `babel checkpoint list --run "${runDir}"`,
    },
    evidence: {
      run_dir: artifacts.runDir,
      support_path: runDir,
      artifacts: listArtifactPaths(artifacts),
    },
  } as LiteResultPayload;

  const humanText = [
    restore.status === 'restored' ? 'Babel Lite undo complete' : 'Babel Lite undo refused',
    `Checkpoint: ${checkpointId}`,
    `Source run: ${runDir}`,
    restore.restored_files.length > 0 ? `Restored files: ${restore.restored_files.join(', ')}` : '',
    `Rollback: bl undo`,
  ].filter(Boolean).join('\n');

  return {
    payload,
    humanText,
    exitCode: restore.status === 'restored' ? 0 : 1,
  };
}
