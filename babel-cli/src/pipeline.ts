/**
 * pipeline.ts — Babel Multi-Agent State Machine
 *
 * Implements the four-stage pipeline:
 *   Stage 1: Orchestrator     — routes task, selects domain + model, emits manifest
 *   Stage 2: SWE Agent        — produces a MINIMAL_ACTION_SET plan
 *   Stage 3: QA Reviewer      — adversarially audits plan (loop up to MAX_LOOPS)
 *   Stage 4: CLI Executor     — multi-turn tool execution loop (deep mode)
 *
 * Execution model:
 *   All four stages use `runWithFallback` (single-turn: CLI → API waterfall).
 *   Stage 4 maintains a stateless text-loop: execution history is accumulated
 *   as a string and appended to the prompt on every iteration so the stateless
 *   runner can see what has already been executed.
 *
 * Path resolution:
 *   All prompt file paths are relative to BABEL_ROOT (two directories above this
 *   file: babel-cli/src/ → babel-cli/ → Babel/).
 *   Override with the BABEL_ROOT environment variable.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  createWriteStream,
  statSync,
  type WriteStream,
  rmSync,
  promises as fsPromises,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { getWorkspaceLockPath, readLock, isLockActive } from './utils/locking.js';
import { runSwarmPipeline } from './runners/swarmRunner.js';
import { runAdversarialQaGate } from './pipeline/qaStage.js';
import { runChatExecutorLoop, formatToolCallForDisplay } from './pipeline/chatExecutorLoop.js';

import { spawnSync } from 'node:child_process';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod';

import { getHighestBudgetSeverity } from './budgetPolicy.js';
import { compileContext, resolveInstructionStackManifest } from './compiler.js';
import {
  getRoutingConfidenceBand,
  getValidatorTierIndex,
  isConfidenceGateEnabled,
} from './confidenceGate.js';
import { runWithFallback, clearRoutingCache } from './execute.js';
import {
  IncrementalToolDetector,
  computeFingerprint,
  JitDenialError,
  PolicyBlockedDuplicateError,
} from './ui/incrementalToolDetector.js';
import { InputCoordinator } from './ui/inputCoordinator.js';
import { getActiveRenderer } from './ui/waterfall.js';
import { resolveMode, type ValidMode } from './cli/constants.js';
import {
  buildExecutionProfilePromptLines,
  DEFAULT_EXECUTION_PROFILE,
  normalizeExecutionProfile,
  resolveExecutionProfile,
  type ExecutionProfileName,
} from './config/executionProfiles.js';
import {
  formatBenchmarkRuntimeInventoryPromptLines,
  getBenchmarkRuntimeCommandUsability,
  getCachedBenchmarkContainerRuntimeInventory,
  inspectBenchmarkContainerRuntime,
  type BenchmarkRuntimeInventory,
} from './config/benchmarkContainer.js';
import {
  buildToolCapabilityPromptLines,
  formatToolCapabilityResolutionForFeedback,
  resolveToolCapabilityForCommand,
} from './config/toolCapabilities.js';
import { resolveFamilyModelPolicy, loadModelPolicyConfig } from './modelPolicy.js';
import { connect } from 'node:net';
import { confirmCost, ConfirmDialog } from './ui/dialog.js';
import { isRunningInDaemon } from './daemon/client.js';
import { assessPlanningComplexity } from './services/plannerRouter.js';
import { EvidenceBundle } from './evidence.js';
import { getAllowedShellCommands, validateExecutorShellCommand } from './sandbox.js';
import { collectHarnessMetadata } from './telemetry/metadata.js';
import { PipelineTrace, endSpan } from './telemetry/tracing.js';
import { runPreToolUseHooks, type RuntimeHookTraceEvent } from './runtime/hooks.js';
import { executeTool, ToolCallRequestSchema, promptUserJit, DRY_RUN } from './localTools.js';
import type { ToolCallRequest, ToolResult, ToolContext } from './localTools.js';
import {
  buildGroundingQaReject,
  buildTaskGrounding,
  classifyTaskContract,
  collectPlanGroundingViolations,
  formatGroundingContext,
  hasPlaceholderProjectPath,
  normalizePlanTargetsAgainstGrounding,
} from './taskCompletion.js';
import {
  OrchestratorManifestSchema,
  OrchestratorErrorHaltSchema,
  SwePlanSchema,
  QaVerdictSchema,
  ExecutorTurnSchema,
  ExecutorReportSchema,
  PipelineErrorSchema,
} from './schemas/agentContracts.js';
import {
  loadTaskEnvelope,
  setActiveTaskEnvelope,
  resetFileWriteCount,
  clearActiveTaskEnvelope,
} from './schemas/taskEnvelope.js';
import { autoCompactIfNeeded } from './services/compaction.js';
import { globalCostTracker } from './services/costTracker.js';
import { buildCostLedger, usageSummaryFromCostLedger } from './services/costLedger.js';
import { extractAndSaveMemories } from './services/memoryExtraction.js';
import { pruneSessionCheckpoints } from './services/sessionCheckpoint.js';
import {
  PRE_EXECUTION_FAILURE_CAPSULE_FILENAME,
  buildPreExecutionFailureArtifacts,
} from './services/pipelineFailureArtifacts.js';
import { runPluginHooks } from './services/plugins.js';
import { analyzeAndPruneContext, isContextPruningEnabled } from './services/pruning.js';
import { buildLiteTaskContract, type LiteTaskContract } from './lite/contract.js';
import { writeExecutorSessionContext } from './services/sessionContext.js';
import {
  buildFailureCapsule,
  formatFailureCapsuleForPrompt,
  maxAttemptsForRepairMode,
  type FailureCapsule,
} from './services/repairGovernance.js';
import {
  buildAttemptSafetySummary,
  buildTerminalStatusSummary,
  isReadOnlyNoModificationRequest,
  isVerifierCommand,
  type AttemptSafetySummary,
  type ProjectSafetySnapshot,
  type RollbackMode,
  type TerminalStatus,
  type TerminalStatusSummary,
} from './services/terminalStatus.js';
import {
  buildVerifierContractArtifacts,
  type VerifierContractSummary,
} from './services/requiredVerifierContract.js';
import {
  createWorktreeSafetyController,
  type WorktreeRollbackSummary,
  type WorktreeRollbackStatus,
  type WorktreeSafetySummary,
} from './services/worktreeSafety.js';
import type {
  AutonomousRepairProofAttemptEvidence,
  AutonomousRepairProofTimeline,
  CompletionGuardEvidence,
  RepairProofFileHash,
} from './services/autonomousRepairProofEvidence.js';
import {
  getAllowedToolsFromEnv,
  getDisallowedToolsFromEnv,
  getNpmWrongWorkingDirectoryHint,
  inferCommandOnlyNoModificationRequest,
  inferVerifierCommandFromTask,
  isExecutorCommandPlaceholder,
  isFileWriteToolAvailable,
  isOptionalVerifierRequest,
  isShellExecutionToolAvailable,
  isVerifierNotFoundFailure,
  shouldRecoverCommandFailure,
  extractMissingNpmScript,
  findDescendantPackageScriptCwd,
} from './pipeline/executorRecovery.js';
import { hasMeaningfulRepairDiff } from './pipeline/repairProof.js';
import {
  BabelEventBus,
  emitRuntimeEvent,
  log,
  logDetail,
  runWithPipelineLogContext,
} from './pipeline/logging.js';
export { BabelEventBus } from './pipeline/logging.js';
import {
  inferProjectRoot,
  normalizeManifestProjectRoot,
  readSessionStartProjectPath,
  resolveConcreteProjectRoot,
} from './pipeline/manifestContext.js';
export {
  inferProjectRoot,
  normalizeManifestProjectRoot,
  readSessionStartProjectPath,
  resolveConcreteProjectRoot,
} from './pipeline/manifestContext.js';
import { isEvidenceRequestPlanSatisfied } from './pipeline/executorEvidenceRequests.js';
export { isEvidenceRequestPlanSatisfied } from './pipeline/executorEvidenceRequests.js';
import {
  benchmarkTaskExplicitlyAllowsDependencyInstall,
  getBenchmarkDependencyInstallPlanReject,
  getBenchmarkInstallRecoveryBlockReason,
  getBenchmarkProtectedWriteReason,
  getExternalBenchmarkDefaultLockedFiles,
  getExternalRepairRerunLimit,
  isBenchmarkDependencyInstallCommand,
  isExternalBenchmarkTask,
  isInvalidGitBundleArchiveCommand,
  normalizeShellCommandForComparison,
  shouldEnforceBoundedPlanActivationContract,
  shouldHaltExternalRepairRerun,
} from './pipeline/benchmarkTasks.js';
export {
  benchmarkTaskExplicitlyAllowsDependencyInstall,
  getBenchmarkDependencyInstallPlanReject,
  getBenchmarkInstallRecoveryBlockReason,
  getBenchmarkProtectedWriteReason,
  getExternalBenchmarkDefaultLockedFiles,
  getExternalRepairRerunLimit,
  isBenchmarkDependencyInstallCommand,
  isInvalidGitBundleArchiveCommand,
  shouldEnforceBoundedPlanActivationContract,
  shouldHaltExternalRepairRerun,
} from './pipeline/benchmarkTasks.js';
import {
  isExecutorToolShapePlaceholder,
  replaceExecutorRequestTarget,
} from './pipeline/executorToolShape.js';
export { isExecutorToolShapePlaceholder } from './pipeline/executorToolShape.js';
import {
  getBenchmarkRuntimeInventoryLines,
  getBenchmarkRuntimeInventoryForProfile,
  resolveShellCommandCapability,
  shouldApplyHostWindowsExecutorNotes,
} from './pipeline/benchmarkRuntime.js';
export { shouldApplyHostWindowsExecutorNotes } from './pipeline/benchmarkRuntime.js';
import {
  collectExecutorSafetyViolations,
  collectRuntimePrerequisiteViolations,
  collectGradleBootstrapSequencingViolations,
  collectAndroidVerificationCoverageViolations,
  collectReferenceSourceShapeViolations,
} from './pipeline/executorSafety.js';
export {
  collectExecutorSafetyViolations,
  collectAndroidVerificationCoverageViolations,
} from './pipeline/executorSafety.js';
import {
  shouldHaltWithoutApprovedPlan,
  shouldRefuseWriteRequestForMode,
  resolveCompletionStatusAfterExactInvariantCheck,
  evaluateExactInstructionInvariants,
  isReadOnlyEvidenceRequestPlan,
  checkWorkspaceLocks,
  extractWindowsAbsolutePaths,
  collectBoundedContractViolations,
  parseLockedFilesEnv,
  mergeLockedFiles,
  verifyExactOutputSchemaArtifacts,
  repairExactOutputSchemaArtifacts,
  assertBoundedPlanActivationContract,
} from './pipeline/contractEnforcement.js';
export {
  shouldHaltWithoutApprovedPlan,
  shouldRefuseWriteRequestForMode,
  resolveCompletionStatusAfterExactInvariantCheck,
  evaluateExactInstructionInvariants,
  isReadOnlyEvidenceRequestPlan,
  checkWorkspaceLocks,
  extractWindowsAbsolutePaths,
  collectBoundedContractViolations,
  parseLockedFilesEnv,
  mergeLockedFiles,
  verifyExactOutputSchemaArtifacts,
  repairExactOutputSchemaArtifacts,
  assertBoundedPlanActivationContract,
} from './pipeline/contractEnforcement.js';
import {
  planStepString,
  buildCounterAgentCritiqueArtifact,
  buildAcceptedRevisedPlanArtifact,
  type CriticVerdict,
  type CriticSeverity,
  type CounterAgentCritiqueArtifact,
} from './pipeline/grounding.js';
export {
  planStepString,
  buildCounterAgentCritiqueArtifact,
  buildAcceptedRevisedPlanArtifact,
  type CriticVerdict,
  type CriticSeverity,
  type CounterAgentCritiqueArtifact,
} from './pipeline/grounding.js';
import {
  collectPlanHandoffViolations,
  buildPlanHandoffQaReject,
  loadPlanHandoff,
} from './agent/planHandoff.js';
import { splitChainedShellSteps } from './pipeline/executorPlanNormalize.js';
import {
  hasImplementationVerificationStrategy,
  injectVerificationStepsIntoPlan,
  plannedVerificationCommandsFromPlan,
} from './pipeline/planVerifierInjection.js';
import { buildOrchestratorTask } from './pipeline/orchestratorTask.js';
import { writeLatestRunPointers } from './pipeline/runPointers.js';
import { buildSweTask } from './pipeline/sweTask.js';
import { buildQaTask } from './pipeline/qaTask.js';
import { buildPipelineFinalTerminalState } from './pipeline/finalization.js';
import { validatePlanTargetsWithinEffectiveRoots } from './pipeline/targetConsistency.js';
import { runPreExecutorSafetyGates } from './pipeline/preExecutorGates.js';
import {
  assertManifest,
  normalizeSwePlan,
  formatZodErrors,
  readManifestFromEvidence,
  readLatestSwePlanFromEvidence,
  hasUsefulEvidence,
  buildEvidenceReportFinalizerArtifact,
  buildBlockedRunSummaryArtifact,
  buildManualPlanRepairPrompt,
  OrchestratorOutputSchema,
  type ParsedOrchestratorOutput,
} from './pipeline/sweUtils.js';
import { inferIntentContract, type BabelIntentContract } from './services/liteFullRouter.js';
import { renderInteractiveChecklist } from './ui/checklist.js';
import { globalIndexer } from './services/indexer.js';
import { backgroundTaskRegistry } from './services/backgroundTaskRegistry.js';
import {
  buildDeterministicRootBuildGradleKtsContent,
  buildLocalPropertiesSdkLine,
  detectAndroidSdkStatus,
  detectCommandOnPath,
  detectGradleBinaryFromExtractedRoot,
  detectGradleInstallCandidate,
  detectJavaRuntimeStatus,
  ensureAndroidSdkEnvironment,
  isGradleProvisioningStep,
  isJavaProvisioningStep,
  parseGradleDistributionUrl,
  prependProcessPath,
  repairSettingsGradleKtsContent,
  shouldUseDeterministicAndroidSdkBootstrapLane,
  shouldUseDeterministicGradleBootstrapLane,
  usesGradleLikeCommand,
  type AndroidSdkStatus,
  type CommandRuntimeStatus,
  type JavaRuntimeStatus,
} from './stages/runtimePreflight.js';
import {
  runDeterministicAndroidSdkBootstrapLane,
  runDeterministicGradleBootstrapLane,
} from './pipeline/bootstrapLanes.js';
import {
  assertExecutorGate,
  buildExecutorRepairPrompt,
  buildExecutorTask,
  buildExecutorTurnPromptLegacy,
  buildHaltReport,
  buildTerminalReport,
  canonicalizeExecutorTargetForLog,
  classifyRunnerExhaustionHaltTag,
  formatExecutionResults,
  formatHistoryEntry,
  getExecutorProjectRoot,
  getTarget,
  isSameRecoverableCommandRetry,
  isWithinProjectRootPath,
  shouldForceRecoverableCommandRerun,
  resolveStepTargetPath,
  type PendingRecoverableCommandRetry,
  RELIABILITY_REPAIR_PROOF_MARKER,
  collectTerminalContext,
  getReliabilityRepairProofMaxFailures,
  hashAbsoluteFileForSafety,
  hashProjectFileForEvidence,
  isReliabilityRepairProofEnabled,
  readJsonArtifact,
  saveSessionState,
  snapshotProjectFilesForSafety,
  summarizeVerifierStreamForEvidence,
  writeValidatedExecutionReport,
} from './stages/executorHelpers.js';
import {
  extractRequestedFileTargets,
  getBoundedExecutorContractLines,
  getBoundedTaskPlanningLines,
  getBoundedTaskQaLines,
  getRequestedTargetContract,
  isAndroidUtilityFileRequest,
  isAndroidWarningCleanupRequest,
  isWriteReportTarget,
  maybeApplyManifestTaskShapeProfile,
  mergeTaskContext,
  normalizePathForComparison,
  normalizeRequestedFileTargetsForBoundedContract,
  uniqueStrings,
  type BoundedTaskContract,
  type SemanticExpectation,
} from './stages/taskShape.js';
import {
  maybeHandleNewFilePreflightFastPath,
  normalizePlanTargetsAgainstRequestedOutputs,
  verifyBoundedTaskArtifacts,
  verifySuccessfulTextWriteTarget,
} from './stages/verification.js';
import {
  getDeterministicSimpleRepairWrite,
  getDirectBoundedWritePlan,
  getNextDeterministicSimpleWrite,
} from './stages/simpleArtifactFallback.js';
import {
  buildBenchmarkVerificationPromptLines,
  collectBenchmarkRiskPlanViolations,
  type BenchmarkVerificationResult,
} from './stages/benchmarkVerification.js';
import { classifyBenchmarkTaskRisk } from './stages/benchmarkTaskRisk.js';
import {
  createRepairState,
  formatFailureFingerprint,
  recordRepairFailure,
  type RepairState,
} from './stages/executorRepairState.js';
import { evaluatePreCompleteGuards } from './stages/preCompleteGuards.js';
import {
  evaluateRunnableArtifactGate,
  runnableArtifactGateBlocksCompletion,
  runnableArtifactGateHaltDecision,
} from './stages/runnableArtifactGate.js';
import { runRuntimeVerification } from './stages/runtimeVerificationRunner.js';
import { runGodotArtifactRepairLoop } from './stages/godotArtifactRepair.js';
import { seedGodotMobileScaffold } from './stages/godotScaffoldSeeder.js';
import {
  AMBIGUOUS_LITERAL_BINDING_STATUS,
  EXACT_INSTRUCTION_DRIFT_STATUS,
  summarizeExactInvariantFailure,
  verifyExactInvariants,
  type ExactInvariantRegistry,
} from './stages/exactInvariants.js';

import type {
  BudgetDiagnostic,
  HaltTag,
  OrchestratorErrorHalt,
  OrchestratorManifest,
  PipelineMode,
  RuntimeTelemetry,
  SwePlan,
  QaVerdictReject,
  ToolCallLog,
} from './schemas/agentContracts.js';

import type { TargetModel } from './execute.js';
import type { ResolvedModelPolicy } from './modelPolicy.js';
import type { SessionUsageSummary } from './services/costTracker.js';

// ─── Constants (canonical source: ./pipeline/paths.ts) ────────────────────────

import {
  BABEL_ROOT,
  BABEL_RUNS_DIR,
  GRADLE_CACHE_DIR,
  MAX_SWE_QA_LOOPS,
  MAX_EXECUTOR_TURNS,
  MAX_EVIDENCE_LOOPS,
  DEFAULT_ORCHESTRATOR_VERSION,
  BENCHMARK_INSTALL_RECOVERY_TAG,
  QA_PATHS,
  EXECUTOR_PATHS,
  abs,
  resolveOrchestratorVersion,
  getOrchestratorPaths,
  type OrchestratorRuntimeVersion,
} from './pipeline/paths.js';

/** Enable Smart Planner: skip weak models for hard tasks. */
const SMART_PLANNER_ENABLED = process.env['BABEL_SMART_PLANNER'] === 'true';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  /** Override the project detected by the Orchestrator. */
  project?: string;
  /** Override the pipeline mode from the Orchestrator manifest. */
  mode?: ValidMode;
  /** Select which orchestrator contract Stage 1 should use. */
  orchestratorVersion?: OrchestratorRuntimeVersion;
  /** Skip Orchestrator model-selection and force a specific worker model. */
  modelOverride?: string;
  /** Select which configured model-policy tier should be resolved. */
  modelTier?: string;
  /** Opt in explicitly to model-policy entries marked expensive. */
  allowExpensive?: boolean;
  /** Include resolved model-policy details in user-visible outputs. */
  showModelPolicy?: boolean;
  /** Associate the raw evidence bundle with a Local Mode session ID. */
  sessionId?: string;
  /** Optional session-start artifact path for exact protocol reconciliation. */
  sessionStartPath?: string;
  /** Optional Local Mode runtime root for exact protocol reconciliation. */
  localLearningRoot?: string;
  /** Custom log file path (H8.1) */
  logFile?: string;
  /** Disable automatic per-run logging if false (H8.1) */
  autoLog?: boolean;
  /** Dedicated event bus for UI integration. */
  eventBus?: BabelEventBus;
  /** Optional file locks to respect during tool execution. */
  lockedFiles?: string[];
  /** Select executor/QA posture for the run without changing the default safe path. */
  executionProfile?: ExecutionProfileName;
  /** Enable performance benchmarking and output latency metrics. */
  benchmark?: boolean;
  /** Whether to update latest run pointer files during this invocation. */
  writeLatestPointers?: boolean;
  /** Denied fingerprints from session to pass down to executor loop */
  deniedFingerprints?: Map<string, { count: number; turn: number }>;
  /** Signal to abort the pipeline mid-execution. */
  abortSignal?: AbortSignal;
}

export interface PipelineResult {
  runDir: string;
  manifest: OrchestratorManifest;
  plan: SwePlan | null;
  status: TerminalStatus;
  finalAnswer?: string;
  manualPromptPath?: string;
  repairPromptPath?: string;
  errors?: string[];
  modelPolicy?: ResolvedModelPolicy;
  usageSummary?: SessionUsageSummary;
  terminalSummary?: TerminalStatusSummary;
  attemptSafetySummary?: AttemptSafetySummary | null;
  verifierContractSummary?: VerifierContractSummary;
}

type ExecutorTerminalStatus =
  | 'EXECUTION_COMPLETE'
  | 'EXECUTION_HALTED'
  | 'ACTIVATION_REFUSED'
  | 'PARTIAL';

import type { ExecutorLoopResult } from './pipeline/executorLoopTypes.js';
import type { RuntimeCompiledArtifacts } from './pipeline/runtimeTelemetry.js';
import {
  buildV9StackTelemetry,
  writeRuntimeTelemetrySnapshot,
  mergeExecutorJitTelemetry,
  markRuntimeTelemetryQaPass,
  markRuntimeTelemetryQaReject,
  markRuntimeTelemetryOutcome,
} from './pipeline/runtimeTelemetry.js';

/**
 * Checks if any planned mutating actions conflict with existing workspace locks.
 */
function configureToolProjectRoot(manifest: OrchestratorManifest): void {
  const root = inferProjectRoot(manifest);
  if (!root) return;
  process.env['BABEL_PROJECT_ROOT'] = root;
  logDetail(`Tool project root: ${root}`);
}

import {
  maybeApplyDeterministicDomainOverride,
  maybeApplyBenchmarkRoutingIsolation,
  maybeApplyModelAdapterFallback,
  maybeApplyBenchmarkHarnessOverlay,
  maybeEnrichPipelineStageIds,
  isAndroidSourceOnlyWorkspace,
} from './pipeline/manifestPatching.js';
export {
  inferDeterministicDomainId,
  maybeApplyDeterministicDomainOverride,
  maybeApplyModelAdapterFallback,
  maybeApplyBenchmarkHarnessOverlay,
  maybeEnrichPipelineStageIds,
  maybeApplyBenchmarkRoutingIsolation,
} from './pipeline/manifestPatching.js';
import {
  sanitizeQaVerdictForDeterministicGradleBootstrapLane,
  sanitizeWindowsGradlewPermissionQaVerdict,
  sanitizeExistingWrapperQaVerdict,
  sanitizeGroundingViolationsForAndroidSdkLane,
} from './pipeline/qaVerdictSanitizers.js';
import { runExecutorLoop } from './pipeline/executorLoop.js';

// ─── Executor halt resolution ──────────────────────────────────────────────────

interface ExecutorHaltResolution {
  haltedStatus: TerminalStatus;
  matchedConditions: string[];
}

function resolveExecutorHaltStatus(
  haltCondition: string,
  haltTag: string | undefined,
): ExecutorHaltResolution {
  const matchedConditions: string[] = [];
  let haltedStatus: TerminalStatus = 'EXECUTOR_HALTED';

  if (/\[ROLLBACK_FAILED\]/.test(haltCondition)) {
    haltedStatus = 'ROLLBACK_FAILED';
    matchedConditions.push('ROLLBACK_FAILED');
  }
  if (/\[ROLLBACK_APPLIED\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'ROLLBACK_APPLIED';
    matchedConditions.push('ROLLBACK_APPLIED');
  }
  if (/\[WORKTREE_DIRTY_UNSAFE\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'WORKTREE_DIRTY_UNSAFE';
    matchedConditions.push('WORKTREE_DIRTY_UNSAFE');
  }
  if (/\[VERIFIER_NOT_FOUND\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'VERIFIER_NOT_FOUND';
    matchedConditions.push('VERIFIER_NOT_FOUND');
  }
  if (/\[REPAIR_REPEATED_FAILURE\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'REPAIR_REPEATED_FAILURE';
    matchedConditions.push('REPAIR_REPEATED_FAILURE');
  }
  if (
    haltTag === 'REPAIR_BUDGET_EXCEEDED' ||
    /\[REPAIR_MAX_ATTEMPTS_REACHED\]/.test(haltCondition)
  ) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'REPAIR_MAX_ATTEMPTS_REACHED';
    matchedConditions.push('REPAIR_MAX_ATTEMPTS_REACHED');
  }
  if (/\[SHELL_COMMAND_DENIED\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'SHELL_COMMAND_DENIED';
    matchedConditions.push('SHELL_COMMAND_DENIED');
  }
  if (/\[SHELL_COMMAND_FAILED\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'SHELL_COMMAND_FAILED';
    matchedConditions.push('SHELL_COMMAND_FAILED');
  }
  if (/\[VERIFIER_FAILED\]/.test(haltCondition)) {
    if (haltedStatus === 'EXECUTOR_HALTED') haltedStatus = 'VERIFIER_FAILED';
    matchedConditions.push('VERIFIER_FAILED');
  }

  return { haltedStatus, matchedConditions };
}

// ─── Chat mode pipeline ────────────────────────────────────────────────────────

interface ChatPipelineContext {
  manifest: OrchestratorManifest;
  mergedTaskContext: string;
  evidence: EvidenceBundle;
  groundingContext: string;
  executionProfileName: ExecutionProfileName;
  runtimeProjectRoot: string;
  pruningStubs: Map<string, string>;
  taskGrounding: ReturnType<typeof buildTaskGrounding>;
  v9StackTelemetry: RuntimeTelemetry | null;
  effectiveMode: PipelineMode;
}

async function runChatPipeline(
  ctx: ChatPipelineContext,
  finalize: (result: PipelineResult) => Promise<PipelineResult>,
): Promise<PipelineResult> {
  let { v9StackTelemetry } = ctx;
  const {
    manifest,
    mergedTaskContext,
    evidence,
    groundingContext,
    executionProfileName,
    runtimeProjectRoot,
    pruningStubs,
    taskGrounding,
    effectiveMode,
  } = ctx;

  // Step 1: Build contract — scan repo for context (from Lite internals)
  log('Stage 1 / 3  —  Scanning repo');
  const projectRoot = inferProjectRoot(manifest) ?? runtimeProjectRoot;
  let chatContract: LiteTaskContract | null = null;
  try {
    chatContract = buildLiteTaskContract({
      task: mergedTaskContext,
      repoPath: projectRoot,
      maxPromptTokens: 2500,
      fileScanLimit: 600,
    });
    evidence.writeDebugFile('chat_contract.json', `${JSON.stringify(chatContract, null, 2)}\n`);
  } catch {
    logDetail('Contract building skipped — repo not scannable, proceeding without it.');
  }

  // Step 2: Plan — single SWE pass
  log('Stage 2 / 3  —  Planning');
  const chatTask = buildSweTask(
    manifest,
    mergedTaskContext,
    [],
    undefined,
    '',
    groundingContext,
    executionProfileName,
  );
  const chatContext = await compileContext(
    manifest.prompt_manifest,
    chatTask,
    projectRoot,
    pruningStubs,
  );
  evidence.writeCompiledContext('chat_v1', chatContext);

  const chatPlanRaw = await runWithFallback(chatContext, SwePlanSchema, {
    evidence,
    stage: 'planning',
    schemaName: 'ChatPlan',
  });
  const { plan: normalizedPlan } = normalizeSwePlan(chatPlanRaw);
  const { plan: groundedPlan } = normalizePlanTargetsAgainstGrounding(
    taskGrounding,
    normalizedPlan,
  );
  const { plan: chatPlan } = normalizePlanTargetsAgainstRequestedOutputs(
    mergedTaskContext,
    groundedPlan,
  );
  const swePlan = splitChainedShellSteps(chatPlan);
  evidence.writeSwePlan(swePlan, 1);

  const actionCount = swePlan.minimal_action_set.length;
  logDetail(`Plan: ${actionCount} step(s) — ${swePlan.task_summary}`);

  // Step 3: Execute (if there are actions to take)
  if (actionCount > 0) {
    // Complex task suggestion (doesn't block execution)
    const riskLane = chatContract?.risk_lane ?? 'Lite';
    if (actionCount > 10 || riskLane === 'Governed') {
      logDetail(
        `This task has ${actionCount} steps and risk level "${riskLane}". ` +
          `For complex work, consider:\n` +
          `  babel plan "..."  — plan first, approve before changes\n` +
          `  babel deep "..."  — full governed pipeline with review`,
      );
    }

    log('Stage 3 / 3  —  Applying changes');
    const chatResult = await runChatExecutorLoop(swePlan, evidence, mergedTaskContext);

    // Emit rich tool annotations to the TUI
    for (const entry of chatResult.toolCallLog) {
      const annotation = formatToolCallForDisplay(entry, projectRoot);
      if (annotation) logDetail(annotation);
    }

    if (chatResult.terminalStatus === 'EXECUTOR_HALTED') {
      logDetail(`Stopped: ${chatResult.haltReason ?? 'execution halted'}`);
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'EXECUTOR_HALTED',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return finalize({
        runDir: evidence.runDir,
        manifest,
        plan: swePlan,
        status: 'EXECUTOR_HALTED',
        errors: [chatResult.haltReason ?? 'Chat executor halted.'],
      });
    }

    v9StackTelemetry = markRuntimeTelemetryOutcome(v9StackTelemetry, 'COMPLETE', effectiveMode);
    writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
    return finalize({ runDir: evidence.runDir, manifest, plan: swePlan, status: 'COMPLETE' });
  }

  // Read-only: no actions to execute
  v9StackTelemetry = markRuntimeTelemetryOutcome(
    v9StackTelemetry,
    'READ_ONLY_NO_MODIFICATION',
    effectiveMode,
  );
  writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
  return finalize({
    runDir: evidence.runDir,
    manifest,
    plan: swePlan,
    status: 'READ_ONLY_NO_MODIFICATION',
    finalAnswer: swePlan.task_summary,
  });
}

async function runPipelineViaDaemon(
  task: string,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { ensureDaemon } = await import('./daemon/client.js');
  await ensureDaemon();

  const { DAEMON_IPC_PATH, DAEMON_IPC_PORT, DAEMON_IPC_HOST } = await import('./daemon/constants.js');
  const { ipcRequest } = await import('./daemon/ipc.js');

  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  return new Promise<PipelineResult>((resolve, reject) => {
    const socket = process.platform === 'win32'
      ? connect(DAEMON_IPC_PORT, DAEMON_IPC_HOST)
      : connect(DAEMON_IPC_PATH);

    socket.setKeepAlive(true, 5000);

    let buffer = '';
    let settled = false;

    // Handle abort signal from client side
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        if (settled) return;
        // Send cancel message over a separate connection
        ipcRequest('pipeline.cancel', { requestId }).catch(() => {});
        settled = true;
        socket.destroy();
        reject(new Error('Pipeline aborted by client.'));
      });
    }

    const sendResponse = (method: string, params: any) => {
      // Connect to a new socket, send response, and close
      ipcRequest(method, params).catch((err) => {
        console.warn(`[daemon] Failed to send ${method}: ${err.message}`);
      });
    };

    socket.on('connect', () => {
      const sanitized = {
        task,
        requestId,
        options: {
          mode: options.mode,
          project: options.project,
          allowExpensive: options.allowExpensive,
          showModelPolicy: options.showModelPolicy,
        },
      };
      socket.write(
        JSON.stringify({
          id: Date.now(),
          method: 'pipeline.run',
          params: sanitized,
        }) + '\n'
      );
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const payload = JSON.parse(line);

          // 1. Process pipeline events
          if (payload.type === 'pipeline_event') {
            const { event, data } = payload;
            if (options.eventBus) {
              if (event === 'stage') {
                options.eventBus.emit('stage', data.stage);
              } else if (event === 'agent_id') {
                options.eventBus.emit('agent_id', data.id);
              } else if (event === 'log') {
                options.eventBus.emit('log', data.line);
              } else if (event === 'runtime_event') {
                options.eventBus.emit('runtime_event', data.event);
              } else if (event === 'prompt_pause') {
                options.eventBus.emit('prompt_pause', data.label);
              } else if (event === 'prompt_resume') {
                options.eventBus.emit('prompt_resume');
              } else if (event === 'assistant_chunk') {
                options.eventBus.emit('assistant_chunk', data);
              } else if (event === 'assistant_thought') {
                options.eventBus.emit('assistant_thought', data.thought);
              }
            }
          }

          // 2. Handle JIT approval requests
          else if (payload.type === 'jit_approval_required') {
            const { id, req } = payload;
            (async () => {
              let approved = false;
              const isInteractive = process.stdout.isTTY && !process.env['CI'] && !process.env['BABEL_NON_INTERACTIVE'];
              
              try {
                if (req.tool === 'file_write') {
                  const { renderGitDiff } = await import('./localTools.js');
                  // renderGitDiff only reads context.runDir; provide minimal ToolContext.
                  const jitRunDir = process.env['BABEL_ACTIVE_RUN_DIR'];
                  const toolContext: ToolContext = {
                    agentId: 'jit',
                    runId: jitRunDir ?? '',
                    babelRoot: BABEL_ROOT,
                  };
                  if (jitRunDir !== undefined) toolContext.runDir = jitRunDir;
                  const diff = renderGitDiff(req, toolContext);
                  if (isInteractive) {
                    approved = await ConfirmDialog.show({
                      title: 'Confirm File Write',
                      message: `Do you want to allow writing changes to:\n  ${req.path}\n\n${diff || '(No differences detected or empty file)'}`,
                      danger: false,
                    });
                  } else {
                    let card = `\nProposed changes to ${req.path}:\n`;
                    if (diff) card += diff;
                    else card += `  (No differences detected or empty file)\n`;
                    process.stdout.write(card);
                    approved = await promptUserJit(`Allow this change? [y/N]: `);
                  }
                } else if (
                  req.tool === 'shell_exec' ||
                  req.tool === 'test_run' ||
                  req.tool === 'git_reset' ||
                  req.tool === 'git_push' ||
                  req.tool === 'file_delete'
                ) {
                  const detail = req.tool === 'file_delete'
                    ? `Delete File: ${req.path}`
                    : req.tool === 'git_reset'
                    ? `Git Reset: ${req.target ?? 'working tree'}`
                    : req.tool === 'git_push'
                    ? `Git Push: ${req.target ?? 'remote'}`
                    : `Command:   ${req.command}\n  Directory: ${req.working_directory ?? process.cwd()}`;
                  
                  if (isInteractive) {
                    approved = await ConfirmDialog.show({
                      title: `Confirm ${req.tool}`,
                      message: `Proposed dangerous tool execution:\n\n  ${detail}`,
                      danger: true,
                    });
                  } else {
                    process.stdout.write(`\n${detail}\n`);
                    approved = await promptUserJit(`Allow this? [y/N]: `);
                  }
                } else {
                  if (isInteractive) {
                    approved = await ConfirmDialog.show({
                      title: `Confirm Tool: ${req.tool}`,
                      message: `Proposed tool execution of "${req.tool}" with arguments:\n\n${JSON.stringify(req, null, 2)}`,
                      danger: true,
                    });
                  } else {
                    process.stdout.write(`\nProposed tool execution of "${req.tool}" with arguments:\n${JSON.stringify(req, null, 2)}\n`);
                    approved = await promptUserJit(`Allow this tool? [y/N]: `);
                  }
                }
              } catch (err) {
                approved = false;
              }

              sendResponse('pipeline.jit_response', { id, approved });
            })();
          }

          // 3. Handle Cost approval requests
          else if (payload.type === 'cost_approval_required') {
            const { id, estimatedCost, threshold, tokenCount, model } = payload;
            (async () => {
              let approved = false;
              try {
                approved = await confirmCost({
                  title: 'Model Cost Threshold Exceeded',
                  message: `Approximate per-run cost $${estimatedCost.toFixed(4)} meets or exceeds warning threshold $${threshold.toFixed(2)}.`,
                  estimatedCost,
                  tokenCount,
                  threshold,
                  model,
                });
              } catch {
                approved = false;
              }
              sendResponse('pipeline.cost_response', { id, approved });
            })();
          }

          // 4. Handle final result
          else if (payload.type === 'pipeline_result') {
            settled = true;
            socket.destroy();
            resolve(payload.result);
          }

          // 5. Handle error
          else if (payload.type === 'pipeline_error') {
            settled = true;
            socket.destroy();
            reject(new Error(payload.error.message));
          }
        } catch (err) {
          // Ignore syntax errors in stream decoding
        }
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error('Daemon connection closed unexpectedly.'));
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Daemon connection failed: ${err.message}`));
      }
    });
  });
}

export async function runBabelPipeline(
  task: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const daemonEnabled = process.env['BABEL_DAEMON_ENABLED'] !== 'false' && process.env['BABEL_DAEMON_ENABLED'] !== '0';
  const isDaemonProcess = isRunningInDaemon();

  if (daemonEnabled && !isDaemonProcess) {
    const DAEMON_BUSY_RETRIES = 3;
    const DAEMON_BUSY_RETRY_DELAY_MS = 1000;
    for (let attempt = 0; attempt <= DAEMON_BUSY_RETRIES; attempt++) {
      try {
        return await runPipelineViaDaemon(task, options);
      } catch (err: any) {
        const isBusy = err?.message?.includes('Daemon is busy');
        if (isBusy && attempt < DAEMON_BUSY_RETRIES) {
          await new Promise((r) => setTimeout(r, DAEMON_BUSY_RETRY_DELAY_MS));
          continue;
        }
        console.warn(`[daemon] Connection or execution failed, falling back to local run: ${err.message}`);
        break;
      }
    }
  }

  clearRoutingCache();
  // Session cost accumulates across runs within the same TUI session.
  // Reset only happens on interactive session startup, not per-pipeline-run.
  const evidence = new EvidenceBundle(task, BABEL_RUNS_DIR);
  const previousLockedFiles = process.env['BABEL_LOCKED_FILES'];
  const effectiveLockedFiles = mergeLockedFiles(
    parseLockedFilesEnv(previousLockedFiles),
    options.lockedFiles ?? [],
    getExternalBenchmarkDefaultLockedFiles(task),
  );
  if (effectiveLockedFiles.length > 0) {
    process.env['BABEL_LOCKED_FILES'] = JSON.stringify(effectiveLockedFiles);
  }
  process.env['BABEL_ACTIVE_RUN_DIR'] = evidence.runDir;
  if (DRY_RUN) {
    process.env['BABEL_SHADOW_ROOT'] = join(evidence.runDir, 'shadow');
  } else {
    delete process.env['BABEL_SHADOW_ROOT'];
  }

  let stream: WriteStream | undefined;
  if (options.logFile) {
    const logPath = resolve(options.logFile);
    mkdirSync(dirname(logPath), { recursive: true });
    stream = createWriteStream(logPath, { flags: 'a' });
  } else if (options.autoLog !== false) {
    const defaultLogPath = join(evidence.runDir, 'babel.log');
    stream = createWriteStream(defaultLogPath);
  }
  options.eventBus?.runtimeEvent('session.started', {
    run_id: evidence.runId,
    run_dir: evidence.runDir,
    task,
  });

  const runLogic = async (): Promise<PipelineResult> => {
    try {
      const result = await _runBabelPipelineInternal(task, options, evidence);
      options.eventBus?.runtimeEvent('session.completed', {
        run_id: evidence.runId,
        run_dir: evidence.runDir,
        status: result.status,
      });
      return result;
    } finally {
      clearActiveTaskEnvelope();
      if (stream) {
        stream.end();
      }
      if (previousLockedFiles === undefined) {
        delete process.env['BABEL_LOCKED_FILES'];
      } else {
        process.env['BABEL_LOCKED_FILES'] = previousLockedFiles;
      }
    }
  };

  if (stream) {
    const context = { stream, ...(options.eventBus ? { eventBus: options.eventBus } : {}) };
    return runWithPipelineLogContext(context, runLogic);
  } else {
    return runLogic();
  }
}

export async function _runBabelPipelineInternal(
  task: string,
  options: PipelineOptions,
  evidence: EvidenceBundle,
  precomputedManifest?: OrchestratorManifest,
): Promise<PipelineResult> {
  log(`Run directory: ${evidence.runDir}`);

  const orchestratorVersion = resolveOrchestratorVersion(options.orchestratorVersion);
  const sessionId =
    options.sessionId?.trim() || process.env['BABEL_SESSION_ID']?.trim() || undefined;
  const sessionStartPath =
    options.sessionStartPath?.trim() ||
    process.env['BABEL_SESSION_START_PATH']?.trim() ||
    undefined;
  const localLearningRoot =
    options.localLearningRoot?.trim() ||
    process.env['BABEL_LOCAL_LEARNING_ROOT']?.trim() ||
    undefined;
  const requestedExecutionProfile =
    options.executionProfile ??
    normalizeExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']) ??
    DEFAULT_EXECUTION_PROFILE;
  const executionProfile = resolveExecutionProfile(requestedExecutionProfile);
  const harnessMetadata = collectHarnessMetadata(sessionStartPath, localLearningRoot);
  const authoritativeProjectRoot = process.env['BABEL_PROJECT_ROOT']?.trim() || null;
  const sessionResolvedRoot = readSessionStartProjectPath(sessionStartPath);
  if (authoritativeProjectRoot) {
    logDetail(`Authoritative project root (BABEL_PROJECT_ROOT): ${authoritativeProjectRoot}`);
  }
  if (sessionStartPath) {
    logDetail(`Session start path: ${sessionStartPath}`);
    logDetail(
      `Session start resolved root: ${
        sessionResolvedRoot ?? '(not resolved — not a valid session start file)'
      }`,
    );
  }
  const runtimeProjectRoot = resolve(
    authoritativeProjectRoot ?? sessionResolvedRoot ?? process.cwd(),
  );
  logDetail(`Runtime project root: ${runtimeProjectRoot}`);

  // ── Phase 1a: Load and activate task envelope ───────────────────────────
  const envelopeResult = loadTaskEnvelope(runtimeProjectRoot);
  if (envelopeResult.loaded && envelopeResult.envelope) {
    setActiveTaskEnvelope(envelopeResult.envelope);
    resetFileWriteCount(evidence.runId);
    logDetail(`Task envelope loaded: ${envelopeResult.path}`);
    logDetail(
      `  Mode: ${envelopeResult.envelope.mode}, Network: ${envelopeResult.envelope.networkAccess}`,
    );
    if (envelopeResult.envelope.allowedTools?.length) {
      logDetail(`  Allowed tools: ${envelopeResult.envelope.allowedTools.join(', ')}`);
    }
    if (envelopeResult.envelope.deniedTools?.length) {
      logDetail(`  Denied tools: ${envelopeResult.envelope.deniedTools.join(', ')}`);
    }
    if (envelopeResult.envelope.maxFileWrites !== undefined) {
      logDetail(`  Max file writes: ${envelopeResult.envelope.maxFileWrites}`);
    }
  } else if (envelopeResult.error) {
    logDetail(`Task envelope error: ${envelopeResult.error}`);
  }

  let resolvedModelPolicy: ResolvedModelPolicy | undefined;
  const traceOptions = {
    runDir: evidence.runDir,
    orchestratorVersion,
    metadata: harnessMetadata,
    ...(options.mode ? { requestedMode: options.mode } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionStartPath ? { sessionStartPath } : {}),
    ...(localLearningRoot ? { localLearningRoot } : {}),
  };
  const pipelineTrace = await PipelineTrace.start(traceOptions);

  const finalizeResult = async (result: PipelineResult): Promise<PipelineResult> => {
    const terminalContext = collectTerminalContext(evidence.runDir);
    const verifierContract = buildVerifierContractArtifacts({
      task,
      toolCallLog: terminalContext.toolCallLog,
      runDir: evidence.runDir,
    });
    evidence.writeDebugFile(
      'verifier_plan.json',
      `${JSON.stringify(verifierContract.plan, null, 2)}\n`,
    );
    evidence.writeDebugFile(
      'verifier_execution_summary.json',
      `${JSON.stringify(verifierContract.summary, null, 2)}\n`,
    );
    const terminalState = buildPipelineFinalTerminalState({
      resultStatus: result.status,
      terminalContext,
      verifierContractSummary: verifierContract.summary,
    });
    evidence.writeDebugFile(
      'terminal_status_summary.json',
      `${JSON.stringify(terminalState.terminalSummary, null, 2)}\n`,
    );
    const finalizedResult: PipelineResult = {
      ...result,
      status: terminalState.status,
      terminalSummary: terminalState.terminalSummary,
      attemptSafetySummary: terminalContext.attemptSafetySummary,
      verifierContractSummary: verifierContract.summary,
    };
    await runPluginHooks('PostRun', {
      runId: evidence.runId,
      runDir: evidence.runDir,
      babelRoot: BABEL_ROOT,
      projectRoot: inferProjectRoot(finalizedResult.manifest) ?? runtimeProjectRoot,
      dryRun: DRY_RUN,
      status: finalizedResult.status,
      manifest: finalizedResult.manifest,
      plan: finalizedResult.plan,
    });
    const traceSummary = await pipelineTrace.finish(finalizedResult.status);
    evidence.writeTraceContext(traceSummary);
    evidence.writeWaterfallTelemetry();
    const costLedger = buildCostLedger({
      runId: evidence.runId,
      task,
      lane: 'governed',
      waterfallEntries: evidence.getWaterfallLogSnapshot(),
    });
    evidence.writeCostLedger(costLedger);
    const usageSummary =
      costLedger.entries.length > 0
        ? usageSummaryFromCostLedger(costLedger)
        : globalCostTracker.getSessionSummary();

    // Trigger Project Memory Extraction on success
    if (finalizedResult.status === 'COMPLETE') {
      await extractAndSaveMemories(
        finalizedResult.runDir,
        inferProjectRoot(finalizedResult.manifest),
        evidence,
      );
    }

    // Prune old session checkpoints to prevent unbounded storage growth.
    // Uses the manifest's session_id, falling back to a hash of the run dir.
    const pruneSessionId =
      finalizedResult.manifest.session_id ??
      `run_${finalizedResult.runDir.split(/[\\/]/).pop() ?? 'unknown'}`;
    try {
      const pruned = pruneSessionCheckpoints(pruneSessionId);
      if (pruned > 0) {
        logDetail(`Pruned ${pruned} old session checkpoint(s) for ${pruneSessionId}`);
      }
    } catch {
      // Best-effort — never block finalization for checkpoint cleanup.
    }

    if (options.writeLatestPointers !== false) {
      writeLatestRunPointers(finalizedResult.runDir, finalizedResult.manifest.target_project, {
        status: finalizedResult.status,
        targetRoot: inferProjectRoot(finalizedResult.manifest) ?? runtimeProjectRoot,
        command: 'run',
        evidenceComplete: true,
      });
    }
    if (finalizedResult.modelPolicy !== undefined || resolvedModelPolicy === undefined) {
      return {
        ...finalizedResult,
        usageSummary,
      };
    }
    return {
      ...finalizedResult,
      modelPolicy: resolvedModelPolicy,
      usageSummary,
    };
  };

  const finalizeError = async (error: unknown): Promise<PipelineResult> => {
    const message = error instanceof Error ? error.message : String(error);
    const failureArtifacts = buildPreExecutionFailureArtifacts({
      runDir: evidence.runDir,
      error,
    });
    const recoverableManifest = hasUsefulEvidence(evidence.runDir)
      ? readManifestFromEvidence(evidence.runDir)
      : null;
    if (recoverableManifest) {
      const recoveredPlan = readLatestSwePlanFromEvidence(evidence.runDir);
      const blockedSummary = buildBlockedRunSummaryArtifact({
        task,
        errorMessage: message,
        condition: failureArtifacts.condition,
        runDir: evidence.runDir,
      });
      evidence.writeDebugFile(
        PRE_EXECUTION_FAILURE_CAPSULE_FILENAME,
        `${JSON.stringify(failureArtifacts.failureCapsule, null, 2)}\n`,
      );
      evidence.writeDebugFile(
        'blocked_run_summary.json',
        `${JSON.stringify(blockedSummary, null, 2)}\n`,
      );
      const terminalSummary = buildTerminalStatusSummary({
        status: 'EXECUTOR_HALTED',
        condition: `[RECOVERED_AFTER_EVIDENCE] ${failureArtifacts.condition}`,
        failureCapsulePath: failureArtifacts.failureCapsulePath,
      });
      evidence.writeDebugFile(
        'terminal_status_summary.json',
        `${JSON.stringify(terminalSummary, null, 2)}\n`,
      );
      if (options.writeLatestPointers !== false) {
        writeLatestRunPointers(evidence.runDir, recoverableManifest.target_project, {
          status: 'EXECUTOR_HALTED',
          targetRoot: inferProjectRoot(recoverableManifest) ?? runtimeProjectRoot,
          command: 'run',
          evidenceComplete: true,
        });
      }
      await runPluginHooks('PostRun', {
        runId: evidence.runId,
        runDir: evidence.runDir,
        babelRoot: BABEL_ROOT,
        projectRoot: inferProjectRoot(recoverableManifest) ?? runtimeProjectRoot,
        dryRun: DRY_RUN,
        status: 'EXECUTOR_HALTED',
        error: message,
      });
      const traceSummary = await pipelineTrace.finish('EXECUTOR_HALTED', error);
      evidence.writeTraceContext(traceSummary);
      evidence.writeWaterfallTelemetry();
      const costLedger = buildCostLedger({
        runId: evidence.runId,
        task,
        lane: 'governed',
        waterfallEntries: evidence.getWaterfallLogSnapshot(),
      });
      evidence.writeCostLedger(costLedger);
      return {
        runDir: evidence.runDir,
        manifest: recoverableManifest,
        plan: recoveredPlan,
        status: 'EXECUTOR_HALTED',
        errors: [message],
        terminalSummary,
        finalAnswer: blockedSummary.answer,
        usageSummary:
          costLedger.entries.length > 0
            ? usageSummaryFromCostLedger(costLedger)
            : globalCostTracker.getSessionSummary(),
      };
    }
    writeValidatedExecutionReport(
      evidence,
      failureArtifacts.executionReport,
      [],
      failureArtifacts.executionReport.warnings,
    );
    evidence.writeDebugFile(
      PRE_EXECUTION_FAILURE_CAPSULE_FILENAME,
      `${JSON.stringify(failureArtifacts.failureCapsule, null, 2)}\n`,
    );
    const terminalSummary = buildTerminalStatusSummary({
      status: 'FATAL_ERROR',
      condition: failureArtifacts.condition,
      failureCapsulePath: failureArtifacts.failureCapsulePath,
    });
    evidence.writeDebugFile(
      'terminal_status_summary.json',
      `${JSON.stringify(terminalSummary, null, 2)}\n`,
    );
    if (options.writeLatestPointers !== false) {
      writeLatestRunPointers(evidence.runDir, 'global', {
        status: 'FATAL_ERROR',
        targetRoot: runtimeProjectRoot,
        command: 'run',
        evidenceComplete: true,
      });
    }
    await runPluginHooks('PostRun', {
      runId: evidence.runId,
      runDir: evidence.runDir,
      babelRoot: BABEL_ROOT,
      projectRoot: runtimeProjectRoot,
      dryRun: DRY_RUN,
      status: 'FATAL_ERROR',
      error: message,
    });
    const traceSummary = await pipelineTrace.finish('FATAL_ERROR', error);
    evidence.writeTraceContext(traceSummary);
    evidence.writeWaterfallTelemetry();
    evidence.writeCostLedger(
      buildCostLedger({
        runId: evidence.runId,
        task,
        lane: 'governed',
        waterfallEntries: evidence.getWaterfallLogSnapshot(),
      }),
    );
    throw error;
  };

  if (DRY_RUN) {
    log('Dry run mode is on — changes will be simulated, not applied.');
  }
  logDetail(`Execution profile: ${executionProfile.name}`);

  if (!existsSync(runtimeProjectRoot)) {
    const chainParts: string[] = [];
    if (authoritativeProjectRoot) {
      chainParts.push(`BABEL_PROJECT_ROOT="${authoritativeProjectRoot}"`);
    } else {
      chainParts.push('BABEL_PROJECT_ROOT (not set)');
    }
    if (sessionResolvedRoot) {
      chainParts.push(`session-start ProjectPath="${sessionResolvedRoot}"`);
    } else if (sessionStartPath) {
      chainParts.push(
        `session-start path="${sessionStartPath}" (did not resolve to a valid project root)`,
      );
    } else {
      chainParts.push('session-start path (not set)');
    }
    chainParts.push(`fallback cwd="${process.cwd()}"`);
    const resolutionChain = chainParts.join(' -> ');
    logDetail(`Runtime root resolution chain: ${resolutionChain}`);
    return await finalizeError(
      new Error(
        `Resolved target root does not exist: ${runtimeProjectRoot}. Resolution chain: ${resolutionChain}`,
      ),
    );
  }

  await runPluginHooks('PreRun', {
    runId: evidence.runId,
    runDir: evidence.runDir,
    babelRoot: BABEL_ROOT,
    projectRoot: runtimeProjectRoot,
    dryRun: DRY_RUN,
    task,
  });

  // ── Preflight: Parallel Semantic Indexing & Root Discovery ────────────────
  const preflightTaskId = backgroundTaskRegistry.register('Building semantic index…');
  const preflightPromise = (async () => {
    try {
      await globalIndexer.indexProject(runtimeProjectRoot);
      backgroundTaskRegistry.complete(preflightTaskId);
    } catch (err) {
      backgroundTaskRegistry.fail(preflightTaskId, err instanceof Error ? err.message : undefined);
    }
  })();

  try {
    // ── Stage 1: Orchestrator ───────────────────────────────────────────────────
    let manifest: OrchestratorManifest;
    let orchestratorContext: string | undefined;
    if (precomputedManifest) {
      log('Stage 1 / 4  —  Using precomputed manifest');
      manifest = precomputedManifest;
    } else {
      log('Stage 1 / 4  —  Analyzing your request');
      options.eventBus?.assistantChunk('\n  Analyzing your request…\n');
      logDetail(`Orchestrator version: ${orchestratorVersion}`);
      options.eventBus?.emit('agent_id', 'OLS-v9 ORCHESTRATOR');

      orchestratorContext = await compileContext(
        abs(getOrchestratorPaths(orchestratorVersion)),
        buildOrchestratorTask(task, options, orchestratorVersion),
        sessionStartPath,
      );
      evidence.writeCompiledContext('orchestrator', orchestratorContext);

      const orchestratorSpan = pipelineTrace.startChildSpan('babel.orchestrator', {
        'babel.orchestrator.version': orchestratorVersion,
      });

      try {
        const orchestratorOutput = await runWithFallback(
          orchestratorContext,
          OrchestratorOutputSchema,
          {
            evidence,
            stage: 'orchestrator',
            schemaName: 'OrchestratorOutputSchema',
          },
        );
        assertManifest(orchestratorOutput); // throws on error_halt
        manifest = OrchestratorManifestSchema.parse(orchestratorOutput);
        manifest = normalizeManifestProjectRoot(manifest, sessionStartPath, {
          authoritativeProjectRoot,
        });
        endSpan(orchestratorSpan, SpanStatusCode.OK);
      } catch (error) {
        endSpan(orchestratorSpan, SpanStatusCode.ERROR, {}, error);
        throw error;
      }
    }
    manifest = normalizeManifestProjectRoot(manifest, sessionStartPath, {
      authoritativeProjectRoot,
    });
    let manifestArtifact: Record<string, unknown> = manifest as unknown as Record<string, unknown>;
    let v9StackTelemetry: RuntimeTelemetry | null = null;
    let stackOptimizationWarnings: string[] = [];

    if (
      orchestratorVersion === 'v9' &&
      manifest.instruction_stack &&
      manifest.compilation_state === 'uncompiled'
    ) {
      const compilerSpan = pipelineTrace.startChildSpan('babel.compiler', {
        'babel.compilation.state.before': manifest.compilation_state,
        'babel.stack.domain_id': manifest.instruction_stack.domain_id,
        'babel.stack.model_adapter_id': manifest.instruction_stack.model_adapter_id,
        'babel.stack.behavioral_count': manifest.instruction_stack.behavioral_ids.length,
        'babel.stack.skill_count.requested': manifest.instruction_stack.skill_ids.length,
        'babel.stack.task_overlay_count': manifest.instruction_stack.task_overlay_ids.length,
        'babel.stack.pipeline_stage_count': manifest.instruction_stack.pipeline_stage_ids.length,
      });

      try {
        const deterministicDomainResult = maybeApplyDeterministicDomainOverride(manifest, task);
        manifest = deterministicDomainResult.manifest;
        if (deterministicDomainResult.applied) {
          stackOptimizationWarnings = [
            ...stackOptimizationWarnings,
            ...deterministicDomainResult.warnings,
          ];
          logDetail(deterministicDomainResult.warnings[0] ?? 'Applied deterministic domain route.');
        }

        const benchmarkRoutingIsolationResult = maybeApplyBenchmarkRoutingIsolation(manifest, task);
        manifest = benchmarkRoutingIsolationResult.manifest;
        if (benchmarkRoutingIsolationResult.applied) {
          stackOptimizationWarnings = [
            ...stackOptimizationWarnings,
            ...benchmarkRoutingIsolationResult.warnings,
          ];
          logDetail(
            benchmarkRoutingIsolationResult.warnings[0] ?? 'Applied benchmark routing isolation.',
          );
        }

        const modelAdapterFallbackResult = maybeApplyModelAdapterFallback(manifest);
        manifest = modelAdapterFallbackResult.manifest;
        if (modelAdapterFallbackResult.applied) {
          stackOptimizationWarnings = [
            ...stackOptimizationWarnings,
            ...modelAdapterFallbackResult.warnings,
          ];
          logDetail(modelAdapterFallbackResult.warnings[0] ?? 'Applied model adapter fallback.');
        }

        const optimizedManifestResult = maybeApplyManifestTaskShapeProfile(
          manifest,
          task,
          inferProjectRoot(manifest),
        );
        manifest = optimizedManifestResult.manifest;
        stackOptimizationWarnings = [
          ...stackOptimizationWarnings,
          ...optimizedManifestResult.warnings,
        ];
        const benchmarkHarnessOverlayResult = maybeApplyBenchmarkHarnessOverlay(manifest, task);
        manifest = benchmarkHarnessOverlayResult.manifest;
        stackOptimizationWarnings = [
          ...stackOptimizationWarnings,
          ...benchmarkHarnessOverlayResult.warnings,
        ];
        if (benchmarkHarnessOverlayResult.applied) {
          logDetail(
            benchmarkHarnessOverlayResult.warnings[0] ?? 'Applied benchmark harness overlay.',
          );
        }

        const pipelineStageEnrichmentResult = maybeEnrichPipelineStageIds(manifest, options.mode);
        manifest = pipelineStageEnrichmentResult.manifest;
        if (pipelineStageEnrichmentResult.applied) {
          stackOptimizationWarnings = [
            ...stackOptimizationWarnings,
            ...pipelineStageEnrichmentResult.warnings,
          ];
          logDetail(
            pipelineStageEnrichmentResult.warnings[0] ?? 'Applied pipeline stage enrichment.',
          );
        }

        if (
          optimizedManifestResult.applied ||
          deterministicDomainResult.applied ||
          benchmarkRoutingIsolationResult.applied ||
          modelAdapterFallbackResult.applied ||
          benchmarkHarnessOverlayResult.applied ||
          pipelineStageEnrichmentResult.applied
        ) {
          const optimizedInstructionStack = manifest.instruction_stack;
          if (optimizedManifestResult.applied) {
            logDetail(optimizedManifestResult.warnings[0] ?? 'Applied stack optimization.');
          }
          evidence.writeDebugFile(
            'debug_stack_optimization.json',
            JSON.stringify(
              {
                applied: optimizedManifestResult.applied,
                deterministic_domain_applied: deterministicDomainResult.applied,
                benchmark_routing_isolation_applied: benchmarkRoutingIsolationResult.applied,
                model_adapter_fallback_applied: modelAdapterFallbackResult.applied,
                benchmark_harness_overlay_applied: benchmarkHarnessOverlayResult.applied,
                pipeline_stage_enrichment_applied: pipelineStageEnrichmentResult.applied,
                target_project: manifest.target_project,
                domain_id: optimizedInstructionStack?.domain_id ?? null,
                explicit_skill_ids: [...(optimizedInstructionStack?.skill_ids ?? [])],
                task_overlay_ids: [...(optimizedInstructionStack?.task_overlay_ids ?? [])],
                warnings: stackOptimizationWarnings,
                resolution_policy: manifest.resolution_policy,
              },
              null,
              2,
            ),
          );
        }

        log(`[debug] Starting manifest resolution...`);
        const manifestStartMs = performance.now();
        let resolvedManifest = resolveInstructionStackManifest(manifest, BABEL_ROOT);
        const manifestDurationMs = performance.now() - manifestStartMs;

        if (options.benchmark) {
          const benchmarkDir = join(BABEL_ROOT, 'runs', 'benchmarks');
          if (!existsSync(benchmarkDir)) {
            mkdirSync(benchmarkDir, { recursive: true });
          }
          const benchmarkPath = join(benchmarkDir, 'manifest-latency-v9.json');
          const benchmarkData = {
            timestamp: new Date().toISOString(),
            task_length: task.length,
            skill_count: manifest.instruction_stack?.skill_ids.length ?? 0,
            manifest_ms: manifestDurationMs,
            orchestrator_version: orchestratorVersion,
          };
          writeFileSync(benchmarkPath, JSON.stringify(benchmarkData, null, 2));
          log(`[benchmark] Manifest latency written to ${benchmarkPath}`);
        }

        resolvedManifest = normalizeManifestProjectRoot(resolvedManifest, sessionStartPath, {
          authoritativeProjectRoot,
        });
        if (stackOptimizationWarnings.length > 0 && resolvedManifest.compiled_artifacts) {
          resolvedManifest = {
            ...resolvedManifest,
            compiled_artifacts: {
              ...resolvedManifest.compiled_artifacts,
              warnings: [
                ...(resolvedManifest.compiled_artifacts.warnings ?? []),
                ...stackOptimizationWarnings,
              ],
            },
          };
        }
        const resolvedCompiledArtifacts = (
          resolvedManifest as OrchestratorManifest & {
            compiled_artifacts?: RuntimeCompiledArtifacts;
          }
        ).compiled_artifacts;

        manifest = OrchestratorManifestSchema.parse(resolvedManifest);
        manifestArtifact = resolvedManifest as unknown as Record<string, unknown>;
        logDetail(`Resolved typed stack to ${manifest.prompt_manifest.length} prompt file(s).`);

        // Surface budget pruning, guard-missing, and gate-skip decisions to the operator
        if (resolvedCompiledArtifacts?.warnings) {
          for (const warning of resolvedCompiledArtifacts.warnings) {
            if (
              warning.startsWith('[budget-prune]') ||
              warning.startsWith('[guard-missing]') ||
              warning.startsWith('[gate-skip]')
            ) {
              log(warning);
            }
          }
        }

        if (resolvedCompiledArtifacts) {
          const typedInstructionStack = manifest.instruction_stack;
          v9StackTelemetry = buildV9StackTelemetry(manifest, resolvedCompiledArtifacts);

          const budgetTotal = resolvedCompiledArtifacts.token_budget_total;
          const budgetPolicy = resolvedCompiledArtifacts.budget_policy;
          if (budgetPolicy?.enabled && typeof budgetTotal === 'number') {
            const limit = budgetPolicy.hard_limit ?? 80000;
            if (budgetTotal > limit) {
              const condition = `Token budget exceeded: ${budgetTotal} tokens > ${limit} limit (hard_limit). Pipeline halted for context safety.`;
              log(`[babel:compiler] ❌ ${condition}`);
              const report = buildHaltReport([], 'AMBIGUOUS_PLAN', 0, condition);
              evidence.writeExecutionLog(report);
              return await finalizeResult({
                runDir: evidence.runDir,
                manifest,
                plan: null,
                status: 'EXECUTOR_HALTED',
              });
            }
          }
          pipelineTrace.recordCompilerSummary({
            selectedEntryIds: [...resolvedCompiledArtifacts.selected_entry_ids],
            promptManifestCount: manifest.prompt_manifest.length,
            skillCount: resolvedCompiledArtifacts.selected_entry_ids.filter((entryId) =>
              entryId.startsWith('skill_'),
            ).length,
            tokenBudgetTotal: resolvedCompiledArtifacts.token_budget_total ?? null,
            tokenBudgetMissingCount: resolvedCompiledArtifacts.token_budget_missing?.length ?? 0,
            budgetWarningSeverity: getHighestBudgetSeverity(
              resolvedCompiledArtifacts.budget_diagnostics ?? [],
            ),
            budgetPolicyEnabled: resolvedCompiledArtifacts.budget_policy?.enabled ?? false,
            ...(typedInstructionStack?.domain_id
              ? { domainId: typedInstructionStack.domain_id }
              : {}),
            ...(typedInstructionStack?.model_adapter_id
              ? { modelAdapterId: typedInstructionStack.model_adapter_id }
              : {}),
          });
          if (v9StackTelemetry) {
            logDetail(`v9 stack telemetry: ${JSON.stringify(v9StackTelemetry)}`);
          }
        }

        endSpan(compilerSpan, SpanStatusCode.OK, {
          'babel.compilation.state.after': manifest.compilation_state ?? 'compiled',
          'babel.stack.selected_entry_count':
            manifest.compiled_artifacts?.selected_entry_ids.length,
          'babel.stack.prompt_manifest_count': manifest.prompt_manifest.length,
        });
      } catch (error) {
        endSpan(compilerSpan, SpanStatusCode.ERROR, {}, error);
        throw error;
      }
    }

    configureToolProjectRoot(manifest);

    // ── Routing confidence gate ─────────────────────────────────────────────
    const routingConf = manifest.analysis.routing_confidence;
    if (routingConf !== undefined) {
      if (isConfidenceGateEnabled()) {
        const band = getRoutingConfidenceBand(routingConf);
        let action:
          | 'accepted'
          | 'downgraded'
          | 'validated'
          | 'validator_still_low'
          | 'medium_confidence_regular' = 'accepted';
        let validatorUsed = false;
        let validatorImproved: boolean | null = null;

        if (band === 'low' && orchestratorContext) {
          // Run a bounded validator pass (starts at tier 1, no dynamic routing).
          validatorUsed = true;
          log(
            `[babel:orchestrator] ⚠ Low routing confidence: ${routingConf.toFixed(2)} — ` +
              `running validator pass (tier ${getValidatorTierIndex() + 1}).`,
          );
          // Validator reuses the existing orchestrator waterfall at startTierIndex — no new runner or schema.
          let validatorManifest: OrchestratorManifest | null = null;
          try {
            const validatorOutput = await runWithFallback(
              orchestratorContext,
              OrchestratorOutputSchema,
              {
                evidence,
                stage: 'orchestrator',
                startTierIndex: getValidatorTierIndex(),
                dynamicRouting: false,
              },
            );
            assertManifest(validatorOutput);
            validatorManifest = OrchestratorManifestSchema.parse(validatorOutput);
          } catch {
            log(
              `[babel:orchestrator] ⚠ Validator pass failed — proceeding with original manifest.`,
            );
          }
          if (validatorManifest) {
            const validatorConf = validatorManifest.analysis.routing_confidence;
            if (validatorConf !== undefined && validatorConf >= routingConf) {
              validatorImproved = validatorConf > routingConf;
            } else {
              validatorImproved = false;
            }
            const stillLow = validatorConf === undefined || validatorConf < routingConf + 0.05;
            if (!stillLow) {
              manifest = validatorManifest;
              manifestArtifact = validatorManifest as unknown as Record<string, unknown>;
              action = 'validated';
              log(
                `[babel:orchestrator] Validator improved confidence: ${(validatorConf ?? 0).toFixed(2)} — using validator manifest.`,
              );
            } else {
              action = 'validator_still_low';
              log(
                `[babel:orchestrator] ⚠ Validator confidence still low: ${(validatorConf ?? routingConf).toFixed(2)} ` +
                  `— proceeding with original manifest.`,
              );
            }
          } else {
            action = 'validator_still_low';
          }
        } else if (band === 'medium') {
          // Medium confidence with 'chat' mode is fine (read-only by default).
          // For 'deep' mode, recommend 'plan' as a safer alternative.
          if (!options.mode && manifest.analysis.pipeline_mode === 'chat') {
            // regular is already the safest mode — no downgrade needed
            action = 'medium_confidence_regular';
          } else if (!options.mode && manifest.analysis.pipeline_mode !== 'chat') {
            log(
              `[babel:orchestrator] ⚠ Medium confidence (${routingConf.toFixed(2)}): ` +
                `consider using --mode plan to review before applying changes.`,
            );
          }
        }

        evidence.writeRoutingDecision({
          routing_confidence: routingConf,
          routing_confidence_band: band,
          routing_action: action,
          routing_validator_used: validatorUsed,
          routing_validator_improved: validatorImproved,
          ts: new Date().toISOString(),
        });

        if (v9StackTelemetry) {
          v9StackTelemetry = {
            ...v9StackTelemetry,
            routing_confidence: routingConf,
            routing_confidence_band: band,
            routing_action: action,
            routing_validator_used: validatorUsed,
            routing_validator_improved: validatorImproved,
          };
        }
      } else if (routingConf < 0.8) {
        // Gate disabled — passive warning only.
        log(
          `[babel:orchestrator] ⚠ Low routing confidence: ${routingConf.toFixed(2)} ` +
            `(threshold 0.80) — routing decision may need review.`,
        );
      }
    }

    const manifestWithProtocol = {
      ...manifestArtifact,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(sessionStartPath ? { session_start_path: sessionStartPath } : {}),
      ...(localLearningRoot ? { local_learning_root: localLearningRoot } : {}),
      ...(v9StackTelemetry ? { runtime_telemetry: v9StackTelemetry } : {}),
    };

    evidence.writeManifest(manifestWithProtocol);
    writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
    await runPluginHooks('PostOrchestrator', {
      runId: evidence.runId,
      runDir: evidence.runDir,
      babelRoot: BABEL_ROOT,
      projectRoot: inferProjectRoot(manifest) ?? sessionStartPath ?? process.cwd(),
      dryRun: DRY_RUN,
      manifest,
    });

    const mergedTaskContext = mergeTaskContext(task, manifest.handoff_payload.user_request);
    const originalIntentContract = inferIntentContract(mergedTaskContext);
    evidence.writeDebugFile(
      'intent_contract.json',
      `${JSON.stringify(originalIntentContract, null, 2)}\n`,
    );

    const effectiveModeRaw = options.mode ?? manifest.analysis.pipeline_mode;
    const resolvedMode = resolveMode(effectiveModeRaw);
    if (resolvedMode.deprecated && resolvedMode.note) {
      logDetail(resolvedMode.note);
    }
    let effectiveMode = resolvedMode.mode;
    // Default to deepseek-v4-pro for best instruction following across all stages.
    // The stage-specific policies in model-policy.json further refine per-stage selection.
    const effectiveModel = (options.modelOverride ??
      manifest.worker_configuration.assigned_model ??
      'deepseek-v4-pro') as TargetModel;
    const exactInvariantRegistry = getRequestedTargetContract(mergedTaskContext).exactInvariants;
    evidence.writeDebugFile(
      '11_exact_invariants.json',
      `${JSON.stringify(exactInvariantRegistry, null, 2)}\n`,
    );
    const taskContract = classifyTaskContract(mergedTaskContext);
    const taskGrounding = buildTaskGrounding(taskContract, inferProjectRoot(manifest));
    const planHandoff = loadPlanHandoff({
      repoPath: runtimeProjectRoot,
      task: mergedTaskContext,
    });
    if (planHandoff) {
      evidence.writeDebugFile(
        'plan_handoff.json',
        `${JSON.stringify(
          {
            schema_version: 1,
            plan_run_id: planHandoff.planRunId,
            plan_run_dir: planHandoff.planRunDir,
            allowed_paths: planHandoff.allowedPaths,
          },
          null,
          2,
        )}\n`,
      );
    }
    const groundingContext = [formatGroundingContext(taskGrounding), planHandoff?.contextText ?? '']
      .filter((section) => section.trim().length > 0)
      .join('\n\n');
    const javaRuntimeStatus = detectJavaRuntimeStatus();
    const gradleRuntimeStatus = detectCommandOnPath('gradle');
    resolvedModelPolicy = resolveFamilyModelPolicy({
      family: effectiveModel,
      ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
      ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
      babelRoot: BABEL_ROOT,
    });

    const { config: policyConfig } = loadModelPolicyConfig(BABEL_ROOT);
    const costWarnThreshold = policyConfig.policy?.warn_if_estimated_cost_per_run_usd_at_least;
    const isDaemon = isRunningInDaemon();
    const isInteractive = process.stdout.isTTY && !process.env['CI'] && !options.allowExpensive;
    const modelPolicy = resolvedModelPolicy;
    if (
      typeof costWarnThreshold === 'number' &&
      modelPolicy !== undefined &&
      modelPolicy.approximateCostPerRunUsd !== undefined &&
      modelPolicy.approximateCostPerRunUsd >= costWarnThreshold &&
      (isInteractive || (isDaemon && options.eventBus))
    ) {
      let proceed = false;
      if (isDaemon && options.eventBus) {
        const id = 'cost-' + Math.random();
        proceed = await new Promise<boolean>((resolve) => {
          options.eventBus!.once(`cost_approval_response:${id}`, (data: { approved: boolean }) => {
            resolve(data.approved);
          });
          options.eventBus!.emit('cost_approval_request', {
            id,
            estimatedCost: modelPolicy.approximateCostPerRunUsd,
            threshold: costWarnThreshold,
            tokenCount: (modelPolicy.approximateInputTokens ?? 0) + (modelPolicy.approximateOutputTokens ?? 0),
            model: modelPolicy.resolvedBackendKey,
          });
        });
      } else {
        proceed = await confirmCost({
          title: 'Model Cost Threshold Exceeded',
          message: `Approximate per-run cost $${modelPolicy.approximateCostPerRunUsd.toFixed(4)} meets or exceeds warning threshold $${costWarnThreshold.toFixed(2)}.`,
          estimatedCost: modelPolicy.approximateCostPerRunUsd,
          tokenCount: (modelPolicy.approximateInputTokens ?? 0) + (modelPolicy.approximateOutputTokens ?? 0),
          threshold: costWarnThreshold,
          model: modelPolicy.resolvedBackendKey,
        });
      }
      if (!proceed) {
        throw new Error('Operation cancelled: Estimated cost meets or exceeds budget threshold.');
      }
    }

    pipelineTrace.setRootAttributes({
      'babel.target_project': manifest.target_project,
      'babel.pipeline.mode': effectiveMode,
      'babel.worker.assigned_model': effectiveModel,
      'babel.orchestrator.version': manifest.orchestrator_version,
    });
    pipelineTrace.updateBaggage({
      'babel.lane.id': `${manifest.orchestrator_version}:${effectiveMode}`,
    });

    if (v9StackTelemetry) {
      v9StackTelemetry = {
        ...v9StackTelemetry,
        pipeline_mode: effectiveMode,
      };
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
    }

    logDetail(`Project:  ${manifest.target_project}`);
    logDetail(`Model:    ${effectiveModel}${options.modelOverride ? ' (forced override)' : ''}`);
    logDetail(`Mode:     ${effectiveMode}`);
    const completeStatusForCurrentTask = (): TerminalStatus =>
      isReadOnlyNoModificationRequest({
        task,
        mode: effectiveMode,
        allowedTools: getAllowedToolsFromEnv() ?? [],
      })
        ? 'COMPLETE_NO_MODIFICATION'
        : 'COMPLETE';
    if (sessionId) {
      logDetail(`Session:  ${sessionId}`);
    }

    if (options.mode) {
      logDetail(`Pipeline mode overridden by CLI flag: ${options.mode}`);
    }
    if (options.modelOverride) {
      logDetail(`Worker model overridden by CLI flag: ${options.modelOverride}`);
    }

    const exactInvariantProjectRoot = inferProjectRoot(manifest) ?? runtimeProjectRoot;
    const finalizeExactInstructionDrift = async (
      plan: SwePlan | null,
      currentToolCallLog: readonly ToolCallLog[] = [],
    ): Promise<PipelineResult | null> => {
      const exactInvariantFailure = evaluateExactInstructionInvariants(
        exactInvariantRegistry,
        exactInvariantProjectRoot,
        currentToolCallLog,
      );
      if (!exactInvariantFailure) {
        return null;
      }
      const invariantStatus =
        resolveCompletionStatusAfterExactInvariantCheck(exactInvariantFailure);
      log(`Pipeline halted — ${invariantStatus}`);
      logDetail(exactInvariantFailure);
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        invariantStatus,
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return await finalizeResult({
        runDir: evidence.runDir,
        manifest,
        plan,
        status: invariantStatus,
        errors: [exactInvariantFailure],
      });
    };

    // ── Swarm Dispatch ────────────────────────────────────────────────────────
    const requestedTargetContractForMode = getRequestedTargetContract(mergedTaskContext);
    if (
      effectiveMode === 'plan' &&
      shouldRefuseWriteRequestForMode(
        effectiveMode,
        requestedTargetContractForMode.requestedTargets.length,
      )
    ) {
      log('Plan mode is read-only — approve the plan first to apply changes.');
      logDetail(
        'Plan mode shows the plan and waits for approval. Use `babel deep` to skip the approval step.',
      );
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'READ_ONLY_MODE_NO_EXECUTOR',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return await finalizeResult({
        runDir: evidence.runDir,
        manifest,
        plan: null,
        status: 'READ_ONLY_MODE_NO_EXECUTOR',
        errors: [
          'Plan mode cannot execute file writes — approve the plan first, or use chat/deep mode.',
        ],
      });
    }

    // Swarm dispatch: triggered by manifest.swarm presence, not by mode.
    // Use babel swarm command for explicit swarm runs.
    if (manifest.swarm) {
      if (requestedTargetContractForMode.requestedTargets.length > 0) {
        log('Stopped — swarm does not support file writes yet. Use `babel deep` instead.');
        logDetail('Or run swarm without file targets.');
        return await finalizeResult({
          runDir: evidence.runDir,
          manifest,
          plan: null,
          status: 'SWARM_NO_EXECUTOR_BOUND',
          errors: ['Swarm dispatch refused: no merger/writeback path for file artifacts.'],
        });
      }
      log('Stage 2-4 / 4 — Parallel swarm dispatch');
      const swarmResult = await runSwarmPipeline(manifest, evidence, options);
      return finalizeResult({
        status: swarmResult.status,
        runDir: evidence.runDir,
        manifest,
        plan: null,
      });
    }

    // ── Stage 0: Surgical Pruning ───────────────────────────────────────────
    let pruningStubs = new Map<string, string>();
    if (effectiveMode !== 'plan' && isContextPruningEnabled()) {
      log('Stage 0 / 4  -  Optimizing context');
      const pruningResult = await analyzeAndPruneContext(
        mergedTaskContext,
        manifest.prompt_manifest,
        evidence,
      );
      pruningStubs = pruningResult.stubs;
      if (pruningStubs.size > 0) {
        logDetail(`✓ Stubbed ${pruningStubs.size} supplementary files to save tokens.`);
      }
    }

    if (effectiveMode === 'plan') {
      log('Stage 2 / 4  —  Exporting the plan');
      const sweTask = buildSweTask(
        manifest,
        mergedTaskContext,
        [],
        undefined,
        '',
        groundingContext,
        executionProfile.name,
      );
      const sweContext = await compileContext(
        manifest.prompt_manifest,
        sweTask,
        inferProjectRoot(manifest),
        pruningStubs,
      );
      evidence.writeManualSwePrompt(sweContext);
      evidence.writeCompiledContext('swe_manual', sweContext);
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'MANUAL_BRIDGE_REQUIRED',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);

      return await finalizeResult({
        runDir: evidence.runDir,
        manifest,
        plan: null,
        status: 'MANUAL_BRIDGE_REQUIRED',
        manualPromptPath: join(evidence.runDir, '02_manual_swe_prompt.md'),
      });
    }

    // ── Chat mode: fast capable coding agent ──────────────────────────────
    if (effectiveMode === 'chat') {
      return await runChatPipeline(
        {
          manifest,
          mergedTaskContext,
          evidence,
          groundingContext,
          executionProfileName: executionProfile.name,
          runtimeProjectRoot,
          pruningStubs,
          taskGrounding,
          v9StackTelemetry,
          effectiveMode,
        },
        finalizeResult,
      );
    }

    // ── Evidence loop state ─────────────────────────────────────────────────────
    // `approvedPlan` is declared outside the while so it is accessible after break.
    let approvedPlan: SwePlan | null = null;
    let evidenceLoopCount = 0;
    let additionalEvidenceContext = '';
    const executionReportWarnings: string[] = [];
    let lastToolCallLog: ToolCallLog[] = [];
    let lastExecutorResult: ExecutorLoopResult | null = null;

    const commandOnlyNoModification =
      effectiveMode === 'deep' ? inferCommandOnlyNoModificationRequest(task) : null;
    const shouldRunCommandOnlyNoModification =
      commandOnlyNoModification !== null &&
      !(isOptionalVerifierRequest(task) && !isShellExecutionToolAvailable());
    if (commandOnlyNoModification && !shouldRunCommandOnlyNoModification) {
      log(
        `Optional command-only verifier "${commandOnlyNoModification}" skipped because shell_exec is unavailable.`,
      );
    }
    if (commandOnlyNoModification && shouldRunCommandOnlyNoModification) {
      log(
        `Command-only no-modification task detected; running "${commandOnlyNoModification}" through shell_exec.`,
      );
      const toolResult = await executeTool(
        {
          tool: 'shell_exec',
          command: commandOnlyNoModification,
          working_directory: '.',
          timeout_seconds: 300,
        },
        {
          agentId: 'executor',
          runId: evidence.runId,
          runDir: evidence.runDir,
          babelRoot: BABEL_ROOT,
        },
      );
      const entry: ToolCallLog = {
        step: 1,
        tool: 'shell_exec',
        target: commandOnlyNoModification,
        exit_code: toolResult.exit_code,
        stdout: toolResult.stdout,
        stderr: toolResult.stderr,
        ...(toolResult.denial ? { denial: toolResult.denial } : {}),
        ...(toolResult.mcp_lifecycle ? { mcp_lifecycle: toolResult.mcp_lifecycle } : {}),
        ...(toolResult.checkpoint_ids ? { checkpoint_ids: toolResult.checkpoint_ids } : {}),
        verified: toolResult.exit_code === 0,
      };
      lastToolCallLog = [entry];
      if (toolResult.exit_code === 0) {
        const report = buildTerminalReport(
          {
            type: 'completion',
            status: 'EXECUTION_COMPLETE',
          },
          lastToolCallLog,
          evidence,
        );
        writeValidatedExecutionReport(evidence, report, lastToolCallLog, executionReportWarnings);
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'COMPLETE_NO_MODIFICATION',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({
          runDir: evidence.runDir,
          manifest,
          plan: null,
          status: 'COMPLETE_NO_MODIFICATION',
        });
      }

      const status = toolResult.denial
        ? 'SHELL_COMMAND_DENIED'
        : isVerifierNotFoundFailure(commandOnlyNoModification, toolResult.stdout, toolResult.stderr)
          ? 'VERIFIER_NOT_FOUND'
          : isVerifierCommand(commandOnlyNoModification)
            ? 'VERIFIER_FAILED'
            : 'SHELL_COMMAND_FAILED';
      const condition = [
        `[${status}] Command-only no-modification task failed.`,
        `Command: ${commandOnlyNoModification}.`,
        `Exit code: ${toolResult.exit_code}.`,
        `stdout: ${summarizeVerifierStreamForEvidence(toolResult.stdout) ?? '(empty)'}.`,
        `stderr: ${summarizeVerifierStreamForEvidence(toolResult.stderr) ?? '(empty)'}.`,
        toolResult.denial
          ? `denial: ${toolResult.denial.category}/${toolResult.denial.reason_code}: ${toolResult.denial.message}.`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      const report = buildHaltReport(lastToolCallLog, 'STEP_VERIFICATION_FAIL', 1, condition);
      writeValidatedExecutionReport(evidence, report, lastToolCallLog, executionReportWarnings);
      v9StackTelemetry = markRuntimeTelemetryOutcome(v9StackTelemetry, status, effectiveMode);
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return await finalizeResult({
        runDir: evidence.runDir,
        manifest,
        plan: null,
        status,
      });
    }

    // ── Outer evidence loop ──────────────────────────────────────────────────────
    // Stages 2 → 3 → 4 repeat when the SWE Agent emits a plan_type=EVIDENCE_REQUEST plan.
    // The loop is hard-capped at MAX_EVIDENCE_LOOPS to prevent infinite context
    // accumulation. On each iteration, gathered evidence is injected back into the
    // Stage 2 prompt so the SWE Agent can produce a concrete implementation plan.
    while (true) {
      // Reset SWE↔QA state for this evidence-loop pass.
      approvedPlan = null;
      let qaRejections: string[] = [];
      let proposedFixStrategy: string | undefined = undefined;
      // Track failure tags across SWE-QA attempts so the Smart Planner can
      // detect repeated rejection patterns and escalate to a stronger model.
      const previousRejectionTags: string[][] = [];

      // ── Stage 2 & 3: SWE Agent → QA Reviewer loop ───────────────────────────
      for (let attempt = 1; attempt <= MAX_SWE_QA_LOOPS; attempt++) {
        // ── Stage 2: SWE Agent ─────────────────────────────────────────────────
        log(
          `Stage 2 / 4  —  Planning` +
            (attempt > 1 ? ` (attempt ${attempt}/${MAX_SWE_QA_LOOPS})` : '') +
            (evidenceLoopCount > 0 ? ` [evidence pass ${evidenceLoopCount}]` : ''),
        );
        options.eventBus?.assistantChunk(
          attempt === 1
            ? '\n  Let me plan the implementation…\n'
            : `\n  Revising plan (attempt ${attempt}/${MAX_SWE_QA_LOOPS})…\n`,
        );

        // prompt_manifest contains ordered absolute path strings — use directly.
        const swePaths = manifest.prompt_manifest;

        const sweTask = buildSweTask(
          manifest,
          mergedTaskContext,
          qaRejections,
          proposedFixStrategy,
          additionalEvidenceContext,
          groundingContext,
          executionProfile.name,
        );
        const sweContext = await compileContext(
          swePaths,
          sweTask,
          inferProjectRoot(manifest),
          pruningStubs,
        );
        evidence.writeCompiledContext(`swe_v${attempt}`, sweContext);

        // ── Smart Planner: assess task difficulty for model selection ────────
        let plannerStartTierIndex: number | undefined;
        let plannerSkipTierNames: string[] | undefined;

        if (SMART_PLANNER_ENABLED) {
          const complexityEstimate = manifest.analysis?.complexity_estimate;
          const plannerDecision = assessPlanningComplexity({
            task: mergedTaskContext,
            ...(complexityEstimate === 'Low' ||
            complexityEstimate === 'Medium' ||
            complexityEstimate === 'High'
              ? { manifestComplexity: complexityEstimate }
              : {}),
            qaRejections,
            previousRejectionTags,
            attempt,
          });

          if (plannerDecision.startTierIndex > 0 || plannerDecision.skipTierKeys.length > 0) {
            plannerStartTierIndex = plannerDecision.startTierIndex;
            plannerSkipTierNames = plannerDecision.skipTierKeys;
            log(
              `  Smart Planner: ${plannerDecision.rationale}` +
                (plannerDecision.escalatedByRepeatedFailure
                  ? ' [REPEATED FAILURE ESCALATION]'
                  : ''),
            );
            // Persist the decision for post-run analysis.
            evidence.writeDebugFile(
              `debug_smart_planner_v${attempt}.json`,
              `${JSON.stringify(plannerDecision, null, 2)}\n`,
            );
          }

          // Apply the recommended reasoning effort for this planning call.
          // The DeepSeek runner reads BABEL_REASONING_EFFORT from the environment.
          // Auto-scaling: "max" effort also increases waterfall timeout by 2x
          // since deeper reasoning takes longer.
          if (plannerDecision.recommendedEffort === 'max') {
            process.env['BABEL_REASONING_EFFORT'] = 'max';
          }
        }

        const swePlanRaw = await runWithFallback(sweContext, SwePlanSchema, {
          evidence,
          stage: 'planning',
          schemaName: 'SwePlanSchema',
          ...(plannerStartTierIndex !== undefined ? { startTierIndex: plannerStartTierIndex } : {}),
          ...(plannerSkipTierNames !== undefined ? { skipTierNames: plannerSkipTierNames } : {}),
        });
        const { plan: normalizedPlan, warnings: planWarnings } = normalizeSwePlan(swePlanRaw);
        const { plan: groundedPlan, warnings: groundingWarnings } =
          normalizePlanTargetsAgainstGrounding(taskGrounding, normalizedPlan);
        const { plan: requestedTargetPlan, warnings: requestedTargetWarnings } =
          normalizePlanTargetsAgainstRequestedOutputs(mergedTaskContext, groundedPlan);
        const swePlan = splitChainedShellSteps(requestedTargetPlan);
        if (
          planWarnings.length > 0 ||
          groundingWarnings.length > 0 ||
          requestedTargetWarnings.length > 0
        ) {
          executionReportWarnings.push(...planWarnings);
          executionReportWarnings.push(...groundingWarnings);
          executionReportWarnings.push(...requestedTargetWarnings);
          planWarnings.forEach((w) => logDetail(`SWE plan warning: ${w}`));
          groundingWarnings.forEach((w) => logDetail(`SWE plan warning: ${w}`));
          requestedTargetWarnings.forEach((w) => logDetail(`SWE plan warning: ${w}`));
        }
        evidence.writeSwePlan(swePlan, attempt);
        await runPluginHooks('PostPlan', {
          runId: evidence.runId,
          runDir: evidence.runDir,
          babelRoot: BABEL_ROOT,
          projectRoot: inferProjectRoot(manifest) ?? sessionStartPath ?? process.cwd(),
          dryRun: DRY_RUN,
          attempt,
          manifest,
          plan: swePlan,
        });
        logDetail(
          `Action steps: ${swePlan.minimal_action_set.length} | ` +
            `plan_type: ${swePlan.plan_type}`,
        );

        // ── Regular/Plan mode: skip QA and CLI ─────────────────────────────────
        if ((effectiveMode as ValidMode) === 'chat' || (effectiveMode as ValidMode) === 'plan') {
          logDetail(`Mode is "${effectiveMode}" — skipping QA Reviewer and CLI Executor.`);
          approvedPlan = swePlan;
          break;
        }

        // ── Phase 2a: Shared deterministic QA reject handler ─────────────────
        const handleQaReject = (reject: QaVerdictReject, label: string): void => {
          evidence.writeQaVerdict(reject, attempt);
          logDetail(
            `QA: REJECT  (${reject.failure_count} failure(s), confidence: ${reject.overall_confidence}/5)`,
          );
          reject.failures.forEach((failure, index) => {
            logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
          });
          qaRejections = reject.failures.map((failure) =>
            failure.fix_hint
              ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
              : `[${failure.tag}] ${failure.condition}`,
          );
          proposedFixStrategy = reject.proposed_fix_strategy;
          v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, reject);
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          pipelineTrace.recordQaVerdict(
            'REJECT',
            reject.failures.map((failure) => failure.tag),
          );
        };

        const planHandoffViolations = collectPlanHandoffViolations(
          swePlan,
          planHandoff?.allowedPaths ?? [],
        );
        if (planHandoffViolations.length > 0) {
          handleQaReject(
            buildPlanHandoffQaReject(planHandoffViolations) as QaVerdictReject,
            'planHandoff',
          );
          continue;
        }

        const groundingViolations = sanitizeGroundingViolationsForAndroidSdkLane(
          collectPlanGroundingViolations(taskContract, taskGrounding, swePlan),
          manifest,
        );
        if (groundingViolations.length > 0) {
          handleQaReject(
            buildGroundingQaReject(groundingViolations) as QaVerdictReject,
            'grounding',
          );
          continue;
        }

        const referenceSourceShapeReject = collectReferenceSourceShapeViolations(swePlan, manifest);
        if (referenceSourceShapeReject) {
          handleQaReject(referenceSourceShapeReject, 'referenceSourceShape');
          continue;
        }

        const executorSafetyReject = collectExecutorSafetyViolations(
          swePlan,
          manifest,
          mergedTaskContext,
          executionProfile.name,
        );
        if (executorSafetyReject) {
          handleQaReject(executorSafetyReject, 'executorSafety');
          continue;
        }

        const runtimePrereqReject = collectRuntimePrerequisiteViolations(
          swePlan,
          javaRuntimeStatus,
          gradleRuntimeStatus,
        );
        if (runtimePrereqReject) {
          handleQaReject(runtimePrereqReject, 'runtimePrereq');
          continue;
        }

        const gradleBootstrapReject = collectGradleBootstrapSequencingViolations(
          swePlan,
          manifest,
          gradleRuntimeStatus,
        );
        if (gradleBootstrapReject) {
          handleQaReject(gradleBootstrapReject, 'gradleBootstrap');
          continue;
        }

        const androidVerificationCoverageReject = collectAndroidVerificationCoverageViolations(
          swePlan,
          manifest,
          task,
        );
        if (androidVerificationCoverageReject) {
          handleQaReject(androidVerificationCoverageReject, 'androidVerificationCoverage');
          continue;
        }

        // ── Stage 3: QA Reviewer ───────────────────────────────────────────────
        log(
          `Stage 3 / 4  —  Reviewing` +
            (attempt > 1 ? ` (attempt ${attempt}/${MAX_SWE_QA_LOOPS})` : ''),
        );
        options.eventBus?.assistantChunk(
          attempt === 1
            ? '\n  Reviewing the plan for correctness and safety…\n'
            : `\n  Re-reviewing (attempt ${attempt}/${MAX_SWE_QA_LOOPS})…\n`,
        );

        const deterministicGradleBootstrapLaneActive = shouldUseDeterministicGradleBootstrapLane(
          inferProjectRoot(manifest),
        );
        const qaContext = await compileContext(
          abs(QA_PATHS),
          buildQaTask(
            swePlan,
            javaRuntimeStatus,
            gradleRuntimeStatus,
            detectAndroidSdkStatus(),
            mergedTaskContext,
            deterministicGradleBootstrapLaneActive,
            executionProfile.name,
          ),
          inferProjectRoot(manifest),
        );
        evidence.writeCompiledContext(`qa_v${attempt}`, qaContext);

        const qaSpan = pipelineTrace.startChildSpan('babel.qa', {
          'babel.qa.attempt': attempt,
          'babel.pipeline.mode': effectiveMode,
        });
        let verdict: z.infer<typeof QaVerdictSchema>;
        try {
          verdict = await runWithFallback(qaContext, QaVerdictSchema, {
            evidence,
            stage: 'qa',
            schemaName: 'QaVerdictSchema',
          });
          verdict = sanitizeQaVerdictForDeterministicGradleBootstrapLane(
            verdict,
            swePlan,
            manifest,
          );
          verdict = sanitizeWindowsGradlewPermissionQaVerdict(verdict, swePlan);
          verdict = sanitizeExistingWrapperQaVerdict(verdict, swePlan, manifest);
        } catch (error) {
          endSpan(qaSpan, SpanStatusCode.ERROR, {}, error);
          log(
            `[pipeline] QA model invocation error on attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        evidence.writeQaVerdict(verdict, attempt);

        if (verdict.verdict === 'PASS') {
          logDetail(`QA: PASS  (confidence: ${verdict.overall_confidence}/5)`);
          v9StackTelemetry = markRuntimeTelemetryQaPass(v9StackTelemetry);
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          pipelineTrace.recordQaVerdict('PASS', []);
          endSpan(qaSpan, SpanStatusCode.OK, {
            'babel.qa.verdict': 'PASS',
            'babel.qa.failure_count': 0,
            'babel.qa.confidence': verdict.overall_confidence,
            'babel.evidence_gate.status': 'satisfied',
          });

          // ── Adversarial QA Review (Phase 4C) ────────────────────────────────
          const advGateResult = await runAdversarialQaGate(
            swePlan,
            verdict,
            mergedTaskContext,
            attempt,
            evidence.runDir,
            logDetail,
          );

          if (!advGateResult.passed) {
            qaRejections = advGateResult.qaRejections!;
            // Accumulate rejection tags for Smart Planner repeated-failure detection.
            if (SMART_PLANNER_ENABLED) {
              previousRejectionTags.push((advGateResult.allFailures ?? []).map((f) => f.tag));
            }
            proposedFixStrategy = advGateResult.proposedFixStrategy;
            v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, {
              verdict: 'REJECT',
              failure_count: advGateResult.allFailures!.length,
              overall_confidence: 5,
              failures: advGateResult.allFailures!,
              proposed_fix_strategy:
                'Adversarial review found plan issues. Review the failure tags and regenerate the plan.',
            } satisfies QaVerdictReject);
            writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
            pipelineTrace.recordQaVerdict(
              'REJECT',
              advGateResult.allFailures!.map((f) => f.tag),
            );

            if (attempt === MAX_SWE_QA_LOOPS) {
              log(`Adversarial QA rejected after ${MAX_SWE_QA_LOOPS} attempts. Pipeline halted.`);
              const driftResult = await finalizeExactInstructionDrift(null, lastToolCallLog);
              if (driftResult) return driftResult;
              v9StackTelemetry = markRuntimeTelemetryOutcome(
                v9StackTelemetry,
                'QA_REJECTED_MAX_LOOPS',
                effectiveMode,
              );
              writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
              return await finalizeResult({
                runDir: evidence.runDir,
                manifest,
                plan: null,
                status: 'QA_REJECTED_MAX_LOOPS',
              });
            }
            logDetail(`Looping back to SWE Agent with adversarial feedback...`);
            continue;
          }

          approvedPlan = swePlan;
          break;
        }

        // ── QA rejected — collect failures and loop ────────────────────────────
        // Phase 2e: Replace `as QaVerdictReject` casts with a runtime-checked
        // assertion. The PASS branch above always exits (break/continue/return),
        // so at runtime verdict.verdict is guaranteed to be 'REJECT'. TypeScript
        // narrows to `never` because it tracks all exits as dead code, so the
        // cast through `unknown` is required.
        const v = verdict as unknown as { verdict: string };
        if (v.verdict !== 'REJECT') {
          throw new Error(`Invariant violation: expected REJECT verdict, got "${v.verdict}"`);
        }
        const rejVerdict = verdict as unknown as QaVerdictReject;

        logDetail(
          `QA: REJECT  (${rejVerdict.failure_count} failure(s), ` +
            `confidence: ${rejVerdict.overall_confidence}/5)`,
        );

        rejVerdict.failures.forEach((f, i) => {
          logDetail(`  ${i + 1}. [${f.tag}]  ${f.condition}`);
        });

        qaRejections = rejVerdict.failures.map((f) =>
          f.fix_hint
            ? `[${f.tag}] ${f.condition} (hint: ${f.fix_hint})`
            : `[${f.tag}] ${f.condition}`,
        );
        // Accumulate rejection tags for Smart Planner repeated-failure detection.
        if (SMART_PLANNER_ENABLED) {
          previousRejectionTags.push(rejVerdict.failures.map((f) => f.tag));
        }
        proposedFixStrategy = rejVerdict.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, rejVerdict);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict(
          'REJECT',
          rejVerdict.failures.map((failure) => failure.tag),
        );
        endSpan(qaSpan, SpanStatusCode.OK, {
          'babel.qa.verdict': 'REJECT',
          'babel.qa.failure_count': rejVerdict.failure_count,
          'babel.qa.failure_tags_hash':
            rejVerdict.failures.length > 0
              ? rejVerdict.failures.map((failure) => failure.tag).join(',')
              : undefined,
          'babel.qa.confidence': rejVerdict.overall_confidence,
          'babel.evidence_gate.status': rejVerdict.failures.some(
            (failure) => failure.tag === 'EVIDENCE-GATE',
          )
            ? 'violated'
            : 'unknown',
        });

        if (attempt === MAX_SWE_QA_LOOPS) {
          log(`Plan didn't pass review after ${MAX_SWE_QA_LOOPS} attempts. Stopping.`);
          log(`See ${evidence.runDir} for details.`);
          const driftResult = await finalizeExactInstructionDrift(null, lastToolCallLog);
          if (driftResult) {
            return driftResult;
          }
          v9StackTelemetry = markRuntimeTelemetryOutcome(
            v9StackTelemetry,
            'QA_REJECTED_MAX_LOOPS',
            effectiveMode,
          );
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: null,
            status: 'QA_REJECTED_MAX_LOOPS',
          });
        }

        logDetail(`Looping back to SWE Agent with rejection feedback...`);
      }

      // ── Pre-executor bounded-contract activation gate ─────────────────────────
      // `collectBoundedContractViolations` already enforces the bounded target set
      // inside the SWE↔QA retry loop. This gate is the final hard assertion: it
      // prevents executor activation if the approved plan's file_write targets do
      // not exactly match the requested bounded set, regardless of how that state
      // was reached. Belt-and-suspenders — should never fire if the in-loop check
      // is working, but guarantees the executor never starts on a drifted plan.
      if (approvedPlan !== null && effectiveMode === 'deep') {
        const boundedActivationReject = assertBoundedPlanActivationContract(
          approvedPlan,
          mergedTaskContext,
        );
        if (boundedActivationReject) {
          log(`  Executor: ACTIVATION_REFUSED [ACTIVATION_GATE_FAIL]`);
          logDetail(boundedActivationReject);
          writeValidatedExecutionReport(
            evidence,
            {
              status: 'ACTIVATION_REFUSED',
              reason: boundedActivationReject,
              gate: 'ACTIVATION_GATE_FAIL' satisfies HaltTag,
            },
            [],
            [...executionReportWarnings, boundedActivationReject],
          );
          v9StackTelemetry = markRuntimeTelemetryOutcome(
            v9StackTelemetry,
            'EXECUTOR_HALTED',
            effectiveMode,
          );
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: approvedPlan,
            status: 'EXECUTOR_HALTED',
          });
        }
      }

      // ── Stage 4: CLI Executor ─────────────────────────────────────────────────

      if (effectiveMode === 'deep' && approvedPlan !== null) {
        const preChecklistInjection = injectVerificationStepsIntoPlan(
          approvedPlan,
          mergedTaskContext,
          inferProjectRoot(manifest) ?? runtimeProjectRoot,
        );
        if (preChecklistInjection.injected) {
          approvedPlan = preChecklistInjection.plan;
          evidence.writeDebugFile(
            'verifier_auto_injected.json',
            `${JSON.stringify(
              {
                schema_version: 1,
                artifact_type: 'babel_verifier_auto_injection',
                injected: true,
                phase: 'pre_checklist',
                commands: preChecklistInjection.commands,
                step_count: approvedPlan.minimal_action_set.length,
              },
              null,
              2,
            )}\n`,
          );
          logDetail(`[VERIFIER_AUTO_INJECTED] ${preChecklistInjection.commands.join(' && ')}`);
        }
        const autoApproveReadOnlyEvidence = isReadOnlyEvidenceRequestPlan(approvedPlan);
        const checklistWillPrompt =
          !autoApproveReadOnlyEvidence &&
          process.stdout.isTTY === true &&
          process.env['BABEL_PIPELINE_V9_OFFLINE'] !== '1';
        if (autoApproveReadOnlyEvidence) {
          log('Read-only — approved automatically.');
        }
        if (checklistWillPrompt) {
          options.eventBus?.promptPause('Waiting for plan approval');
        }
        const selectedSteps = autoApproveReadOnlyEvidence
          ? approvedPlan.minimal_action_set
          : await renderInteractiveChecklist(approvedPlan.minimal_action_set);
        if (checklistWillPrompt) {
          options.eventBus?.promptResume();
        }
        if (selectedSteps === null) {
          log(`Review cancelled.`);
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: approvedPlan,
            status: 'EXECUTOR_HALTED',
          });
        }
        if (selectedSteps.length === 0) {
          const driftResult = await finalizeExactInstructionDrift(approvedPlan);
          if (driftResult) {
            return driftResult;
          }
          // Check verifier contract: if verifiers were expected but user declined all steps,
          // signal contract unsatisfied rather than reporting COMPLETE.
          if (hasImplementationVerificationStrategy(approvedPlan)) {
            log(`No steps selected but checks are required — not complete.`);
            return await finalizeResult({
              runDir: evidence.runDir,
              manifest,
              plan: approvedPlan,
              status: 'VERIFIER_CONTRACT_UNSATISFIED',
            });
          }
          log(`No steps selected. Done.`);
          v9StackTelemetry = markRuntimeTelemetryOutcome(
            v9StackTelemetry,
            'COMPLETE',
            effectiveMode,
          );
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: approvedPlan,
            status: completeStatusForCurrentTask(),
          });
        }
        // Update plan and promote to autonomous for execution
        approvedPlan.minimal_action_set = selectedSteps;
        effectiveMode = 'deep';

        // Re-run the bounded-contract activation gate now that mode has escalated.
        // The gate originally ran at the top of the pre-executor block (line ~6760)
        // when effectiveMode was still 'plan' (so it was a no-op). The
        // user-modified plan must be re-validated before the executor activates.
        const postEscalationBoundedReject = assertBoundedPlanActivationContract(
          approvedPlan,
          mergedTaskContext,
        );
        if (postEscalationBoundedReject) {
          log(`  Executor: ACTIVATION_REFUSED [ACTIVATION_GATE_FAIL] (post-escalation)`);
          logDetail(postEscalationBoundedReject);
          writeValidatedExecutionReport(
            evidence,
            {
              status: 'ACTIVATION_REFUSED',
              reason: postEscalationBoundedReject,
              gate: 'ACTIVATION_GATE_FAIL' satisfies HaltTag,
            },
            [],
            [...executionReportWarnings, postEscalationBoundedReject],
          );
          v9StackTelemetry = markRuntimeTelemetryOutcome(
            v9StackTelemetry,
            'EXECUTOR_HALTED',
            effectiveMode,
          );
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: approvedPlan,
            status: 'EXECUTOR_HALTED',
          });
        }
      }

      if (shouldHaltWithoutApprovedPlan(effectiveMode, approvedPlan)) {
        log(`QA rejected ${MAX_SWE_QA_LOOPS} plans. Pipeline halted.`);
        log(`See ${evidence.runDir} for details.`);
        const driftResult = await finalizeExactInstructionDrift(approvedPlan, lastToolCallLog);
        if (driftResult) {
          return driftResult;
        }
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'QA_REJECTED_MAX_LOOPS',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({
          runDir: evidence.runDir,
          manifest,
          plan: null,
          status: 'QA_REJECTED_MAX_LOOPS',
        });
      }

      if (effectiveMode !== 'deep' || approvedPlan === null) {
        log('Done — plan is ready for review.');
        log(`Run data: ${evidence.runDir}`);
        const driftResult = await finalizeExactInstructionDrift(approvedPlan);
        if (driftResult) {
          return driftResult;
        }
        v9StackTelemetry = markRuntimeTelemetryOutcome(v9StackTelemetry, 'COMPLETE', effectiveMode);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({
          runDir: evidence.runDir,
          manifest,
          plan: approvedPlan,
          status: completeStatusForCurrentTask(),
        });
      }

      const preExecutorResult = await runPreExecutorSafetyGates({
        approvedPlan,
        projectRoot: inferProjectRoot(manifest) ?? runtimeProjectRoot,
        taskContext: mergedTaskContext,
        intentContract: originalIntentContract,
        babelRoot: BABEL_ROOT,
      });

      if (!preExecutorResult.ok) {
        log(`  Executor: ACTIVATION_REFUSED [${preExecutorResult.gate}]`);
        logDetail(preExecutorResult.reason);
        writeValidatedExecutionReport(
          evidence,
          {
            status: 'ACTIVATION_REFUSED',
            reason: preExecutorResult.reason,
            gate: preExecutorResult.gate as HaltTag,
          },
          [],
          [...executionReportWarnings, preExecutorResult.reason],
        );
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'EXECUTOR_HALTED',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({
          runDir: evidence.runDir,
          manifest,
          plan: approvedPlan,
          status: 'EXECUTOR_HALTED',
          ...(preExecutorResult.errors ? { errors: preExecutorResult.errors } : {}),
        });
      }

      approvedPlan = preExecutorResult.approvedPlan;

      log('Stage 4 / 4  —  Applying changes');
      options.eventBus?.assistantChunk('\n  Applying changes…\n');
      // This span records the QA gate clearance and activation decision only —
      // it is intentionally closed before the executor loop runs. Individual
      // executor tool calls are captured in the evidence bundle (05_execution_log.json),
      // not in OTel spans, to prevent raw command strings from entering the trace backend.
      const executorActivationSpan = pipelineTrace.startChildSpan('babel.executor.activation', {
        'babel.executor.status': 'activated',
        'babel.executor.mode': effectiveMode,
        'babel.executor.plan_type': approvedPlan.plan_type,
        'babel.executor.step_count': approvedPlan.minimal_action_set.length,
      });
      endSpan(executorActivationSpan, SpanStatusCode.OK);

      let toolCallLog: ToolCallLog[];
      const initialExecutorLog: ToolCallLog[] = [];
      try {
        const stagedResult = await runStagedExecutor({
          approvedPlan,
          evidence,
          targetModel: effectiveModel,
          manifest,
          rawTask: mergedTaskContext,
          reportWarnings: executionReportWarnings,
          initialExecutorLog,
          pruningStubs,
        });

        if (!stagedResult.ok) {
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: approvedPlan,
            status: 'EXECUTOR_HALTED',
          });
        }

        const executorResult = stagedResult.executorResult;
        toolCallLog = executorResult.toolCallLog;
        lastToolCallLog = toolCallLog;
        lastExecutorResult = executorResult;
        if (executorResult.terminalStatus !== 'EXECUTION_COMPLETE') {
          log(
            `Pipeline halted after executor terminal status ${executorResult.terminalStatus}. ` +
              `Run data: ${evidence.runDir}`,
          );
          v9StackTelemetry = markRuntimeTelemetryOutcome(
            v9StackTelemetry,
            'EXECUTOR_HALTED',
            effectiveMode,
          );
          v9StackTelemetry = mergeExecutorJitTelemetry(v9StackTelemetry, executorResult);
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          const haltCondition = executorResult.condition ?? '';
          const { haltedStatus, matchedConditions } = resolveExecutorHaltStatus(
            haltCondition,
            executorResult.haltTag,
          );
          if (matchedConditions.length > 1) {
            log(`[MULTIPLE_HALT_CONDITIONS] ${matchedConditions.join(', ')}`);
          }
          if (haltedStatus === 'EXECUTOR_HALTED') {
            const driftResult = await finalizeExactInstructionDrift(approvedPlan, toolCallLog);
            if (driftResult) {
              return driftResult;
            }
          }
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: approvedPlan,
            status: haltedStatus,
          });
        }
      } catch (err) {
        log(`CLI Executor error: ${err instanceof Error ? err.message : String(err)}`);
        const driftResult = await finalizeExactInstructionDrift(approvedPlan, lastToolCallLog);
        if (driftResult) {
          return driftResult;
        }
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'EXECUTOR_HALTED',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({
          runDir: evidence.runDir,
          manifest,
          plan: approvedPlan,
          status: 'EXECUTOR_HALTED',
        });
      }

      // ── Evidence loop evaluation ──────────────────────────────────────────────
      // If the approved plan was an evidence-gathering pass, rebound to Stage 2
      // with the collected results injected into the next SWE Agent prompt.
      if (approvedPlan.plan_type === 'EVIDENCE_REQUEST') {
        evidenceLoopCount++;
        additionalEvidenceContext += formatExecutionResults(toolCallLog, evidenceLoopCount);

        if (
          !originalIntentContract.mutation_allowed &&
          originalIntentContract.task_kind !== 'implementation'
        ) {
          const reportFinalizer = buildEvidenceReportFinalizerArtifact({
            task: mergedTaskContext,
            toolCallLog,
            intent: originalIntentContract,
            runDir: evidence.runDir,
          });
          evidence.writeDebugFile(
            'report_finalizer.json',
            `${JSON.stringify(reportFinalizer, null, 2)}\n`,
          );
          log('Nothing more to learn — wrapping up.');
          v9StackTelemetry = markRuntimeTelemetryOutcome(
            v9StackTelemetry,
            'READ_ONLY_NO_MODIFICATION',
            effectiveMode,
          );
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: approvedPlan,
            status: 'READ_ONLY_NO_MODIFICATION',
            finalAnswer: reportFinalizer.answer,
          });
        }

        if (evidenceLoopCount >= MAX_EVIDENCE_LOOPS) {
          log(`Gathered enough context after ${MAX_EVIDENCE_LOOPS} rounds — stopping.`);
          log(`See ${evidence.runDir} for details.`);
          v9StackTelemetry = markRuntimeTelemetryOutcome(
            v9StackTelemetry,
            'EVIDENCE_LOOP_EXCEEDED',
            effectiveMode,
          );
          writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
          return await finalizeResult({
            runDir: evidence.runDir,
            manifest,
            plan: approvedPlan,
            status: 'EVIDENCE_LOOP_EXCEEDED',
          });
        }

        log(
          `Learning more, then re-planning ` +
            `(Loop ${evidenceLoopCount}/${MAX_EVIDENCE_LOOPS})...`,
        );
        continue; // outer while — back to Stage 2 with enriched context
      }

      // Standard (non-evidence) implementation plan — pipeline complete.
      break;
    }

    log(`Done — run data saved to ${evidence.runDir}`);
    const driftResult = await finalizeExactInstructionDrift(approvedPlan, lastToolCallLog);
    if (driftResult) {
      return driftResult;
    }
    v9StackTelemetry = markRuntimeTelemetryOutcome(v9StackTelemetry, 'COMPLETE', effectiveMode);
    if (lastExecutorResult) {
      v9StackTelemetry = mergeExecutorJitTelemetry(v9StackTelemetry, lastExecutorResult);
    }
    writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
    return await finalizeResult({
      runDir: evidence.runDir,
      manifest,
      plan: approvedPlan,
      status: completeStatusForCurrentTask(),
    });
  } catch (error) {
    return await finalizeError(error);
  } finally {
    // The preflight indexing promise is fire-and-forget — if it's still running
    // or rejected, swallow it so it doesn't leave a dangling background task.
    preflightPromise.catch(() => {});
  }
}

// ── Shared Stage 4 executor preparation (R2.1) ────────────────────────────────

interface StagedExecutorOptions {
  approvedPlan: SwePlan;
  evidence: EvidenceBundle;
  targetModel: TargetModel;
  manifest: OrchestratorManifest;
  rawTask: string;
  reportWarnings: string[];
  initialExecutorLog: ToolCallLog[];
  pruningStubs?: Map<string, string>;
}

interface StagedExecutorHalt {
  ok: false;
}

interface StagedExecutorSuccess {
  ok: true;
  executorResult: ExecutorLoopResult;
}

type StagedExecutorResult = StagedExecutorHalt | StagedExecutorSuccess;

/**
 * Shared Stage 4 executor preparation + execution: scaffold seed, deterministic
 * bootstrap lanes, and the executor loop itself. Extracted from the duplicated
 * blocks in `_runBabelPipelineInternal` and `resumeManualBridge` (R2.1).
 *
 * Bootstrap halts are handled internally (writeValidatedExecutionReport + log)
 * and surfaced as `{ ok: false }`. Executor-loop exceptions propagate to the
 * caller so each path can apply its own telemetry and finalization.
 *
 * Callers handle finalization differently (telemetry, result shapes) — this
 * function returns a structured result and leaves finalization to the caller.
 */
async function runStagedExecutor(
  opts: StagedExecutorOptions,
): Promise<StagedExecutorResult> {
  const {
    approvedPlan,
    evidence,
    targetModel,
    manifest,
    rawTask,
    reportWarnings,
    initialExecutorLog,
    pruningStubs,
  } = opts;

  const scaffoldSeed = seedGodotMobileScaffold({
    rawTask: manifest.handoff_payload.user_request,
    projectRoot: getExecutorProjectRoot() ?? inferProjectRoot(manifest) ?? null,
    toolCallLog: initialExecutorLog,
    babelRoot: BABEL_ROOT,
  });
  evidence.writeDebugFile(
    '09_scaffold_seed.json',
    `${JSON.stringify(scaffoldSeed, null, 2)}\n`,
  );
  if (scaffoldSeed.status === 'SEEDED') {
    logDetail(
      `Deterministic Godot scaffold seed copied ${scaffoldSeed.filesCopied.length} file(s).`,
    );
  }

  if (shouldUseDeterministicAndroidSdkBootstrapLane(inferProjectRoot(manifest))) {
    logDetail('Deterministic Android SDK bootstrap lane activated.');
    const androidSdkBootstrapResult = await runDeterministicAndroidSdkBootstrapLane(manifest);
    initialExecutorLog.push(...androidSdkBootstrapResult.toolCallLog);
    if (androidSdkBootstrapResult.haltedReport) {
      writeValidatedExecutionReport(
        evidence,
        androidSdkBootstrapResult.haltedReport,
        initialExecutorLog,
        reportWarnings,
      );
      log(
        '  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during deterministic Android SDK bootstrap lane',
      );
      return { ok: false };
    }
  }

  if (shouldUseDeterministicGradleBootstrapLane(inferProjectRoot(manifest))) {
    logDetail('Deterministic Gradle bootstrap lane activated.');
    const bootstrapResult = await runDeterministicGradleBootstrapLane(manifest, evidence);
    initialExecutorLog.push(...bootstrapResult.toolCallLog);
    if (bootstrapResult.haltedReport) {
      writeValidatedExecutionReport(
        evidence,
        bootstrapResult.haltedReport,
        initialExecutorLog,
        reportWarnings,
      );
      log(
        '  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during deterministic Gradle bootstrap lane',
      );
      return { ok: false };
    }
  }

  const executorResult = await runExecutorLoop(
    approvedPlan,
    evidence,
    targetModel,
    reportWarnings,
    initialExecutorLog,
    rawTask,
    pruningStubs,
  );

  return { ok: true, executorResult };
}

/**
 * Resume a pipeline run from a previously-computed Orchestrator manifest.
 *
 * R2.1 note: Stage 4 executor preparation (scaffold seed, bootstrap lanes,
 * executor loop) is now shared via `runStagedExecutor()`. Stage 2 (SWE) and
 * Stage 3 (QA) remain separate by design — the main path has a retry loop
 * with QA feedback, while this resume path is single-shot with manual plan
 * input. The pre-executor safety gates (`runPreExecutorSafetyGates`) are
 * already factored out and called from each path independently.
 */
export async function resumeManualBridge(
  runDir: string,
  planInput: string | { planPath?: string; rawPlanText?: string },
): Promise<PipelineResult> {
  globalCostTracker.resetSession();
  const manifestPath = join(runDir, '01_manifest.json');
  const manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  const manifest = OrchestratorManifestSchema.parse(manifestRaw);
  configureToolProjectRoot(manifest);

  let rawPlanText: string;
  if (typeof planInput === 'string') {
    rawPlanText = readFileSync(planInput, 'utf-8');
  } else if (planInput.rawPlanText !== undefined) {
    rawPlanText = planInput.rawPlanText;
  } else if (planInput.planPath) {
    rawPlanText = readFileSync(planInput.planPath, 'utf-8');
  } else {
    throw new Error('resumeManualBridge requires planPath or rawPlanText.');
  }
  let planJson: unknown;
  const sanitizedPlanText = rawPlanText.replace(/^\uFEFF/, '').trim();
  try {
    planJson = JSON.parse(sanitizedPlanText);
  } catch (err) {
    const errors = [
      `plan.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    ];
    const evidence = EvidenceBundle.fromExistingRun(runDir);
    evidence.writeManualPlanRepair(buildManualPlanRepairPrompt(errors, sanitizedPlanText));
    return {
      runDir,
      manifest,
      plan: null,
      status: 'MANUAL_PLAN_INVALID',
      repairPromptPath: join(runDir, '02_manual_plan_repair.md'),
      errors,
    };
  }

  const parsedPlan = SwePlanSchema.safeParse(planJson);
  if (!parsedPlan.success) {
    const errors = formatZodErrors(parsedPlan.error);
    const evidence = EvidenceBundle.fromExistingRun(runDir);
    evidence.writeManualPlanRepair(buildManualPlanRepairPrompt(errors, sanitizedPlanText));
    return {
      runDir,
      manifest,
      plan: null,
      status: 'MANUAL_PLAN_INVALID',
      repairPromptPath: join(runDir, '02_manual_plan_repair.md'),
      errors,
    };
  }

  const { plan: swePlan, warnings: planWarnings } = normalizeSwePlan(parsedPlan.data);
  const evidence = EvidenceBundle.fromExistingRun(runDir);
  const canonicalPlan = `${JSON.stringify(swePlan, null, 2)}\n`;
  const manualDir = join(runDir, 'manual');
  mkdirSync(manualDir, { recursive: true });
  writeFileSync(join(manualDir, 'plan.json'), canonicalPlan, 'utf-8');
  writeFileSync(join(runDir, '02_swe_plan_v1.json'), canonicalPlan, 'utf-8');

  const targetModel = manifest.worker_configuration.assigned_model as TargetModel;
  log('Stage 3 / 4  —  Reviewing (resume)');
  const qaContext = await compileContext(
    abs(QA_PATHS),
    buildQaTask(
      swePlan,
      detectJavaRuntimeStatus(),
      detectCommandOnPath('gradle'),
      detectAndroidSdkStatus(),
      manifest.handoff_payload.user_request,
      shouldUseDeterministicGradleBootstrapLane(inferProjectRoot(manifest)),
    ),
    inferProjectRoot(manifest),
  );
  evidence.writeCompiledContext('qa_v1', qaContext);

  const verdict = sanitizeQaVerdictForDeterministicGradleBootstrapLane(
    await runWithFallback(qaContext, QaVerdictSchema, {
      evidence,
      stage: 'qa',
      schemaName: 'QaVerdictSchema',
    }),
    swePlan,
    manifest,
  );
  const sanitizedVerdict = sanitizeWindowsGradlewPermissionQaVerdict(verdict, swePlan);
  const normalizedVerdict = sanitizeExistingWrapperQaVerdict(sanitizedVerdict, swePlan, manifest);
  evidence.writeQaVerdict(normalizedVerdict, 1);

  if (normalizedVerdict.verdict !== 'PASS') {
    log(`QA rejected the resumed manual plan. Pipeline halted at Stage 3.`);
    return {
      runDir,
      manifest,
      plan: null,
      status: 'QA_REJECTED_MAX_LOOPS',
    };
  }

  log('Stage 4 / 4  —  Applying changes');
  const executionReportWarnings: string[] = [];
  const initialExecutorLog: ToolCallLog[] = [];

  // ── Pre-executor safety gates (shared with primary pipeline path) ─────
  const bridgePreExecutorResult = await runPreExecutorSafetyGates({
    approvedPlan: swePlan,
    projectRoot: inferProjectRoot(manifest) ?? process.cwd(),
    taskContext: manifest.handoff_payload.user_request,
    intentContract: inferIntentContract(manifest.handoff_payload.user_request),
    babelRoot: BABEL_ROOT,
  });

  if (!bridgePreExecutorResult.ok) {
    log(`  Executor: ACTIVATION_REFUSED [${bridgePreExecutorResult.gate}] (manual bridge)`);
    logDetail(bridgePreExecutorResult.reason);
    writeValidatedExecutionReport(
      evidence,
      {
        status: 'ACTIVATION_REFUSED',
        reason: bridgePreExecutorResult.reason,
        gate: bridgePreExecutorResult.gate as HaltTag,
        errors: bridgePreExecutorResult.errors,
      },
      initialExecutorLog,
      [bridgePreExecutorResult.reason],
    );
    return {
      runDir,
      manifest,
      plan: swePlan,
      status: 'EXECUTOR_HALTED',
    };
  }

  // Use the plan returned by the gates (may have verifier-injected steps).
  const bridgeApprovedPlan = bridgePreExecutorResult.approvedPlan;

  try {
    const stagedResult = await runStagedExecutor({
      approvedPlan: bridgeApprovedPlan,
      evidence,
      targetModel,
      manifest,
      rawTask: manifest.handoff_payload.user_request,
      reportWarnings: planWarnings,
      initialExecutorLog,
    });

    if (!stagedResult.ok) {
      return {
        runDir,
        manifest,
        plan: swePlan,
        status: 'EXECUTOR_HALTED',
      };
    }

    if (stagedResult.executorResult.terminalStatus !== 'EXECUTION_COMPLETE') {
      return {
        runDir,
        manifest,
        plan: swePlan,
        status: 'EXECUTOR_HALTED',
      };
    }
  } catch (err) {
    log(`CLI Executor error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      runDir,
      manifest,
      plan: swePlan,
      status: 'EXECUTOR_HALTED',
    };
  }

  return {
    runDir,
    manifest,
    plan: swePlan,
    status: 'COMPLETE',
    usageSummary: globalCostTracker.getSessionSummary(),
  };
}
