import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ToolCallLog } from '../schemas/agentContracts.js';
import type { AttemptSafetySummary } from '../services/terminalStatus.js';
import type {
  WorktreeRollbackSummary,
  WorktreeSafetySummary,
} from '../services/worktreeSafety.js';
import type { AutonomousRepairProofTimeline } from '../services/autonomousRepairProofEvidence.js';
import type { PipelineTerminalContext } from './finalization.js';

function readJsonArtifact<T>(runDir: string, filename: string): T | null {
  const path = join(runDir, filename);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function collectTerminalContext(runDir: string): PipelineTerminalContext {
  const report = readJsonArtifact<{
    tool_call_log?: ToolCallLog[];
    pipeline_error?: { condition?: string };
    reason?: string;
  }>(runDir, '04_execution_report.json');
  const timeline = readJsonArtifact<AutonomousRepairProofTimeline>(runDir, 'repair_attempt_timeline.json') ??
    readJsonArtifact<AutonomousRepairProofTimeline>(runDir, '12_repair_attempt_timeline.json');
  const attemptSafetySummary = readJsonArtifact<AttemptSafetySummary>(runDir, 'attempt_safety_summary.json');
  const rollbackSummary = readJsonArtifact<WorktreeRollbackSummary>(runDir, 'rollback_summary.json');
  const worktreeSafetySummary = readJsonArtifact<WorktreeSafetySummary>(runDir, 'worktree_safety_summary.json');
  const latestFailureCapsulePath = timeline?.attempts
    .map(attempt => attempt.failure_capsule_path)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .at(-1) ?? null;

  return {
    toolCallLog: report?.tool_call_log ?? [],
    condition: report?.pipeline_error?.condition ?? report?.reason ?? null,
    failureCapsulePath: latestFailureCapsulePath,
    repairAttemptTimelinePath: timeline ? join(runDir, 'repair_attempt_timeline.json') : null,
    attemptSafetySummaryPath: attemptSafetySummary ? join(runDir, 'attempt_safety_summary.json') : null,
    attemptSafetySummary,
    rollbackSummaryPath: rollbackSummary ? join(runDir, 'rollback_summary.json') : null,
    rollbackSummary,
    worktreeSafetySummaryPath: worktreeSafetySummary ? join(runDir, 'worktree_safety_summary.json') : null,
    worktreeSafetySummary,
  };
}
