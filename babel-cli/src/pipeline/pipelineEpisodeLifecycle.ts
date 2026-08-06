import type { ToolCallLog } from '../schemas/agentContracts.js';
import type { EpisodeStreamLoadMode } from '../evidence/episodeStream.js';
import { PipelineEpisodeSink } from './pipelineEpisodeSink.js';
export type { PipelineEpisodeSink } from './pipelineEpisodeSink.js';

export interface PipelineEpisodeLifecycle {
  readonly sink: PipelineEpisodeSink | null;
  readonly status: 'active' | 'degraded';
  readonly warning: string | undefined;
  recordPhase(
    phase: 'orchestrator' | 'swe_planning' | 'qa_review' | 'executor' | 'finalization',
    status: 'started' | 'completed' | 'failed',
    details?: Record<string, unknown>,
  ): void;
  recordFinalization(status: string, reason: string): void;
}

export interface EpisodeWarningEvidence {
  runDir: string;
  writeDebugFile(filename: string, content: string): void;
}

export function createEpisodeLifecycleForEvidence(
  evidence: EpisodeWarningEvidence,
  options: Omit<Parameters<typeof createPipelineEpisodeLifecycle>[0], 'runDir' | 'writeWarning'>,
): PipelineEpisodeLifecycle {
  return createPipelineEpisodeLifecycle({
    ...options,
    runDir: evidence.runDir,
    writeWarning: (warning) => evidence.writeDebugFile('episode_persistence_warning.json', `${JSON.stringify({ status: 'degraded', warning }, null, 2)}\n`),
  });
}

export function createPipelineEpisodeLifecycle(options: {
  runDir: string;
  sessionId?: string;
  mode: EpisodeStreamLoadMode;
  writeWarning: (warning: string) => void;
  initialPhase?: {
    phase: 'orchestrator' | 'swe_planning' | 'qa_review' | 'executor' | 'finalization';
    status: 'started' | 'completed' | 'failed';
    details?: Record<string, unknown>;
  };
}): PipelineEpisodeLifecycle {
  let warning: string | undefined;
  const markDegraded = (next: string): void => {
    if (warning !== undefined) return;
    warning = next;
    try {
      options.writeWarning(next);
    } catch {
      // Episode evidence is supplemental; a warning writer failure must not
      // turn the primary pipeline result into an exception.
    }
  };
  const created = PipelineEpisodeSink.create({
    runDir: options.runDir,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    mode: options.mode,
    onDegraded: markDegraded,
  });
  const sink = created.ok ? created.value : null;
  if (sink?.status === 'degraded') markDegraded(sink.warnings[0] ?? 'Episode persistence degraded.');
  else if (!created.ok) {
    markDegraded(`Episode persistence unavailable: ${created.error.message}`);
  }

  let finalized = false;
  const activePhases = new Set<string>();
  const recordPhase = (
    phase: 'orchestrator' | 'swe_planning' | 'qa_review' | 'executor' | 'finalization',
    status: 'started' | 'completed' | 'failed',
    details?: Record<string, unknown>,
  ): void => {
    if (status === 'started') activePhases.add(phase);
    else activePhases.delete(phase);
    sink?.recordPhase(phase, status, details);
    if (sink?.status === 'degraded') markDegraded(sink.warnings[0] ?? 'Episode persistence degraded.');
  };
  if (options.initialPhase) recordPhase(options.initialPhase.phase, options.initialPhase.status, options.initialPhase.details);

  return {
    sink,
    get status() {
      return sink?.status ?? 'degraded';
    },
    get warning() {
      return warning;
    },
    recordPhase,
    recordFinalization(finalStatus: string, reason: string): void {
      if (finalized) return;
      finalized = true;
      for (const phase of [...activePhases] as Array<'orchestrator' | 'swe_planning' | 'qa_review' | 'executor'>) {
        recordPhase(phase, 'failed', { interrupted: true, finalStatus });
      }
      recordPhase('finalization', 'started', { status: finalStatus });
      recordPhase('finalization', 'completed', { status: finalStatus });
      sink?.recordCompletion(finalStatus, reason);
    },
  };
}

export function recordExecutorToolLog(
  sink: PipelineEpisodeSink | null | undefined,
  entries: readonly ToolCallLog[],
): void {
  if (!sink) return;
  for (const entry of entries) sink.recordExecutorToolCall(entry);
}
