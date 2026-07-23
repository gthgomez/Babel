/**
 * goalLoop.ts — Autonomous goal loop for Babel CLI
 *
 * Reuses `runBabelPipeline` in a controlled loop, calling plan→QA→execute
 * on each iteration, observing results, and enriching the task for the
 * next iteration until the goal is met or the budget is exhausted.
 *
 * P1.1: Autonomous goal loop — competitive parity with Claude Code /goal and Codex CLI.
 */

import { runBabelPipeline, type PipelineResult } from '../pipeline.js';
import type { ValidMode } from '../cli/constants.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GoalLoopStatus =
  | 'goal_met'
  | 'max_iterations_reached'
  | 'token_budget_exhausted'
  | 'halted_by_qa_reject'
  | 'halted_by_executor_error'
  | 'cancelled';

export interface GoalIterationResult {
  iteration: number;
  status: PipelineResult['status'];
  runDir: string | undefined;
  summary: string;
}

export interface GoalLoopResult {
  status: GoalLoopStatus;
  goal: string;
  iterations: GoalIterationResult[];
  finalRunDir: string | null;
  startedAt: string;
  completedAt: string;
}

export interface GoalLoopOptions {
  /** Maximum iterations (default: 5) */
  maxIterations?: number;
  /** Token budget ceiling shared across iterations */
  tokenBudget?: number;
  /** Pipeline mode: 'deep' (default, full pipeline) or 'chat' / 'chat-headless' / 'plan' */
  mode?: ValidMode;
  /** Target project name */
  project?: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}

/**
 * Derive a summary line from a pipeline result for iteration tracking.
 */
function summarizeResult(result: PipelineResult): string {
  switch (result.status) {
    case 'COMPLETE':
      return 'Plan executed successfully.';
    case 'COMPLETE_NO_MODIFICATION':
      return 'No changes were needed.';
    case 'SMALL_FIX_COMPLETE':
      return 'Small fix applied.';
    case 'QA_REJECTED_MAX_LOOPS':
      return 'QA rejected all plan attempts.';
    case 'EXECUTOR_HALTED':
      return 'Executor halted before completion.';
    default:
      return `Pipeline ended with status: ${result.status}`;
  }
}

/**
 * Determine whether a pipeline result represents forward progress.
 */
function isTerminalProgress(result: PipelineResult): boolean {
  return (
    result.status === 'COMPLETE' ||
    result.status === 'COMPLETE_NO_MODIFICATION' ||
    result.status === 'SMALL_FIX_COMPLETE'
  );
}

function isBlocking(result: PipelineResult): boolean {
  return result.status === 'QA_REJECTED_MAX_LOOPS' || result.status === 'EXECUTOR_HALTED';
}

/**
 * Enrich the task prompt for the next iteration with context from the
 * previous one. This is intentionally lightweight — the SWE Agent sees
 * the accumulated context and adjusts.
 */
function enrichTaskForNextIteration(
  goal: string,
  lastResult: PipelineResult,
  iteration: number,
): string {
  const summary = summarizeResult(lastResult);

  return [
    `Goal: ${goal}`,
    '',
    `--- Iteration ${iteration} result ---`,
    `Status: ${lastResult.status}`,
    `Summary: ${summary}`,
    '',
    'The goal has not yet been met. Based on what was accomplished above,',
    'continue working toward the goal. Focus on remaining work only.',
    '',
    `Goal: ${goal}`,
  ].join('\n');
}

// ─── Core loop ────────────────────────────────────────────────────────────────

export async function runGoalLoop(
  goal: string,
  options: GoalLoopOptions = {},
): Promise<GoalLoopResult> {
  const startedAt = new Date().toISOString();
  const maxIterations = positiveInt(options.maxIterations, DEFAULT_MAX_ITERATIONS);
  const iterations: GoalIterationResult[] = [];
  let finalRunDir: string | null = null;

  let task = goal;

  for (let i = 1; i <= maxIterations; i++) {
    // Token budget exhaustion check
    if (options.tokenBudget !== undefined && options.tokenBudget <= 0) {
      return {
        status: 'token_budget_exhausted',
        goal,
        iterations,
        finalRunDir,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    const result: PipelineResult = await runBabelPipeline(task, {
      mode: options.mode ?? 'deep',
      ...(options.project ? { project: options.project } : {}),
    });

    // Decrement token budget from actual pipeline usage (or 1 as floor).
    const iterationTokens = result.usageSummary?.totalTokens ?? 1;
    if (options.tokenBudget !== undefined) {
      options.tokenBudget = Math.max(0, options.tokenBudget - iterationTokens);
    }

    const iterationResult: GoalIterationResult = {
      iteration: i,
      status: result.status,
      runDir: result.runDir,
      summary: summarizeResult(result),
    };
    iterations.push(iterationResult);
    finalRunDir = result.runDir ?? finalRunDir;

    // Blocking failures — stop the loop
    if (isBlocking(result)) {
      return {
        status:
          result.status === 'QA_REJECTED_MAX_LOOPS'
            ? 'halted_by_qa_reject'
            : 'halted_by_executor_error',
        goal,
        iterations,
        finalRunDir,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    // Forward progress — goal may be met
    if (isTerminalProgress(result)) {
      // If this is the last iteration, assume goal is met (COMPLETE on final iteration)
      if (i === maxIterations) {
        return {
          status: 'goal_met',
          goal,
          iterations,
          finalRunDir,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      // Heuristic: if the pipeline completed with no modifications, the goal
      // was likely already satisfied or the task was a no-op => goal met.
      if (result.status === 'COMPLETE_NO_MODIFICATION') {
        return {
          status: 'goal_met',
          goal,
          iterations,
          finalRunDir,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      // COMPLETE or SMALL_FIX_COMPLETE: goal may be met. Continue if budget remains.
      // (A more sophisticated check would verify against a user-provided condition.)
    }

    // Enrich task for next iteration
    if (i < maxIterations) {
      task = enrichTaskForNextIteration(goal, result, i);
    }
  }

  return {
    status: 'max_iterations_reached',
    goal,
    iterations,
    finalRunDir,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
