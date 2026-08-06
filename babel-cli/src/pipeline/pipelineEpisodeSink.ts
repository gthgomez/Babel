/**
 * Pipeline episode persistence boundary.
 *
 * Episode events are supplemental evidence: a persistence failure degrades
 * this sink and is surfaced to the caller, but never hides the primary run.
 */
import type { ToolCallLog } from '../schemas/agentContracts.js';
import type {
  EpisodeEventLog,
  EpisodeStreamLoadMode,
  EpisodeStreamResult,
} from '../evidence/episodeStream.js';
import {
  appendEpisodeEvent,
  flushEpisodeEventLog,
  loadEpisodeEventLogForMode,
} from '../evidence/episodeStream.js';
import { redactSecrets } from '../utils/redaction.js';

export type PipelineEpisodePersistenceStatus = 'active' | 'degraded';

export interface PipelineEpisodeSinkOptions {
  runDir: string;
  sessionId?: string;
  mode?: EpisodeStreamLoadMode;
  onDegraded?: (warning: string) => void;
}

export type PipelineEpisodeSinkCreateResult = EpisodeStreamResult<PipelineEpisodeSink>;

export class PipelineEpisodeSink {
  public readonly log: EpisodeEventLog;
  public readonly runDir: string;
  private readonly onDegraded: ((warning: string) => void) | undefined;
  private _status: PipelineEpisodePersistenceStatus = 'active';
  private readonly _warnings: string[] = [];

  private constructor(
    options: PipelineEpisodeSinkOptions,
    log: EpisodeEventLog,
  ) {
    this.runDir = options.runDir;
    this.log = log;
    this.onDegraded = options.onDegraded;
  }

  public static create(options: PipelineEpisodeSinkOptions): PipelineEpisodeSinkCreateResult {
    const loaded = loadEpisodeEventLogForMode(options.runDir, {
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      mode: options.mode ?? 'new',
    });
    if (!loaded.ok) return loaded;

    const sink = new PipelineEpisodeSink(options, loaded.value);
    sink.flush();
    return { ok: true, value: sink, mode: loaded.mode };
  }

  public get status(): PipelineEpisodePersistenceStatus {
    return this._status;
  }

  public get warnings(): readonly string[] {
    return this._warnings;
  }

  public recordPhase(
    phase: 'orchestrator' | 'swe_planning' | 'qa_review' | 'executor' | 'finalization',
    status: 'started' | 'completed' | 'failed',
    details?: Record<string, unknown>,
  ): void {
    this.record('progress', `PIPELINE_PHASE_${status.toUpperCase()}`, {
      phase,
      status,
      ...(details ?? {}),
    });
  }

  public recordStageTransition(
    stageName: string,
    status: 'started' | 'completed' | 'failed',
    details?: Record<string, unknown>,
  ): void {
    this.record('progress', `PIPELINE_STAGE_${status.toUpperCase()}`, {
      stage: stageName,
      status,
      ...(details ?? {}),
    });
  }

  public recordToolCall(
    toolName: string,
    input: Record<string, unknown>,
    output?: Record<string, unknown>,
  ): void {
    this.record('tool', `TOOL_${toolName.toUpperCase()}`, {
      tool: toolName,
      input,
      ...(output ? { output } : {}),
    });
  }

  /** Canonical bridge from the executor tool log to the episode stream. */
  public recordExecutorToolCall(entry: ToolCallLog): void {
    this.recordToolCall(
      entry.tool,
      { target: entry.target, step: entry.step },
      {
        exit_code: entry.exit_code,
        verified: entry.verified,
        stdout: entry.stdout,
        stderr: entry.stderr,
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.mutation_paths?.length ? { mutation_paths: entry.mutation_paths } : {}),
      },
    );
  }

  public recordCompletion(outcome: string, reason: string): void {
    this.record('completion', 'PIPELINE_COMPLETION', { outcome, reason });
  }

  public flush(): boolean {
    if (this._status === 'degraded') return false;
    const result = flushEpisodeEventLog(this.runDir, this.log);
    if (result.error) {
      this.markDegraded(`Episode stream flush failed: ${result.error}`);
      return false;
    }
    return true;
  }

  private record(
    kind: 'tool' | 'progress' | 'completion',
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (this._status === 'degraded') return;
    try {
      appendEpisodeEvent(this.log, { kind, type, payload });
      this.flush();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markDegraded(`Episode stream append failed: ${redactSecrets(message)}`);
    }
  }

  private markDegraded(warning: string): void {
    if (this._status === 'degraded') return;
    this._status = 'degraded';
    this._warnings.push(warning);
    try {
      this.onDegraded?.(warning);
    } catch {
      // Degradation reporting is supplemental and must not hide the primary run.
    }
  }
}
