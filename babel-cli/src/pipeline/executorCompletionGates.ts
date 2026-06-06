import { relative } from 'node:path';

import type { SwePlan, ToolCallLog } from '../schemas/agentContracts.js';
import {
  isWithinProjectRootPath,
  resolveStepTargetPath,
} from '../stages/executorHelpers.js';
import {
  getRequestedTargetContract,
  normalizePathForComparison,
} from '../stages/taskShape.js';
import { verifyBoundedTaskArtifacts } from '../stages/verification.js';
import { isExternalBenchmarkTask } from './benchmarkTasks.js';

export function buildMissingPlannedFileWritesCondition(missingTargets: readonly string[]): string {
  return (
    `Executor reported EXECUTION_COMPLETE before successful file_write for planned target(s): ` +
    `${missingTargets.join(', ')}`
  );
}

export function buildEvidenceRequestCompletionCondition(): string {
  return 'EVIDENCE_REQUEST minimal_action_set satisfied.';
}

export function buildMaxTurnsExceededCondition(maxTurns: number): string {
  return `Executor exceeded the maximum of ${maxTurns} turns without a terminal signal.`;
}

export function buildExternalPostconditionFeedback(attempt: number, semanticFailure: string): string {
  return [
    `[Postcondition ${attempt}] external_benchmark_verification -> requested output artifact`,
    'Exit code: 1',
    'Stdout: (empty)',
    `Stderr: ${semanticFailure}`,
    'Verification: FAILED',
  ].join('\n');
}

export function getMissingSuccessfulPlannedFileWrites(params: {
  approvedPlan: SwePlan;
  toolCallLog: readonly ToolCallLog[];
  projectRoot: string | null;
}): string[] {
  const plannedWrites = params.approvedPlan.minimal_action_set
    .filter(step => step.tool === 'file_write')
    .map(step => String(step.target ?? '').trim())
    .filter(target => target.length > 0);
  if (plannedWrites.length === 0) {
    return [];
  }

  const targetKey = (target: string): string => {
    const normalized = normalizePathForComparison(target);
    if (!params.projectRoot) {
      return normalized.toLowerCase();
    }

    const resolved = resolveStepTargetPath(params.projectRoot, normalized);
    if (isWithinProjectRootPath(params.projectRoot, resolved)) {
      return relative(params.projectRoot, resolved).replace(/\\/g, '/').toLowerCase();
    }

    return resolved.replace(/\\/g, '/').toLowerCase();
  };

  const successfulWrites = new Set(
    params.toolCallLog
      .filter(entry => entry.tool === 'file_write' && entry.exit_code === 0)
      .map(entry => targetKey(String(entry.target ?? ''))),
  );

  return plannedWrites.filter(target =>
    !successfulWrites.has(targetKey(target)),
  );
}

export function shouldCompleteBoundedWriteTask(params: {
  approvedPlan: SwePlan;
  rawTask: string;
  toolCallLog: readonly ToolCallLog[];
  projectRoot: string | null;
}): boolean {
  if (isExternalBenchmarkTask(params.rawTask)) {
    return false;
  }

  const contract = getRequestedTargetContract(params.rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0) {
    return false;
  }

  const planTools = params.approvedPlan.minimal_action_set.map(step => step.tool);
  if (!planTools.every(tool => ['directory_list', 'file_read', 'file_write'].includes(tool))) {
    return false;
  }

  const successfulWrites = new Set(
    params.toolCallLog
      .filter(entry => entry.tool === 'file_write' && entry.exit_code === 0)
      .map(entry => normalizePathForComparison(String(entry.target ?? '')).toLowerCase()),
  );
  const allRequestedTargetsWritten = contract.requestedTargets.every(target =>
    successfulWrites.has(normalizePathForComparison(target).toLowerCase()),
  );
  if (!allRequestedTargetsWritten) {
    return false;
  }

  return !verifyBoundedTaskArtifacts(
    params.rawTask,
    [...params.toolCallLog],
    params.projectRoot,
  );
}
