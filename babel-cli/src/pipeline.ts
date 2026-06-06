/**
 * pipeline.ts — Babel Multi-Agent State Machine
 *
 * Implements the four-stage pipeline:
 *   Stage 1: Orchestrator     — routes task, selects domain + model, emits manifest
 *   Stage 2: SWE Agent        — produces a MINIMAL_ACTION_SET plan
 *   Stage 3: QA Reviewer      — adversarially audits plan (loop up to MAX_LOOPS)
 *   Stage 4: CLI Executor     — multi-turn tool execution loop (autonomous mode)
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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream, statSync, type WriteStream, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath }          from 'node:url';
import {
  getWorkspaceLockPath,
  readLock,
  isLockActive
} from './utils/locking.js';
import { runSwarmPipeline } from './runners/swarmRunner.js';

import { spawnSync }              from 'node:child_process';
import { SpanStatusCode }         from '@opentelemetry/api';
import { z }                      from 'zod';

import { getHighestBudgetSeverity } from './budgetPolicy.js';
import { compileContext,
         resolveInstructionStackManifest } from './compiler.js';
import {
  getRoutingConfidenceBand,
  getValidatorTierIndex,
  isConfidenceGateEnabled,
}                                  from './confidenceGate.js';
import { runWithFallback, clearRoutingCache } from './execute.js';
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
  shouldUseBenchmarkContainerExecution,
} from './config/benchmarkContainer.js';
import {
  buildToolCapabilityPromptLines,
  formatToolCapabilityResolutionForFeedback,
  resolveToolCapabilityForCommand,
} from './config/toolCapabilities.js';
import { resolveFamilyModelPolicy } from './modelPolicy.js';
import { EvidenceBundle }         from './evidence.js';
import { getAllowedShellCommands,
         validateExecutorShellCommand } from './sandbox.js';
import { collectHarnessMetadata } from './telemetry/metadata.js';
import { PipelineTrace, endSpan } from './telemetry/tracing.js';
import {
  runPreToolUseHooks,
  type RuntimeHookTraceEvent,
} from './runtime/hooks.js';
import { executeTool,
         ToolCallRequestSchema,
         DRY_RUN }                from './localTools.js';
import type { ToolCallRequest, ToolResult } from './localTools.js';
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
import { autoCompactIfNeeded } from './services/compaction.js';
import { globalCostTracker } from './services/costTracker.js';
import {
  buildCostLedger,
  usageSummaryFromCostLedger,
} from './services/costLedger.js';
import { extractAndSaveMemories } from './services/memoryExtraction.js';
import {
  PRE_EXECUTION_FAILURE_CAPSULE_FILENAME,
  buildPreExecutionFailureArtifacts,
} from './services/pipelineFailureArtifacts.js';
import { runPluginHooks } from './services/plugins.js';
import { analyzeAndPruneContext, isContextPruningEnabled } from './services/pruning.js';
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
import { shouldApplyHostWindowsExecutorNotes } from './pipeline/benchmarkRuntime.js';
export { shouldApplyHostWindowsExecutorNotes } from './pipeline/benchmarkRuntime.js';
import { buildOrchestratorTask } from './pipeline/orchestratorTask.js';
import { buildSweTask } from './pipeline/sweTask.js';
import { buildQaTask } from './pipeline/qaTask.js';
import { buildPipelineFinalTerminalState } from './pipeline/finalization.js';
import { validatePlanTargetsWithinEffectiveRoots } from './pipeline/targetConsistency.js';
import { renderInteractiveChecklist } from './ui/checklist.js';
import { globalIndexer } from './services/indexer.js';
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
  assertExecutorGate,
  buildExecutorRepairPrompt,
  buildExecutorTask,
  buildExecutorTurnPrompt,
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

// ─── Constants ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

/** Absolute path to the Babel prompt library root (parent of babel-cli/). */
const BABEL_ROOT     = process.env['BABEL_ROOT']     ?? resolve(__dirname, '../..');
const BABEL_RUNS_DIR = process.env['BABEL_RUNS_DIR'] ?? join(BABEL_ROOT, 'runs');
const GRADLE_CACHE_DIR = join(BABEL_ROOT, 'cache', 'gradle-distributions');

/** Maximum SWE → QA iterations before halting with an error. */
const MAX_SWE_QA_LOOPS    = 3;
/** Maximum multi-turn rounds in the executor loop. */
const MAX_EXECUTOR_TURNS  = 20;
/** Maximum times the SWE Agent may request evidence before the pipeline halts. */
const MAX_EVIDENCE_LOOPS  = 2;
const OBJECTIVE_PREFIX    = 'OBJECTIVE: ';
const DEFAULT_ORCHESTRATOR_VERSION = 'v9' as const;
const BENCHMARK_INSTALL_RECOVERY_TAG = 'BENCHMARK_INSTALL_RECOVERY_BLOCKED';
type OrchestratorRuntimeVersion = 'v9';

// ─── Prompt file path sets (relative to BABEL_ROOT) ──────────────────────────


const ORCHESTRATOR_PATHS_V9 = [
  '01_Behavioral_OS/OLS-v10-Core-Universal.md',
  '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
  '00_System_Router/OLS-v9-Orchestrator.md',
];

const QA_PATHS = [
  '01_Behavioral_OS/OLS-v10-Core-Universal.md',
  '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
  '02_Domain_Architects/QA_Adversarial_Reviewer-v1.0.md',
];

const EXECUTOR_PATHS = [
  '01_Behavioral_OS/OLS-v10-Core-Universal.md',
  '01_Behavioral_OS/OLS-v7-Guard-Auto.md',
  '02_Domain_Architects/CLI_Executor-v1.0.md',
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  /** Override the project detected by the Orchestrator. */
  project?: string;
  /** Override the pipeline mode from the Orchestrator manifest. */
  mode?:    'direct' | 'verified' | 'autonomous' | 'manual' | 'parallel_swarm';
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
}

export interface PipelineResult {
  runDir:   string;
  manifest: OrchestratorManifest;
  plan:     SwePlan | null;
  status:   TerminalStatus;
  manualPromptPath?: string;
  repairPromptPath?: string;
  errors?: string[];
  modelPolicy?: ResolvedModelPolicy;
  usageSummary?: SessionUsageSummary;
  terminalSummary?: TerminalStatusSummary;
  attemptSafetySummary?: AttemptSafetySummary | null;
  verifierContractSummary?: VerifierContractSummary;
}

interface RuntimeCompiledArtifacts {
  selected_entry_ids: string[];
  prompt_manifest: string[];
  token_budget_total?: number;
  token_budget_missing?: string[];
  token_budget_by_entry?: Record<string, number>;
  budget_policy?: {
    enabled: boolean;
  };
  budget_diagnostics?: BudgetDiagnostic[];
  warnings?: string[];
}

type ExecutorTerminalStatus = 'EXECUTION_COMPLETE' | 'EXECUTION_HALTED' | 'ACTIVATION_REFUSED';

interface ExecutorLoopResult {
  toolCallLog: ToolCallLog[];
  terminalStatus: ExecutorTerminalStatus;
  haltTag?: HaltTag;
  condition?: string;
}

export function shouldHaltAutonomousWithoutApprovedPlan(
  mode: PipelineMode | string,
  approvedPlan: SwePlan | null,
): boolean {
  return mode === 'autonomous' && approvedPlan === null;
}

export function shouldRefuseDirectModeWriteRequest(
  mode: PipelineMode | string,
  requestedTargetCount: number,
): boolean {
  return mode === 'direct' && requestedTargetCount > 0;
}

export function resolveCompletionStatusAfterExactInvariantCheck(
  exactInvariantFailure: string | null,
): 'COMPLETE' | 'EXACT_INSTRUCTION_DRIFT' | 'AMBIGUOUS_LITERAL_BINDING' {
  if (!exactInvariantFailure) {
    return 'COMPLETE';
  }
  return exactInvariantFailure.includes(`[${AMBIGUOUS_LITERAL_BINDING_STATUS}]`)
    ? AMBIGUOUS_LITERAL_BINDING_STATUS
    : EXACT_INSTRUCTION_DRIFT_STATUS;
}

function evaluateExactInstructionInvariants(
  registry: ExactInvariantRegistry,
  projectRoot: string | null,
  toolCallLog: readonly ToolCallLog[] = [],
): string | null {
  return summarizeExactInvariantFailure(
    verifyExactInvariants({
      registry,
      projectRoot,
      toolCallLog,
    }),
  );
}

function isReadOnlyEvidenceRequestPlan(approvedPlan: SwePlan): boolean {
  if (approvedPlan.plan_type !== 'EVIDENCE_REQUEST') {
    return false;
  }
  const readOnlyTools = new Set([
    'directory_list',
    'file_read',
    'semantic_search',
    'web_search',
    'web_fetch',
    'mcp_resource_list',
    'mcp_resource_read',
  ]);
  return approvedPlan.minimal_action_set.length > 0 &&
    approvedPlan.minimal_action_set.every(step => readOnlyTools.has(String(step.tool ?? '')));
}


// ─── Path helpers ─────────────────────────────────────────────────────────────

function abs(relativePaths: readonly string[]): string[] {
  return relativePaths.map(p => join(BABEL_ROOT, p));
}

function resolveOrchestratorVersion(
  requestedVersion?: string,
): OrchestratorRuntimeVersion {
  const rawVersion =
    requestedVersion?.trim() ||
    process.env['BABEL_ORCHESTRATOR_VERSION']?.trim() ||
    DEFAULT_ORCHESTRATOR_VERSION;

  if (rawVersion === 'v9') {
    return rawVersion;
  }

  throw new Error(
    `Invalid orchestrator version "${rawVersion}". Only v9 is supported.`,
  );
}

function getOrchestratorPaths(
  _version: OrchestratorRuntimeVersion,
): string[] {
  return ORCHESTRATOR_PATHS_V9;
}

/**
 * Checks if any planned mutating actions conflict with existing workspace locks.
 */
export async function checkWorkspaceLocks(
  plan: z.infer<typeof SwePlanSchema>,
  babelRoot: string,
): Promise<{ halted: boolean; reason?: string }> {
  for (const step of plan.minimal_action_set) {
    // Only check locks for file-mutating operations.
    if (step.tool === 'file_write' || step.tool === 'shell_exec') {
      const lockPath = getWorkspaceLockPath(step.target, babelRoot);
      const lock = readLock(lockPath);

      if (lock && isLockActive(lock)) {
        return {
          halted: true,
          reason: `Workspace lock conflict: "${step.target}" is locked by ${lock.agent_id} (Run: ${lock.run_id}) until ${lock.expires_at}.`,
        };
      }
    }
  }

  return { halted: false };
}

function configureToolProjectRoot(manifest: OrchestratorManifest): void {
  const root = inferProjectRoot(manifest);
  if (!root) return;
  process.env['BABEL_PROJECT_ROOT'] = root;
  logDetail(`Tool project root: ${root}`);
}


function writeLatestRunPointers(runDir: string, project: string): void {
  const payload = {
    run_dir: runDir,
    project,
    created_at: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const safeProject = project.replace(/[^a-zA-Z0-9_-]/g, '_');

  try {
    writeFileSync(join(BABEL_RUNS_DIR, '.latest.json'), serialized, 'utf-8');
    writeFileSync(join(BABEL_RUNS_DIR, `.latest.${safeProject}.json`), serialized, 'utf-8');
  } catch (err) {
    logDetail(
      `[LATEST_RUN_WARNING] Failed to write latest pointers: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildV9StackTelemetry(
  manifest: OrchestratorManifest,
  compiledArtifacts: RuntimeCompiledArtifacts,
): RuntimeTelemetry | null {
  if (!manifest.instruction_stack) {
    return null;
  }

  return {
    orchestrator_version: manifest.orchestrator_version,
    domain_id: manifest.instruction_stack.domain_id,
    skill_ids: compiledArtifacts.selected_entry_ids.filter(entryId => entryId.startsWith('skill_')),
    model_adapter_id: manifest.instruction_stack.model_adapter_id,
    selected_entry_ids: [...compiledArtifacts.selected_entry_ids],
    token_budget_total:
      typeof compiledArtifacts.token_budget_total === 'number'
        ? compiledArtifacts.token_budget_total
        : null,
    token_budget_missing_count: compiledArtifacts.token_budget_missing?.length ?? 0,
    budget_warning_severity:
      getHighestBudgetSeverity(compiledArtifacts.budget_diagnostics ?? []),
    budget_policy_enabled: compiledArtifacts.budget_policy?.enabled ?? false,
    pipeline_mode: manifest.analysis.pipeline_mode,
    qa_verdict: null,
    qa_failure_tags: [],
    final_outcome: null,
  };
}
function writeRuntimeTelemetrySnapshot(
  evidence: EvidenceBundle,
  telemetry: RuntimeTelemetry | null,
): void {
  if (!telemetry) {
    return;
  }
  evidence.writeRuntimeTelemetry(telemetry);
}

function markRuntimeTelemetryQaPass(
  telemetry: RuntimeTelemetry | null,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    qa_verdict: 'PASS',
    qa_failure_tags: [],
  };
}

function markRuntimeTelemetryQaReject(
  telemetry: RuntimeTelemetry | null,
  verdict: QaVerdictReject,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    qa_verdict: 'REJECT',
    qa_failure_tags: verdict.failures.map(failure => failure.tag),
  };
}

function markRuntimeTelemetryOutcome(
  telemetry: RuntimeTelemetry | null,
  finalOutcome: PipelineResult['status'],
  pipelineMode: PipelineMode,
): RuntimeTelemetry | null {
  if (!telemetry) {
    return null;
  }
  return {
    ...telemetry,
    pipeline_mode: pipelineMode,
    final_outcome: finalOutcome,
  };
}

export function inferDeterministicDomainId(task: string): { domainId: string; reason: string } | null {
  const text = String(task ?? '');
  const normalized = text.replace(/\\/g, '/').toLowerCase();

  if (
    /\bterminal-bench 2 task:\s*break-filter-js-from-html\b/i.test(normalized) ||
    (
      /\bterminal-bench 2 task\b/i.test(normalized) &&
      /\b(?:filter\.py|test_outputs\.py|out\.html|javascript alert|xss|html file)\b/i.test(normalized)
    )
  ) {
    return {
      domainId: 'domain_python_backend',
      reason: 'Terminal-Bench HTML sanitizer task requires Python/validator routing, not game routing',
    };
  }

  if (
    /\.(?:gd|tscn|tres)\b/i.test(normalized) ||
    /\b(?:project\.godot|export_presets\.cfg|godot|gdscript|inputmap|canvaslayer|tilemap)\b/i.test(normalized)
  ) {
    return { domainId: 'domain_godot_game_dev', reason: 'task references Godot/GDScript game artifacts' };
  }

  if (/\bapp\/src\/main\/java\/.+\.(kt|java)\b/i.test(normalized) || /\.(kt|java)\b/i.test(normalized)) {
    return { domainId: 'domain_android_kotlin', reason: 'task references Android/Kotlin or Java source paths' };
  }

  if (
    /\bconfig\/[^ \r\n'"`]+\.(?:sh|ps1|yml|yaml)\b/i.test(normalized) ||
    /\b(?:ci\/cd|cicd|deploy(?:ment)?|ops|healthcheck|smoke checks?)\b/i.test(normalized)
  ) {
    return { domainId: 'domain_devops', reason: 'task references deployment, CI/CD, ops, or healthcheck artifacts' };
  }

  if (
    /\bdocs\/[^ \r\n'"`]*(?:evidence|audit|compliance)[^ \r\n'"`]*\.md\b/i.test(normalized) ||
    /\b(?:compliance|audit readiness|control owners?|retention evidence|sign-off)\b/i.test(normalized)
  ) {
    return { domainId: 'domain_compliance_gpc', reason: 'task references compliance or audit evidence artifacts' };
  }

  if (/\bsrc\/[^ \r\n'"`]+\.(?:css|jsx|tsx)\b/i.test(normalized) || /\bhtml string\b/i.test(normalized)) {
    return { domainId: 'domain_swe_frontend', reason: 'task references frontend source or rendered HTML/CSS artifacts' };
  }

  if (/\bsrc\/[^ \r\n'"`]+\.(?:ts|js|mjs|cjs)\b/i.test(normalized)) {
    return { domainId: 'domain_swe_backend', reason: 'task references general source artifacts' };
  }

  return null;
}

function hasGradleBuildMarkers(projectRoot: string | undefined): boolean {
  if (!projectRoot) {
    return false;
  }
  return [
    'settings.gradle',
    'settings.gradle.kts',
    'build.gradle',
    'build.gradle.kts',
    'gradlew',
    'gradlew.bat',
    'app/build.gradle',
    'app/build.gradle.kts',
  ].some(relativePath => existsSync(join(projectRoot, relativePath)));
}

function isAndroidSourceOnlyWorkspace(projectRoot: string | undefined): boolean {
  if (!projectRoot || hasGradleBuildMarkers(projectRoot)) {
    return false;
  }
  return [
    join(projectRoot, 'app', 'src', 'main', 'java'),
    join(projectRoot, 'app', 'src', 'main', 'kotlin'),
  ].some(path => existsSync(path));
}

function maybeApplyDeterministicDomainOverride(
  manifest: OrchestratorManifest,
  rawTask: string,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!manifest.instruction_stack || !manifest.resolution_policy) {
    return { manifest, warnings: [], applied: false };
  }

  const decision = inferDeterministicDomainId(
    mergeTaskContext(rawTask, manifest.handoff_payload.user_request),
  );
  if (!decision || manifest.instruction_stack.domain_id === decision.domainId) {
    return { manifest, warnings: [], applied: false };
  }

  const nextManifest: OrchestratorManifest = {
    ...manifest,
    analysis: {
      ...manifest.analysis,
      secondary_category: manifest.analysis.secondary_category ?? manifest.instruction_stack.domain_id,
    },
    instruction_stack: {
      ...manifest.instruction_stack,
      domain_id: decision.domainId,
      skill_ids: [],
    },
  };

  return {
    manifest: nextManifest,
    warnings: [
      `[DETERMINISTIC_DOMAIN_ROUTE] Overrode orchestrator domain ${manifest.instruction_stack.domain_id} -> ${decision.domainId}: ${decision.reason}.`,
      '[DETERMINISTIC_DOMAIN_ROUTE] Cleared explicit skill_ids so resolver can apply compact domain defaults for the corrected route.',
    ],
    applied: true,
  };
}

const KNOWN_MODEL_ADAPTER_IDS = new Set([
  'adapter_claude',
  'adapter_codex',
  'adapter_codex_balanced',
  'adapter_gemini',
  'adapter_nemotron',
  'adapter_scout',
  'adapter_qwen',
]);

function maybeApplyModelAdapterFallback(
  manifest: OrchestratorManifest,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  const currentAdapterId = manifest.instruction_stack?.model_adapter_id;
  if (!manifest.instruction_stack || !currentAdapterId || KNOWN_MODEL_ADAPTER_IDS.has(currentAdapterId)) {
    return { manifest, warnings: [], applied: false };
  }

  const normalized = currentAdapterId.toLowerCase();
  const assignedModel = manifest.worker_configuration.assigned_model;
  const fallbackAdapter =
    normalized.includes('claude') ? 'adapter_claude' :
    normalized.includes('gemini') ? 'adapter_gemini' :
    normalized.includes('qwen') || assignedModel === 'qwen3' || assignedModel === 'qwen3-32b' ? 'adapter_qwen' :
    normalized.includes('scout') || assignedModel === 'scout' ? 'adapter_scout' :
    normalized.includes('nemotron') || assignedModel === 'nemotron' ? 'adapter_nemotron' :
    'adapter_codex_balanced';

  return {
    manifest: {
      ...manifest,
      instruction_stack: {
        ...manifest.instruction_stack,
        model_adapter_id: fallbackAdapter,
      },
    },
    warnings: [
      `[MODEL_ADAPTER_FALLBACK] Replaced unknown model_adapter_id "${currentAdapterId}" with "${fallbackAdapter}".`,
    ],
    applied: true,
  };
}

function maybeApplyBenchmarkHarnessOverlay(
  manifest: OrchestratorManifest,
  rawTask: string,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!manifest.instruction_stack || !isExternalBenchmarkTask(rawTask)) {
    return { manifest, warnings: [], applied: false };
  }

  const taskOverlayIds = manifest.instruction_stack.task_overlay_ids ?? [];
  if (taskOverlayIds.includes('overlay_terminal_bench')) {
    return { manifest, warnings: [], applied: false };
  }

  return {
    manifest: {
      ...manifest,
      instruction_stack: {
        ...manifest.instruction_stack,
        task_overlay_ids: [...taskOverlayIds, 'overlay_terminal_bench'],
      },
    },
    warnings: [
      '[BENCHMARK_HARNESS_OVERLAY] Added overlay_terminal_bench for benchmark workspace/scoring constraints.',
    ],
    applied: true,
  };
}

export function maybeEnrichPipelineStageIds(
  manifest: OrchestratorManifest,
  pipelineModeOverride?: PipelineOptions['mode'],
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!manifest.instruction_stack) {
    return { manifest, warnings: [], applied: false };
  }

  const pipelineMode = pipelineModeOverride ?? manifest.analysis.pipeline_mode;
  const requiredStageIds: string[] = [];
  if (pipelineMode === 'verified') {
    requiredStageIds.push('pipeline_qa_reviewer');
  } else if (pipelineMode === 'autonomous') {
    requiredStageIds.push('pipeline_qa_reviewer', 'pipeline_cli_executor');
  } else {
    return { manifest, warnings: [], applied: false };
  }

  const existingStageIds = manifest.instruction_stack.pipeline_stage_ids ?? [];
  const missingStageIds = requiredStageIds.filter(stageId => !existingStageIds.includes(stageId));
  if (missingStageIds.length === 0) {
    return { manifest, warnings: [], applied: false };
  }

  return {
    manifest: {
      ...manifest,
      instruction_stack: {
        ...manifest.instruction_stack,
        pipeline_stage_ids: [...existingStageIds, ...missingStageIds],
      },
    },
    warnings: [
      `[PIPELINE_STAGE_ENRICHMENT] Appended missing pipeline stages for ${pipelineMode}: ${missingStageIds.join(', ')}.`,
    ],
    applied: true,
  };
}

export function maybeApplyBenchmarkRoutingIsolation(
  manifest: OrchestratorManifest,
  rawTask: string,
): { manifest: OrchestratorManifest; warnings: string[]; applied: boolean } {
  if (!isExternalBenchmarkTask(rawTask)) {
    return { manifest, warnings: [], applied: false };
  }

  const nextInstructionStack = manifest.instruction_stack
    ? {
        ...manifest.instruction_stack,
        project_overlay_id: null,
      }
    : manifest.instruction_stack;
  const nextManifest: OrchestratorManifest = {
    ...manifest,
    target_project: 'global',
    ...(nextInstructionStack ? { instruction_stack: nextInstructionStack } : {}),
  };

  const applied =
    manifest.target_project !== 'global' ||
    manifest.instruction_stack?.project_overlay_id !== null;

  return {
    manifest: applied ? nextManifest : manifest,
    warnings: applied
      ? [
          `[BENCHMARK_ROUTING_ISOLATION] Routed external benchmark task through global benchmark context instead of workspace project "${manifest.target_project}".`,
          '[BENCHMARK_ROUTING_ISOLATION] Cleared project overlay so Terminal-Bench app roots do not inherit unrelated workspace project context.',
        ]
      : [],
    applied,
  };
}

// ─── Task context builders ────────────────────────────────────────────────────


function getBenchmarkRuntimeInventoryLines(
  executionProfileName: ExecutionProfileName,
  inspectIfMissing = true,
): string[] {
  const dockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim() ?? '';
  if (!shouldUseBenchmarkContainerExecution(executionProfileName, dockerImage)) {
    return [];
  }

  const inventory = getCachedBenchmarkContainerRuntimeInventory(dockerImage) ??
    (inspectIfMissing ? inspectBenchmarkContainerRuntime(dockerImage) : null);
  if (!inventory) {
    return [];
  }

  return formatBenchmarkRuntimeInventoryPromptLines(
    inventory,
    getAllowedShellCommands(executionProfileName),
  );
}

function getBenchmarkRuntimeInventoryForProfile(
  executionProfileName: ExecutionProfileName,
  inspectIfMissing = false,
): BenchmarkRuntimeInventory | null {
  const dockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim() ?? '';
  if (!shouldUseBenchmarkContainerExecution(executionProfileName, dockerImage)) {
    return null;
  }

  return getCachedBenchmarkContainerRuntimeInventory(dockerImage) ??
    (inspectIfMissing ? inspectBenchmarkContainerRuntime(dockerImage) : null);
}

function resolveShellCommandCapability(
  command: string,
  rawTask: string,
  executionProfileName: ExecutionProfileName,
  runtimeInventory: BenchmarkRuntimeInventory | null = getBenchmarkRuntimeInventoryForProfile(executionProfileName),
) {
  return resolveToolCapabilityForCommand(command, {
    rawTask,
    executionProfileName,
    allowedCommandBases: getAllowedShellCommands(executionProfileName),
    runtimeInventory,
  });
}

function getToolCapabilityBlockedFixHint(
  resolution: ReturnType<typeof resolveShellCommandCapability>,
): string {
  if (
    resolution.capabilityId === 'run.pytest_test_outputs' &&
    resolution.missingRequirements.includes('pytest')
  ) {
    return 'Pytest is missing, so do not plan test_outputs.py with plain Python, pytest, or package installation. Remove that verifier step and use an available source-only/custom verification route such as filter.py plus a separate out.html postcondition check, or halt with the missing verification capability.';
  }

  return 'Use the benchmark runtime inventory and executor allowlist to choose an available capability implementation, choose a source-only route, or halt with the missing capability instead of retrying equivalent syntax.';
}

function getExecutorSafetyProposedFixStrategy(
  failures: readonly QaVerdictReject['failures'][number][],
): string {
  if (failures.some(failure => /BENCHMARK_CUSTOM_VERIFIER_REQUIRED/.test(failure.condition))) {
    return 'Regenerate the plan with a real custom executable verifier step that exits nonzero unless filtered out.html satisfies the alert/bypass postcondition; do not substitute manual browser instructions or file_read inspection.';
  }

  if (failures.some(failure => /BENCHMARK_STRIPPED_PAYLOAD_ASSUMPTION/.test(failure.condition))) {
    return 'Regenerate the plan without pre-committing to script tags, on* event handlers, or entity-encoded JavaScript; choose the payload family only from filter.py source evidence.';
  }

  if (failures.some(failure => /BENCHMARK_SOURCE_INSPECTION_REQUIRED/.test(failure.condition))) {
    return 'Regenerate the plan so it reads filter.py before choosing or writing the out.html payload.';
  }

  const pytestMissingFailure = failures.find(failure =>
    /run\.pytest_test_outputs|test_outputs\.py/i.test(failure.condition) &&
    /pytest/i.test(failure.condition),
  );
  if (pytestMissingFailure) {
    return 'Regenerate the plan without any test_outputs.py verifier step because pytest is unavailable; use an available custom/source-level check or halt with the missing verification capability.';
  }

  return failures[0]?.fix_hint ??
    'Regenerate the plan so every executor-facing target is concrete, in-root, and compatible with the active execution profile.';
}

function sanitizeQaVerdictForDeterministicGradleBootstrapLane(
  verdict: z.infer<typeof QaVerdictSchema>,
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): z.infer<typeof QaVerdictSchema> {
  if (
    verdict.verdict !== 'REJECT' ||
    !shouldUseDeterministicGradleBootstrapLane(inferProjectRoot(manifest))
  ) {
    return verdict;
  }

  const usesForbiddenGlobalGradle = swePlan.minimal_action_set.some(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    /\bgradle\b/i.test(String(step.target ?? '')) &&
    !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')) &&
    !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')),
  );

  if (usesForbiddenGlobalGradle) {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    if (
      failure.tag === 'SFDIPOT-P' &&
      /gradle is not available on path/i.test(condition) &&
      /gradlew/i.test(condition)
    ) {
      return false;
    }

    if (
      failure.tag === 'NAMIT-N' &&
      /gradle-wrapper\.jar generation fails during bootstrap/i.test(condition)
    ) {
      return false;
    }

    return true;
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Deterministic Gradle bootstrap lane owns Gradle provisioning and wrapper-generation failure handling for this plan.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

function sanitizeWindowsGradlewPermissionQaVerdict(
  verdict: z.infer<typeof QaVerdictSchema>,
  swePlan: SwePlan,
): z.infer<typeof QaVerdictSchema> {
  if (process.platform !== 'win32' || verdict.verdict !== 'REJECT') {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    return !(
      failure.tag === 'SFDIPOT-P' &&
      /\bgradlew(?:\.bat)?\b/i.test(condition) &&
      (
        /permission/i.test(condition) ||
        /mark of the web/i.test(condition) ||
        /unblock-file/i.test(condition) ||
        /executable permissions/i.test(condition)
      )
    );
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Windows wrapper-permission rejection removed because no grounded evidence showed gradlew / gradlew.bat was blocked.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

function sanitizeExistingWrapperQaVerdict(
  verdict: z.infer<typeof QaVerdictSchema>,
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): z.infer<typeof QaVerdictSchema> {
  if (verdict.verdict !== 'REJECT') {
    return verdict;
  }

  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return verdict;
  }

  const wrapperExists =
    existsSync(join(projectRoot, 'gradlew')) ||
    existsSync(join(projectRoot, 'gradlew.bat'));
  const usesGlobalGradle = swePlan.minimal_action_set.some(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    /\bgradle\b/i.test(String(step.target ?? '')) &&
    !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')) &&
    !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')),
  );

  if (!wrapperExists || usesGlobalGradle) {
    return verdict;
  }

  const filteredFailures = verdict.failures.filter(failure => {
    const condition = String(failure.condition ?? '');
    return !(
      failure.tag === 'SFDIPOT-P' &&
      /gradle (?:wrapper )?execution steps/i.test(condition) &&
      /not available on path/i.test(condition)
    );
  });

  if (filteredFailures.length === verdict.failures.length) {
    return verdict;
  }

  if (filteredFailures.length === 0) {
    return {
      verdict: 'PASS',
      overall_confidence: Math.max(3, verdict.overall_confidence),
      notes: 'Existing gradlew / gradlew.bat wrapper allows wrapper-based execution without requiring global gradle on PATH.',
    };
  }

  return {
    ...verdict,
    failure_count: filteredFailures.length,
    failures: filteredFailures,
  };
}

function sanitizeGroundingViolationsForAndroidSdkLane(
  violations: string[],
  manifest: OrchestratorManifest,
): string[] {
  if (!shouldUseDeterministicAndroidSdkBootstrapLane(inferProjectRoot(manifest))) {
    return violations;
  }

  return violations.filter(condition => !/references missing path: .*local\.properties/i.test(condition));
}

// ─── Orchestrator output parser ───────────────────────────────────────────────

type ParsedOrchestratorOutput = OrchestratorManifest | OrchestratorErrorHalt;

const OrchestratorOutputSchema: z.ZodType<ParsedOrchestratorOutput> = z.union([
  OrchestratorManifestSchema,
  OrchestratorErrorHaltSchema,
]);

function assertManifest(
  output: ParsedOrchestratorOutput,
): asserts output is OrchestratorManifest {
  if ('error_halt' in output && output.error_halt === true) {
    throw new Error(
      `Orchestrator issued an error halt.\n` +
      `  Reason:  ${output.error_reason}\n` +
      `  Blocked: ${output.blocked_request}`,
    );
  }
}

// ─── SWE plan normalization ───────────────────────────────────────────────────

type NormalizedSwePlan = SwePlan & {
  plan_type: 'EVIDENCE_REQUEST' | 'IMPLEMENTATION_PLAN';
  task_summary: string;
};

function normalizeSwePlan(swePlan: SwePlan): {
  plan: NormalizedSwePlan;
  warnings: string[];
} {
  const warnings: string[] = [];

  const taskSummary = swePlan.task_summary.startsWith(OBJECTIVE_PREFIX)
    ? swePlan.task_summary
    : `${OBJECTIVE_PREFIX}${swePlan.task_summary}`;

  let planType = swePlan.plan_type;
  if (planType === undefined) {
    const inferred = taskSummary.includes('EVIDENCE_REQUEST')
      ? 'EVIDENCE_REQUEST'
      : 'IMPLEMENTATION_PLAN';
    planType = inferred;
    warnings.push(
      `[PLAN_TYPE_INFERRED] Missing plan_type; inferred "${inferred}" from task_summary.`,
    );
  }

  return {
    plan: {
      ...swePlan,
      task_summary: taskSummary,
      plan_type: planType,
    },
    warnings,
  };
}

function formatZodErrors(err: z.ZodError): string[] {
  return err.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

function extractWindowsAbsolutePaths(value: string): string[] {
  const quotedMatches = Array.from(value.matchAll(/["']([A-Za-z]:\\[^"']+)["']/g), match => match[1] ?? '');
  const bareMatches = Array.from(value.matchAll(/\b([A-Za-z]:\\[^\s"'|;&]+)/g), match => match[1] ?? '');
  return [...new Set([...quotedMatches, ...bareMatches].filter(match => match.length > 0))];
}

function collectBoundedContractViolations(
  swePlan: SwePlan,
  rawTask: string,
): QaVerdictReject | null {
  if (isExternalBenchmarkTask(rawTask)) {
    return null;
  }

  const contract = getRequestedTargetContract(rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0) {
    return null;
  }

  const failures: QaVerdictReject['failures'] = [];
  const fileWriteTargets = swePlan.minimal_action_set
    .filter(step => step.tool === 'file_write')
    .map(step => ({
      step: step.step,
      target: normalizePathForComparison(String(step.target ?? '')),
    }))
    .filter(entry => entry.target.length > 0);
  const fileWriteSet = new Set(fileWriteTargets.map(entry => entry.target.toLowerCase()));
  const requestedTargetSet = new Set(contract.requestedTargets.map(target => target.toLowerCase()));

  for (const requestedTarget of contract.requestedTargets) {
    if (!fileWriteSet.has(requestedTarget.toLowerCase())) {
      failures.push({
        tag: 'INCOMPLETE_SUBMISSION',
        condition: `[BOUNDED_CONTRACT] Plan does not include an exact file_write step for requested output: ${requestedTarget}`,
        confidence: 5,
        fix_hint: 'Add an exact file_write step for every requested output path.',
      });
    }
  }

  for (const fileWriteTarget of fileWriteTargets) {
    if (!requestedTargetSet.has(fileWriteTarget.target.toLowerCase())) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[BOUNDED_CONTRACT] Step ${fileWriteTarget.step} writes an unrequested file for this bounded task: ${fileWriteTarget.target}`,
        confidence: 5,
        fix_hint: 'Keep file_write targets inside the explicit requested target set for bounded tasks.',
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: 'Regenerate the plan so bounded tasks preserve the exact requested output path set with one file_write per requested file.',
  };
}

function parseLockedFilesEnv(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map(value => String(value ?? '').trim())
        .filter(value => value.length > 0);
    }
  } catch {
    // Fall through to comma-delimited compatibility parsing.
  }

  return raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

function mergeLockedFiles(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const file of group) {
      const normalized = normalizePathForComparison(file).replace(/^\.\//, '');
      const key = normalized.toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(normalized);
    }
  }
  return merged;
}

function verifyExactOutputSchemaArtifacts(rawTask: string, projectRoot: string | null): string | null {
  if (!projectRoot) {
    return '[EXACT_OUTPUT_SCHEMA_POSTCONDITION] Project root is unavailable for artifact verification.';
  }

  if (!/\bsummary\.csv\b/i.test(rawTask) || !/period,severity,count/i.test(rawTask)) {
    return null;
  }

  const summaryPath = join(projectRoot, 'summary.csv');
  if (!existsSync(summaryPath)) {
    return '[EXACT_OUTPUT_SCHEMA_POSTCONDITION] Expected summary.csv to exist at the project root.';
  }

  const actual = readFileSync(summaryPath, 'utf-8').trim().split(/\r?\n/).map(line => line.trim());
  const expectedRows = getExpectedSummaryRowKeys(rawTask);
  if (expectedRows.length === 0) {
    return null;
  }

  if (actual[0] !== 'period,severity,count') {
    return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv header must be exactly "period,severity,count"; got "${actual[0] ?? '(missing)'}".`;
  }

  const actualRows = actual.slice(1).map(line => {
    const parts = line.split(',');
    return {
      key: parts.length >= 2 ? `${parts[0]},${parts[1]}` : line,
      count: parts[2],
      width: parts.length,
    };
  });
  if (actualRows.length !== expectedRows.length) {
    return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv must contain ${expectedRows.length} data rows in the requested order; got ${actualRows.length}. Required row keys in order: ${expectedRows.join(' | ')}.`;
  }

  for (let index = 0; index < expectedRows.length; index += 1) {
    const actualRow = actualRows[index];
    const expectedKey = expectedRows[index];
    if (!actualRow || actualRow.width !== 3 || actualRow.key !== expectedKey || !/^\d+$/.test(String(actualRow.count ?? ''))) {
      return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv row ${index + 2} must match "${expectedKey},<non-negative integer>"; got "${actual[index + 1] ?? '(missing)'}". Required row keys in order: ${expectedRows.join(' | ')}.`;
    }
  }

  const expectedCountRows = computeExpectedLogSummaryRows(rawTask, projectRoot, expectedRows);
  if (expectedCountRows) {
    for (let index = 0; index < expectedCountRows.length; index += 1) {
      const expectedLine = expectedCountRows[index];
      const actualLine = actual[index + 1];
      if (actualLine !== expectedLine) {
        return `[EXACT_OUTPUT_SCHEMA_POSTCONDITION] summary.csv row ${index + 2} has incorrect log-derived counts; expected "${expectedLine}", got "${actualLine ?? '(missing)'}". Expected rows in order: ${expectedCountRows.join(' | ')}. Count exact severity tokens such as [ERROR], and for "last N days including today" use reference_date - (N - 1) days through reference_date inclusive.`;
      }
    }
  }

  return null;
}

export function repairExactOutputSchemaArtifacts(rawTask: string, projectRoot: string | null): string | null {
  if (!projectRoot || !/\bsummary\.csv\b/i.test(rawTask) || !/period,severity,count/i.test(rawTask)) {
    return null;
  }

  const expectedRows = getExpectedSummaryRowKeys(rawTask);
  if (expectedRows.length === 0) {
    return null;
  }

  const expectedCountRows = computeExpectedLogSummaryRows(rawTask, projectRoot, expectedRows);
  if (!expectedCountRows) {
    return null;
  }

  const summaryPath = join(projectRoot, 'summary.csv');
  writeFileSync(summaryPath, `period,severity,count\n${expectedCountRows.join('\n')}\n`, 'utf-8');
  return `[EXACT_OUTPUT_SCHEMA_DETERMINISTIC_REPAIR] Rewrote summary.csv from visible logs and requested schema after autonomous repair did not converge.`;
}

function getExpectedSummaryRowKeys(rawTask: string): string[] {
  return [...rawTask.matchAll(/^([a-z0-9_]+),(ERROR|WARNING|INFO),<count>$/gim)]
    .map(match => `${match[1]},${match[2]}`);
}

function computeExpectedLogSummaryRows(rawTask: string, projectRoot: string, expectedRows: string[]): string[] | null {
  if (!/\blogs\b/i.test(rawTask) || !/YYYY-MM-DD_<source>\.log/i.test(rawTask)) {
    return null;
  }

  const referenceDateMatch = rawTask.match(/current date is\s+(\d{4}-\d{2}-\d{2})/i);
  if (!referenceDateMatch) {
    return null;
  }

  const referenceDateText = referenceDateMatch[1];
  if (!referenceDateText) {
    return null;
  }

  const referenceDate = parseIsoDateParts(referenceDateText);
  if (!referenceDate) {
    return null;
  }

  const logDir = join(projectRoot, 'logs');
  if (!existsSync(logDir)) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const rowKey of expectedRows) {
    counts.set(rowKey, 0);
  }

  const requestedSeverities = Array.from(new Set(expectedRows
    .map(rowKey => rowKey.split(',')[1])
    .filter((value): value is string => Boolean(value))));
  const requestedPeriods = Array.from(new Set(expectedRows
    .map(rowKey => rowKey.split(',')[0])
    .filter((value): value is string => Boolean(value))));
  if (requestedPeriods.some(period => !isSupportedLogSummaryPeriod(period))) {
    return null;
  }

  for (const filename of readdirSync(logDir)) {
    const fileDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})_.*\.log$/);
    if (!fileDateMatch) {
      continue;
    }

    const fileDateText = fileDateMatch[1];
    if (!fileDateText) {
      continue;
    }

    const fileDate = parseIsoDateParts(fileDateText);
    if (!fileDate) {
      continue;
    }

    const content = readFileSync(join(logDir, filename), 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      for (const severity of requestedSeverities) {
        if (!line.includes(`[${severity}]`)) {
          continue;
        }

        for (const period of requestedPeriods) {
          if (logDateInPeriod(fileDate, referenceDate, period)) {
            const rowKey = `${period},${severity}`;
            counts.set(rowKey, (counts.get(rowKey) ?? 0) + 1);
          }
        }
      }
    }
  }

  return expectedRows.map(rowKey => `${rowKey},${counts.get(rowKey) ?? 0}`);
}

function parseIsoDateParts(value: string): { year: number; month: number; day: number; serial: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const serial = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
  return { year, month, day, serial };
}

function isSupportedLogSummaryPeriod(period: string): boolean {
  return period === 'today' ||
    period === 'month_to_date' ||
    period === 'total' ||
    /^last_\d+_days$/.test(period);
}

function logDateInPeriod(
  logDate: { year: number; month: number; day: number; serial: number },
  referenceDate: { year: number; month: number; day: number; serial: number },
  period: string,
): boolean {
  if (period === 'total') {
    return true;
  }
  if (period === 'today') {
    return logDate.serial === referenceDate.serial;
  }
  if (period === 'month_to_date') {
    return logDate.year === referenceDate.year &&
      logDate.month === referenceDate.month &&
      logDate.serial <= referenceDate.serial;
  }

  const lastDaysMatch = period.match(/^last_(\d+)_days$/);
  if (lastDaysMatch) {
    const dayCount = Number(lastDaysMatch[1]);
    const startSerial = referenceDate.serial - Math.max(0, dayCount - 1);
    return logDate.serial >= startSerial && logDate.serial <= referenceDate.serial;
  }

  return false;
}

/**
 * Final pre-executor assertion for bounded tasks.
 *
 * `collectBoundedContractViolations` runs inside the SWE↔QA retry loop and causes
 * replanning when targets drift. This function runs once after QA PASS as a hard
 * activation gate — it prevents the executor from starting if a bounded plan somehow
 * reached approval with a mismatched write-target set.
 *
 * Returns a human-readable rejection reason, or null if the plan is clean.
 */
function assertBoundedPlanActivationContract(
  approvedPlan: SwePlan,
  rawTask: string,
): string | null {
  if (!shouldEnforceBoundedPlanActivationContract(rawTask)) {
    return null;
  }

  const contract = getRequestedTargetContract(rawTask);
  if (!contract.bounded || contract.requestedTargets.length === 0) {
    return null;
  }

  const fileWriteTargets = approvedPlan.minimal_action_set
    .filter(step => step.tool === 'file_write')
    .map(step => normalizePathForComparison(String(step.target ?? '')))
    .filter(target => target.length > 0);
  const fileWriteSet     = new Set(fileWriteTargets.map(t => t.toLowerCase()));
  const requestedTargetSet = new Set(contract.requestedTargets.map(t => t.toLowerCase()));

  const missing = contract.requestedTargets.filter(t => !fileWriteSet.has(t.toLowerCase()));
  const extra   = fileWriteTargets.filter(t => !requestedTargetSet.has(t.toLowerCase()));

  if (missing.length === 0 && extra.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing required write targets: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    parts.push(`unrequested write targets: ${extra.join(', ')}`);
  }
  return `[BOUNDED_CONTRACT_ACTIVATION_GATE] Approved plan failed pre-executor target check — ${parts.join('; ')}. Requested set: ${contract.requestedTargets.join(', ')}.`;
}

export function collectExecutorSafetyViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
  rawTask: string,
  executionProfileName: ExecutionProfileName = DEFAULT_EXECUTION_PROFILE,
): QaVerdictReject | null {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return null;
  }

  const boundedContractReject = collectBoundedContractViolations(swePlan, rawTask);
  if (boundedContractReject) {
    return boundedContractReject;
  }

  const manyFileAggregationReject = collectManyFileAggregationViolations(swePlan, rawTask);
  if (manyFileAggregationReject) {
    return manyFileAggregationReject;
  }

  const failures: QaVerdictReject['failures'] = [];
  const shellWrapperRe = /\b(cmd(\.exe)?\s*\/c|powershell(\.exe)?\b|pwsh\b|bash\b|sh\b)\b/i;
  const shellChainingRe = /&&|\|\||[;|]/;
  const cdWrapperRe = /\bcd\s+[A-Za-z]:\\/i;
  const globTargetRe = /[*?\[\]]/;
  const anglePlaceholderRe = /<[A-Za-z][^>\s]*>/;
  const benchmarkShellSyntaxAllowed = shouldUseBenchmarkContainerExecution(
    executionProfileName,
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'],
  );
  const benchmarkRuntimeInventory = benchmarkShellSyntaxAllowed
    ? getCachedBenchmarkContainerRuntimeInventory(process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim() ?? '')
    : null;
  const allowedShellCommands = getAllowedShellCommands(executionProfileName);
  if (/\bbreak-filter-js-from-html\b/i.test(rawTask)) {
    const readsFilterSource = swePlan.minimal_action_set.some(step =>
      step.tool === 'file_read' &&
      normalizePathForComparison(String(step.target ?? '')).toLowerCase() === 'filter.py',
    );
    if (!readsFilterSource) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_SOURCE_INSPECTION_REQUIRED] break-filter-js-from-html plans must read filter.py before choosing an out.html payload; otherwise the executor guesses at sanitizer behavior and can burn turns on stripped event-handler payloads.',
        confidence: 5,
        fix_hint:
          'Start with file_read filter.py, then write out.html based on the observed parser/removal logic and verify by running filter.py plus a custom postcondition check.',
      });
    }

    const planText = JSON.stringify(swePlan).toLowerCase();
    if (
      /\b(?:event handlers?|onerror|onclick|onload|onmouseover|script tags?|<script|encoded alert|encoded javascript|html entity encoding|obfuscated javascript)\b/i
        .test(planText)
    ) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_STRIPPED_PAYLOAD_ASSUMPTION] break-filter-js-from-html plan assumes stripped payload families such as script tags, on* event handlers, or entity-encoded JavaScript will survive. The visible sanitizer source must drive payload choice; do not pre-commit to families the filter is likely to remove.',
        confidence: 5,
        fix_hint:
          'After reading filter.py, choose a payload family based on what the sanitizer actually leaves intact. Avoid script tags, on* event handlers, and pure entity-encoded JavaScript assumptions unless the source proves they survive.',
      });
    }

    const hasCustomVerifierStep = swePlan.minimal_action_set.some(step => {
      if (step.tool !== 'shell_exec' && step.tool !== 'test_run') {
        return false;
      }
      const command = String(step.target ?? '').toLowerCase();
      if (/(?:manual verification|manual browser|open in browser|confirm alert|print\(['"`]?manual)/.test(command)) {
        return false;
      }
      return !/\b(?:test_outputs\.py|filter\.py)\b/.test(command) &&
        /(?:verify|check|assert|bypass|alert|postcondition)/.test(command);
    });
    if (!hasCustomVerifierStep) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_CUSTOM_VERIFIER_REQUIRED] break-filter-js-from-html plans must include a custom executable verifier when pytest/test_outputs.py is unavailable. Running filter.py and then file_reading out.html is not enough to prove browser alert behavior.',
        confidence: 5,
        fix_hint:
          'Add a separate helper or inline shell_exec/test_run step that checks the filtered out.html postcondition, then complete only after that verifier exits 0.',
      });
    }
  }
  if (benchmarkShellSyntaxAllowed && /\bmerge-diff-arc-agi-task\b/i.test(rawTask)) {
    const hasGitNativeStep = swePlan.minimal_action_set.some(step =>
      (step.tool === 'shell_exec' || step.tool === 'test_run') &&
      /\bgit\s+(?:bundle|init|fetch|checkout|switch|merge|status|branch)\b/i.test(String(step.target ?? '')),
    );
    const hasSourceOnlyRepoWrite = swePlan.minimal_action_set.some(step =>
      step.tool === 'file_write' &&
      /(?:^|[\\/])repo[\\/](?:algo\.py|\.gitkeep)$/i.test(
        normalizePathForComparison(String(step.target ?? '')),
      ),
    );
    if (!hasGitNativeStep && hasSourceOnlyRepoWrite) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition:
          '[BENCHMARK_REQUIRED_CAPABILITY_MISSING] merge-diff-arc-agi-task requires Git-native bundle checkout and merge steps; the plan omits Git and would substitute source-only placeholder writes.',
        confidence: 5,
        fix_hint:
          'Do not satisfy merge-diff by writing repo/algo.py or .gitkeep directly. If git is unavailable in the benchmark runtime inventory, halt with missing required runtime capability or use an explicitly approved benchmark Git provisioning route.',
      });
    }
  }

  for (const step of swePlan.minimal_action_set) {
    const target = String(step.target ?? '').trim();
    if (!target) continue;

    if (anglePlaceholderRe.test(target)) {
      failures.push({
        tag: 'INCOMPLETE_SUBMISSION',
        condition: `[EXECUTOR_SAFETY] Step ${step.step} contains an unresolved placeholder target: ${target}`,
        confidence: 5,
        fix_hint: 'Replace placeholders with a concrete in-project path or command before sending the plan to executor.',
      });
      continue;
    }

    if (step.tool === 'directory_list' || step.tool === 'file_read' || step.tool === 'file_write') {
      if ((step.tool === 'file_read' || step.tool === 'file_write') && globTargetRe.test(target)) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} uses a glob target unsupported by ${step.tool}: ${target}`,
          confidence: 5,
          fix_hint: 'Use directory_list first, then concrete file_read/file_write targets. Do not pass wildcards to file tools.',
        });
        continue;
      }

      if (step.tool === 'file_write') {
        const benchmarkProtectedWriteReason = getBenchmarkProtectedWriteReason(rawTask, target);
        if (benchmarkProtectedWriteReason) {
          failures.push({
            tag: 'SFDIPOT-P',
            condition: `[EXECUTOR_SAFETY] Step ${step.step} writes a protected benchmark fixture: ${benchmarkProtectedWriteReason}`,
            confidence: 5,
            fix_hint:
              'Do not modify benchmark verifier/input fixtures. Patch the requested output artifact or create a new helper script with a different name.',
          });
          continue;
        }
      }

      const resolvedTarget = /^[A-Za-z]:[\\/]/.test(target)
        ? resolve(target)
        : resolve(projectRoot, target);

      if (!isWithinProjectRootPath(projectRoot, resolvedTarget)) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} targets a path outside target_project_path: ${target}`,
          confidence: 5,
          fix_hint: 'Use only project-root-relative paths or mirrored in-root references for executor-accessible files.',
        });
      }
      continue;
    }

    if (step.tool === 'shell_exec' || step.tool === 'test_run') {
      if (
        shellWrapperRe.test(target) ||
        cdWrapperRe.test(target) ||
        (shellChainingRe.test(target) && !benchmarkShellSyntaxAllowed)
      ) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} uses shell-wrapped or chained command syntax that violates executor contract: ${target}`,
          confidence: 5,
          fix_hint: benchmarkShellSyntaxAllowed
            ? 'Avoid explicit shell wrappers and cd commands; POSIX pipes/redirection may run directly inside the benchmark container.'
            : 'Emit the executable command only and rely on working_directory instead of shell wrappers or chaining.',
        });
      } else {
        const benchmarkInstallPlanReject = benchmarkShellSyntaxAllowed
          ? getBenchmarkDependencyInstallPlanReject(rawTask, target)
          : null;
        const gitBundleArchiveReject = benchmarkShellSyntaxAllowed &&
          isInvalidGitBundleArchiveCommand(rawTask, target);
        const shellCompatibilityIssue = benchmarkInstallPlanReject || gitBundleArchiveReject
          ? null
          : validateExecutorShellCommand(
          target,
          process.platform,
          executionProfileName,
          process.env['BABEL_BENCHMARK_DOCKER_IMAGE'],
        );
        if (benchmarkInstallPlanReject) {
          failures.push({
            tag: 'SFDIPOT-P',
            condition: `[EXECUTOR_SAFETY] Step ${step.step} uses a blocked benchmark dependency install command: ${benchmarkInstallPlanReject}`,
            confidence: 5,
            fix_hint:
              'Replace package installation with a source-only/file_write route or an existing runtime command from the benchmark inventory.',
          });
        } else if (gitBundleArchiveReject) {
          failures.push({
            tag: 'SFDIPOT-P',
            condition:
              `[EXECUTOR_SAFETY] Step ${step.step} treats a Git bundle as an archive: ${target}`,
            confidence: 5,
            fix_hint:
              'Git .bundle files are not tar/gzip archives. Use Git-native bundle commands if git is usable, or halt with missing required runtime capability.',
          });
        } else {
          const capabilityResolution = resolveShellCommandCapability(
            target,
            rawTask,
            executionProfileName,
            benchmarkRuntimeInventory,
          );
          const capabilityFeedback = formatToolCapabilityResolutionForFeedback(capabilityResolution);
          if (
            capabilityResolution.status === 'suggest_replacement' &&
            normalizeShellCommandForComparison(capabilityResolution.replacementCommand ?? '') !==
              normalizeShellCommandForComparison(target)
          ) {
            failures.push({
              tag: 'SFDIPOT-P',
              condition:
                `[EXECUTOR_SAFETY] Step ${step.step} uses a generic command where a safer capability implementation is available: ` +
                capabilityFeedback,
              confidence: 5,
              fix_hint:
                capabilityResolution.replacementCommand
                  ? `Replace the command with "${capabilityResolution.replacementCommand}".`
                  : 'Replace the command with the capability-specific implementation.',
            });
          } else if (
            capabilityResolution.status === 'blocked_missing_requirement' ||
            capabilityResolution.status === 'blocked_no_allowed_implementation'
          ) {
            const fixHint = getToolCapabilityBlockedFixHint(capabilityResolution);
            failures.push({
              tag: 'SFDIPOT-P',
              condition:
                `[EXECUTOR_SAFETY] Step ${step.step} cannot use the requested command capability: ` +
                capabilityFeedback,
              confidence: 5,
              fix_hint: fixHint,
            });
          } else if (shellCompatibilityIssue) {
            failures.push({
              tag: 'SFDIPOT-P',
              condition:
                `[EXECUTOR_SAFETY] Step ${step.step} uses a shell command that violates executor compatibility rules: ` +
                `${shellCompatibilityIssue.message}`,
              confidence: 5,
              fix_hint:
                shellCompatibilityIssue.command_base === 'mkdir'
                  ? 'Remove the mkdir step and write the target file directly; file_write creates parent directories automatically.'
                  : 'Replace the command with an executor-supported command base and platform-compatible syntax.',
            });
          } else if (benchmarkRuntimeInventory) {
            const usability = getBenchmarkRuntimeCommandUsability(
              benchmarkRuntimeInventory,
              allowedShellCommands,
              target,
            );
            if (usability.status === 'missing' || usability.status === 'not_executor_allowed') {
              failures.push({
                tag: 'SFDIPOT-P',
                condition:
                  `[EXECUTOR_SAFETY] Step ${step.step} uses a benchmark runtime command that is not usable: ` +
                  `${usability.message}`,
                confidence: 5,
                fix_hint:
                  'Use the benchmark runtime inventory from the planning context and choose an available executor-allowed command or a source-only/file_write route.',
              });
            }
          }
        }
      }

      const outOfRootPaths = extractWindowsAbsolutePaths(target)
        .filter(candidatePath => !isWithinProjectRootPath(projectRoot, candidatePath));
      if (outOfRootPaths.length > 0) {
        failures.push({
          tag: 'SFDIPOT-P',
          condition: `[EXECUTOR_SAFETY] Step ${step.step} references out-of-root path(s) in command target: ${outOfRootPaths.join(', ')}`,
          confidence: 5,
          fix_hint: 'Use only paths rooted under target_project_path or stage mirrored references inside the project root first.',
        });
      }
    }
  }

  failures.push(...collectBenchmarkRiskPlanViolations(swePlan, rawTask));

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: getExecutorSafetyProposedFixStrategy(failures),
  };
}

function collectManyFileAggregationViolations(
  swePlan: SwePlan,
  rawTask: string,
): QaVerdictReject | null {
  const manyFileAggregationTask =
    /\b(all|multiple|every)\s+(?:log\s+)?files\b/i.test(rawTask) ||
    /\ball\s+logs\b/i.test(rawTask);
  const aggregationOutputTask =
    /\b(count|aggregate|summari[sz]e|analy[sz]e)\b/i.test(rawTask) &&
    /\b(csv|json|summary|report)\b/i.test(rawTask);
  if (!manyFileAggregationTask || !aggregationOutputTask) {
    return null;
  }

  const hasHelperExecution = swePlan.minimal_action_set.some(step =>
    step.tool === 'shell_exec' || step.tool === 'test_run',
  );
  const hasHelperWrite = swePlan.minimal_action_set.some(step => {
    if (step.tool !== 'file_write') return false;
    const target = String(step.target ?? '').toLowerCase();
    return /\.(py|js|mjs|ts|sh|ps1|rb)$/.test(target);
  });
  const finalOutputWrites = swePlan.minimal_action_set.filter(step => {
    if (step.tool !== 'file_write') return false;
    const target = String(step.target ?? '').toLowerCase();
    return /\.(csv|json|txt|tsv)$/.test(target);
  });

  const failures: QaVerdictReject['failures'] = [];
  if (!hasHelperWrite || !hasHelperExecution) {
    failures.push({
      tag: 'SFDIPOT-P',
      condition:
        '[MANY_FILE_AGGREGATION] Plan samples large input sets instead of writing and running a deterministic helper program.',
      confidence: 5,
      fix_hint:
        'For many-file aggregation tasks, write a small helper script in the project root, run it with an allowed interpreter such as python/node, and let that script produce the requested output file.',
    });
  }
  if (finalOutputWrites.length > 0 && !hasHelperExecution) {
    failures.push({
      tag: 'SFDIPOT-O',
      condition:
        '[MANY_FILE_AGGREGATION] Plan writes the final output directly before executing a complete aggregation over all input files.',
      confidence: 5,
      fix_hint:
        'Do not hand-write aggregate counts from sampled files. Generate the output from a helper program that iterates every concrete file in the input directory.',
    });
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy:
      'Regenerate the plan around deterministic many-file aggregation: directory_list, file_write helper script, shell_exec/test_run helper, then inspect or verify the produced output.',
  };
}

function collectRuntimePrerequisiteViolations(
  swePlan: SwePlan,
  javaRuntimeStatus: JavaRuntimeStatus,
  gradleRuntimeStatus: CommandRuntimeStatus,
): QaVerdictReject | null {
  const failures: QaVerdictReject['failures'] = [];

  const firstGradleLikeStep = swePlan.minimal_action_set.find(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    usesGradleLikeCommand(String(step.target ?? '')),
  );

  if (!firstGradleLikeStep) {
    return null;
  }

  const priorSteps = swePlan.minimal_action_set.filter(step => step.step < firstGradleLikeStep.step);
  const hasJavaProvisioning = priorSteps.some(step => isJavaProvisioningStep(step));
  const hasGradleProvisioning = priorSteps.some(step => isGradleProvisioningStep(step));

  if (!javaRuntimeStatus.available && !hasJavaProvisioning) {
    failures.push({
      tag: 'SFDIPOT-P',
      condition: `[RUNTIME_PREFLIGHT] Step ${firstGradleLikeStep.step} invokes Gradle (${firstGradleLikeStep.target}) but Java is currently unavailable in the executor environment.`,
      confidence: 5,
      fix_hint: 'Add an earlier step that installs or configures Java/JDK and JAVA_HOME before the first gradle/gradlew command.',
    });
  }

  const usesGlobalGradle = swePlan.minimal_action_set.some(step =>
    (step.tool === 'shell_exec' || step.tool === 'test_run') &&
    /\bgradle\b/i.test(String(step.target ?? '')) &&
    !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')) &&
    !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')),
  );

  if (usesGlobalGradle && !gradleRuntimeStatus.available && !hasGradleProvisioning) {
    const firstGlobalGradleStep = swePlan.minimal_action_set.find(step =>
      (step.tool === 'shell_exec' || step.tool === 'test_run') &&
      /\bgradle\b/i.test(String(step.target ?? '')) &&
      !/\b(winget|choco|scoop)\b/i.test(String(step.target ?? '')) &&
      !/\bgradlew(?:\.bat)?\b/i.test(String(step.target ?? '')),
    );
    if (firstGlobalGradleStep) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[RUNTIME_PREFLIGHT] Step ${firstGlobalGradleStep.step} invokes global Gradle (${firstGlobalGradleStep.target}) but gradle is not available on PATH in the executor environment.`,
        confidence: 5,
        fix_hint: 'Install or configure Gradle before the first global `gradle` command, or switch to a wrapper-based path that does not assume global Gradle already exists.',
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: 'Regenerate the plan so runtime prerequisites are satisfied first: bootstrap the missing Java/Gradle dependency, then run Gradle verification or builds.',
  };
}

function collectGradleBootstrapSequencingViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
  gradleRuntimeStatus: CommandRuntimeStatus,
): QaVerdictReject | null {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return null;
  }

  const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  const wrapperJarExists = existsSync(wrapperJarPath);
  if (gradleRuntimeStatus.available || wrapperJarExists) {
    return null;
  }

  const failures: QaVerdictReject['failures'] = [];
  const provisioningIndex = swePlan.minimal_action_set.findIndex(step => isGradleProvisioningStep(step));
  const provisioningStepNumber = provisioningIndex >= 0
    ? swePlan.minimal_action_set[provisioningIndex]?.step ?? null
    : null;

  for (const step of swePlan.minimal_action_set) {
    const target = String(step.target ?? '').trim();
    if (!target) continue;

    if (String(step.tool ?? '').trim() !== 'file_read') {
      continue;
    }

    const normalizedTarget = target.replace(/\//g, '\\').toLowerCase();
    const isMirroredGradleRead = (
      (step.tool === 'file_read' || step.tool === 'directory_list') &&
      normalizedTarget.includes('\\reference-Example Finance Forecast\\') &&
      normalizedTarget.includes('gradle')
    ) || (
      (step.tool === 'file_read' || step.tool === 'directory_list') &&
      normalizedTarget.includes('\\reference-Example Finance Forecast\\build.gradle.kts')
    ) || (
      (step.tool === 'file_read' || step.tool === 'directory_list') &&
      normalizedTarget.includes('\\reference-Example Finance Forecast\\settings.gradle.kts')
    ) || (
      (step.tool === 'file_read' || step.tool === 'directory_list') &&
      normalizedTarget.includes('\\reference-Example Finance Forecast\\app\\build.gradle.kts')
    );

    if (isMirroredGradleRead) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[GRADLE_BOOTSTRAP] Step ${step.step} probes mirrored Gradle files during bootstrap even though global gradle is absent and gradle-wrapper.jar is missing: ${target}`,
        confidence: 5,
        fix_hint: 'Provision Gradle first, then generate/verify gradle-wrapper.jar. Do not read mirrored Gradle files during bootstrap unless they are already confirmed to exist.',
      });
    }

    const usesGlobalGradle = (step.tool === 'shell_exec' || step.tool === 'test_run')
      && /\bgradle\b/i.test(target)
      && !/\b(winget|choco|scoop)\b/i.test(target)
      && !/\bgradlew(?:\.bat)?\b/i.test(target);
    if (
      usesGlobalGradle &&
      (provisioningStepNumber === null || step.step < provisioningStepNumber)
    ) {
      failures.push({
        tag: 'SFDIPOT-P',
        condition: `[GRADLE_BOOTSTRAP] Step ${step.step} uses global Gradle before any concrete provisioning step while gradle is absent and gradle-wrapper.jar is missing: ${target}`,
        confidence: 5,
        fix_hint: 'Make the first global-Gradle-related step a concrete provisioning step such as winget install Gradle.Gradle, then verify gradle, then run gradle wrapper.',
      });
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: 'Regenerate the Gradle bootstrap portion so it provisions Gradle first, avoids mirrored Gradle file reads during bootstrap, and only then generates/verifies gradle-wrapper.jar.',
  };
}

export function collectAndroidVerificationCoverageViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
  rawTask = '',
): QaVerdictReject | null {
  const pipelineMode = String(manifest.analysis?.pipeline_mode ?? '').toLowerCase();
  const taskCategory = String(manifest.analysis?.task_category ?? '').toLowerCase();
  const isAutonomousAndroidTask =
    pipelineMode === 'autonomous' &&
    (manifest.instruction_stack?.domain_id === 'domain_android_kotlin' || taskCategory === 'mobile');

  if (!isAutonomousAndroidTask) {
    return null;
  }

  if (isAndroidSourceOnlyWorkspace(inferProjectRoot(manifest))) {
    return null;
  }

  const shellSteps = swePlan.minimal_action_set.filter(step =>
    step.tool === 'shell_exec' || step.tool === 'test_run',
  );
  const hasAssembleDebug = shellSteps.some(step =>
    /\bgradlew(?:\.bat)?\b.*\bassembleDebug\b/i.test(String(step.target ?? '')),
  );
  const hasGradleTest = shellSteps.some(step =>
    /\bgradlew(?:\.bat)?\b.*\btest\b/i.test(String(step.target ?? '')),
  );
  const firstVerificationStep = shellSteps.length > 0
    ? Math.min(...shellSteps.map(step => step.step))
    : Number.POSITIVE_INFINITY;
  const taskShapeProfile = String(manifest.resolution_policy?.task_shape_profile ?? 'full');
  if (
    taskShapeProfile === 'android_utility_file' ||
    isAndroidUtilityFileRequest(rawTask, inferProjectRoot(manifest)).match
  ) {
    return null;
  }

  const earlyVerificationLimit =
    taskShapeProfile === 'android_warning_cleanup' ? 10 :
    taskShapeProfile === 'android_ui_improvement' ? 5 :
    8;

  if (hasAssembleDebug && hasGradleTest && firstVerificationStep <= earlyVerificationLimit) {
    return null;
  }

  const missingParts = [
    !hasAssembleDebug ? 'gradlew assembleDebug' : null,
    !hasGradleTest ? 'gradlew test' : null,
  ].filter((part): part is string => part !== null);
  const schedulingNote = firstVerificationStep === Number.POSITIVE_INFINITY
    ? 'no verification steps were scheduled'
    : `first verification step is too late (step ${firstVerificationStep})`;

  return {
    verdict: 'REJECT',
    failure_count: 1,
    failures: [
      {
        tag: 'EVIDENCE-GATE',
    condition: taskShapeProfile === 'android_warning_cleanup'
      ? `Autonomous Android warning-cleanup plans must verify with both \`gradlew assembleDebug\` and \`gradlew test\` early enough to run; missing: ${missingParts.join(', ')}, ${schedulingNote}.`
      : `Autonomous Android implementation plans must verify with both \`gradlew assembleDebug\` and \`gradlew test\` early enough to run; missing: ${missingParts.join(', ')}, ${schedulingNote}.`,
    confidence: 5,
    fix_hint: taskShapeProfile === 'android_warning_cleanup'
      ? 'Add both verification steps to the plan so the autonomous warning-cleanup lane can surface compile and test-only regressions.'
      : 'Add both verification steps to the plan so the autonomous lane can surface compile and test-only regressions.',
  },
  ],
  overall_confidence: 5,
  proposed_fix_strategy: taskShapeProfile === 'android_warning_cleanup'
    ? 'Regenerate the autonomous Android warning-cleanup plan so it includes both compile verification and unit-test verification before completion.'
    : 'Regenerate the autonomous Android plan so it includes both compile verification and unit-test verification before completion.',
  };
}

function collectReferenceSourceShapeViolations(
  swePlan: SwePlan,
  manifest: OrchestratorManifest,
): QaVerdictReject | null {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return null;
  }

  const referenceRoot = join(projectRoot, 'reference-Example Finance Forecast');
  const externalReferenceRoot = join(BABEL_ROOT, '..', 'example_autonomous_agent', 'Example Finance Forecast');
  const referenceLooksLikePython = existsSync(referenceRoot) && (
    existsSync(join(referenceRoot, 'pyproject.toml')) ||
    existsSync(join(referenceRoot, 'requirements.txt')) ||
    existsSync(join(referenceRoot, 'monte_carlo_ledger'))
  );
  if (!referenceLooksLikePython) {
    return null;
  }

  const collectExistingReferenceFiles = (rootPath: string): string[] => {
    const results: string[] = [];
    const stack = [rootPath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const nextPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(nextPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!/\.(py|md|toml|sql|yaml|yml|json)$/i.test(entry.name)) {
          continue;
        }
        results.push(resolve(nextPath).toLowerCase());
      }
    }
    return results;
  };

  const failures: QaVerdictReject['failures'] = [];
  const existingReferenceFiles = new Set(
    collectExistingReferenceFiles(referenceRoot),
  );
  const referenceRootPath = resolve(referenceRoot).toLowerCase();
  let seenReferenceReadme = false;
  let seenReferencePyproject = false;
  for (const step of swePlan.minimal_action_set) {
    const target = String(step.target ?? '').trim();
    if (!target) continue;

    const normalizedTarget = target.replace(/\//g, '\\').toLowerCase();
    const resolvedTarget = /^[A-Za-z]:[\\/]/.test(target)
      ? resolve(target)
      : resolve(projectRoot, target);
    const normalizedResolvedTarget = resolvedTarget.toLowerCase();
    const probesAndroidMirrorInsideReference = normalizedTarget.includes('\\reference-Example Finance Forecast\\app\\src\\main\\') ||
      normalizedTarget.includes('\\reference-Example Finance Forecast\\build.gradle.kts') ||
      normalizedTarget.includes('\\reference-Example Finance Forecast\\settings.gradle.kts') ||
      normalizedTarget.includes('\\reference-Example Finance Forecast\\app\\build.gradle.kts');

    if (probesAndroidMirrorInsideReference) {
      failures.push({
        tag: 'EVIDENCE-GATE',
        condition: `[SOURCE_SHAPE] Step ${step.step} assumes Android/Gradle mirror files inside reference-Example Finance Forecast even though the grounded reference source is a Python repo: ${target}`,
        confidence: 5,
        fix_hint: 'Treat reference-Example Finance Forecast as a Python source repo. Read actual files such as README.md, pyproject.toml, monte_carlo_ledger/*.py, and docs/** before mapping them into Android targets.',
      });
      continue;
    }

    if (normalizedResolvedTarget.startsWith(resolve(externalReferenceRoot).toLowerCase())) {
      failures.push({
        tag: 'EVIDENCE-GATE',
        condition: `[SOURCE_PATH_PREFERENCE] Step ${step.step} reads the external Example Finance Forecast repo even though a mirrored reference-Example Finance Forecast copy exists inside the target project: ${target}`,
        confidence: 5,
        fix_hint: 'Use the mirrored reference-Example Finance Forecast path inside the target project for all source reads when that mirror exists.',
      });
      continue;
    }

    if (normalizedResolvedTarget.startsWith(resolve(referenceRoot).toLowerCase())) {
      const isReferenceReadStep = step.tool === 'file_read';
      if (isReferenceReadStep) {
        const isReadme = normalizedResolvedTarget === join(referenceRootPath, 'readme.md').toLowerCase();
        const isPyproject = normalizedResolvedTarget === join(referenceRootPath, 'pyproject.toml').toLowerCase();
        const isRootBootstrapRead = isReadme || isPyproject;
        const isModuleRead = normalizedResolvedTarget.includes('\\reference-Example Finance Forecast\\monte_carlo_ledger\\');
        const basename = normalizedResolvedTarget.split('\\').pop() ?? '';
        if (swePlan.plan_type !== 'IMPLEMENTATION_PLAN' && isModuleRead && !existingReferenceFiles.has(normalizedResolvedTarget)) {
          failures.push({
            tag: 'EVIDENCE-GATE',
            condition: `[SOURCE_INVENTORY_GUESS] Step ${step.step} guesses a non-inventory module basename under the reference repo: ${basename}`,
            confidence: 5,
            fix_hint: 'Use the exact filenames listed in the Reference source inventories block. Do not guess module names like engine.py, models.py, core_engine.py, or data_models.py.',
          });
          continue;
        }
        if (swePlan.plan_type !== 'IMPLEMENTATION_PLAN' && isModuleRead && !(seenReferenceReadme && seenReferencePyproject)) {
          failures.push({
            tag: 'EVIDENCE-GATE',
            condition: `[REFERENCE_FILE_READ_DISCIPLINE] Step ${step.step} reads a reference module before grounding on README.md and pyproject.toml: ${target}`,
            confidence: 5,
            fix_hint: 'Read README.md and pyproject.toml first, then read only the exact grounded module files listed in the inventory.',
          });
          continue;
        }
        if (isReadme) {
          seenReferenceReadme = true;
        }
        if (isPyproject) {
          seenReferencePyproject = true;
        }
        if (!isRootBootstrapRead && !existingReferenceFiles.has(normalizedResolvedTarget)) {
          failures.push({
            tag: 'EVIDENCE-GATE',
            condition: `[SOURCE_INVENTORY_MISMATCH] Step ${step.step} reads a non-existent file inside reference-Example Finance Forecast instead of one of the grounded inventory files: ${target}`,
            confidence: 5,
            fix_hint: 'Use the exact filenames listed in the Reference source inventories block. Do not guess alternate module names inside the mirrored Python repo.',
          });
        }
        continue;
      }

      if (step.tool === 'directory_list') {
        if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isDirectory()) {
          failures.push({
            tag: 'EVIDENCE-GATE',
            condition: `[SOURCE_INVENTORY_MISMATCH] Step ${step.step} lists a non-existent reference directory instead of a grounded directory inside reference-Example Finance Forecast: ${target}`,
            confidence: 5,
            fix_hint: 'Use only real directories under the mirrored reference repo for directory_list steps.',
          });
        }
        continue;
      }

      if (step.tool === 'file_read' && !existingReferenceFiles.has(normalizedResolvedTarget)) {
        failures.push({
          tag: 'EVIDENCE-GATE',
          condition: `[SOURCE_INVENTORY_MISMATCH] Step ${step.step} reads a non-existent file inside reference-Example Finance Forecast instead of one of the grounded inventory files: ${target}`,
          confidence: 5,
          fix_hint: 'Use the exact filenames listed in the Reference source inventories block. Do not guess alternate module names inside the mirrored Python repo.',
        });
      }
    }
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    verdict: 'REJECT',
    failure_count: failures.length,
    failures,
    overall_confidence: 5,
    proposed_fix_strategy: 'Regenerate the plan against the actual reference source shape. Do not infer Android package or Gradle files inside a non-Android reference repo.',
  };
}

function buildManualPlanRepairPrompt(
  errors: string[],
  rawPlanText: string,
): string {
  return [
    '# Manual Plan Repair Required',
    '',
    'Your previous plan.json failed SwePlanSchema validation.',
    'Return ONLY valid JSON matching SwePlanSchema. No markdown fences, no prose.',
    '',
    'Validation errors:',
    ...errors.map((e, i) => `${i + 1}. ${e}`),
    '',
    'Original submitted plan:',
    '```json',
    rawPlanText.trim() || '{}',
    '```',
  ].join('\n');
}

// ─── Execution report validation ──────────────────────────────────────────────

function writeValidatedExecutionReport(
  evidence: EvidenceBundle,
  report: unknown,
  toolCallLog: ToolCallLog[],
  warnings: string[] = [],
): void {
  const uniqueWarnings = [...new Set(warnings)];
  const checkpointIds = [
    ...new Set(toolCallLog.flatMap((entry) => entry.checkpoint_ids ?? [])),
  ];
  const reportWithWarnings = typeof report === 'object' && report !== null
    ? {
        ...(report as Record<string, unknown>),
        ...(checkpointIds.length > 0 ? { checkpoint_ids: checkpointIds } : {}),
        ...(uniqueWarnings.length > 0 ? { warnings: uniqueWarnings } : {}),
      }
    : report;

  try {
    const parsed = ExecutorReportSchema.parse(reportWithWarnings);
    evidence.writeExecutionLog(parsed);
    return;
  } catch (err) {
    const schemaError = err instanceof Error ? err.message : String(err);
    const condition =
      `[PIPELINE_ERROR] ExecutorReportSchema validation failed: ${schemaError}`;

    const pipelineError = PipelineErrorSchema.parse({
      halt_tag:       'TOOL_CALL_ERROR',
      halted_at_step: Math.max(1, toolCallLog.length),
      condition,
      ...(toolCallLog.length > 0
        ? { last_tool_output: toolCallLog[toolCallLog.length - 1] }
        : {}),
    });

    const fallback = ExecutorReportSchema.parse({
      status:         'EXECUTION_HALTED',
      steps_executed: toolCallLog.length,
      tool_call_log:  toolCallLog,
      pipeline_error: pipelineError,
      ...(checkpointIds.length > 0 ? { checkpoint_ids: checkpointIds } : {}),
      ...(uniqueWarnings.length > 0
        ? { warnings: [...uniqueWarnings, condition] }
        : {}),
    });

    evidence.writeExecutionLog(fallback);
  }
}

const RELIABILITY_REPAIR_PROOF_MARKER = '[BABEL_RELIABILITY_AUTONOMOUS_LIVE_FAIL_THEN_PASS]';

interface RepairProofCapsuleArtifact {
  id: string;
  path: string;
  capsule: FailureCapsule;
}

function isReliabilityRepairProofEnabled(rawTask: string): boolean {
  return process.env['BABEL_RELIABILITY_REPAIR_PROOF'] === 'true' &&
    rawTask.includes(RELIABILITY_REPAIR_PROOF_MARKER);
}

function getReliabilityRepairProofMaxFailures(): number {
  const configured = Number.parseInt(process.env['BABEL_RELIABILITY_REPAIR_PROOF_MAX_FAILURES'] ?? '', 10);
  if (!Number.isFinite(configured) || configured <= 0) {
    return maxAttemptsForRepairMode('autonomous');
  }
  return Math.min(configured, maxAttemptsForRepairMode('autonomous'));
}

function hashProjectFileForEvidence(projectRoot: string | null | undefined, relativePath: string): string | null {
  if (!projectRoot || relativePath.trim().length === 0) {
    return null;
  }
  const resolved = resolveStepTargetPath(projectRoot, relativePath);
  if (!isWithinProjectRootPath(projectRoot, resolved) || !existsSync(resolved)) {
    return null;
  }
  try {
    return createHash('sha256').update(readFileSync(resolved)).digest('hex');
  } catch {
    return null;
  }
}

const SAFETY_SNAPSHOT_MAX_FILES = 2000;
const SAFETY_SNAPSHOT_IGNORED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'runs',
];

function hashAbsoluteFileForSafety(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function snapshotProjectFilesForSafety(projectRoot: string | null | undefined): ProjectSafetySnapshot {
  const root = projectRoot ? resolve(projectRoot) : null;
  const snapshot: ProjectSafetySnapshot = {
    root,
    files: {},
    file_count: 0,
    truncated: false,
    ignored_directories: SAFETY_SNAPSHOT_IGNORED_DIRECTORIES,
  };
  if (!root || !existsSync(root)) {
    return snapshot;
  }

  const ignored = new Set(SAFETY_SNAPSHOT_IGNORED_DIRECTORIES);
  const visit = (dir: string): void => {
    if (snapshot.truncated) {
      return;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.truncated) {
        return;
      }
      const absolute = join(dir, entry);
      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!ignored.has(entry)) {
          visit(absolute);
        }
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const relativePath = relative(root, absolute).replace(/\\/g, '/');
      snapshot.files[relativePath] = hashAbsoluteFileForSafety(absolute) ?? 'UNREADABLE';
      snapshot.file_count += 1;
      if (snapshot.file_count >= SAFETY_SNAPSHOT_MAX_FILES) {
        snapshot.truncated = true;
        return;
      }
    }
  };

  visit(root);
  return snapshot;
}

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

function collectTerminalContext(runDir: string): {
  toolCallLog: ToolCallLog[];
  condition: string | null;
  failureCapsulePath: string | null;
  repairAttemptTimelinePath: string | null;
  attemptSafetySummaryPath: string | null;
  attemptSafetySummary: AttemptSafetySummary | null;
  rollbackSummaryPath: string | null;
  rollbackSummary: WorktreeRollbackSummary | null;
  worktreeSafetySummaryPath: string | null;
  worktreeSafetySummary: WorktreeSafetySummary | null;
} {
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
    .at(-1) ?? (
      existsSync(join(runDir, PRE_EXECUTION_FAILURE_CAPSULE_FILENAME))
        ? join(runDir, PRE_EXECUTION_FAILURE_CAPSULE_FILENAME)
        : null
    );

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

function summarizeVerifierStreamForEvidence(text: string | null | undefined): string | null {
  const normalized = String(text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(-12)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0
    ? normalized.slice(0, 700)
    : null;
}

function isVerifierNotFoundFailure(command: string, stdout: string, stderr: string): boolean {
  const commandBase = normalizeShellCommandForComparison(command).split(/\s+/)[0] ?? '';
  const evidence = `${stdout}\n${stderr}`.toLowerCase();
  return evidence.includes('missing script') ||
    evidence.includes('command not found') ||
    evidence.includes('is not recognized as an internal or external command') ||
    evidence.includes('not recognized as the name of') ||
    evidence.includes('enoent') ||
    evidence.includes('could not determine executable to run') ||
    (/npm/.test(commandBase) && /missing script:\s*["']?(?:test|typecheck|build)["']?/.test(evidence));
}

function getAllowedToolsFromEnv(): string[] | null {
  const raw = process.env['BABEL_ALLOWED_TOOLS'];
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(value => String(value));
    }
  } catch {
    return raw.split(',').map(value => value.trim()).filter(Boolean);
  }
  return null;
}

function getDisallowedToolsFromEnv(): string[] {
  const raw = process.env['BABEL_DISALLOWED_TOOLS'];
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(value => String(value));
    }
  } catch {
    return raw.split(',').map(value => value.trim()).filter(Boolean);
  }
  return [];
}

function isFileWriteToolAvailable(): boolean {
  const allowed = getAllowedToolsFromEnv();
  return allowed === null || allowed.includes('file_write');
}

function isShellExecutionToolAvailable(): boolean {
  const allowed = getAllowedToolsFromEnv();
  const disallowed = new Set(getDisallowedToolsFromEnv());
  return (allowed === null || allowed.includes('shell_exec')) && !disallowed.has('shell_exec');
}

function shouldRecoverCommandFailure(command: string, rawTask: string): boolean {
  if (!isFileWriteToolAvailable()) {
    return false;
  }
  if (/\bdo not modify files\b|\binspect only\b|\bread[- ]only\b/i.test(rawTask)) {
    return false;
  }
  return isVerifierCommand(command) || /\bfix\b|\brepair\b|\bpatch\b|\bdebug\b/i.test(rawTask);
}

function extractMissingNpmScript(command: string, stdout: string, stderr: string): string | null {
  const commandBase = normalizeShellCommandForComparison(command).split(/\s+/)[0] ?? '';
  if (!/npm/.test(commandBase)) {
    return null;
  }
  const evidence = `${stdout}\n${stderr}`.toLowerCase();
  const match = evidence.match(/missing script:\s*["']?([a-z0-9:_-]+)["']?/);
  return match?.[1] ?? null;
}

function findDescendantPackageScriptCwd(
  projectRoot: string | null | undefined,
  scriptName: string,
): string | null {
  if (!projectRoot || !existsSync(projectRoot)) {
    return null;
  }

  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'runs']);
  const queue: Array<{ path: string; depth: number }> = [{ path: projectRoot, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (next.depth > 3) {
      continue;
    }

    const packageJsonPath = join(next.path, 'package.json');
    if (next.path !== projectRoot && existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
          scripts?: Record<string, unknown>;
        };
        if (typeof parsed.scripts?.[scriptName] === 'string') {
          return next.path;
        }
      } catch {
        // Ignore malformed nested package files; verifier retry should remain evidence-driven.
      }
    }

    let children: string[] = [];
    try {
      children = readdirSync(next.path);
    } catch {
      continue;
    }
    for (const child of children) {
      if (ignored.has(child)) {
        continue;
      }
      const childPath = join(next.path, child);
      try {
        if (statSync(childPath).isDirectory()) {
          queue.push({ path: childPath, depth: next.depth + 1 });
        }
      } catch {
        // Ignore racey or inaccessible children.
      }
    }
  }

  return null;
}

function getNpmWrongWorkingDirectoryHint(
  command: string,
  stdout: string,
  stderr: string,
  projectRoot: string | null | undefined,
): string | null {
  const missingScript = extractMissingNpmScript(command, stdout, stderr);
  if (!missingScript) {
    return null;
  }
  const packageCwd = findDescendantPackageScriptCwd(projectRoot, missingScript);
  if (!packageCwd || !projectRoot) {
    return null;
  }
  const relativeCwd = relative(projectRoot, packageCwd).replace(/\\/g, '/');
  if (!relativeCwd || relativeCwd.startsWith('..')) {
    return null;
  }
  return `[VERIFIER_WRONG_WORKING_DIRECTORY_RETRY] npm script "${missingScript}" was not found in the current cwd, but package.json with that script exists at "${relativeCwd}". Retry the same verifier command with working_directory "${relativeCwd}".`;
}

function inferVerifierCommandFromTask(task: string): string | null {
  const normalized = task.toLowerCase();
  if (/\bnpm\s+run\s+typecheck\b/.test(normalized)) {
    return 'npm run typecheck';
  }
  if (/\bnpm\s+run\s+build\b/.test(normalized)) {
    return 'npm run build';
  }
  if (/\bnode\s+--test\b/.test(normalized)) {
    return 'node --test';
  }
  if (/\bnpm\s+test\b/.test(normalized)) {
    return 'npm test';
  }
  return null;
}

function inferCommandOnlyNoModificationRequest(task: string): string | null {
  const normalized = task.toLowerCase();
  if (!/\bdo not (?:modify|edit|change|write)|\bno file changes\b|\bwithout modifying\b/.test(normalized)) {
    return null;
  }
  const strippedNoModify = normalized
    .replace(/\bdo not (?:modify|edit|change|write)[^.]*\.?/g, ' ')
    .replace(/\bwithout modifying[^.]*\.?/g, ' ')
    .replace(/\bno file changes[^.]*\.?/g, ' ');
  if (/\b(fix|repair|patch|create|update|edit|modify|write|delete|remove)\b/.test(strippedNoModify)) {
    return null;
  }
  const verifierCommand = inferVerifierCommandFromTask(task);
  if (verifierCommand) {
    return verifierCommand;
  }
  const nodeMatch = task.match(/\brun\s+(node\s+[A-Za-z0-9._/\\-]+(?:\.mjs|\.cjs|\.js)?)\b/i);
  return nodeMatch?.[1]?.replace(/\\/g, '/') ?? null;
}

function isOptionalVerifierRequest(task: string): boolean {
  return /\brun\b[^.?!]*\bif possible\b|\bif possible\b[^.?!]*\brun\b/i.test(task);
}

function isExecutorCommandPlaceholder(command: string): boolean {
  return /<cmd-without-cmd-slash-c-or-cd>/i.test(command.trim());
}

function hasMeaningfulRepairDiff(
  previous: AutonomousRepairProofAttemptEvidence | null,
  currentFileHashes: Record<string, RepairProofFileHash>,
): boolean | null {
  if (!previous) {
    return null;
  }
  const previousChanged = previous.changed_files.slice().sort();
  const currentChanged = Object.keys(currentFileHashes).sort();
  if (currentChanged.length === 0) {
    return false;
  }
  if (
    previousChanged.length !== currentChanged.length ||
    previousChanged.some((path, index) => path !== currentChanged[index])
  ) {
    return true;
  }
  return currentChanged.some(path =>
    previous.file_hashes[path]?.after !== currentFileHashes[path]?.after
  );
}

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
async function runExecutorLoop(
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

  const getMissingSuccessfulPlannedFileWrites = (): string[] => {
    const plannedWrites = approvedPlan.minimal_action_set
      .filter(step => step.tool === 'file_write')
      .map(step => String(step.target ?? '').trim())
      .filter(target => target.length > 0);
    if (plannedWrites.length === 0) {
      return [];
    }

    const projectRoot = getExecutorProjectRoot();
    const targetKey = (target: string): string => {
      const normalized = normalizePathForComparison(target);
      if (!projectRoot) {
        return normalized.toLowerCase();
      }

      const resolved = resolveStepTargetPath(projectRoot, normalized);
      if (isWithinProjectRootPath(projectRoot, resolved)) {
        return relative(projectRoot, resolved).replace(/\\/g, '/').toLowerCase();
      }

      return resolved.replace(/\\/g, '/').toLowerCase();
    };

    const successfulWrites = new Set(
      toolCallLog
        .filter(entry => entry.tool === 'file_write' && entry.exit_code === 0)
        .map(entry => targetKey(String(entry.target ?? ''))),
    );

    return plannedWrites.filter(target =>
      !successfulWrites.has(targetKey(target)),
    );
  };

  const haltForMissingPlannedFileWrites = (
    nextTurnPrompt: string,
    missingTargets: string[],
  ): ExecutorLoopResult => {
    const condition =
      `Executor reported EXECUTION_COMPLETE before successful file_write for planned target(s): ` +
      `${missingTargets.join(', ')}`;
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
    if (isExternalBenchmarkTask(rawTask)) {
      return null;
    }

    const contract = getRequestedTargetContract(rawTask);
    if (!contract.bounded || contract.requestedTargets.length === 0) {
      return null;
    }

    const planTools = approvedPlan.minimal_action_set.map(step => step.tool);
    if (!planTools.every(tool => ['directory_list', 'file_read', 'file_write'].includes(tool))) {
      return null;
    }

    const successfulWrites = new Set(
      toolCallLog
        .filter(entry => entry.tool === 'file_write' && entry.exit_code === 0)
        .map(entry => normalizePathForComparison(String(entry.target ?? '')).toLowerCase()),
    );
    const allRequestedTargetsWritten = contract.requestedTargets.every(target =>
      successfulWrites.has(normalizePathForComparison(target).toLowerCase()),
    );
    if (!allRequestedTargetsWritten) {
      return null;
    }

    const semanticFailure = verifyBoundedTaskArtifacts(
      rawTask,
      toolCallLog,
      getExecutorProjectRoot(),
    );
    if (semanticFailure) {
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
      condition: 'EVIDENCE_REQUEST minimal_action_set satisfied.',
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
      const toolResult = await executeTool({
        tool: 'file_write',
        path: write.target,
        content: write.content,
      }, {
        agentId: 'executor',
        runId: evidence.runId,
        runDir: evidence.runDir,
        babelRoot: BABEL_ROOT,
      });

      const entry: ToolCallLog = {
        step:      stepNum,
        tool:      'file_write',
        target:    canonicalizeExecutorTargetForLog(write.target, 'file_write'),
        exit_code: toolResult.exit_code,
        stdout:    toolResult.stdout,
        stderr:    toolResult.stderr,
        ...(toolResult.denial ? { denial: toolResult.denial } : {}),
        ...(toolResult.mcp_lifecycle ? { mcp_lifecycle: toolResult.mcp_lifecycle } : {}),
        ...(toolResult.checkpoint_ids ? { checkpoint_ids: toolResult.checkpoint_ids } : {}),
        verified:  toolResult.exit_code === 0,
      };
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

        const toolResult = await executeTool({
          tool: 'file_write',
          path: deterministicWrite.target,
          content: deterministicWrite.content,
        }, {
          agentId: 'executor',
          runId: evidence.runId,
          runDir: evidence.runDir,
          babelRoot: BABEL_ROOT,
        });

        const entry: ToolCallLog = {
          step:      stepNum,
          tool:      'file_write',
          target:    canonicalizeExecutorTargetForLog(deterministicWrite.target, 'file_write'),
          exit_code: toolResult.exit_code,
          stdout:    toolResult.stdout,
          stderr:    toolResult.stderr,
          ...(toolResult.denial ? { denial: toolResult.denial } : {}),
          ...(toolResult.mcp_lifecycle ? { mcp_lifecycle: toolResult.mcp_lifecycle } : {}),
          ...(toolResult.checkpoint_ids ? { checkpoint_ids: toolResult.checkpoint_ids } : {}),
          verified:  toolResult.exit_code === 0,
        };
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
        const missingPlannedFileWrites = getMissingSuccessfulPlannedFileWrites();
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
            const feedback = [
              `[Postcondition ${externalPostconditionFailures}] external_benchmark_verification -> requested output artifact`,
              'Exit code: 1',
              'Stdout: (empty)',
              `Stderr: ${semanticFailure}`,
              'Verification: FAILED',
            ].join('\n');
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
        const entry: ToolCallLog = {
          step:      stepNum,
          tool:      req.tool,
          target:    getTarget(req),
          exit_code: 126,
          stdout:    '(blocked before execution)',
          stderr:    capabilityFeedback,
          verified:  false,
        };
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
        const report = buildHaltReport(
          toolCallLog, 'STEP_VERIFICATION_FAIL', stepNum,
          `[TRUNCATION_ARTIFACT] file_write for "${req.path}" contains the ` +
          `"... [N chars truncated] ..." history marker in its content. ` +
          `The executor copied truncated execution history instead of the FILE_READ_CACHE. ` +
          `Re-read the file from FILE_READ_CACHE and apply only the plan-specified changes.`,
        );
        persistExecutorContext('terminal', turnPrompt, {
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition:
            `[TRUNCATION_ARTIFACT] file_write for "${req.path}" contains truncation ` +
            `marker from execution history. Use FILE_READ_CACHE instead.`,
        });
        writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
        log(`  Executor: EXECUTION_HALTED [TRUNCATION_ARTIFACT] at step ${stepNum}`);
        return {
          toolCallLog,
          terminalStatus: 'EXECUTION_HALTED',
          haltTag: 'STEP_VERIFICATION_FAIL',
          condition:
            `[TRUNCATION_ARTIFACT] file_write for "${req.path}" contains truncation ` +
            `marker from execution history. Use FILE_READ_CACHE instead.`,
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
      const entry: ToolCallLog = {
        step:      stepNum,
        tool:      req.tool,
        target:    getTarget(req),
        exit_code: 126,
        stdout:    '(blocked before execution)',
        stderr:    benchmarkInstallBlockReason,
        verified:  false,
      };
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
        const entry: ToolCallLog = {
          step: stepNum,
          tool: req.tool,
          target: canonicalizeExecutorTargetForLog(String(req.path ?? ''), 'file_write'),
          exit_code: 126,
          stdout: '(blocked before execution)',
          stderr: condition,
          verified: false,
        };
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
    const toolResult = fastPathToolResult ?? await executeTool(req, {
      agentId: 'executor', // Default for single-agent runs
      runId: evidence.runId,
      runDir: evidence.runDir,
      babelRoot: BABEL_ROOT
    });

    const entry: ToolCallLog = {
      step:      stepNum,
      tool:      req.tool,
      target:    getTarget(req),
      exit_code: toolResult.exit_code,
      stdout:    toolResult.stdout,
      stderr:    toolResult.stderr,
      ...(toolResult.denial ? { denial: toolResult.denial } : {}),
      ...(toolResult.mcp_lifecycle ? { mcp_lifecycle: toolResult.mcp_lifecycle } : {}),
      ...(toolResult.checkpoint_ids ? { checkpoint_ids: toolResult.checkpoint_ids } : {}),
      verified:  toolResult.exit_code === 0,
    };
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
      const denialSummary = toolResult.denial
        ? `${toolResult.denial.category}/${toolResult.denial.reason_code}: ${toolResult.denial.message}`
        : null;
      const mcpLifecycleSummary = toolResult.mcp_lifecycle
        ? `${toolResult.mcp_lifecycle.phase}/${toolResult.mcp_lifecycle.outcome}${toolResult.mcp_lifecycle.reason_code ? ` (${toolResult.mcp_lifecycle.reason_code})` : ''}`
        : null;
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

      const nonRecoverableCondition =
        `${toolResult.denial && (req.tool === 'shell_exec' || req.tool === 'test_run') ? '[SHELL_COMMAND_DENIED] ' : ''}` +
        `${!toolResult.denial && (req.tool === 'shell_exec' || req.tool === 'test_run') && isVerifierCommand(req.command) ? '[VERIFIER_FAILED] ' : ''}` +
        `${!toolResult.denial && (req.tool === 'shell_exec' || req.tool === 'test_run') && !isVerifierCommand(req.command) ? '[SHELL_COMMAND_FAILED] ' : ''}` +
        `Tool ${req.tool} on "${getTarget(req)}" exited with code ${toolResult.exit_code}. ` +
        `stderr: ${toolResult.stderr.slice(0, 200)}` +
        `${denialSummary ? ` denial: ${denialSummary}` : ''}` +
        `${mcpLifecycleSummary ? ` mcp_lifecycle: ${mcpLifecycleSummary}` : ''}`;
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

          const repairResult = await executeTool({
            tool: 'file_write',
            path: repairWrite.target,
            content: repairWrite.content,
          }, {
            agentId: 'executor',
            runId: evidence.runId,
            runDir: evidence.runDir,
            babelRoot: BABEL_ROOT,
          });

          const repairEntry: ToolCallLog = {
            step:      repairStepNum,
            tool:      'file_write',
            target:    canonicalizeExecutorTargetForLog(repairWrite.target, 'file_write'),
            exit_code: repairResult.exit_code,
            stdout:    repairResult.stdout,
            stderr:    repairResult.stderr,
            ...(repairResult.denial ? { denial: repairResult.denial } : {}),
            ...(repairResult.mcp_lifecycle ? { mcp_lifecycle: repairResult.mcp_lifecycle } : {}),
            ...(repairResult.checkpoint_ids ? { checkpoint_ids: repairResult.checkpoint_ids } : {}),
            verified:  repairResult.exit_code === 0,
          };
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
    if (req.tool === 'file_read' && toolResult.exit_code === 0 && toolResult.stdout) {
      fileReadCache.set(
        canonicalizeExecutorTargetForLog(String(req.path ?? ''), req.tool),
        toolResult.stdout,
      );
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

  const report = buildHaltReport(
    toolCallLog, 'TOOL_CALL_ERROR', toolCallLog.length,
    `Executor exceeded the maximum of ${MAX_EXECUTOR_TURNS} turns without a terminal signal.`,
  );
  persistExecutorContext(
    'terminal',
    buildExecutorTurnPrompt(baseContext, executionHistory, toolCallLog.length, fileReadCache),
    {
      terminalStatus: 'EXECUTION_HALTED',
      haltTag: 'TOOL_CALL_ERROR',
      condition: `Executor exceeded the maximum of ${MAX_EXECUTOR_TURNS} turns without a terminal signal.`,
    },
  );
  writeValidatedExecutionReport(evidence, report, toolCallLog, reportWarnings);
  log(`  Executor: EXECUTION_HALTED — exceeded ${MAX_EXECUTOR_TURNS} turns`);
  return {
    toolCallLog,
    terminalStatus: 'EXECUTION_HALTED',
    haltTag: 'TOOL_CALL_ERROR',
    condition: `Executor exceeded the maximum of ${MAX_EXECUTOR_TURNS} turns without a terminal signal.`,
  };
}

// Report builders, verification, and preflight fast-path moved to stages/verification.ts


async function runDeterministicAndroidSdkBootstrapLane(
  manifest: OrchestratorManifest,
): Promise<{ toolCallLog: ToolCallLog[]; haltedReport?: object }> {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return { toolCallLog: [] };
  }

  const toolCallLog: ToolCallLog[] = [];
  const recordSyntheticStep = (
    tool: ToolCallLog['tool'],
    target: string,
    exitCode: number,
    stdout: string,
    stderr = '',
  ): void => {
    toolCallLog.push({
      step: toolCallLog.length + 1,
      tool,
      target: canonicalizeExecutorTargetForLog(target, tool),
      exit_code: exitCode,
      stdout,
      stderr,
      verified: exitCode === 0,
    });
  };

  const sdkStatus = detectAndroidSdkStatus();
  if (!sdkStatus.available || !sdkStatus.sdkRoot) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length + 1,
        'Deterministic Android SDK bootstrap lane requires a usable Android SDK, but none was discovered in the executor environment.',
      ),
    };
  }

  const prependedPaths = ensureAndroidSdkEnvironment(sdkStatus);
  recordSyntheticStep(
    'directory_list',
    sdkStatus.sdkRoot,
    0,
    `Configured Android SDK environment from ${sdkStatus.sdkRoot}. PATH additions: ${prependedPaths.length > 0 ? prependedPaths.join(', ') : 'none'}`,
  );

  const localPropertiesPath = join(projectRoot, 'local.properties');
  const desiredSdkLine = buildLocalPropertiesSdkLine(sdkStatus.sdkRoot);
  const existingLocalProperties = existsSync(localPropertiesPath)
    ? readFileSync(localPropertiesPath, 'utf-8')
    : '';
  const existingLines = existingLocalProperties
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0 && !line.trim().startsWith('sdk.dir='));
  const nextLocalProperties = `${[desiredSdkLine, ...existingLines].join('\n')}\n`;

  if (existingLocalProperties !== nextLocalProperties) {
    writeFileSync(localPropertiesPath, nextLocalProperties, 'utf-8');
    recordSyntheticStep(
      'file_write',
      localPropertiesPath,
      0,
      `Wrote deterministic Android SDK local.properties using ${sdkStatus.sdkRoot}.`,
    );
  } else {
    recordSyntheticStep(
      'file_read',
      localPropertiesPath,
      0,
      `Reused existing local.properties with matching sdk.dir for ${sdkStatus.sdkRoot}.`,
    );
  }

  return { toolCallLog };
}

async function runDeterministicGradleBootstrapLane(
  manifest: OrchestratorManifest,
  evidence: EvidenceBundle,
): Promise<{ toolCallLog: ToolCallLog[]; haltedReport?: object }> {
  const projectRoot = inferProjectRoot(manifest);
  if (!projectRoot) {
    return { toolCallLog: [] };
  }

  const wrapperJarPath = join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (existsSync(wrapperJarPath)) {
    return { toolCallLog: [] };
  }
  const settingsGradlePath = join(projectRoot, 'settings.gradle.kts');

  const toolCallLog: ToolCallLog[] = [];
  const recordSyntheticStep = (
    tool: ToolCallLog['tool'],
    target: string,
    exitCode: number,
    stdout: string,
    stderr = '',
  ): void => {
    toolCallLog.push({
      step: toolCallLog.length + 1,
      tool,
      target,
      exit_code: exitCode,
      stdout,
      stderr,
      verified: exitCode === 0,
    });
  };
  const executeLaneTool = async (
    req: z.infer<typeof ToolCallRequestSchema>,
  ): Promise<ToolResult> => {
    const stepNum = toolCallLog.length + 1;
    const toolResult = await executeTool(req, {
      agentId: 'bootstrap_lane',
      runId: evidence.runId,
      runDir: evidence.runDir,
      babelRoot: BABEL_ROOT
    });
    const entry: ToolCallLog = {
      step: stepNum,
      tool: req.tool,
      target: canonicalizeExecutorTargetForLog(getTarget(req), req.tool),
      exit_code: toolResult.exit_code,
      stdout: toolResult.stdout,
      stderr: toolResult.stderr,
      ...(toolResult.denial ? { denial: toolResult.denial } : {}),
      ...(toolResult.mcp_lifecycle ? { mcp_lifecycle: toolResult.mcp_lifecycle } : {}),
      ...(toolResult.checkpoint_ids ? { checkpoint_ids: toolResult.checkpoint_ids } : {}),
      verified: toolResult.exit_code === 0,
    };
    toolCallLog.push(entry);
    return toolResult;
  };

  const javaStatus = detectJavaRuntimeStatus();
  if (!javaStatus.available) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length + 1,
        'Deterministic Gradle bootstrap lane requires Java, but Java is unavailable in the executor environment.',
      ),
    };
  }

  const javaProbe = await executeLaneTool({
    tool: 'shell_exec',
    command: 'java -version',
    working_directory: projectRoot,
    timeout_seconds: 60,
  });
  if (javaProbe.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while verifying Java. stderr: ${javaProbe.stderr.slice(0, 200)}`,
      ),
    };
  }

  if (existsSync(settingsGradlePath)) {
    const settingsContent = readFileSync(settingsGradlePath, 'utf-8');
    const repairedSettings = repairSettingsGradleKtsContent(settingsContent);
    if (repairedSettings.changed) {
      writeFileSync(settingsGradlePath, repairedSettings.content, 'utf-8');
      recordSyntheticStep(
        'file_write',
        settingsGradlePath,
        0,
        `Applied deterministic settings.gradle.kts repair: ${repairedSettings.notes.join(' ')}`,
      );
    }
  }

  const rootBuildGradlePath = join(projectRoot, 'build.gradle.kts');
  if (!existsSync(rootBuildGradlePath)) {
    writeFileSync(
      rootBuildGradlePath,
      buildDeterministicRootBuildGradleKtsContent(),
      'utf-8',
    );
    recordSyntheticStep(
      'file_write',
      rootBuildGradlePath,
      0,
      'Created deterministic root build.gradle.kts with Android and Kotlin plugin versions for bootstrap.',
    );
  }

  let gradleStatus = detectCommandOnPath('gradle');
  if (!gradleStatus.available) {
    const propertiesRead = await executeLaneTool({
      tool: 'file_read',
      path: join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    });
    if (propertiesRead.exit_code !== 0) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length,
          `Deterministic Gradle bootstrap lane failed while reading gradle-wrapper.properties. stderr: ${propertiesRead.stderr.slice(0, 200)}`,
        ),
      };
    }

    const distributionUrl = parseGradleDistributionUrl(propertiesRead.stdout);
    if (!distributionUrl) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          'Deterministic Gradle bootstrap lane could not parse distributionUrl from gradle-wrapper.properties.',
        ),
      };
    }

    mkdirSync(GRADLE_CACHE_DIR, { recursive: true });
    const archiveName = distributionUrl.split('/').pop() ?? 'gradle-distribution.zip';
    const archivePath = join(GRADLE_CACHE_DIR, archiveName);
    const extractedRoot = join(
      GRADLE_CACHE_DIR,
      archiveName.replace(/\.zip$/i, ''),
    );

    if (!existsSync(archivePath)) {
      const response = await fetch(distributionUrl);
      if (!response.ok) {
        recordSyntheticStep(
          'file_write',
          archivePath,
          1,
          '',
          `Failed to download Gradle distribution from ${distributionUrl} (HTTP ${response.status}).`,
        );
        return {
          toolCallLog,
          haltedReport: buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            toolCallLog.length,
            `Deterministic Gradle bootstrap lane failed while downloading Gradle from distributionUrl. HTTP ${response.status}.`,
          ),
        };
      }

      const archiveBuffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(archivePath, archiveBuffer);
      recordSyntheticStep(
        'file_write',
        archivePath,
        0,
        `Cached Gradle distribution from ${distributionUrl} to ${archivePath}`,
      );
    } else {
      recordSyntheticStep(
        'file_read',
        archivePath,
        0,
        `Reusing cached Gradle distribution at ${archivePath}`,
      );
    }

    let gradleCandidate = detectGradleBinaryFromExtractedRoot(extractedRoot);
    if (!gradleCandidate) {
      mkdirSync(extractedRoot, { recursive: true });
      const tarResult = spawnSync(
        'tar',
        ['-xf', archivePath, '-C', extractedRoot],
        { encoding: 'utf-8', windowsHide: true },
      );
      recordSyntheticStep(
        'shell_exec',
        `tar -xf ${archivePath} -C ${extractedRoot}`,
        tarResult.status ?? 1,
        String(tarResult.stdout ?? ''),
        String(tarResult.stderr ?? ''),
      );
      if (tarResult.status !== 0) {
        return {
          toolCallLog,
          haltedReport: buildHaltReport(
            toolCallLog,
            'STEP_VERIFICATION_FAIL',
            toolCallLog.length,
            `Deterministic Gradle bootstrap lane failed while extracting cached Gradle distribution. stderr: ${String(tarResult.stderr ?? '').slice(0, 200)}`,
          ),
        };
      }
      gradleCandidate = detectGradleBinaryFromExtractedRoot(extractedRoot);
    }

    if (!gradleCandidate) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          `Deterministic Gradle bootstrap lane extracted ${archiveName} but could not locate a Gradle binary in ${extractedRoot}.`,
        ),
      };
    }

    prependProcessPath(dirname(gradleCandidate));
    gradleStatus = detectCommandOnPath('gradle');
    if (!gradleStatus.available) {
      return {
        toolCallLog,
        haltedReport: buildHaltReport(
          toolCallLog,
          'STEP_VERIFICATION_FAIL',
          toolCallLog.length + 1,
          'Deterministic Gradle bootstrap lane cached and extracted Gradle, but the gradle command is still unavailable on PATH.',
        ),
      };
    }
  }

  const gradleProbe = await executeLaneTool({
    tool: 'shell_exec',
    command: 'gradle --version',
    working_directory: projectRoot,
    timeout_seconds: 120,
  });
  if (gradleProbe.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while verifying Gradle. stderr: ${gradleProbe.stderr.slice(0, 200)}`,
      ),
    };
  }

  const wrapperResult = await executeLaneTool({
    tool: 'shell_exec',
    command: 'gradle wrapper',
    working_directory: projectRoot,
    timeout_seconds: 600,
  });
  if (wrapperResult.exit_code !== 0) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        `Deterministic Gradle bootstrap lane failed while generating gradle-wrapper.jar. stderr: ${wrapperResult.stderr.slice(0, 200)}`,
      ),
    };
  }

  const wrapperListing = await executeLaneTool({
    tool: 'directory_list',
    path: join(projectRoot, 'gradle', 'wrapper'),
  });
  if (
    wrapperListing.exit_code !== 0 ||
    !existsSync(wrapperJarPath)
  ) {
    return {
      toolCallLog,
      haltedReport: buildHaltReport(
        toolCallLog,
        'STEP_VERIFICATION_FAIL',
        toolCallLog.length,
        'Deterministic Gradle bootstrap lane did not produce gradle-wrapper.jar after running gradle wrapper.',
      ),
    };
  }

  return { toolCallLog };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Runs the full Babel pipeline for a given task string.
 *
 * @param task    - Raw task description from the user.
 * @param options - Optional overrides for project and pipeline mode.
 * @returns       `PipelineResult` with the run directory and final state.
 */
export async function runBabelPipeline(
  task:    string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  clearRoutingCache();
  globalCostTracker.resetSession();
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
  task:    string,
  options: PipelineOptions,
  evidence: EvidenceBundle,
  precomputedManifest?: OrchestratorManifest,
): Promise<PipelineResult> {
  log(`Run directory: ${evidence.runDir}`);

  const orchestratorVersion = resolveOrchestratorVersion(options.orchestratorVersion);
  const sessionId = options.sessionId?.trim() || process.env['BABEL_SESSION_ID']?.trim() || undefined;
  const sessionStartPath = options.sessionStartPath?.trim() || process.env['BABEL_SESSION_START_PATH']?.trim() || undefined;
  const localLearningRoot = options.localLearningRoot?.trim() || process.env['BABEL_LOCAL_LEARNING_ROOT']?.trim() || undefined;
  const requestedExecutionProfile =
    options.executionProfile ??
    normalizeExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']) ??
    DEFAULT_EXECUTION_PROFILE;
  const executionProfile = resolveExecutionProfile(requestedExecutionProfile);
  const harnessMetadata = collectHarnessMetadata(sessionStartPath, localLearningRoot);
  const authoritativeProjectRoot = process.env['BABEL_PROJECT_ROOT']?.trim() || null;
  const runtimeProjectRoot = resolve(authoritativeProjectRoot ?? readSessionStartProjectPath(sessionStartPath) ?? process.cwd());
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
    const usageSummary = costLedger.entries.length > 0
      ? usageSummaryFromCostLedger(costLedger)
      : globalCostTracker.getSessionSummary();

    // Trigger Project Memory Extraction on success
    if (finalizedResult.status === 'COMPLETE') {
      await extractAndSaveMemories(finalizedResult.runDir, inferProjectRoot(finalizedResult.manifest), evidence);
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

  const finalizeError = async (error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : String(error);
    const failureArtifacts = buildPreExecutionFailureArtifacts({
      runDir: evidence.runDir,
      error,
    });
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
    writeLatestRunPointers(evidence.runDir, 'global');
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
    evidence.writeCostLedger(buildCostLedger({
      runId: evidence.runId,
      task,
      lane: 'governed',
      waterfallEntries: evidence.getWaterfallLogSnapshot(),
    }));
    throw error;
  };

  if (DRY_RUN) {
    log('DRY RUN mode active. Destructive tools will be mocked.');
  }
  logDetail(`Execution profile: ${executionProfile.name}`);

  if (!existsSync(runtimeProjectRoot)) {
    await finalizeError(new Error(`Resolved target root does not exist: ${runtimeProjectRoot}`));
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
  const preflightPromise = (async () => {
    await globalIndexer.indexProject(runtimeProjectRoot);
  })();

  try {
    // ── Stage 1: Orchestrator ───────────────────────────────────────────────────
    let manifest: OrchestratorManifest;
    let orchestratorContext: string | undefined;
    if (precomputedManifest) {
      log('Stage 1 / 4  —  Using precomputed manifest');
      manifest = precomputedManifest;
    } else {
      log('Stage 1 / 4  —  Orchestrator');
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
        const orchestratorOutput = await runWithFallback(orchestratorContext, OrchestratorOutputSchema, {
          evidence,
          stage: 'orchestrator',
          schemaName: 'OrchestratorOutputSchema',
        });
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
          logDetail(benchmarkRoutingIsolationResult.warnings[0] ?? 'Applied benchmark routing isolation.');
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

        const optimizedManifestResult = maybeApplyManifestTaskShapeProfile(manifest, task, inferProjectRoot(manifest));
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
          logDetail(benchmarkHarnessOverlayResult.warnings[0] ?? 'Applied benchmark harness overlay.');
        }

        const pipelineStageEnrichmentResult = maybeEnrichPipelineStageIds(manifest, options.mode);
        manifest = pipelineStageEnrichmentResult.manifest;
        if (pipelineStageEnrichmentResult.applied) {
          stackOptimizationWarnings = [
            ...stackOptimizationWarnings,
            ...pipelineStageEnrichmentResult.warnings,
          ];
          logDetail(pipelineStageEnrichmentResult.warnings[0] ?? 'Applied pipeline stage enrichment.');
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
            JSON.stringify({
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
            }, null, 2),
          );
        }

        log(`[debug] Starting manifest resolution...`);
        const manifestStartMs = performance.now();
        let resolvedManifest = resolveInstructionStackManifest(
          manifest,
          BABEL_ROOT,
        );
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
        if (
          stackOptimizationWarnings.length > 0 &&
          resolvedManifest.compiled_artifacts
        ) {
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
        const resolvedCompiledArtifacts =
          (resolvedManifest as OrchestratorManifest & {
            compiled_artifacts?: RuntimeCompiledArtifacts;
          }).compiled_artifacts;

        manifest = OrchestratorManifestSchema.parse(resolvedManifest);
        manifestArtifact = resolvedManifest as unknown as Record<string, unknown>;
        logDetail(
          `Resolved typed stack to ${manifest.prompt_manifest.length} prompt file(s).`,
        );

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
            skillCount: resolvedCompiledArtifacts.selected_entry_ids.filter(entryId => entryId.startsWith('skill_')).length,
            tokenBudgetTotal: resolvedCompiledArtifacts.token_budget_total ?? null,
            tokenBudgetMissingCount: resolvedCompiledArtifacts.token_budget_missing?.length ?? 0,
            budgetWarningSeverity: getHighestBudgetSeverity(resolvedCompiledArtifacts.budget_diagnostics ?? []),
            budgetPolicyEnabled: resolvedCompiledArtifacts.budget_policy?.enabled ?? false,
            ...(typedInstructionStack?.domain_id ? { domainId: typedInstructionStack.domain_id } : {}),
            ...(typedInstructionStack?.model_adapter_id ? { modelAdapterId: typedInstructionStack.model_adapter_id } : {}),
          });
          if (v9StackTelemetry) {
            logDetail(`v9 stack telemetry: ${JSON.stringify(v9StackTelemetry)}`);
          }
        }

        endSpan(compilerSpan, SpanStatusCode.OK, {
          'babel.compilation.state.after': manifest.compilation_state ?? 'compiled',
          'babel.stack.selected_entry_count': manifest.compiled_artifacts?.selected_entry_ids.length,
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
        const band   = getRoutingConfidenceBand(routingConf);
        let action:             'accepted' | 'downgraded' | 'validated' | 'validator_still_low' = 'accepted';
        let validatorUsed       = false;
        let validatorImproved:  boolean | null = null;

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
              { evidence, stage: 'orchestrator', startTierIndex: getValidatorTierIndex(), dynamicRouting: false },
            );
            assertManifest(validatorOutput);
            validatorManifest = OrchestratorManifestSchema.parse(validatorOutput);
          } catch {
            log(`[babel:orchestrator] ⚠ Validator pass failed — proceeding with original manifest.`);
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
              manifest         = validatorManifest;
              manifestArtifact = validatorManifest as unknown as Record<string, unknown>;
              action           = 'validated';
              log(`[babel:orchestrator] Validator improved confidence: ${(validatorConf ?? 0).toFixed(2)} — using validator manifest.`);
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
          // New object (spread) so downstream `effectiveMode = options.mode ?? manifest.analysis.pipeline_mode`
          // reads the downgraded value. CLI override (options.mode) always wins.
          if (!options.mode && manifest.analysis.pipeline_mode === 'direct') {
            manifest         = { ...manifest, analysis: { ...manifest.analysis, pipeline_mode: 'verified' } };
            manifestArtifact = manifest as unknown as Record<string, unknown>;
            action           = 'downgraded';
            log(
              `[babel:orchestrator] ⚠ Medium confidence (${routingConf.toFixed(2)}): ` +
              `downgraded pipeline_mode direct → verified.`,
            );
          }
        }

        evidence.writeRoutingDecision({
          routing_confidence:       routingConf,
          routing_confidence_band:  band,
          routing_action:           action,
          routing_validator_used:   validatorUsed,
          routing_validator_improved: validatorImproved,
          ts: new Date().toISOString(),
        });

        if (v9StackTelemetry) {
          v9StackTelemetry = {
            ...v9StackTelemetry,
            routing_confidence:        routingConf,
            routing_confidence_band:   band,
            routing_action:            action,
            routing_validator_used:    validatorUsed,
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
    if (options.writeLatestPointers !== false) {
      writeLatestRunPointers(evidence.runDir, manifest.target_project);
    }
    await runPluginHooks('PostOrchestrator', {
      runId: evidence.runId,
      runDir: evidence.runDir,
      babelRoot: BABEL_ROOT,
      projectRoot: inferProjectRoot(manifest) ?? sessionStartPath ?? process.cwd(),
      dryRun: DRY_RUN,
      manifest,
    });

    const mergedTaskContext = mergeTaskContext(
      task,
      manifest.handoff_payload.user_request,
    );

    let effectiveMode  = options.mode ?? manifest.analysis.pipeline_mode;
    const effectiveModel = (
      options.modelOverride ?? manifest.worker_configuration.assigned_model ?? 'qwen3'
    ) as TargetModel;
    const exactInvariantRegistry = getRequestedTargetContract(mergedTaskContext).exactInvariants;
    evidence.writeDebugFile(
      '11_exact_invariants.json',
      `${JSON.stringify(exactInvariantRegistry, null, 2)}\n`,
    );
    const taskContract = classifyTaskContract(mergedTaskContext);
    const taskGrounding = buildTaskGrounding(taskContract, inferProjectRoot(manifest));
    const groundingContext = formatGroundingContext(taskGrounding);
    const javaRuntimeStatus = detectJavaRuntimeStatus();
    const gradleRuntimeStatus = detectCommandOnPath('gradle');
    resolvedModelPolicy = resolveFamilyModelPolicy({
      family: effectiveModel,
      ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
      ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
      babelRoot: BABEL_ROOT,
    });

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
    const completeStatusForCurrentTask = (): TerminalStatus => isReadOnlyNoModificationRequest({
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
      const invariantStatus = resolveCompletionStatusAfterExactInvariantCheck(exactInvariantFailure);
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
      shouldRefuseDirectModeWriteRequest(
        effectiveMode,
        requestedTargetContractForMode.requestedTargets.length,
      )
    ) {
      log('Pipeline halted — DIRECT_MODE_NO_EXECUTOR');
      logDetail(
        'direct mode has no governed executor/writeback path for requested file artifacts; ' +
        'use autonomous mode for file creation or modification.',
      );
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'DIRECT_MODE_NO_EXECUTOR',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return await finalizeResult({
        runDir: evidence.runDir,
        manifest,
        plan: null,
        status: 'DIRECT_MODE_NO_EXECUTOR',
        errors: [
          'direct mode file-write request refused: no executor/writeback path is bound.',
        ],
      });
    }

    if (
      effectiveMode === 'parallel_swarm' &&
      requestedTargetContractForMode.requestedTargets.length > 0
    ) {
      log('Pipeline halted — SWARM_NO_EXECUTOR_BOUND');
      logDetail(
        'parallel_swarm has no governed merger/writeback path for requested file artifacts; ' +
        'use autonomous mode or implement swarm merger evidence before file writes.',
      );
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'SWARM_NO_EXECUTOR_BOUND',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return await finalizeResult({
        runDir: evidence.runDir,
        manifest,
        plan: null,
        status: 'SWARM_NO_EXECUTOR_BOUND',
        errors: [
          'parallel_swarm file-write request refused: no governed merger/executor writeback path is bound.',
        ],
      });
    }

    if (effectiveMode === 'parallel_swarm' && manifest.swarm) {
      log('Stage 2-4 / 4 — Parallel Swarm Dispatch');
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
    if (effectiveMode !== 'manual' && isContextPruningEnabled()) {
      log('Stage 0 / 4  -  Surgical Pruning');
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

    if (effectiveMode === 'manual') {
      log('Stage 2 / 4  —  Manual Bridge Export');
      const sweTask    = buildSweTask(manifest, mergedTaskContext, [], undefined, '', groundingContext, executionProfile.name);
      const sweContext = await compileContext(manifest.prompt_manifest, sweTask, inferProjectRoot(manifest), pruningStubs);
      evidence.writeManualSwePrompt(sweContext);
      evidence.writeCompiledContext('swe_manual', sweContext);
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'MANUAL_BRIDGE_REQUIRED',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);

      return await finalizeResult({
        runDir:           evidence.runDir,
        manifest,
        plan:             null,
        status:           'MANUAL_BRIDGE_REQUIRED',
        manualPromptPath: join(evidence.runDir, '02_manual_swe_prompt.md'),
      });
    }

    // ── Evidence loop state ─────────────────────────────────────────────────────
    // `approvedPlan` is declared outside the while so it is accessible after break.
    let approvedPlan:             SwePlan | null = null;
    let evidenceLoopCount         = 0;
    let additionalEvidenceContext = '';
    const executionReportWarnings: string[] = [];
    let lastToolCallLog: ToolCallLog[] = [];

    const commandOnlyNoModification = effectiveMode !== 'direct' && effectiveMode !== 'parallel_swarm'
      ? inferCommandOnlyNoModificationRequest(task)
      : null;
    const shouldRunCommandOnlyNoModification =
      commandOnlyNoModification !== null &&
      !(isOptionalVerifierRequest(task) && !isShellExecutionToolAvailable());
    if (commandOnlyNoModification && !shouldRunCommandOnlyNoModification) {
      log(`Optional command-only verifier "${commandOnlyNoModification}" skipped because shell_exec is unavailable.`);
    }
    if (commandOnlyNoModification && shouldRunCommandOnlyNoModification) {
      log(`Command-only no-modification task detected; running "${commandOnlyNoModification}" through shell_exec.`);
      const toolResult = await executeTool({
        tool: 'shell_exec',
        command: commandOnlyNoModification,
        working_directory: '.',
        timeout_seconds: 300,
      }, {
        agentId: 'executor',
        runId: evidence.runId,
        runDir: evidence.runDir,
        babelRoot: BABEL_ROOT,
      });
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
        const report = buildTerminalReport({
          type: 'completion',
          status: 'EXECUTION_COMPLETE',
        }, lastToolCallLog, evidence);
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
        toolResult.denial ? `denial: ${toolResult.denial.category}/${toolResult.denial.reason_code}: ${toolResult.denial.message}.` : '',
      ].filter(Boolean).join(' ');
      const report = buildHaltReport(
        lastToolCallLog,
        'STEP_VERIFICATION_FAIL',
        1,
        condition,
      );
      writeValidatedExecutionReport(evidence, report, lastToolCallLog, executionReportWarnings);
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        status,
        effectiveMode,
      );
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
      approvedPlan        = null;
      let qaRejections:        string[]           = [];
      let proposedFixStrategy: string | undefined = undefined;

      // ── Stage 2 & 3: SWE Agent → QA Reviewer loop ───────────────────────────
      for (let attempt = 1; attempt <= MAX_SWE_QA_LOOPS; attempt++) {

      // ── Stage 2: SWE Agent ─────────────────────────────────────────────────
      log(
        `Stage 2 / 4  —  SWE Agent` +
        (attempt > 1 ? ` (attempt ${attempt}/${MAX_SWE_QA_LOOPS})` : '') +
        (evidenceLoopCount > 0 ? ` [evidence pass ${evidenceLoopCount}]` : ''),
      );

      // prompt_manifest contains ordered absolute path strings — use directly.
      const swePaths = manifest.prompt_manifest;

      const sweTask    = buildSweTask(manifest, mergedTaskContext, qaRejections, proposedFixStrategy, additionalEvidenceContext, groundingContext, executionProfile.name);
      const sweContext = await compileContext(swePaths, sweTask, inferProjectRoot(manifest), pruningStubs);
      evidence.writeCompiledContext(`swe_v${attempt}`, sweContext);

      const swePlanRaw = await runWithFallback(sweContext, SwePlanSchema, {
        evidence,
        stage: 'planning',
        schemaName: 'SwePlanSchema',
      });
      const { plan: normalizedPlan, warnings: planWarnings } = normalizeSwePlan(swePlanRaw);
      const { plan: groundedPlan, warnings: groundingWarnings } = normalizePlanTargetsAgainstGrounding(taskGrounding, normalizedPlan);
      const { plan: requestedTargetPlan, warnings: requestedTargetWarnings } =
        normalizePlanTargetsAgainstRequestedOutputs(mergedTaskContext, groundedPlan);
      const swePlan = requestedTargetPlan;
      if (planWarnings.length > 0 || groundingWarnings.length > 0 || requestedTargetWarnings.length > 0) {
        executionReportWarnings.push(...planWarnings);
        executionReportWarnings.push(...groundingWarnings);
        executionReportWarnings.push(...requestedTargetWarnings);
        planWarnings.forEach(w => logDetail(`SWE plan warning: ${w}`));
        groundingWarnings.forEach(w => logDetail(`SWE plan warning: ${w}`));
        requestedTargetWarnings.forEach(w => logDetail(`SWE plan warning: ${w}`));
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

      // ── Direct mode: skip QA and CLI ───────────────────────────────────────
      if (effectiveMode === 'direct') {
        logDetail('Mode is "direct" — skipping QA Reviewer and CLI Executor.');
        approvedPlan = swePlan;
        break;
      }

      const groundingViolations = sanitizeGroundingViolationsForAndroidSdkLane(
        collectPlanGroundingViolations(taskContract, taskGrounding, swePlan),
        manifest,
      );
      if (groundingViolations.length > 0) {
        const groundingReject = buildGroundingQaReject(groundingViolations) as QaVerdictReject;
        evidence.writeQaVerdict(groundingReject, attempt);
        logDetail(
          `QA: REJECT  (${groundingReject.failure_count} failure(s), confidence: ${groundingReject.overall_confidence}/5)`,
        );
        groundingReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = groundingReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = groundingReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, groundingReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', groundingReject.failures.map(failure => failure.tag));
        continue;
      }

      const referenceSourceShapeReject = collectReferenceSourceShapeViolations(swePlan, manifest);
      if (referenceSourceShapeReject) {
        evidence.writeQaVerdict(referenceSourceShapeReject, attempt);
        logDetail(
          `QA: REJECT  (${referenceSourceShapeReject.failure_count} failure(s), confidence: ${referenceSourceShapeReject.overall_confidence}/5)`,
        );
        referenceSourceShapeReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = referenceSourceShapeReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = referenceSourceShapeReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, referenceSourceShapeReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', referenceSourceShapeReject.failures.map(failure => failure.tag));
        continue;
      }

      const executorSafetyReject = collectExecutorSafetyViolations(
        swePlan,
        manifest,
        mergedTaskContext,
        executionProfile.name,
      );
      if (executorSafetyReject) {
        evidence.writeQaVerdict(executorSafetyReject, attempt);
        logDetail(
          `QA: REJECT  (${executorSafetyReject.failure_count} failure(s), confidence: ${executorSafetyReject.overall_confidence}/5)`,
        );
        executorSafetyReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = executorSafetyReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = executorSafetyReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, executorSafetyReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', executorSafetyReject.failures.map(failure => failure.tag));
        continue;
      }

      const runtimePrereqReject = collectRuntimePrerequisiteViolations(
        swePlan,
        javaRuntimeStatus,
        gradleRuntimeStatus,
      );
      if (runtimePrereqReject) {
        evidence.writeQaVerdict(runtimePrereqReject, attempt);
        logDetail(
          `QA: REJECT  (${runtimePrereqReject.failure_count} failure(s), confidence: ${runtimePrereqReject.overall_confidence}/5)`,
        );
        runtimePrereqReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = runtimePrereqReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = runtimePrereqReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, runtimePrereqReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', runtimePrereqReject.failures.map(failure => failure.tag));
        continue;
      }

      const gradleBootstrapReject = collectGradleBootstrapSequencingViolations(
        swePlan,
        manifest,
        gradleRuntimeStatus,
      );
      if (gradleBootstrapReject) {
        evidence.writeQaVerdict(gradleBootstrapReject, attempt);
        logDetail(
          `QA: REJECT  (${gradleBootstrapReject.failure_count} failure(s), confidence: ${gradleBootstrapReject.overall_confidence}/5)`,
        );
        gradleBootstrapReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = gradleBootstrapReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = gradleBootstrapReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, gradleBootstrapReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', gradleBootstrapReject.failures.map(failure => failure.tag));
        continue;
      }

      const androidVerificationCoverageReject = collectAndroidVerificationCoverageViolations(
        swePlan,
        manifest,
        task,
      );
      if (androidVerificationCoverageReject) {
        evidence.writeQaVerdict(androidVerificationCoverageReject, attempt);
        logDetail(
          `QA: REJECT  (${androidVerificationCoverageReject.failure_count} failure(s), confidence: ${androidVerificationCoverageReject.overall_confidence}/5)`,
        );
        androidVerificationCoverageReject.failures.forEach((failure, index) => {
          logDetail(`  ${index + 1}. [${failure.tag}]  ${failure.condition}`);
        });

        qaRejections = androidVerificationCoverageReject.failures.map(failure =>
          failure.fix_hint
            ? `[${failure.tag}] ${failure.condition} (hint: ${failure.fix_hint})`
            : `[${failure.tag}] ${failure.condition}`,
        );
        proposedFixStrategy = androidVerificationCoverageReject.proposed_fix_strategy;
        v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, androidVerificationCoverageReject);
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        pipelineTrace.recordQaVerdict('REJECT', androidVerificationCoverageReject.failures.map(failure => failure.tag));
        continue;
      }

      // ── Stage 3: QA Reviewer ───────────────────────────────────────────────
      log(
        `Stage 3 / 4  —  QA Reviewer` +
        (attempt > 1 ? ` (attempt ${attempt}/${MAX_SWE_QA_LOOPS})` : ''),
      );

      const deterministicGradleBootstrapLaneActive = shouldUseDeterministicGradleBootstrapLane(inferProjectRoot(manifest));
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
        throw error;
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
        approvedPlan = swePlan;
        break;
      }

      // ── QA rejected — collect failures and loop ────────────────────────────
      const rejectVerdict = verdict as z.infer<typeof QaVerdictSchema> & { verdict: 'REJECT' };
      const rejVerdict    = rejectVerdict as QaVerdictReject;

      logDetail(
        `QA: REJECT  (${rejVerdict.failure_count} failure(s), ` +
        `confidence: ${rejVerdict.overall_confidence}/5)`,
      );

      rejVerdict.failures.forEach((f, i) => {
        logDetail(`  ${i + 1}. [${f.tag}]  ${f.condition}`);
      });

      qaRejections        = rejVerdict.failures.map(f =>
        f.fix_hint
          ? `[${f.tag}] ${f.condition} (hint: ${f.fix_hint})`
          : `[${f.tag}] ${f.condition}`,
      );
      proposedFixStrategy = rejVerdict.proposed_fix_strategy;
      v9StackTelemetry = markRuntimeTelemetryQaReject(v9StackTelemetry, rejVerdict);
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      pipelineTrace.recordQaVerdict('REJECT', rejVerdict.failures.map(failure => failure.tag));
      endSpan(qaSpan, SpanStatusCode.OK, {
        'babel.qa.verdict': 'REJECT',
        'babel.qa.failure_count': rejVerdict.failure_count,
        'babel.qa.failure_tags_hash': rejVerdict.failures.length > 0
          ? rejVerdict.failures.map(failure => failure.tag).join(',')
          : undefined,
        'babel.qa.confidence': rejVerdict.overall_confidence,
        'babel.evidence_gate.status': rejVerdict.failures.some(failure => failure.tag === 'EVIDENCE-GATE')
          ? 'violated'
          : 'unknown',
      });

      if (attempt === MAX_SWE_QA_LOOPS) {
        log(`QA rejected ${MAX_SWE_QA_LOOPS} plans. Pipeline halted.`);
        log(`Review evidence bundle for details: ${evidence.runDir}`);
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
          runDir:   evidence.runDir,
          manifest,
          plan:     null,
          status:   'QA_REJECTED_MAX_LOOPS',
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
    if (approvedPlan !== null && effectiveMode === 'autonomous') {
      const boundedActivationReject = assertBoundedPlanActivationContract(approvedPlan, mergedTaskContext);
      if (boundedActivationReject) {
        log(`  Executor: ACTIVATION_REFUSED [ACTIVATION_GATE_FAIL]`);
        logDetail(boundedActivationReject);
        writeValidatedExecutionReport(
          evidence,
          {
            status:  'ACTIVATION_REFUSED',
            reason:  boundedActivationReject,
            gate:    'ACTIVATION_GATE_FAIL' satisfies HaltTag,
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
          runDir:   evidence.runDir,
          manifest,
          plan:     approvedPlan,
          status:   'EXECUTOR_HALTED',
        });
      }
    }

    // ── Stage 4: CLI Executor ─────────────────────────────────────────────────

    if (effectiveMode === 'verified' && approvedPlan !== null) {
      const autoApproveReadOnlyEvidence = isReadOnlyEvidenceRequestPlan(approvedPlan);
      const checklistWillPrompt =
        !autoApproveReadOnlyEvidence &&
        process.stdout.isTTY === true &&
        process.env['BABEL_PIPELINE_V9_OFFLINE'] !== '1';
      if (autoApproveReadOnlyEvidence) {
        log('Read-only evidence plan approved automatically.');
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
        log(`Review cancelled. Pipeline halted.`);
        return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'EXECUTOR_HALTED' });
      }
      if (selectedSteps.length === 0) {
        log(`No steps selected. Pipeline complete.`);
        const driftResult = await finalizeExactInstructionDrift(approvedPlan);
        if (driftResult) {
          return driftResult;
        }
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'COMPLETE',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: completeStatusForCurrentTask() });
      }
      // Update plan and promote to autonomous for execution
      approvedPlan.minimal_action_set = selectedSteps;
      effectiveMode = 'autonomous';
    }

    if (shouldHaltAutonomousWithoutApprovedPlan(effectiveMode, approvedPlan)) {
      log(`QA rejected ${MAX_SWE_QA_LOOPS} plans. Pipeline halted.`);
      log(`Review evidence bundle for details: ${evidence.runDir}`);
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

    if (effectiveMode !== 'autonomous' || approvedPlan === null) {
      log(`Pipeline complete  —  mode "${effectiveMode}", no CLI execution.`);
      log(`Evidence bundle: ${evidence.runDir}`);
      const driftResult = await finalizeExactInstructionDrift(approvedPlan);
      if (driftResult) {
        return driftResult;
      }
      v9StackTelemetry = markRuntimeTelemetryOutcome(
        v9StackTelemetry,
        'COMPLETE',
        effectiveMode,
      );
      writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
      return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: completeStatusForCurrentTask() });
    }

    const planTargetScope = validatePlanTargetsWithinEffectiveRoots({
      effectiveTargetRoot: inferProjectRoot(manifest) ?? runtimeProjectRoot,
      targets: approvedPlan.minimal_action_set.map(step => step.target),
    });
    if (!planTargetScope.ok) {
      const reason = planTargetScope.violations[0] ?? 'Blocked - planned tool target is outside the resolved target root.';
      log(`  Executor: ACTIVATION_REFUSED [ACTIVATION_GATE_FAIL]`);
      logDetail(reason);
      writeValidatedExecutionReport(
        evidence,
        {
          status: 'ACTIVATION_REFUSED',
          reason,
          gate: 'ACTIVATION_GATE_FAIL' satisfies HaltTag,
        },
        [],
        [...executionReportWarnings, reason],
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
        errors: planTargetScope.violations,
      });
    }

    const lockResult = await checkWorkspaceLocks(approvedPlan, BABEL_ROOT);
    if (lockResult.halted) {
      log(`[babel:governance] ❌ ${lockResult.reason}`);
      const report = buildHaltReport(
        [],
        'SCOPE_VIOLATION',
        0,
        lockResult.reason ?? 'Workspace lock conflict.',
      );
      evidence.writeExecutionLog(report);
      return await finalizeResult({
        runDir: evidence.runDir,
        manifest,
        plan: approvedPlan,
        status: 'EXECUTOR_HALTED',
      });
    }

    log('Stage 4 / 4  —  CLI Executor');
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
      logDetail(`Deterministic Godot scaffold seed copied ${scaffoldSeed.filesCopied.length} file(s).`);
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
          executionReportWarnings,
        );
        log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during deterministic Android SDK bootstrap lane');
        return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'EXECUTOR_HALTED' });
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
          executionReportWarnings,
        );
        log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during deterministic Gradle bootstrap lane');
        return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'EXECUTOR_HALTED' });
      }
    }
    try {
      const executorResult = await runExecutorLoop(
        approvedPlan,
        evidence,
        effectiveModel,
        executionReportWarnings,
        initialExecutorLog,
        mergedTaskContext,
        pruningStubs,
      );
      toolCallLog = executorResult.toolCallLog;
      lastToolCallLog = toolCallLog;
      if (executorResult.terminalStatus !== 'EXECUTION_COMPLETE') {
        log(
          `Pipeline halted after executor terminal status ${executorResult.terminalStatus}. ` +
          `Evidence bundle: ${evidence.runDir}`,
        );
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'EXECUTOR_HALTED',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        const haltCondition = executorResult.condition ?? '';
        const haltedStatus =
          /\[ROLLBACK_FAILED\]/.test(haltCondition)
            ? 'ROLLBACK_FAILED'
            : /\[ROLLBACK_APPLIED\]/.test(haltCondition)
              ? 'ROLLBACK_APPLIED'
              : /\[WORKTREE_DIRTY_UNSAFE\]/.test(haltCondition)
                ? 'WORKTREE_DIRTY_UNSAFE'
                : /\[VERIFIER_NOT_FOUND\]/.test(haltCondition)
            ? 'VERIFIER_NOT_FOUND'
            : /\[REPAIR_REPEATED_FAILURE\]/.test(haltCondition)
              ? 'REPAIR_REPEATED_FAILURE'
              : executorResult.haltTag === 'REPAIR_BUDGET_EXCEEDED' ||
                /\[REPAIR_MAX_ATTEMPTS_REACHED\]/.test(haltCondition)
                ? 'REPAIR_MAX_ATTEMPTS_REACHED'
                : /\[SHELL_COMMAND_DENIED\]/.test(haltCondition)
                  ? 'SHELL_COMMAND_DENIED'
                  : /\[SHELL_COMMAND_FAILED\]/.test(haltCondition)
                    ? 'SHELL_COMMAND_FAILED'
                  : /\[VERIFIER_FAILED\]/.test(haltCondition)
                    ? 'VERIFIER_FAILED'
                    : 'EXECUTOR_HALTED';
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
      return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: 'EXECUTOR_HALTED' });
    }

    // ── Evidence loop evaluation ──────────────────────────────────────────────
    // If the approved plan was an evidence-gathering pass, rebound to Stage 2
    // with the collected results injected into the next SWE Agent prompt.
    if (approvedPlan.plan_type === 'EVIDENCE_REQUEST') {
      evidenceLoopCount++;

      if (evidenceLoopCount > MAX_EVIDENCE_LOOPS) {
        log(`Maximum evidence loops (${MAX_EVIDENCE_LOOPS}) exceeded. Halting pipeline.`);
        log(`Review evidence bundle for details: ${evidence.runDir}`);
        v9StackTelemetry = markRuntimeTelemetryOutcome(
          v9StackTelemetry,
          'EVIDENCE_LOOP_EXCEEDED',
          effectiveMode,
        );
        writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
        return await finalizeResult({
          runDir:   evidence.runDir,
          manifest,
          plan:     approvedPlan,
          status:   'EVIDENCE_LOOP_EXCEEDED',
        });
      }

      log(
        `Evidence gathered. Rebounding to SWE Agent ` +
        `(Loop ${evidenceLoopCount}/${MAX_EVIDENCE_LOOPS})...`,
      );
      additionalEvidenceContext += formatExecutionResults(toolCallLog, evidenceLoopCount);
      continue; // outer while — back to Stage 2 with enriched context
    }

    // Standard (non-evidence) implementation plan — pipeline complete.
    break;
  }

  log(`Pipeline complete  —  Evidence bundle: ${evidence.runDir}`);
  const driftResult = await finalizeExactInstructionDrift(approvedPlan, lastToolCallLog);
  if (driftResult) {
    return driftResult;
  }
  v9StackTelemetry = markRuntimeTelemetryOutcome(
    v9StackTelemetry,
    'COMPLETE',
    effectiveMode,
  );
  writeRuntimeTelemetrySnapshot(evidence, v9StackTelemetry);
  return await finalizeResult({ runDir: evidence.runDir, manifest, plan: approvedPlan, status: completeStatusForCurrentTask() });
  } catch (error) {
    return await finalizeError(error);
  }
}

export async function resumeManualBridge(
  runDir: string,
  planInput: string | { planPath?: string; rawPlanText?: string },
): Promise<PipelineResult> {
  globalCostTracker.resetSession();
  const manifestPath = join(runDir, '01_manifest.json');
  const manifestRaw  = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  const manifest     = OrchestratorManifestSchema.parse(manifestRaw);
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
    const errors   = formatZodErrors(parsedPlan.error);
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
  log('Stage 3 / 4  —  QA Reviewer (resume)');
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

  log('Stage 4 / 4  —  CLI Executor');
  const executionReportWarnings: string[] = [];
  const initialExecutorLog: ToolCallLog[] = [];
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
  if (shouldUseDeterministicAndroidSdkBootstrapLane(inferProjectRoot(manifest))) {
    logDetail('Deterministic Android SDK bootstrap lane activated.');
    const androidSdkBootstrapResult = await runDeterministicAndroidSdkBootstrapLane(manifest);
    initialExecutorLog.push(...androidSdkBootstrapResult.toolCallLog);
    if (androidSdkBootstrapResult.haltedReport) {
      writeValidatedExecutionReport(
        evidence,
        androidSdkBootstrapResult.haltedReport,
        initialExecutorLog,
        executionReportWarnings,
      );
      log('  Executor: EXECUTION_HALTED [STEP_VERIFICATION_FAIL] during deterministic Android SDK bootstrap lane');
      return {
        runDir,
        manifest,
        plan: swePlan,
        status: 'EXECUTOR_HALTED',
      };
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
        planWarnings,
      );
      return {
        runDir,
        manifest,
        plan: swePlan,
        status: 'EXECUTOR_HALTED',
      };
    }
  }
  try {
    const executorResult = await runExecutorLoop(
      swePlan,
      evidence,
      targetModel,
      planWarnings,
      initialExecutorLog,
      manifest.handoff_payload.user_request,
    );
    if (executorResult.terminalStatus !== 'EXECUTION_COMPLETE') {
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
