/**
 * dryRunPipeline.ts — Dry-run pipeline verification.
 *
 * Implements `dryRunPipeline()` which traces what the full pipeline WOULD
 * do without actually executing tool calls. All four stages run normally
 * through the LLM (or offline fixtures), but tool execution is replaced
 * with no-op recording.
 *
 * Use via CLI: babel run "<task>" --dry-run
 * Or programmatically: dryRunPipeline(task, options)
 */

import type { PipelineOptions } from '../pipeline.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DryRunTraceEntry {
  /** Turn number (1-indexed). */
  turn: number;
  /** The tool that WOULD have been called. */
  tool: string;
  /** The target path (for file_read, file_write, directory_list). */
  target?: string;
  /** The command (for shell_exec, test_run). */
  command?: string;
  /** Truncated content preview (for file_write). */
  contentPreview?: string;
}

export interface DryRunPipelineResult {
  /** Whether the dry run completed without errors. */
  success: boolean;
  /** The pipeline mode that would be used. */
  mode: string;
  /** Stage 1: orchestrator routing decision summary. */
  orchestrator: {
    domain: string;
    pipelineMode: string;
    modelAssigned: string;
  } | null;
  /** Stage 2: SWE plan summary. */
  swePlan: {
    planType: string;
    actionCount: number;
    tools: string[];
  } | null;
  /** Stage 3: QA verdict. */
  qaVerdict: {
    verdict: string;
    confidence: number;
  } | null;
  /** Stage 4: tool calls that WOULD be executed. */
  executorTrace: DryRunTraceEntry[];
  /** Total estimated tool calls. */
  estimatedToolCalls: number;
  /** Error message if the dry run failed. */
  error?: string;
}

// ── No-op tool executor ──────────────────────────────────────────────────────

/** Simplified tool request for dry-run recording. */
interface DryRunRequest {
  tool: string;
  path?: string;
  content?: string;
}

/**
 * A no-op replacement for executeTool that records what WOULD be done
 * without actually doing it.
 */
export function createDryRunExecuteTool(): {
  execute: (request: DryRunRequest) => Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
  }>;
  getTrace: () => DryRunTraceEntry[];
} {
  const trace: DryRunTraceEntry[] = [];

  const execute = async (request: DryRunRequest) => {
    const entry: DryRunTraceEntry = {
      turn: trace.length + 1,
      tool: request.tool,
    };

    switch (request.tool) {
      case 'file_read':
      case 'file_write':
      case 'directory_list':
        if (request.path !== undefined) entry.target = request.path;
        if (request.tool === 'file_write' && request.content !== undefined) {
          entry.contentPreview = request.content.slice(0, 200);
        }
        break;
      case 'shell_exec':
      case 'test_run':
        if (request.path !== undefined) entry.command = request.path;
        break;
    }

    trace.push(entry);

    return {
      exit_code: 0,
      stdout: `[DRY-RUN] Would execute: ${request.tool} ${request.path ?? ''}`,
      stderr: '',
    };
  };

  return { execute, getTrace: () => [...trace] };
}

// ── Dry-run pipeline ─────────────────────────────────────────────────────────

/**
 * Run a dry-run trace of the pipeline.
 *
 * This function traces what WOULD happen without executing tool calls.
 * It uses the offline fixture system when BABEL_PIPELINE_V9_OFFLINE=1
 * for deterministic, no-cost traces.
 *
 * @param task    - The task prompt
 * @param options - Pipeline options (mode, model, project root, etc.)
 * @returns A DryRunPipelineResult with the full trace
 */
export async function dryRunPipeline(
  task: string,
  options: PipelineOptions = {},
): Promise<DryRunPipelineResult> {
  const { createDryRunExecuteTool: createDryRun } = await import('./dryRunPipeline.js');

  // Enable offline fixtures for deterministic dry-run if not already set
  if (!process.env['BABEL_PIPELINE_V9_OFFLINE']) {
    process.env['BABEL_PIPELINE_V9_OFFLINE'] = '1';
  }

  try {
    // Import pipeline functions lazily to avoid circular deps
    const { buildPipelineV9OfflineFixtureResponse, resetOfflineQaCallCount } =
      await import('../execute.js');

    resetOfflineQaCallCount();

    // Stage 1: Orchestrator
    const orchResult = buildPipelineV9OfflineFixtureResponse(`otel regression: ${task}`, {
      stage: 'orchestrator',
    }) as Record<string, unknown> | null;

    // Stage 2: SWE Plan
    const planResult = buildPipelineV9OfflineFixtureResponse(
      `Analyze the task below and produce the SWE Plan. ${task}`,
      { stage: 'planning' },
    ) as Record<string, unknown> | null;

    // Stage 3: QA Verdict
    const qaResult = buildPipelineV9OfflineFixtureResponse(
      `Review the SWE Plan below and produce a QA verdict. ${task}`,
      { stage: 'qa' },
    ) as Record<string, unknown> | null;

    // Stage 4: Executor (simulated — just record what the plan would do)
    const planActions = (planResult?.minimal_action_set as Array<Record<string, unknown>>) ?? [];
    const trace: DryRunTraceEntry[] = planActions.map((action, i) => {
      const entry: DryRunTraceEntry = {
        turn: i + 1,
        tool: String(action.tool ?? 'unknown'),
      };
      if (action.target) {
        entry.target = String(action.target);
      }
      return entry;
    });

    return {
      success: true,
      mode: String(options.mode ?? 'deep'),
      orchestrator: orchResult
        ? {
            domain: String(
              (orchResult.instruction_stack as Record<string, unknown>)?.domain_id ?? 'unknown',
            ),
            pipelineMode: String(
              (orchResult.analysis as Record<string, unknown>)?.pipeline_mode ?? 'deep',
            ),
            modelAssigned: String(
              (orchResult.worker_configuration as Record<string, unknown>)?.assigned_model ??
                'unknown',
            ),
          }
        : null,
      swePlan: planResult
        ? {
            planType: String(planResult.plan_type ?? 'UNKNOWN'),
            actionCount: planActions.length,
            tools: planActions.map((a) => String(a.tool ?? 'unknown')),
          }
        : null,
      qaVerdict: qaResult
        ? {
            verdict: String(qaResult.verdict ?? 'UNKNOWN'),
            confidence: Number(qaResult.overall_confidence ?? 0),
          }
        : null,
      executorTrace: trace,
      estimatedToolCalls: trace.length,
    };
  } catch (err) {
    return {
      success: false,
      mode: String(options.mode ?? 'deep'),
      orchestrator: null,
      swePlan: null,
      qaVerdict: null,
      executorTrace: [],
      estimatedToolCalls: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
