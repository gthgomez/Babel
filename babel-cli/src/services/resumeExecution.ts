import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { executeTool } from '../localTools.js';
import { runAskAnswerPath } from './askAnswer.js';
import { buildRecoveryAssessment, type RecoveryAssessment } from './recovery.js';
import {
  findRuntimeEventLogInRunDir,
  RESUME_HEURISTIC_FALLBACK_FLAG,
  resumeHeuristicFallbackEnabled,
  resumeReplayFromLog,
  type ResumeReplayResultV1,
} from './resumeReplay.js';
import { runSmallFixPath } from './smallFix.js';

export interface ResumeExecutionReplayEvidence {
  source: 'event_log';
  path: string;
  state_hash: string;
  last_cursor_sequence: number;
  torn_tail: boolean;
  discarded_facts: number;
  checkpoints: string[];
  indeterminate_operations: string[];
  operator_action_required: boolean;
  /** Always false: automatic resume stays disabled (P06 operator gate). */
  automatic_resume: false;
}

export interface ResumeExecutionResult {
  status:
    | 'RESUME_COMPLETE'
    | 'RESUME_FAILED'
    | 'RESUME_NOT_RESUMABLE'
    | 'NO_LATEST_RUN'
    | 'RUN_NOT_FOUND';
  run_dir: string | null;
  classification: string | null;
  reason: string;
  action: string | null;
  resumed_run_dir?: string | null;
  changed_files: string[];
  checks: string[];
  recovery: {
    available_artifacts: RecoveryAssessment['available_artifacts'];
    missing_artifacts: RecoveryAssessment['missing_artifacts'];
    failure_code: string | null;
    failed_command: string | null;
  };
  /**
   * Packet A4: replay-first hydration evidence. When a runtime EventLog was
   * replayed, this carries the deterministic state hash and the P06
   * classification of indeterminate effects; it is `null` when no replayable
   * log exists (heuristic fallback) or when the fallback answered.
   */
  replay?: ResumeExecutionReplayEvidence | null;
}

export interface ResumeExecutionOptions {
  run?: string;
  project?: string;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function writeResumeSummary(runDir: string, result: ResumeExecutionResult): void {
  writeFileSync(
    join(runDir, 'resume_execution_summary.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        ...result,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

function nonResumable(assessment: RecoveryAssessment, reason: string): ResumeExecutionResult {
  return {
    status:
      assessment.status === 'NO_LATEST_RUN' || assessment.status === 'RUN_NOT_FOUND'
        ? assessment.status
        : 'RESUME_NOT_RESUMABLE',
    run_dir: assessment.run_dir,
    classification: assessment.classification,
    reason,
    action: null,
    changed_files: [],
    checks: [],
    recovery: {
      available_artifacts: assessment.available_artifacts,
      missing_artifacts: assessment.missing_artifacts,
      failure_code: assessment.failure_code,
      failed_command: assessment.failed_command,
    },
  };
}

async function resumeVerifierFailure(
  assessment: RecoveryAssessment,
): Promise<ResumeExecutionResult> {
  const runDir = assessment.run_dir;
  const command = assessment.failed_command;
  const projectRoot =
    getString(assessment.failure_capsule?.['project_root']) ??
    getString(
      (assessment.execution_report?.['small_fix'] as Record<string, unknown> | undefined)?.[
        'project_root'
      ],
    );

  if (!runDir || !command || !projectRoot || !existsSync(projectRoot)) {
    return nonResumable(assessment, 'Verifier rerun needs a saved command and project root.');
  }

  const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  process.env['BABEL_PROJECT_ROOT'] = projectRoot;
  let result;
  try {
    result = await executeTool(
      {
        tool: 'test_run',
        command,
        working_directory: projectRoot,
        timeout_seconds: 120,
      },
      {
        agentId: 'resume',
        runId: `resume_${Date.now()}`,
        runDir,
        babelRoot: projectRoot,
      },
    );
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
    }
  }

  const output: ResumeExecutionResult = {
    status: result.exit_code === 0 ? 'RESUME_COMPLETE' : 'RESUME_FAILED',
    run_dir: runDir,
    classification: assessment.classification,
    reason:
      result.exit_code === 0 ? 'Verifier passed on resume.' : 'Verifier still fails on resume.',
    action: 'rerun_verifier',
    changed_files: Array.isArray(assessment.terminal_status_summary?.['changed_files'])
      ? (assessment.terminal_status_summary?.['changed_files'] as unknown[]).filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    checks: [`${command}: ${result.exit_code === 0 ? 'passed' : 'failed'}`],
    recovery: {
      available_artifacts: assessment.available_artifacts,
      missing_artifacts: assessment.missing_artifacts,
      failure_code: assessment.failure_code,
      failed_command: assessment.failed_command,
    },
  };
  writeResumeSummary(runDir, output);
  return output;
}

async function retrySavedDirectPath(
  assessment: RecoveryAssessment,
  options: ResumeExecutionOptions,
): Promise<ResumeExecutionResult> {
  const capsule = assessment.failure_capsule;
  const task = getString(capsule?.['task']);
  const projectRoot = getString(capsule?.['project_root']);
  const targetFile = getString(capsule?.['target_file']);
  const commandKind = getString(assessment.terminal_status_summary?.['failed_command']);

  if (!task) {
    return nonResumable(assessment, 'Provider retry needs saved task text from the failed run.');
  }

  if (targetFile) {
    let result;
    try {
      result = await runSmallFixPath({
        task,
        ...(projectRoot ? { projectRoot } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.modelTier ? { modelTier: options.modelTier } : {}),
        ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
      });
    } catch (error: unknown) {
      return {
        status: 'RESUME_FAILED',
        run_dir: assessment.run_dir,
        classification: assessment.classification,
        reason: error instanceof Error ? error.message : String(error),
        action: 'retry_small_fix',
        changed_files: [],
        checks: [],
        recovery: {
          available_artifacts: assessment.available_artifacts,
          missing_artifacts: assessment.missing_artifacts,
          failure_code: assessment.failure_code,
          failed_command: assessment.failed_command,
        },
      };
    }
    if (result.status === 'SMALL_FIX_NOT_APPLICABLE') {
      return nonResumable(assessment, result.reason);
    }
    return {
      status: result.status === 'SMALL_FIX_COMPLETE' ? 'RESUME_COMPLETE' : 'RESUME_FAILED',
      run_dir: assessment.run_dir,
      classification: assessment.classification,
      reason: result.summary,
      action: 'retry_small_fix',
      resumed_run_dir: result.runDir,
      changed_files: result.changedFiles,
      checks: result.checks,
      recovery: {
        available_artifacts: assessment.available_artifacts,
        missing_artifacts: assessment.missing_artifacts,
        failure_code: assessment.failure_code,
        failed_command: assessment.failed_command,
      },
    };
  }

  if (
    commandKind === 'ask' ||
    assessment.classification === 'retry_same_command' ||
    assessment.classification === 'retry_with_schema_repair'
  ) {
    let result;
    try {
      result = await runAskAnswerPath({
        task,
        ...(projectRoot ? { projectRoot } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.modelTier ? { modelTier: options.modelTier } : {}),
        ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
      });
    } catch (error: unknown) {
      return {
        status: 'RESUME_FAILED',
        run_dir: assessment.run_dir,
        classification: assessment.classification,
        reason: error instanceof Error ? error.message : String(error),
        action: 'retry_ask',
        changed_files: [],
        checks: [],
        recovery: {
          available_artifacts: assessment.available_artifacts,
          missing_artifacts: assessment.missing_artifacts,
          failure_code: assessment.failure_code,
          failed_command: assessment.failed_command,
        },
      };
    }
    return {
      status: result.status === 'ANSWER_READY' ? 'RESUME_COMPLETE' : 'RESUME_FAILED',
      run_dir: assessment.run_dir,
      classification: assessment.classification,
      reason: result.answer.summary,
      action: 'retry_ask',
      resumed_run_dir: result.runDir,
      changed_files: [],
      checks: ['read-only answer path'],
      recovery: {
        available_artifacts: assessment.available_artifacts,
        missing_artifacts: assessment.missing_artifacts,
        failure_code: assessment.failure_code,
        failed_command: assessment.failed_command,
      },
    };
  }

  return nonResumable(
    assessment,
    'Saved run does not identify a supported action-taking resume path.',
  );
}

export async function resumeExecution(
  options: ResumeExecutionOptions = {},
): Promise<ResumeExecutionResult> {
  const assessment = buildRecoveryAssessment({
    run: options.run ?? 'latest',
    ...(options.project ? { project: options.project } : {}),
  });

  // Packet A4: replay-first. Hydrate from the conversation's runtime EventLog
  // when one exists; the pre-A4 artifact-availability heuristic remains only
  // as a flag-guarded fallback (BABEL_RESUME_HEURISTIC_FALLBACK). Replay
  // evidence never authorizes execution by itself: indeterminate effects are
  // surfaced through the P06 restore report, and the action-taking decision
  // below still runs through the existing recovery classification with
  // automatic resume disabled.
  const replay = assessment.run_dir
    ? resumeReplayFromLog(findRuntimeEventLogInRunDir(assessment.run_dir) ?? '')
    : null;
  if (replay !== null && !replay.ok && !resumeHeuristicFallbackEnabled()) {
    return {
      ...nonResumable(
        assessment,
        'No replayable runtime EventLog exists for this run and the artifact heuristic ' +
          `fallback is disabled (${RESUME_HEURISTIC_FALLBACK_FLAG}=off).`,
      ),
      replay: null,
    };
  }

  let result: ResumeExecutionResult;
  if (assessment.status !== 'CONTINUE_READY') {
    result = nonResumable(assessment, assessment.reason);
  } else if (!assessment.classification || !assessment.retryable) {
    result = nonResumable(assessment, assessment.reason);
  } else if (assessment.classification === 'requires_user_decision') {
    result = nonResumable(assessment, assessment.reason);
  } else if (assessment.classification === 'rerun_verifier') {
    result = await resumeVerifierFailure(assessment);
  } else if (
    assessment.classification === 'retry_same_command' ||
    assessment.classification === 'retry_with_schema_repair'
  ) {
    result = await retrySavedDirectPath(assessment, options);
  } else {
    result = nonResumable(
      assessment,
      `No action-taking resume path exists for ${assessment.classification}.`,
    );
  }
  return withReplayEvidence(result, replay);
}

/** Attach replay hydration evidence to a resume result (never mutates status). */
function withReplayEvidence(
  result: ResumeExecutionResult,
  replay: ResumeReplayResultV1 | null,
): ResumeExecutionResult {
  if (!replay || !replay.ok) {
    return { ...result, replay: null };
  }
  const indeterminate = replay.state.operations
    .filter((operation) => operation.indeterminateReason !== null)
    .map((operation) => operation.operationId);
  return {
    ...result,
    replay: {
      source: 'event_log',
      path: replay.path,
      state_hash: replay.state.stateHash,
      last_cursor_sequence: replay.state.lastCursorSequence,
      torn_tail: replay.tornTail,
      discarded_facts: replay.discarded,
      checkpoints: [...replay.state.checkpointIds],
      indeterminate_operations: indeterminate,
      operator_action_required: replay.restore.operatorActionRequired,
      automatic_resume: false,
    },
  };
}

export function formatResumeExecutionHuman(result: ResumeExecutionResult): string {
  const lines = ['Babel Resume', `Status: ${result.status}`];
  if (result.run_dir) {
    lines.push(`Run: ${result.run_dir}`);
  }
  if (result.classification) {
    lines.push(`Recovery: ${result.classification}`);
  }
  lines.push(`Reason: ${result.reason}`);
  if (result.action) {
    lines.push(`Action: ${result.action}`);
  }
  if (result.resumed_run_dir) {
    lines.push(`New run: ${result.resumed_run_dir}`);
  }
  if (result.replay) {
    lines.push(`Replay: event_log state ${result.replay.state_hash.slice(0, 12)}…` +
      ` (cursor ${result.replay.last_cursor_sequence})` +
      (result.replay.torn_tail ? ' [torn tail discarded]' : ''));
    if (result.replay.indeterminate_operations.length > 0) {
      lines.push(
        `Indeterminate operations (operator review required): ${result.replay.indeterminate_operations.join(', ')}`,
      );
    }
  }
  if (result.checks.length > 0) {
    lines.push('');
    lines.push('Checks:');
    for (const check of result.checks) {
      lines.push(`- ${check}`);
    }
  }
  lines.push('');
  lines.push('Available evidence:');
  if (result.recovery.available_artifacts.length === 0) {
    lines.push('- none');
  } else {
    for (const artifact of result.recovery.available_artifacts) {
      lines.push(`- ${artifact.key}: ${artifact.path}`);
    }
  }
  return lines.join('\n');
}
