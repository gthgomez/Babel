/**
 * sessionCheckpoint.ts — Session-level checkpoint/restore for Babel CLI
 *
 * Saves pipeline state at key transition points so a user can resume
 * a multi-hour session from the last checkpoint after interruption.
 *
 * P2.5: Session-level checkpoint/restore.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BABEL_RUNS_DIR } from '../cli/constants.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionCheckpointStage =
  | 'orchestrator_complete'
  | 'plan_approved'
  | 'executor_started'
  | 'executor_complete';

export interface SessionCheckpoint {
  /** Unique checkpoint ID */
  id: string;
  /** Session identifier */
  sessionId: string;
  /** Pipeline stage where checkpoint was saved */
  stage: SessionCheckpointStage;
  /** The run directory for the current pipeline invocation */
  runDir: string;
  /** The approved plan (if available) */
  planSnapshot: unknown | null;
  /** ISO timestamp */
  savedAt: string;
  /** Task string that was being executed */
  task: string;
}

export interface SessionCheckpointListResult {
  sessionId: string;
  checkpoints: SessionCheckpoint[];
  latest: SessionCheckpoint | null;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

function checkpointDir(sessionId: string): string {
  return join(BABEL_RUNS_DIR, 'session-checkpoints', sessionId);
}

function checkpointPath(sessionId: string, stage: string): string {
  return join(checkpointDir(sessionId), `${stage}.json`);
}

// ─── Limits ────────────────────────────────────────────────────────────────────

/** Maximum serialized bytes for planSnapshot before truncation (1 MB). */
const MAX_CHECKPOINT_SIZE_BYTES = 1_048_576;

/** Maximum number of checkpoints retained per session. */
const MAX_CHECKPOINTS_PER_SESSION = 10;

// ─── Save ─────────────────────────────────────────────────────────────────────

export function saveSessionCheckpoint(
  sessionId: string,
  stage: SessionCheckpointStage,
  runDir: string,
  task: string,
  planSnapshot: unknown | null = null,
): SessionCheckpoint {
  const dir = checkpointDir(sessionId);
  mkdirSync(dir, { recursive: true });

  // Truncate oversized plan snapshots before serialization.
  let safeSnapshot: unknown = planSnapshot;
  if (planSnapshot !== null) {
    const serialized = JSON.stringify(planSnapshot);
    const byteLen = Buffer.byteLength(serialized, 'utf-8');
    if (byteLen > MAX_CHECKPOINT_SIZE_BYTES) {
      console.warn(
        `[sessionCheckpoint] Plan snapshot truncated: ${byteLen} bytes exceeds ${MAX_CHECKPOINT_SIZE_BYTES} byte limit (${(byteLen / 1_048_576).toFixed(1)} MB). ` +
        `Session "${sessionId}" checkpoint "${stage}" will contain a stub marker instead of the full plan.`,
      );
      safeSnapshot = {
        _truncated: true,
        _reason: `planSnapshot (${byteLen} bytes) exceeded ${MAX_CHECKPOINT_SIZE_BYTES} bytes limit`,
        _original_bytes: byteLen,
      };
    }
  }

  const checkpoint: SessionCheckpoint = {
    id: `${sessionId}_${stage}`,
    sessionId,
    stage,
    runDir,
    planSnapshot: safeSnapshot,
    savedAt: new Date().toISOString(),
    task,
  };

  const serialized = JSON.stringify(checkpoint, null, 2);

  // Atomic write: temp file → rename, prevents partial writes on crash.
  const stagePath = checkpointPath(sessionId, stage);
  const stageTmp = `${stagePath}.tmp`;
  writeFileSync(stageTmp, serialized, 'utf-8');
  renameSync(stageTmp, stagePath);

  // Also write as latest pointer (atomic).
  const latestPath = join(dir, 'latest.json');
  const latestTmp = `${latestPath}.tmp`;
  writeFileSync(latestTmp, serialized, 'utf-8');
  renameSync(latestTmp, latestPath);

  return checkpoint;
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export function loadSessionCheckpoint(
  sessionId: string,
  stage?: SessionCheckpointStage,
): SessionCheckpoint | null {
  const dir = checkpointDir(sessionId);
  if (!existsSync(dir)) return null;

  const path = stage ? checkpointPath(sessionId, stage) : join(dir, 'latest.json');

  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SessionCheckpoint;
  } catch {
    return null;
  }
}

export function listSessionCheckpoints(sessionId: string): SessionCheckpointListResult {
  const dir = checkpointDir(sessionId);
  const checkpoints: SessionCheckpoint[] = [];

  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (entry === 'latest.json' || !entry.endsWith('.json')) continue;
      try {
        const cp = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as SessionCheckpoint;
        checkpoints.push(cp);
      } catch {
        // Skip corrupted files
      }
    }
  }

  checkpoints.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());

  return {
    sessionId,
    checkpoints,
    latest: checkpoints.length > 0 ? (checkpoints[0] ?? null) : null,
  };
}

// ─── Prune ────────────────────────────────────────────────────────────────────

/**
 * Removes the oldest checkpoints for a session, keeping at most `maxCount`.
 * Defaults to `MAX_CHECKPOINTS_PER_SESSION` (10). Safe to call at any time;
 * no-op if the session directory doesn't exist or is already under the limit.
 */
export function pruneSessionCheckpoints(
  sessionId: string,
  maxCount: number = MAX_CHECKPOINTS_PER_SESSION,
): number {
  const dir = checkpointDir(sessionId);
  if (!existsSync(dir)) return 0;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  const stageFiles = entries
    .filter((entry) => entry.endsWith('.json') && entry !== 'latest.json')
    .map((entry) => ({
      name: entry,
      path: join(dir, entry),
      mtimeMs: (() => {
        try {
          return statSync(join(dir, entry)).mtimeMs;
        } catch {
          return 0;
        }
      })(),
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // Newest first.

  let pruned = 0;
  for (let i = maxCount; i < stageFiles.length; i++) {
    const file = stageFiles[i];
    if (!file) continue;
    try {
      rmSync(file.path);
      pruned++;
    } catch {
      // Best-effort — skip files we can't remove.
    }
  }

  return pruned;
}

// ─── Resume context ───────────────────────────────────────────────────────────

/**
 * Build a resume task string from a session checkpoint.
 * The resume context includes what was being worked on and where to pick up.
 */
export function buildResumeContext(checkpoint: SessionCheckpoint): string {
  return [
    `Resume session "${checkpoint.sessionId}" from stage "${checkpoint.stage}".`,
    '',
    `Original task: ${checkpoint.task}`,
    `Run directory: ${checkpoint.runDir}`,
    `Saved at: ${checkpoint.savedAt}`,
    '',
    checkpoint.stage === 'orchestrator_complete'
      ? 'The orchestrator completed. Continue with the resolved task.'
      : checkpoint.stage === 'plan_approved'
        ? 'A plan was approved. Continue with plan execution.'
        : checkpoint.stage === 'executor_started'
          ? 'The executor started but did not finish. Continue or restart execution.'
          : 'Execution completed. Review the results.',
  ].join('\n');
}
