import { join } from 'node:path';

import { z } from 'zod';

import { compileContext } from '../compiler.js';
import { buildToolCapabilityPromptLines } from '../config/toolCapabilities.js';
import { resolveExecutionProfile } from '../config/executionProfiles.js';
import { EvidenceBundle } from '../evidence.js';
import { runWithFallback, type TargetModel } from '../execute.js';
import {
  DRY_RUN,
  ToolCallRequestSchema,
} from '../localTools.js';
import { runPreToolUseHooks, type RuntimeHookTraceEvent } from '../runtime/hooks.js';
import { autoCompactIfNeeded } from '../services/compaction.js';
import type {
  AutonomousRepairProofAttemptEvidence,
  AutonomousRepairProofTimeline,
  CompletionGuardEvidence,
  RepairProofFileHash,
} from '../services/autonomousRepairProofEvidence.js';
import {
  buildFailureCapsule,
  formatFailureCapsuleForPrompt,
  maxAttemptsForRepairMode,
} from '../services/repairGovernance.js';
import { writeExecutorSessionContext } from '../services/sessionContext.js';
import {
  buildAttemptSafetySummary,
  buildTerminalStatusSummary,
  type RollbackMode,
  type TerminalStatus,
} from '../services/terminalStatus.js';
import {
  createWorktreeSafetyController,
  type WorktreeRollbackStatus,
  type WorktreeRollbackSummary,
} from '../services/worktreeSafety.js';
import {
  ExecutorTurnSchema,
  type SwePlan,
  type ToolCallLog,
} from '../schemas/agentContracts.js';
import {
  buildBenchmarkVerificationPromptLines,
  type BenchmarkVerificationResult,
} from '../stages/benchmarkVerification.js';
import {
  assertExecutorGate,
  buildExecutorRepairPrompt,
  buildExecutorTask,
  buildExecutorTurnPrompt,
  buildHaltReport,
  buildTerminalReport,
  canonicalizeExecutorTargetForLog,
  classifyRunnerExhaustionHaltTag,
  formatHistoryEntry,
  getExecutorProjectRoot,
  getTarget,
  isSameRecoverableCommandRetry,
  shouldForceRecoverableCommandRerun,
  type PendingRecoverableCommandRetry,
} from '../stages/executorHelpers.js';
import {
  createRepairState,
  formatFailureFingerprint,
  recordRepairFailure,
  type RepairState,
} from '../stages/executorRepairState.js';
import {
  AMBIGUOUS_LITERAL_BINDING_STATUS,
  EXACT_INSTRUCTION_DRIFT_STATUS,
} from '../stages/exactInvariants.js';
import { runGodotArtifactRepairLoop } from '../stages/godotArtifactRepair.js';
import { seedGodotMobileScaffold } from '../stages/godotScaffoldSeeder.js';
import { evaluatePreCompleteGuards } from '../stages/preCompleteGuards.js';
import {
  evaluateRunnableArtifactGate,
  runnableArtifactGateBlocksCompletion,
  runnableArtifactGateHaltDecision,
} from '../stages/runnableArtifactGate.js';
import { runRuntimeVerification } from '../stages/runtimeVerificationRunner.js';
import {
  getDeterministicSimpleRepairWrite,
  getDirectBoundedWritePlan,
  getNextDeterministicSimpleWrite,
} from '../stages/simpleArtifactFallback.js';
import {
  getBoundedExecutorContractLines,
  getRequestedTargetContract,
  isAndroidWarningCleanupRequest,
  isWriteReportTarget,
  normalizePathForComparison,
  normalizeRequestedFileTargetsForBoundedContract,
} from '../stages/taskShape.js';
import {
  maybeHandleNewFilePreflightFastPath,
  normalizePlanTargetsAgainstRequestedOutputs,
  verifyBoundedTaskArtifacts,
  verifySuccessfulTextWriteTarget,
} from '../stages/verification.js';
import {
  getBenchmarkRuntimeInventoryForProfile,
  getBenchmarkRuntimeInventoryLines,
} from './benchmarkRuntime.js';
import {
  BABEL_ROOT,
  BENCHMARK_INSTALL_RECOVERY_TAG,
  EXECUTOR_PATHS,
  MAX_EXECUTOR_TURNS,
  abs,
} from './paths.js';
import {
  getBenchmarkInstallRecoveryBlockReason,
  getExternalRepairRerunLimit,
  isBenchmarkDependencyInstallCommand,
  isExternalBenchmarkTask,
  normalizeShellCommandForComparison,
  shouldHaltExternalRepairRerun,
} from './benchmarkTasks.js';
import {
  buildEvidenceRequestCompletionCondition,
  buildExternalPostconditionFeedback,
  buildMaxTurnsExceededCondition,
  buildMissingPlannedFileWritesCondition,
  getMissingSuccessfulPlannedFileWrites,
  shouldCompleteBoundedWriteTask,
} from './executorCompletionGates.js';
import {
  buildBlockedExecutorToolCallEntry,
  buildExecutorToolCallEntry,
  buildNonRecoverableToolFailureCondition,
  buildTruncationArtifactConditions,
  executeExecutorTool,
  getSuccessfulFileReadCacheEntry,
} from './executorToolDispatch.js';
import {
  getAllowedToolsFromEnv,
  getNpmWrongWorkingDirectoryHint,
  inferCommandOnlyNoModificationRequest,
  inferVerifierCommandFromTask,
  isExecutorCommandPlaceholder,
  isOptionalVerifierRequest,
  isShellExecutionToolAvailable,
  isVerifierNotFoundFailure,
  shouldRecoverCommandFailure,
} from './executorRecovery.js';
import { isEvidenceRequestPlanSatisfied } from './executorEvidenceRequests.js';
import type { ExecutorLoopResult } from './executorLoopTypes.js';
import {
  isExecutorToolShapePlaceholder,
  replaceExecutorRequestTarget,
} from './executorToolShape.js';
import { writeValidatedExecutionReport } from './executionReports.js';
import { evaluateExactInstructionInvariants } from './exactInstructionGuards.js';
import {
  repairExactOutputSchemaArtifacts,
  verifyExactOutputSchemaArtifacts,
} from './exactOutputArtifacts.js';
import { emitRuntimeEvent, log, logDetail } from './logging.js';
import {
  RELIABILITY_REPAIR_PROOF_MARKER,
  getReliabilityRepairProofMaxFailures,
  hashProjectFileForEvidence,
  hasMeaningfulRepairDiff,
  isReliabilityRepairProofEnabled,
  snapshotProjectFilesForSafety,
  summarizeVerifierStreamForEvidence,
  type RepairProofCapsuleArtifact,
} from './repairProof.js';


/**
 * Stage 4: runs the CLI Executor in a stateless text-loop via `runWithFallback`.
 *
 * Each iteration compiles a fresh prompt = base context + execution history +
 * next-action instruction, calls `runWithFallback` expecting an `ExecutorTurn`
 * (either a tool call or a completion signal), executes any tool call, and
 * appends the result to `executionHistory` for the next iteration.
 *
 * No Anthropic SDK — all LLM calls go through the same waterfall as Stages 1-3.
 */
export async function runExecutorLoop(
  approvedPlan: SwePlan,
  evidence:     EvidenceBundle,
  targetModel:  TargetModel,
  reportWarnings: string[] = [],
  initialToolCallLog: ToolCallLog[] = [],
  rawTask: string = '',
  pruningStubs?: Map<string, string>,
): Promise<ExecutorLoopResult> {
  assertExecutorGate(evidence.runDir);

  const reliabilityRepairProofEnabled = isReliabilityRepairProofEnabled(rawTask);
  const requestedTargetContract = getRequestedTargetContract(rawTask);
  const compactFileOnlyExecutor =
    !isExternalBenchmarkTask(rawTask) &&
    requestedTargetContract.bounded &&
    requestedTargetContract.requestedTargets.length > 0 &&
    approvedPlan.minimal_action_set.every(step =>
      ['directory_list', 'file_read', 'file_write'].includes(String(step.tool)),
    );

  // ── Compile base context once ────────────────────────────────────────────
  const executorRuntimeLines = [
    ...(reliabilityRepairProofEnabled
      ? [`Reliability repair proof marker: ${RELIABILITY_REPAIR_PROOF_MARKER}`]
      : []),
    ...getBoundedExecutorContractLines(rawTask),
    ...getBenchmarkRuntimeInventoryLines(
      resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']).name,
      false,
    ),
    ...buildToolCapabilityPromptLines(resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']).name),
    ...buildBenchmarkVerificationPromptLines(rawTask),
  ];
  const baseContext = await compileContext(
    abs(EXECUTOR_PATHS),
    buildExecutorTask(
      approvedPlan,
      rawTask,
      executorRuntimeLines,
      {
        compactFileOnly: compactFileOnlyExecutor,
        allowCommandRecovery: true,
      },
    ),
    undefined,
    pruningStubs,
  );
  evidence.writeCompiledContext('executor', baseContext);

  const normalizedInitialToolCallLog: ToolCallLog[] = initialToolCallLog.map(entry => ({
    ...entry,
    target: canonicalizeExecutorTargetForLog(entry.target, entry.tool),
  }));

  let executionHistory = normalizedInitialToolCallLog.map(formatHistoryEntry).join('\n\n');
  const toolCallLog: ToolCallLog[] = [...normalizedInitialToolCallLog];

  // FILE_READ_CACHE: stores the complete, untruncated content of every
  // file_read result keyed by the resolved file path. Injected verbatim into
  // every executor turn prompt so the LLM never reconstructs file content from
  // memory when writing. This is the primary defence against the truncation bug
  // where the executor wrote the "... [N chars truncated] ..." history marker
  // into the file content of a file_write.
  const fileReadCache = new Map<string, string>();
  let externalPostconditionFailures = 0;
  let externalRepairRerunCount = 0;
  let recoverableCommandFailures = 0;
  const pendingRecoverableCommandRetryState: { value: PendingRecoverableCommandRetry | null } = {
    value: null,
  };
  let blockedBenchmarkInstallRecoveryCount = 0;
  let blockedToolCapabilityRecoveryCount = 0;
  const maxRecoverableCommandFailures = reliabilityRepairProofEnabled
    ? getReliabilityRepairProofMaxFailures()
    : maxAttemptsForRepairMode('autonomous');
  let repairState: RepairState = createRepairState(maxRecoverableCommandFailures);
  let latestFailureCapsuleArtifact: RepairProofCapsuleArtifact | null = null;
  let currentRepairAttemptInputCapsule: RepairProofCapsuleArtifact | null = null;
  let currentRepairAttemptChangedFiles = new Set<string>();
  let currentRepairAttemptFileHashes: Record<string, RepairProofFileHash> = {};
  const repairAttemptTimeline: AutonomousRepairProofAttemptEvidence[] = [];
  const attemptSafetyInitialSnapshot = snapshotProjectFilesForSafety(getExecutorProjectRoot());
  const worktreeSafety = createWorktreeSafetyController({
    projectRoot: getExecutorProjectRoot(),
    runDir: evidence.runDir,
  });
  let latestRollbackSummary: WorktreeRollbackSummary | null = null;
  let latestRollbackMode: RollbackMode = 'snapshot_only';
  const repairProofNotes: string[] = reliabilityRepairProofEnabled
    ? ['Deterministic model-boundary response provider enabled for live fail-then-pass reliability proof; file writes, verifier runs, failure capsules, retries, and completion guards still execute through the normal autonomous pipeline.']
    : [];
  let finalCompletionGuardResult: CompletionGuardEvidence = {
    status: 'not_run',
    semantic_failure: null,
    runtime_hook_event_count: 0,
    benchmark_verification_status: null,
  };
  const markInputCapsuleConsumed = (capsule: RepairProofCapsuleArtifact | null): void => {
    if (!capsule) {
      return;
    }
    const sourceAttempt = repairAttemptTimeline.find(attempt =>
      attempt.failure_capsule_id === capsule.id ||
      attempt.failure_capsule_path === capsule.path
    );
    if (sourceAttempt) {
      sourceAttempt.next_attempt_consumed_capsule = true;
    }
  };
  const maxBenchmarkInstallRecoveryBlocks = 1;
  const maxBlockedToolCapabilityRecoveries = 1;
  const runtimeHookTraceEvents: RuntimeHookTraceEvent[] = [];
  const preCompleteVerificationTrace: BenchmarkVerificationResult[] = [];

  const writeWorktreeSafetySummary = (): void => {
    evidence.writeDebugFile(
      'worktree_safety_summary.json',
      `${JSON.stringify(worktreeSafety.buildSummary(), null, 2)}\n`,
    );
  };

  const shouldReplaceEffectiveRollbackSummary = (
    current: WorktreeRollbackSummary | null,
    candidate: WorktreeRollbackSummary,
  ): boolean => {
    if (!current) {
      return true;
    }
    const priority: Record<WorktreeRollbackStatus, number> = {
      rollback_failed: 4,
      rollback_skipped_user_dirty_target: 3,
      rollback_applied: 2,
      rollback_not_needed: 1,
    };
    return priority[candidate.status] >= priority[current.status];
  };

  const effectiveRollbackStatusFor = (status: WorktreeRollbackStatus): WorktreeRollbackStatus => {
    if (
      status === 'rollback_not_needed' &&
      latestRollbackSummary?.status === 'rollback_applied'
    ) {
      return 'rollback_applied';
    }
    return status;
  };

  const writeRollbackSummary = (summary: WorktreeRollbackSummary): void => {
    if (shouldReplaceEffectiveRollbackSummary(latestRollbackSummary, summary)) {
      latestRollbackSummary = summary;
      latestRollbackMode = summary.status;
    }
    const rollbackSummaryPath = join(evidence.runDir, 'rollback_summary.json');
    worktreeSafety.setRollbackSummaryPath(rollbackSummaryPath);
    evidence.writeDebugFile(
      'rollback_summary.json',
      `${JSON.stringify(latestRollbackSummary ?? summary, null, 2)}\n`,
    );
    writeWorktreeSafetySummary();
  };

  const rollbackStatusToTerminalStatus = (
    rollbackStatus: WorktreeRollbackStatus,
    fallbackStatus: TerminalStatus,
  ): TerminalStatus => {
    if (rollbackStatus === 'rollback_failed') {
      return 'ROLLBACK_FAILED';
    }
    if (rollbackStatus === 'rollback_applied') {
      return 'ROLLBACK_APPLIED';
    }
    if (rollbackStatus === 'rollback_skipped_user_dirty_target') {
      return 'WORKTREE_DIRTY_UNSAFE';
    }
    return fallbackStatus;
  };

  const rollbackTouchedFilesForFailure = (
    underlyingStatus: TerminalStatus,
    reason: string,
  ): {
    summary: WorktreeRollbackSummary;
    terminalStatus: TerminalStatus;
    conditionPrefix: string;
  } => {
    const summary = worktreeSafety.rollbackTouchedFiles(reason);
    writeRollbackSummary(summary);
    const effectiveRollbackStatus = effectiveRollbackStatusFor(summary.status);
    const terminalStatus = rollbackStatusToTerminalStatus(effectiveRollbackStatus, underlyingStatus);
    const conditionPrefix = effectiveRollbackStatus === 'rollback_applied'
      ? `[ROLLBACK_APPLIED] Rolled back touched files during this failed repair run.`
      : effectiveRollbackStatus === 'rollback_failed'
        ? `[ROLLBACK_FAILED] Automatic rollback failed after failed repair.`
        : effectiveRollbackStatus === 'rollback_skipped_user_dirty_target'
          ? `[WORKTREE_DIRTY_UNSAFE] Rollback skipped because target files were dirty before the run.`
          : `[${underlyingStatus}] No rollback changes were needed.`;
    return { summary, terminalStatus, conditionPrefix };
  };

  writeWorktreeSafetySummary();

  const writeRepairAttemptTimeline = (finalStatus: string | null = null): void => {
    if (repairAttemptTimeline.length === 0 && !reliabilityRepairProofEnabled) {
      return;
    }
    const timeline: AutonomousRepairProofTimeline = {
      schema_version: 1,
      proof_id: reliabilityRepairProofEnabled
        ? 'autonomous_live_fail_then_pass_repair'
        : 'autonomous_repair_attempt_timeline',
      proof_kind: reliabilityRepairProofEnabled ? 'deterministic_model_boundary_assisted' : 'fully_autonomous',
      deterministic_test_double: reliabilityRepairProofEnabled,
      max_attempts: maxRecoverableCommandFailures,
      attempt_count: repairAttemptTimeline.length,
      attempts: repairAttemptTimeline,
      final_status: finalStatus,
      final_completion_guard_result: finalCompletionGuardResult,
      changed_files: [...new Set(repairAttemptTimeline.flatMap(attempt => attempt.changed_files))].sort(),
      verifier_command_log: repairAttemptTimeline.map(attempt => ({
        attempt: attempt.attempt,
        command: attempt.verifier_command,
        cwd: attempt.verifier_cwd,
        exit_code: attempt.verifier_exit_code,
      })),
      notes: repairProofNotes,
    };
    evidence.writeDebugFile(
      '12_repair_attempt_timeline.json',
      `${JSON.stringify(timeline, null, 2)}\n`,
    );
    evidence.writeDebugFile(
      'repair_attempt_timeline.json',
      `${JSON.stringify(timeline, null, 2)}\n`,
    );
    if (finalStatus !== null) {
      const attemptSafetySummary = buildAttemptSafetySummary({
        timeline,
        initialSnapshot: attemptSafetyInitialSnapshot,
        finalSnapshot: snapshotProjectFilesForSafety(getExecutorProjectRoot()),
        rollbackMode: latestRollbackMode,
        rollbackStatus: latestRollbackSummary?.status ?? latestRollbackMode,
        rollbackSummaryPath: latestRollbackSummary ? join(evidence.runDir, 'rollback_summary.json') : null,
        worktreeSafetySummaryPath: join(evidence.runDir, 'worktree_safety_summary.json'),
        restoredFiles: latestRollbackSummary?.restored_files ?? [],
        dirtyFilesPreserved: latestRollbackSummary?.dirty_files_preserved ?? [],
        targetDirtyConflicts: latestRollbackSummary?.target_dirty_conflicts ?? worktreeSafety.buildSummary().target_dirty_conflicts,
      });
      evidence.writeDebugFile(
        'attempt_safety_summary.json',
        `${JSON.stringify(attemptSafetySummary, null, 2)}\n`,
      );
      evidence.writeDebugFile(
        'repair_final_status.json',
        `${JSON.stringify({
          schema_version: 1,
          status: finalStatus,
          proof_kind: timeline.proof_kind,
          deterministic_test_double: timeline.deterministic_test_double,
          attempt_count: timeline.attempt_count,
          changed_files: timeline.changed_files,
          verifier_command_log: timeline.verifier_command_log,
          final_completion_guard_result: timeline.final_completion_guard_result,
          repair_attempt_timeline_path: join(evidence.runDir, 'repair_attempt_timeline.json'),
          attempt_safety_summary_path: join(evidence.runDir, 'attempt_safety_summary.json'),
          worktree_safety_summary_path: join(evidence.runDir, 'worktree_safety_summary.json'),
          rollback_summary_path: latestRollbackSummary ? join(evidence.runDir, 'rollback_summary.json') : null,
        }, null, 2)}\n`,
      );
    }
  };

  const writeExecutorGateTrace = (): void => {
    try {
      const warningCounts: Record<string, number> = {};
      for (const warning of reportWarnings) {
        const tag = /^\[([^\]]+)\]/.exec(warning)?.[1] ?? 'UNTAGGED_WARNING';
        warningCounts[tag] = (warningCounts[tag] ?? 0) + 1;
      }
      evidence.writeDebugFile(
        '09_executor_gate_trace.json',
        JSON.stringify(
          {
            runtime_hook_events: runtimeHookTraceEvents,
            pre_complete_verifications: preCompleteVerificationTrace,
            repair_attempt_timeline: {
              artifact: '12_repair_attempt_timeline.json',
              attempt_count: repairAttemptTimeline.length,
              proof_enabled: reliabilityRepairProofEnabled,
            },
            repair_state: {
              status: repairState.status,
              max_failures: repairState.maxFailures,
              failure_count: repairState.failures.length,
              last_fingerprint: repairState.lastFingerprint,
              failures: repairState.failures,
            },
            warning_counts: warningCounts,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      reportWarnings.push(
        `[EXECUTOR_GATE_TRACE_WRITE_FAILED] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Seed the cache from any initial tool call log (resumed runs).
  for (const entry of normalizedInitialToolCallLog) {
    if (entry.tool === 'file_read' && entry.exit_code === 0 && entry.stdout) {
      fileReadCache.set(entry.target, entry.stdout);
    }
  }

  const persistExecutorContext = (
    status: 'ready_for_next_turn' | 'after_tool_call' | 'terminal',
    nextTurnPrompt: string,
    details: { terminalStatus?: string; haltTag?: string; condition?: string } = {},
  ): void => {
    try {
      if (status === 'terminal') {
        writeExecutorGateTrace();
      }
      writeExecutorSessionContext({
        evidence,
        status,
        baseContext,
        executionHistory,
        nextTurnPrompt,
        fileReadCache,
        toolCallLog,
        ...(details.terminalStatus ? { terminalStatus: details.terminalStatus } : {}),
        ...(details.haltTag ? { haltTag: details.haltTag } : {}),
        ...(details.condition ? { condition: details.condition } : {}),
      });
    } catch (err) {
      reportWarnings.push(
        `[SESSION_CONTEXT_WRITE_FAILED] ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const haltForMissingPlannedFileWrites = (
    nextTurnPrompt: string,
    missingTargets: string[],
  ): ExecutorLoopResult => {
    const condition = buildMissingPlannedFileWritesCondition(missingTargets);
    const report = buildHaltReport(
      toolCallLog,
      'STEP_VERIFICATION_FAIL',
      Math.max(1, toolCallLog.length),
      condition,
    );
    persistExecutorContext('terminal', nextTurnPrompt, {
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'STEP_VERIFICATION_FAIL',
      condition,
    });
    writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
    log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] after incomplete planned writes');
    logDetail(condition);
    return {
      toolCallLog,
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'STEP_VERIFICATION_FAIL',
      condition,
    };
  };

  const maybeCompleteBoundedWriteTask = (nextTurnPrompt: string): ExecutorLoopResult | null => {
    if (!shouldCompleteBoundedWriteTask({
      approvedPlan,
      rawTask,
      toolCallLog,
      projectRoot: getExecutorProjectRoot(),
    })) {
      return null;
    }

    const completion = {
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    } as const;
    const report = buildTerminalReport(completion, toolCallLog, evidence);
    persistExecutorContext('terminal', nextTurnPrompt, {
      terminalStatus: 'EXECUTION_COMPLETE',
    });
    writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
    log(`  Executor: EXECUTION_COMPLETE (${toolCallLog.length} steps, bounded artifact verified)`);
    return {
      toolCallLog,
      terminalStatus: 'EXECUTION_COMPLETE',
    };
  };

  const maybeCompleteEvidenceRequestPlan = (nextTurnPrompt: string): ExecutorLoopResult | null => {
    if (!isEvidenceRequestPlanSatisfied(approvedPlan, toolCallLog)) {
      return null;
    }

    const completion = {
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    } as const;
    const report = buildTerminalReport(completion, toolCallLog, evidence);
    persistExecutorContext('terminal', nextTurnPrompt, {
      terminalStatus: 'EXECUTION_COMPLETE',
      condition: buildEvidenceRequestCompletionCondition(),
    });
    writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
    log(`  Executor: EXECUTION_COMPLETE (${toolCallLog.length} steps, evidence request satisfied)`);
    return {
      toolCallLog,
      terminalStatus: 'EXECUTION_COMPLETE',
    };
  };

  const completeAfterDeterministicExternalRepair = (
    nextTurnPrompt: string,
    reason: string,
  ): ExecutorLoopResult | null => {
    if (!isExternalBenchmarkTask(rawTask)) {
      return null;
    }

    const deterministicRepair = repairExactOutputSchemaArtifacts(rawTask, getExecutorProjectRoot());
    if (!deterministicRepair) {
      return null;
    }

    const warning = `${deterministicRepair} Trigger: ${reason}`;
    reportWarnings.push(warning);
    const completion = {
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    } as const;
    const report = buildTerminalReport(completion, toolCallLog, evidence);
    persistExecutorContext('terminal', nextTurnPrompt, {
      terminalStatus: 'EXECUTION_COMPLETE',
      condition: warning,
    });
    writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
    log('  Executor: EXECUTION_COMPLETE after deterministic external benchmark repair');
    logDetail(warning);
    return {
      toolCallLog,
      terminalStatus: 'EXECUTION_COMPLETE',
    };
  };

  const directBoundedPlan = reliabilityRepairProofEnabled
    ? null
    : getDirectBoundedWritePlan(
        approvedPlan,
        rawTask,
        getExecutorProjectRoot(),
      );
  if (directBoundedPlan) {
    const warning =
      `[EXECUTOR_DIRECT_BOUNDED_WRITE] Executing without model executor turns: ${directBoundedPlan.reason}.`;
    reportWarnings.push(warning);
    logDetail(warning);

    for (const write of directBoundedPlan.writes) {
      const stepNum = toolCallLog.length + 1;
      const writeReq = {
        tool: 'file_write',
        path: write.target,
        content: write.content,
      } as const;
      const toolResult = await executeExecutorTool(writeReq, evidence);

      const entry = buildExecutorToolCallEntry({
        step: stepNum,
        req: writeReq,
        toolResult,
        target: canonicalizeExecutorTargetForLog(write.target, 'file_write'),
      });
      toolCallLog.push(entry);

      const writeVerificationFailure = toolResult.exit_code === 0
        ? verifySuccessfulTextWriteTarget(write.target, getExecutorProjectRoot(), rawTask)
        : `Direct bounded file_write for "${write.target}" exited with code ${toolResult.exit_code}. ` +
          `stderr: ${toolResult.stderr.slice(0, 200)}`;
      if (writeVerificationFailure) {
        const report = buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          stepNum,
          writeVerificationFailure,
        );
        persistExecutorContext('terminal', baseContext, {
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: writeVerificationFailure,
        });
        writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
        log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${stepNum}`);
        return {
          toolCallLog,
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: writeVerificationFailure,
        };
      }

      executionHistory +=
        (executionHistory ? '\n\n' : '') + formatHistoryEntry(entry);
    }

    const semanticFailure = verifyBoundedTaskArtifacts(
      rawTask,
      toolCallLog,
      getExecutorProjectRoot(),
    );
    if (semanticFailure) {
      const report = buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        semanticFailure,
      );
      persistExecutorContext('terminal', baseContext, {
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'STEP_VERIFICATION_FAIL',
        condition: semanticFailure,
      });
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during direct bounded write verification');
      return {
        toolCallLog,
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'STEP_VERIFICATION_FAIL',
        condition: semanticFailure,
      };
    }

    const completion = {
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    } as const;
    const report = buildTerminalReport(completion, toolCallLog, evidence);
    persistExecutorContext('terminal', baseContext, {
      terminalStatus: 'EXECUTION_COMPLETE',
    });
    writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
    log(`  Executor: EXECUTION_COMPLETE (${toolCallLog.length} steps, direct bounded write)`);
    return {
      toolCallLog,
      terminalStatus: 'EXECUTION_COMPLETE',
    };
  }

  for (let turn = 1; turn <= MAX_EXECUTOR_TURNS; turn++) {
    logDetail(`Executor turn ${turn}/${MAX_EXECUTOR_TURNS}...`);

    // ── Context Compaction ───────────────────────────────────────────────────
    const compactionResult = await autoCompactIfNeeded(executionHistory, turn, evidence);
    if (compactionResult.compacted) {
      executionHistory = compactionResult.newHistory;
    }

    // ── Call runWithFallback with the history-enriched prompt ───────────────
    const turnPrompt = buildExecutorTurnPrompt(
      baseContext, executionHistory, toolCallLog.length, fileReadCache,
    );
    persistExecutorContext('ready_for_next_turn', turnPrompt);

    let executorTurn: z.infer<typeof ExecutorTurnSchema>;
    try {
      executorTurn = await runWithFallback(turnPrompt, ExecutorTurnSchema, {
        evidence,
        stage: 'executor',
        schemaName: 'ExecutorTurnSchema',
      });
    } catch (err) {
      const deterministicWrite = getNextDeterministicSimpleWrite(
        approvedPlan,
        rawTask,
        toolCallLog,
      );
      const projectRoot = getExecutorProjectRoot();
      if (deterministicWrite && projectRoot) {
        const stepNum = toolCallLog.length + 1;
        const warning =
          `[EXECUTOR_DETERMINISTIC_SIMPLE_WRITE] Recovered after executor model failure: ` +
          `${deterministicWrite.reason}; target=${deterministicWrite.target}.`;
        reportWarnings.push(warning);
        logDetail(warning);

        const deterministicReq = {
          tool: 'file_write',
          path: deterministicWrite.target,
          content: deterministicWrite.content,
        } as const;
        const toolResult = await executeExecutorTool(deterministicReq, evidence);

        const entry = buildExecutorToolCallEntry({
          step: stepNum,
          req: deterministicReq,
          toolResult,
          target: canonicalizeExecutorTargetForLog(deterministicWrite.target, 'file_write'),
        });
        toolCallLog.push(entry);

        if (!DRY_RUN && toolResult.exit_code !== 0) {
          const report = buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            stepNum,
            `Deterministic fallback file_write for "${deterministicWrite.target}" exited with code ${toolResult.exit_code}. ` +
            `stderr: ${toolResult.stderr.slice(0, 200)}`,
          );
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition:
              `Deterministic fallback file_write for "${deterministicWrite.target}" exited with code ${toolResult.exit_code}. ` +
              `stderr: ${toolResult.stderr.slice(0, 200)}`,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${stepNum}`);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition:
              `Deterministic fallback file_write for "${deterministicWrite.target}" exited with code ${toolResult.exit_code}. ` +
              `stderr: ${toolResult.stderr.slice(0, 200)}`,
          };
        }

        if (!DRY_RUN) {
          const writeVerificationFailure = verifySuccessfulTextWriteTarget(
            deterministicWrite.target,
            projectRoot,
            rawTask,
          );
          if (writeVerificationFailure) {
            const report = buildHaltReport(
              toolCallLog,
              'STEP_VERIFICATION_FAIL',
              stepNum,
              writeVerificationFailure,
            );
            persistExecutorContext('terminal', turnPrompt, {
              terminalStatus: 'EXECUTION_HALTED',
              haltTag: 'STEP_VERIFICATION_FAIL',
              condition: writeVerificationFailure,
            });
            writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
            log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${stepNum}`);
            return {
              toolCallLog,
              terminalStatus: 'EXECUTION_HALTED',
              haltTag: 'STEP_VERIFICATION_FAIL',
              condition: writeVerificationFailure,
            };
          }
        }

        executionHistory +=
          (executionHistory ? '\n\n' : '') + formatHistoryEntry(entry);
        const nextTurnAfterFallback = buildExecutorTurnPrompt(
          baseContext,
          executionHistory,
          toolCallLog.length,
          fileReadCache,
        );
        persistExecutorContext('after_tool_call', nextTurnAfterFallback);

        const deterministicCompletion = maybeCompleteBoundedWriteTask(nextTurnAfterFallback);
        if (deterministicCompletion) {
          return deterministicCompletion;
        }
        continue;
      }

      // All tiers exhausted — try deterministic benchmark repair before halting.
      const exhaustedReason =
        `All runner tiers failed to produce a valid executor turn. ` +
        `Last error: ${err instanceof Error ? err.message : String(err)}`;
      const deterministicRepairCompletion = completeAfterDeterministicExternalRepair(
        turnPrompt,
        exhaustedReason,
      );
      if (deterministicRepairCompletion) {
        return deterministicRepairCompletion;
      }

      const exhaustedHaltTag = classifyRunnerExhaustionHaltTag(exhaustedReason);
      const report = buildHaltReport(
        toolCallLog, exhaustedHaltTag, toolCallLog.length + 1,
        exhaustedReason,
      );
      persistExecutorContext('terminal', turnPrompt, {
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: exhaustedHaltTag,
        condition: exhaustedReason,
      });
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      const exhaustedRollbackSummary = latestRollbackSummary as WorktreeRollbackSummary | null;
      const exhaustedRollbackStatus = exhaustedRollbackSummary?.status ?? null;
      const exhaustedFinalStatus =
        exhaustedRollbackStatus === 'rollback_failed'
          ? 'ROLLBACK_FAILED'
          : exhaustedRollbackStatus === 'rollback_skipped_user_dirty_target'
            ? 'WORKTREE_DIRTY_UNSAFE'
            : exhaustedRollbackStatus === 'rollback_applied'
              ? 'ROLLBACK_APPLIED'
              : 'EXECUTOR_HALTED';
      writeRepairAttemptTimeline(exhaustedFinalStatus);
      log(`  Executor: EXECUTION_HALTED [${exhaustedHaltTag}]`);
      return {
        toolCallLog,
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: exhaustedHaltTag,
        condition: exhaustedReason,
      };
    }

    // ── Terminal completion ──────────────────────────────────────────────────
    if (executorTurn.type === 'completion') {
      if (executorTurn.status === 'EXECUTION_COMPLETE') {
        const missingPlannedFileWrites = getMissingSuccessfulPlannedFileWrites({
          approvedPlan,
          toolCallLog,
          projectRoot: getExecutorProjectRoot(),
        });
        if (missingPlannedFileWrites.length > 0) {
          return haltForMissingPlannedFileWrites(turnPrompt, missingPlannedFileWrites);
        }

        const preCompleteGuards = evaluatePreCompleteGuards({
          rawTask,
          toolCallLog,
          projectRoot: getExecutorProjectRoot(),
          exactOutputSchemaFailure: verifyExactOutputSchemaArtifacts(rawTask, getExecutorProjectRoot()),
          exactInvariantFailure: evaluateExactInstructionInvariants(
            requestedTargetContract.exactInvariants,
            getExecutorProjectRoot(),
            toolCallLog,
          ),
        });
        runtimeHookTraceEvents.push(...preCompleteGuards.runtimeHookTraceEvents);
        if (preCompleteGuards.benchmarkVerification) {
          preCompleteVerificationTrace.push(preCompleteGuards.benchmarkVerification);
          emitRuntimeEvent('verification.decision', {
            hook_id: 'benchmark_verification.before_complete',
            contract_id: preCompleteGuards.benchmarkVerification.contractId,
            passed: preCompleteGuards.benchmarkVerification.passed,
            message: preCompleteGuards.benchmarkVerification.message,
          });
        }

        const semanticFailure = preCompleteGuards.semanticFailure;
        finalCompletionGuardResult = {
          status: semanticFailure ? 'fail' : 'pass',
          semantic_failure: semanticFailure,
          runtime_hook_event_count: preCompleteGuards.runtimeHookTraceEvents.length,
          benchmark_verification_status: preCompleteGuards.benchmarkVerification
            ? (preCompleteGuards.benchmarkVerification.passed ? 'pass' : 'fail')
            : null,
        };
        if (semanticFailure) {
          if (isExternalBenchmarkTask(rawTask) && externalPostconditionFailures < 2) {
            externalPostconditionFailures += 1;
            const feedback = buildExternalPostconditionFeedback(
              externalPostconditionFailures,
              semanticFailure,
            );
            executionHistory += (executionHistory ? '\n\n' : '') + feedback;
            const nextTurnAfterPostcondition = buildExecutorTurnPrompt(
              baseContext,
              executionHistory,
              toolCallLog.length,
              fileReadCache,
            );
            persistExecutorContext('after_tool_call', nextTurnAfterPostcondition, {
              condition: semanticFailure,
            });
            log('  Executor: postcondition failed — continuing for autonomous repair');
            logDetail(semanticFailure);
            continue;
          }

          const deterministicRepairCompletion = completeAfterDeterministicExternalRepair(
            turnPrompt,
            semanticFailure,
          );
          if (deterministicRepairCompletion) {
            return deterministicRepairCompletion;
          }

          const report = buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            toolCallLog.length,
            semanticFailure,
          );
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition: semanticFailure,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          writeRepairAttemptTimeline('EXECUTOR_HALTED');
          log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] after post-write semantic verification');
          logDetail(semanticFailure);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition: semanticFailure,
          };
        }

        const runtimeVerification = runRuntimeVerification({
          rawTask,
          toolCallLog,
          projectRoot: getExecutorProjectRoot(),
          babelRoot: BABEL_ROOT,
        });
        evidence.writeDebugFile(
          '10_runtime_verification.json',
          `${JSON.stringify(runtimeVerification, null, 2)}\n`,
        );

        const runnableArtifactGate = evaluateRunnableArtifactGate({
          rawTask,
          toolCallLog,
          projectRoot: getExecutorProjectRoot(),
          runtimeVerification,
        });
        evidence.writeDebugFile(
          '11_runnable_artifact_gate.json',
          `${JSON.stringify(runnableArtifactGate, null, 2)}\n`,
        );
        if (runnableArtifactGateBlocksCompletion(runnableArtifactGate)) {
          const repairLoop = runGodotArtifactRepairLoop({
            rawTask,
            toolCallLog,
            projectRoot: getExecutorProjectRoot(),
            initialGate: runnableArtifactGate,
            babelRoot: BABEL_ROOT,
            maxRepairAttempts: 2,
          });
          repairLoop.attempts.forEach((attemptEvidence, index) => {
            evidence.writeDebugFile(
              `${12 + index}_artifact_repair_attempt_${index + 1}.json`,
              `${JSON.stringify(attemptEvidence, null, 2)}\n`,
            );
          });
          if (repairLoop.status === 'REPAIRED_AND_COMPLETE') {
            const completion = {
              type: 'completion',
              status: 'EXECUTION_COMPLETE',
            } as const;
            const report = {
              ...buildTerminalReport(completion, toolCallLog, evidence),
              stage_status: 'REPAIRED_AND_COMPLETE',
              pipeline_completion_note: 'Godot artifact repair completed only after fresh Babel-owned runtime verification and Runnable Artifact Gate PASS.',
              artifact_gate: repairLoop.finalGate,
            };
            persistExecutorContext('terminal', turnPrompt, {
              terminalStatus: 'EXECUTION_COMPLETE',
              condition: repairLoop.reason,
            });
            writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
            writeRepairAttemptTimeline('COMPLETE');
            log(`  Executor: REPAIRED_AND_COMPLETE (${toolCallLog.length} steps, Godot artifact repaired)`);
            logDetail(repairLoop.reason);
            return {
              toolCallLog,
              terminalStatus: 'EXECUTION_COMPLETE',
            };
          }

          const finalGate = repairLoop.finalGate ?? runnableArtifactGate;
          const haltDecision = repairLoop.status === 'EXECUTION_HALTED_REPAIR_BUDGET_EXCEEDED'
            ? {
                haltTag: 'REPAIR_BUDGET_EXCEEDED' as const,
                condition: [
                  'EXECUTION_HALTED_REPAIR_BUDGET_EXCEEDED',
                  `Runnable Artifact Gate status: ${finalGate.status}`,
                  `Target type: ${finalGate.target_type}`,
                  `Repair attempts: ${repairLoop.attempts.length}/2`,
                  `Reason: ${repairLoop.reason}`,
                  `Verification command: ${finalGate.verification_command ?? 'NO_RUNTIME_VERIFICATION'}`,
                  'Failed artifact checks:',
                  ...(finalGate.failed_artifact_checks.length > 0
                    ? finalGate.failed_artifact_checks.map(check => `- ${check.id}: ${check.message}`)
                    : ['- None']),
                  `Next repair action: ${finalGate.next_repair_action ?? 'Manual repair required before completion.'}`,
                ].join('\n'),
              }
            : runnableArtifactGateHaltDecision(finalGate);
          const report = {
            ...buildHaltReport(
              toolCallLog,
              haltDecision.haltTag,
              Math.max(1, toolCallLog.length),
              haltDecision.condition,
            ),
            artifact_gate: finalGate,
          };
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: haltDecision.haltTag,
            condition: haltDecision.condition,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          writeRepairAttemptTimeline('EXECUTOR_HALTED');
          log(`  Executor: EXECUTION_HALTED [${haltDecision.haltTag}] after runnable artifact gate`);
          logDetail(haltDecision.condition);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: haltDecision.haltTag,
            condition: haltDecision.condition,
          };
        }
      }

      if (executorTurn.status === 'EXECUTION_HALTED') {
        const deterministicRepairCompletion = completeAfterDeterministicExternalRepair(
          turnPrompt,
          executorTurn.condition,
        );
        if (deterministicRepairCompletion) {
          return deterministicRepairCompletion;
        }
      }

      const report = buildTerminalReport(executorTurn, toolCallLog, evidence);
      persistExecutorContext('terminal', turnPrompt, {
        terminalStatus: executorTurn.status,
        ...(executorTurn.status === 'EXECUTION_HALTED'
          ? { haltTag: executorTurn.halt_tag, condition: executorTurn.condition }
          : {}),
        ...(executorTurn.status === 'ACTIVATION_REFUSED'
          ? { haltTag: 'ACTIVATION_GATE_FAIL', condition: executorTurn.reason }
          : {}),
      });
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      writeRepairAttemptTimeline(executorTurn.status === 'EXECUTION_COMPLETE' ? 'COMPLETE' : 'EXECUTOR_HALTED');

      if (executorTurn.status === 'EXECUTION_COMPLETE') {
        log(`  Executor: EXECUTION_COMPLETE (${toolCallLog.length} steps)`);
      } else if (executorTurn.status === 'EXECUTION_HALTED') {
        log(`  Executor: EXECUTION_HALTED [${executorTurn.halt_tag}]`);
        logDetail(executorTurn.condition);
      } else {
        log(`  Executor: ACTIVATION_REFUSED — ${executorTurn.reason}`);
      }
      if (executorTurn.status === 'EXECUTION_COMPLETE') {
        return {
          toolCallLog,
          terminalStatus: 'EXECUTION_COMPLETE',
        };
      }
      if (executorTurn.status === 'EXECUTION_HALTED') {
        return {
          toolCallLog,
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: executorTurn.halt_tag,
          condition: executorTurn.condition,
        };
      }
      return {
        toolCallLog,
        terminalStatus: 'ACTIVATION_REFUSED',
        condition: executorTurn.reason,
      };
    }

    // ── Tool call ────────────────────────────────────────────────────────────
    // Re-validate with strict ToolCallRequestSchema (enforces per-tool required fields).
    const { type: _type, ...toolArgs } = executorTurn;
    let parsedReq = ToolCallRequestSchema.safeParse(toolArgs);

    if (!parsedReq.success) {
      // ── Repair mode: one retry with a targeted fix prompt ────────────────
      log('  Executor: tool call failed strict validation — attempting schema repair');
      const repairPrompt = buildExecutorRepairPrompt(
        turnPrompt,
        toolArgs,
        parsedReq.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
      );
      try {
        const repairedTurn = await runWithFallback(repairPrompt, ExecutorTurnSchema, {
          evidence, stage: 'executor', schemaName: 'ExecutorTurnSchema',
        });
        if (repairedTurn.type === 'tool_call') {
          const { type: _rt, ...repairedArgs } = repairedTurn;
          const repairedParse = ToolCallRequestSchema.safeParse(repairedArgs);
          if (repairedParse.success) {
            log('  Executor: schema repair succeeded — continuing execution');
            parsedReq = repairedParse;
          }
        }
      } catch {
        // repair attempt exhausted all tiers — fall through to AMBIGUOUS_PLAN halt
      }
    }

    if (!parsedReq.success) {
      const report = buildHaltReport(
        toolCallLog, 'AMBIGUOUS_PLAN', toolCallLog.length + 1,
        `Executor tool call failed strict validation (repair attempted and failed). ` +
        `Zod error: ${parsedReq.error.toString().slice(0, 200)}`,
      );
      persistExecutorContext('terminal', turnPrompt, {
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'AMBIGUOUS_PLAN',
        condition:
          `Executor tool call failed strict validation (repair attempted and failed). ` +
          `Zod error: ${parsedReq.error.toString().slice(0, 200)}`,
      });
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      log('  Executor: EXECUTION_HALTED [AMBIGUOUS_PLAN]');
      return {
        toolCallLog,
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'AMBIGUOUS_PLAN',
        condition:
          `Executor tool call failed strict validation (repair attempted and failed). ` +
          `Zod error: ${parsedReq.error.toString().slice(0, 200)}`,
      };
    }

    let req       = parsedReq.data;
    const stepNum = toolCallLog.length + 1;

    const approvedStep = approvedPlan.minimal_action_set[stepNum - 1];
    if (
      approvedStep?.tool === req.tool &&
      isExecutorToolShapePlaceholder(getTarget(req)) &&
      String(approvedStep.target ?? '').trim().length > 0
    ) {
      const warning =
        `[EXECUTOR_PLAN_TARGET_CANONICALIZED] Step ${stepNum} ${req.tool} target replaced ` +
        `tool-shape placeholder "${getTarget(req)}" with approved plan target "${approvedStep.target}".`;
      reportWarnings.push(warning);
      logDetail(warning);
      req = replaceExecutorRequestTarget(req, String(approvedStep.target));
    }

    if (
      req.tool === 'file_write' &&
      approvedStep?.tool === 'file_write' &&
      normalizeRequestedFileTargetsForBoundedContract(rawTask).includes(normalizePathForComparison(approvedStep.target))
    ) {
      const emittedTarget = normalizePathForComparison(String(req.path ?? ''));
      const approvedTarget = normalizePathForComparison(approvedStep.target);
      if (emittedTarget !== approvedTarget) {
        const warning =
          `[EXECUTOR_PLAN_TARGET_CANONICALIZED] Step ${stepNum} file_write target normalized ` +
          `from "${String(req.path ?? '')}" to approved bounded target "${approvedStep.target}".`;
        reportWarnings.push(warning);
        logDetail(warning);
        req = { ...req, path: approvedStep.target };
      }
    }

    if (
      isExternalBenchmarkTask(rawTask) &&
      externalPostconditionFailures > 0 &&
      req.tool === 'file_write'
    ) {
      const previousEntry = toolCallLog[toolCallLog.length - 1];
      const currentTarget = canonicalizeExecutorTargetForLog(String(req.path ?? ''), 'file_write');
      const previousTarget = previousEntry
        ? canonicalizeExecutorTargetForLog(String(previousEntry.target ?? ''), previousEntry.tool)
        : '';
      const lastShellCommand = [...toolCallLog]
        .reverse()
        .find(entry => entry.tool === 'shell_exec' || entry.tool === 'test_run');
      if (
        previousEntry?.tool === 'file_write' &&
        normalizePathForComparison(previousTarget).toLowerCase() === normalizePathForComparison(currentTarget).toLowerCase() &&
        lastShellCommand
      ) {
        externalRepairRerunCount += 1;
        if (shouldHaltExternalRepairRerun(rawTask, externalRepairRerunCount)) {
          const limit = getExternalRepairRerunLimit(rawTask);
          const condition =
            `[EXECUTOR_EXTERNAL_REPAIR_LOOP] Repeated postcondition repair reruns exceeded ` +
            `${limit} attempt(s) for "${currentTarget}". Last verifier command was ` +
            `"${lastShellCommand.target}". Stop the canary and inspect the failing strategy instead ` +
            `of spending the full benchmark timeout.`;
          const warning = `[EXECUTOR_EXTERNAL_REPAIR_LOOP_HALTED] ${condition}`;
          reportWarnings.push(warning);
          logDetail(warning);
          const report = buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            stepNum,
            condition,
          );
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          log(`  Executor: EXECUTION_HALTED [EXECUTOR_EXTERNAL_REPAIR_LOOP] at step ${stepNum}`);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition,
          };
        }

        const warning =
          `[EXECUTOR_EXTERNAL_REPAIR_RERUN] Repeated helper write for "${currentTarget}" after ` +
          `postcondition failure; rerunning "${lastShellCommand.target}" instead ` +
          `(attempt ${externalRepairRerunCount}/${getExternalRepairRerunLimit(rawTask)}).`;
        reportWarnings.push(warning);
        logDetail(warning);
        req = {
          tool: 'shell_exec',
          command: lastShellCommand.target,
          working_directory: '.',
          timeout_seconds: 120,
        };
      }
    }

    const recoverableNextTargetKey = req.tool === 'file_write'
      ? normalizePathForComparison(canonicalizeExecutorTargetForLog(String(req.path ?? ''), 'file_write')).toLowerCase()
      : null;
    const recoverableRerunDecision = shouldForceRecoverableCommandRerun(
      pendingRecoverableCommandRetryState.value,
      req,
      recoverableNextTargetKey,
    );
    const pendingRecoverableCommandRetry = pendingRecoverableCommandRetryState.value;
    if (recoverableRerunDecision.force && pendingRecoverableCommandRetry) {
      const warning =
        `[EXECUTOR_RECOVERABLE_COMMAND_RERUN] Step ${stepNum} redirected to failed verifier command: ` +
        `${recoverableRerunDecision.reason}`;
      reportWarnings.push(warning);
      logDetail(warning);
      emitRuntimeEvent('policy.decision', {
        hook_id: 'recoverable_command.rerun',
        decision: 'rewrite',
        original_tool: req.tool,
        original_target: getTarget(req),
        replacement_tool: pendingRecoverableCommandRetry.tool,
        replacement_command: pendingRecoverableCommandRetry.command,
        reason: recoverableRerunDecision.reason,
      });
      req = pendingRecoverableCommandRetry.tool === 'test_run'
        ? {
            tool: 'test_run',
            command: pendingRecoverableCommandRetry.command,
            working_directory: pendingRecoverableCommandRetry.workingDirectory,
            timeout_seconds: pendingRecoverableCommandRetry.timeoutSeconds ?? 300,
          }
        : {
            tool: 'shell_exec',
            command: pendingRecoverableCommandRetry.command,
            working_directory: pendingRecoverableCommandRetry.workingDirectory,
            timeout_seconds: pendingRecoverableCommandRetry.timeoutSeconds ?? 120,
          };
    }

    if (
      (req.tool === 'shell_exec' || req.tool === 'test_run') &&
      isExecutorCommandPlaceholder(req.command)
    ) {
      const inferredVerifierCommand = inferVerifierCommandFromTask(rawTask);
      if (inferredVerifierCommand) {
        const warning =
          `[EXECUTOR_PLACEHOLDER_COMMAND_REWRITE] Replaced placeholder verifier command ` +
          `"${req.command}" with "${inferredVerifierCommand}" inferred from the task.`;
        reportWarnings.push(warning);
        logDetail(warning);
        req = {
          ...req,
          command: inferredVerifierCommand,
        };
      }
    }

    if (req.tool === 'shell_exec' || req.tool === 'test_run') {
      const executionProfileName = resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']).name;
      const preToolHookResult = runPreToolUseHooks({
        request: req,
        rawTask,
        executionProfileName,
        runtimeInventory: getBenchmarkRuntimeInventoryForProfile(executionProfileName),
      });
      runtimeHookTraceEvents.push(...preToolHookResult.traces);

      if (
        !preToolHookResult.blocked &&
        (preToolHookResult.request.tool === 'shell_exec' || preToolHookResult.request.tool === 'test_run') &&
        normalizeShellCommandForComparison(preToolHookResult.request.command) !==
          normalizeShellCommandForComparison(req.command)
      ) {
        const warning =
          `[TOOL_CAPABILITY_REWRITE] Step ${stepNum} ${req.tool} rewrote generic command ` +
          `"${req.command}" to "${preToolHookResult.request.command}".`;
        reportWarnings.push(warning);
        logDetail(warning);
        emitRuntimeEvent('policy.decision', {
          hook_id: 'tool_capability.pre_tool_use',
          decision: 'rewrite',
          tool: req.tool,
          original_command: req.command,
          replacement_command: preToolHookResult.request.command,
        });
        req = preToolHookResult.request;
      } else if (preToolHookResult.blocked) {
        blockedToolCapabilityRecoveryCount += 1;
        const capabilityFeedback = preToolHookResult.message ?? '[TOOL_CAPABILITY_BROKER] Tool capability blocked.';
        const entry = buildBlockedExecutorToolCallEntry({
          step: stepNum,
          req,
          stderr: capabilityFeedback,
        });
        toolCallLog.push(entry);

        const warning =
          `[TOOL_CAPABILITY_BLOCKED] Step ${stepNum} ${req.tool} blocked before execution; ` +
          `attempt ${blockedToolCapabilityRecoveryCount}/${maxBlockedToolCapabilityRecoveries}.`;
        reportWarnings.push(warning);
        logDetail(warning);
        emitRuntimeEvent('policy.decision', {
          hook_id: 'tool_capability.pre_tool_use',
          decision: 'block',
          tool: req.tool,
          command: req.command,
          message: capabilityFeedback,
        });

        executionHistory +=
          (executionHistory ? '\n\n' : '') +
          formatHistoryEntry(entry) +
          '\n\n--- TOOL CAPABILITY UNAVAILABLE ---\n' +
          'Do not retry a generic inspection command. Use the task-specific capability replacement if available, ' +
          'choose a source-only route, or halt with STEP_VERIFICATION_FAIL if the required runtime capability is missing.';

        if (blockedToolCapabilityRecoveryCount > maxBlockedToolCapabilityRecoveries) {
          const report = buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            stepNum,
            capabilityFeedback,
          );
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition: capabilityFeedback,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          log(`  Executor: EXECUTION_HALTED [TOOL_CAPABILITY_BLOCKED] at step ${stepNum}`);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition: capabilityFeedback,
          };
        }

        persistExecutorContext(
          'after_tool_call',
          buildExecutorTurnPrompt(baseContext, executionHistory, toolCallLog.length, fileReadCache),
        );
        continue;
      }
    }

    logDetail(`  Step ${stepNum}: ${req.tool} → ${canonicalizeExecutorTargetForLog(getTarget(req), req.tool)}`);

    // ── Truncation artifact guard ─────────────────────────────────────────────
    // If the executor is about to write a file whose content contains the
    // truncation marker from formatHistoryEntry, it has copied from the
    // execution history instead of the FILE_READ_CACHE. Halt before writing
    // corrupted content to disk.
    if (req.tool === 'file_write' && 'content' in req) {
      const TRUNCATION_MARKER = /\.\.\. \[\d+ chars truncated\] \.\.\./;
      if (TRUNCATION_MARKER.test(req.content)) {
        const truncationConditions = buildTruncationArtifactConditions(String(req.path ?? ''));
        const report = buildHaltReport(
          toolCallLog, 'STEP_VERIFICATION_FAIL', stepNum,
          truncationConditions.reportCondition,
        );
        persistExecutorContext('terminal', turnPrompt, {
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: truncationConditions.resultCondition,
        });
        writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
        log(`  Executor: EXECUTION_HALTED [TRUNCATION_ARTIFACT] at step ${stepNum}`);
        return {
          toolCallLog,
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: truncationConditions.resultCondition,
        };
      }
    }

    const benchmarkInstallBlockReason =
      isExternalBenchmarkTask(rawTask) &&
      (req.tool === 'shell_exec' || req.tool === 'test_run')
        ? getBenchmarkInstallRecoveryBlockReason(approvedPlan, rawTask, req.command)
        : null;
    if (benchmarkInstallBlockReason) {
      blockedBenchmarkInstallRecoveryCount += 1;
      const entry = buildBlockedExecutorToolCallEntry({
        step: stepNum,
        req,
        stderr: benchmarkInstallBlockReason,
      });
      toolCallLog.push(entry);

      const warning =
        `[${BENCHMARK_INSTALL_RECOVERY_TAG}] Step ${stepNum} ${req.tool} blocked before execution; ` +
        `attempt ${blockedBenchmarkInstallRecoveryCount}/${maxBenchmarkInstallRecoveryBlocks}.`;
      reportWarnings.push(warning);
      logDetail(warning);

      executionHistory +=
        (executionHistory ? '\n\n' : '') +
        formatHistoryEntry(entry) +
        '\n\n--- BENCHMARK INSTALL RECOVERY BLOCKED ---\n' +
        'Do not retry package installation with alternate syntax. Use existing container tools, ' +
        'patch/write self-contained source artifacts, or halt with STEP_VERIFICATION_FAIL if the task ' +
        'cannot be solved without the missing dependency.';

      if (blockedBenchmarkInstallRecoveryCount > maxBenchmarkInstallRecoveryBlocks) {
        const report = buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          stepNum,
          benchmarkInstallBlockReason,
        );
        persistExecutorContext('terminal', turnPrompt, {
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: benchmarkInstallBlockReason,
        });
        writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
        log(`  Executor: EXECUTION_HALTED [${BENCHMARK_INSTALL_RECOVERY_TAG}] at step ${stepNum}`);
        return {
          toolCallLog,
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: benchmarkInstallBlockReason,
        };
      }

      persistExecutorContext(
        'after_tool_call',
        buildExecutorTurnPrompt(baseContext, executionHistory, toolCallLog.length, fileReadCache),
      );
      continue;
    }

    if (!DRY_RUN && req.tool === 'file_write') {
      const snapshotResult = worktreeSafety.snapshotBeforeWrite(
        String(req.path ?? ''),
        repairState.failures.length + 1,
      );
      writeWorktreeSafetySummary();
      if (!snapshotResult.ok) {
        const condition = `[WORKTREE_DIRTY_UNSAFE] ${snapshotResult.reason ?? 'Unsafe worktree write refused.'}`;
        const entry = buildBlockedExecutorToolCallEntry({
          step: stepNum,
          req,
          stderr: condition,
          target: canonicalizeExecutorTargetForLog(String(req.path ?? ''), 'file_write'),
        });
        toolCallLog.push(entry);
        const rollbackSummary = worktreeSafety.rollbackTouchedFiles(condition);
        writeRollbackSummary(rollbackSummary);
        const report = buildHaltReport(
          toolCallLog,
          'SCOPE_VIOLATION',
          stepNum,
          condition,
        );
        persistExecutorContext('terminal', turnPrompt, {
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'SCOPE_VIOLATION',
          condition,
        });
        writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
        log(`  Executor: EXECUTION_HALTED [WORKTREE_DIRTY_UNSAFE] at step ${stepNum}`);
        return {
          toolCallLog,
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'SCOPE_VIOLATION',
          condition,
        };
      }
    }

    const fileWriteProofHashBefore = req.tool === 'file_write'
      ? hashProjectFileForEvidence(getExecutorProjectRoot(), String(req.path ?? ''))
      : null;
    const fastPathToolResult = maybeHandleNewFilePreflightFastPath(req, approvedPlan);
    if (fastPathToolResult) {
      logDetail(`  Executor fast path: ${fastPathToolResult.stdout}`);
    }
    const toolResult = fastPathToolResult ?? await executeExecutorTool(req, evidence);

    const entry = buildExecutorToolCallEntry({
      step: stepNum,
      req,
      toolResult,
    });
    toolCallLog.push(entry);

    if (!DRY_RUN && req.tool === 'file_write' && toolResult.exit_code === 0) {
      const changedTarget = canonicalizeExecutorTargetForLog(String(req.path ?? ''), 'file_write');
      currentRepairAttemptChangedFiles.add(changedTarget);
      currentRepairAttemptFileHashes[changedTarget] = {
        before: fileWriteProofHashBefore,
        after: hashProjectFileForEvidence(getExecutorProjectRoot(), String(req.path ?? '')),
      };
    }

    const activeRecoverableRetryForPatch: PendingRecoverableCommandRetry | null =
      pendingRecoverableCommandRetryState.value;
    if (
      !DRY_RUN &&
      toolResult.exit_code === 0 &&
      activeRecoverableRetryForPatch &&
      req.tool === 'file_write'
    ) {
      const patchedTargetKey = normalizePathForComparison(
        canonicalizeExecutorTargetForLog(String(req.path ?? ''), 'file_write'),
      ).toLowerCase();
      pendingRecoverableCommandRetryState.value = {
        ...activeRecoverableRetryForPatch,
        patchedTargetKeys: new Set([
          ...activeRecoverableRetryForPatch.patchedTargetKeys,
          patchedTargetKey,
        ]),
      };
    }

    const activeRecoverableRetryForSuccess: PendingRecoverableCommandRetry | null =
      pendingRecoverableCommandRetryState.value;
    if (
      !DRY_RUN &&
      toolResult.exit_code === 0 &&
      activeRecoverableRetryForSuccess &&
      (req.tool === 'shell_exec' || req.tool === 'test_run') &&
      isSameRecoverableCommandRetry(req, activeRecoverableRetryForSuccess)
    ) {
      const inputCapsule = currentRepairAttemptInputCapsule ?? latestFailureCapsuleArtifact;
      markInputCapsuleConsumed(inputCapsule);
      repairAttemptTimeline.push({
        attempt: repairState.failures.length + 1,
        kind: reliabilityRepairProofEnabled ? 'deterministic_stub' : 'live_cli',
        status: 'REPAIR_ATTEMPT_PASSED',
        changed_files: [...currentRepairAttemptChangedFiles].sort(),
        verifier_command: req.command,
        verifier_cwd: req.working_directory ?? null,
        verifier_exit_code: toolResult.exit_code,
        verifier_stdout_summary: summarizeVerifierStreamForEvidence(toolResult.stdout),
        verifier_stderr_summary: summarizeVerifierStreamForEvidence(toolResult.stderr),
        failure_capsule_id: null,
        failure_capsule_path: null,
        failure_capsule: null,
        input_capsule_id: inputCapsule?.id ?? null,
        input_capsule_path: inputCapsule?.path ?? null,
        input_capsule_consumed: inputCapsule !== null,
        next_attempt_consumed_capsule: null,
        repeated_failure_signature: null,
        meaningful_diff_since_previous_attempt: hasMeaningfulRepairDiff(
          repairAttemptTimeline.filter(attempt => attempt.status === 'REPAIR_ATTEMPT_FAILED').at(-1) ?? null,
          currentRepairAttemptFileHashes,
        ),
        file_hashes: currentRepairAttemptFileHashes,
      });
      currentRepairAttemptChangedFiles = new Set<string>();
      currentRepairAttemptFileHashes = {};
      currentRepairAttemptInputCapsule = null;
      pendingRecoverableCommandRetryState.value = null;
      writeRepairAttemptTimeline('IN_PROGRESS');
    }

    // Command failures are often recoverable during autonomous work: the
    // executor can inspect stderr, patch a helper script, and retry. Policy
    // denials and integration lifecycle failures still halt immediately.
    if (!DRY_RUN && toolResult.exit_code !== 0) {
      if (
        (req.tool === 'shell_exec' || req.tool === 'test_run') &&
        !toolResult.denial &&
        !toolResult.mcp_lifecycle &&
        shouldRecoverCommandFailure(req.command, rawTask)
      ) {
        recoverableCommandFailures += 1;
        const repairDecision = recordRepairFailure(repairState, entry);
        repairState = repairDecision.state;
        const inputCapsule = currentRepairAttemptInputCapsule;
        markInputCapsuleConsumed(inputCapsule);
        const failureCapsule = buildFailureCapsule({
          attempt: repairState.failures.length,
          verifierStatus: 'fail',
          failedCommand: req.command,
          stdout: toolResult.stdout,
          stderr: toolResult.stderr,
          changedFiles: [...currentRepairAttemptChangedFiles],
        });
        const failureCapsuleId = `repair_failure_capsule_attempt_${failureCapsule.attempt}`;
        const failureCapsuleFilename = `12_${failureCapsuleId}.json`;
        const failureCapsulePath = join(evidence.runDir, failureCapsuleFilename);
        evidence.writeDebugFile(
          failureCapsuleFilename,
          `${JSON.stringify({
            id: failureCapsuleId,
            source: 'executor_recoverable_command_failure',
            source_tool_call: entry,
            capsule: failureCapsule,
          }, null, 2)}\n`,
        );
        latestFailureCapsuleArtifact = {
          id: failureCapsuleId,
          path: failureCapsulePath,
          capsule: failureCapsule,
        };
        const previousFailedAttempt =
          repairAttemptTimeline.filter(attempt => attempt.status === 'REPAIR_ATTEMPT_FAILED').at(-1) ?? null;
        const meaningfulDiffSincePreviousAttempt = hasMeaningfulRepairDiff(
          previousFailedAttempt,
          currentRepairAttemptFileHashes,
        );
        const repeatedFailureSignature = repairDecision.state.status === 'same_failure_repeated' ||
          repairDecision.state.status === 'strategy_exhausted'
          ? formatFailureFingerprint(repairDecision.state.lastFingerprint!)
          : null;
        repairAttemptTimeline.push({
          attempt: failureCapsule.attempt,
          kind: reliabilityRepairProofEnabled ? 'deterministic_stub' : 'live_cli',
          status: 'REPAIR_ATTEMPT_FAILED',
          changed_files: [...currentRepairAttemptChangedFiles].sort(),
          verifier_command: req.command,
          verifier_cwd: req.working_directory ?? null,
          verifier_exit_code: toolResult.exit_code,
          verifier_stdout_summary: summarizeVerifierStreamForEvidence(toolResult.stdout),
          verifier_stderr_summary: summarizeVerifierStreamForEvidence(toolResult.stderr),
          failure_capsule_id: failureCapsuleId,
          failure_capsule_path: failureCapsulePath,
          failure_capsule: failureCapsule,
          input_capsule_id: inputCapsule?.id ?? null,
          input_capsule_path: inputCapsule?.path ?? null,
          input_capsule_consumed: inputCapsule !== null,
          next_attempt_consumed_capsule: false,
          repeated_failure_signature: repeatedFailureSignature,
          meaningful_diff_since_previous_attempt: meaningfulDiffSincePreviousAttempt,
          file_hashes: currentRepairAttemptFileHashes,
        });
        currentRepairAttemptChangedFiles = new Set<string>();
        currentRepairAttemptFileHashes = {};
        currentRepairAttemptInputCapsule = latestFailureCapsuleArtifact;
        writeRepairAttemptTimeline('IN_PROGRESS');
        const wrongWorkingDirectoryHint = getNpmWrongWorkingDirectoryHint(
          req.command,
          toolResult.stdout,
          toolResult.stderr,
          getExecutorProjectRoot(),
        );
        const verifierNotFound =
          isVerifierNotFoundFailure(req.command, toolResult.stdout, toolResult.stderr) &&
          wrongWorkingDirectoryHint === null;
        const repeatedVerifierFailure = repairDecision.state.status === 'same_failure_repeated';
        const repairBudgetExhausted = recoverableCommandFailures >= maxRecoverableCommandFailures;
        const underlyingFailureStatus: TerminalStatus = verifierNotFound
          ? 'VERIFIER_NOT_FOUND'
          : repeatedVerifierFailure
            ? 'REPAIR_REPEATED_FAILURE'
            : repairBudgetExhausted
              ? 'REPAIR_MAX_ATTEMPTS_REACHED'
              : 'VERIFIER_FAILED';
        const rollbackOutcome = rollbackTouchedFilesForFailure(
          underlyingFailureStatus,
          `Verifier command "${req.command}" failed on repair attempt ${failureCapsule.attempt}.`,
        );
        const rollbackFeedback = [
          '--- WORKTREE ROLLBACK ---',
          `Rollback status: ${rollbackOutcome.summary.status}`,
          `Restored files: ${rollbackOutcome.summary.restored_files.join(', ') || '(none)'}`,
          `Removed files: ${rollbackOutcome.summary.removed_files.join(', ') || '(none)'}`,
          `Failed files: ${rollbackOutcome.summary.failed_files.map(file => file.path).join(', ') || '(none)'}`,
        ].join('\n');
        if (rollbackOutcome.terminalStatus === 'ROLLBACK_FAILED') {
          const condition = [
            rollbackOutcome.conditionPrefix,
            `[${underlyingFailureStatus}] Verifier command "${req.command}" failed before rollback completed.`,
            `Failed rollback files: ${rollbackOutcome.summary.failed_files.map(file => `${file.path}: ${file.error}`).join('; ') || '(none)'}.`,
          ].join(' ');
          reportWarnings.push(condition);
          const report = buildHaltReport(
            toolCallLog,
            'REPAIR_BUDGET_EXCEEDED',
            stepNum,
            condition,
          );
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'REPAIR_BUDGET_EXCEEDED',
            condition,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          writeRepairAttemptTimeline('ROLLBACK_FAILED');
          log(`  Executor: EXECUTION_HALTED [ROLLBACK_FAILED] at step ${stepNum}`);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'REPAIR_BUDGET_EXCEEDED',
            condition,
          };
        }
        if (verifierNotFound) {
          const underlyingCondition = [
            `[VERIFIER_NOT_FOUND] Verifier command "${req.command}" is missing or unavailable.`,
            `stdout: ${summarizeVerifierStreamForEvidence(toolResult.stdout) ?? '(empty)'}.`,
            `stderr: ${summarizeVerifierStreamForEvidence(toolResult.stderr) ?? '(empty)'}.`,
            'Recommended next action: define a runnable verifier or choose a task that can be verified with available commands.',
          ].join(' ');
          const finalStatus = rollbackOutcome.terminalStatus;
          const condition = finalStatus === 'VERIFIER_NOT_FOUND'
            ? underlyingCondition
            : `${rollbackOutcome.conditionPrefix} Underlying failure: ${underlyingCondition}`;
          reportWarnings.push(condition);
          const report = buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            stepNum,
            condition,
          );
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          writeRepairAttemptTimeline(finalStatus);
          log(`  Executor: EXECUTION_HALTED [${finalStatus}] at step ${stepNum}`);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'STEP_VERIFICATION_FAIL',
            condition,
          };
        }
        if (repeatedVerifierFailure) {
          const underlyingCondition = [
            '[REPAIR_REPEATED_FAILURE] Same verifier failure repeated after a repair attempt.',
            `Repeated failure signature: ${repeatedFailureSignature ?? '(unknown)'}.`,
            `Meaningful diff since previous attempt: ${meaningfulDiffSincePreviousAttempt === null ? 'unknown' : String(meaningfulDiffSincePreviousAttempt)}.`,
            'Recommended next action: inspect the failure capsule and change repair strategy instead of repeating the same verifier failure.',
          ].join(' ');
          const finalStatus = rollbackOutcome.terminalStatus;
          const condition = finalStatus === 'REPAIR_REPEATED_FAILURE'
            ? underlyingCondition
            : `${rollbackOutcome.conditionPrefix} Underlying failure: ${underlyingCondition}`;
          reportWarnings.push(condition);
          const report = buildHaltReport(
            toolCallLog,
            'REPAIR_BUDGET_EXCEEDED',
            stepNum,
            condition,
          );
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'REPAIR_BUDGET_EXCEEDED',
            condition,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          writeRepairAttemptTimeline(finalStatus);
          log(`  Executor: EXECUTION_HALTED [${finalStatus}] at step ${stepNum}`);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'REPAIR_BUDGET_EXCEEDED',
            condition,
          };
        }
        pendingRecoverableCommandRetryState.value = {
          tool: req.tool,
          command: req.command,
          workingDirectory: req.working_directory,
          timeoutSeconds: req.timeout_seconds,
          failedStep: stepNum,
          patchedTargetKeys: new Set(),
        };
        if (repairBudgetExhausted) {
          const deterministicRepairCompletion = completeAfterDeterministicExternalRepair(
            turnPrompt,
            `recoverable command failure budget exceeded at step ${stepNum}: ${toolResult.stderr.slice(0, 200)}`,
          );
          if (deterministicRepairCompletion) {
            return deterministicRepairCompletion;
          }
          const underlyingCondition = [
            `[REPAIR_MAX_ATTEMPTS_REACHED] Recoverable command failure budget exceeded at step ${stepNum}.`,
            repairDecision.condition ??
              `Last fingerprint: ${formatFailureFingerprint(repairDecision.state.lastFingerprint!)}.`,
          ].join(' ');
          const finalStatus = rollbackOutcome.terminalStatus;
          const condition = finalStatus === 'REPAIR_MAX_ATTEMPTS_REACHED'
            ? underlyingCondition
            : `${rollbackOutcome.conditionPrefix} Underlying failure: ${underlyingCondition}`;
          reportWarnings.push(condition);
          const report = buildHaltReport(
            toolCallLog,
            'REPAIR_BUDGET_EXCEEDED',
            stepNum,
            condition,
          );
          persistExecutorContext('terminal', turnPrompt, {
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'REPAIR_BUDGET_EXCEEDED',
            condition,
          });
          writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
          writeRepairAttemptTimeline(finalStatus);
          log(`  Executor: EXECUTION_HALTED [${finalStatus}] at step ${stepNum}`);
          return {
            toolCallLog,
            terminalStatus: 'EXECUTION_HALTED',
            haltTag: 'REPAIR_BUDGET_EXCEEDED',
            condition,
          };
        }

        const warning =
          `[EXECUTOR_RECOVERABLE_COMMAND_FAILURE] Step ${stepNum} ${req.tool} exited with code ` +
          `${toolResult.exit_code}; repair attempt ${Math.min(recoverableCommandFailures, maxRecoverableCommandFailures)}/${maxRecoverableCommandFailures}. ` +
          `Fingerprint: ${formatFailureFingerprint(repairDecision.state.lastFingerprint ?? repairDecision.state.failures[repairDecision.state.failures.length - 1]!.fingerprint)}.` +
          `${wrongWorkingDirectoryHint ? ` ${wrongWorkingDirectoryHint}` : ''}`;
        reportWarnings.push(warning);
        if (repairDecision.shouldReplan && repairDecision.condition) {
          reportWarnings.push(repairDecision.condition);
          logDetail(repairDecision.condition);
        }
        logDetail(warning);
        executionHistory +=
          (executionHistory ? '\n\n' : '') +
          formatHistoryEntry(entry) +
          '\n\n--- COMMAND FAILURE REPAIR REQUIRED ---\n' +
          'Patch the helper/source artifact that caused this command failure, then retry the same shell_exec/test_run command before advancing. Do not emit EXECUTION_COMPLETE until the command succeeds and requested artifacts pass postcondition checks.' +
          '\n\n--- FAILURE CAPSULE ---\n' +
          `Failure capsule id: ${failureCapsuleId}\n` +
          `Failure capsule path: ${failureCapsulePath}\n` +
          formatFailureCapsuleForPrompt(failureCapsule) +
          `\n\n${rollbackFeedback}` +
          (wrongWorkingDirectoryHint ? `\n${wrongWorkingDirectoryHint}` : '') +
          (repairDecision.shouldReplan && repairDecision.condition
            ? `\n${repairDecision.condition}\nThe same failure appears to be repeating. Change strategy or halt with STEP_VERIFICATION_FAIL instead of applying another equivalent patch.`
            : '');
        persistExecutorContext(
          'after_tool_call',
          buildExecutorTurnPrompt(baseContext, executionHistory, toolCallLog.length, fileReadCache),
        );
        continue;
      }

      const nonRecoverableCondition = buildNonRecoverableToolFailureCondition(req, toolResult);
      const report = buildHaltReport(
        toolCallLog, 'STEP_VERIFICATION_FAIL', stepNum,
        nonRecoverableCondition,
      );
      persistExecutorContext('terminal', turnPrompt, {
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'STEP_VERIFICATION_FAIL',
        condition: nonRecoverableCondition,
      });
      writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
      log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${stepNum}`);
      return {
        toolCallLog,
        terminalStatus: 'EXECUTION_HALTED',
        haltTag: 'STEP_VERIFICATION_FAIL',
        condition: nonRecoverableCondition,
      };
    }

    if (!DRY_RUN && req.tool === 'file_write') {
      const writeVerificationFailure = verifySuccessfulTextWriteTarget(
        String(req.path ?? ''),
        getExecutorProjectRoot(),
        rawTask,
      );
      if (writeVerificationFailure) {
        const repairWrite = getDeterministicSimpleRepairWrite(
          approvedPlan,
          rawTask,
          String(req.path ?? ''),
        );
        if (repairWrite) {
          const repairStepNum = toolCallLog.length + 1;
          const warning =
            `[EXECUTOR_DETERMINISTIC_SIMPLE_REPAIR] Recovered invalid bounded file_write output: ` +
            `${repairWrite.reason}. Original failure: ${writeVerificationFailure}`;
          reportWarnings.push(warning);
          logDetail(warning);

          const repairReq = {
            tool: 'file_write',
            path: repairWrite.target,
            content: repairWrite.content,
          } as const;
          const repairResult = await executeExecutorTool(repairReq, evidence);

          const repairEntry = buildExecutorToolCallEntry({
            step: repairStepNum,
            req: repairReq,
            toolResult: repairResult,
            target: canonicalizeExecutorTargetForLog(repairWrite.target, 'file_write'),
          });
          toolCallLog.push(repairEntry);

          const repairVerificationFailure = repairResult.exit_code === 0
            ? verifySuccessfulTextWriteTarget(repairWrite.target, getExecutorProjectRoot(), rawTask)
            : `Deterministic repair file_write for "${repairWrite.target}" exited with code ${repairResult.exit_code}. ` +
              `stderr: ${repairResult.stderr.slice(0, 200)}`;
          if (repairVerificationFailure) {
            const report = buildHaltReport(
              toolCallLog,
              'STEP_VERIFICATION_FAIL',
              repairStepNum,
              repairVerificationFailure,
            );
            persistExecutorContext('terminal', turnPrompt, {
              terminalStatus: 'EXECUTION_HALTED',
              haltTag: 'STEP_VERIFICATION_FAIL',
              condition: repairVerificationFailure,
            });
            writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
            log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${repairStepNum}`);
            return {
              toolCallLog,
              terminalStatus: 'EXECUTION_HALTED',
              haltTag: 'STEP_VERIFICATION_FAIL',
              condition: repairVerificationFailure,
            };
          }

          executionHistory +=
            (executionHistory ? '\n\n' : '') +
            [formatHistoryEntry(entry), formatHistoryEntry(repairEntry)].join('\n\n');
          const nextTurnAfterRepair = buildExecutorTurnPrompt(
            baseContext,
            executionHistory,
            toolCallLog.length,
            fileReadCache,
          );
          persistExecutorContext('after_tool_call', nextTurnAfterRepair);

          const deterministicCompletion = maybeCompleteBoundedWriteTask(nextTurnAfterRepair);
          if (deterministicCompletion) {
            return deterministicCompletion;
          }
          continue;
        }

        const report = buildHaltReport(
          toolCallLog, 'STEP_VERIFICATION_FAIL', stepNum, writeVerificationFailure,
        );
        persistExecutorContext('terminal', turnPrompt, {
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: writeVerificationFailure,
        });
        writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
        log(`  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] at step ${stepNum}`);
        return {
          toolCallLog,
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition: writeVerificationFailure,
        };
      }
    }

    // Populate the FILE_READ_CACHE so subsequent turns have the full verbatim
    // content available for file_write without relying on the truncated history.
    const fileReadCacheEntry = getSuccessfulFileReadCacheEntry(req, toolResult);
    if (fileReadCacheEntry) {
      fileReadCache.set(fileReadCacheEntry.key, fileReadCacheEntry.stdout);
    }

    // Append result to history so the next turn has full context.
    executionHistory +=
      (executionHistory ? '\n\n' : '') + formatHistoryEntry(entry);
    persistExecutorContext(
      'after_tool_call',
      buildExecutorTurnPrompt(baseContext, executionHistory, toolCallLog.length, fileReadCache),
    );

    const nextTurnAfterTool = buildExecutorTurnPrompt(
      baseContext,
      executionHistory,
      toolCallLog.length,
      fileReadCache,
    );
    const evidenceRequestCompletion = maybeCompleteEvidenceRequestPlan(nextTurnAfterTool);
    if (evidenceRequestCompletion) {
      return evidenceRequestCompletion;
    }

    if (req.tool === 'file_write' && toolResult.exit_code === 0) {
      const deterministicCompletion = maybeCompleteBoundedWriteTask(
        nextTurnAfterTool,
      );
      if (deterministicCompletion) {
        return deterministicCompletion;
      }
    }
  }

  // Exceeded max turns without a terminal signal.
  const deterministicRepair = repairExactOutputSchemaArtifacts(rawTask, getExecutorProjectRoot());
  if (deterministicRepair) {
    reportWarnings.push(deterministicRepair);
    const completion = {
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    } as const;
    const report = buildTerminalReport(completion, toolCallLog, evidence);
    persistExecutorContext(
      'terminal',
      buildExecutorTurnPrompt(baseContext, executionHistory, toolCallLog.length, fileReadCache),
      {
        terminalStatus: 'EXECUTION_COMPLETE',
        condition: deterministicRepair,
      },
    );
    writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
    log('  Executor: EXECUTION_COMPLETE after deterministic exact-output repair');
    logDetail(deterministicRepair);
    return {
      toolCallLog,
      terminalStatus: 'EXECUTION_COMPLETE',
    };
  }

  const maxTurnsCondition = buildMaxTurnsExceededCondition(MAX_EXECUTOR_TURNS);
  const report = buildHaltReport(
    toolCallLog, 'TOOL_CALL_ERROR', toolCallLog.length,
    maxTurnsCondition,
  );
  persistExecutorContext(
    'terminal',
    buildExecutorTurnPrompt(baseContext, executionHistory, toolCallLog.length, fileReadCache),
    {
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'TOOL_CALL_ERROR',
      condition: maxTurnsCondition,
    },
  );
  writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
  log(`  Executor: EXECUTION_HALTED — exceeded ${MAX_EXECUTOR_TURNS} turns`);
  return {
    toolCallLog,
    terminalStatus: 'EXECUTION_HALTED',
    haltTag: 'TOOL_CALL_ERROR',
    condition: maxTurnsCondition,
  };
}
