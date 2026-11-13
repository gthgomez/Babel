/**
 * daemon/queue.ts — Daemon job queue consumer
 *
 * Polls the agentJobs registry, dequeues eligible 'queued' jobs, and executes
 * them through the shared agent-job pipeline runner. Supports priority ordering,
 * retry with exponential backoff, rate limiting (sliding window), and drain on shutdown.
 * Concurrency limit: 1 (MVP). Reuses agentJobs.ts for persistence.
 */

import { updateAgentJob, listAgentJobs } from '../services/agentJobs.js';
import type { AgentJob } from '../services/agentJobs.js';
import { runAgentJobThroughPipeline } from '../services/agentJobPipeline.js';
import { DAEMON_QUEUE_TICK_INTERVAL_MS } from './constants.js';
import { writeDaemonJobResult, writeDaemonJobTelemetry } from './evidence.js';
import { isDaemonPipelineQualified } from './pipelineQualification.js';
import { recommendModel } from './resourceOptimizer.js';

export const DAEMON_PIPELINE_QUARANTINE_MESSAGE =
  'UNSUPPORTED_OPERATION: Daemon pipeline execution is quarantined pending settlement and recovery qualification.';

/**
 * Truthful queue wait: the wall time between the job record's creation and the
 * moment the daemon actually started it. A malformed/absent created_at is an
 * unknown wait, never a fabricated positive value; we report 0 rather than a
 * negative or NaN measurement.
 */
export function realQueueWaitMs(startedAt: number, createdAt: string | null | undefined): number {
  const parsed = Date.parse(String(createdAt ?? ''));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, startedAt - parsed);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface QueueStatus {
  pending: number;
  active: string | null;
  totalCompleted: number;
  totalFailed: number;
  totalRetried: number;
  rateLimitActive: boolean;
}

export interface DrainResult {
  drained: boolean;
  abandonedJobId: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_JOBS_PER_MINUTE = 30;
const DEFAULT_BASE_BACKOFF_MS = 5000;

// ── Queue Consumer ───────────────────────────────────────────────────────────

export class DaemonQueue {
  private _processing = false;
  private _activeJobId: string | null = null;
  private _tickTimer: ReturnType<typeof setInterval> | null = null;
  private _totalCompleted = 0;
  private _totalFailed = 0;
  private _totalRetried = 0;
  private _completionTimestamps: number[] = [];
  private _rateLimitActive = false;

  constructor(
    private concurrency: number = 1,
    private maxJobsPerMinute: number = DEFAULT_MAX_JOBS_PER_MINUTE,
    private baseBackoffMs: number = DEFAULT_BASE_BACKOFF_MS,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Start the tick loop. */
  start(): void {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[daemon:queue] tick error:', err.message);
      });
    }, DAEMON_QUEUE_TICK_INTERVAL_MS);
    this.tick().catch((err) => {
      console.error('[daemon:queue] initial tick error:', err.message);
    });
  }

  /** Stop the tick loop. */
  stop(): void {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  /** Drain and stop. Returns abandoned job if one was running. */
  async drain(): Promise<DrainResult> {
    this.stop();
    const abandoned = this._activeJobId;
    if (abandoned) {
      const deadline = Date.now() + 1000;
      while (this._activeJobId !== null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return {
      drained: this._activeJobId === null,
      abandonedJobId: this._activeJobId,
    };
  }

  // ── Tick ────────────────────────────────────────────────────────────────

  /** Trigger a queue processing cycle. */
  async tick(): Promise<void> {
    if (this._processing) return;

    try {
      const pending = this.pendingCount;
      if (pending === 0) return;

      if (this.isRateLimited()) {
        this._rateLimitActive = true;
        return;
      }
      this._rateLimitActive = false;

      this._processing = true;
      await this.processNext();
    } finally {
      this._processing = false;
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  getStatus(): QueueStatus {
    return {
      pending: this.pendingCount,
      active: this._activeJobId,
      totalCompleted: this._totalCompleted,
      totalFailed: this._totalFailed,
      totalRetried: this._totalRetried,
      rateLimitActive: this.isRateLimited(),
    };
  }

  get pendingCount(): number {
    try {
      const { jobs } = listAgentJobs();
      return jobs.filter((j) => j.status === 'queued' && !this.isRetryDelayed(j)).length;
    } catch {
      return 0;
    }
  }

  get activeJobId(): string | null {
    return this._activeJobId;
  }

  // ── Private: dequeuing ──────────────────────────────────────────────────

  private async processNext(): Promise<void> {
    let allJobs: AgentJob[];
    try {
      const result = listAgentJobs();
      allJobs = result.jobs;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[daemon:queue] Failed to list jobs:', message);
      return;
    }

    const eligible = allJobs.filter((j) => j.status === 'queued' && !this.isRetryDelayed(j));
    if (eligible.length === 0) return;

    eligible.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pa - pb;
      return a.created_at.localeCompare(b.created_at);
    });

    const toProcess = eligible.slice(0, this.concurrency);
    for (const job of toProcess) {
      await this.executeJob(job);
    }
  }

  // ── Private: execution ──────────────────────────────────────────────────

  private async executeJob(job: AgentJob): Promise<void> {
    this._activeJobId = job.id;
    const startedAt = Date.now();
    let runDir = '';
    let recordedRateLimit = false;

    const finishRateLimit = (): void => {
      if (!recordedRateLimit) {
        this.recordJobFinished();
        recordedRateLimit = true;
      }
    };

    const checkpointId: string | null = null;
    const checkpointStatus: 'not_wired' | 'skipped' = job.mode === 'deep' ? 'not_wired' : 'skipped';
    const checkpointNote =
      checkpointStatus === 'not_wired'
        ? 'Daemon deep-mode pre-mutation checkpointing is not wired to the checkpoint service; no recoverability claim is made.'
        : null;

    try {
      if (!isDaemonPipelineQualified()) {
        updateAgentJob(job.id, {
          status: 'failed',
          error: DAEMON_PIPELINE_QUARANTINE_MESSAGE,
        });
        this._totalFailed++;
        finishRateLimit();
        console.error(`[daemon:queue] Job ${job.id} blocked: pipeline quarantined.`);
        return;
      }

      updateAgentJob(job.id, { status: 'running' });
      console.log(`[daemon:queue] Executing job ${job.id}: ${job.task.slice(0, 80)}...`);

      const modelRec = recommendModel(job);
      if (job.verify_commands?.length) {
        console.log(
          `[daemon:queue] Job ${job.id} binds ${job.verify_commands.length} verify command(s) before execution.`,
        );
      }

      const pipelineRun = await runAgentJobThroughPipeline(job);
      const { result, resolvedModel, status, completionVerification, diagnosis } = pipelineRun;

      runDir = result.runDir ?? '';
      const durationMs = Date.now() - startedAt;

      if (runDir) {
        writeDaemonJobResult(runDir, job.id, {
          status:
            status === 'complete'
              ? 'complete'
              : status === 'verification_failed'
                ? 'verification_failed'
                : 'failed',
          pipelineStatus: result.status,
          durationMs,
          error: pipelineRun.error,
          modelRequested: job.model ?? null,
          modelRecommended: modelRec.model,
          checkpointId,
          checkpointStatus,
          checkpointNote,
        });
        writeDaemonJobTelemetry(runDir, job.id, {
          queueWaitMs: realQueueWaitMs(startedAt, job.created_at),
          executionDurationMs: durationMs,
          retryCount: job.retry_count ?? 0,
          rateLimitDelayMs: 0,
        });
      }

      updateAgentJob(job.id, {
        status,
        run_dir: result.runDir ?? null,
        pipeline_status: result.status,
        completion_verification: completionVerification,
        diagnosis,
        error: pipelineRun.error,
      });

      finishRateLimit();

      if (status === 'complete') {
        this._totalCompleted++;
        console.log(
          `[daemon:queue] Job ${job.id} completed: ${result.status} (resolved model: ${resolvedModel ?? 'default'}, recommended: ${modelRec.model})`,
        );
        return;
      }

      if (status === 'verification_failed') {
        this._totalFailed++;
        console.error(`[daemon:queue] Job ${job.id} verification_failed: ${diagnosis.headline}`);
        return;
      }

      if (!result.runDir) {
        this._totalFailed++;
        console.error(`[daemon:queue] Job ${job.id} failed: pipeline produced no run directory.`);
        return;
      }

      this.handleFailure(job, diagnosis.headline ?? `Pipeline status: ${result.status}`);
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      if (runDir) {
        try {
          writeDaemonJobResult(runDir, job.id, {
            status: 'failed',
            pipelineStatus: null,
            durationMs,
            error: message,
          });
          writeDaemonJobTelemetry(runDir, job.id, {
            queueWaitMs: realQueueWaitMs(startedAt, job.created_at),
            executionDurationMs: durationMs,
            retryCount: job.retry_count ?? 0,
            rateLimitDelayMs: 0,
          });
        } catch {
          /* best effort */
        }
      }
      if (/SETUP_REQUIRED|BUDGET_UNSUPPORTED/i.test(message)) {
        updateAgentJob(job.id, { status: 'failed', error: message });
        this._totalFailed++;
        finishRateLimit();
        return;
      }
      finishRateLimit();
      this.handleFailure(job, message);
    } finally {
      this._activeJobId = null;
    }
  }

  // ── Private: retry logic ────────────────────────────────────────────────

  private handleFailure(job: AgentJob, errorMsg: string): void {
    const maxRetries = job.max_retries ?? 0;
    const retryCount = (job.retry_count ?? 0) + 1;

    if (retryCount <= maxRetries) {
      const delayMs = this.baseBackoffMs * Math.pow(2, retryCount - 1);
      const retryAfter = new Date(Date.now() + delayMs).toISOString();

      try {
        updateAgentJob(job.id, {
          status: 'queued',
          retry_count: retryCount,
          retry_after: retryAfter,
          error: `[Retry ${retryCount}/${maxRetries}] ${errorMsg}`,
        });
      } catch {
        /* best effort */
      }

      this._totalRetried++;
      console.log(
        `[daemon:queue] Job ${job.id} failed, retry ${retryCount}/${maxRetries} ` +
          `after ${delayMs}ms: ${errorMsg.slice(0, 60)}`,
      );
    } else {
      this._totalFailed++;
      console.error(`[daemon:queue] Job ${job.id} failed (max retries exhausted): ${errorMsg}`);
      try {
        updateAgentJob(job.id, {
          status: 'failed',
          error: `[Failed after ${retryCount - 1} retries] ${errorMsg}`,
        });
      } catch {
        /* best effort */
      }
    }
  }

  private isRetryDelayed(job: AgentJob): boolean {
    if (!job.retry_after) return false;
    return new Date(job.retry_after) > new Date();
  }

  // ── Private: rate limiting ──────────────────────────────────────────────

  private isRateLimited(): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    this._completionTimestamps = this._completionTimestamps.filter((ts) => now - ts < windowMs);
    return this._completionTimestamps.length >= this.maxJobsPerMinute;
  }

  private recordJobFinished(): void {
    this._completionTimestamps.push(Date.now());
    if (this._completionTimestamps.length > this.maxJobsPerMinute * 2) {
      const now = Date.now();
      this._completionTimestamps = this._completionTimestamps.filter((ts) => now - ts < 60_000);
    }
  }
}
