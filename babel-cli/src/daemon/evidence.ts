/**
 * daemon/evidence.ts — Daemon evidence bundle helpers (Phase 9)
 *
 * Every daemon job produces Babel evidence artifacts alongside pipeline
 * artifacts. Every daemon job produces auditable, replayable evidence
 * alongside pipeline artifacts for governance and debugging.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import type { AgentJob } from '../services/agentJobs.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DaemonJobMeta {
  schema_version: 1;
  artifact_type: 'babel_daemon_job_meta';
  job_id: string;
  task: string;
  priority: number;
  max_retries: number;
  retry_count: number;
  tags: string[];
  mode: string;
  project_root: string | null;
  model: string | null;
  trigger_source: 'cli' | 'scheduler' | 'file_watcher' | 'retry';
  enqueued_at: string;
  started_at: string;
}

export interface DaemonJobResult {
  schema_version: 2;
  artifact_type: 'babel_daemon_job_result';
  job_id: string;
  status: string;
  pipeline_status: string | null;
  duration_ms: number;
  error: string | null;
  rollback_performed: boolean;
  /** Set only when checkpoint creation returned an authoritative record. */
  checkpoint_id: string | null;
  /** Why checkpoint_id is null ('not_wired' | 'skipped') when no checkpoint exists. */
  checkpoint_status: 'created' | 'not_wired' | 'skipped' | null;
  checkpoint_note: string | null;
  /** The model the job requested (from the job spec), if any. */
  model_requested: string | null;
  /** The daemon heuristic recommendation. This is NOT an observation. */
  model_recommended: string | null;
  /**
   * Provider-observed model. The daemon never observes the provider model
   * today, so this is always null; a recommendation must never be written
   * into an observed-execution-truth field.
   */
  model_used: string | null;
  cost_usd: number | null;
  token_count: number | null;
}

export interface DaemonJobTelemetry {
  schema_version: 1;
  artifact_type: 'babel_daemon_job_telemetry';
  job_id: string;
  queue_wait_ms: number;
  execution_duration_ms: number;
  retry_count: number;
  rate_limit_delay_ms: number;
  evidence_bundle_path: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function writeDaemonJobMeta(
  runDir: string,
  job: AgentJob,
  triggerSource: DaemonJobMeta['trigger_source'] = 'cli',
): void {
  mkdirSync(runDir, { recursive: true });
  const meta: DaemonJobMeta = {
    schema_version: 1,
    artifact_type: 'babel_daemon_job_meta',
    job_id: job.id,
    task: job.task,
    priority: job.priority ?? 0,
    max_retries: job.max_retries ?? 0,
    retry_count: job.retry_count ?? 0,
    tags: job.tags ?? [],
    mode: job.mode,
    project_root: job.project_root,
    model: job.model,
    trigger_source: triggerSource,
    enqueued_at: job.created_at,
    started_at: new Date().toISOString(),
  };
  writeFileSync(`${runDir}/00_daemon_meta.json`, JSON.stringify(meta, null, 2), 'utf-8');
}

export function writeDaemonJobResult(
  runDir: string,
  jobId: string,
  result: {
    status: string;
    pipelineStatus: string | null;
    durationMs: number;
    error: string | null;
    rollbackPerformed?: boolean;
    checkpointId?: string | null;
    checkpointStatus?: DaemonJobResult['checkpoint_status'];
    checkpointNote?: string | null;
    modelRequested?: string | null;
    modelRecommended?: string | null;
    modelUsed?: string | null;
    costUsd?: number | null;
    tokenCount?: number | null;
  },
): void {
  mkdirSync(runDir, { recursive: true });
  const jobResult: DaemonJobResult = {
    schema_version: 2,
    artifact_type: 'babel_daemon_job_result',
    job_id: jobId,
    status: result.status,
    pipeline_status: result.pipelineStatus,
    duration_ms: result.durationMs,
    error: result.error,
    rollback_performed: result.rollbackPerformed ?? false,
    checkpoint_id: result.checkpointId ?? null,
    checkpoint_status: result.checkpointStatus ?? (result.checkpointId ? 'created' : 'not_wired'),
    checkpoint_note: result.checkpointNote ?? null,
    model_requested: result.modelRequested ?? null,
    model_recommended: result.modelRecommended ?? null,
    // Provider observation is never available in the daemon today; only a
    // future pipeline/provider receipt may populate this field.
    model_used: result.modelUsed ?? null,
    cost_usd: result.costUsd ?? null,
    token_count: result.tokenCount ?? null,
  };
  writeFileSync(`${runDir}/09_daemon_result.json`, JSON.stringify(jobResult, null, 2), 'utf-8');
}

export function writeDaemonJobTelemetry(
  runDir: string,
  jobId: string,
  telemetry: {
    queueWaitMs: number;
    executionDurationMs: number;
    retryCount: number;
    rateLimitDelayMs: number;
  },
): void {
  mkdirSync(runDir, { recursive: true });
  const tel: DaemonJobTelemetry = {
    schema_version: 1,
    artifact_type: 'babel_daemon_job_telemetry',
    job_id: jobId,
    queue_wait_ms: telemetry.queueWaitMs,
    execution_duration_ms: telemetry.executionDurationMs,
    retry_count: telemetry.retryCount,
    rate_limit_delay_ms: telemetry.rateLimitDelayMs,
    evidence_bundle_path: runDir,
  };
  writeFileSync(`${runDir}/10_daemon_telemetry.json`, JSON.stringify(tel, null, 2), 'utf-8');
}
