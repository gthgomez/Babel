/**
 * ChatEngine — unified conversational agent loop for Babel chat mode.
 * Chat investigates and executes; deep mode remains the governed pipeline.
 * Compaction: chatCompaction.ts. Critic/budget: chatEngineCriticBudget.ts.
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { isBabelHeadlessEnv } from '../utils/envFlags.js';
import { resolveClassCGateDecision } from './autonomyEnforcement.js';
import { resolveProjectPath } from '../utils/projectPath.js';

import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

import { endSpan } from '../telemetry/tracing.js';
import { chatSessionDir, transcriptPath as layoutTranscriptPath } from '../cli/runsLayout.js';
import { allocateThreadId } from '../services/threadStore/threadIds.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { OllamaApiRunner } from '../runners/ollamaApi.js';
import { OpenCodeApiRunner } from '../runners/openCodeApi.js';
import { OpenRouterApiRunner } from '../runners/openRouterApi.js';
import type {
  ProviderInvocationStarted,
  ProviderMessage,
  RunnerCallbacks,
} from '../runners/base.js';
import { mapProviderMessagesToWire } from '../runners/providerMessages.js';
import {
  assertLiveModelId,
  LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS,
  LIVE_OPENROUTER_MODEL_ID,
  resolveOpenRouterDeepSeekModelId,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';
import {
  isOfflineChatMode,
  resolveChatModelPolicy,
  resolveFallbackModelId,
} from './chatModelPolicy.js';
import {
  captureCostBaselineUsd,
  globalCostTracker,
} from '../services/costTracker.js';
import type { SessionUsageSummary } from '../services/costTracker.js';
import {
  proposeProjectMemoryWriteback,
  readProjectMemory,
  readProjectMemoryStructured,
} from '../services/projectMemory.js';
import {
  buildPlaybookPrompt,
  selectPlaybookForChatTask,
  type PlaybookDefinition,
} from '../services/playbooks/playbookService.js';
import { evaluatePlanThenExecuteGate, shouldRequireTodoPlan } from './planThenExecute.js';
import {
  evaluateHardPlanModeGate,
  formatPlanHandoffUserMessage,
  operatorModeIsHardPlan,
  resolveForceMutateTurnsForHandoff,
  type ChatOperatorMode,
  type ChatPlanExecuteHandoff,
} from './planExecuteMode.js';
import { detectEnvBlockedFromText, extractToolEnvBlockedSignal, evaluateCompletionPrefersPatch } from './implementorPolicy.js';
import { evaluatePhaseToolGate } from './phaseToolPolicy.js';
import { extractJson } from '../utils/extractJson.js';
import type { BlockedReport, TerminalOutcome } from '../schemas/agentContracts.js';
import {
  CompactionManager,
  DEFAULT_COMPACTION_CONFIG,
  estimateTokens,
  resolveCompactionModelId,
} from './chatCompaction.js';
import { runChatEngineCompaction } from './compactionCommit.js';
import { PreparedRequestAdmissionError } from '../runners/preparedProviderRequest.js';
import {
  initLiveAuthorityOnEngine,
  projectEngineLiveSession,
  restoreEngineSessionEvents,
  engineCanMutateKey,
  evaluateSubmitTaskAuthorityHalt,
} from './chatEngineLiveSession.js';
import {
  AUTHORITY_SESSION_FILENAME,
  establishAuthoritySession,
  restoreAuthoritySession,
} from '../authority/sessionContext.js';
import {
  loadLiveSessionAuthorityStrict,
  persistLiveSessionAuthority,
} from './liveSessionBridge.js';
import type { LiveSessionV1 } from './liveSession.js';
import {
  applyHonestTaskOutcomeToCompletion,
  createFailureBudgetTrackerFromContract,
  type FailureClassBudgetTracker,
  type FailureCapsuleV1,
} from './taskContract.js';
import { getGlobalTokenTracker } from '../ui/tokenHistory.js';
import {
  classifyTerminalLimiter,
  createRunAllowanceReport,
  explicitFiniteCostOverride,
  resolveChatEngineLimits,
  shouldShrinkWallForPostWriteRepair,
  type ChatEngineLimits,
  type ChatEngineRunAllowanceReport,
  type ChatRunLimiter,
} from '../config/chatEngineLimits.js';
import {
  classifyFailureText,
  isProviderOutputLimitText,
  projectChatTerminal,
  type ChatStatus,
} from './chatFailureClassification.js';
import { nativeTurnFromStream, ProviderOutputTruncatedError } from './chatNativeTurn.js';
import {
  resolveChatTaskClass,
  getChatTaskTune,
  type ChatTaskClass,
  type TaskOperation,
  type VerificationPolicy,
} from '../config/chatTaskClass.js';
import {
  AUTO_CONTINUE_REFUSAL_MSG,
  buildAutoContinueBlockedReport,
  buildGateRejectUserMessageForEngine,
  evaluateCompletionGateForEngine,
  isAuthoritativeVerifierCommand,
  parseStructuredVerifierCommand,
  planCompletionGateReject,
  resolveVerificationPolicy,
} from './completionGatePolicy.js';
import {
  formatTestCommandsForGate,
  type DiscoveredTestCommand,
  discoverProjectTestCommands,
} from './projectTestDiscovery.js';
import { appendPatchRecovery } from './patchRecovery.js';
import {
  buildFullRereadSkipObservation,
  isExplorationBudgetTool,
  normalizeReadCacheKey,
  shouldSkipFullReread,
} from './readThrashPolicy.js';
import {
  applyWorkingStateEvent,
  createWorkingState,
  decideReadInjection,
  evaluateReadRequest,
  formatReadFailureObservation,
  formatReadObservation,
  formatVerifierReceiptSummary,
  invalidateReadCacheForPath,
  resetOneShotSnapshot,
  resolveNextTurnToolAccess,
  selectReadWindow,
  snapshotOnce,
  upsertWorkingStateMessage,
  type ReadInjectionCache,
  type WorkingState,
} from './codingLoop/index.js';
import { ingestVerifierResult, rememberFullReadWindow } from './codingLoop/chatBindings.js';

import { parseTextToolTurn } from './textToolParser.js';
import {
  ChatTurnSchema,
  buildAnswerSynthesisPrompt,
  mapChatActionToAgentAction,
  isMcpChatAction,
  mapChatMcpActionToToolRequest,
  formatChatToolObservation,
  formatSubAgentFindings,
  mapChatWebActionToToolRequest,
  chatActionToolName,
  chatActionTarget,
  type ChatMessage,
  type ChatToolAction,
  type ChatTurn,
  type ChatRuntimeMode,
} from './chatToolDefinitions.js';
import {
  buildReadOnlyChildResult,
  renderReadOnlyChildResultSection,
} from './childConclusion.js';
import {
  CHILD_MUTATION_DEFAULT_ROUNDS,
  CHILD_READ_DEFAULT_ROUNDS,
  formatChildSpecReceipt,
  resolveChildSpec,
} from './childSpec.js';
import { type ChatEngineServices, type ChatExecutionProfile } from './chatEngineServices.js';
import { createExecutorKernel, type ExecutorKernel } from '../executor/kernel.js';
import {
  evaluateChatCompletionProof,
  mutationPathsFromSessionEvents,
  refreshChatVerifierReceiptStalenessSync,
  toGateToolLog,
  type BoundChatVerifierReceipt,
} from '../evidence/chatRevisionBinding.js';
import { RevisionManager } from '../evidence/revisionBoundReceipt.js';
import { resolveIsolationBrokerFlags } from './chatEngineIsolationFlags.js';

import {
  executeActionWithPolicy,
  defaultToolExecutor,
  type PolicyGatedExecutionResult,
} from './toolExecutor.js';
import { governedStrReplace } from './governedMutations.js';
import {
  planToolBatches,
  orderChatToolActions,
  isCircuitBreakerObservation,
} from './agentLoopReducer.js';
import {
  createParityRuntime,
  parityOnUserTurn,
  parityRecordProviderRetry,
  paritySettleProviderRetry,
  parityRecordToolBatch,
  paritySettleProposeTools,
  paritySettleToolStarted,
  paritySettleToolNotStarted,
  parityAuthorizeRecoveredOutcomeRetry,
  parityArbitrateCycle,
  parityShouldCompact,
  parityTryFailover,
  finalizeParityTurnSync,
  finalizeParityCancel,
  checkpointParityEventLog,
  checkpointParityEventLogStrict,
  type ParityRuntime,
} from './chatEngineParityBridge.js';
import { loadThreadEventLogFromDir, recordUserMessage } from './threadEventLog.js';
import { isOperatorAbortError } from './operatorAbort.js';
import {
  loadSessionEventLogForResume,
  loadSessionEventLogIfPresentForResume,
  recordCompletionDecision,
  recordCapabilityBindingReceipt,
  recordModelInputReceipt,
  recordModelInvocationPhase,
  recordModelResultDelivery,
  recordModelFailover,
  recordMutationBatch,
  recordPolicyIntervened,
  recordProgressRecovery,
  resumedToolRecoveryGuidance,
  operationFingerprint,
  requiresRecoveredOutcomeReconciliation,
  type SessionEventLog,
} from './sessionEvents.js';
import { projectDurableToolBatch } from './toolExecutionIdentity.js';
import { captureSessionEventAppendFailure } from './sessionEventDiagnostics.js';
import { buildRepoMapPreamble } from './repoMapPreamble.js';
import {
  bindChatApprovalSession,
  getChatApprovalSession,
  setChatApprovalTurnId,
} from './chatApproval.js';
import { remoteMcpFailClosedObservation, remoteMcpIsFailClosed } from '../bridge/remoteApproval.js';
import { deriveSubagentApprovalSession } from './approvalRequests.js';
import { clearBackgroundShellRegistry, killAllBackgroundShells } from './backgroundShell.js';
import {
  createProviderProtocolInvariant,
  createRequestReconstructionInvariant,
  MODEL_VISIBLE_EQUALS_PERSISTED,
  PROVIDER_PROTOCOL_VALID,
  resolveRuntimeInvariantMode,
  RuntimeInvariantRegistry,
  type RequestReconstructionContext,
  type RuntimeInvariantMode,
} from './runtimeInvariants.js';
import { validateProviderMessageProtocol } from '../runners/providerMessages.js';
import { createHash, randomUUID } from 'node:crypto';
import { buildContextManifest, type ContextDeliveryMode } from './contextManifest.js';
import { buildModelRouteReceipt, hashRouteReference, type ModelRouteStage } from './modelRouteReceipt.js';
import {
  executeAwaitCommandAction,
  executeBackgroundRunCommandAction,
} from './chatBackgroundShell.js';

import { runReadOnlyAgentLoop } from './lanes/readOnlyAgentLoop.js';
import {
  deriveChildAllowance,
  inheritedChildBudgetLimiter,
  type ChildBudgetLimiter,
  type InheritedChildAllowance,
} from './childBudget.js';
import {
  childBudgetAttribution,
  classifySubagentFailure,
  runMutationAgentLoop,
  subagentFinishedCleanly,
  type SubagentAttribution,
} from './lanes/runMutationAgentLoop.js';
import { runImplementWorktreeAgent } from './implementWorktreeAgent.js';
import { executeTool, renderGitDiff, type ToolContext } from '../localTools.js';
import {
  createStallDetector,
  updateStallState,
  getStallInterventionMessage,
  isTextOnlyLoop,
  buildTextOnlyLoopIntervention,
  buildTextOnlyLoopBlockedMessage,
  TEXT_ONLY_FORCE_BLOCKED_THRESHOLD,
} from './stallDetector.js';
import type { StallState, StallIntervention } from './stallDetector.js';
import type { ProgressController, ProgressSignal } from './progressController.js';
import { classifyShellCapability } from './progressController.js';
import {
  progressSignalsFromReceipt,
  type ProgressReceipt,
} from './progressReceipt.js';
import { classifyPhase, buildPhaseNudge, shouldNudge, type ChatPhase } from './chatPhaseNudge.js';
import {
  assessMutationEffect,
  confirmedMutationPaths,
  isConfirmedMutation,
  isSuccessfulDirectMutation,
  type MutationEffectStatus,
} from './mutationTools.js';
import { ChatTurnTelemetryCollector, type ChatTurnTelemetryRecord } from './chatTurnTelemetry.js';
import type { DiffCriticVerdict } from './diffCritic.js';
import { evaluateTokenExplosionAfterTurn } from './budgetKillPolicy.js';
import {
  applyExploreFuses as applyExploreFusesPolicy,
  buildPolicyTerminalBlockedReport,
  resolveInvestigateHardCapObserveOnly,
  type ExploreFuseResult,
} from './chatZeroWritePolicy.js';
import { PolicyEventLog, type PolicyEvent } from './policyEventLog.js';
import {
  evaluateZeroWriteWithShadow,
  recordPolicyShadowSessionOutcome,
  resolveStallInterventionsEnabled,
  resolveStallShadowMode,
} from './policyShadow.js';
import { isCodingTaskSuccess } from '../services/codingTaskSuccess.js';
import { BlockedAttemptLedger } from './blockedAttemptLedger.js';
import { TurnRoutingReceiptLog, type TurnRoutingReceipt } from './turnRoutingReceipt.js';
import { resolvePhaseModelName } from './phaseModelRouting.js';
import { ObservationTailBuffer, resolveObservationTailChars } from './observationTails.js';
import {
  buildPromptFingerprint,
  buildStreamDone,
  buildStreamFailed,
  computeTerminalOutcome,
  makeChatRunner,
  observabilityResultFields,
  persistPolicyEventsJsonl,
  persistTranscriptToDisk,
  pushProviderTurnMessages,
  pushRoutingReceiptFromMetadata,
  recordPolicyEvent,
  recordTurnToolObservability,
  stashEngineFingerprint,
  type ObservabilityHandles,
  type PromptFingerprint,
} from './chatEngineObservability.js';

import {
  buildCriticBlockedAnswer,
  buildCriticBlockedReport,
  buildGateRejectionMessage,
  checkCostWallBudgets,
  currentTurnHasMutation as turnHasMutation,
  formatBudgetKillAnswer,
  hasAnyWrites as sessionHasAnyWrites,
  isDiffCriticEnabled,
  maybeInjectMidLoopHeuristicCritic as injectMidLoopHeuristicCritic,
  runAsymmetricDiffCritic as runAsymmetricDiffCriticImpl,
  computeCriticRepairCostCap,
  computePostWriteRepairWallMs,
  buildPostWriteRepairMessage,
  type AsymmetricCriticState,
  type CriticRunner,
} from './chatEngineCriticBudget.js';
import {
  detectAndBuildBlockedReport as detectBlockedReportFromAnswer,
  runPostEditStaticCheck as runPostEditStaticCheckFn,
  summarizeDroppedTurns as summarizeDroppedTurnsFn,
  compactHeuristicConversation,
  pinProjectRootEnv,
  noteChatWorkspaceMutation,
  invalidateVerifierLedger,
  nativeToolUseToChatAction,
  formatResultDetail,
  countPatchStats,
  primaryPatchPath,
  executeLspChatToolAction,
} from './chatEngineSupport.js';
import {
  applyTamperEscalation as applyTamperEscalationFn,
  checkVerifierTamper as checkVerifierTamperFn,
  extractVerifierCommand as extractVerifierCommandFn,
  hashContent as hashContentFn,
  initializeVerifierDependencyHashes,
} from './chatEngineVerifierSession.js';
import { isFatalWindowsProcessExit, logPlatformUnusableResult } from './verifierFailFast.js';
import { RepetitionDetector } from './repetitionDetector.js';
import { captureThought } from './thoughtCapture.js';
import {
  prepareKernelVerifierInput,
  captureAndRecordVerifierReceipt,
  resolveEngineRequiredVerifiers,
  restorePersistedVerifierEvidence,
} from './chatEngineVerifierAdapter.js';
import { beginUserSubmission, type TurnRuntimeSnapshot } from './turnRuntime.js';

// ─── Types ────────────────────────────────────────────────────────────────

/** Classifies the user's intent for a chat turn.
 *  'execute' = user wants code changes → gate active in headless mode
 *  'explain' = user wants information → gate bypassed */
export type TaskIntent = 'execute' | 'explain';

function isPersistedTurnRuntime(value: unknown): value is TurnRuntimeSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const numericKeys = [
    'submissionIndex',
    'writeCount',
    'gateStrikes',
    'criticStrikes',
    'turnsWithoutWrite',
    'consecutiveReadOnlyTools',
    'consecutiveNonMutatingShells',
    'toolsWithoutWrite',
  ];
  if (numericKeys.some((key) => typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key]))) {
    return false;
  }
  const booleanKeys = [
    'midLoopCriticFired',
    'budgetExceeded',
    'budgetLastChanceDone',
    'restrictToolsNextTurn',
    'continuedTask',
  ];
  if (booleanKeys.some((key) => typeof candidate[key] !== 'boolean')) return false;
  if (
    typeof candidate.taskText !== 'string' ||
    (candidate.taskIntent !== 'execute' && candidate.taskIntent !== 'explain') ||
    typeof candidate.taskClass !== 'string' ||
    typeof candidate.projectRoot !== 'string' ||
    (candidate.stickyIntent !== null &&
      candidate.stickyIntent !== 'execute' &&
      candidate.stickyIntent !== 'explain') ||
    (candidate.gatePolicy !== null &&
      candidate.gatePolicy !== 'none' &&
      candidate.gatePolicy !== 'required' &&
      candidate.gatePolicy !== 'strict')
  ) {
    return false;
  }
  return true;
}

export type ChatAllowanceCostCap =
  | { kind: 'finite'; usd: number }
  | { kind: 'unlimited' };

export interface ChatAllowanceGrant {
  grantId: string;
  provenance: string;
  costCapUsd: number;
  wallCapMs: number;
  turnCap: number;
}

export interface ChatTaskAllowanceSnapshot {
  schemaVersion: 2;
  taskOwnerId: string;
  accountingEpoch: string;
  grant: {
    grantId: string;
    provenance: string;
    costCap: ChatAllowanceCostCap;
    wallCapMs: number;
    turnCap: number;
  };
  consumed: {
    costUsd: number;
    activeWallMs: number;
    turns: number;
  };
  repair: {
    criticRepairCostCapUsd: number | null;
    postWriteRepairWallCapMs: number | null;
    postWriteRepairRestrict: boolean;
  };
  accountedChargeIds: string[];
  activeExecution: boolean;
  taskCostBaselineUsd: number;
  lastTurnRuntime?: TurnRuntimeSnapshot;
}

function allowanceCostCap(costCapUsd: number): ChatAllowanceCostCap {
  return Number.isFinite(costCapUsd)
    ? { kind: 'finite', usd: costCapUsd }
    : { kind: 'unlimited' };
}

function allowanceCostCapUsd(costCap: ChatAllowanceCostCap): number {
  return costCap.kind === 'finite' ? costCap.usd : Infinity;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseTaskAllowance(value: unknown): ChatTaskAllowanceSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate['schemaVersion'] !== 2) return null;
  if (
    typeof candidate['taskOwnerId'] !== 'string' ||
    candidate['taskOwnerId'].length === 0 ||
    typeof candidate['accountingEpoch'] !== 'string'
  ) return null;
  const grant = candidate['grant'];
  const consumed = candidate['consumed'];
  const repair = candidate['repair'];
  if (
    grant === null || typeof grant !== 'object' ||
    consumed === null || typeof consumed !== 'object' ||
    repair === null || typeof repair !== 'object'
  ) return null;
  const grantRecord = grant as Record<string, unknown>;
  const consumedRecord = consumed as Record<string, unknown>;
  const repairRecord = repair as Record<string, unknown>;
  const rawCostCap = grantRecord['costCap'];
  if (rawCostCap === null || typeof rawCostCap !== 'object') return null;
  const costCapRecord = rawCostCap as Record<string, unknown>;
  const costCap: ChatAllowanceCostCap | null =
    costCapRecord['kind'] === 'unlimited'
      ? { kind: 'unlimited' }
      : costCapRecord['kind'] === 'finite' && isNonNegativeFinite(costCapRecord['usd'])
        ? { kind: 'finite', usd: costCapRecord['usd'] }
        : null;
  if (
    costCap === null ||
    typeof grantRecord['grantId'] !== 'string' ||
    grantRecord['grantId'].length === 0 ||
    typeof grantRecord['provenance'] !== 'string' ||
    grantRecord['provenance'].length === 0 ||
    !isNonNegativeFinite(grantRecord['wallCapMs']) ||
    !Number.isInteger(grantRecord['turnCap']) ||
    (grantRecord['turnCap'] as number) < 1 ||
    !isNonNegativeFinite(consumedRecord['costUsd']) ||
    !isNonNegativeFinite(consumedRecord['activeWallMs']) ||
    !Number.isInteger(consumedRecord['turns']) ||
    (consumedRecord['turns'] as number) < 0 ||
    (repairRecord['criticRepairCostCapUsd'] !== null &&
      !isNonNegativeFinite(repairRecord['criticRepairCostCapUsd'])) ||
    (repairRecord['postWriteRepairWallCapMs'] !== null &&
      !isNonNegativeFinite(repairRecord['postWriteRepairWallCapMs'])) ||
    typeof repairRecord['postWriteRepairRestrict'] !== 'boolean' ||
    !Array.isArray(candidate['accountedChargeIds']) ||
    !(candidate['accountedChargeIds'] as unknown[]).every((id) => typeof id === 'string') ||
    typeof candidate['activeExecution'] !== 'boolean' ||
    !isNonNegativeFinite(candidate['taskCostBaselineUsd'])
  ) return null;
  const parsed: ChatTaskAllowanceSnapshot = {
    schemaVersion: 2,
    taskOwnerId: candidate['taskOwnerId'],
    accountingEpoch: candidate['accountingEpoch'],
    grant: {
      grantId: grantRecord['grantId'],
      provenance: grantRecord['provenance'],
      costCap,
      wallCapMs: grantRecord['wallCapMs'],
      turnCap: grantRecord['turnCap'] as number,
    },
    consumed: {
      costUsd: consumedRecord['costUsd'],
      activeWallMs: consumedRecord['activeWallMs'],
      turns: consumedRecord['turns'] as number,
    },
    repair: {
      criticRepairCostCapUsd: repairRecord['criticRepairCostCapUsd'] as number | null,
      postWriteRepairWallCapMs: repairRecord['postWriteRepairWallCapMs'] as number | null,
      postWriteRepairRestrict: repairRecord['postWriteRepairRestrict'],
    },
    accountedChargeIds: [...candidate['accountedChargeIds'] as string[]],
    // A crashed active marker is cleared on restore; downtime is not execution.
    activeExecution: false,
    taskCostBaselineUsd: candidate['taskCostBaselineUsd'],
    ...(isPersistedTurnRuntime(candidate['lastTurnRuntime'])
      ? { lastTurnRuntime: candidate['lastTurnRuntime'] }
      : {}),
  };
  return parsed;
}

/** Options for a single user submission (W0.3 TurnRuntime). */
export interface SubmitMessageOptions {
  /**
   * Explicit continuation linkage: preserve write/gate counters from the
   * prior submission. Default false — isolate so prior writes cannot satisfy
   * a new task's completion gate.
   */
  continueTask?: boolean;
}

import { deniesReadOnlyChatAction, filterReadOnlyChatTools, isReadOnlyChat, resolveChatRangePath } from './chatReadOnly.js';

export interface ChatEngineOptions {
  instructionRoot?: string;
  /** Trusted embedding seam: pins all inference phases to one observed runner. */
  providerRunner?: DeepInfraApiRunner;
  /** Immutable policy for a trusted embedded provider, never model-supplied. */
  providerPolicy?: ResolvedModelPolicy;
  task: string;
  projectRoot: string;
  runId?: string;
  resumeExisting?: boolean;
  systemContext?: string;
  /** Appended system prompt fragments (plugins, skills, project memory).
   *  Injected after the base system prompt for layered context assembly. */
  appendSystemPrompt?: string;
  /** Pre-flight context injected into the system prompt (git state, session info, etc.).
   *  Gathered once per engine session and appended after appendSystemPrompt. */
  preflightContext?: string;
  model?: string;
  modelTier?: string;
  provider?: string;
  maxTurns?: number;
  maxConversationMessages?: number;
  maxEstimatedTokens?: number;
  /** R11: Per-round token ceiling — a single turn exceeding this with zero
   *  tool calls is force-BLOCKED. Default 200_000. */
  maxTokensPerRound?: number;
  /** Explicit wall-budget request. Still clamped by the resolver's ceiling
   *  (one hour, or LONG_TASK ceiling when BABEL_CHAT_LONG_TASK is authorized);
   *  requested vs effective stays observable via limits.wallBudget. */
  maxWallMs?: number;
  /** Explicit cost-budget request. Marks costBudget.explicitCostCeiling. */
  maxCostUsd?: number;
  allowExpensive?: boolean;
  workspaceRoot?: string | null;
  fallbackModel?: string;
  /** C1: Structured intent plan user message injected at session start
   *  for execute tasks when the intent compiler is enabled. */
  intentPlanUserMessage?: string;
  /**
   * Implementor W1.3: hard plan mode — block all mutations until /execute-plan.
   * Also implied by operatorMode === 'hard_plan'.
   */
  hardPlanMode?: boolean;
  /** Implementor W1.4 operator policy (orthogonal to chat/plan/deep ValidMode). */
  operatorMode?: import('./planExecuteMode.js').ChatOperatorMode;
  /** Implementor W1.3: plan→execute handoff injected at first user turn. */
  planHandoff?: import('./planExecuteMode.js').ChatPlanExecuteHandoff;
  /** Shared kernel profile. Plan is read-only; deep retains governed writes. */
  executionProfile?: ChatExecutionProfile;
  /** Externally supplied required verifier commands for completion gate scope. */
  requiredVerifierCommands?: readonly string[] | null;
  /** C1/B7 rollout: enforce in development/CI, shadow in production by default. */
  runtimeInvariantMode?: RuntimeInvariantMode;
  /** Test-only: explicit live workspace revision hash for gate freshness tests. */
  testWorkspaceRevisionHash?: string | null;
  /** Truthful delivery surface for the model-visible runtime metadata. */
  runtimeMode?: ChatRuntimeMode;
}

/** Shared TUI/headless/direct preparation applied to a live or reused engine. */
export interface ChatEngineTurnPreparation {
  task: string;
  projectRoot?: string | undefined;
  instructionRoot?: string | undefined;
  systemContext?: string | undefined;
  appendSystemPrompt?: string | undefined;
  preflightContext?: string | undefined;
  model?: string | undefined;
  intentPlanUserMessage?: string | undefined;
  limits?: ChatEngineLimits;
  executionProfile?: ChatExecutionProfile;
  runtimeMode?: ChatRuntimeMode;
}

export interface ContextCompactedInfo {
  mode: 'llm' | 'heuristic';
  beforeMessages: number;
  afterMessages: number;
  message: string;
}

export interface ChatCallbacks {
  onAnswerChunk?: (chunk: string) => void;
  onToolStart?: (tool: string, target: string) => number;
  onToolComplete?: (id: number, detail?: string, error?: string, exitCode?: number) => void;
  onFileChanged?: (path: string, additions: number, deletions: number, content?: string) => void;
  onThought?: (thought: string) => void;
  /**
   * A new model generation is starting (engine 'thinking' event). Consumers
   * must commit any in-flight streamed answer instead of concatenating onto
   * it — keeps streaming and non-streaming presentation semantically equal.
   */
  onGenerationBoundary?: () => void;
  onContextCompacted?: (info: ContextCompactedInfo) => void;
  onSubAgentStart?: (info: { id: string; label: string; model?: string }) => void;
  onSubAgentComplete?: (info: { id: string; summary: string; tokens?: number }) => void;
  onSubAgentFailed?: (info: { id: string; error: string }) => void;
}

// ─── #5 Typed streaming events ───────────────────────────────────────────

/** Events yielded by executeRawStream() — the runner layer. */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string };

/** Events yielded by submitMessageStream() — the ChatEngine layer. */
export type ChatEvent =
  | { type: 'thinking' }
  | { type: 'answer_chunk'; text: string }
  | { type: 'tool_start'; toolCallId?: string; tool: string; target: string }
  | {
      type: 'tool_complete';
      toolCallId?: string;
      tool: string;
      target: string;
      detail?: string;
      error?: string;
      exitCode?: number;
      effect_status?: MutationEffectStatus;
      mutation_paths?: string[];
    }
  | {
      type: 'tool_failed';
      toolCallId?: string;
      tool: string;
      target: string;
      detail?: string;
      error?: string;
      exitCode?: number;
      effect_status?: MutationEffectStatus;
      mutation_paths?: string[];
    }
  | { type: 'thought'; text: string }
  | {
      type: 'context_compacted';
      mode: 'llm' | 'heuristic';
      beforeMessages: number;
      afterMessages: number;
      message: string;
    }
  | { type: 'sub_agent_start'; id: string; label: string; model?: string }
  | { type: 'sub_agent_complete'; id: string; summary: string; tokens?: number }
  | { type: 'sub_agent_failed'; id: string; error: string }
  | {
      type: 'file_changed';
      path: string;
      additions: number;
      deletions: number;
      content?: string;
    }
  | {
      type: 'done';
      answer: string;
      usage: SessionUsageSummary;
      /** Canonical legacy status derived from outcome when known. */
      status?: ChatStatus;
      /** Authoritative terminal outcome from the engine (P0-D lossless). */
      outcome?: TerminalOutcome;
      planOutcome?: 'PLAN_COMPLETE';
      budgetExceeded?: boolean;
      toolCalls?: Array<{
        toolCallId?: string;
        tool: string;
        target: string;
        detail?: string;
        error?: string;
        effect_status?: MutationEffectStatus;
        mutation_paths?: string[];
      }>;
      runDir?: string;
      verifierReceipt?: {
        command: string;
        exit_code: number;
        summary: string;
      } | null;
      blockedReport?: BlockedReport | null;
      /** R9: Whether the agent modified a verifier dependency file. */
      verifierTampered?: boolean;
      /** Idea 14: asymmetric diff critic receipt. */
      criticReceipt?: DiffCriticVerdict | null;
      policyEvents?: PolicyEvent[];
      turnRouting?: TurnRoutingReceipt[];
      observationTails?: Array<{
        tool: string;
        target: string;
        exit_code?: number;
        tail: string;
      }>;
      blockedAttempts?: import('./blockedAttemptLedger.js').BlockedAttempt[];
      turnTelemetry?: ChatTurnTelemetryRecord;
      costBudget?: ChatEngineLimits['costBudget'];
      runAllowance?: ChatEngineRunAllowanceReport;
    }
  | {
      type: 'failed';
      error: string;
      status?: ChatStatus;
      /** Present when tools ran before failure (turn-limit / stall kill / etc.). */
      toolCalls?: Array<{
        toolCallId?: string;
        tool: string;
        target: string;
        detail?: string;
        error?: string;
        effect_status?: MutationEffectStatus;
        mutation_paths?: string[];
      }>;
      runDir?: string;
      /** Preserve INFRA_FAILURE vs AGENT_FAILURE when the engine already classified. */
      outcome?: import('../schemas/agentContracts.js').TerminalOutcome;
      turnTelemetry?: ChatTurnTelemetryRecord;
      costBudget?: ChatEngineLimits['costBudget'];
      runAllowance?: ChatEngineRunAllowanceReport;
    }
  | {
      type: 'cancelled';
      status?: ChatStatus;
      outcome?: 'CANCELLED';
      turnTelemetry?: ChatTurnTelemetryRecord;
    }
  | {
      type: 'progress_recovery';
      intervention: import('./progressController.js').ProgressInterventionLevel;
      source: string;
      score: number;
      message?: string;
    };

export interface ChatResult {
  status: ChatStatus;
  /** Honest terminal outcome — semantically precise, never conflated.
   *  Optional for backward compatibility with test fixtures that omit it. */
  outcome?: TerminalOutcome;
  /** Separate plan-mode completion result; never an executor terminal. */
  planOutcome?: 'PLAN_COMPLETE';
  answer: string;
  usage: SessionUsageSummary;
  conversation: ChatMessage[];
  toolCalls?: Array<{
    toolCallId?: string;
    tool: string;
    target: string;
    detail?: string;
    error?: string;
    effect_status?: MutationEffectStatus;
    mutation_paths?: string[];
  }>;
  runDir?: string;
  verifierReceipt?: {
    command: string;
    exit_code: number;
    summary: string;
  } | null;
  blockedReport?: BlockedReport | null;
  dedupeHitCount?: number;
  verifierTampered?: boolean;
  criticReceipt?: DiffCriticVerdict | null;
  budgetExceeded?: boolean;
  gatePolicy?: VerificationPolicy;
  /** Tier A2: Policy events emitted during the session. */
  policyEvents?: PolicyEvent[];
  /** Tier A3: Per-turn routing receipts. */
  turnRouting?: TurnRoutingReceipt[];
  /** Tier A5: Last-N tool observation tails. */
  observationTails?: Array<{
    tool: string;
    target: string;
    exit_code?: number;
    tail: string;
  }>;
  /** Tier A1: Aggregate counts derived from the tool call log. */
  toolCallAggregates?: {
    tool_call_count: number;
    write_count: number;
    verifier_attempt_count: number;
  };
  promptFingerprint?: PromptFingerprint;
  /** Active input prompt tokens from latest single model invocation */
  lastRequestPromptTokens?: number | null;
  /** Active completion output tokens from latest single model invocation */
  lastRequestCompletionTokens?: number | null;
  /** Structured active context telemetry from latest provider invocation */
  activeContext?: {
    tokens: number;
    modelId: string;
    source: 'provider_prompt_tokens' | 'estimated' | 'unknown';
  } | null;
  turnTelemetry?: ChatTurnTelemetryRecord;
  /** Enumerable cost-budget provenance — survives JSON / spreads / manifests. */
  costBudget?: ChatEngineLimits['costBudget'];
  /** Enumerable declared vs effective run allowance + terminating limiter. */
  runAllowance?: ChatEngineRunAllowanceReport;
}

// ─── Constants ────────────────────────────────────────────────────────────

const TURN_TIMEOUT_MS = 120_000; // per-turn LLM call deadline
const MAX_TOOL_CONCURRENCY = 6; // Prevent exhausting connection pools
/**
 * I1: text-tools cap for the bounded child section. The section is already
 * bounded by childConclusion (2 KB conclusion + 0.5 KB error + 12 evidence
 * refs), so this is comfortably above its worst case and keeps the provenance
 * `authority` line and evidence tail visible on the text path.
 */
const SUB_AGENT_TEXT_MAX_CHARS = 6000;

/**
 * S03/#213 slice 2: stable child delegation id bound to the parent operation
 * (run + turn + batch + action index + operation fingerprint), not a batch-local
 * counter. Distinct batches -> distinct ids; same delegation -> same id.
 */
export function deriveChildDelegationId(input: {
  parentRunId: string;
  turnId: string;
  batchId: string;
  actionIndex: number;
  fingerprint: string;
}): string {
  const digest = createHash('sha256')
    .update(
      [
        input.parentRunId,
        input.turnId,
        input.batchId,
        String(input.actionIndex),
        input.fingerprint,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 12);
  return `chat-sub-${digest}`;
}

/** S03/#213 slice 2: per-attempt evidence dir so a retry cannot overwrite it. */
export function childAttemptDir(engineRunDir: string, subId: string, attempt: number): string {
  return join(engineRunDir, subId, `attempt-${attempt}`);
}

/** S02: minimal shape of a text-tools log entry (see ChatEngine.toolCallLog). */
export interface TextToolResultEntry {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * S02/#212: text-tools rendering was rebuilt from `toolCallLog` and only
 * surfaced read/grep/glob/list_dir/run_command stdout, so a read-only child
 * conclusion never reached the model on the text path. Extracted pure so both
 * delivery modes can be asserted directly.
 */
export function formatTextToolResults(entries: readonly TextToolResultEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.error === 'blocked') {
      parts.push(`[ERROR] ${entry.tool}:${entry.target} blocked`);
      continue;
    }
    // S02/I1: sub_agent handoff (conclusion + status + evidence refs) before the
    // generic exit-code branch, so failed/policy-denied children still surface
    // their bounded result instead of a 500-char error slice. The child section
    // is self-bounded by childConclusion (conclusion/error/evidence caps), so it
    // gets a larger explicit cap than generic tool output — otherwise the
    // provenance `authority` line and evidence tail would be truncated away.
    if (entry.tool === 'sub_agent' && entry.stdout) {
      const out =
        entry.stdout.length > SUB_AGENT_TEXT_MAX_CHARS
          ? entry.stdout.slice(0, SUB_AGENT_TEXT_MAX_CHARS) + '\n... [truncated]'
          : entry.stdout;
      parts.push(
        `[RESULT] ${entry.tool}:${entry.target}\n${entry.detail ? entry.detail + '\n' : ''}${out}`,
      );
      continue;
    }
    if (entry.exit_code !== undefined && entry.exit_code !== 0) {
      const err = (entry.stderr || entry.stdout || '').slice(0, 500);
      parts.push(`[ERROR] ${entry.tool}:${entry.target} exit ${entry.exit_code}: ${err}`);
      continue;
    }
    // Tools whose output content the model needs to ingest
    if (entry.stdout && ['read_file', 'grep', 'glob', 'list_dir'].includes(entry.tool)) {
      const truncated =
        entry.stdout.length > 3000
          ? entry.stdout.slice(0, 3000) + '\n... [truncated]'
          : entry.stdout;
      parts.push(`[RESULT] ${entry.tool}:${entry.target}\n${truncated}`);
      continue;
    }
    // run_command: include output
    if (entry.tool === 'run_command' && entry.stdout) {
      const out = entry.stdout.slice(0, 1000);
      parts.push(`[RESULT] ${entry.tool}:${entry.target}\n${out}`);
      continue;
    }
    // Default: simple [OK] summary
    const detail = entry.detail ? ` (${entry.detail})` : '';
    parts.push(`[OK] ${entry.tool}:${entry.target}${detail}`);
  }
  return parts.join('\n\n');
}

// ─── Conversational-turn detection ────────────────────────────────────────
// Pure greetings / acknowledgements / punctuation-only turns ('?', 'hello',
// 'thanks') carry no task content. They must not take the execute path:
// execute-intent classification makes the zero-write completion refusal
// re-query trivial turns until the turn budget is exhausted. Whole-input
// match keeps action-bearing requests ('hi — fix the bug') on execute via
// the verb checks in classifyChatTaskIntent.
const CONVERSATIONAL_TURN_RE =
  /^(?:(?:hi+|hello+|hey+|yo|sup|howdy|greetings|good\s*(?:morning|afternoon|evening|day)|hi\s+there|hello\s+there|thanks|thank\s*you|thankyou|thx|ty|ok(?:ay)?|cool|nice|great|awesome|perfect|got\s*it|sounds\s+good|bye|goodbye|see\s*ya)(?:[!,.?;:\s]+|$))+$/i;
const PUNCTUATION_ONLY_TURN_RE = /^[\s\p{P}\p{S}\p{C}]*$/u;

function isConversationalTurnText(task: string): boolean {
  const t = task.trim();
  if (!t || t.length > 32) return false;
  return PUNCTUATION_ONLY_TURN_RE.test(t) || CONVERSATIONAL_TURN_RE.test(t);
}

/**
 * Provider tool_call ids are untrusted data: empty ids and duplicate ids both
 * make tool results unpairable at the wire boundary. Canonicalize to a
 * non-empty, turn-unique id so every declared call stays individually
 * answerable (tool_cycle protocol invariant).
 */
function canonicalizeToolCallId(
  event: { id?: string },
  turn: number,
  actionIndex: number,
  seen: Set<string>,
): string {
  const candidates = [
    event.id && event.id.length > 0 ? event.id : undefined,
    `tool_call_${turn}_${actionIndex}`,
    `tool_call_${turn}_${actionIndex}_${seen.size}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }
  let suffix = seen.size;
  while (seen.has(`tool_call_${turn}_${actionIndex}_${suffix}`)) suffix += 1;
  const fallback = `tool_call_${turn}_${actionIndex}_${suffix}`;
  seen.add(fallback);
  return fallback;
}

/**
 * Reconcile an already-streamed answer with the final parsed answer so the
 * renderer never displays duplicated text.
 *
 * - exact match → nothing left to emit
 * - final extends the streamed prefix → emit only the missing suffix
 *   ("Hello " streamed, "Hello world" final → emit "world")
 * - zero stream → emit the full answer once
 * - divergent/normalized final → emit the full answer once
 *
 * Divergence should not occur in practice: only native append-compatible
 * paths stream live (final === concatenated deltas by construction), while
 * parse/normalization paths (text-tools, legacy JSON, lenient fallbacks) are
 * buffered and stream nothing. If a future path makes divergence reachable,
 * the correct fix is buffering on that path or a renderer replacement event —
 * appending after already-rendered divergent content duplicates user-visible
 * text.
 */
export function reconcileStreamedAnswer(streamed: string | null, final: string): string | null {
  if (!final) return null;
  if (streamed === null || streamed === '') return final;
  if (final === streamed) return null;
  if (final.startsWith(streamed)) return final.slice(streamed.length);
  return final;
}

// ─── ChatEngine ───────────────────────────────────────────────────────────

export class ChatEngine {
  // TODO: once ProviderMessage[] path is stable, remove legacy ChatMessage[]
  // conversation store and Markdown flattening buildChatTurnPrompt.
  private conversation: ChatMessage[] = [];
  private readonly services: ChatEngineServices;
  private readonly executorKernel: ExecutorKernel;
  private readonly executionProfile: ChatExecutionProfile;
  private abortController: AbortController;
  private engineRunId: string;
  private options: ChatEngineOptions;
  /** Mutable: P0-C re-resolves limits on isolated user submissions (task class change). */
  private limits: ChatEngineLimits;
  private modelPolicy: ResolvedModelPolicy | undefined;
  private synthesisRunner:
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
    | OpenRouterApiRunner
    | null = null;
  private deliberationRunner:
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
    | OpenRouterApiRunner
    | null = null;
  private fallbackRunner:
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
    | OpenRouterApiRunner
    | null = null;
  private toolCallLog: Array<{
    toolCallId?: string;
    tool: string;
    target: string;
    detail?: string;
    error?: string;
    index: number;
    exit_code?: number;
    stdout?: string;
    stderr?: string;
    verified?: boolean;
    mutation_paths?: string[];
    effect_status?: MutationEffectStatus;
  }> = [];
  private lastVerifierReceipt: BoundChatVerifierReceipt | null = null;
  private executedVerifierLedger: BoundChatVerifierReceipt[] = [];
  /**
   * M1: fingerprint (tool + exit code + output hash) of the last verifier run
   * this task. A repeated identical shell loop is not "verifier progress".
   */
  private lastVerifierSignalSignature: string | null = null;
  /** Index into toolCallLog at the start of the current turn's actions.
   *  Used to correctly slice per-turn entries even as the log grows across turns. */
  private _turnToolCallLogStart = 0;
  private gatePolicy: VerificationPolicy | null = null;
  private gateStrikes = 0;
  private static readonly MAX_GATE_STRIKES = 3;
  private criticStrikes = 0;
  private progressController: ProgressController;
  private lastCriticReceipt: DiffCriticVerdict | null = null;
  private criticRunner: CriticRunner | null = null;
  private criticProRunner: CriticRunner | null = null;
  private budgetExceeded = false;
  private budgetLastChanceDone = false;
  /** Actual limiter that terminated the run, or null while still active. */
  private terminatingLimiter: ChatRunLimiter | null = null;
  private terminalLimiterReason: string | null = null;
  private midLoopCriticFired = false;
  /** Bound final-request admission recovery to one rebuild per user submission. */
  private preparedAdmissionCompactionAttempts = 0;
  /** Logical request lineage for compaction/fallback rebuild receipts. */
  private lastLogicalRequestId: string | null = null;
  private pendingParentRequestId: string | null = null;
  private turnsWithoutWrite = 0;
  /** Resolved task class for this thread (recomputed per isolated submission). */
  private taskClass: ChatTaskClass;
  /** W0.3: last user-submission runtime (counters re-synced from live fields). */
  private lastTurnRuntime: TurnRuntimeSnapshot | null = null;
  /** Discovered project test commands for gate rejection hints. */
  private discoveredTestCommands: DiscoveredTestCommand[] = [];
  /** Crash-safe patch persistence: write-through after each successful mutation. */
  private patchRecoveryPath: string | null = null;
  /** Consecutive exploration tools without a successful file mutation. */
  private consecutiveReadOnlyTools = 0;
  /** Implementor: consecutive shell tools without a successful mutation. */
  private consecutiveNonMutatingShells = 0;
  /** Implementor: tools since last successful mutation. */
  private toolsWithoutWrite = 0;
  /** One-shot explore-fuse shadow kinds this session (force_mutate_shadow, …). */
  private exploreShadowLoggedKinds = new Set<string>();
  /**
   * After first diff-critic reject: effective cost ceiling (spent + repair window).
   * null = use limits.maxCostUsd only.
   */
  private criticRepairCostCapUsd: number | null = null;
  /**
   * Absolute wall deadline (ms from session start) after first successful write.
   * Caps remaining thrash so patches get verify/repair time (Wave A C1).
   */
  private postWriteRepairWallCapMs: number | null = null;
  /**
   * After first write: wall/cost repair slice is active. Investigation tools
   * stay available; a red verifier reopens targeted reinspection.
   */
  private postWriteRepairRestrict = false;
  /** Last authoritative verifier failed (reopens investigation tools). */
  private lastVerifierFailed = false;
  private workingState: WorkingState = createWorkingState();
  /** Soft investigate-budget one-shot latch (synced via explore fuse state). */
  private investigateSoftNudgeDone = false;
  /** Cumulative exploration tools across the entire session (never resets).
   *  Used for progressive escalation to prevent A01-class analysis paralysis. */
  private cumulativeExplorationTools = 0;
  /** Full-file read counts keyed by normalized path. */
  private fullReadCounts = new Map<string, number>();
  private apiTokenCount = 0;
  /** Prompt tokens from latest single model invocation in the active turn */
  private lastRequestPromptTokens: number | null = null;
  /** Completion output tokens from latest single model invocation in the active turn */
  private lastRequestCompletionTokens: number | null = null;
  private lastRequestModelId: string | null = null;
  /** R11: API-reported token count at the start of the current turn.
   *  Used to compute the per-round token delta for the token ceiling check. */
  private apiTokenCountAtTurnStart = 0;
  /** R11: True when the current turn executed at least one tool action.
   *  Used by the auto-continue refusal gate — a turn with zero tool
   *  calls must not be auto-restarted. */
  private _hadToolCallsThisTurn = false;
  /** When true, the next deliberateTurn / native-tools call restricts
   *  the tool schema to write+verify+todo+finish only (no read/exploration).
   *  Set by the stall restrict_tools intervention; cleared after one turn. */
  private restrictToolsNextTurn = false;
  private logicalTurnToolPolicy: import('./codingLoop/oneShotToolPolicy.js').OneShotPolicySnapshot<
    ReturnType<typeof resolveNextTurnToolAccess>
  > = { taken: false };
  private _sessionStartTime = 0;
  /** Legacy observable baseline; enforcement uses task-indexed accounting. */
  private taskCostBaselineUsd = 0;
  /** Durable allowance for the current immutable task owner. */
  private taskAllowance: ChatTaskAllowanceSnapshot | null = null;
  /** Monotonic checkpoint for active execution wall time. */
  private activeExecutionCheckpointMs: number | null = null;
  /** Stable logical provider request identity consumed by trackRunnerUsage. */
  private pendingUsageChargeId: string | null = null;
  /** True when a resumed run lacks valid durable scoped-accounting state. */
  private taskCostScopeUnavailable = false;
  private stallState: StallState = createStallDetector();
  private cachedSystemPromptLegacy: string | null = null;
  private cachedSystemPromptNative: string | null = null;
  private cachedSystemPromptText: string | null = null;
  private repoMapCache: string | null = null;
  /**
   * Monotonically increasing generation counter. Incremented at the start
   * of each submitMessage() call. Streaming callbacks check this value to
   * prevent stale callbacks from a cancelled/aborted request from
   * affecting the current turn.
   */
  private generationCounter = 0;
  /** Flag set by cancel() to signal pending work should stop immediately.
   *  Used alongside AbortController to close the race window where a new
   *  controller replaces the aborted one before the loop re-checks it. */
  private _cancelled = false;
  /** LLM-based conversation compaction (from chatCompaction.ts).
   *  Undefined when BABEL_COMPACTION=off — falls back to heuristic truncation. */
  private compactionManager?: CompactionManager;
  /**
   * Number of consecutive compaction failures for circuit breaker.
   *
   * This circuit breaker guards ChatEngine's inline `compactConversation()`
   * method which drops old ChatMessage[] entries from the conversation array
   * and injects text summaries. It is SEPARATE from the module-level circuit
   * breaker in compaction.ts (which guards `autoCompactIfNeeded` — the
   * step-level ToolCallLog[] stdout/stderr pruning used by the governed
   * pipeline). They are independent because the two compaction mechanisms
   * operate on different data structures and serve different callers.
   *
   * @see compactionConsecutiveFailures in compaction.ts
   */
  private compactionConsecutiveFailures = 0;
  private static readonly MAX_COMPACTION_FAILURES = 3;
  private readCache: ReadInjectionCache = new Map();
  /** Read-injection generation; compaction and re-preparation start a new context. */
  private readContextEpoch = 0;
  private dedupeHitCount = 0;
  private writeCount = 0;
  /** R8: Verifier receipt cache — avoids re-running identical verifier commands
   *  when no writes have occurred since the last run. Keyed by command string. */
  private verifierReceiptCache: Map<
    string,
    { receipt: BoundChatVerifierReceipt; writeCountAtCache: number }
  > = new Map();
  /** Commands that hard-crashed on this platform — never re-exec (A06 DLL_INIT thrash). */
  private platformUnusableVerifiers = new Set<string>();
  /** R9: SHA-256 hashes of verifier dependency files computed at session start.
   *  Keyed by relative file path (e.g. "package.json", "verify.mjs"). */
  private verifierDependencyHashes: Map<string, string> = new Map();
  private verifierTampered = false;
  private tamperCount = 0;
  private tamperedThisTurn = false;
  private todos: Map<string, { content: string; status: string }> = new Map();
  private activePlaybook: PlaybookDefinition | null = null;
  private requireTodoBeforeMutate = false;
  /** Implementor: hard plan mode blocks mutations. */
  private hardPlanMode = false;
  private planHandoff: ChatPlanExecuteHandoff | null = null;
  private forceMutateTurnsOverride: number | null = null;
  private operatorMode: ChatOperatorMode = 'default';
  private _lastPhase: ChatPhase | null = null;
  private investigateRunner:
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
    | OpenRouterApiRunner
    | null = null;
  private mutateRunner:
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
    | OpenRouterApiRunner
    | null = null;
  private repetitionDetector: RepetitionDetector;
  private policyEventLog = new PolicyEventLog(); // A2: policy event log
  private blockedAttemptLedger = new BlockedAttemptLedger(); // B3
  private routingReceiptLog = new TurnRoutingReceiptLog(); // A3: turn routing
  /** Tier A5: Last-N tool observation tail buffer. */
  private observationTails: ObservationTailBuffer;
  /** Tier A1: Current turn index (0-based) for per-turn metadata. */
  private _turnIndex = 0;
  /** Tier A1: Maps toolCallLog entry index → turn number. */
  private _logIndexToTurn = new Map<number, number>();
  /** P1–P3 live parity runtime (loop / progress / event log / approvals). */
  private parity: ParityRuntime;
  private readonly runtimeInvariants: RuntimeInvariantRegistry<RequestReconstructionContext>;
  private failureBudgetTracker: FailureClassBudgetTracker =
    createFailureBudgetTrackerFromContract(null);
  private testWorkspaceRevisionHash?: string | null | undefined;
  private currentTurnTelemetry: ChatTurnTelemetryCollector | null = null;
  private lastTurnTelemetry: ChatTurnTelemetryRecord | null = null;

  public setTestWorkspaceRevisionHash(hash: string | null | undefined): void {
    this.testWorkspaceRevisionHash = hash;
  }

  public getLastTurnTelemetry(): ChatTurnTelemetryRecord | null {
    return this.lastTurnTelemetry;
  }

  private get engineRunDir(): string {
    return chatSessionDir(this.engineRunId);
  }

  private readPersistedTaskBudget(runDir: string): ChatTaskAllowanceSnapshot | null {
    const path = join(runDir, 'task-budget.json');
    if (!existsSync(path)) return null;
    try {
      return parseTaskAllowance(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
  }

  private checkpointActiveWall(nowMs = Date.now()): void {
    if (!this.taskAllowance || this.activeExecutionCheckpointMs === null) return;
    this.taskAllowance.consumed.activeWallMs += Math.max(
      0,
      nowMs - this.activeExecutionCheckpointMs,
    );
    this.activeExecutionCheckpointMs = nowMs;
  }

  private persistTaskAllowance(): void {
    if (this.taskCostScopeUnavailable || !this.taskAllowance) return;
    try {
      this.checkpointActiveWall();
      this.taskAllowance.accountingEpoch = globalCostTracker.getAccountingEpoch();
      this.taskAllowance.consumed.costUsd = this.currentTaskCostUsd();
      this.taskAllowance.accountedChargeIds = globalCostTracker.getTaskChargeIds(
        this.taskAllowance.taskOwnerId,
      );
      this.taskAllowance.activeExecution = this.activeExecutionCheckpointMs !== null;
      this.taskAllowance.repair = {
        criticRepairCostCapUsd: this.criticRepairCostCapUsd,
        postWriteRepairWallCapMs: this.postWriteRepairWallCapMs,
        postWriteRepairRestrict: this.postWriteRepairRestrict,
      };
      if (this.lastTurnRuntime) this.taskAllowance.lastTurnRuntime = this.lastTurnRuntime;
      const path = join(this.engineRunDir, 'task-budget.json');
      const tmpPath = `${path}.tmp-${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(this.taskAllowance), 'utf8');
      renameSync(tmpPath, path);
    } catch {
      // A missing durable write removes our authority to continue spending.
      this.taskCostScopeUnavailable = true;
    }
  }

  /** Compatibility wrapper retained for existing checkpoint call sites. */
  private persistTaskCostBaseline(): void {
    this.persistTaskAllowance();
  }

  private createTaskAllowance(): ChatTaskAllowanceSnapshot {
    return {
      schemaVersion: 2,
      taskOwnerId: randomUUID(),
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      grant: {
        grantId: randomUUID(),
        provenance: 'chat-engine-initial',
        costCap: allowanceCostCap(this.limits.maxCostUsd),
        wallCapMs: this.limits.maxWallMs,
        turnCap: this.limits.maxTurns,
      },
      consumed: { costUsd: 0, activeWallMs: 0, turns: 0 },
      repair: {
        criticRepairCostCapUsd: null,
        postWriteRepairWallCapMs: null,
        postWriteRepairRestrict: false,
      },
      accountedChargeIds: [],
      activeExecution: false,
      taskCostBaselineUsd: captureCostBaselineUsd(),
    };
  }

  private startIndependentTaskCostScope(): void {
    this.taskCostScopeUnavailable = false;
    this.taskAllowance = this.createTaskAllowance();
    this.taskCostBaselineUsd = this.taskAllowance.taskCostBaselineUsd;
    this.activeExecutionCheckpointMs = null;
    this.persistTaskAllowance();
  }

  private currentTaskCostUsd(): number {
    if (!this.taskAllowance) return 0;
    return globalCostTracker.getTaskSummary(this.taskAllowance.taskOwnerId).totalCostUSD;
  }

  private currentTaskActiveWallMs(nowMs = Date.now()): number {
    if (!this.taskAllowance) return 0;
    return this.taskAllowance.consumed.activeWallMs +
      (this.activeExecutionCheckpointMs === null
        ? 0
        : Math.max(0, nowMs - this.activeExecutionCheckpointMs));
  }

  private restorePersistedTaskBudget(persisted: ChatTaskAllowanceSnapshot | null): void {
    this.taskCostScopeUnavailable = persisted === null || persisted.lastTurnRuntime === undefined;
    this.activeExecutionCheckpointMs = null;
    if (!persisted) {
      this.taskAllowance = null;
      this.taskCostBaselineUsd = captureCostBaselineUsd();
      this.lastTurnRuntime = null;
      return;
    }
    this.taskAllowance = persisted;
    this.taskCostBaselineUsd = persisted.taskCostBaselineUsd;
    this.lastTurnRuntime = persisted.lastTurnRuntime ?? null;
    this.criticRepairCostCapUsd = persisted.repair.criticRepairCostCapUsd;
    this.postWriteRepairWallCapMs = persisted.repair.postWriteRepairWallCapMs;
    this.postWriteRepairRestrict = persisted.repair.postWriteRepairRestrict;
    globalCostTracker.restoreTaskUsage(persisted.taskOwnerId, {
      totalCostUSD: persisted.consumed.costUsd,
      chargeIds: persisted.accountedChargeIds,
    });
    this.limits = {
      ...this.limits,
      maxCostUsd: allowanceCostCapUsd(persisted.grant.costCap),
      maxWallMs: persisted.grant.wallCapMs,
      maxTurns: persisted.grant.turnCap,
    };
  }

  public getTaskAllowanceSnapshot(): ChatTaskAllowanceSnapshot | null {
    if (!this.taskAllowance) return null;
    return structuredClone({
      ...this.taskAllowance,
      consumed: {
        ...this.taskAllowance.consumed,
        costUsd: this.currentTaskCostUsd(),
        activeWallMs: this.currentTaskActiveWallMs(),
      },
      activeExecution: this.activeExecutionCheckpointMs !== null,
    });
  }

  /** Explicitly replace the current grant. No other path may increase caps. */
  public renewAllowance(grant: ChatAllowanceGrant): void {
    if (this.taskCostScopeUnavailable || !this.taskAllowance) {
      throw new Error('Cannot renew allowance without a valid durable task scope');
    }
    if (!grant.grantId || !grant.provenance) {
      throw new Error('Allowance renewal requires grant identity and provenance');
    }
    const currentCostCap = allowanceCostCapUsd(this.taskAllowance.grant.costCap);
    const doesNotDecrease =
      grant.costCapUsd >= currentCostCap &&
      grant.wallCapMs >= this.taskAllowance.grant.wallCapMs &&
      grant.turnCap >= this.taskAllowance.grant.turnCap;
    const increases =
      grant.costCapUsd > currentCostCap ||
      grant.wallCapMs > this.taskAllowance.grant.wallCapMs ||
      grant.turnCap > this.taskAllowance.grant.turnCap;
    if (!doesNotDecrease || !increases) {
      throw new Error('Allowance renewal must increase at least one cap without decreasing another');
    }
    this.taskAllowance.grant = {
      grantId: grant.grantId,
      provenance: grant.provenance,
      costCap: allowanceCostCap(grant.costCapUsd),
      wallCapMs: grant.wallCapMs,
      turnCap: grant.turnCap,
    };
    this.limits.maxCostUsd = grant.costCapUsd;
    this.limits.maxWallMs = grant.wallCapMs;
    this.limits.maxTurns = grant.turnCap;
    this.persistTaskAllowance();
  }

  private beginActiveExecution(): void {
    if (this.activeExecutionCheckpointMs !== null) return;
    this.activeExecutionCheckpointMs = Date.now();
    this.persistTaskAllowance();
  }

  private pauseActiveExecution(): void {
    if (this.activeExecutionCheckpointMs === null) return;
    this.checkpointActiveWall();
    this.activeExecutionCheckpointMs = null;
    this.persistTaskAllowance();
  }

  /** Settle the active task interval before exposing any terminal truth. */
  private settleActiveExecutionForTerminal(): void {
    this.pauseActiveExecution();
  }

  private consumeTaskTurn(): void {
    if (!this.taskAllowance) return;
    this.taskAllowance.consumed.turns += 1;
    this.persistTaskAllowance();
  }

  private effectiveCostCapUsd(): number {
    return this.criticRepairCostCapUsd == null
      ? this.limits.maxCostUsd
      : Math.min(this.limits.maxCostUsd, this.criticRepairCostCapUsd);
  }

  private effectiveWallCapMs(): number {
    return this.postWriteRepairWallCapMs == null
      ? this.limits.maxWallMs
      : Math.min(this.limits.maxWallMs, this.postWriteRepairWallCapMs);
  }

  private deriveChildAllowance(maxRounds: number): InheritedChildAllowance {
    if (!this.taskAllowance) {
      throw new Error('Cannot delegate without a durable task allowance');
    }
    const parentDeadlineAtMs =
      Date.now() + Math.max(0, this.effectiveWallCapMs() - this.currentTaskActiveWallMs());
    return deriveChildAllowance({
      parentTaskOwnerId: this.taskAllowance.taskOwnerId,
      parentTaskBaselineUsd: this.taskCostBaselineUsd,
      parentEffectiveCostCapUsd: this.effectiveCostCapUsd(),
      parentDeadlineAtMs,
      childMaxRounds: maxRounds,
    });
  }

  private markChildBudgetExhausted(limiter: ChildBudgetLimiter, reason: string): void {
    this.budgetExceeded = true;
    this.budgetLastChanceDone = true;
    this.terminatingLimiter = 'child_exhaustion';
    this.terminalLimiterReason =
      `Inherited child ${limiter} allowance exhausted: ${reason}`;
  }

  constructor(options: ChatEngineOptions) {
    this.options = options;
    this.testWorkspaceRevisionHash = options.testWorkspaceRevisionHash;
    this.executionProfile = options.executionProfile ?? 'chat';
    this.executorKernel = createExecutorKernel(this.executionProfile);
    this.services = this.executorKernel.services;
    this.progressController = this.services.progress.createController();
    this.taskClass = resolveChatTaskClass({
      taskText: options.task,
      autoClassify: true,
    });
    // P0: Initialize gatePolicy from task class so the result payload always
    // reflects the effective verification policy, even when the gate is never
    // evaluated (prevents false_complete classification in benchmarks).
    this.gatePolicy = getChatTaskTune(this.taskClass).verificationPolicy;
    this.limits = resolveChatEngineLimits(
      {
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(options.maxConversationMessages !== undefined
          ? { maxConversationMessages: options.maxConversationMessages }
          : {}),
        ...(options.maxEstimatedTokens !== undefined
          ? { maxEstimatedTokens: options.maxEstimatedTokens }
          : {}),
        ...(options.maxTokensPerRound !== undefined
          ? { maxTokensPerRound: options.maxTokensPerRound }
          : {}),
        ...(options.maxWallMs !== undefined ? { maxWallMs: options.maxWallMs } : {}),
        ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
      },
      undefined,
      { taskClass: this.taskClass, taskText: options.task },
    );
    this.abortController = new AbortController();
    this.engineRunId = options.runId ?? allocateThreadId();
    // definite assignment: engineRunId set immediately above
    this.parity = createParityRuntime(this.engineRunId);
    this.runtimeInvariants = new RuntimeInvariantRegistry(
      resolveRuntimeInvariantMode(options.runtimeInvariantMode),
    );
    this.runtimeInvariants.register(createRequestReconstructionInvariant());
    this.runtimeInvariants.register(
      createProviderProtocolInvariant(validateProviderMessageProtocol),
    );
    // Per-session bg shell isolation — scoped to this run id so sibling
    // engines in the same process keep their jobs (matters for resume).
    clearBackgroundShellRegistry(this.engineRunId);

    // Initialize LLM-based compaction manager (gated behind BABEL_COMPACTION=off).
    // When disabled or on failure, falls back to the inline compactConversation() heuristic.
    if (process.env['BABEL_COMPACTION'] !== 'off') {
      this.compactionManager = new CompactionManager();
    }
    mkdirSync(this.engineRunDir, { recursive: true });
    const persistedTaskBudget = options.resumeExisting
      ? this.readPersistedTaskBudget(this.engineRunDir)
      : null;
    if (options.resumeExisting) this.restorePersistedTaskBudget(persistedTaskBudget);
    else {
      this.taskAllowance = this.createTaskAllowance();
      this.taskCostBaselineUsd = this.taskAllowance.taskCostBaselineUsd;
    }
    this.persistTaskCostBaseline();

    if (options.resumeExisting) {
      this.parity.liveAuthority = loadLiveSessionAuthorityStrict(this.engineRunDir);
      this.parity.authoritySession = restoreAuthoritySession({
        repoRoot: options.projectRoot,
        persistPath: join(this.engineRunDir, AUTHORITY_SESSION_FILENAME),
      });
    } else
      initLiveAuthorityOnEngine({
        parity: this.parity,
        options,
        taskClass: this.taskClass,
        executionProfile: this.executionProfile,
        engineRunDir: this.engineRunDir,
      });
    this.failureBudgetTracker = createFailureBudgetTrackerFromContract(
      this.parity.liveAuthority?.taskContract,
    );
    // Crash-safe patch persistence: write-through recovery file.
    this.patchRecoveryPath = join(this.engineRunDir, 'patches.recovery.log');

    // R9: Initialize verifier guard — track hashes of verifier dependency
    // files so tampering can be detected and flagged in real-time.
    this.initializeVerifierGuard();

    // P-4.2 / Gap-2: structured memory dir with task relevance, else BABEL.md.
    const babelMd = readProjectMemoryStructured(this.options.instructionRoot ?? this.options.projectRoot, this.options.task);
    if (babelMd) {
      this.options.systemContext =
        babelMd + (this.options.systemContext ? '\n\n' + this.options.systemContext : '');
    }

    // Task-class playbook inject for REPL/chat (benchmark path already had this).
    const chatPlaybook = selectPlaybookForChatTask(this.options.task);
    if (chatPlaybook) {
      this.activePlaybook = chatPlaybook;
      const pbPrompt = buildPlaybookPrompt(chatPlaybook);
      if (pbPrompt) {
        this.options.systemContext =
          (this.options.systemContext ? this.options.systemContext + '\n\n' : '') + pbPrompt;
      }
    }
    // Plan-then-execute hard gate when playbook/size threshold says so.
    this.requireTodoBeforeMutate = shouldRequireTodoPlan(this.options.task, this.activePlaybook);

    // Implementor W1.3 / W1.4: operator mode + hard plan + plan handoff.
    this.operatorMode = options.operatorMode ?? 'default';
    this.hardPlanMode =
      this.executionProfile === 'plan' ||
      options.hardPlanMode === true ||
      operatorModeIsHardPlan(this.operatorMode);
    if (options.planHandoff) {
      this.planHandoff = options.planHandoff;
      this.forceMutateTurnsOverride = resolveForceMutateTurnsForHandoff(
        getChatTaskTune(this.taskClass).forceMutateTurns,
        options.planHandoff,
      );
      // Implement handoff exits hard-plan mutation block.
      this.hardPlanMode = false;
    }

    // Resolve model policy for provider selection.
    // Always resolve — when no model is specified, use the policy default tier.
    const { policy: modelPolicy, offline: isOffline } = options.providerPolicy && options.providerRunner ? { policy: options.providerPolicy, offline: false } : resolveChatModelPolicy({
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.modelTier !== undefined ? { modelTier: options.modelTier } : {}),
      ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
      ...(process.env['BABEL_ROOT'] ? { babelRoot: process.env['BABEL_ROOT'] } : {}),
    });
    this.modelPolicy = modelPolicy;
    if (options.providerRunner) {
      this.deliberationRunner = this.synthesisRunner = this.fallbackRunner = options.providerRunner;
    }
    // Exact experimental routes are campaign boundaries: phase-specific
    // environment overrides must not recruit another provider/model.
    if (
      this.modelPolicy.provider === 'openrouter' &&
      this.modelPolicy.providerModelId === LIVE_OPENROUTER_MODEL_ID
    ) {
      this.limits = {
        ...this.limits,
        investigateModel: LIVE_OPENROUTER_MODEL_ID,
        mutateModel: LIVE_OPENROUTER_MODEL_ID,
      };
    }
    // Text-tools / offline mode: override limits for small local models.
    // gemma3:4b has ~4K practical attention ceiling and ~6K VRAM headroom.
    // We compact aggressively to keep the model within its effective range.
    if (isOffline) {
      this.limits = {
        ...this.limits,
        maxEstimatedTokens: 4096,
        maxConversationMessages: 8,
      };
    }
    // Discover project test commands for verification gate hints.
    this.discoveredTestCommands = discoverProjectTestCommands(this.options.projectRoot);
    // Repetition loop detector: safety net for text-tools path gemma loops.
    this.repetitionDetector = new RepetitionDetector();
    // Tier A5: Observation tail buffer sized from env.
    this.observationTails = new ObservationTailBuffer({
      maxEntries: 5,
      tailChars: resolveObservationTailChars(),
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Classify user intent from the task text.
   *  Used to determine whether the execution gate should be active. */
  static classifyChatTaskIntent(task: string): TaskIntent {
    // Conversational / non-actionable turns ('?', 'hello') are never execute
    // tasks — there is nothing to mutate, and execute classification makes
    // the implementor zero-write refusal loop re-query them until maxTurns.
    if (isConversationalTurnText(task)) return 'explain';

    // Explicit read-only / no-edit directives → explain.
    // MUST be checked before fenced code and execute verb patterns: evidence
    // content (a pasted snippet, diff, or a path named "repair"/"write") is
    // never mutation authority, and "fix this without editing files" routes to
    // explain rather than execute.
    if (
      /\b(without\s+(editing|modifying|changing|writing|touching)|read[- ]only|do\s+not\s+(edit|modify|change|write|delete|remove))\b/i.test(
        task,
      )
    )
      return 'explain';

    // Explicit markdown fenced code blocks or diff/patch snippets → execute
    if (/```(?:diff|patch|javascript|typescript|python|go|rust)\b/.test(task)) return 'execute';

    // Review/audit prompts are read-only even when their evidence contains
    // mutation-shaped words such as "repair" in a path or diff description.
    // A paired edit directive remains executable (for example, "review and
    // fix it"). Keeping this before the generic mutation verbs prevents the
    // trusted reviewer from entering the coding zero-write recovery loop.
    if (
      /\b(review|audit|analyze|diagnose|inspect|investigate|research|check|find|locate|search|look\s+for|compare|contrast|evaluate|assess|report\s+(tradeoffs|findings|back|on))\b(?!.*\b(and|then)\s+(fix|repair|implement|resolve|patch|refactor|migrate|upgrade|update|create|write|edit|modify|change|remove|delete|revert|rewrite|replace)\b)(?!.*\bfix\s+it\b)/i.test(
        task,
      )
    )
      return 'explain';

    // Fix/implement/create verbs → execute
    if (
      /\b(fix|repair|implement|resolve|patch|refactor|migrate|upgrade|update\s+dependency)\b/i.test(
        task,
      )
    )
      return 'execute';
    if (/\b(create|write|build|add|make)\s+(a|the|this|an?)\b/i.test(task)) return 'execute';
    if (/\b(run|execute)\s+(npm\s+test|pytest|tests?|the\s+test)\b/i.test(task)) return 'execute';
    if (/\b(change|modify|edit|rewrite|replace|remove|delete|revert|apply|set\s+up)\b/i.test(task))
      return 'execute';

    // Question/understanding patterns → explain
    if (
      /^(what|how|why|does|can\s+you\s+explain|describe|tell\s+me\s+about|show\s+me\s+how)\b/i.test(
        task,
      )
    )
      return 'explain';
    if (/\b(explain|what\s+does|how\s+does|what\s+is|document|summarize)\b/i.test(task))
      return 'explain';
    // Read-only file inspection verbs → explain (unless paired with edit intent)
    if (
      /\b(read|list|show|cat|head|tail|display|print|output)\b/i.test(task) &&
      !/\b(and\s+(fix|edit|modify|change|update|write|patch|repair)|then\s+(fix|edit|modify)|fix\s+it)\b/i.test(
        task,
      )
    )
      return 'explain';

    // Default: peer-engineer posture — assume user wants execution
    return 'execute';
  }

  private evaluateCompletionGate(turnResult: ChatTurn, taskIntent: TaskIntent): 'allow' | 'reject' {
    const verifStart = performance.now();
    try {
      const projectTestCommands = this.discoveredTestCommands
        .map((entry) => entry.command)
        .filter((command) => command.trim().length > 0);
      const verifierInput = this.buildVerifierInput();
      // H5: live workspace revision at gate time (not the receipt's own bound hash).
      let currentWorkspaceRevisionHash: string | undefined =
        this.testWorkspaceRevisionHash !== null
          ? (this.testWorkspaceRevisionHash ?? undefined)
          : undefined;
      try {
        const paths = mutationPathsFromSessionEvents(this.parity.sessionEvents.events);
        if (paths.length > 0) {
          currentWorkspaceRevisionHash = RevisionManager.computeRevisionSync(
            this.options.projectRoot,
            paths,
          ).compositeTreeHash;
        }
      } catch {
        /* best-effort */
      }
      return evaluateCompletionGateForEngine({
        turnType: turnResult.type,
        taskIntent,
        task: this.options.task,
        taskClass: this.taskClass,
        toolCallLog: this.toolCallLog,
        lastVerifierReceipt: this.lastVerifierReceipt,
        executedVerifierLedger: verifierInput.executedVerifierLedger ?? null,
        verifierEvidenceErrors: verifierInput.verifierEvidenceErrors ?? null,
        requiredVerifierCommands: verifierInput.requiredVerifierCommands,
        projectTestCommands,
        ...(currentWorkspaceRevisionHash ? { currentWorkspaceRevisionHash } : {}),
      });
    } finally {
      const verifEnd = performance.now();
      this.currentTurnTelemetry?.recordVerificationSpan(
        Math.max(0, verifEnd - verifStart),
        verifStart,
        verifEnd,
      );
    }
  }

  private buildGateRejectUserMessage(): string {
    const testCommands = formatTestCommandsForGate(this.discoveredTestCommands);
    const verifierInput = this.buildVerifierInput();
    return buildGateRejectUserMessageForEngine({
      task: this.options.task,
      taskClass: this.taskClass,
      toolCallLog: this.toolCallLog,
      lastVerifierReceipt: this.lastVerifierReceipt,
      hasAnyWrites: this.hasAnyWrites(),
      gateStrikes: this.gateStrikes,
      executedVerifierLedger: verifierInput.executedVerifierLedger ?? null,
      verifierEvidenceErrors: verifierInput.verifierEvidenceErrors ?? null,
      requiredVerifierCommands: verifierInput.requiredVerifierCommands,
      ...(testCommands ? { projectTestCommands: testCommands.split(', ') } : {}),
    });
  }

  private criticState(onThought?: (msg: string) => void): AsymmetricCriticState {
    return {
      toolCallLog: this.toolCallLog,
      conversation: this.conversation,
      projectRoot: this.options.projectRoot,
      task: this.options.task,
      lastVerifierReceipt: this.lastVerifierReceipt,
      lastCriticReceipt: this.lastCriticReceipt,
      criticStrikes: this.criticStrikes,
      criticRunner: this.criticRunner,
      criticProRunner: this.criticProRunner,
      cancelled: this._cancelled,
      abortController: this.abortController,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      ...(this.modelPolicy?.providerModelId
        ? { primaryModel: this.modelPolicy.providerModelId }
        : {}),
      resolveDeliberationRunner: () => this.resolveDeliberationRunner(),
      providerCallbacks: this.providerRetryCallbacks({
        deliveryMode: 'text',
        conversationState: this.conversation,
        userTaskPrompt: this.options.task,
        // The critic receives a synthesized text prompt, not provider-native
        // tool messages. Record that boundary explicitly so preservation is
        // determinable even when the run had earlier tool calls.
        expectedPriorEventIds: [],
        deliveredPriorEventIds: [],
        executionStage: 'critic',
      }),
      trackRunnerUsage: (runner) => this.trackRunnerUsage(runner),
      ...(onThought ? { onThought } : {}),
    };
  }

  private applyCriticState(state: AsymmetricCriticState): void {
    this.lastCriticReceipt = state.lastCriticReceipt;
    this.criticStrikes = state.criticStrikes;
    this.criticRunner = state.criticRunner;
    this.criticProRunner = state.criticProRunner;
  }

  private async runAsymmetricDiffCritic(
    answer: string,
    callbacks: ChatCallbacks,
    taskIntent: TaskIntent,
    opts?: { terminal?: boolean },
  ): Promise<'allow' | 'reject' | 'block'> {
    const criticSpan = this.currentTurnTelemetry?.startCriticSpan();
    try {
      const state = this.criticState(callbacks.onThought);
      const decision = await runAsymmetricDiffCriticImpl(state, answer, taskIntent, opts);
      this.applyCriticState(state);
      return decision;
    } finally {
      criticSpan?.end();
    }
  }

  private buildCriticBlockedReport(verdict: DiffCriticVerdict): BlockedReport {
    return buildCriticBlockedReport(verdict, this.criticStrikes);
  }

  private buildCriticBlockedAnswer(report: BlockedReport): string {
    return buildCriticBlockedAnswer(report);
  }

  private async handleBudgetKill(
    reason: string,
    callbacks: ChatCallbacks,
    taskIntent: TaskIntent,
  ): Promise<ChatResult> {
    // Tier A2: Record budget kill event
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: 'budget_kill',
      detail: reason.slice(0, 200),
    });
    if (!this.budgetLastChanceDone && this.hasAnyWrites() && isDiffCriticEnabled()) {
      this.budgetLastChanceDone = true;
      callbacks.onThought?.('[Budget: last-chance critic before kill…]');
      const critic = await this.runAsymmetricDiffCritic(
        `Budget last-chance review: ${reason}`,
        callbacks,
        taskIntent,
        { terminal: true },
      );
      if (critic === 'block' || critic === 'reject') {
        const report = this.buildCriticBlockedReport(
          this.lastCriticReceipt ?? {
            verdict: 'reject',
            reasons: ['critic reject on budget last-chance'],
            confidence: 1,
          },
        );
        this.budgetExceeded = true;
        return this.buildResult(
          'blocked',
          callbacks,
          this.buildCriticBlockedAnswer(report),
          report,
        );
      }
    }

    this.budgetExceeded = true;
    return this.buildResult(
      'budget_exhausted',
      callbacks,
      formatBudgetKillAnswer(reason, this.toolCallLog, this.lastCriticReceipt?.verdict ?? null),
    );
  }

  private maybeInjectMidLoopHeuristicCritic(
    callbacks: ChatCallbacks,
    taskIntent: TaskIntent,
  ): void {
    const state = {
      toolCallLog: this.toolCallLog,
      conversation: this.conversation,
      projectRoot: this.options.projectRoot,
      task: this.options.task,
      midLoopCriticFired: this.midLoopCriticFired,
      lastCriticReceipt: this.lastCriticReceipt,
      criticStrikes: this.criticStrikes,
      restrictToolsNextTurn: this.restrictToolsNextTurn,
      ...(callbacks.onThought ? { onThought: callbacks.onThought } : {}),
    };
    injectMidLoopHeuristicCritic(state, taskIntent);
    this.midLoopCriticFired = state.midLoopCriticFired;
    this.lastCriticReceipt = state.lastCriticReceipt;
    this.criticStrikes = state.criticStrikes;
    this.restrictToolsNextTurn = state.restrictToolsNextTurn;
  }

  private hasAnyWrites(): boolean {
    return sessionHasAnyWrites(this.toolCallLog);
  }

  /**
   * Build the synchronous proof summary passed to the shared completion
   * authority. Uses SessionEventV1 + bound receipts, then kernel evaluateEvidenceSync.
   */
  private buildCompletionProof(hasMutation: boolean): {
    compliant: boolean;
    errors?: string[];
  } {
    return evaluateChatCompletionProof({
      projectRoot: this.options.projectRoot,
      hasMutation,
      verifierTampered: this.verifierTampered,
      receipt: this.lastVerifierReceipt,
      events: this.parity.sessionEvents.events,
      isAuthoritativeCommand: isAuthoritativeVerifierCommand,
    });
  }

  private readCacheKey(filePath: string): string {
    return normalizeReadCacheKey(filePath, this.options.projectRoot);
  }

  private noteToolForReadThrash(tool: string, opts?: { error?: string; detail?: string }): void {
    if (isSuccessfulDirectMutation(tool, opts?.error)) {
      this.consecutiveReadOnlyTools = 0;
      this.consecutiveNonMutatingShells = 0;
      this.toolsWithoutWrite = 0;
      return;
    }
    if (
      tool === 'sub_agent' &&
      opts?.error !== 'blocked' &&
      /[1-9]\d*\s+changed/.test(opts?.detail ?? '')
    ) {
      this.consecutiveReadOnlyTools = 0;
      this.consecutiveNonMutatingShells = 0;
      this.toolsWithoutWrite = 0;
      return;
    }
    this.toolsWithoutWrite += 1;
    // Implementor: track shell-only thrash separately (shell soft budget).
    if (
      tool === 'run_command' ||
      tool === 'shell_exec' ||
      tool === 'test_run' ||
      tool === 'bash' ||
      tool === 'shell'
    ) {
      this.consecutiveNonMutatingShells += 1;
    } else {
      this.consecutiveNonMutatingShells = 0;
    }
    // Zero-write shell thrash counts against exploration budget (not only reads).
    if (isExplorationBudgetTool(tool, this.hasAnyWrites())) {
      this.consecutiveReadOnlyTools += 1;
      this.cumulativeExplorationTools += 1;
    }
  }

  private buildRejectionMessage(): string {
    return buildGateRejectionMessage(this.toolCallLog);
  }

  private currentTurnHasMutation(): boolean {
    return turnHasMutation(this.toolCallLog, this._turnToolCallLogStart);
  }

  /** Force-mutate + read-thrash + cumulative exploration fuses (shared submit/stream). */
  private applyExploreFuses(
    executeIntent: boolean,
    readOnlyOperation: boolean,
  ): ExploreFuseResult {
    const state = {
      turnsWithoutWrite: this.turnsWithoutWrite,
      consecutiveReadOnlyTools: this.consecutiveReadOnlyTools,
      cumulativeExplorationTools: this.cumulativeExplorationTools,
      restrictToolsNextTurn: this.restrictToolsNextTurn,
      consecutiveNonMutatingShells: this.consecutiveNonMutatingShells,
      toolsWithoutWrite: this.toolsWithoutWrite,
      phase: this._lastPhase,
      shadowLoggedKinds: this.exploreShadowLoggedKinds,
      investigateSoftNudgeDone: this.investigateSoftNudgeDone,
    };
    const out = applyExploreFusesPolicy({
      executeIntent,
      readOnlyOperation,
      taskClass: this.taskClass,
      hasAnyWrites: this.hasAnyWrites(),
      state,
      pushUser: (content) => this.conversation.push({ role: 'user', content }),
      onPolicyEvent: (event) => this.policyEventLog.record(event),
      currentTurn: this._turnIndex,
      // Defer fuse messages to parityArbitrateCycle (at most one intervention).
      deferMessagesToArbiter: true,
      ...(this.forceMutateTurnsOverride !== null
        ? { forceMutateTurnsOverride: this.forceMutateTurnsOverride }
        : {}),
    });
    this.turnsWithoutWrite = state.turnsWithoutWrite;
    this.consecutiveReadOnlyTools = state.consecutiveReadOnlyTools;
    this.restrictToolsNextTurn = state.restrictToolsNextTurn;
    this.consecutiveNonMutatingShells = state.consecutiveNonMutatingShells;
    this.toolsWithoutWrite = state.toolsWithoutWrite;
    this.investigateSoftNudgeDone = state.investigateSoftNudgeDone === true;
    if (state.shadowLoggedKinds) {
      this.exploreShadowLoggedKinds = state.shadowLoggedKinds;
    }
    return out;
  }

  /** Provider-native tool_use ids for the current stream tool batch (if any). */
  private _streamNativeToolCallIds: string[] = [];
  /** Stable batch id for the in-flight tool cycle (propose → start → terminal). */
  private _activeToolBatchId: string | null = null;
  /**
   * S03/#213 slice 2: dispatch attempt per stable child delegation id. The
   * first dispatch is attempt 1; re-dispatching the same delegation increments,
   * so a retry never overwrites the original child's evidence directory.
   */
  private childAttempts = new Map<string, number>();

  /** Snapshot for Tier A observability helpers (keeps chatEngine thin). */
  private obsHandles(): ObservabilityHandles {
    return {
      toolCallLog: this.toolCallLog,
      engineRunDir: this.engineRunDir,
      lastVerifierReceipt: this.lastVerifierReceipt,
      policyEventLog: this.policyEventLog,
      routingReceiptLog: this.routingReceiptLog,
      observationTails: this.observationTails,
      blockedAttemptLedger: this.blockedAttemptLedger,
      logIndexToTurn: this._logIndexToTurn,
      turnIndex: this._turnIndex,
      turnToolCallLogStart: this._turnToolCallLogStart,
      lastPhase: this._lastPhase,
    };
  }

  private checkBudgets(): { ok: boolean; reason?: string; limiter?: ChatRunLimiter } {
    if (this.taskCostScopeUnavailable || !this.taskAllowance) {
      const reason = 'Cannot restore durable task cost scope for resumed run; refusing a fresh allowance.';
      this.terminatingLimiter = 'cost';
      this.terminalLimiterReason = reason;
      return { ok: false, reason, limiter: 'cost' };
    }
    if (this.taskAllowance.consumed.turns >= this.taskAllowance.grant.turnCap) {
      const reason =
        `Task turn allowance exhausted (${this.taskAllowance.consumed.turns} of ` +
        `${this.taskAllowance.grant.turnCap}).`;
      this.terminatingLimiter = 'turns';
      this.terminalLimiterReason = reason;
      return { ok: false, reason, limiter: 'turns' };
    }
    const taskCost = this.currentTaskCostUsd();
    const taskWallMs = this.currentTaskActiveWallMs();
    // After first critic reject or post-write repair, use the tighter cost cap.
    const grantedCostCapUsd = allowanceCostCapUsd(this.taskAllowance.grant.costCap);
    const maxCostUsd =
      Number.isFinite(grantedCostCapUsd) && this.criticRepairCostCapUsd != null
        ? Math.min(grantedCostCapUsd, this.criticRepairCostCapUsd)
        : grantedCostCapUsd;
    // After first write: absolute wall cap from session start (repair window).
    const maxWallMs =
      this.postWriteRepairWallCapMs != null
        ? Math.min(this.taskAllowance.grant.wallCapMs, this.postWriteRepairWallCapMs)
        : this.taskAllowance.grant.wallCapMs;
    const result = checkCostWallBudgets({
      totalCostUsd: taskCost,
      maxCostUsd,
      sessionStartTime: Date.now() - taskWallMs,
      maxWallMs,
      declaredCostUsd: this.limits.costBudget?.requestedCostUsd ?? this.limits.maxCostUsd,
      declaredWallMs: this.limits.wallBudget?.requestedMs ?? this.limits.maxWallMs,
      postWriteRepairWallCapMs: this.postWriteRepairWallCapMs,
      criticRepairCostCapUsd: this.criticRepairCostCapUsd,
    });
    if (!result.ok) {
      this.terminatingLimiter = result.limiter ?? 'cost';
      this.terminalLimiterReason = result.reason ?? 'Budget limit exceeded.';
    }
    return result;
  }

  /**
   * On first diff-critic reject: shrink remaining cost budget to a repair window
   * so thrash cannot burn the full general_swe $3 after a correct reject.
   */
  private applyCriticRepairCostBudget(): void {
    if (this.criticRepairCostCapUsd != null) return;
    const spent = this.currentTaskCostUsd();
    const { capUsd, repairWindowUsd } = computeCriticRepairCostCap({
      spentUsd: spent,
      sessionMaxCostUsd: this.limits.maxCostUsd,
      longTaskProfile: this.limits.costBudget?.longTaskProfile === true,
      explicitCostCeiling: this.limits.costBudget?.explicitCostCeiling === true,
      criticStrikes: this.criticStrikes,
      limits: this.limits,
    });
    this.criticRepairCostCapUsd = capUsd;
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: 'progress_policy',
      detail:
        `critic_repair_budget spent=${spent.toFixed(3)} ` +
        `repair_window=${repairWindowUsd.toFixed(3)} cap=${capUsd.toFixed(3)} ` +
        `session_max=${this.limits.maxCostUsd.toFixed(2)}`,
    });
    this.persistTaskAllowance();
  }

  /**
   * On first successful mutation: activate post-write repair mode —
   * wall slice + cost slice + one nudge. Investigation tools stay available.
   * Idempotent.
   */
  private applyPostWriteRepairBudget(): void {
    if (this.postWriteRepairWallCapMs != null) return;
    // Only for execute-style classes that must verify (not pure investigate).
    if (this.taskClass === 'investigate') return;

    const elapsedMs = this.currentTaskActiveWallMs();
    // An explicitly authorized long-task run keeps its full wall: the
    // anti-thrash repair window would otherwise kill it minutes after the
    // first write. Hard wall, stall, turn and cost budgets still apply.
    const shrinkWall = shouldShrinkWallForPostWriteRepair(this.limits.wallBudget);
    const repairWall = shrinkWall
      ? computePostWriteRepairWallMs({ elapsedMs, sessionMaxWallMs: this.limits.maxWallMs })
      : { capMs: this.limits.maxWallMs, repairWindowMs: Math.max(0, this.limits.maxWallMs - elapsedMs) };
    const { capMs, repairWindowMs } = repairWall;
    this.postWriteRepairWallCapMs = capMs;
    this.postWriteRepairRestrict = true;

    // Also shrink cost if critic repair cap not already tighter.
    if (this.criticRepairCostCapUsd == null) {
      const spent = this.currentTaskCostUsd();
      const { capUsd, repairWindowUsd } = computeCriticRepairCostCap({
        spentUsd: spent,
        sessionMaxCostUsd: this.limits.maxCostUsd,
        longTaskProfile: this.limits.costBudget?.longTaskProfile === true,
        explicitCostCeiling: this.limits.costBudget?.explicitCostCeiling === true,
        criticStrikes: this.criticStrikes,
        limits: this.limits,
      });
      this.criticRepairCostCapUsd = capUsd;
      this.policyEventLog.record({
        at_turn: this._turnIndex,
        kind: 'progress_policy',
        detail:
          `post_write_repair_cost spent=${spent.toFixed(3)} ` +
          `repair_window=${repairWindowUsd.toFixed(3)} cap=${capUsd.toFixed(3)}`,
      });
    }

    const remainingWallSec = Math.max(0, Math.round((this.limits.maxWallMs - elapsedMs) / 1000));
    const repairWindowSec = Math.round(repairWindowMs / 1000);
    const msg = buildPostWriteRepairMessage({
      repairWindowSec,
      remainingWallSec,
    });
    this.conversation.push({ role: 'user', content: msg });
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: 'progress_policy',
      detail:
        `post_write_repair_wall elapsed_ms=${elapsedMs} ` +
        `repair_window_ms=${repairWindowMs} cap_ms=${capMs} ` +
        `session_max_ms=${this.limits.maxWallMs} tools=act_or_verify`,
    });
    this.persistTaskAllowance();
  }

  /** Whether the next model turn should use restricted mutate/verify tools. */
  private nextTurnToolPolicy() {
    return snapshotOnce(this.logicalTurnToolPolicy, () => {
      const stall = this.restrictToolsNextTurn;
      const policy = resolveNextTurnToolAccess({
        postWriteRestrict: this.postWriteRepairRestrict,
        lastVerifierFailed: this.lastVerifierFailed,
        stallRestrictOnce: stall,
        taskClass: this.taskClass,
      });
      if (stall) this.restrictToolsNextTurn = false;
      return policy;
    });
  }

  /** Whether the next model turn should use restricted mutate/verify tools. */
  private shouldRestrictToolsThisTurn(): boolean {
    return this.nextTurnToolPolicy().restrict;
  }

  // ─── R11: Per-Round Token Ceiling ──────────────────────────────────────────
  // Each turn that exceeds maxTokensPerRound with zero tool calls is
  // force-BLOCKED immediately — no waiting for the text-only-turn counter.
  // This catches the case where a single runaway text response burns the
  // entire budget before the turn-counter escalation can react.

  /** Returns a BLOCKED message if the current round exceeded the token ceiling
   *  with zero tool calls. Returns null when within budget or when tools were used. */
  private checkPerRoundTokenCeiling(hadToolCalls: boolean): string | null {
    const perRoundTokens = this.apiTokenCount - this.apiTokenCountAtTurnStart;
    if (perRoundTokens > this.limits.maxTokensPerRound && !hadToolCalls) {
      return [
        `BLOCKED: This turn consumed ${perRoundTokens.toLocaleString()} tokens ` +
          `(ceiling: ${this.limits.maxTokensPerRound.toLocaleString()}) with zero tool calls.`,
        'The model produced only text without using any tools. This is a text-loop.',
        `Per-round token limit: ${this.limits.maxTokensPerRound.toLocaleString()}. ` +
          `Actual: ${perRoundTokens.toLocaleString()}.`,
      ].join('\n');
    }
    return null;
  }

  /** R2: Check for stall and return the escalating intervention if stalled.
   *  Returns null when not stalled or when the intervention has already been
   *  applied for the current stall state.
   *
   *  P0-E: stall_kill mode shadow|enforce|off (env ablation or task-class default).
   *  Shadow downgrades kill → nudge and logs stall_shadow_kill. */
  private checkStallIntervention(isReadOnlyInspection: boolean): StallIntervention | null {
    if (!resolveStallInterventionsEnabled(this.taskClass)) {
      return null;
    }
    // I4: consume the admitted effective-operation policy instead of
    // re-deriving read-only from taskClass (which can be overridden by env /
    // autonomy / plan handoff and disagree with isReadOnlyInspection).
    const isReadOnly = isReadOnlyInspection;
    const stallShadow = resolveStallShadowMode(this.taskClass);
    const intervention = getStallInterventionMessage(
      this.stallState,
      this.limits.stallTurns,
      stallShadow,
      isReadOnly,
    );
    if (!intervention) return null;

    // Record the intervention so the next call escalates
    this.stallState.interventionLevel++;
    this.stallState.interventionHistory.push(intervention.message);

    // Shadow mode: log each time the stall detector would have killed
    if (stallShadow && this.stallState.interventionLevel >= 4) {
      this.policyEventLog.record({
        at_turn: this._turnIndex,
        kind: 'stall_shadow_kill',
        detail: `Shadow mode: would have killed at interventionLevel=${this.stallState.interventionLevel}`,
      });
    }

    return intervention;
  }

  /**
   * Non-stream entry is a thin adapter over submitMessageStream.
   * One loop owns semantics; presentation maps ChatEvent → callbacks.
   */
  async submitMessage(
    userInput: string,
    callbacks: ChatCallbacks,
    taskIntent?: TaskIntent,
  ): Promise<ChatResult> {
    this._cancelled = false;
    const generation = ++this.generationCounter;

    const cb: ChatCallbacks = {};
    if (callbacks.onAnswerChunk) {
      cb.onAnswerChunk = (chunk: string) => {
        if (this.generationCounter !== generation) return;
        callbacks.onAnswerChunk!(chunk);
      };
    }
    if (callbacks.onThought) {
      cb.onThought = (thought: string) => {
        if (this.generationCounter !== generation) return;
        captureThought(this.engineRunDir, this._turnIndex, thought);
        callbacks.onThought!(thought);
      };
    }
    if (callbacks.onGenerationBoundary) {
      cb.onGenerationBoundary = () => {
        if (this.generationCounter !== generation) return;
        callbacks.onGenerationBoundary!();
      };
    }
    if (callbacks.onContextCompacted) {
      cb.onContextCompacted = (info) => {
        if (this.generationCounter !== generation) return;
        callbacks.onContextCompacted!(info);
      };
    }
    if (callbacks.onToolStart) {
      cb.onToolStart = (tool: string, target: string) => {
        if (this.generationCounter !== generation) return -1;
        return callbacks.onToolStart!(tool, target);
      };
    }
    if (callbacks.onToolComplete) {
      cb.onToolComplete = (id: number, detail?: string, error?: string, exitCode?: number) => {
        if (this.generationCounter !== generation) return;
        callbacks.onToolComplete!(id, detail, error, exitCode);
      };
    }
    if (callbacks.onFileChanged) {
      cb.onFileChanged = (path, adds, dels, diff) => {
        if (this.generationCounter !== generation) return;
        callbacks.onFileChanged!(path, adds, dels, diff);
      };
    }
    if (callbacks.onSubAgentStart) {
      cb.onSubAgentStart = (info) => {
        if (this.generationCounter !== generation) return;
        callbacks.onSubAgentStart!(info);
      };
    }
    if (callbacks.onSubAgentComplete) {
      cb.onSubAgentComplete = (info) => {
        if (this.generationCounter !== generation) return;
        callbacks.onSubAgentComplete!(info);
      };
    }
    if (callbacks.onSubAgentFailed) {
      cb.onSubAgentFailed = (info) => {
        if (this.generationCounter !== generation) return;
        callbacks.onSubAgentFailed!(info);
      };
    }

    const callbackToolIds = new Map<string, number>();
    const legacyCallbackToolIds: number[] = [];

    let terminal: {
      kind: 'done' | 'failed' | 'cancelled';
      answer?: string;
      blockedReport?: BlockedReport | null;
      error?: string;
      /** Authoritative outcome from streamDone (P0-D B4). */
      outcome?: TerminalOutcome;
      budgetExceeded?: boolean;
    } | null = null;

    try {
      for await (const event of this.submitMessageStream(userInput, taskIntent)) {
        switch (event.type) {
          case 'answer_chunk':
            cb.onAnswerChunk?.(event.text);
            break;
          case 'thinking':
            // Generation boundary — the same semantic the streaming dispatcher
            // forwards, so non-streaming presentation stays equivalent.
            cb.onGenerationBoundary?.();
            break;
          case 'thought':
            cb.onThought?.(event.text);
            break;
          case 'context_compacted':
            cb.onContextCompacted?.(event);
            break;
          case 'tool_start':
            {
              const id = cb.onToolStart?.(event.tool, event.target) ?? -1;
              if (event.toolCallId) callbackToolIds.set(event.toolCallId, id);
              else legacyCallbackToolIds.push(id);
            }
            break;
          case 'tool_complete':
          case 'tool_failed': {
            const id = event.toolCallId
              ? callbackToolIds.get(event.toolCallId)
              : legacyCallbackToolIds.shift();
            cb.onToolComplete?.(id ?? -1, event.detail, event.error, event.exitCode);
            if (event.toolCallId) callbackToolIds.delete(event.toolCallId);
            break;
          }
          case 'file_changed':
            cb.onFileChanged?.(event.path, event.additions, event.deletions, event.content);
            break;
          case 'sub_agent_start':
            cb.onSubAgentStart?.({
              id: event.id,
              label: event.label,
              ...(event.model !== undefined ? { model: event.model } : {}),
            });
            break;
          case 'sub_agent_complete':
            cb.onSubAgentComplete?.({
              id: event.id,
              summary: event.summary,
              ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
            });
            break;
          case 'sub_agent_failed':
            cb.onSubAgentFailed?.({ id: event.id, error: event.error });
            break;
          case 'done':
            terminal = {
              kind: 'done',
              answer: event.answer,
              blockedReport: event.blockedReport ?? null,
              ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
              ...(event.budgetExceeded ? { budgetExceeded: true } : {}),
            };
            break;
          case 'failed':
            terminal = {
              kind: 'failed',
              error: event.error,
              ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
            };
            break;
          case 'cancelled':
            terminal = { kind: 'cancelled' };
            break;
          default:
            break;
        }
      }
    } catch (error) {
      // Unexpected throw still finalizes the turn; unknown stays inconclusive.
      const captured = captureSessionEventAppendFailure(error, this.engineRunDir);
      const message =
        captured?.operatorMessage ?? (error instanceof Error ? error.message : String(error));
      return this.buildResult('failed', cb, message, undefined, classifyFailureText(message));
    }

    if (!terminal) {
      return this.buildResult(
        'failed',
        cb,
        'Stream ended without a terminal event — possible internal error',
      );
    }
    if (terminal.kind === 'cancelled') {
      return this.buildResult('cancelled', cb);
    }
    if (terminal.kind === 'failed') {
      const failedOutcome = terminal.outcome ?? classifyFailureText(terminal.error ?? '');
      if (failedOutcome === 'BUDGET_EXHAUSTED' || this.budgetExceeded) {
        this.budgetExceeded = true;
        return this.buildResult(
          'budget_exhausted',
          cb,
          terminal.error ?? 'Stream failed',
          undefined,
          'BUDGET_EXHAUSTED',
        );
      }
      if (
        failedOutcome === 'BLOCKED_POLICY' ||
        failedOutcome === 'BLOCKED_EXTERNAL' ||
        failedOutcome === 'NEEDS_HUMAN_DECISION' ||
        failedOutcome === 'INVALID_TASK'
      ) {
        return this.buildResult('blocked', cb, terminal.error ?? 'Stream failed', undefined, failedOutcome);
      }
      return this.buildResult(
        'failed',
        cb,
        terminal.error ?? 'Stream failed',
        undefined,
        failedOutcome,
      );
    }
    if (terminal.budgetExceeded || terminal.outcome === 'BUDGET_EXHAUSTED' || this.budgetExceeded) {
      this.budgetExceeded = true;
    }
    const doneTerminal = projectChatTerminal({
      ...(terminal.outcome !== undefined ? { outcome: terminal.outcome } : {}),
      status: terminal.blockedReport
        ? 'blocked'
        : this.budgetExceeded
          ? 'budget_exhausted'
          : 'completed',
    });
    return this.buildResult(
      doneTerminal.status,
      cb,
      terminal.answer,
      terminal.blockedReport,
      doneTerminal.outcome,
    );
  }

  /** #1 Async generator: yields typed ChatEvents as the conversation progresses.
   *  Callers use `for await (const event of engine.submitMessageStream(...))`.
   *  Uses executeRawStream() for true chunk-by-chunk streaming. */
  async *submitMessageStream(
    userInput: string,
    taskIntent?: TaskIntent,
    submitOpts?: SubmitMessageOptions,
  ): AsyncGenerator<ChatEvent, void, undefined> {
    this._cancelled = false;
    this.preparedAdmissionCompactionAttempts = 0;
    this.currentTurnTelemetry = new ChatTurnTelemetryCollector(performance.now());
    this.currentTurnTelemetry.markStarted();
    this.lastRequestPromptTokens = null;
    this.lastRequestCompletionTokens = null;
    this.lastRequestModelId = null;
    // W0.3: fresh TurnRuntime per user submission (isolate counters by default).
    const runtime = this.applyUserSubmission({
      userInput,
      ...(taskIntent !== undefined ? { taskIntent } : {}),
      ...(submitOpts?.continueTask !== undefined ? { continueTask: submitOpts.continueTask } : {}),
    });
    // D01/S01/M2: one effective-operation policy for this accepted submission,
    // resolved BEFORE any generated guidance is appended. TaskShape is
    // authoritative (derived from the same classifier that sets taskClass), so
    // read-only gating, preparation fuses, progress scoring, loop-control and
    // finalization all consume this decision.
    //
    // There are still two *inputs* by design: `resolvedIntent` is the legacy
    // text-intent classifier (`classifyChatTaskIntent`) and TaskShape is the
    // operation classifier. Neither is a second authority: `effectiveOperation`
    // (TaskShape) dominates, and `effectiveExecutePolicy` below ANDs the two so
    // the legacy `execute` label can never re-add mutation pressure to a
    // READ_ONLY shape. Zero-write is safe for the same reason — its
    // `executeIntent` is `effectiveExecutePolicy`, so a read-only shape cannot
    // reach the zero-write terminal even where a class tune left the threshold
    // non-zero. Older hydrated snapshots without the field fall back to their
    // persisted shape; unknown defaults to MUTATING (fail-safe: never silently
    // loosens mutation pressure).
    const effectiveOperation: TaskOperation =
      runtime.effectiveOperation ?? runtime.taskShape?.operation ?? 'MUTATING';
    const isReadOnlyInspection = effectiveOperation === 'READ_ONLY';

    this.conversation.push({ role: 'user', content: userInput });
    // S01/#211: harness-generated repair guidance is only ever injected for an
    // execute-like operation. A READ_ONLY submission never receives the
    // generated edit mandate, and the injected text identifies itself as
    // guidance rather than user authorization (see compileIntentPlanUserMessage).
    if (this.options.intentPlanUserMessage && !isReadOnlyInspection)
      this.conversation.push({
        role: 'user',
        content: this.options.intentPlanUserMessage,
      });
    // Implementor: inject plan→execute handoff once at first user message of session.
    if (this.planHandoff && this._turnIndex === 0) {
      this.conversation.push({
        role: 'user',
        content: formatPlanHandoffUserMessage(this.planHandoff),
      });
      this.policyEventLog.record({
        at_turn: 0,
        kind: 'progress_policy',
        detail: `plan_execute_handoff:${this.planHandoff.planId}`,
      });
    }
    // R11: Reset text-only turn counter for each new submitMessageStream round.
    this.stallState = { ...this.stallState, textOnlyTurns: 0 };
    let allToolObservations = '';

    const resolvedIntent = runtime.taskIntent;

    // F1/C1: finalization and loop-control consume the same effective operation
    // policy as gating/fuses/progress. The legacy text classifier can say
    // `execute` for a READ_ONLY TaskShape (bare "how to fix …", fenced evidence
    // with no directive), and such a submission must not be pressed to patch,
    // gated as an execute task, or fed a mutation-oriented critic.
    const effectiveExecutePolicy = resolvedIntent === 'execute' && !isReadOnlyInspection;
    const effectiveIntent: TaskIntent = effectiveExecutePolicy ? 'execute' : 'explain';

    const authorityHalt = evaluateSubmitTaskAuthorityHalt(this.parity, userInput);
    if (authorityHalt) {
      yield authorityHalt;
      return;
    }

    // P1: open parity turn (loop + durable event log)
    // Record the resolved provider/model, not the backend shorthand supplied
    // by the caller. This is the first durable route fact for exact-lock runs;
    // later runner metadata records what was actually sent and observed.
    const modelName =
      this.modelPolicy?.providerModelId ??
      this.options.model ??
      this.modelPolicy?.family ??
      'unknown';
    const providerName =
      this.modelPolicy?.provider ??
      (modelName.toLowerCase().includes('deepseek')
        ? 'deepseek'
        : modelName.toLowerCase().includes('ollama')
          ? 'ollama'
          : 'deepinfra');
    parityOnUserTurn(this.parity, {
      task: userInput,
      model: modelName,
      provider: providerName,
      projectRoot: this.options.projectRoot,
      policyPreset: 'workspace_write',
      taskClass: runtime.taskClass,
      gatePolicy: runtime.gatePolicy ?? this.gatePolicy ?? 'required',
      submissionIndex: runtime.submissionIndex,
      continuedTask: runtime.continuedTask,
    });
    if (this.options.intentPlanUserMessage && !isReadOnlyInspection && this.parity.turnId) {
      recordUserMessage(
        this.parity.eventLog,
        this.parity.turnId,
        this.options.intentPlanUserMessage,
      );
    }
    setChatApprovalTurnId(this.parity.turnId);

    // R4: Fire-and-forget repo map generation, awaited before first LLM call
    const repoMapPromise =
      this.repoMapCache === null
        ? this.generateRepoMap()
            .then((map) => {
              if (map) this.repoMapCache = map;
            })
            .catch(() => {
              /* best-effort */
            })
        : Promise.resolve();

    if (this.conversation.length === 1 || this.conversation[0]?.role !== 'system') {
      // R4: Await repo map first so it's included in the system prompt
      await repoMapPromise;
      const useNativeInit = this.shouldUseNativeTools(this.resolveDeliberationRunner());
      const useTextInit = !useNativeInit && this.shouldUseTextTools();
      // P3: native preferred; legacy Markdown flatten only when no native tools
      const systemContent = this.getOrBuildSystemPrompt(
        useNativeInit ? 'native' : useTextInit ? 'text' : 'legacy',
      );
      this.conversation.unshift({ role: 'system', content: systemContent });
    }

    const maxTurns = Math.max(
      0,
      (this.taskAllowance?.grant.turnCap ?? this.limits.maxTurns) -
        (this.taskAllowance?.consumed.turns ?? 0),
    );
    this._sessionStartTime = Date.now();
    this.beginActiveExecution();

    let _turnSpan: Span | null = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      // Tier A: Track turn index for per-turn observability metadata
      this._turnIndex = turn;
      // Never leak native tool-call IDs from a prior turn/batch into a new cycle.
      this._streamNativeToolCallIds = [];
      this._activeToolBatchId = null;
      // R9: Reset per-turn tamper flag
      this.tamperedThisTurn = false;

      // R11: Snapshot API token count at turn start for per-round ceiling check
      this.apiTokenCountAtTurnStart = this.apiTokenCount;
      // R11: Reset per-turn tool-call flag for auto-continue refusal
      this._hadToolCallsThisTurn = false;

      // Ensure repo map is available for subsequent turns that may rebuild system prompt
      if (turn === 0) await repoMapPromise;
      if (this._cancelled || this.abortController.signal.aborted) {
        // AC3: stream cancel path flushes disk (idempotent if cancel() already did)
        finalizeParityCancel(this.parity, this.engineRunDir);
        yield this.streamCancelled();
        return;
      }

      // Budget checks (P1): cost, wall-clock — honest receipts + last-chance critic
      if (this.terminatingLimiter === 'child_exhaustion') {
        const kill = await this.handleBudgetKill(
          this.terminalLimiterReason ?? 'Inherited child allowance exhausted.',
          { onThought: () => {} },
          effectiveIntent,
        );
        yield this.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }
      const budget = this.checkBudgets();
      if (!budget.ok) {
        const kill = await this.handleBudgetKill(
          budget.reason ?? 'Budget limit exceeded.',
          { onThought: () => {} },
          effectiveIntent,
        );
        // AC3: every stream terminal goes through streamDone (buildResult already
        // finalized; streamDone finalize is idempotent on turn_ended).
        yield this.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }
      this.consumeTaskTurn();

      resetOneShotSnapshot(this.logicalTurnToolPolicy);

      // ── OTel chat turn span ──
      const _tracer = trace.getTracer('babel-cli', '1.0.0');
      let _turnSpan: Span | null = _tracer.startSpan('babel.chat.turn');

      // Compact if needed; user-visible notice via stream event
      const compactionSpan = this.currentTurnTelemetry?.startCompactionSpan();
      const compactInfo = await this.compactIfNeeded();
      compactionSpan?.end();
      if (compactInfo) {
        yield { type: 'context_compacted', ...compactInfo };
      }

      // C1: Inject current todo list into conversation before LLM call
      this.updateTodoSystemMessage();
      if (!this.workingState.goal) {
        this.workingState = applyWorkingStateEvent(this.workingState, {
          type: 'set_goal',
          goal: this.options.task.slice(0, 240),
        });
      }
      this.conversation = upsertWorkingStateMessage(this.conversation, this.workingState);

      const runner = this.resolveRoutedRunner();
      const useNativeTools = this.shouldUseNativeTools(runner);
      const useTextTools = !useNativeTools && this.shouldUseTextTools();
      const prompt = this.services.conversation.buildTurnPrompt({
        conversation: this.conversation,
        task: this.options.task,
        nativeTools: useNativeTools,
        textTools: useTextTools,
      });
      const providerMessages = useNativeTools
        ? this.services.conversation.rebuildProviderMessages(this.parity.eventLog, {
            systemPrompt: this.getOrBuildSystemPrompt('native'),
          })
        : [];

      yield { type: 'thinking' };

      let turnResult: ChatTurn;
      let toolsAnnouncedInStream = false;
      // Visible answer text already emitted chunk-by-chunk by this turn's
      // provider call. Terminal paths re-emit the full answer only when it
      // differs — re-emitting identical text duplicates it in the TUI.
      let streamedAnswerForTurn: string | null = null;

      if (useTextTools) {
        // ── Text-tools path — simplified format for small local models ──────
        // Buffered: rawText may contain [TOOL:…] markers that parseTextToolTurn
        // strips, so the final answer is not guaranteed append-compatible with
        // the stream. The reconciled final answer is emitted at the terminal.
        const systemPrompt = this.getOrBuildSystemPrompt('text');
        let rawText = '';
        const providerStart = performance.now();
        try {
          for await (const chunk of runner.executeRawStream(
            prompt,
            systemPrompt,
            this.abortController.signal,
            this.providerRetryCallbacks({
              deliveryMode: 'text',
              conversationState: prompt,
              systemPolicyPrompt: systemPrompt,
              executionStage: 'chat',
            }),
          )) {
            rawText += chunk;
            this.currentTurnTelemetry?.markFirstToken();
          }
          const providerEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          this.trackRunnerUsage(runner);
          turnResult = parseTextToolTurn(rawText);
        } catch (err: any) {
          const providerEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          const admissionRecovery = await this.recoverPreparedRequestAdmission(err);
          if (admissionRecovery) {
            yield { type: 'context_compacted', ...admissionRecovery };
            continue;
          }
          endSpan(_turnSpan, SpanStatusCode.ERROR);
          _turnSpan = null;
          const cancelled = this.emitCancelledIfOperatorAbort(err);
          if (cancelled) {
            yield cancelled;
            return;
          }
          yield this.streamFailed(err?.message ?? String(err));
          return;
        }
      } else if (useNativeTools) {
        const nextTools = this.nextTurnToolPolicy();
        const restrictTools = nextTools.restrict && !isReadOnlyChat();
        const toolDefs = filterReadOnlyChatTools(restrictTools
          ? this.services.tools.buildRestrictedDefinitions(
              nextTools.mode === 'full' ? 'act_or_verify' : nextTools.mode,
            )
          : this.services.tools.buildDefinitions());
        const nativeActions: ChatToolAction[] = [];
        const nativeToolCallIds: string[] = [];
        const seenToolCallIds = new Set<string>();
        let answerText = '';
        let nativeFinishReason: string | undefined;
        const systemPrompt = this.getOrBuildSystemPrompt('native');

        this.assertNativeRequestMatchesDurable(providerMessages, systemPrompt, systemPrompt);
        const providerStart = performance.now();
        try {
          for await (const event of runner.executeWithToolsStream(
            providerMessages,
            toolDefs,
            systemPrompt,
            this.abortController.signal,
            restrictTools ? 'required' : 'auto',
            this.providerRetryCallbacks({
              deliveryMode: 'native',
              conversationState: providerMessages,
              systemPolicyPrompt: systemPrompt,
              userTaskPrompt: prompt,
              toolSchema: toolDefs,
              executionStage: 'chat',
            }),
          )) {
            switch (event.type) {
              case 'text_delta':
                this.currentTurnTelemetry?.markFirstToken();
                answerText += event.text;
                yield { type: 'answer_chunk', text: event.text };
                break;
              case 'thought_delta':
                this.currentTurnTelemetry?.markFirstToken();
                yield { type: 'thought', text: event.text };
                break;
              case 'tool_use': {
                const action = nativeToolUseToChatAction(event.name, event.input);
                nativeActions.push(action);
                nativeToolCallIds.push(
                  canonicalizeToolCallId(event, turn, nativeActions.length - 1, seenToolCallIds),
                );
                const toolCallId = nativeToolCallIds.at(-1)!;
                toolsAnnouncedInStream = true;
                yield {
                  type: 'tool_start',
                  toolCallId,
                  tool: event.name,
                  target: chatActionTarget(action),
                };
                break;
              }
              case 'error':
                throw new Error(event.message);
              case 'done':
                nativeFinishReason = event.finishReason;
                break;
            }
          }
          const providerEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          this.trackRunnerUsage(runner);
          this._streamNativeToolCallIds = nativeToolCallIds;
          streamedAnswerForTurn = answerText;
          turnResult = nativeTurnFromStream({
            answerText,
            actions: nativeActions,
            finishReason: nativeFinishReason,
          });
        } catch (err: any) {
          const providerEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          const admissionRecovery = await this.recoverPreparedRequestAdmission(err);
          if (admissionRecovery) {
            yield { type: 'context_compacted', ...admissionRecovery };
            continue;
          }
          const fb = yield* this.resolveFallbackOrFail(err, turn);
          if (!fb) {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            return;
          }
          if (typeof fb.executeWithToolsStream !== 'function') {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            yield this.streamFailed(err.message);
            return;
          }
          nativeActions.length = 0;
          nativeToolCallIds.length = 0;
          seenToolCallIds.clear();
          answerText = '';
          nativeFinishReason = undefined;
          this.assertNativeRequestMatchesDurable(providerMessages, systemPrompt, undefined);
          const fbStart = performance.now();
          try {
            for await (const event of fb.executeWithToolsStream(
              providerMessages,
              toolDefs,
              undefined,
              this.abortController.signal,
              undefined,
              this.providerRetryCallbacks({
                deliveryMode: 'native',
                conversationState: providerMessages,
                userTaskPrompt: prompt,
                toolSchema: toolDefs,
                executionStage: 'chat',
                substitutionOrFallback: true,
              }),
            )) {
              switch (event.type) {
                case 'text_delta':
                  this.currentTurnTelemetry?.markFirstToken();
                  answerText += event.text;
                  yield { type: 'answer_chunk', text: event.text };
                  break;
                case 'thought_delta':
                  this.currentTurnTelemetry?.markFirstToken();
                  yield { type: 'thought', text: event.text };
                  break;
                case 'tool_use': {
                  const action = nativeToolUseToChatAction(event.name, event.input);
                  nativeActions.push(action);
                  nativeToolCallIds.push(
                    canonicalizeToolCallId(event, turn, nativeActions.length - 1, seenToolCallIds),
                  );
                  const toolCallId = nativeToolCallIds.at(-1)!;
                  toolsAnnouncedInStream = true;
                  yield {
                    type: 'tool_start',
                    toolCallId,
                    tool: event.name,
                    target: chatActionTarget(action),
                  };
                  break;
                }
                case 'error':
                  throw new Error(event.message);
                case 'done':
                  nativeFinishReason = event.finishReason;
                  break;
              }
            }
            const fbEnd = performance.now();
            this.currentTurnTelemetry?.recordProviderSpan(
              Math.max(0, fbEnd - fbStart),
              fbStart,
              fbEnd,
            );
            this.trackRunnerUsage(fb);
            this._streamNativeToolCallIds = nativeToolCallIds;
            streamedAnswerForTurn = answerText;
            turnResult = nativeTurnFromStream({
              answerText,
              actions: nativeActions,
              finishReason: nativeFinishReason,
            });
          } catch (fbErr: any) {
            const fbEnd = performance.now();
            this.currentTurnTelemetry?.recordProviderSpan(
              Math.max(0, fbEnd - fbStart),
              fbStart,
              fbEnd,
            );
            // If tools still fail, degrade to raw-text (buffered — the lenient
            // parser may transform the final answer; not append-compatible).
            yield { type: 'thought', text: 'Retrying without tools…' };
            let rawText = '';
            const rawFbStart = performance.now();
            try {
              for await (const chunk of fb.executeRawStream(
                prompt,
                undefined,
                this.abortController.signal,
                this.providerRetryCallbacks({
                  deliveryMode: 'text',
                  conversationState: prompt,
                  executionStage: 'chat',
                  substitutionOrFallback: true,
                }),
              )) {
                rawText += chunk;
                this.currentTurnTelemetry?.markFirstToken();
              }
              const rawFbEnd = performance.now();
              this.currentTurnTelemetry?.recordProviderSpan(
                Math.max(0, rawFbEnd - rawFbStart),
                rawFbStart,
                rawFbEnd,
              );
              this.trackRunnerUsage(fb);
              turnResult = this.parseChatTurnLenient(rawText);
            } catch (rawErr: any) {
              const rawFbEnd = performance.now();
              this.currentTurnTelemetry?.recordProviderSpan(
                Math.max(0, rawFbEnd - rawFbStart),
                rawFbStart,
                rawFbEnd,
              );
              endSpan(_turnSpan, SpanStatusCode.ERROR);
              _turnSpan = null;
              const cancelled = this.emitCancelledIfOperatorAbort(rawErr);
              if (cancelled) {
                yield cancelled;
                return;
              }
              yield this.streamFailed(rawErr?.message ?? String(rawErr));
              return;
            }
          }
        }
      } else {
        // ── Legacy prompt-based JSON path ─────────────────────────────────
        // Buffered: raw output is re-parsed (lenient JSON extraction), so the
        // parsed final answer is not append-compatible with the raw stream.
        let rawText = '';
        const legacyStart = performance.now();
        try {
          for await (const chunk of runner.executeRawStream(
            prompt,
            undefined,
            this.abortController.signal,
            this.providerRetryCallbacks({
              deliveryMode: 'text',
              conversationState: prompt,
              executionStage: 'chat',
            }),
          )) {
            rawText += chunk;
            this.currentTurnTelemetry?.markFirstToken();
          }
          const legacyEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, legacyEnd - legacyStart),
            legacyStart,
            legacyEnd,
          );
          this.trackRunnerUsage(runner);
        } catch (err: any) {
          const legacyEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, legacyEnd - legacyStart),
            legacyStart,
            legacyEnd,
          );
          const admissionRecovery = await this.recoverPreparedRequestAdmission(err);
          if (admissionRecovery) {
            yield { type: 'context_compacted', ...admissionRecovery };
            continue;
          }
          const fb = yield* this.resolveFallbackOrFail(err, turn);
          if (!fb) {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            return;
          }
          rawText = '';
          try {
            for await (const chunk of fb.executeRawStream(
              prompt,
              undefined,
              this.abortController.signal,
              this.providerRetryCallbacks({
                deliveryMode: 'text',
                conversationState: prompt,
                executionStage: 'chat',
                substitutionOrFallback: true,
              }),
            )) {
              rawText += chunk;
              this.currentTurnTelemetry?.markFirstToken();
            }
            this.trackRunnerUsage(fb);
          } catch (fbErr: any) {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            const cancelled = this.emitCancelledIfOperatorAbort(fbErr);
            if (cancelled) {
              yield cancelled;
              return;
            }
            yield this.streamFailed(fbErr?.message ?? String(fbErr));
            return;
          }
        }

        turnResult = this.parseChatTurnLenient(rawText);
      }

      // Item 7: end-of-turn token explosion on stream path (after LLM usage tracked)
      const streamExplosion = evaluateTokenExplosionAfterTurn({
        tokensAtTurnStart: this.apiTokenCountAtTurnStart,
        tokensNow: this.apiTokenCount,
        maxTokensPerRound: this.limits.maxTokensPerRound,
        hasAnyWrites: this.hasAnyWrites(),
      });
      if (streamExplosion.abort) {
        // Tier A2: Record token explosion event before aborting
        recordPolicyEvent(
          this.policyEventLog,
          this._turnIndex,
          'token_explosion',
          `tokens_this_turn=${streamExplosion.tokensThisTurn}`,
        );
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        this.terminatingLimiter = 'tokens';
        this.terminalLimiterReason =
          `Token explosion with zero mutations: ${streamExplosion.tokensThisTurn} tokens this turn (ceiling ${this.limits.maxTokensPerRound}).`;
        const kill = await this.handleBudgetKill(
          this.terminalLimiterReason,
          { onThought: () => {} },
          effectiveIntent,
        );
        yield this.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }

      if (turnResult.type === 'tool_calls' && turnResult.actions.length > 0) {
        if (turnResult.thinking) {
          yield { type: 'thought', text: turnResult.thinking };
        }

        // R7: After force_status intervention (level ≥ 3), check if the model
        // declared BLOCKED in its thinking text while still issuing tool calls.
        if (turnResult.thinking && this.stallState.interventionLevel >= 3) {
          const thinkingBlocked = this.detectAndBuildBlockedReport(turnResult.thinking);
          if (thinkingBlocked) {
            this.conversation.push({
              role: 'assistant',
              content: turnResult.thinking,
            });
            _turnSpan.setAttribute('babel.chat.blocked', 'true');
            endSpan(_turnSpan, SpanStatusCode.OK);
            _turnSpan = null;
            yield this.streamDone(turnResult.thinking, {
              blockedReport: thinkingBlocked,
            });
            return;
          }
        }

        // Capture toolCallLog start index BEFORE execution so the
        // per-turn slice is correct even as the log grows across turns.
        this._turnToolCallLogStart = this.toolCallLog.length;
        this._activeToolBatchId = `batch_${turn}_${this._turnToolCallLogStart}`;

        // W2.2 settle: assign stable call ids, persist tool_proposed+tool_started
        // to session-events.jsonl BEFORE any side effects (kill/resume safety).
        const settleCallIds = turnResult.actions.map((_, idx) => {
          if (this._streamNativeToolCallIds[idx]) return this._streamNativeToolCallIds[idx]!;
          return `tool_call_${turn}_${idx}`;
        });
        if (this._streamNativeToolCallIds.length === 0 && turnResult.actions.length > 0) {
          this._streamNativeToolCallIds = settleCallIds;
        }
        if (!toolsAnnouncedInStream) {
          for (const [idx, action] of turnResult.actions.entries()) {
            yield {
              type: 'tool_start',
              toolCallId: settleCallIds[idx]!,
              tool: chatActionToolName(action),
              target: chatActionTarget(action),
            };
          }
        }
        if (turnResult.actions.length > 0) {
          paritySettleProposeTools(
            this.parity,
            turnResult.actions.map((action, idx) => ({
              id: settleCallIds[idx]!,
              name: chatActionToolName(action),
              argsDigest: operationFingerprint(chatActionToolName(action), action),
              action_index: idx,
              batch_id: this._activeToolBatchId!,
              target_summary: chatActionTarget(action),
            })),
            this.engineRunDir,
          );
        }

        const subAgentEvents: ChatEvent[] = [];

        const { observations, observationList } = await this.executeActions(turnResult.actions, {
          onToolStart: (_tool, _target) => {
            this._hadToolCallsThisTurn = true;
            return 0;
          },
          onToolComplete: (id, detail) => {
            // handled below via toolCallLog
          },
          onSubAgentStart: (info) => {
            subAgentEvents.push({
              type: 'sub_agent_start',
              id: info.id,
              label: info.label,
            });
          },
          onSubAgentComplete: (info) => {
            subAgentEvents.push({
              type: 'sub_agent_complete',
              id: info.id,
              summary: info.summary,
            });
          },
          onSubAgentFailed: (info) => {
            subAgentEvents.push({
              type: 'sub_agent_failed',
              id: info.id,
              error: info.error,
            });
          },
          onFileChanged: (path, additions, deletions, content) => {
            subAgentEvents.push({
              type: 'file_changed',
              path,
              additions,
              deletions,
              ...(content ? { content } : {}),
            });
          },
        });

        // Repetition loop detection: record each executed action and check for loops
        for (const action of turnResult.actions) {
          const tool = chatActionToolName(action);
          const target = chatActionTarget(action);
          this.repetitionDetector.record({
            type: tool,
            fingerprint: `${tool}:${target}`,
          });
        }
        const streamLoopResult = this.repetitionDetector.detect();
        if (streamLoopResult.loop) {
          this.conversation.push({
            role: 'system',
            content: `[SYSTEM] Detected repetition loop: ${streamLoopResult.message} Please proceed to the next step or use [TOOL:finish] if done.`,
          });
          this.repetitionDetector.reset();
        }

        // Yield sub-agent lifecycle events collected during execution
        for (const event of subAgentEvents) {
          yield event;
        }

        recordTurnToolObservability(this.obsHandles());

        allToolObservations += observations;
        this.conversation.push({
          role: 'assistant',
          content: turnResult.thinking ?? 'Using tools…',
          name: 'tool_calls',
        });
        // Text-tools models need plain text [OK]/[RESULT] results instead of role:tool
        if (useTextTools) {
          this.conversation.push({
            role: 'user',
            content: this.buildTextToolResults(this._turnToolCallLogStart),
          });
        } else {
          this.conversation.push({ role: 'tool', content: observations });
        }

        let providerToolCallIds: string[] | undefined;
        if (useNativeTools && turnResult.type === 'tool_calls') {
          providerToolCallIds = turnResult.actions.map((_, idx) => {
            if (this._streamNativeToolCallIds.length === turnResult.actions.length) {
              return this._streamNativeToolCallIds[idx]!;
            }
            return `tool_call_${this._turnIndex}_${idx}`;
          });
        }

        // Yield tool complete events (slice from this turn's start, sorted by
        // original action index so tool_complete order matches tool_start order
        // even when read tools complete concurrently in a different order).
        for (const [settlementIndex, tc] of this.toolCallLog
          .slice(this._turnToolCallLogStart)
          .sort((a, b) => a.index - b.index)
          .entries()) {
          tc.toolCallId = settleCallIds[settlementIndex]!;
          yield {
            type: tc.error || (tc.exit_code !== undefined && tc.exit_code !== 0)
              ? 'tool_failed'
              : 'tool_complete',
            toolCallId: tc.toolCallId,
            tool: tc.tool,
            target: tc.target,
            ...(tc.detail ? { detail: tc.detail } : {}),
            ...(tc.error ? { error: tc.error } : {}),
            ...(tc.exit_code !== undefined ? { exitCode: tc.exit_code } : {}),
            ...(tc.effect_status !== undefined ? { effect_status: tc.effect_status } : {}),
            ...(tc.mutation_paths !== undefined ? { mutation_paths: [...tc.mutation_paths] } : {}),
          };
        }

        await new Promise((resolve) => setImmediate(resolve));
        // Only reset gate strikes when this turn includes a mutation —
        // read-only turns don't reset the counter.
        if (this.currentTurnHasMutation()) {
          this.gateStrikes = 0;
          this.criticStrikes = 0;
          this.turnsWithoutWrite = 0;
          this.consecutiveReadOnlyTools = 0;
          this.consecutiveNonMutatingShells = 0;
          this.toolsWithoutWrite = 0;
          this.investigateSoftNudgeDone = false;
          this.midLoopCriticFired = false;
          this.applyPostWriteRepairBudget();
        } else {
          this.turnsWithoutWrite++;
        }

        // Mid-loop heuristic critic (stream path)
        if (this.currentTurnHasMutation() || (this.hasAnyWrites() && this.lastVerifierReceipt)) {
          this.maybeInjectMidLoopHeuristicCritic({ onThought: () => {} }, effectiveIntent);
        }

        const exploreFuses = this.applyExploreFuses(
          effectiveExecutePolicy,
          isReadOnlyInspection,
        );
        for (const label of exploreFuses.labels) {
          yield { type: 'thought', text: label };
        }

        // P2: Update stall detector and inject phase nudge if needed
        const turnCallsStr = this.toolCallLog.slice(this._turnToolCallLogStart);
        this.stallState = updateStallState(this.stallState, turnCallsStr, turn);

        const streamPhase = classifyPhase(
          this.stallState,
          this.hasAnyWrites(),
          this.stallState.lastVerifierTurn >= 0,
        );
        // Tier A2: Record phase change event
        if (streamPhase !== this._lastPhase && streamPhase !== null) {
          recordPolicyEvent(
            this.policyEventLog,
            this._turnIndex,
            'phase_change',
            `${this._lastPhase ?? 'start'}→${streamPhase}`,
          );
        }
        this._lastPhase = streamPhase;
        if (shouldNudge(this._lastPhase) && !isReadOnlyInspection) {
          const hintsStr = turnCallsStr
            .filter(
              (e) =>
                e.tool === 'read_file' ||
                e.tool === 'read_range' ||
                isConfirmedMutation({
                  tool: e.tool,
                  error: e.error,
                  effectStatus: e.effect_status,
                  mutationPaths: e.mutation_paths,
                }),
            )
            .map((e) => e.target)
            .filter(Boolean);
          this.conversation.push({
            role: 'user',
            content: buildPhaseNudge(this._lastPhase, hintsStr),
          });
        }

        // R9: Tamper-aware escalation — if verifier files were modified this
        // turn, accelerate intervention regardless of write-stall count.
        const tamperEscalation = this.applyTamperEscalation();
        if (tamperEscalation === '__TAMPER_AUTO_BLOCKED__') {
          _turnSpan.setAttribute('babel.chat.tamper_blocked', 'true');
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          const tamperAnswer = await this.synthesizeAnswer(allToolObservations, {
            onAnswerChunk: (_chunk: string) => {},
          }).catch(() => '');
          const tamperBlocked = tamperAnswer
            ? this.detectAndBuildBlockedReport(tamperAnswer)
            : null;
          const finalTamperAnswer = tamperBlocked
            ? tamperAnswer
            : `BLOCKED: Verifier integrity compromised — ${this.tamperCount} verifier dependency files were modified. The task cannot be completed honestly.`;
          this.conversation.push({
            role: 'assistant',
            content: finalTamperAnswer,
          });
          yield this.streamDone(finalTamperAnswer, {
            blockedReport: tamperBlocked ?? null,
            verifierTampered: true,
          });
          return;
        }
        if (tamperEscalation) {
          this.conversation.push({ role: 'user', content: tamperEscalation });
          yield {
            type: 'thought',
            text: `[Tamper escalation: ${this.tamperCount} violations]`,
          };
        }

        // R2: Escalating stall intervention — kill routed through parity arbiter
        const stallIntervention = this.checkStallIntervention(isReadOnlyInspection);
        if (stallIntervention && stallIntervention.level !== 'kill') {
          recordPolicyEvent(
            this.policyEventLog,
            this._turnIndex,
            'stall_intervention',
            `level=${stallIntervention.level}`,
          );
          // I4: never latch a mutate-only tool restriction onto a read-only
          // operation; the read-only stall path concludes or synthesizes.
          if (stallIntervention.level === 'restrict_tools' && !isReadOnlyInspection) {
            this.restrictToolsNextTurn = true;
          }
          this.conversation.push({
            role: 'user',
            content: stallIntervention.message,
          });
          yield {
            type: 'thought',
            text: `[Stall intervention: ${stallIntervention.level}]`,
          };
        }
        if (stallIntervention?.level === 'kill') {
          recordPolicyEvent(
            this.policyEventLog,
            this._turnIndex,
            'stall_intervention',
            'level=kill',
          );
        }

        // Record progress + durable tool results (contentHash for re-read fidelity).
        // Identity is the original action index, never completion-order slice position.
        const turnSlice = this.toolCallLog.slice(this._turnToolCallLogStart);
        const isReadTool = (name: string) =>
          name === 'read_file' || name === 'file_read' || name === 'read_range' || name === 'grep';
        const projected = projectDurableToolBatch({
          turnSlice,
          observationsByActionIndex: observationList,
          ...(turnResult.type === 'tool_calls'
            ? { actions: turnResult.actions as Array<Record<string, unknown>> }
            : {}),
          turn,
          batchId: this._activeToolBatchId ?? `batch_${turn}_${this._turnToolCallLogStart}`,
          ...(providerToolCallIds ? { providerToolCallIds } : {}),
          streamNativeToolCallIds: this._streamNativeToolCallIds,
          contentHashFor: (toolName, content) =>
            isReadTool(toolName) && content.length > 0
              ? createHash('sha256').update(content).digest('hex').slice(0, 16)
              : undefined,
        });
        let cycleReceipt: ProgressReceipt | null = null;
        try {
          cycleReceipt = parityRecordToolBatch(this.parity, {
            at_turn: turn,
            ...(turnResult.type === 'tool_calls' && turnResult.thinking
              ? { thinking: turnResult.thinking }
              : {}),
            toolCalls: projected.toolCalls,
            results: projected.results,
            patchAttempted: turnSlice.some(
              (t) => isConfirmedMutation({
                tool: t.tool,
                error: t.error,
                effectStatus: t.effect_status,
                mutationPaths: t.mutation_paths,
              }),
            ),
            patchFailed: turnSlice.some(
              (t) => t.tool === 'str_replace' && t.error != null && t.error !== '',
            ),
            verifierChanged: this.computeVerifierChanged(projected.results),
            // Context epoch: advancing it makes necessary re-reads count again.
            contextEpoch: this.readContextEpoch,
            // W2.2: propose+start already flushed before executeActions.
            settleAlreadyProposed: turnResult.actions.length > 0,
            // Do NOT pass every read as localizedPaths — re-reads use contentHash only.
          });
        } catch (err) {
          const captured = captureSessionEventAppendFailure(err, this.engineRunDir);
          this._streamNativeToolCallIds = [];
          this._activeToolBatchId = null;
          if (captured) {
            yield this.streamFailed(captured.operatorMessage);
            return;
          }
          throw err;
        }
        this._streamNativeToolCallIds = [];
        this._activeToolBatchId = null;

        // D02: score the W3 progress/recovery controller from the same evidence
        // set as the durable receipt (confirmed mutation + receipt read-novelty)
        // instead of an empty mutation-only list. A read-only investigation with
        // distinct reads therefore stays at "none" rather than emitting false
        // restricted_tools / terminal_blocked labels.
        const progressSignals: ProgressSignal[] = [];
        if (
          turnCallsStr.some(
            (tc) =>
              isConfirmedMutation({
                tool: tc.tool,
                error: tc.error,
                effectStatus: tc.effect_status,
                mutationPaths: tc.mutation_paths,
              }) ||
              (tc.tool === 'sub_agent' && tc.effect_status === 'confirmed_change'),
          )
        ) {
          progressSignals.push('production_mutation');
        }
        for (const signal of progressSignalsFromReceipt(cycleReceipt)) {
          if (!progressSignals.includes(signal)) progressSignals.push(signal);
        }
        const isTextOnly = turnCallsStr.length === 0;
        const pcResult = this.progressController.scoreTurn(
          progressSignals,
          isTextOnly,
          this.gateStrikes,
        );
        recordProgressRecovery(
          this.parity.sessionEvents,
          String(this.parity.turnId ?? this._turnIndex),
          {
            intervention: pcResult.intervention,
            score: pcResult.score,
            signals: progressSignals,
            reason: 'turn_scored',
          },
        );
        if (pcResult.transitioned) {
          this.currentTurnTelemetry?.recordPolicyIntervention();
          yield {
            type: 'progress_recovery',
            intervention: pcResult.intervention,
            source: 'progress_controller',
            score: pcResult.score,
            message: `Transitioned to ${pcResult.intervention}`,
          };
        }

        // P0-E: zero-write shadow by default for coding classes (one-shot log);
        // enforce ablation is a real terminal via zeroWriteTerminalMessage.
        const alreadyHasZeroWriteShadow = this.policyEventLog
          .all()
          .some((e) => e.kind === 'zero_write_shadow');
        const zeroWriteDecision = evaluateZeroWriteWithShadow({
          executeIntent: effectiveExecutePolicy,
          completedTurns: turn + 1,
          hasAnyWrites: this.hasAnyWrites(),
          taskClass: this.taskClass,
          atTurn: turn,
          alreadyHasZeroWriteShadow,
        });
        for (const ev of zeroWriteDecision.events) {
          this.policyEventLog.record(ev);
        }
        // Host/toolchain env block (missing pytest, host deps before patch) →
        // terminal ENV_BLOCKED instead of progress_terminal thrash.
        // After writes, import failures are treated as patch-induced (not host env).
        const sessionHasWrites = this.hasAnyWrites();
        const envBlockedSignal = (() => {
          for (const t of turnSlice) {
            const signal = extractToolEnvBlockedSignal(t, { hasAnyWrites: sessionHasWrites });
            if (signal) return signal;
          }
          return null;
        })();
        // I01 observation mode: the identical counter and terminal candidate
        // were computed above; withhold only this candidate from the arbiter
        // and record durable would-fire evidence instead. All other terminals,
        // nudges, budgets, and permissions are untouched.
        const executeHardCapTerminal = !isReadOnlyInspection
          ? exploreFuses.investigateHardCapTerminal
          : null;
        const i01ObserveOnly = executeHardCapTerminal !== null && resolveInvestigateHardCapObserveOnly();
        if (i01ObserveOnly) {
          recordPolicyIntervened(this.parity.sessionEvents, this.parity.turnId ?? 'policy', {
            source: 'investigate_hard_cap',
            action: 'would_fire_observe_only',
            detail: `i01: tools_without_write=${this.toolsWithoutWrite} terminal_withheld_from_arbiter=1`,
          });
        }
        const arb = parityArbitrateCycle({
          rt: this.parity,
          isReadOnlyInspection,
          fuseLabels: exploreFuses.labels,
          forceMutateMessage: exploreFuses.forceMutateMessage,
          readThrashMessage: exploreFuses.readThrashMessage,
          explorationFuseMessage: exploreFuses.explorationFuseMessage,
          shellSoftMessage: exploreFuses.shellSoftMessage,
          investigateBudgetMessage: exploreFuses.investigateBudgetMessage,
          readOnlyHardCapTerminal: isReadOnlyInspection
            ? exploreFuses.investigateHardCapTerminal
            : null,
          investigateHardCapTerminal: i01ObserveOnly ? null : executeHardCapTerminal,
          stallMessage:
            stallIntervention && stallIntervention.level !== 'kill'
              ? stallIntervention.message
              : null,
          stallKillMessage: stallIntervention?.level === 'kill' ? stallIntervention.message : null,
          zeroWriteCandidate: zeroWriteDecision.arbiterMessage,
          zeroWriteTerminalMessage: zeroWriteDecision.terminalMessage,
          envBlockedSignal,
        });
        if (arb.policySource) {
          this.policyEventLog.record({
            at_turn: turn,
            kind:
              arb.policySource === 'env_blocked'
                ? 'progress_policy'
                : arb.terminalAnswer
                  ? 'progress_terminal'
                  : 'progress_policy',
            detail: `${arb.policySource}: ${arb.policyMessage ?? arb.terminalAnswer ?? ''}`,
          });
        }
        if (arb.terminalAnswer) {
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;

          // Read-only inspection terminal: synthesize gathered evidence into a
          // bounded final informational answer instead of a generic capability
          // block. Covers the read-only hard cap and the evidence-based
          // no-progress terminal (never press a research task to mutate).
          if (
            (arb.policySource === 'investigate_hard_cap' ||
              arb.policySource === 'read_only_hard_cap' ||
              arb.policySource === 'progress_terminal') &&
            isReadOnlyInspection
          ) {
            let synthAnswer = '';
            let synthError: Error | null = null;
            try {
              synthAnswer = await this.synthesizeAnswer(allToolObservations, {
                onAnswerChunk: (_chunk: string) => {},
              });
            } catch (err: any) {
              synthError = err instanceof Error ? err : new Error(String(err));
            }

            if (synthError || !synthAnswer?.trim()) {
              const failMsg = `Answer synthesis failed after inspection completed: ${synthError?.message ?? 'no answer generated'}`;
              this.conversation.push({ role: 'assistant', content: failMsg });
              yield { type: 'answer_chunk', text: failMsg };
              yield this.streamDone(failMsg, {
                blockedReport: {
                  schema_version: 1,
                  status: 'BLOCKED',
                  reason: 'Answer synthesis unavailable',
                  missing: 'LLM provider response for answer synthesis',
                  checked: [
                    {
                      action: 'synthesize_answer',
                      target: 'provider',
                      finding: synthError?.message ?? 'Empty synthesis output',
                    },
                  ],
                },
              });
              return;
            }

            const finalAnswer = synthAnswer.trim();
            const synthBlocked = this.detectAndBuildBlockedReport(finalAnswer);
            this.conversation.push({ role: 'assistant', content: finalAnswer });
            yield { type: 'answer_chunk', text: finalAnswer };
            yield this.streamDone(finalAnswer, {
              blockedReport: synthBlocked ?? null,
            });
            return;
          }

          // Prefer BLOCKED synthesis when stall kill and agent already diagnosed
          if (stallIntervention?.level === 'kill') {
            const killAnswer = await this.synthesizeAnswer(allToolObservations, {
              onAnswerChunk: (_chunk: string) => {},
            }).catch(() => '');
            const killBlocked = killAnswer ? this.detectAndBuildBlockedReport(killAnswer) : null;
            if (killBlocked) {
              this.conversation.push({
                role: 'assistant',
                content: killAnswer,
              });
              yield this.streamDone(killAnswer, { blockedReport: killBlocked });
              return;
            }
          }
          this.conversation.push({
            role: 'assistant',
            content: arb.terminalAnswer,
          });
          yield this.streamDone(arb.terminalAnswer, {
            blockedReport: buildPolicyTerminalBlockedReport(
              arb.policySource ?? 'progress_terminal',
              arb.terminalAnswer,
            ),
          });
          return;
        }
        if (arb.policyMessage) {
          this.conversation.push({ role: 'user', content: arb.policyMessage });
          yield { type: 'thought', text: `[Policy: ${arb.policySource}]` };
        }
        // Mid-loop checkpoint only (turn continues) — terminal paths use finalizeParityTurn.
        // Also flush policy events so hard harness kills still leave scoreboard data.
        checkpointParityEventLog(this.parity, this.engineRunDir);
        persistPolicyEventsJsonl(this.engineRunDir, this.policyEventLog);

        _turnSpan.setAttribute('babel.chat.turn', `${turn + 1}:tool_calls`);
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        continue;
      }

      if (turnResult.type === 'completion') {
        const answer = turnResult.answer;

        if (this.parity.turnId) {
          this.services.conversation.recordAssistantMessage(
            this.parity.eventLog,
            this.parity.turnId,
            answer,
          );
        }

        // R1: Check for BLOCKED declaration before the gate — the agent may
        // declare BLOCKED even though no writes were made.
        const blockedReport = this.detectAndBuildBlockedReport(answer);
        if (blockedReport) {
          const blockedDelta = reconcileStreamedAnswer(streamedAnswerForTurn, answer);
          if (blockedDelta !== null) {
            yield { type: 'answer_chunk', text: blockedDelta };
          }
          this.conversation.push({ role: 'assistant', content: answer });
          _turnSpan.setAttribute('babel.chat.blocked', 'true');
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          yield this.streamDone(answer, { blockedReport });
          return;
        }

        // R11: Per-round token ceiling — must run BEFORE any continuation
        // mechanism (text-only guard, prefers-patch refusal). Both of those
        // `continue` the loop and would otherwise starve this cost terminal:
        // a single text round that burned > maxTokensPerRound must hard-stop
        // immediately instead of being re-queried.
        const tokenCeilingBlocked = this.checkPerRoundTokenCeiling(false);
        if (tokenCeilingBlocked) {
          _turnSpan.setAttribute('babel.chat.token_ceiling_blocked', 'true');
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          this.conversation.push({ role: 'assistant', content: answer });
          this.conversation.push({
            role: 'assistant',
            content: tokenCeilingBlocked,
          });
          yield this.streamDone(tokenCeilingBlocked, {
            blockedReport: {
              schema_version: 1 as const,
              status: 'BLOCKED' as const,
              reason: `Per-round token ceiling exceeded: ${this.apiTokenCount - this.apiTokenCountAtTurnStart} tokens with zero tool calls`,
              missing: 'Agent produced only text — no tool calls were made',
              checked: [
                {
                  action: 'token_ceiling',
                  target: 'per_round_limit',
                  finding: `${(this.apiTokenCount - this.apiTokenCountAtTurnStart).toLocaleString()} tokens this turn (limit: ${this.limits.maxTokensPerRound.toLocaleString()})`,
                },
              ],
            },
            ...(this.verifierTampered ? { verifierTampered: true as const } : {}),
          });
          return;
        }

        // R11: Text-only loop guard — detect when the model produces only
        // text/completion responses without any tool calls. This must run
        // BEFORE the implementor prefers-patch refusal below: the refusal
        // continues unconditionally on every zero-write execute completion,
        // which would starve this bounded escalation (force_status at 3,
        // BLOCKED at 5) and re-query pure-text loops until maxTurns.
        this.stallState = {
          ...this.stallState,
          textOnlyTurns: this.stallState.textOnlyTurns + 1,
        };
        if (isTextOnlyLoop(this.stallState)) {
          const hasAnyWrites = this.hasAnyWrites();
          if (!hasAnyWrites && this.stallState.textOnlyTurns >= TEXT_ONLY_FORCE_BLOCKED_THRESHOLD) {
            // 5+ text-only turns with zero writes — force BLOCKED.
            _turnSpan.setAttribute('babel.chat.text_only_blocked', 'true');
            endSpan(_turnSpan, SpanStatusCode.OK);
            _turnSpan = null;
            const textBlockedMsg = buildTextOnlyLoopBlockedMessage(this.stallState);
            this.conversation.push({ role: 'assistant', content: answer });
            this.conversation.push({
              role: 'assistant',
              content: textBlockedMsg,
            });
            yield this.streamDone(textBlockedMsg, {
              blockedReport: {
                schema_version: 1 as const,
                status: 'BLOCKED' as const,
                reason: 'Agent produced only text responses without tool calls or file changes',
                missing: 'Unable to determine — no tool calls were made',
                checked: [
                  {
                    action: 'chat_turn',
                    target: 'text_only_loop',
                    finding: `${this.stallState.textOnlyTurns} consecutive turns with zero tool calls and zero writes`,
                  },
                ],
              },
              ...(this.verifierTampered ? { verifierTampered: true as const } : {}),
            });
            return;
          }
          // At threshold 3: inject force_status and continue the loop.
          this.conversation.push({ role: 'assistant', content: answer });
          this.conversation.push({
            role: 'user',
            content: buildTextOnlyLoopIntervention(this.stallState),
          });
          yield {
            type: 'thought',
            text: `[Text-only loop: ${this.stallState.textOnlyTurns} turns, escalating]`,
          };
          _turnSpan.setAttribute('babel.chat.text_only_turn', this.stallState.textOnlyTurns);
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          continue;
        }

        // Implementor I-03: refuse silent complete on execute with zero writes
        // (allow env_blocked answers through). Import errors after writes are not host env.
        const completionHasWrites = this.hasAnyWrites();
        const envDetectOpts = { hasAnyWrites: completionHasWrites };
        const envBlocked =
          (!isReadOnlyChat() && detectEnvBlockedFromText(answer, envDetectOpts)) ||
          this.toolCallLog.some((t) =>
            extractToolEnvBlockedSignal(t, envDetectOpts) !== null,
          );
        const completionPref = evaluateCompletionPrefersPatch({
          executeIntent: effectiveExecutePolicy,
          hasAnyWrites: completionHasWrites,
          envBlocked,
        });
        if (!completionPref.allowComplete && completionPref.message) {
          this.conversation.push({ role: 'assistant', content: answer });
          this.conversation.push({
            role: 'user',
            content: completionPref.message,
          });
          yield {
            type: 'thought',
            text: '[Implementor: completion prefers patch — continuing]',
          };
          this.policyEventLog.record({
            at_turn: this._turnIndex,
            kind: 'progress_policy',
            detail: 'completion_prefers_patch',
          });
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          continue;
        }

        // Execution gate: buffer streaming answer until gate check passes
        const gateResult = this.evaluateCompletionGate(turnResult, effectiveIntent);
        const hardGate = isBabelHeadlessEnv() || !process.stdout.isTTY;

        if (gateResult === 'reject') {
          const tuneStream = getChatTaskTune(this.taskClass);
          const policyStream = resolveVerificationPolicy({
            policy: tuneStream.verificationPolicy,
            task: this.options.task,
          });
          this.gatePolicy = policyStream;
          const plan = planCompletionGateReject({
            hasWrites: this.hasAnyWrites(),
            policy: policyStream,
            hardGate,
            hadToolCallsThisTurn: this._hadToolCallsThisTurn,
            gateStrikes: this.gateStrikes,
            maxGateStrikes: ChatEngine.MAX_GATE_STRIKES,
          });
          if (plan.kind === 'auto_continue_block') {
            _turnSpan.setAttribute('babel.chat.auto_continue_refused', 'true');
            endSpan(_turnSpan, SpanStatusCode.OK);
            _turnSpan = null;
            this.conversation.push({ role: 'assistant', content: answer });
            this.conversation.push({
              role: 'assistant',
              content: AUTO_CONTINUE_REFUSAL_MSG,
            });
            yield this.streamDone(AUTO_CONTINUE_REFUSAL_MSG, {
              blockedReport: buildAutoContinueBlockedReport(),
              ...(this.verifierTampered ? { verifierTampered: true as const } : {}),
            });
            return;
          }
          if (plan.kind === 'blocked') {
            _turnSpan.setAttribute('babel.chat.gate_blocked', 'true');
            endSpan(_turnSpan, SpanStatusCode.OK);
            _turnSpan = null;
            yield this.streamDone(`BLOCKED: ${plan.reason}`, {
              blockedReport: this.buildVerifierBlockedReport(plan.reason),
              ...(this.verifierTampered ? { verifierTampered: true as const } : {}),
            });
            return;
          }
          if (plan.kind === 'reject_continue') {
            this.gateStrikes = plan.gateStrikesAfter;

            // W3 Phase 3 Progress and Recovery Controller
            const pcResult = this.progressController.scoreTurn([], true, this.gateStrikes);
            recordProgressRecovery(
              this.parity.sessionEvents,
              String(this.parity.turnId ?? this._turnIndex),
              {
                intervention: pcResult.intervention,
                score: pcResult.score,
                signals: ['text_only_turn', 'gate_rejection'],
                reason: 'completion_gate_rejection',
              },
            );
            if (pcResult.transitioned) {
              yield {
                type: 'progress_recovery',
                intervention: pcResult.intervention,
                source: 'progress_controller',
                score: pcResult.score,
                message: `Gate strike threshold escalated to ${pcResult.intervention}`,
              };
            }

            this.conversation.push({ role: 'assistant', content: answer });
            this.conversation.push({
              role: 'user',
              content: plan.useGreenMessage
                ? this.buildGateRejectUserMessage()
                : this.buildRejectionMessage(),
            });
            _turnSpan.setAttribute('babel.chat.gate_strike', this.gateStrikes);
            endSpan(_turnSpan, SpanStatusCode.OK);
            _turnSpan = null;
            continue;
          }
          this.gateStrikes = plan.gateStrikesAfter;
        }

        // Idea 14: asymmetric diff critic before complete (streaming path)
        const streamCritic = await this.runAsymmetricDiffCritic(
          answer,
          {
            onThought: (_t) => {
              /* thought emitted via yield below when we can */
            },
          },
          effectiveIntent,
        );
        if (this.lastCriticReceipt) {
          yield {
            type: 'thought',
            text: `[Diff critic: ${this.lastCriticReceipt.verdict}]`,
          };
        }
        if (streamCritic === 'reject') {
          _turnSpan.setAttribute('babel.chat.critic_strike', this.criticStrikes);
          // Shrink remaining cost to a repair window (do not burn full session max).
          this.applyCriticRepairCostBudget();
          // Inject critic feedback so the model knows WHY and can fix it.
          const receipt = this.lastCriticReceipt;
          if (receipt?.reasons?.length) {
            const reasons = receipt.reasons.map((r, i) => `${i + 1}. ${r}`).join('\n');
            this.conversation.push({ role: 'assistant', content: answer });
            this.conversation.push({
              role: 'user',
              content: [
                '## Diff critic rejected your patch',
                '',
                reasons,
                '',
                'Fix these issues before trying to complete again.',
                'If the critic says you modified the wrong method or API,',
                're-read the issue to identify the CORRECT symbol to fix.',
                this.criticRepairCostCapUsd != null
                  ? `\nCost repair window active — finish the fix soon (cap $${this.criticRepairCostCapUsd.toFixed(2)}).`
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
            });
          }
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          continue;
        }
        if (streamCritic === 'block') {
          const report = this.buildCriticBlockedReport(
            this.lastCriticReceipt ?? {
              verdict: 'reject',
              reasons: ['critic hard-block'],
              confidence: 1,
            },
          );
          const blockedAnswer = this.buildCriticBlockedAnswer(report);
          this.conversation.push({ role: 'assistant', content: answer });
          this.conversation.push({ role: 'assistant', content: blockedAnswer });
          _turnSpan.setAttribute('babel.chat.critic_strike', this.criticStrikes);
          _turnSpan.setAttribute('babel.chat.critic_hard_block', 'true');
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          yield this.streamDone(blockedAnswer, {
            blockedReport: report,
            ...(this.lastCriticReceipt ? { criticReceipt: this.lastCriticReceipt } : {}),
            ...(this.verifierTampered ? { verifierTampered: true as const } : {}),
          });
          return;
        }

        // Emit only the not-yet-streamed remainder of the final answer —
        // re-emitting identical or prefix-overlapping text duplicates it in
        // the TUI (see reconcileStreamedAnswer).
        const answerDelta = reconcileStreamedAnswer(streamedAnswerForTurn, answer);
        if (answerDelta !== null) {
          yield { type: 'answer_chunk', text: answerDelta };
        }
        this.conversation.push({ role: 'assistant', content: answer });
        _turnSpan.setAttribute('babel.chat.turn', `${turn + 1}:completion`);
        if (this.lastCriticReceipt) {
          _turnSpan.setAttribute('babel.chat.critic_verdict', this.lastCriticReceipt.verdict);
        }
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        yield this.streamDone(answer, {
          ...(this.lastCriticReceipt ? { criticReceipt: this.lastCriticReceipt } : {}),
        });
        return;
      }
    }

    // maxTurns exceeded
    this.terminatingLimiter = this.terminatingLimiter ?? 'turns';
    this.terminalLimiterReason =
      this.terminalLimiterReason ??
      `Turn limit reached (${this.taskAllowance?.consumed.turns ?? maxTurns} of ` +
        `${this.taskAllowance?.grant.turnCap ?? maxTurns}).`;
    const maxTurnAnswer = await this.synthesizeAnswer(allToolObservations, {
      onAnswerChunk: (_chunk) => {},
    }).catch(() => '');
    this.conversation.push({ role: 'assistant', content: maxTurnAnswer });

    // R1: Check synthesized answer for BLOCKED before gate — must come
    // before the gate check since BLOCKED is a valid terminal outcome
    // that bypasses the write/verifier gate.
    const maxTurnBlockedReport = this.detectAndBuildBlockedReport(maxTurnAnswer);
    if (maxTurnBlockedReport) {
      yield this.streamDone(maxTurnAnswer, {
        blockedReport: maxTurnBlockedReport,
      });
      return;
    }

    if (effectiveExecutePolicy) {
      const gateResult = this.evaluateCompletionGate(
        { type: 'completion', answer: '' },
        effectiveIntent,
      );
      if (gateResult === 'reject') {
        yield this.streamFailed(`Turn limit exceeded. ${this.buildRejectionMessage()}`);
        return;
      }

      // Critic on stream max-turn completion: terminal — reject becomes hard-block.
      const terminalCritic = await this.runAsymmetricDiffCritic(
        maxTurnAnswer,
        {
          onThought: (_t) => {
            /* no-op on terminal stream path */
          },
        },
        effectiveIntent,
        { terminal: true },
      );
      if (this.lastCriticReceipt) {
        yield {
          type: 'thought',
          text: `[Diff critic: ${this.lastCriticReceipt.verdict}]`,
        };
      }
      if (terminalCritic === 'block' || terminalCritic === 'reject') {
        const report = this.buildCriticBlockedReport(
          this.lastCriticReceipt ?? {
            verdict: 'reject',
            reasons: ['critic reject at turn limit'],
            confidence: 1,
          },
        );
        const blockedAnswer = this.buildCriticBlockedAnswer(report);
        yield this.streamDone(blockedAnswer, {
          blockedReport: report,
          ...(this.lastCriticReceipt ? { criticReceipt: this.lastCriticReceipt } : {}),
        });
        return;
      }
    }
    yield this.streamDone(maxTurnAnswer, {
      ...(this.lastCriticReceipt ? { criticReceipt: this.lastCriticReceipt } : {}),
    });
  }

  /**
   * Map operator abort / in-flight cancel to a cancelled stream event.
   * cancel() replaces AbortController, so signal.aborted on the new
   * controller is not sufficient — also honor _cancelled and runner wrap.
   */
  private emitCancelledIfOperatorAbort(err?: unknown): ChatEvent | null {
    if (this._cancelled || this.abortController.signal.aborted || isOperatorAbortError(err)) {
      this._cancelled = true;
      finalizeParityCancel(this.parity, this.engineRunDir);
      return this.streamCancelled();
    }
    return null;
  }

  /**
   * Abort the in-flight turn without touching the input arbiter.
   * TUI hosts dispatch ctrl_c themselves, then call this so a second
   * dispatch cannot be mistaken for "exit the process".
   */
  abortTurn(): void {
    this._cancelled = true;
    this.settleActiveExecutionForTerminal();
    this.abortController.abort();
    try {
      // Scoped to this engine's jobs; the tree kill itself is deferred
      // (setImmediate) so cancel latency never blocks on Windows taskkill.
      killAllBackgroundShells({ ownerId: this.engineRunId });
    } catch {
      // Best-effort: session must remain usable after cancel.
    }
    finalizeParityCancel(this.parity, this.engineRunDir);
    this.abortController = new AbortController();
  }

  cancel(): void {
    // Compatibility alias for non-UI callers. Ctrl+C arbitration belongs to
    // the interactive host so runtime cancellation cannot change UI state.
    this.abortTurn();
  }

  /** Expose durable event log for resume / tests. */
  getParityEventLog() {
    return this.parity.eventLog;
  }

  getParityRuntime(): ParityRuntime {
    return this.parity;
  }

  /** Content-free invariant mismatch count for shadow-mode telemetry consumers. */
  getRuntimeInvariantViolationCount(invariantId = MODEL_VISIBLE_EQUALS_PERSISTED): number {
    return this.runtimeInvariants.getViolationCount(invariantId);
  }

  /** Assert native wire reconstruction equality and provider protocol validity. */
  private assertNativeRequestMatchesDurable(
    outbound: readonly ProviderMessage[],
    systemPrompt: string,
    systemPromptOverride: string | undefined,
  ): void {
    const reconstructed = this.services.conversation.rebuildProviderMessages(this.parity.eventLog, {
      systemPrompt,
    });
    // Native runners share this deterministic final serializer. Compare its
    // exact output rather than neutral messages so committed capsules cannot
    // disappear between C1 and the provider POST body.
    const context: RequestReconstructionContext = {
      outbound: mapProviderMessagesToWire([...outbound], systemPrompt, systemPromptOverride),
      reconstructed: mapProviderMessagesToWire(reconstructed, systemPrompt, systemPromptOverride),
    };
    for (const invariantId of [MODEL_VISIBLE_EQUALS_PERSISTED, PROVIDER_PROTOCOL_VALID]) {
      const evaluation = this.runtimeInvariants.evaluate(invariantId, context);
      if (!evaluation.passed && evaluation.violation) {
        trace.getActiveSpan()?.addEvent('runtime_invariant_mismatch', {
          'runtime_invariant.id': evaluation.invariantId,
          'runtime_invariant.expected_hash': evaluation.violation.expectedHash,
          'runtime_invariant.actual_hash': evaluation.violation.actualHash,
        });
      }
    }
  }

  getInstructionManifest() {
    return this.parity.liveAuthority?.instructionManifest ?? null;
  }
  getTaskContract() {
    return this.parity.liveAuthority?.taskContract ?? null;
  }
  getLiveSession(c?: {
    turns?: number;
    tokens?: number;
    repair_attempts?: number;
    infra_retries?: number;
  }): LiveSessionV1 {
    return projectEngineLiveSession(this.parity, c);
  }
  canMutateIdempotencyKey(key: string): boolean {
    return engineCanMutateKey(this.parity, key);
  }
  consumeFailureBudget(failure: FailureCapsuleV1): boolean {
    return this.failureBudgetTracker.consume(failure);
  }
  getFailureBudgets() {
    return this.failureBudgetTracker.remainingBudgets();
  }
  /** H4: isolation + dirty-tree flags for the capability broker. */
  private isolationBrokerFlags() {
    return resolveIsolationBrokerFlags(this.options.projectRoot);
  }
  restoreEventLog(log: import('./threadEventLog.js').ThreadEventLog): void {
    this.parity.eventLog = log;
    this.clearVerifierEvidenceState();
    const lastTurn = [...log.events].reverse().find((e) => e.kind === 'turn_started');
    if (lastTurn) this.parity.turnId = lastTurn.turn_id;
  }
  /** W2.2+H2: restore session events, settle interrupted tools, reload authority, reproject LiveSession. */
  restoreSessionEvents(log: SessionEventLog, options?: { runDir?: string }): number {
    this.clearVerifierEvidenceState();
    const interrupted = restoreEngineSessionEvents({
      parity: this.parity,
      log,
      runDir: options?.runDir ?? this.engineRunDir,
    });
    this.restorePersistedVerifierEvidence(log);
    const repairGuidance = resumedToolRecoveryGuidance(this.parity.sessionEvents);
    if (
      repairGuidance &&
      !this.conversation.some((message) => message.content === repairGuidance)
    ) {
      this.conversation.push({ role: 'system', content: repairGuidance });
    }
    return interrupted;
  }
  restoreSessionEventsFromDir(runDir?: string): number {
    const targetDir = runDir ?? this.engineRunDir;
    const loaded = loadSessionEventLogIfPresentForResume(targetDir, this.engineRunId);
    return loaded ? this.restoreSessionEvents(loaded, { runDir: targetDir }) : 0;
  }

  public getResolvedRequiredVerifiers(): string[] {
    return resolveEngineRequiredVerifiers({
      task: this.options.task,
      projectTestCommands: this.discoveredTestCommands.map((e) => e.command),
      requiredVerifierCommands: this.options.requiredVerifierCommands ?? null,
    });
  }

  private clearVerifierEvidenceState(): void {
    this.executedVerifierLedger = [];
    this.lastVerifierReceipt = null;
    this.verifierReceiptCache.clear();
    this.platformUnusableVerifiers.clear();
    this.verifierDependencyHashes.clear();
    this.lastVerifierSignalSignature = null;
  }

  /**
   * M1: a verifier signal only counts as progress when the verifier's identity
   * or observed output changed. Repeated identical shell loops must not reset
   * the no-progress bound (D-T06) or add verifier score.
   */
  private computeVerifierChanged(
    results: ReadonlyArray<{ tool_name: string; content?: string; exit_code?: number }>,
  ): boolean {
    const verifierTools = new Set(['run_command', 'test_run', 'shell_exec']);
    const relevant = results.filter((r) => verifierTools.has(r.tool_name));
    if (relevant.length === 0) return false;
    const signature = relevant
      .map(
        (r) =>
          `${r.tool_name}:${r.exit_code ?? ''}:` +
          createHash('sha256').update(r.content ?? '').digest('hex').slice(0, 16),
      )
      .join('|');
    const changed = signature !== this.lastVerifierSignalSignature;
    this.lastVerifierSignalSignature = signature;
    return changed;
  }

  private restorePersistedVerifierEvidence(log: SessionEventLog): void {
    this.lastVerifierReceipt = restorePersistedVerifierEvidence(log, this.executedVerifierLedger);
  }

  /** Build the single canonical verifier input shared by every completion gate. */
  private buildVerifierInput(): ReturnType<typeof prepareKernelVerifierInput> & {
    requiredVerifierCommands: string[];
  } {
    return {
      ...prepareKernelVerifierInput(this.lastVerifierReceipt, this.executedVerifierLedger),
      requiredVerifierCommands: this.getResolvedRequiredVerifiers(),
    };
  }

  private decideCompletion(
    requestedOutcome: TerminalOutcome | 'PLAN_COMPLETE',
    hasMutation: boolean,
  ) {
    refreshChatVerifierReceiptStalenessSync(this.options.projectRoot, this.lastVerifierReceipt);
    for (const receipt of this.executedVerifierLedger)
      refreshChatVerifierReceiptStalenessSync(this.options.projectRoot, receipt);
    const verifierInput = this.buildVerifierInput();

    return this.executorKernel.completion.decide({
      mode: this.executionProfile,
      requestedOutcome,
      hasWrite: hasMutation,
      verificationPolicy: this.gatePolicy ?? 'required',
      lastVerifierReceipt: verifierInput.lastVerifierReceipt,
      executedVerifierLedger: verifierInput.executedVerifierLedger,
      verifierEvidenceErrors: verifierInput.verifierEvidenceErrors,
      requiredVerifierCommands: verifierInput.requiredVerifierCommands,
      toolCallLog: toGateToolLog(this.toolCallLog),
      ...(this.lastVerifierReceipt?.boundRevision
        ? { workspaceRevision: this.lastVerifierReceipt.boundRevision }
        : {}),
      proof:
        requestedOutcome === 'VERIFIED_COMPLETE'
          ? this.buildCompletionProof(hasMutation)
          : {
              compliant: false,
              errors: ['requested outcome was not verified'],
            },
    });
  }

  /**
   * Stream terminal helper — AC3: always finalizeParityTurn (memory + disk).
   * Every streaming exit must go through streamDone/streamFailed, not raw yields.
   */
  private streamDone(
    answer: string,
    extra?: {
      blockedReport?: BlockedReport | null;
      verifierTampered?: boolean;
      criticReceipt?: DiffCriticVerdict | null;
    },
  ) {
    this.settleActiveExecutionForTerminal();
    const hasMutation = this.hasAnyWrites();
    let requestedOutcome = computeTerminalOutcome({
      readOnly: isReadOnlyChat(),
      finalStatus: extra?.blockedReport
        ? 'blocked'
        : this.budgetExceeded
          ? 'budget_exhausted'
          : 'completed',
      budgetExceeded: this.budgetExceeded,
      lastVerifierReceipt: this.lastVerifierReceipt,
      blockedReport: extra?.blockedReport,
      hasAnyWrites: hasMutation,
    });
    requestedOutcome = applyHonestTaskOutcomeToCompletion({
      contract: this.parity.liveAuthority?.taskContract,
      requestedOutcome,
      hasMutation,
      planMode: this.executionProfile === 'plan',
    });
    const planCompletion =
      this.executionProfile === 'plan' && !extra?.blockedReport && !this.budgetExceeded;
    const decision = this.decideCompletion(
      planCompletion ? 'PLAN_COMPLETE' : requestedOutcome,
      hasMutation,
    );
    const outcome =
      decision.finalOutcome === 'PLAN_COMPLETE' ? 'UNVERIFIED_PATCH' : decision.finalOutcome;
    {
      this.recordCompletionDecisionOnce({
        requestedOutcome: decision.requestedOutcome,
        finalOutcome: outcome,
        allowed: decision.allowed,
        reason: decision.reason,
        evidenceRefs: decision.evidenceRefs,
        policyVersion: decision.policyVersion,
      });
    }
    // P0-E: attach shadow later-succeeded summary before export (idempotent with buildResult).
    // P0-F: wire the derived OutcomeDimensions — the real receipt (its `stale`
    // flag was just refreshed against the live workspace by decideCompletion)
    // and the completion-gate result (the final outcome IS the gate decision).
    recordPolicyShadowSessionOutcome(this.policyEventLog, {
      atTurn: this._turnIndex,
      hasSuccessfulMutation: hasMutation,
      codingTaskPassed: isCodingTaskSuccess({
        terminalOutcome: outcome,
        hasSuccessfulMutation: hasMutation,
        verifierOk: this.lastVerifierReceipt?.exit_code === 0,
        requireVerifier: false,
        declaredBlocked: Boolean(extra?.blockedReport),
        verifierReceipt: this.lastVerifierReceipt ?? null,
        contractChecksPass: outcome === 'VERIFIED_COMPLETE' ? true : null,
      }),
      terminalOutcome: outcome,
    });
    // Sync flush before process exit — required for campaign shadow scoreboard.
    persistPolicyEventsJsonl(this.engineRunDir, this.policyEventLog);
    const terminal = projectChatTerminal({
      outcome,
      status: extra?.blockedReport
        ? 'blocked'
        : this.budgetExceeded
          ? 'budget_exhausted'
          : 'completed',
    });
    finalizeParityTurnSync(
      this.parity,
      this.engineRunDir,
      terminal.outcome,
      terminal.status,
    );
    const finalizedTelemetry = this.currentTurnTelemetry?.finalize({
      turnId: String(this.parity.turnId ?? this._turnIndex),
      taskClass: this.taskClass,
      promptTokens: this.lastRequestPromptTokens,
      completionTokens: this.lastRequestCompletionTokens,
      cumulativeSessionTokens: globalCostTracker.getSessionSummary().totalTokens,
    });
    this.lastTurnTelemetry = finalizedTelemetry ?? null;
    const runAllowance = this.assembleRunAllowance(terminal.status);
    return buildStreamDone(this.obsHandles(), answer, {
      outcome: terminal.outcome!,
      status: terminal.status,
      ...(decision.finalOutcome === 'PLAN_COMPLETE'
        ? { planOutcome: 'PLAN_COMPLETE' as const }
        : {}),
      ...(this.budgetExceeded ? { budgetExceeded: true as const } : {}),
      ...(extra ?? {}),
      ...(this.limits.costBudget ? { costBudget: this.limits.costBudget } : {}),
      runAllowance,
      ...(finalizedTelemetry ? { turnTelemetry: finalizedTelemetry } : {}),
    });
  }

  private streamFailed(error: string) {
    this.settleActiveExecutionForTerminal();
    const providerOutputLimit = isProviderOutputLimitText(error);
    if (providerOutputLimit && this.terminatingLimiter == null) {
      this.terminatingLimiter = 'tokens';
      this.terminalLimiterReason = error;
    }
    const limiterOutcome: TerminalOutcome | undefined =
      this.terminatingLimiter === 'turns' ||
      this.terminatingLimiter === 'wall' ||
      this.terminatingLimiter === 'cost' ||
      this.terminatingLimiter === 'tokens' ||
      this.terminatingLimiter === 'child_exhaustion'
        ? 'BUDGET_EXHAUSTED'
        : this.terminatingLimiter === 'stall'
          ? 'BLOCKED_POLICY'
          : undefined;
    // Preserve an unknown terminal cause when no classifier or limiter proves
    // one. Durable validation accepts this explicit absence; guessing would
    // make the model-visible outcome less truthful.
    const outcome = classifyFailureText(error) ?? limiterOutcome;
    if (outcome === 'BUDGET_EXHAUSTED') this.budgetExceeded = true;
    const terminal = projectChatTerminal({
      ...(outcome !== undefined ? { outcome } : {}),
      status: 'failed',
    });
    const runAllowance = this.assembleRunAllowance(terminal.status);
    finalizeParityTurnSync(this.parity, this.engineRunDir, terminal.outcome, terminal.status);
    const finalizedTelemetry = this.currentTurnTelemetry?.finalize({
      turnId: String(this.parity.turnId ?? this._turnIndex),
      taskClass: this.taskClass,
      promptTokens: this.lastRequestPromptTokens,
      completionTokens: this.lastRequestCompletionTokens,
      cumulativeSessionTokens: globalCostTracker.getSessionSummary().totalTokens,
    });
    this.lastTurnTelemetry = finalizedTelemetry ?? null;
    return buildStreamFailed(this.obsHandles(), error, {
      ...(outcome !== undefined ? { outcome } : {}),
      status: terminal.status,
      ...(this.limits.costBudget ? { costBudget: this.limits.costBudget } : {}),
      runAllowance,
      ...(finalizedTelemetry ? { turnTelemetry: finalizedTelemetry } : {}),
    });
  }

  /**
   * Stream cancel helper — mirrors streamDone/streamFailed telemetry
   * finalization. Without this, a cancelled turn reports no per-turn
   * telemetry at all (first turn) or the PREVIOUS turn's stale record via
   * buildResult, while session token totals still include the rounds that
   * already ran — internally inconsistent cost/token reporting.
   */
  private streamCancelled(): ChatEvent {
    this.settleActiveExecutionForTerminal();
    const finalizedTelemetry = this.currentTurnTelemetry?.finalize({
      turnId: String(this.parity.turnId ?? this._turnIndex),
      taskClass: this.taskClass,
      promptTokens: this.lastRequestPromptTokens,
      completionTokens: this.lastRequestCompletionTokens,
      cumulativeSessionTokens: globalCostTracker.getSessionSummary().totalTokens,
    });
    this.lastTurnTelemetry = finalizedTelemetry ?? null;
    return {
      type: 'cancelled',
      status: 'cancelled',
      outcome: 'CANCELLED',
      ...(finalizedTelemetry ? { turnTelemetry: finalizedTelemetry } : {}),
    };
  }

  getConversation(): ChatMessage[] {
    return [...this.conversation];
  }

  getEngineRunId(): string {
    return this.engineRunId;
  }

  assignRunId(runId: string): void {
    if (runId === this.engineRunId) return;
    if (this.parity.eventLog.events.length > 0 || this.parity.sessionEvents.events.length > 0) {
      throw new Error('Cannot change ChatEngine run identity after durable events exist');
    }
    const authority = this.parity.liveAuthority;
    this.engineRunId = runId;
    this.parity = createParityRuntime(runId);
    if (authority) this.parity.liveAuthority = authority;
    mkdirSync(this.engineRunDir, { recursive: true });
    const persistedTaskBudget = this.readPersistedTaskBudget(this.engineRunDir);
    this.restorePersistedTaskBudget(persistedTaskBudget);
    this.persistTaskCostBaseline();
    if (authority) persistLiveSessionAuthority(this.engineRunDir, authority);
    this.failureBudgetTracker = createFailureBudgetTrackerFromContract(authority?.taskContract);
  }

  replaceConversation(messages: ChatMessage[]): void {
    this.conversation = messages;
    this.cachedSystemPromptLegacy = null;
    this.cachedSystemPromptNative = null;
    this.cachedSystemPromptText = null;
    // Replacing retained conversation content invalidates any prior read
    // injection, even when the replacement has the same message count.
    this.resetReadInjectionContext();
  }

  /** Restore structured provider conversation (tool call/result IDs) on resume. */
  replaceProviderConversation(messages: ProviderMessage[]): void {
    // Deprecated. We rebuild from event log.
  }

  getProviderConversation(): ProviderMessage[] {
    return this.services.conversation.rebuildProviderMessages(this.parity.eventLog);
  }

  resyncTurnStateAfterBranch(): void {
    this._cancelled = false;
    this.apiTokenCount = 0;
    this.compactionConsecutiveFailures = 0;
    this.clearSystemPromptCache();
    this.abortController = new AbortController();
    this.toolCallLog = [];
    this._turnToolCallLogStart = 0;
    // A branch resync discards retained context. Advance the epoch as well as
    // clearing the cache so unchanged bytes can be reacquired explicitly.
    this.resetReadInjectionContext();
    this.clearVerifierEvidenceState();
    this.verifierTampered = false;
    this.tamperCount = 0;
    this.tamperedThisTurn = false;
    this.writeCount = 0;
    this._lastPhase = null;
    // Tier A: Reset observability logs
    this.policyEventLog.clear();
    this.routingReceiptLog.clear();
    this.observationTails.clear();
    this.blockedAttemptLedger.clear();
    this._turnIndex = 0;
    this._logIndexToTurn.clear();
    // W0.3: branch resync drops task-scoped runtime (counters already zeroed).
    if (this.lastTurnRuntime) {
      this.lastTurnRuntime = {
        ...this.lastTurnRuntime,
        writeCount: 0,
        gateStrikes: 0,
        criticStrikes: 0,
        turnsWithoutWrite: 0,
        consecutiveReadOnlyTools: 0,
        consecutiveNonMutatingShells: 0,
        toolsWithoutWrite: 0,
        midLoopCriticFired: false,
        budgetExceeded: false,
        budgetLastChanceDone: false,
        restrictToolsNextTurn: false,
        continuedTask: false,
      };
    }
  }

  /**
   * W0.3: open TurnRuntime for a user submission.
   * Isolates write/gate counters by default so a prior task's patch cannot
   * satisfy a later completion gate. Pass continueTask: true for explicit
   * continuation (sticky intent + preserved counters).
   */
  applyUserSubmission(input: {
    userInput: string;
    taskIntent?: TaskIntent;
    continueTask?: boolean;
  }): TurnRuntimeSnapshot {
    const previous = this.snapshotPreviousForBegin();
    const runtime = beginUserSubmission({
      userInput: input.userInput,
      projectRoot: this.options.projectRoot,
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(input.taskIntent !== undefined ? { taskIntent: input.taskIntent } : {}),
      ...(input.continueTask !== undefined ? { continueTask: input.continueTask } : {}),
      classifyIntent: (text) => ChatEngine.classifyChatTaskIntent(text),
      previous,
    });

    this.options = { ...this.options, task: runtime.taskText };
    this.taskClass = runtime.taskClass;
    this.gatePolicy = runtime.gatePolicy;
    this.writeCount = runtime.writeCount;
    this.gateStrikes = runtime.gateStrikes;
    this.criticStrikes = runtime.criticStrikes;
    this.turnsWithoutWrite = runtime.turnsWithoutWrite;
    this.consecutiveReadOnlyTools = runtime.consecutiveReadOnlyTools;
    this.consecutiveNonMutatingShells = runtime.consecutiveNonMutatingShells;
    this.toolsWithoutWrite = runtime.toolsWithoutWrite;
    this.midLoopCriticFired = runtime.midLoopCriticFired;
    this.budgetExceeded = runtime.budgetExceeded;
    this.budgetLastChanceDone = runtime.budgetLastChanceDone;
    this.restrictToolsNextTurn = runtime.restrictToolsNextTurn;

    const continuationScopeUnavailable =
      input.continueTask === true && !runtime.continuedTask && this.taskCostScopeUnavailable;
    if (!runtime.continuedTask && !continuationScopeUnavailable) {
      // A fresh submission starts a new enforcement scope. The global tracker
      // is intentionally preserved for session/accounting views.
      //
      // S06 cross-task integration: reset ONLY task-local progress punishment
      // (level/score/strikes/streak/signals). Do not recreate the controller and
      // do not blank environment/provider capability health: a DEGRADED
      // capability persists across submissions and is recoverable only via
      // recordSuccess on a genuinely successful operation. Recreating the
      // controller here would silently revert DEGRADED capabilities to
      // AVAILABLE and would also discard task-local punishment on explicit
      // `continueTask`.
      this.progressController.resetTaskLocal();
      this.taskCostScopeUnavailable = false;
      this.criticRepairCostCapUsd = null;
      this.postWriteRepairWallCapMs = null;
      this.postWriteRepairRestrict = false;
      this.terminatingLimiter = null;
      this.terminalLimiterReason = null;
      this.clearVerifierEvidenceState();
      // Plan handoff force-mutate elevation must not leak into an unrelated task.
      this.forceMutateTurnsOverride = null;
      // P0-C: prior task exploration / stall state must not bias a new submission.
      this.fullReadCounts.clear();
      this.cumulativeExplorationTools = 0;
      this.stallState = createStallDetector();
      this.repetitionDetector.reset();
      // Budgets follow the new task class (not the previous submission's class).
      this.limits = resolveChatEngineLimits(
        {
          ...(this.options.maxTurns !== undefined ? { maxTurns: this.options.maxTurns } : {}),
          ...(this.options.maxConversationMessages !== undefined
            ? { maxConversationMessages: this.options.maxConversationMessages }
            : {}),
          ...(this.options.maxEstimatedTokens !== undefined
            ? { maxEstimatedTokens: this.options.maxEstimatedTokens }
            : {}),
          ...(this.options.maxTokensPerRound !== undefined
            ? { maxTokensPerRound: this.options.maxTokensPerRound }
            : {}),
          ...(this.options.maxWallMs !== undefined ? { maxWallMs: this.options.maxWallMs } : {}),
          ...(this.options.maxCostUsd !== undefined ? { maxCostUsd: this.options.maxCostUsd } : {}),
          ...(this.limits.costBudget ? { costBudget: this.limits.costBudget } : {}),
        },
        undefined,
        { taskClass: runtime.taskClass, taskText: runtime.taskText },
      );
      if (
        this.modelPolicy?.provider === 'openrouter' &&
        this.modelPolicy.providerModelId === LIVE_OPENROUTER_MODEL_ID
      ) {
        this.limits = {
          ...this.limits,
          investigateModel: LIVE_OPENROUTER_MODEL_ID,
          mutateModel: LIVE_OPENROUTER_MODEL_ID,
        };
      }
      this.startIndependentTaskCostScope();
      // Playbook / todo gate re-evaluate for the new task text.
      this.activePlaybook = selectPlaybookForChatTask(runtime.taskText) ?? null;
      this.requireTodoBeforeMutate = shouldRequireTodoPlan(runtime.taskText, this.activePlaybook);
      // System prompt may embed class/playbook hints — rebuild next LLM call.
      this.clearSystemPromptCache();
    }

    if (continuationScopeUnavailable) {
      this.budgetExceeded = true;
      this.budgetLastChanceDone = true;
      this.terminatingLimiter = 'cost';
      this.terminalLimiterReason =
        'Cannot restore durable task cost scope for explicit continuation.';
    }

    this.lastTurnRuntime = runtime;
    this.persistTaskCostBaseline();
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: 'progress_policy',
      detail: runtime.continuedTask
        ? `turn_runtime:continue:sub=${runtime.submissionIndex}:writes=${runtime.writeCount}:class=${runtime.taskClass}`
        : `turn_runtime:isolate:sub=${runtime.submissionIndex}:intent=${runtime.taskIntent}:class=${runtime.taskClass}`,
    });
    return runtime;
  }

  getTurnRuntimeSnapshot(): TurnRuntimeSnapshot | null {
    return this.lastTurnRuntime ? this.snapshotPreviousForBegin() : null;
  }
  getWriteCount(): number {
    return this.writeCount;
  }

  private snapshotPreviousForBegin(): TurnRuntimeSnapshot | null {
    if (!this.lastTurnRuntime) return null;
    return {
      ...this.lastTurnRuntime,
      writeCount: this.writeCount,
      gateStrikes: this.gateStrikes,
      criticStrikes: this.criticStrikes,
      turnsWithoutWrite: this.turnsWithoutWrite,
      consecutiveReadOnlyTools: this.consecutiveReadOnlyTools,
      consecutiveNonMutatingShells: this.consecutiveNonMutatingShells,
      toolsWithoutWrite: this.toolsWithoutWrite,
      midLoopCriticFired: this.midLoopCriticFired,
      budgetExceeded: this.budgetExceeded,
      budgetLastChanceDone: this.budgetLastChanceDone,
      restrictToolsNextTurn: this.restrictToolsNextTurn,
    };
  }

  clearSystemPromptCache(): void {
    this.cachedSystemPromptLegacy = null;
    this.cachedSystemPromptNative = null;
    this.cachedSystemPromptText = null;
  }

  /**
   * Apply the same preparation a freshly constructed engine receives so a
   * reused TUI engine's next native request matches headless/direct Chat.
   */
  applyTurnPreparation(preparation: ChatEngineTurnPreparation): void {
    const nextOptions: ChatEngineOptions = {
      ...this.options,
      task: preparation.task,
    };
    // A reused engine is a new turn boundary, not an overlay on the prior
    // request. Clear optional inputs first so omitted values cannot leak
    // stale prompts, preflight facts, model routing, or runtime claims.
    delete nextOptions.instructionRoot;
    delete nextOptions.systemContext;
    delete nextOptions.appendSystemPrompt;
    delete nextOptions.preflightContext;
    delete nextOptions.model;
    delete nextOptions.executionProfile;
    delete nextOptions.runtimeMode;
    if (preparation.projectRoot !== undefined) nextOptions.projectRoot = preparation.projectRoot;
    if (preparation.instructionRoot !== undefined) nextOptions.instructionRoot = preparation.instructionRoot;
    if (preparation.systemContext !== undefined) nextOptions.systemContext = preparation.systemContext;
    if (preparation.appendSystemPrompt !== undefined) nextOptions.appendSystemPrompt = preparation.appendSystemPrompt;
    if (preparation.preflightContext !== undefined) nextOptions.preflightContext = preparation.preflightContext;
    if (preparation.model !== undefined) nextOptions.model = preparation.model;
    if (preparation.executionProfile !== undefined) nextOptions.executionProfile = preparation.executionProfile;
    if (preparation.runtimeMode !== undefined) nextOptions.runtimeMode = preparation.runtimeMode;
    this.options = nextOptions;
    if (preparation.intentPlanUserMessage !== undefined) {
      this.options.intentPlanUserMessage = preparation.intentPlanUserMessage;
    } else {
      delete this.options.intentPlanUserMessage;
    }
    const chatPlaybook = selectPlaybookForChatTask(preparation.task);
    this.activePlaybook = chatPlaybook ?? null;
    this.requireTodoBeforeMutate = shouldRequireTodoPlan(
      preparation.task,
      this.activePlaybook,
    );
    if (preparation.systemContext !== undefined) {
      const projectRoot = this.options.instructionRoot ?? this.options.projectRoot;
      const babelMd = readProjectMemoryStructured(projectRoot, preparation.task);
      if (babelMd) {
        this.options.systemContext =
          babelMd + (this.options.systemContext ? '\n\n' + this.options.systemContext : '');
      }
      if (chatPlaybook) {
        const pbPrompt = buildPlaybookPrompt(chatPlaybook);
        if (pbPrompt) {
          this.options.systemContext =
            (this.options.systemContext ? this.options.systemContext + '\n\n' : '') + pbPrompt;
        }
      }
    }
    if (preparation.limits) {
      this.limits = preparation.limits;
      this.options.maxTurns = preparation.limits.maxTurns;
      this.options.maxConversationMessages = preparation.limits.maxConversationMessages;
      this.options.maxEstimatedTokens = preparation.limits.maxEstimatedTokens;
      this.options.maxTokensPerRound = preparation.limits.maxTokensPerRound;
      this.options.maxWallMs = preparation.limits.maxWallMs;
      const explicitCost = explicitFiniteCostOverride(preparation.limits);
      if (explicitCost !== undefined) {
        this.options.maxCostUsd = explicitCost;
      } else {
        delete this.options.maxCostUsd;
      }
    }
    this.taskClass = resolveChatTaskClass({
      taskText: preparation.task,
      autoClassify: true,
    });
    // Reused TUI engines start a new task/context. Do not let a previous
    // task's read dedupe suppress evidence in the new request.
    this.resetReadInjectionContext();
    this.clearSystemPromptCache();
  }

  /**
   * Static factory: restore a ChatEngine from a previously persisted session.
   *
   * Reads `{runs}/chat-sessions/{engineRunId}/transcript.jsonl` via runsLayout,
   * parses each line as a JSON ChatMessage, and returns a ready-to-use engine
   * whose conversation history is pre-populated. No new system prompt is
   * injected — the transcript already contains it.
   *
   * The restored engine reuses the original `engineRunId` so that subsequent
   * `persistTranscript()` calls append to the same session directory.
   *
   * @throws if the transcript file is missing, unreadable, or contains
   *         unparseable JSON lines.
   */
  static async restore(engineRunId: string, options: ChatEngineOptions): Promise<ChatEngine> {
    const transcriptPath = layoutTranscriptPath(engineRunId);
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(transcriptPath, 'utf-8');
    const messages: ChatMessage[] = content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    const sessionDir = chatSessionDir(engineRunId),
      sessionLog = loadSessionEventLogForResume(sessionDir, engineRunId);
    const engine = new ChatEngine({
      ...options,
      runId: engineRunId,
      resumeExisting: true,
    });
    engine.conversation = messages;
    const threadLog = loadThreadEventLogFromDir(sessionDir);
    if (threadLog) engine.restoreEventLog(threadLog);
    engine.restoreSessionEvents(sessionLog, { runDir: sessionDir });
    engine.clearVerifierEvidenceState();
    engine.cachedSystemPromptLegacy = null;
    engine.cachedSystemPromptNative = null;
    engine.cachedSystemPromptText = null;
    engine.apiTokenCount = 0;
    engine.compactionConsecutiveFailures = 0;
    return engine;
  }

  // ── Private Methods ─────────────────────────────────────────────────────

  /**
   * Execute a batch of tool actions sequentially through the policy gate.
   * Each action emits start/complete callbacks for the ConversationalRenderer.
   */
  private async executeActions(
    actions: ChatToolAction[],
    callbacks: ChatCallbacks,
  ): Promise<{
    observations: string;
    observationList: string[];
    count: number;
  }> {
    const toolContext: ToolContext = {
      agentId: `chat-${this.engineRunId}`,
      runId: this.engineRunId,
      runDir: this.engineRunDir,
      babelRoot: process.env['BABEL_ROOT'] ?? process.cwd(),
      signal: this.abortController.signal,
      projectRoot: this.options.projectRoot,
      sessionId: this.engineRunId,
      ...(this.parity.turnId ? { turnId: this.parity.turnId } : {}),
    };
    // Order-preserving batches (only consecutive reads may parallelize).
    const batches = planToolBatches(
      orderChatToolActions(
        actions.map((a) => ({
          type: a.type,
          ...(a.type === 'sub_agent' ? { mutation: (a as { mutation?: boolean }).mutation } : {}),
        })),
      ),
    );

    const allResults: Awaited<ReturnType<typeof this.executeOneAction>>[] = [];
    let stopTerminal = false;
    for (const batch of batches) {
      if (this._cancelled || this.abortController.signal.aborted || stopTerminal) break;
      if (batch.kind === 'parallel_reads') {
        const containsSubAgent = batch.indices.some((index) => actions[index]?.type === 'sub_agent');
        if (containsSubAgent) {
          for (const index of batch.indices) {
            if (this._cancelled || this.abortController.signal.aborted || stopTerminal) break;
            const result = await this.executeOneAction(actions[index]!, toolContext, callbacks, {
              index,
              idempotencyKey:
                this._streamNativeToolCallIds[index] ?? `tool_call_${this._turnIndex}_${index}`,
            });
            allResults.push(result);
            if (result.stop) stopTerminal = true;
          }
          continue;
        }
        for (let c = 0; c < batch.indices.length; c += MAX_TOOL_CONCURRENCY) {
          if (this._cancelled || this.abortController.signal.aborted) break;
          const chunk = batch.indices.slice(c, c + MAX_TOOL_CONCURRENCY);
          allResults.push(
            ...(await Promise.all(
              chunk.map((index) =>
                this.executeOneAction(actions[index]!, toolContext, callbacks, {
                  index,
                  idempotencyKey:
                    this._streamNativeToolCallIds[index] ?? `tool_call_${this._turnIndex}_${index}`,
                }),
              ),
            )),
          );
        }
      } else {
        const result = await this.executeOneAction(actions[batch.index]!, toolContext, callbacks, {
          index: batch.index,
          idempotencyKey:
            this._streamNativeToolCallIds[batch.index] ??
            `tool_call_${this._turnIndex}_${batch.index}`,
        });
        allResults.push(result);
        if (result.stop || isCircuitBreakerObservation(result.observation)) stopTerminal = true;
      }
    }

    allResults.sort((a, b) => a.index - b.index);
    // Align one observation slot per requested action index (empty if skipped).
    const observationList = actions.map((_, i) => {
      const hit = allResults.find((r) => r.index === i);
      return hit?.observation ?? '';
    });
    return {
      observations: allResults
        .map((r) => r.observation)
        .filter(Boolean)
        .join('\n\n'),
      observationList,
      count: allResults.length,
    };
  }

  /** Persist tool_started immediately before the policy-gated executor performs the effect. */
  private persistToolStartedAtExecutorDispatch(
    action: ChatToolAction,
    meta: { index: number; idempotencyKey?: string },
  ): void {
    const idempotencyKey =
      meta.idempotencyKey ??
      this._streamNativeToolCallIds[meta.index] ??
      `tool_call_${this._turnIndex}_${meta.index}`;
    paritySettleToolStarted(
      this.parity,
      {
        id: idempotencyKey,
        name: chatActionToolName(action),
        action_index: meta.index,
        ...(this._activeToolBatchId ? { batch_id: this._activeToolBatchId } : {}),
        target_summary: chatActionTarget(action),
      },
      this.engineRunDir,
    );
  }

  private settleInheritedBudgetRejectedChild(
    action: ChatToolAction,
    meta: { index: number; idempotencyKey?: string },
    callbacks: ChatCallbacks,
    toolId: number,
    subId: string,
    reason: string,
    limiter?: ChildBudgetLimiter,
  ): { index: number; observation: string; stop: true } {
    // S03/T04: a wall/cost rejection is not a round exhaustion.
    const attribution = childBudgetAttribution(limiter);
    const idempotencyKey =
      meta.idempotencyKey ??
      this._streamNativeToolCallIds[meta.index] ??
      `tool_call_${this._turnIndex}_${meta.index}`;
    paritySettleToolNotStarted(
      this.parity,
      {
        id: idempotencyKey,
        name: chatActionToolName(action),
        action_index: meta.index,
        ...(this._activeToolBatchId ? { batch_id: this._activeToolBatchId } : {}),
        target_summary: chatActionTarget(action),
      },
      this.engineRunDir,
      reason,
    );
    const detail = `failed, attribution=${attribution}: ${reason}`;
    this.toolCallLog.push({
      tool: chatActionToolName(action),
      target: chatActionTarget(action),
      detail,
      error: reason,
      index: meta.index,
      exit_code: 1,
      effect_status: 'indeterminate',
    });
    callbacks.onToolComplete?.(toolId, detail, reason, 1);
    callbacks.onSubAgentFailed?.({ id: subId, error: reason });
    return {
      index: meta.index,
      observation: `### sub_agent ${subId}\nstatus: failed\nattribution: ${attribution}\n${reason}`,
      stop: true,
    };
  }

  /** Block a fresh tool-call id from replaying an equivalent unknown external/non-idempotent effect. */
  /**
   * S03/#213 slice 2: bind child identity to the parent operation/delegation
   * (parent run + turn + batch + action index + operation fingerprint), not a
   * batch-local display counter that resets on every `executeActions` call.
   * Two successive batches therefore get distinct ids; a re-dispatch of the
   * same admitted delegation keeps its base id.
   */
  private childDelegationIdForAction(action: ChatToolAction, meta: { index: number }): string {
    const turnId = String(this.parity.turnId ?? this._turnIndex);
    const batchId =
      this._activeToolBatchId ?? `batch_${this._turnIndex}_${this._turnToolCallLogStart}`;
    return deriveChildDelegationId({
      parentRunId: this.engineRunId,
      turnId,
      batchId,
      actionIndex: meta.index,
      fingerprint: operationFingerprint(chatActionToolName(action), action),
    });
  }

  private recoveredOperationDispatchAuthorization(action: ChatToolAction): {
    allowed: boolean;
    message?: string;
  } {
    const fingerprint = operationFingerprint(chatActionToolName(action), action);
    if (!requiresRecoveredOutcomeReconciliation(this.parity.sessionEvents, fingerprint))
      return { allowed: true };
    return {
      allowed: false,
      message:
        'Equivalent recovered effect has TOOL_OUTCOME_UNKNOWN; inspect/reconcile its state, then require an explicit durable reconciliation authorization before retrying this fingerprint.',
    };
  }

  /**
   * Explicit controller/operator path to authorize retry after inspection of one
   * prior unknown outcome. The opaque audit reference is persisted before retry.
   */
  public authorizeRecoveredOutcomeRetry(
    action: ChatToolAction,
    recoveredIdempotencyKey: string,
    reconciliationRef: string,
  ): void {
    const fingerprint = operationFingerprint(chatActionToolName(action), action);
    if (
      !requiresRecoveredOutcomeReconciliation(
        this.parity.sessionEvents,
        fingerprint,
        recoveredIdempotencyKey,
      )
    ) {
      throw new Error(
        'No matching unreconciled TOOL_OUTCOME_UNKNOWN effect exists for this authorization.',
      );
    }
    parityAuthorizeRecoveredOutcomeRetry(
      this.parity,
      {
        recoveredIdempotencyKey,
        operationFingerprint: fingerprint,
        reconciliationRef,
      },
      this.engineRunDir,
    );
  }

  private async executeOneAction(
    action: ChatToolAction,
    toolContext: ToolContext,
    callbacks: ChatCallbacks,
    meta: { index: number; idempotencyKey?: string },
  ): Promise<{ index: number; observation: string; stop?: boolean }> {
    const tool = chatActionToolName(action);
    const target = chatActionTarget(action);
    const toolId = callbacks.onToolStart?.(tool, target) ?? -1;
    const restoreProjectRoot = pinProjectRootEnv(this.options.projectRoot);
    const toolStart = performance.now();

    try {
      // Plan-then-execute + optional phase tool gates (before side effects)
      const isMutationSubAgent =
        action.type === 'sub_agent' && (action as { mutation?: boolean }).mutation === true;
      // Implementor W1.3: hard plan mode (mutations blocked until /execute-plan).
      const hardPlanGate = deniesReadOnlyChatAction(action.type) ? { blocked: true, observation: 'Read-only chat policy denied this tool; use only read_file/read_range/list_dir/grep/glob inspection.' } : evaluateHardPlanModeGate({
        toolName: tool,
        hardPlanMode: this.hardPlanMode,
        isMutationSubAgent,
      });
      if (hardPlanGate.blocked) {
        this.policyEventLog.record({
          at_turn: this._turnIndex,
          kind: 'plan_gate_block',
          detail: 'hard-plan-mode',
          tool,
        });
        this.toolCallLog.push({
          tool,
          target,
          detail: 'hard-plan-mode',
          error: 'blocked',
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(toolId, 'hard-plan-mode', 'blocked', 1);
        return {
          index: meta.index,
          observation: hardPlanGate.observation ?? '',
        };
      }
      const planGate = evaluatePlanThenExecuteGate({
        toolName: tool,
        requirePlan: this.requireTodoBeforeMutate,
        todoCount: this.todos.size,
        isMutationSubAgent,
      });
      if (planGate.blocked) {
        this.toolCallLog.push({
          tool,
          target,
          detail: 'plan-gate',
          error: 'blocked',
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(toolId, 'plan-gate', 'blocked', 1);
        return { index: meta.index, observation: planGate.observation ?? '' };
      }
      const phaseGate = evaluatePhaseToolGate({
        toolName: tool,
        phase: this._lastPhase,
        isMutationSubAgent,
      });
      if (phaseGate.blocked) {
        this.policyEventLog.record({
          at_turn: this._turnIndex,
          kind: 'phase_gate_block',
          detail: `phase=${this._lastPhase ?? 'null'}`,
          tool,
        });
        this.toolCallLog.push({
          tool,
          target,
          detail: 'phase-gate',
          error: 'blocked',
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(toolId, 'phase-gate', 'blocked', 1);
        return { index: meta.index, observation: phaseGate.observation ?? '' };
      }

      const recoveredAuthorization = this.recoveredOperationDispatchAuthorization(action);
      if (!recoveredAuthorization.allowed) {
        const detail = `[RECOVERY_RECONCILIATION_REQUIRED] ${recoveredAuthorization.message ?? 'Reconcile the prior unknown effect before retrying'}`;
        this.toolCallLog.push({
          tool,
          target,
          detail,
          error: 'blocked',
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(toolId, 'reconciliation-required', 'blocked', 1);
        return {
          index: meta.index,
          observation: `### ${tool} ${target}\nexit_code: 1\n\`\`\`\n${detail}\n\`\`\``,
        };
      }

      if (action.type === 'sub_agent') {
        // S03/#213 slice 2: stable delegation id + per-attempt evidence dir.
        //
        // M7 (open, disclosed): this makes retry *identity* stable and prevents
        // the retry from overwriting attempt-1 evidence, but it does NOT yet
        // replay a terminal idempotency key instead of re-running the child.
        // The recon's full T05 dedupe gate remains unimplemented; the existing
        // recovered-outcome authorization gate (above) still blocks unknown
        // outcomes until reconciliation.
        const subId = this.childDelegationIdForAction(action, meta);
        const attempt = (this.childAttempts.get(subId) ?? 0) + 1;
        this.childAttempts.set(subId, attempt);
        const childRunDir = childAttemptDir(this.engineRunDir, subId, attempt);
        // S03/#213 slice 1: resolve ONE effective child spec. Every declared
        // option is honored, rejected, or clamped with a reason; the runtime
        // receipts and the advertised schema both derive from these semantics.
        const spec = resolveChildSpec({
          mutation: (action as { mutation?: boolean }).mutation === true,
          writeScope: (action as { write_scope?: string[] }).write_scope ?? [],
          instructions: (action as { instructions?: string }).instructions ?? null,
          model: (action as { model?: string }).model ?? null,
          maxRounds: (action as { max_rounds?: number }).max_rounds ?? null,
          parentModel: this.modelPolicy?.providerModelId ?? null,
        });
        const mutationEnabled = spec.mutation;
        const writeScope = spec.writeScope;
        const specReceipt = formatChildSpecReceipt(spec);

        // #11: Fork an isolated ToolContext with a child AbortController.
        // Cancelling the parent cascades; cancelling a sibling does not.
        const childController = new AbortController();
        const onParentAbort = () => childController.abort();
        this.abortController.signal.addEventListener('abort', onParentAbort, {
          once: true,
        });
        const mutationAllowance = mutationEnabled
          ? this.deriveChildAllowance(spec.effectiveRounds)
          : null;
        if (mutationAllowance) {
          const inheritedLimiter = inheritedChildBudgetLimiter(mutationAllowance);
          if (inheritedLimiter) {
            const reason = `child was not started: inherited ${inheritedLimiter} allowance already exhausted`;
            this.markChildBudgetExhausted(inheritedLimiter, reason);
            const rejected = this.settleInheritedBudgetRejectedChild(
              action,
              meta,
              callbacks,
              toolId,
              subId,
              reason,
              inheritedLimiter,
            );
            this.abortController.signal.removeEventListener('abort', onParentAbort);
            return rejected;
          }
        }

        // Subagent approval session cannot exceed parent permission ceiling
        const parentApproval = getChatApprovalSession();
        const childCeiling = mutationEnabled
          ? (['shell', 'write', 'other'] as const)
          : (['other'] as const);
        const childApproval = deriveSubagentApprovalSession(parentApproval, subId, [
          ...childCeiling,
        ]);
        const restoreApproval = () => bindChatApprovalSession(parentApproval);
        bindChatApprovalSession(childApproval);

        // Mutation sub-agent path (W2.1: git worktree + write_scope allowlist)
        if (mutationEnabled) {
          callbacks.onSubAgentStart?.({
            id: subId,
            label: action.task.slice(0, 60),
          });
          try {
            // Prefer implement-worktree isolation when write_scope is declared.
            // Empty write_scope still routes through the legacy in-tree loop so
            // read-only mutation attempts get the existing "no write scope" error.
            const useWorktree =
              writeScope.length > 0 && process.env['BABEL_IMPLEMENT_WORKTREE'] !== '0';
            if (useWorktree) {
              this.persistToolStartedAtExecutorDispatch(action, meta);
              const implResult = await runImplementWorktreeAgent(
                {
                  id: subId,
                  task: action.task,
                  writeScope,
                  maxRounds: spec.effectiveRounds,
                  ...(spec.resolvedModel ? { model: spec.resolvedModel } : {}),
                  ...(spec.instructions ? { instructions: spec.instructions } : {}),
                },
                {
                  projectRoot: this.options.projectRoot,
                  runDir: childRunDir,
                  abortSignal: childController.signal,
                  cleanupWorktree: false,
                  toolContext: {
                    signal: childController.signal,
                  },
                  ...(mutationAllowance ? { inheritedAllowance: mutationAllowance } : {}),
                  onUsageRecorded: () => this.persistTaskCostBaseline(),
                },
              );
              if (implResult.inheritedBudgetExceeded && implResult.inheritedBudgetLimiter) {
                this.markChildBudgetExhausted(
                  implResult.inheritedBudgetLimiter,
                  implResult.error ?? 'child inherited allowance exhausted',
                );
              }
              const attribution: SubagentAttribution = implResult.attribution;
              const clean = subagentFinishedCleanly(attribution);
              const details = clean
                ? `${implResult.stepsExecuted} steps, ${implResult.changedFiles.length} changed, attribution=${attribution} (worktree ${implResult.worktree.name})`
                : `failed: ${implResult.error || 'unknown error'}, attribution=${attribution}`;
              this.toolCallLog.push({
                tool,
                target,
                detail: details,
                index: meta.index,
                exit_code: clean ? 0 : 1,
                ...(clean ? {} : { error: implResult.error || attribution }),
                ...(implResult.changedFiles.length > 0
                  ? {
                      effect_status: 'confirmed_change' as const,
                      mutation_paths: implResult.changedFiles.map((file) => file.path),
                    }
                  : clean
                    ? { effect_status: 'confirmed_no_change' as const }
                    : { effect_status: 'indeterminate' as const }),
              });
              callbacks?.onToolComplete?.(
                toolId,
                details,
                clean ? undefined : implResult.error || attribution,
                clean ? 0 : 1,
              );
              if (clean) {
                callbacks.onSubAgentComplete?.({ id: subId, summary: details });
              } else {
                callbacks.onSubAgentFailed?.({
                  id: subId,
                  error: implResult.error || attribution,
                });
              }
              const findings = [
                `### sub_agent ${subId}: ${action.task}`,
                `status: ${clean ? (attribution === 'child_noop' ? 'noop' : 'success') : 'failed'}`,
                `attribution: ${attribution}`,
                `isolation: git_worktree`,
                `child_spec: ${specReceipt}`,
                `worktree: ${implResult.worktree.path}`,
                `write_scope: ${implResult.writeScope.join(', ') || '(none)'}`,
                `parent_tree_clean: ${implResult.parentTreeClean}`,
                `steps: ${implResult.stepsExecuted}`,
                `changed_files: ${implResult.changedFiles.map((f) => f.path).join(', ') || 'none'}`,
                implResult.summary,
              ].join('\n');
              return {
                index: meta.index,
                observation: findings,
                ...(implResult.inheritedBudgetExceeded ? { stop: true } : {}),
              };
            }

            this.persistToolStartedAtExecutorDispatch(action, meta);
            const mutResult = await runMutationAgentLoop({
              agentId: subId,
              task: action.task,
              projectRoot: this.options.projectRoot,
              writeScope,
              ...(this.options.workspaceRoot ? { workspaceRoot: this.options.workspaceRoot } : {}),
              toolContext: {
                agentId: subId,
                runId: this.engineRunId,
                runDir: childRunDir,
                babelRoot: process.env['BABEL_ROOT'] ?? process.cwd(),
                signal: childController.signal,
              },
              maxRounds: spec.effectiveRounds,
              abortSignal: childController.signal,
              runDir: childRunDir,
              ...(mutationAllowance ? { inheritedAllowance: mutationAllowance } : {}),
              onUsageRecorded: () => this.persistTaskCostBaseline(),
              ...(spec.resolvedModel ? { model: spec.resolvedModel } : {}),
              ...(spec.instructions ? { additionalInstructions: spec.instructions } : {}),
            });
            const attribution: SubagentAttribution = mutResult.attribution;
            const clean = subagentFinishedCleanly(attribution);
            const details = clean
              ? `${mutResult.stepsExecuted} steps, ${mutResult.changedFiles.length} changed, attribution=${attribution}`
              : `failed: ${mutResult.error || 'unknown error'}, attribution=${attribution}`;
            this.toolCallLog.push({
              tool,
              target,
              detail: details,
              index: meta.index,
              exit_code: clean ? 0 : 1,
              ...(clean ? {} : { error: mutResult.error || attribution }),
              ...(mutResult.changedFiles.length > 0
                ? {
                    effect_status: 'confirmed_change' as const,
                    mutation_paths: mutResult.changedFiles.map((file) => file.path),
                  }
                : clean
                  ? { effect_status: 'confirmed_no_change' as const }
                : { effect_status: 'indeterminate' as const }),
            });
            if (mutResult.inheritedBudgetExceeded && mutResult.inheritedBudgetLimiter) {
              this.markChildBudgetExhausted(
                mutResult.inheritedBudgetLimiter,
                mutResult.error ?? 'child inherited allowance exhausted',
              );
            }
            callbacks?.onToolComplete?.(
              toolId,
              details,
              clean ? undefined : mutResult.error || attribution,
              clean ? 0 : 1,
            );
            if (clean) {
              callbacks.onSubAgentComplete?.({ id: subId, summary: details });
            } else {
              callbacks.onSubAgentFailed?.({
                id: subId,
                error: mutResult.error || attribution,
              });
            }
            const findings = [
              `### sub_agent ${subId}: ${action.task}`,
              `status: ${clean ? (attribution === 'child_noop' ? 'noop' : 'success') : 'failed'}`,
              `attribution: ${attribution}`,
              `child_spec: ${specReceipt}`,
              `steps: ${mutResult.stepsExecuted}`,
              `changed_files: ${mutResult.changedFiles.map((f) => f.path).join(', ') || 'none'}`,
              mutResult.summary,
            ].join('\n');
            return {
              index: meta.index,
              observation: findings,
              ...(mutResult.inheritedBudgetExceeded ? { stop: true } : {}),
            };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const attribution = classifySubagentFailure({
              success: false,
              error: errMsg,
              changedFilesCount: 0,
              aborted: childController.signal.aborted,
            });
            this.toolCallLog.push({
              tool,
              target,
              detail: `failed, attribution=${attribution}`,
              error: 'error',
              index: meta.index,
              exit_code: 1,
            });
            callbacks?.onToolComplete?.(toolId, `failed, attribution=${attribution}`, errMsg, 1);
            callbacks.onSubAgentFailed?.({ id: subId, error: errMsg });
            return {
              index: meta.index,
              observation: `### sub_agent ${subId}: ${action.task}\nattribution: ${attribution}\nError: ${errMsg}`,
            };
          } finally {
            restoreApproval();
            this.abortController.signal.removeEventListener('abort', onParentAbort);
          }
        }

        // Read-only sub-agent path (existing)
        callbacks.onSubAgentStart?.({
          id: subId,
          label: action.task.slice(0, 60),
        });
        try {
          // S03: use the one resolved spec (bounds/defaults live in childSpec).
          const childRounds = spec.effectiveRounds;
          const readAllowance = this.deriveChildAllowance(childRounds);
          const readInheritedLimiter = inheritedChildBudgetLimiter(readAllowance);
          if (readInheritedLimiter) {
            const reason = `child was not started: inherited ${readInheritedLimiter} allowance already exhausted`;
            this.markChildBudgetExhausted(readInheritedLimiter, reason);
            const rejected = this.settleInheritedBudgetRejectedChild(
              action,
              meta,
              callbacks,
              toolId,
              subId,
              reason,
              readInheritedLimiter,
            );
            this.abortController.signal.removeEventListener('abort', onParentAbort);
            return rejected;
          }
          this.persistToolStartedAtExecutorDispatch(action, meta);
          const subResult = await runReadOnlyAgentLoop({
            verb: 'ask',
            task: action.task,
            projectRoot: this.options.projectRoot,
            seedPaths: [],
            toolContext: {
              agentId: subId,
              runId: this.engineRunId,
              runDir: childRunDir,
              babelRoot: process.env['BABEL_ROOT'] ?? process.cwd(),
              signal: childController.signal,
            },
            maxRounds: childRounds,
            preset: 'read_only',
            abortSignal: childController.signal,
            ...(spec.resolvedModel ? { model: spec.resolvedModel } : {}),
            ...(spec.instructions ? { additionalInstructions: spec.instructions } : {}),
            inheritedAllowance: readAllowance,
            onUsageRecorded: () => this.persistTaskCostBaseline(),
          } as any);
          const attribution: SubagentAttribution = subResult.needsApproval || subResult.policyBlocked
            ? 'child_policy_block'
            : subResult.inheritedBudgetExceeded
              ? childBudgetAttribution(subResult.inheritedBudgetLimiter)
            : subResult.providerError
              ? classifySubagentFailure({
                  success: false,
                  error: subResult.providerError,
                  changedFilesCount: 0,
                  aborted: childController.signal.aborted,
                })
            : subResult.roundExhausted
              ? 'child_round_exhaustion'
              : childController.signal.aborted
                ? 'child_cancellation'
                : subResult.completed
                  ? 'child_noop'
                  : classifySubagentFailure({
                      success: false,
                      error: subResult.blockedReason,
                      changedFilesCount: 0,
                    });
          const clean = subagentFinishedCleanly(attribution);
          const details = `${subResult.stepsExecuted} steps, 0 changed, attribution=${attribution}`;
          // S02/#212: one bounded child result (conclusion + structured status
          // + evidence refs). Child-reported only; never completion authority.
          const childResult = buildReadOnlyChildResult({
            steps: subResult.steps,
            toolCallLog: subResult.toolCallLog,
            observations: subResult.observations,
            stepsExecuted: subResult.stepsExecuted,
            degraded: subResult.degraded,
            completed: subResult.completed,
            roundExhausted: subResult.roundExhausted,
            policyBlocked: subResult.policyBlocked,
            ...(subResult.needsApproval !== undefined
              ? { needsApproval: subResult.needsApproval }
              : {}),
            ...(subResult.providerError !== undefined
              ? { providerError: subResult.providerError }
              : {}),
            ...(subResult.inheritedBudgetExceeded !== undefined
              ? { inheritedBudgetExceeded: subResult.inheritedBudgetExceeded }
              : {}),
            ...(subResult.blockedReason !== undefined
              ? { blockedReason: subResult.blockedReason }
              : {}),
            ...(subResult.roundsExecuted !== undefined
              ? { roundsExecuted: subResult.roundsExecuted }
              : {}),
            lane: 'ask',
            childId: subId,
            maxRounds: childRounds,
            cancelled: childController.signal.aborted,
          });
          const childSection = renderReadOnlyChildResultSection(childResult);
          const findings = [
            formatSubAgentFindings(subId, action.task, {
              observations: subResult.observations,
              stepsExecuted: subResult.stepsExecuted,
              degraded: subResult.degraded,
              childResult,
            }),
            `attribution: ${attribution}`,
            `child_spec: ${specReceipt}`,
            `completed: ${subResult.completed}`,
            `round_exhausted: ${subResult.roundExhausted}`,
            ...(subResult.needsApproval ? ['needs_approval: true'] : []),
            ...(subResult.providerError ? [`provider_error: ${subResult.providerError}`] : []),
          ].join('\n');
          this.toolCallLog.push({
            tool,
            target,
            detail: details,
            index: meta.index,
            exit_code: clean ? 0 : 1,
            ...(clean ? {} : { error: subResult.blockedReason || attribution }),
            // S02: the text-tools path surfaces the bounded handoff via stdout;
            // `detail` stays untouched for gate/critic consumers. Note: this
            // also makes recordTurnToolObservability capture the child section
            // in observationTails (previously no tail existed for this row); it
            // is diagnostic only and is not re-injected as authority.
            stdout: childSection,
          });
          callbacks?.onToolComplete?.(
            toolId,
            details,
            clean ? undefined : subResult.blockedReason || attribution,
            clean ? 0 : 1,
          );
          if (clean) {
            callbacks.onSubAgentComplete?.({
              id: subId,
              summary: details,
            });
          } else {
            callbacks.onSubAgentFailed?.({
              id: subId,
              error: subResult.blockedReason || attribution,
            });
          }
          if (subResult.inheritedBudgetExceeded && subResult.inheritedBudgetLimiter) {
            this.markChildBudgetExhausted(
              subResult.inheritedBudgetLimiter,
              subResult.blockedReason ?? 'child inherited allowance exhausted',
            );
          }
          return {
            index: meta.index,
            observation: findings,
            ...(subResult.inheritedBudgetExceeded ? { stop: true } : {}),
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const attribution = classifySubagentFailure({
            success: false,
            error: errMsg,
            changedFilesCount: 0,
            aborted: childController.signal.aborted,
          });
          this.toolCallLog.push({
            tool,
            target,
            detail: `failed, attribution=${attribution}`,
            error: 'error',
            index: meta.index,
            exit_code: 1,
          });
          callbacks?.onToolComplete?.(toolId, `failed, attribution=${attribution}`, errMsg, 1);
          callbacks.onSubAgentFailed?.({ id: subId, error: errMsg });
          return {
            index: meta.index,
            observation: `### sub_agent ${subId}: ${action.task}\nattribution: ${attribution}\nError: ${errMsg}`,
          };
        } finally {
          restoreApproval();
          this.abortController.signal.removeEventListener('abort', onParentAbort);
        }
      }

      if (isMcpChatAction(action)) {
        if (remoteMcpIsFailClosed()) {
          const detail = remoteMcpFailClosedObservation(action.server);
          this.toolCallLog.push({
            tool,
            target,
            detail,
            index: meta.index,
            exit_code: 1,
          });
          callbacks?.onToolComplete?.(toolId, detail, detail, 1);
          return {
            index: meta.index,
            observation: formatChatToolObservation(action, {
              stdout: '',
              stderr: detail,
              exitCode: 1,
            }),
          };
        }
        // Local TUI: MCP calls execute without approval prompts in chat mode.
        // Safety is provided by the execution sandbox and circuit breaker,
        // not by blocking the model mid-flow. Remote does not inherit this bypass.
        const mcpResult = await executeTool(mapChatMcpActionToToolRequest(action), {
          ...toolContext,
          onBeforeDispatch: () => this.persistToolStartedAtExecutorDispatch(action, meta),
        });
        const detail = mcpResult.exit_code === 0 ? 'ok' : `exit ${mcpResult.exit_code ?? -1}`;
        this.toolCallLog.push({
          tool,
          target,
          detail,
          index: meta.index,
          exit_code: mcpResult.exit_code,
          stdout: mcpResult.stdout,
          stderr: mcpResult.stderr,
        });
        callbacks?.onToolComplete?.(
          toolId,
          detail,
          mcpResult.exit_code === 0 ? undefined : mcpResult.stderr || detail,
          mcpResult.exit_code ?? 0,
        );
        return {
          index: meta.index,
          observation: formatChatToolObservation(action, {
            stdout: mcpResult.stdout,
            stderr: mcpResult.stderr,
            exitCode: mcpResult.exit_code,
          }),
        };
      }

      if (action.type === 'web_search' || action.type === 'web_fetch') {
        const webResult = await executeTool(mapChatWebActionToToolRequest(action), {
          ...toolContext,
          onBeforeDispatch: () => this.persistToolStartedAtExecutorDispatch(action, meta),
        });
        const detail =
          webResult.exit_code === 0
            ? formatResultDetail(action, webResult)
            : `exit ${webResult.exit_code ?? -1}`;
        this.toolCallLog.push({
          tool,
          target,
          detail,
          index: meta.index,
          exit_code: webResult.exit_code,
          ...(webResult.exit_code !== 0 ? { error: 'failed' as const } : {}),
        });
        callbacks?.onToolComplete?.(
          toolId,
          detail,
          webResult.exit_code === 0 ? undefined : webResult.stderr || detail,
          webResult.exit_code ?? 0,
        );
        return {
          index: meta.index,
          observation: formatChatToolObservation(action, {
            stdout: webResult.stdout,
            stderr: webResult.stderr,
            exitCode: webResult.exit_code,
          }),
        };
      }

      // Gap-1: LSP tool — read-only code intelligence via localTools executor.
      if (action.type === 'lsp') {
        const lsp = await executeLspChatToolAction({
          action,
          toolContext: {
            ...toolContext,
            onBeforeDispatch: () => this.persistToolStartedAtExecutorDispatch(action, meta),
          },
          executeTool,
        });
        this.toolCallLog.push({
          tool,
          target,
          detail: lsp.detail,
          index: meta.index,
          ...(lsp.exit_code !== undefined ? { exit_code: lsp.exit_code } : {}),
          ...(lsp.stdout !== undefined ? { stdout: lsp.stdout } : {}),
          ...(lsp.stderr !== undefined ? { stderr: lsp.stderr } : {}),
          ...(lsp.failed ? { error: 'failed' as const } : {}),
        });
        callbacks?.onToolComplete?.(
          toolId,
          lsp.detail,
          lsp.failed ? lsp.stderr || 'failed' : undefined,
          lsp.exit_code ?? (lsp.failed ? 1 : 0),
        );
        return { index: meta.index, observation: lsp.observation };
      }

      if (action.type === 'finish') {
        this.toolCallLog.push({
          tool,
          target,
          detail: 'done',
          index: meta.index,
          exit_code: 0,
        });
        callbacks?.onToolComplete?.(toolId, 'done', undefined, 0);
        return { index: meta.index, observation: '' };
      }

      // ── B2: Read dedupe cache — skip read_file if file unchanged ─────
      // Path-normalized keys so absolute/relative variants share one slot.
      let fileReadCacheHash: string | undefined;
      if (action.type === 'read_file') {
        if (isReadOnlyChat()) resolveChatRangePath(this.options.projectRoot, action.path);
        const pathKey = this.readCacheKey(action.path);
        const maxFull = getChatTaskTune(this.taskClass).maxFullReadsPerFile;
        const priorFull = this.fullReadCounts.get(pathKey) ?? 0;
        if (
          shouldSkipFullReread({
            fullReadCount: priorFull,
            maxFullReads: maxFull,
          })
        ) {
          this.dedupeHitCount++;
          this.noteToolForReadThrash(tool);
          this.toolCallLog.push({
            tool,
            target,
            detail: 'read_limit',
            index: meta.index,
            exit_code: 0,
          });
          callbacks?.onToolComplete?.(toolId, 'read_limit', undefined, 0);
          return {
            index: meta.index,
            observation: buildFullRereadSkipObservation(target, priorFull, maxFull),
          };
        }
        fileReadCacheHash = await this.hashFilePath(action.path);
        const fullDecision = decideReadInjection({
          pathKey,
          fileHash: fileReadCacheHash,
          request: { kind: 'full' },
          cache: this.readCache,
          contextEpoch: this.readContextEpoch,
        });
        if (fullDecision.skip) {
          const cached = this.readCache.get(fullDecision.cacheKey);
          const secs = cached ? Math.round((Date.now() - cached.timestamp) / 1000) : 0;
          this.dedupeHitCount++;
          this.noteToolForReadThrash(tool);
          this.toolCallLog.push({
            tool,
            target,
            detail: 'cached',
            index: meta.index,
            exit_code: 0,
          });
          callbacks?.onToolComplete?.(toolId, 'cached', undefined, 0);
          return {
            index: meta.index,
            observation:
              `### ${tool} ${target}\nexit_code: 0\n\`\`\`\n` +
              `File ${target} unchanged since last identical full read (${secs}s ago). Skipping re-injection.\n\`\`\``,
          };
        }
      }

      // ── str_replace via governed mutation path (policy/checkpoint/cache) ──
      if (action.type === 'str_replace') {
        const classC = resolveClassCGateDecision({
          executionProfile: this.executionProfile,
        });
        const gov = await governedStrReplace(
          {
            file_path: action.file_path,
            old_str: action.old_str,
            new_str: action.new_str,
          },
          {
            projectRoot: this.options.projectRoot,
            context: toolContext,
            preset: 'workspace_write',
            executor: defaultToolExecutor,
            onDispatchAuthorized: () => recoveredAuthorization,
            onBeforeExecutorExecute: () => this.persistToolStartedAtExecutorDispatch(action, meta),
            ...(this.parity.authoritySession
              ? { authoritySession: this.parity.authoritySession }
              : {}),
            ...(classC === 'allow' ? { onAskApproval: async () => true } : {}),
          },
        );

        if (gov.mutationPaths && gov.mutationPaths.length > 0) {
          recordMutationBatch(this.parity.sessionEvents, this.parity.turnId ?? 'unknown', {
            paths: gov.mutationPaths,
            pre_hash: Object.values(gov.preBatchHash ?? {}).join(','),
            post_hash: Object.values(gov.postBatchHash ?? {}).join(','),
            ...(gov.mutationReceipt
              ? {
                  batch_id: gov.mutationReceipt.batchId,
                  starting_revision: gov.mutationReceipt.startingRevision,
                  ...(gov.mutationReceipt.endingRevision
                    ? { ending_revision: gov.mutationReceipt.endingRevision }
                    : {}),
                  changed_bytes: gov.mutationReceipt.changedBytes,
                  status: gov.mutationReceipt.status,
                  pre_image_hashes: gov.mutationReceipt.preImageHashes,
                  post_image_hashes: gov.mutationReceipt.postImageHashes,
                }
              : {}),
          });
        }

        const strReplaceEffect = assessMutationEffect({
          tool: 'str_replace',
          error: gov.error,
          exitCode: gov.exit_code,
          policyBlocked: gov.policyBlocked,
          mutationPaths: gov.mutationPaths,
          mutationReceipt: gov.mutationReceipt,
          effectTransaction: gov.effectTransaction,
        });

        if (gov.exit_code !== 0) {
          // Process failure does not erase an independently proven workspace
          // effect.  Invalidate reads conservatively for every attempted target
          // and project confirmed changes while preserving the failed outcome.
          const effectPaths =
            gov.mutationPaths && gov.mutationPaths.length > 0
              ? gov.mutationPaths
              : [gov.absolutePath];
          for (const effectPath of effectPaths) {
            const effectKey = this.readCacheKey(effectPath);
            invalidateReadCacheForPath(this.readCache, effectKey);
            this.fullReadCounts.delete(effectKey);
          }
          if (strReplaceEffect.status === 'indeterminate') {
            invalidateVerifierLedger(this as never, strReplaceEffect.reason);
          }
          if (strReplaceEffect.status === 'confirmed_change') {
            this.workingState = applyWorkingStateEvent(this.workingState, {
              type: 'mutation',
              path: gov.absolutePath,
            });
            noteChatWorkspaceMutation(this as never);
            callbacks?.onFileChanged?.(
              gov.absolutePath,
              (action.new_str.match(/\n/g) ?? []).length,
              (action.old_str.match(/\n/g) ?? []).length,
            );
            appendPatchRecovery(
              this.patchRecoveryPath ?? '',
              'str_replace',
              action.file_path,
              `old=${action.old_str.slice(0, 200)}\nnew=${action.new_str.slice(0, 200)}`,
            );
          }
          this.toolCallLog.push({
            tool,
            target,
            detail: 'error',
            error: gov.error ?? 'str_replace failed',
            index: meta.index,
            exit_code: gov.exit_code,
            effect_status: strReplaceEffect.status,
            ...(gov.mutationPaths ? { mutation_paths: [...gov.mutationPaths] } : {}),
          });
          callbacks?.onToolComplete?.(
            toolId,
            gov.policyBlocked ? 'blocked' : 'error',
            gov.error ?? (gov.policyBlocked ? 'blocked' : 'error'),
            gov.exit_code,
          );
          return { index: meta.index, observation: gov.observation };
        }
        if (strReplaceEffect.status !== 'confirmed_change') {
          invalidateReadCacheForPath(this.readCache, this.readCacheKey(gov.absolutePath));
          this.fullReadCounts.delete(this.readCacheKey(gov.absolutePath));
          if (strReplaceEffect.status === 'indeterminate') {
            invalidateVerifierLedger(this as never, strReplaceEffect.reason);
          }
          this.toolCallLog.push({
            tool,
            target,
            detail: `effect: ${strReplaceEffect.status}`,
            index: meta.index,
            exit_code: 0,
            effect_status: strReplaceEffect.status,
          });
          callbacks?.onToolComplete?.(
            toolId,
            `effect: ${strReplaceEffect.status}`,
            undefined,
            0,
          );
          return {
            index: meta.index,
            observation: `${gov.observation}\n\nEffect: ${strReplaceEffect.status} (${strReplaceEffect.reason}).`,
          };
        }
        invalidateReadCacheForPath(this.readCache, this.readCacheKey(gov.absolutePath));
        this.fullReadCounts.delete(this.readCacheKey(gov.absolutePath));
        this.workingState = applyWorkingStateEvent(this.workingState, {
          type: 'mutation',
          path: gov.absolutePath,
        });
        noteChatWorkspaceMutation(this as never);
        const lineNumber = gov.lineNumber ?? 0;
        this.toolCallLog.push({
          tool,
          target,
          detail: `line ${lineNumber}`,
          index: meta.index,
          exit_code: 0,
          effect_status: strReplaceEffect.status,
          ...(gov.mutationPaths && gov.mutationPaths.length > 0
            ? { mutation_paths: [...gov.mutationPaths] }
            : {}),
        });
        callbacks?.onToolComplete?.(toolId, `line ${lineNumber}`, undefined, 0);
        callbacks.onFileChanged?.(
          gov.absolutePath,
          (action.new_str.match(/\n/g) ?? []).length,
          (action.old_str.match(/\n/g) ?? []).length,
        );
        let strObs = gov.observation;
        const staticResult = await this.runPostEditStaticCheck(gov.absolutePath);
        if (staticResult) strObs += `\n\n### static_check ${target}\n${staticResult}`;
        const tamperWarning = this.checkVerifierTamper(gov.absolutePath);
        if (tamperWarning) strObs += `\n\n### verifier_integrity\n${tamperWarning}`;
        appendPatchRecovery(
          this.patchRecoveryPath ?? '',
          'str_replace',
          action.file_path,
          `old=${action.old_str.slice(0, 200)}\nnew=${action.new_str.slice(0, 200)}`,
        );
        return { index: meta.index, observation: strObs };
      }

      // ── B1: read_range — read specific lines ────────────────────────
      if (action.type === 'read_range') {
        const rPath = resolveChatRangePath(this.options.projectRoot, action.file_path);
        const rContent = await readFile(rPath, 'utf-8');
        const rHash = this.hashContent(rContent);
        const rKey = this.readCacheKey(rPath);
        // read_range does not bump fullReadCounts (line windows allowed)
        this.noteToolForReadThrash(tool);
        const evaluated = evaluateReadRequest({
          pathKey: rKey,
          fileHash: rHash,
          content: rContent,
          request: {
            kind: 'range',
            startLine: action.start_line,
            endLine: action.end_line,
          },
          cache: this.readCache,
          contextEpoch: this.readContextEpoch,
        });
        if (
          evaluated.window.lines.length === 0 &&
          action.start_line > evaluated.window.totalLines
        ) {
          this.toolCallLog.push({
            tool,
            target,
            detail: 'error',
            error: 'start_line out of range',
            index: meta.index,
            exit_code: 1,
          });
          callbacks?.onToolComplete?.(toolId, 'error', 'start_line out of range', 1);
          return {
            index: meta.index,
            observation: `### read_range ${target}\nError: start_line (${action.start_line}) exceeds file length (${evaluated.window.totalLines})`,
          };
        }
        this.toolCallLog.push({
          tool,
          target,
          detail: `${evaluated.window.lines.length} lines`,
          index: meta.index,
          exit_code: 0,
        });
        callbacks?.onToolComplete?.(toolId, `${evaluated.window.lines.length} lines`, undefined, 0);
        return {
          index: meta.index,
          observation: formatReadObservation('read_range', target, evaluated.window),
        };
      }

      // ── B1: todo_write — merge-patch task list ─────────────────────
      if (action.type === 'todo_write') {
        for (const item of action.todos) {
          this.todos.set(item.id, {
            content: item.content,
            status: item.status,
          });
        }
        const formattedTodos = [...this.todos.entries()]
          .map(([id, t]) => `- [${t.status}] ${t.content} (${id})`)
          .join('\n');
        this.toolCallLog.push({
          tool,
          target,
          detail: `${this.todos.size} todos`,
          index: meta.index,
          exit_code: 0,
        });
        callbacks?.onToolComplete?.(toolId, `${this.todos.size} todos`, undefined, 0);
        return {
          index: meta.index,
          observation: `### todo_write\nexit_code: 0\n\`\`\`\n${formattedTodos}\n\`\`\``,
        };
      }

      // Background shell — handlers in chatBackgroundShell.ts (size ratchet)
      if (action.type === 'await_command') {
        return executeAwaitCommandAction(action, {
          projectRoot: this.options.projectRoot,
          tool,
          target,
          toolId,
          index: meta.index,
          pushLog: (entry) => this.toolCallLog.push(entry),
          onToolComplete: callbacks.onToolComplete,
          onBeforeAwait: () => this.persistToolStartedAtExecutorDispatch(action, meta),
        });
      }
      if (action.type === 'run_command' && action.background === true) {
        return executeBackgroundRunCommandAction(action, {
          projectRoot: this.options.projectRoot,
          tool,
          target,
          toolId,
          index: meta.index,
          ownerId: this.engineRunId,
          toolCallId: meta.idempotencyKey,
          pushLog: (entry) => this.toolCallLog.push(entry),
          onToolComplete: callbacks.onToolComplete,
          onBeforeSpawn: () => this.persistToolStartedAtExecutorDispatch(action, meta),
        });
      }

      // Capability check: reject recursive shell enumeration if shell.recursive_enumeration is DEGRADED/UNAVAILABLE
      if ('command' in action && typeof action.command === 'string') {
        const classification = classifyShellCapability(action.type, action.command);
        if (classification.isRecursiveEnum) {
          const capState = this.progressController.getCapabilityState(
            'shell.recursive_enumeration',
          );
          if (capState === 'DEGRADED' || capState === 'UNAVAILABLE') {
            const observation = `### ${tool} ${target}\nexit_code: 1\n\`\`\`\n[BABEL ADVISORY] Recursive shell command suppressed: shell.recursive_enumeration is DEGRADED due to repeated failures. Use the list_dir / directory_list tool instead for reliable filesystem inspection.\n\`\`\``;
            this.toolCallLog.push({
              tool,
              target,
              detail: 'degraded_suppressed',
              index: meta.index,
              exit_code: 1,
              error: 'capability_degraded',
            });
            callbacks?.onToolComplete?.(toolId, 'degraded_suppressed', 'capability_degraded', 1);
            return { index: meta.index, observation };
          }
        }
      }

      // Platform fail-fast: never re-exec a command that hard-crashed (A06 thrash).
      if (
        (action.type === 'run_command' || action.type === 'test_run') &&
        target &&
        this.platformUnusableVerifiers.has(target)
      ) {
        const prior = this.verifierReceiptCache.get(target)?.receipt.exit_code ?? 3221225794;
        return logPlatformUnusableResult({
          toolCallLog: this.toolCallLog,
          tool,
          target,
          exitCode: prior,
          meta,
          toolId,
          callbacks,
        });
      }

      // R8: Verifier run dedup — if the same verifier command was already run
      // and no writes have occurred since, return the cached receipt instead
      // of re-executing. This collapses repeated identical verifier runs.
      // Fatal Windows exits are not soft-cached: mark unusable and fail-fast.
      if ((action.type === 'run_command' || action.type === 'test_run') && target) {
        const cachedVerifier = this.verifierReceiptCache.get(target);
        if (cachedVerifier && cachedVerifier.writeCountAtCache === this.writeCount) {
          if (isFatalWindowsProcessExit(cachedVerifier.receipt.exit_code)) {
            this.platformUnusableVerifiers.add(target);
            return logPlatformUnusableResult({
              toolCallLog: this.toolCallLog,
              tool,
              target,
              exitCode: cachedVerifier.receipt.exit_code,
              meta,
              toolId,
              callbacks,
            });
          }
          this.dedupeHitCount++;
          this.toolCallLog.push({
            tool,
            target,
            detail: `cached receipt (exit ${cachedVerifier.receipt.exit_code})`,
            index: meta.index,
            exit_code: cachedVerifier.receipt.exit_code,
            stdout: cachedVerifier.receipt.summary,
          });
          callbacks?.onToolComplete?.(
            toolId,
            `cached (exit ${cachedVerifier.receipt.exit_code})`,
            cachedVerifier.receipt.exit_code === 0 ? undefined : 'verifier failed',
            cachedVerifier.receipt.exit_code,
          );
          return {
            index: meta.index,
            observation:
              `### ${tool} ${target}\nexit_code: ${cachedVerifier.receipt.exit_code}\n\`\`\`\n` +
              `Verifier result unchanged — no file writes since last run.\n` +
              `${cachedVerifier.receipt.summary}\n\`\`\``,
          };
        }
      }

      // Standard tool execution via policy gate
      const agentAction = mapChatActionToAgentAction(action);
      const classC = resolveClassCGateDecision({
        executionProfile: this.executionProfile,
      });
      const result: PolicyGatedExecutionResult = await executeActionWithPolicy(
        agentAction,
        // workspace_write = mutations auto-execute without user approval.
        // Network-touching commands (curl, npm install) are still hard-denied.
        // Future evolutions:
        //   B — new 'auto' preset that allows everything (no approval, no denial)
        //   C — BABEL_ALLOW_NETWORK_COMMANDS=1 env flag for graduated autonomy
        this.executionProfile === 'plan' || process.env['BABEL_READ_ONLY'] === 'true' || process.env['BABEL_EXECUTION_PROFILE'] === 'read_only_audit' ? 'read_only' : 'workspace_write',
        toolContext,
        {
          executor: defaultToolExecutor,
          mode:
            this.executionProfile === 'plan'
              ? 'plan'
              : this.executionProfile === 'deep'
                ? 'deep'
                : 'chat',
          completedIdempotencyKeys: this.getLiveSession().tools.completed_idempotency_keys,
          idempotencyKey:
            meta.idempotencyKey ??
            this._streamNativeToolCallIds[meta.index] ??
            `tool_call_${this._turnIndex}_${meta.index}`,
          ...(this.parity.liveAuthority?.taskContract.contract_id
            ? { taskId: this.parity.liveAuthority.taskContract.contract_id }
            : {}),
          ...(this.parity.liveAuthority?.taskContract.protected_paths
            ? {
                protectedPaths: this.parity.liveAuthority.taskContract.protected_paths,
              }
            : {}),
          ...(this.parity.authoritySession
            ? { authoritySession: this.parity.authoritySession }
            : {}),
          onDispatchAuthorized: () => this.recoveredOperationDispatchAuthorization(action),
          onBeforeExecutorExecute: () => this.persistToolStartedAtExecutorDispatch(action, meta),
          // Privileged ops: lease/PDP decides. Benchmark pair is the only
          // remaining auto-approve exception. TTY is not authority.
          ...this.isolationBrokerFlags(),
          ...(classC === 'allow' ? { onAskApproval: async () => true } : {}),
        },
      );

      if (result.mutationPaths && result.mutationPaths.length > 0) {
        recordMutationBatch(this.parity.sessionEvents, this.parity.turnId ?? 'unknown', {
          paths: result.mutationPaths,
          pre_hash: Object.values(result.preBatchHash ?? {}).join(','),
          post_hash: Object.values(result.postBatchHash ?? {}).join(','),
          ...(result.mutationReceipt
            ? {
                batch_id: result.mutationReceipt.batchId,
                starting_revision: result.mutationReceipt.startingRevision,
                ...(result.mutationReceipt.endingRevision
                  ? { ending_revision: result.mutationReceipt.endingRevision }
                  : {}),
                changed_bytes: result.mutationReceipt.changedBytes,
                status: result.mutationReceipt.status,
                pre_image_hashes: result.mutationReceipt.preImageHashes,
                post_image_hashes: result.mutationReceipt.postImageHashes,
              }
            : {}),
        });
      }

      const obsParts: string[] = [];
      for (const r of result.results) {
        if (action.type === 'read_file') {
          if (r.exit_code === 0) {
            const window = selectReadWindow(r.stdout ?? '', { kind: 'full' });
            obsParts.push(formatReadObservation('read_file', target, window));
          } else {
            obsParts.push(
              formatReadFailureObservation({
                tool: 'read_file',
                target,
                exitCode: r.exit_code,
                stdout: r.stdout,
                stderr: r.stderr,
                toolCallId: String(toolId),
                spillDir: this.engineRunDir,
              }),
            );
          }
        } else {
          obsParts.push(
            formatChatToolObservation(
              action,
              {
                stdout: r.stdout,
                stderr: r.stderr,
                exitCode: r.exit_code,
              },
              { spillDir: this.engineRunDir, toolCallId: String(toolId) },
            ),
          );
        }
      }

      const lastResult = result.results[result.results.length - 1];
      if (lastResult) {
        if (
          lastResult.exit_code !== 0 ||
          (lastResult.stdout.trim() === '' && lastResult.stderr.trim() !== '')
        ) {
          const rec = this.progressController.recordFailure({
            tool: action.type,
            commandSnippet:
              'command' in action && typeof action.command === 'string'
                ? action.command
                : undefined,
            exitCode: lastResult.exit_code,
            emptyStdout: lastResult.stdout.trim() === '',
          });
          if (rec.notice) {
            obsParts.push(`\n[BABEL ADVISORY] ${rec.notice}`);
          }
        } else if (lastResult.exit_code === 0) {
          this.progressController.recordSuccess('tool.' + action.type);
          const cmd =
            'command' in action && typeof action.command === 'string' ? action.command : undefined;
          const classification = classifyShellCapability(action.type, cmd);
          if (classification.isRecursiveEnum) {
            this.progressController.recordSuccess('shell.recursive_enumeration');
          }
        }
      }

      const detail = lastResult
        ? lastResult.exit_code === 0
          ? formatResultDetail(action, lastResult)
          : `exit ${lastResult.exit_code}`
        : 'done';

      const directMutationAction =
        action.type === 'write_file' || action.type === 'apply_patch';
      const toolError = result.policyBlocked
        ? 'blocked'
        : lastResult && lastResult.exit_code !== 0
          ? lastResult.stderr || detail
          : undefined;
      const mutationEffect = assessMutationEffect({
        tool,
        error: toolError,
        exitCode: lastResult?.exit_code,
        policyBlocked: result.policyBlocked,
        mutationPaths: result.mutationPaths,
        mutationReceipt: result.mutationReceipt,
        effectTransaction: result.effectTransaction,
      });
      const confirmedDirectMutation =
        directMutationAction &&
        mutationEffect.status === 'confirmed_change';

      // A direct mutation may have reached the executor without a confirmed
      // committed receipt (including a failed/partial effect). Refresh reads
      // conservatively, but do not count or project it as a confirmed write.
      if (directMutationAction && !result.policyBlocked && lastResult) {
        const possiblePaths =
          result.mutationPaths && result.mutationPaths.length > 0
            ? result.mutationPaths
            : [
                action.type === 'write_file'
                  ? action.path
                  : primaryPatchPath(action.patch),
              ];
        for (const possiblePath of possiblePaths) {
          const possibleKey = this.readCacheKey(possiblePath);
          invalidateReadCacheForPath(this.readCache, possibleKey);
          this.fullReadCounts.delete(possibleKey);
        }
        if (!confirmedDirectMutation) {
          invalidateVerifierLedger(this as never, 'direct mutation effect not confirmed');
        }
      }

      // Keep apply_patch's user-facing projection tied to the executor's
      // actual path instead of the patch-text target summary.
      const projectedTarget =
        action.type === 'apply_patch' && result.mutationPaths?.[0]
          ? result.mutationPaths[0]
          : target;

      // Log tool call for structured result metadata
      this.toolCallLog.push({
        tool,
        target: projectedTarget,
        detail,
        index: meta.index,
        ...(lastResult
          ? {
              exit_code: lastResult.exit_code,
              stdout: lastResult.stdout,
              stderr: lastResult.stderr,
            }
          : {}),
        ...(toolError ? { error: toolError } : {}),
        ...(result.mutationPaths && result.mutationPaths.length > 0
          ? { mutation_paths: [...result.mutationPaths] }
          : {}),
        ...(mutationEffect.status !== 'not_applicable'
          ? { effect_status: mutationEffect.status }
          : {}),
      });

      if (result.policyBlocked) {
        callbacks?.onToolComplete?.(toolId, 'blocked', 'blocked', 1);
      } else {
        const hasErr = lastResult && lastResult.exit_code !== 0;
        callbacks?.onToolComplete?.(
          toolId,
          detail,
          hasErr ? lastResult?.stderr || 'failed' : undefined,
          lastResult?.exit_code ?? 0,
        );

        if (action.type === 'write_file' && confirmedDirectMutation) {
          const diff = renderGitDiff(
            { tool: 'file_write', path: action.path, content: action.content },
            toolContext,
          );
          const adds = (diff.match(/^\+[^+]/gm) ?? []).length;
          const dels = (diff.match(/^-[^-]/gm) ?? []).length;
          callbacks.onFileChanged?.(action.path, adds, dels, diff);
          this.fullReadCounts.delete(this.readCacheKey(action.path));
          this.workingState = applyWorkingStateEvent(this.workingState, {
            type: 'mutation',
            path: action.path,
          });
          noteChatWorkspaceMutation(this as never);
          // Crash-safe: persist patch to recovery log
          appendPatchRecovery(
            this.patchRecoveryPath ?? '',
            'write_file',
            action.path,
            action.content,
          );
        } else if (action.type === 'apply_patch' && confirmedDirectMutation) {
          const { adds, dels } = countPatchStats(action.patch);
          const path = primaryPatchPath(action.patch);
          callbacks.onFileChanged?.(path, adds, dels, action.patch);
          this.workingState = applyWorkingStateEvent(this.workingState, {
            type: 'mutation',
            path,
          });
          noteChatWorkspaceMutation(this as never);
          // Crash-safe: persist patch to recovery log
          appendPatchRecovery(this.patchRecoveryPath ?? '', 'apply_patch', path, action.patch);
        }

        // A shell action that reports confirmed mutation paths is a real write and
        // must account exactly once before verifier receipt capture. A successful
        // shell action without paths is indeterminate and only invalidates prior
        // verifier evidence.
        if ((action.type === 'run_command' || action.type === 'test_run') && lastResult) {
          const confirmedShellMutation = mutationEffect.status === 'confirmed_change';
          if (confirmedShellMutation) {
            noteChatWorkspaceMutation(this as never);
          }

          // B1/B2: only authoritative verifier commands update the completion receipt.
          if (isFatalWindowsProcessExit(lastResult.exit_code) && target) {
            this.platformUnusableVerifiers.add(target);
          }
          const receipt = await captureAndRecordVerifierReceipt({
            projectRoot: this.options.projectRoot,
            command: target,
            exitCode: lastResult.exit_code,
            summary: formatVerifierReceiptSummary({
              verifierId: target,
              command: target,
              exitCode: lastResult.exit_code,
              stdout: lastResult.stdout,
              stderr: lastResult.stderr,
            }),
            mutationPaths: mutationPathsFromSessionEvents(this.parity.sessionEvents.events),
            sessionEvents: this.parity.sessionEvents,
            turnId: String(this.parity.turnId ?? this._turnIndex),
            ledger: this.executedVerifierLedger,
            cache: this.verifierReceiptCache,
            writeCount: this.writeCount,
            toolCallId:
              meta.idempotencyKey ??
              this._streamNativeToolCallIds[meta.index] ??
              `tool_call_${this._turnIndex}_${meta.index}`,
          });
          if (receipt) {
            this.lastVerifierReceipt = receipt;
            const ingested = ingestVerifierResult({
              state: this.workingState,
              tool: action.type,
              target,
              exitCode: lastResult.exit_code,
              stdout: lastResult.stdout,
              stderr: lastResult.stderr,
              summary: receipt.summary ?? String(lastResult.exit_code),
            });
            this.workingState = ingested.state;
            this.lastVerifierFailed = ingested.lastVerifierFailed;
          } else if (lastResult.exit_code === 0 && !confirmedShellMutation) {
            invalidateVerifierLedger(this as never, 'non-verifier shell command executed');
          }

          // A command can mutate files and then fail. Prefer the executor's
          // changed-path receipt; without one, invalidate conservatively.
          if (!result.policyBlocked) {
            if (result.mutationPaths && result.mutationPaths.length > 0) {
              for (const changedPath of result.mutationPaths) {
                const changedKey = this.readCacheKey(changedPath);
                invalidateReadCacheForPath(this.readCache, changedKey);
                this.fullReadCounts.delete(changedKey);
              }
            } else {
              this.readCache.clear();
              this.fullReadCounts.clear();
            }
          }
        }

        // B2: Update read cache after successful read_file execution
        if (
          action.type === 'read_file' &&
          lastResult &&
          lastResult.exit_code === 0 &&
          fileReadCacheHash
        ) {
          const pathKey = this.readCacheKey(action.path);
          rememberFullReadWindow(
            this.readCache,
            pathKey,
            fileReadCacheHash,
            lastResult.stdout ?? '',
            this.readContextEpoch,
          );
          this.fullReadCounts.set(pathKey, (this.fullReadCounts.get(pathKey) ?? 0) + 1);
          this.noteToolForReadThrash(tool);
        } else if (
          action.type === 'grep' ||
          action.type === 'glob' ||
          action.type === 'list_dir' ||
          action.type === 'semantic_search'
        ) {
          this.noteToolForReadThrash(tool);
        }
      }

      // R3a: Post-edit static check after successful write/apply_patch
      if (
        (action.type === 'write_file' || action.type === 'apply_patch') &&
        !result.policyBlocked &&
        lastResult?.exit_code === 0
      ) {
        const editPath =
          action.type === 'write_file'
            ? (action as any).path
            : primaryPatchPath((action as any).patch);
        if (editPath) {
          const staticResult = await this.runPostEditStaticCheck(editPath);
          if (staticResult) {
            obsParts.push(`### static_check ${editPath}\n${staticResult}`);
          }
          // R9: Check for verifier tampering — warn if a verifier dependency was modified
          const tamperWarning = this.checkVerifierTamper(editPath);
          if (tamperWarning) {
            obsParts.push(`### verifier_integrity\n${tamperWarning}`);
          }
        }
      }

      return { index: meta.index, observation: obsParts.join('\n') };
    } catch (err) {
      this.toolCallLog.push({
        tool,
        target,
        detail: 'error',
        error: 'error',
        index: meta.index,
        exit_code: 1,
      });
      callbacks?.onToolComplete?.(
        toolId,
        'error',
        err instanceof Error ? err.message : String(err),
        1,
      );
      return {
        index: meta.index,
        observation: `### ${tool} ${target}\nError: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      const toolEnd = performance.now();
      const lastEntry = this.toolCallLog[this.toolCallLog.length - 1];
      const success =
        !lastEntry?.error && (lastEntry?.exit_code === 0 || lastEntry?.exit_code === undefined);
      this.currentTurnTelemetry?.recordToolSpan(
        tool,
        target,
        Math.max(0, toolEnd - toolStart),
        success,
        toolStart,
        toolEnd,
      );
      restoreProjectRoot();
    }
  }

  /**
   * Build tool result feedback in text-tools format for small local models.
   * Returns simple [OK]/[RESULT]/[ERROR] text that the model can parse on
   * the next turn instead of a role:tool message it does not understand.
   */
  private buildTextToolResults(startIndex: number): string {
    return formatTextToolResults(this.toolCallLog.slice(startIndex));
  }

  private async runPostEditStaticCheck(filePath: string): Promise<string | null> {
    return runPostEditStaticCheckFn(filePath, this.options.projectRoot);
  }

  /**
   * R4: Generate a compact repository map for model orientation.
   * Lists top-level directories, key config files, and build/test commands.
   */
  private async generateRepoMap(): Promise<string> {
    return buildRepoMapPreamble(this.options.projectRoot);
  }

  /**
   * Synthesize the final natural-language answer from investigation results.
   * Uses executeRaw for streaming raw text — no JSON extraction, no Zod validation.
   */
  private async synthesizeAnswer(
    toolObservations: string,
    callbacks: ChatCallbacks,
  ): Promise<string> {
    const prompt = buildAnswerSynthesisPrompt({
      conversation: this.conversation,
      task: this.options.task,
      toolObservations,
    });

    // Lazily resolve and cache the synthesis runner — model/policy is stable
    // across the engine's lifetime. Uses same fallback logic as deliberation.
    if (!this.synthesisRunner) {
      const provider = this.modelPolicy?.provider;
      const modelId = this.modelPolicy?.providerModelId;
      const offline = isOfflineChatMode();
      if (provider === 'ollama' && modelId) {
        if (!offline)
          throw new Error('[LIVE_MODEL_POLICY] Ollama is not a valid live chat provider.');
        try {
          this.synthesisRunner = new OllamaApiRunner(modelId);
        } catch {
          this.synthesisRunner = new DeepInfraApiRunner(resolveFallbackModelId());
        }
      } else if (provider === 'deepseek' && modelId) {
        if (!offline) {
          throw new Error(
            '[LIVE_MODEL_POLICY] Direct DeepSeek live calls are disabled; use the OpenRouter DeepSeek control route.',
          );
        }
        try {
          this.synthesisRunner = new DeepSeekApiRunner(modelId);
        } catch {
          if (!offline)
            throw new Error(
              'Cannot start live chat synthesis: DeepSeek runner is unavailable. Set DEEPSEEK_API_KEY in your environment.',
            );
          this.synthesisRunner = new DeepInfraApiRunner(resolveFallbackModelId());
        }
      } else if (provider === 'opencode' && modelId) {
        this.synthesisRunner = new OpenCodeApiRunner(modelId);
      } else if (provider === 'openrouter' && modelId) {
        try {
          this.synthesisRunner = new OpenRouterApiRunner(modelId);
        } catch {
          throw new Error(
            'Cannot start live chat synthesis: OpenRouter runner is unavailable. Set OPENROUTER_API_KEY in your environment.',
          );
        }
      } else if (modelId) {
        if (!offline) {
          assertLiveModelId(modelId, 'live chat synthesis');
          const routedModel = resolveOpenRouterDeepSeekModelId(modelId);
          if (!routedModel) {
            throw new Error(
              '[LIVE_MODEL_POLICY] Live chat synthesis requires an OpenRouter-approved model route.',
            );
          }
          this.synthesisRunner = new OpenRouterApiRunner(routedModel);
        } else {
          this.synthesisRunner = new DeepInfraApiRunner(modelId);
        }
      } else {
        this.synthesisRunner = offline
          ? new DeepInfraApiRunner(resolveFallbackModelId())
          : new OpenRouterApiRunner(LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0]);
      }
    }

    const runnerCallbacks: RunnerCallbacks | undefined = callbacks.onAnswerChunk
      ? {
          ...this.providerRetryCallbacks({
            deliveryMode: 'text',
            conversationState: prompt,
            executionStage: 'synthesis',
          }),
          onChunk: callbacks.onAnswerChunk,
          ...(callbacks.onThought ? { onThought: callbacks.onThought } : {}),
        }
      : this.providerRetryCallbacks({
          deliveryMode: 'text',
          conversationState: prompt,
          executionStage: 'synthesis',
        });
    const answer = await this.executeWithTimeout(this.synthesisRunner, prompt, runnerCallbacks);
    this.trackRunnerUsage(this.synthesisRunner);
    return answer;
  }

  /** Record token usage from a runner invocation into the global cost tracker.
   *  #12: Also accumulates API-reported token counts for accurate estimation. */
  private trackRunnerUsage(
    runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | OpenRouterApiRunner,
  ): void {
    const metadata = runner.getLastInvocationMetadata?.();
    if (
      metadata?.provider_model_id &&
      metadata.prompt_tokens !== null &&
      metadata.completion_tokens !== null
    ) {
      this.lastRequestPromptTokens = metadata.prompt_tokens;
      this.lastRequestCompletionTokens = metadata.completion_tokens;
      this.lastRequestModelId = metadata.provider_model_id;
      globalCostTracker.trackUsage(
        metadata.provider_model_id,
        metadata.prompt_tokens,
        metadata.completion_tokens,
        metadata.prompt_cache_hit_tokens,
        metadata.prompt_cache_miss_tokens,
        this.taskAllowance
          ? {
              taskOwnerId: this.taskAllowance.taskOwnerId,
              chargeId: this.pendingUsageChargeId ?? randomUUID(),
            }
          : undefined,
      );
      this.pendingUsageChargeId = null;
      // Checkpoint usage immediately after accounting so a crash before the
      // enclosing turn result is persisted cannot mint a fresh continuation
      // allowance on resume.
      this.persistTaskCostBaseline();

      // Feed token history tracker
      const tokenTracker = getGlobalTokenTracker();
      tokenTracker.record({
        inputTokens: metadata.prompt_tokens,
        outputTokens: metadata.completion_tokens,
        cost: metadata.estimated_cost_usd ?? 0,
        modelId: metadata.provider_model_id,
      });

      // #12: Track cumulative API-reported tokens for accurate compaction estimates
      this.apiTokenCount += metadata.prompt_tokens + metadata.completion_tokens;

      // Tier A3: Push per-turn routing receipt
      pushRoutingReceiptFromMetadata(
        this.routingReceiptLog,
        this._turnIndex,
        this._lastPhase,
        metadata,
      );
    }
  }

  /** H1 compaction: delegates to runChatEngineCompaction (atomic commit path). */
  private async compactIfNeeded(
    callbacks?: ChatCallbacks,
    forceCompaction = false,
  ): Promise<ContextCompactedInfo | null> {
    const host: import('./compactionCommit.js').ChatEngineCompactionHost = {
      conversation: this.conversation,
      options: this.options,
      ...(this.modelPolicy ? { modelPolicy: this.modelPolicy } : {}),
      limits: this.limits,
      abortSignal: this.abortController.signal,
      writeCount: this.writeCount,
      turnIndex: this._turnIndex,
      toolCallLog: this.toolCallLog,
      ...(this.lastVerifierReceipt ? { lastVerifierReceipt: this.lastVerifierReceipt } : {}),
      progress: this.parity.progress,
      threadLog: this.parity.eventLog,
      sessionLog: this.parity.sessionEvents,
      turnId: this.parity.turnId,
      providerCallbacks: this.providerRetryCallbacks({
        deliveryMode: this.shouldUseTextTools() ? 'text' : 'native',
        executionStage: 'compaction',
      }),
      shouldUseTextTools: () => this.shouldUseTextTools(),
      compactHeuristic: () => {
        this.compactConversation();
        host.conversation = this.conversation;
      },
      checkpoint: async () => {
        const receipt = await checkpointParityEventLogStrict(this.parity, this.engineRunDir);
        if (receipt.status !== 'committed') {
          throw new Error(receipt.error ?? 'checkpoint persistence blocked');
        }
      },
      reserveTokens: DEFAULT_COMPACTION_CONFIG.reserveTokens,
      textToolsReserve: 1024,
      forceCompaction,
      resolveModel: resolveCompactionModelId,
      shouldCompactByTokens: parityShouldCompact,
      estimateTokens,
    };
    if (this.compactionManager) host.compactionManager = this.compactionManager;
    const result = await runChatEngineCompaction(host);
    this.conversation = host.conversation;
    if (!result) return null;
    if (this.lastLogicalRequestId !== null) {
      this.pendingParentRequestId = this.lastLogicalRequestId;
    }
    // A compaction changes which facts are retained by the model. Any prior
    // read injection may be absent from the new context even when file bytes
    // are unchanged, so force explicit reacquisition on the next request.
    this.resetReadInjectionContext();
    const info: ContextCompactedInfo = {
      mode: result.mode,
      beforeMessages: result.beforeMessages,
      afterMessages: result.afterMessages,
      message: result.message,
    };
    if (this.shouldUseTextTools()) {
      console.error(
        `[compaction] text-tools: ${info.beforeMessages}→${info.afterMessages} msgs (${info.mode}), token estimate was ~${this.apiTokenCount}`,
      );
    }
    callbacks?.onContextCompacted?.(info);
    return info;
  }

  /** Rebuild one over-limit final request after a durable, bounded compaction. */
  private async recoverPreparedRequestAdmission(
    error: unknown,
  ): Promise<ContextCompactedInfo | null> {
    if (!(error instanceof PreparedRequestAdmissionError)) return null;
    if (this.preparedAdmissionCompactionAttempts >= 1) return null;
    this.preparedAdmissionCompactionAttempts += 1;
    this.pendingParentRequestId = error.request.request_id;
    return this.compactIfNeeded(undefined, true);
  }

  private compactConversation(): void {
    const state = {
      conversation: this.conversation,
      toolCallLog: this.toolCallLog,
      lastVerifierReceipt: this.lastVerifierReceipt,
      todosSize: this.todos.size,
      lastPhase: this._lastPhase,
      apiTokenCount: this.apiTokenCount,
      maxConversationMessages: this.limits.maxConversationMessages,
      maxEstimatedTokens: this.limits.maxEstimatedTokens,
      compactionConsecutiveFailures: this.compactionConsecutiveFailures,
      maxCompactionFailures: ChatEngine.MAX_COMPACTION_FAILURES,
      summarizeDroppedTurns: (d: ChatMessage[]) => this.summarizeDroppedTurns(d),
    };
    compactHeuristicConversation(state);
    this.conversation = state.conversation;
    this.apiTokenCount = state.apiTokenCount;
    this.compactionConsecutiveFailures = state.compactionConsecutiveFailures;
  }

  private summarizeDroppedTurns(dropped: ChatMessage[]): string {
    return summarizeDroppedTurnsFn(dropped);
  }

  /**
   * Lenient chat-turn parser that never throws. Unlike the strict
   * parseChatTurn() in chatToolDefinitions.ts, this gracefully degrades
   * when the model returns prose, malformed JSON, or an empty response —
   * treating everything as a natural-language completion.
   */
  private parseChatTurnLenient(rawText: string): ChatTurn {
    try {
      const parsed = extractJson(rawText);
      const result = ChatTurnSchema.safeParse(parsed);
      if (result.success) return result.data;
      // JSON found but schema mismatch — could be a close miss.
      // If it has an "answer" field, treat it as completion directly.
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>)['answer'] === 'string'
      ) {
        return {
          type: 'completion',
          answer: (parsed as Record<string, unknown>)['answer'] as string,
        };
      }
    } catch {
      // No parseable JSON — model responded in prose. That's fine.
    }
    // Fallback: treat the entire raw response as a natural-language answer.
    const answer = rawText.trim();
    if (answer.length === 0) {
      return {
        type: 'completion',
        answer: 'I could not produce a valid response. Please try rephrasing your request.',
      };
    }
    return { type: 'completion', answer };
  }

  /** Lazily resolve the deliberation runner from modelPolicy.
   *  When no model is configured, uses the policy default tier instead of
   *  a hardcoded fallback. Surfaces missing-API-key errors with clear
   *  diagnostics and falls back across providers when possible. */
  private resolveDeliberationRunner(): DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner {
    if (!this.deliberationRunner) {
      const provider = this.modelPolicy?.provider;
      const modelId = this.modelPolicy?.providerModelId;
      if (provider === 'ollama' && modelId) {
        try {
          this.deliberationRunner = new OllamaApiRunner(modelId);
        } catch (err) {
          throw new Error(
            `Cannot start chat: Ollama runner failed to initialize.\n` +
              `  ${err instanceof Error ? err.message : String(err)}\n` +
              `  Is Ollama running? Start it with: ollama serve\n` +
              `  Then pull a model: ollama pull gemma3:4b`,
          );
        }
      } else if (provider === 'deepseek' && modelId) {
        if (!isOfflineChatMode()) {
          throw new Error(
            '[LIVE_MODEL_POLICY] Direct DeepSeek live calls are disabled; use the OpenRouter DeepSeek control route.',
          );
        }
        try {
          this.deliberationRunner = new DeepSeekApiRunner(modelId);
        } catch (err) {
          if (!isOfflineChatMode()) {
            throw new Error(
              'Cannot start live chat: DeepSeek runner is unavailable. ' +
                'Set DEEPSEEK_API_KEY in your environment.',
            );
          }
          // Fall back to DeepSeek Flash if v4 Pro is unavailable
          try {
            this.deliberationRunner = new DeepSeekApiRunner('deepseek-v4-flash');
          } catch (fallbackErr) {
            throw new Error(
              `Cannot start chat: DeepSeek runner failed to initialize.\n` +
                `  v4 Pro: ${err instanceof Error ? err.message : String(err)}\n` +
                `  v4 Flash: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}\n` +
                `  Set DEEPSEEK_API_KEY in your environment.\n` +
                `  Use /model to see available providers.`,
            );
          }
        }
      } else if (provider === 'opencode' && modelId) {
        // OpenCode Zen (e.g. ox-alpha-free): explicit backend-key opt-in.
        try {
          this.deliberationRunner = new OpenCodeApiRunner(modelId);
        } catch (err) {
          throw new Error(
            `Cannot start chat: OpenCode runner failed to initialize.\n` +
              `  ${err instanceof Error ? err.message : String(err)}\n` +
              `  Set OPENCODE_API_KEY in your environment.\n` +
              `  Use /model to see available providers.`,
          );
        }
      } else if (provider === 'openrouter' && modelId) {
        try {
          this.deliberationRunner = new OpenRouterApiRunner(modelId);
        } catch (err) {
          throw new Error(
            `Cannot start chat: OpenRouter runner failed to initialize.\n` +
              `  ${err instanceof Error ? err.message : String(err)}\n` +
              `  Set OPENROUTER_API_KEY in your environment.\n` +
              `  Use /model to see available models.`,
          );
        }
      } else if (modelId) {
        const offline = isOfflineChatMode();
        if (!offline) {
          assertLiveModelId(modelId, 'live chat');
          const routedModel = resolveOpenRouterDeepSeekModelId(modelId);
          if (!routedModel) {
            throw new Error(
              '[LIVE_MODEL_POLICY] Live chat requires an OpenRouter-approved model route.',
            );
          }
          this.deliberationRunner = new OpenRouterApiRunner(routedModel);
          return this.deliberationRunner;
        }
        try {
          this.deliberationRunner = offline
            ? new DeepInfraApiRunner(modelId)
            : new DeepSeekApiRunner(modelId);
        } catch (err) {
          throw new Error(
            `Cannot start chat: ${offline ? 'DeepInfra' : 'DeepSeek'} runner failed to initialize.\n  ${err instanceof Error ? err.message : String(err)}\n  Set ${offline ? 'DEEPINFRA_API_KEY' : 'DEEPSEEK_API_KEY'} in your environment.\n  Use /model to see available providers.`,
          );
        }
      } else {
        // No model configured — resolve from policy default tier.
        const fallbackId = resolveFallbackModelId();
        try {
          this.deliberationRunner = isOfflineChatMode()
            ? new DeepSeekApiRunner(fallbackId)
            : new OpenRouterApiRunner(LIVE_OPENROUTER_DEEPSEEK_MODEL_IDS[0]);
        } catch {
          if (!isOfflineChatMode()) {
            throw new Error(
              'Cannot start live chat: OpenRouter DeepSeek runner is unavailable. Set OPENROUTER_API_KEY in your environment.',
            );
          }
          try {
            this.deliberationRunner = new DeepInfraApiRunner(fallbackId);
          } catch (err) {
            throw new Error(
              `Cannot start chat: no LLM runner is available.\n` +
                `  ${err instanceof Error ? err.message : String(err)}\n` +
                `  Set DEEPSEEK_API_KEY in your environment.\n` +
                `  Use /model to see available providers.`,
            );
          }
        }
      }
    }
    return this.deliberationRunner;
  }

  /**
   * Execute a runner call with a per-turn deadline. If the deadline expires,
   * the shared AbortController is signalled so the HTTP fetch is cancelled
   * and the Promise.race rejects with a descriptive error.
   */
  /** Persist provider retry facts without exposing provider payloads in durable state. */
  private providerRetryCallbacks(context: {
    deliveryMode?: ContextDeliveryMode;
    conversationState?: unknown;
    systemPolicyPrompt?: unknown;
    userTaskPrompt?: unknown;
    toolSchema?: unknown;
    promptInputTokenCount?: number | null;
    contextTruncated?: boolean | null;
    expectedPriorEventIds?: readonly string[];
    deliveredPriorEventIds?: readonly string[];
    executionStage?: ModelRouteStage;
    contractRef?: string;
    substitutionOrFallback?: boolean;
  } = {}): RunnerCallbacks {
    let startedInvocation: ProviderInvocationStarted | null = null;
    let retryCount = 0;
    const parentRequestId =
      this.pendingParentRequestId ??
      (context.substitutionOrFallback && this.lastLogicalRequestId !== null
        ? this.lastLogicalRequestId
        : null);
    return {
      parentRequestId,
      onInvocationStarted: (event) => {
        if (!this.parity.turnId) return;
        startedInvocation = event;
        this.pendingUsageChargeId = event.request_id ?? event.inference_id;
        retryCount = 0;
        const recordedParentRequestId = event.parent_request_id ?? parentRequestId;
        const derivedExpectedPriorEventIds = this.parity.sessionEvents.events
          .filter(
            (prior) =>
              prior.kind === 'tool_completed' ||
              prior.kind === 'tool_failed' ||
              prior.kind === 'tool_cancelled',
          )
          .map((prior) => prior.tool_call_id);
        const compactionEvents = this.parity.sessionEvents.events.filter(
          (prior) =>
            prior.kind === 'compaction_summary' ||
            prior.kind === 'compaction_committed',
        );
        const expectedPriorEventIds = context.expectedPriorEventIds ?? derivedExpectedPriorEventIds;
        const deliveredPriorEventIds =
          context.deliveredPriorEventIds ??
          event.delivered_tool_call_ids ??
          (context.deliveryMode === 'text' ? expectedPriorEventIds : undefined);
        const contextManifest = buildContextManifest({
          inferenceId: event.inference_id,
          conversationState: context.conversationState ?? this.conversation,
          systemPolicyPrompt: context.systemPolicyPrompt,
          userTaskPrompt: context.userTaskPrompt ?? this.options.task,
          toolSchema: context.toolSchema,
          expectedPriorEventIds,
          ...(deliveredPriorEventIds !== undefined
            ? { deliveredPriorEventIds }
            : {}),
          deliveryMode:
            context.deliveryMode ??
            (event.delivered_tool_call_ids !== undefined ? 'native' : 'unknown'),
          compactionOccurred: compactionEvents.length > 0,
          compactionInputState: compactionEvents.map((compaction) => ({
            operation_id: compaction.operation_id,
            kind: compaction.kind,
          })),
          preservedEventIds: compactionEvents.flatMap(
            (compaction) => compaction.preserved_tool_call_ids,
          ),
          promptInputTokenCount: context.promptInputTokenCount ?? null,
          contextTruncated: context.contextTruncated ?? null,
        });
        const routeReceipt = buildModelRouteReceipt({
          projectRef: hashRouteReference(this.options.projectRoot),
          taskRef: hashRouteReference(this.options.task),
          runRef: this.engineRunDir,
          contractRef: context.contractRef ?? 'chat',
          inferenceId: event.inference_id,
          executionStage: context.executionStage ?? 'chat',
          requestedModelSelector: event.requested_model_id,
          normalizedBabelModel: event.normalized_model_id,
          provider: event.provider,
          exactModelIdSent: event.sent_model_id,
          observedModelId: null,
          upstreamProvider: null,
          substitutionOrFallback: context.substitutionOrFallback ?? false,
        });
        recordModelInputReceipt(this.parity.sessionEvents, {
          turn_id: this.parity.turnId,
          inference_id: event.inference_id,
          provider: event.provider,
          requested_model_id: event.requested_model_id,
          normalized_model_id: event.normalized_model_id,
          sent_model_id: event.sent_model_id,
          input_digest: event.input_digest,
          ...(event.request_id !== undefined ? { request_id: event.request_id } : {}),
          ...(event.attempt_id !== undefined ? { attempt_id: event.attempt_id } : {}),
          ...(recordedParentRequestId !== null && recordedParentRequestId !== undefined
            ? { parent_request_id: recordedParentRequestId }
            : {}),
          body_digest: event.input_digest,
          ...(event.input_bytes !== undefined ? { body_bytes: event.input_bytes } : {}),
          ...(event.accounting_kind !== undefined ? { accounting_kind: event.accounting_kind } : {}),
          ...(event.context_limit_tokens !== undefined ? { context_limit_tokens: event.context_limit_tokens } : {}),
          ...(event.context_limit_source !== undefined ? { context_limit_source: event.context_limit_source } : {}),
          input_ref: join(this.engineRunDir, 'thread_events.json'),
          ...(event.input_message_count !== undefined
            ? { input_message_count: event.input_message_count }
            : {}),
          ...(event.delivered_tool_call_ids !== undefined
            ? { delivered_tool_call_ids: [...event.delivered_tool_call_ids] }
            : {}),
          context_manifest: contextManifest,
          route_receipt: routeReceipt,
        });
        this.lastLogicalRequestId = event.request_id ?? event.inference_id;
        this.pendingParentRequestId = null;
        for (const capability of event.capability_bindings ?? []) {
          recordCapabilityBindingReceipt(this.parity.sessionEvents, {
            turn_id: this.parity.turnId,
            inference_id: event.inference_id,
            provider: event.provider,
            capability: capability.capability,
            advertised: capability.advertised,
            authorized: capability.authorized,
            effective: capability.effective,
            ...(capability.evidence_ref !== undefined
              ? { evidence_ref: capability.evidence_ref }
              : {}),
          });
        }
        checkpointParityEventLog(this.parity, this.engineRunDir);
      },
      onInvocationCompleted: (event) => {
        if (!this.parity.turnId) return;
        const observedRouteReceipt = startedInvocation
          ? buildModelRouteReceipt({
              projectRef: hashRouteReference(this.options.projectRoot),
              taskRef: hashRouteReference(this.options.task),
              runRef: this.engineRunDir,
              contractRef: context.contractRef ?? 'chat',
              inferenceId: event.inference_id,
              executionStage: context.executionStage ?? 'chat',
              requestedModelSelector: startedInvocation.requested_model_id,
              normalizedBabelModel: startedInvocation.normalized_model_id,
              provider: startedInvocation.provider,
              exactModelIdSent: startedInvocation.sent_model_id,
              observedModelId: event.observed_model_id ?? null,
              upstreamProvider: event.upstream_provider ?? null,
              retryCount,
              substitutionOrFallback: context.substitutionOrFallback ?? false,
            })
          : undefined;
        recordModelResultDelivery(this.parity.sessionEvents, {
          turn_id: this.parity.turnId,
          inference_id: event.inference_id,
          provider: event.provider,
          model: event.model,
          status: event.status,
          ...(event.observed_model_id !== undefined
            ? { observed_model_id: event.observed_model_id }
            : {}),
          ...(event.upstream_provider !== undefined
            ? { upstream_provider: event.upstream_provider }
            : {}),
          ...(event.output_digest !== undefined ? { output_digest: event.output_digest } : {}),
          ...(event.failure_receipt !== undefined
            ? { failure_receipt: event.failure_receipt }
            : {}),
          ...(event.failure_class !== undefined ? { failure_class: event.failure_class } : {}),
          ...(event.failure_stage !== undefined ? { failure_stage: event.failure_stage } : {}),
          ...(event.provider_request_id !== undefined
            ? { provider_request_id: event.provider_request_id }
            : {}),
          ...(event.api_error_code !== undefined
            ? { api_error_code: event.api_error_code }
            : {}),
          ...(event.http_status !== undefined ? { http_status: event.http_status } : {}),
          ...(event.actual_attempt !== undefined
            ? { actual_attempt: event.actual_attempt }
            : {}),
          ...(event.max_attempts !== undefined ? { max_attempts: event.max_attempts } : {}),
          ...(event.stream !== undefined ? { stream: event.stream } : {}),
          ...(event.inference_started !== undefined
            ? { inference_started: event.inference_started }
            : {}),
          ...(event.partial_model_output !== undefined
            ? { partial_model_output: event.partial_model_output }
            : {}),
          ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
          ...(event.tool_call_count !== undefined
            ? { tool_call_count: event.tool_call_count }
            : {}),
          ...(event.requested_output_budget !== undefined
            ? { requested_output_budget: event.requested_output_budget }
            : {}),
          ...(event.effective_output_budget !== undefined
            ? { effective_output_budget: event.effective_output_budget }
            : {}),
          ...(event.wire_policy_hash !== undefined
            ? { wire_policy_hash: event.wire_policy_hash }
            : {}),
          ...(event.execution_envelope_hash !== undefined
            ? { execution_envelope_hash: event.execution_envelope_hash }
            : {}),
          ...(observedRouteReceipt ? { route_receipt: observedRouteReceipt } : {}),
        });
        checkpointParityEventLog(this.parity, this.engineRunDir);
      },
      onInvocationPhase: (event) => {
        if (!this.parity.turnId) return;
        recordModelInvocationPhase(this.parity.sessionEvents, {
          turn_id: this.parity.turnId,
          inference_id: event.inference_id,
          provider: event.provider,
          model: event.model,
          phase: event.phase,
          ...(event.status_code !== undefined ? { status_code: event.status_code } : {}),
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        });
        checkpointParityEventLog(this.parity, this.engineRunDir);
      },
      onRetry: (event) => {
        retryCount += 1;
        const retryRequestId = event.request_id ?? startedInvocation?.inference_id;
        const retryBodyDigest = event.body_digest ?? startedInvocation?.input_digest;
        parityRecordProviderRetry(
          this.parity,
          {
            provider: event.provider,
            model: event.model,
            ...(retryRequestId ? { requestId: retryRequestId } : {}),
            ...(event.attempt_id !== undefined ? { attemptId: event.attempt_id } : {}),
            ...(retryBodyDigest ? { bodyDigest: retryBodyDigest } : {}),
            attempt: event.attempt,
            reason: event.reason,
            backoffMs: event.backoff_ms,
          },
          this.engineRunDir,
        );
      },
      onRetrySettled: (event) => {
        const retryRequestId = event.request_id ?? startedInvocation?.inference_id;
        const retryBodyDigest = event.body_digest ?? startedInvocation?.input_digest;
        paritySettleProviderRetry(
          this.parity,
          {
            provider: event.provider,
            model: event.model,
            ...(retryRequestId ? { requestId: retryRequestId } : {}),
            ...(event.attempt_id !== undefined ? { attemptId: event.attempt_id } : {}),
            ...(retryBodyDigest ? { bodyDigest: retryBodyDigest } : {}),
            attempt: event.attempt,
            outcome: event.outcome,
          },
          this.engineRunDir,
        );
      },
    };
  }
  private async executeWithTimeout(
    runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | OpenRouterApiRunner,
    prompt: string,
    callbacks: RunnerCallbacks | undefined,
    systemPrompt?: string,
  ): Promise<string> {
    const execPromise = runner.executeRaw(
      prompt,
      callbacks,
      systemPrompt,
      this.abortController.signal,
    );

    // Capture the controller reference so the timeout always aborts the
    // controller that was active when this turn started, even if cancel()
    // replaces this.abortController mid-flight (it creates a fresh one).
    const turnController = this.abortController;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        turnController.abort();
        reject(new Error(`Turn timed out after ${TURN_TIMEOUT_MS / 1000}s without a response`));
      }, TURN_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([execPromise, timeoutPromise]);
      return result;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      // Prevent unhandled rejection: if the timeout fires,
      // abortController.abort() causes execPromise to reject but
      // Promise.race has already settled with TimeoutError, leaving
      // an orphaned rejection.  Swallow it here.
      execPromise.catch(() => {});
    }
  }

  private resolveFallbackRunner():
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
    | OpenRouterApiRunner
    | null {
    if (this.options.providerRunner) return this.options.providerRunner;
    if (
      !isOfflineChatMode() &&
      this.modelPolicy?.provider === 'openrouter' &&
      this.modelPolicy.providerModelId
    ) {
      if (!this.fallbackRunner) {
        try {
          // Campaign invariant: an exact GLM run may retry the same model, but
          // may not silently fail over to a different provider/model.
          this.fallbackRunner = new OpenRouterApiRunner(this.modelPolicy.providerModelId);
        } catch {
          return null;
        }
      }
      return this.fallbackRunner;
    }
    if (!this.options.fallbackModel) return null;
    if (!isOfflineChatMode()) {
      assertLiveModelId(this.options.fallbackModel, 'live chat fallback');
      const routedModel = resolveOpenRouterDeepSeekModelId(this.options.fallbackModel);
      if (!routedModel) {
        return null;
      }
      if (!this.fallbackRunner) {
        try {
          this.fallbackRunner = new OpenRouterApiRunner(routedModel);
        } catch {
          return null;
        }
      }
      return this.fallbackRunner;
    }
    if (!this.fallbackRunner) {
      try {
        this.fallbackRunner = new OllamaApiRunner(this.options.fallbackModel);
      } catch {
        try {
          this.fallbackRunner = new DeepInfraApiRunner(this.options.fallbackModel);
        } catch {
          try {
            this.fallbackRunner = new DeepSeekApiRunner(this.options.fallbackModel);
          } catch {
            return null;
          }
        }
      }
    }
    return this.fallbackRunner;
  }

  /**
   * #27: Build the assembled system prompt, using the session-level cache
   * to avoid reconstructing it on every turn. The cache is keyed implicitly
   * by the options that never change within an engine session (systemContext,
   * appendSystemPrompt, projectRoot).
   */
  private shouldUseNativeTools(
    runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner,
  ): boolean {
    // Ollama models generally don't support native OpenAI tool calling.
    // The legacy JSON path handles tool use via prompt formatting instead.
    if (runner instanceof OllamaApiRunner) return false;
    return (
      process.env['BABEL_NATIVE_TOOLS'] !== 'disabled' &&
      typeof runner.executeWithToolsStream === 'function'
    );
  }

  /**
   * Whether to use the simplified text-tool format for small local models.
   * Auto-detects Ollama models unless explicitly overridden via BABEL_TOOL_PROFILE.
   */
  private shouldUseTextTools(): boolean {
    if (process.env['BABEL_TOOL_PROFILE'] === 'legacy') return false;
    if (process.env['BABEL_TOOL_PROFILE'] === 'text') return true;
    if (process.env['BABEL_TOOL_PROFILE'] === 'native') return false;
    const runner = this.resolveDeliberationRunner();
    return runner instanceof OllamaApiRunner;
  }

  /**
   * Single-turn deliberation — native tool_use when supported, else legacy JSON parse.
   */
  private async deliberateTurn(
    runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner,
    promptOrMessages: string | ProviderMessage[],
    useNativeTools: boolean,
    callbacks: ChatCallbacks,
    hooks: { onStreamedChunks?: (text: string) => void } = {},
  ): Promise<ChatTurn> {
    resetOneShotSnapshot(this.logicalTurnToolPolicy);
    if (useNativeTools && typeof runner.executeWithToolsStream === 'function') {
      const nextTools = this.nextTurnToolPolicy();
      const restrictTools = nextTools.restrict && !isReadOnlyChat();
      const toolDefs = filterReadOnlyChatTools(restrictTools
        ? this.services.tools.buildRestrictedDefinitions(
            nextTools.mode === 'full' ? 'act_or_verify' : nextTools.mode,
          )
        : this.services.tools.buildDefinitions());
      const nativeActions: ChatToolAction[] = [];
      let answerText = '';
      let nativeFinishReason: string | undefined;
      const systemPrompt = this.getOrBuildSystemPrompt('native');

      for await (const event of runner.executeWithToolsStream(
        Array.isArray(promptOrMessages)
          ? promptOrMessages
          : ([{ role: 'user', content: promptOrMessages }] as ProviderMessage[]),
        toolDefs,
        systemPrompt,
        this.abortController.signal,
        restrictTools ? 'required' : 'auto',
        this.providerRetryCallbacks({
          deliveryMode: 'native',
          conversationState: promptOrMessages,
          systemPolicyPrompt: systemPrompt,
          toolSchema: toolDefs,
          executionStage: 'chat',
        }),
      )) {
        switch (event.type) {
          case 'text_delta':
            answerText += event.text;
            hooks.onStreamedChunks?.(answerText);
            callbacks.onAnswerChunk?.(event.text);
            break;
          case 'thought_delta':
            callbacks.onThought?.(event.text);
            break;
          case 'tool_use': {
            const action = nativeToolUseToChatAction(event.name, event.input);
            nativeActions.push(action);
            callbacks.onToolStart?.(chatActionToolName(action), chatActionTarget(action));
            break;
          }
          case 'error':
            throw new Error(event.message);
          case 'done':
            nativeFinishReason = event.finishReason;
            break;
          default: {
            const _exhaustive: never = event;
            throw new Error(`Unknown stream event: ${(_exhaustive as any).type}`);
          }
        }
      }
      this.trackRunnerUsage(runner);
      return nativeTurnFromStream({
        answerText,
        actions: nativeActions,
        finishReason: nativeFinishReason,
      });
    }

    // ── Text-tools path — simplified format for small local models ──────────
    if (this.shouldUseTextTools()) {
      const systemPrompt = this.getOrBuildSystemPrompt('text');
      const rawText = await this.executeWithTimeout(
        runner,
        promptOrMessages as string,
        this.providerRetryCallbacks({
          deliveryMode: 'text',
          conversationState: promptOrMessages,
          systemPolicyPrompt: systemPrompt,
          executionStage: 'chat',
        }),
        systemPrompt,
      );
      const turn = parseTextToolTurn(rawText);
      this.trackRunnerUsage(runner);
      return turn;
    }

    let streamedChunks = '';
    let looksLikeJson = false;
    const deliberationCallbacks: RunnerCallbacks = {
      ...this.providerRetryCallbacks({
        deliveryMode: 'text',
        conversationState: promptOrMessages,
        executionStage: 'chat',
      }),
      ...(callbacks.onThought || callbacks.onAnswerChunk
        ? {
            onChunk: (chunk: string) => {
              streamedChunks += chunk;
              hooks.onStreamedChunks?.(streamedChunks);
              if (!looksLikeJson && streamedChunks.length >= 3) {
                const head = streamedChunks.trimStart();
                looksLikeJson =
                  head.startsWith('{') || head.startsWith('```json') || head.startsWith('```');
              }
              if (!looksLikeJson && chunk.trim()) {
                callbacks.onAnswerChunk?.(chunk);
              }
            },
            ...(callbacks.onThought
              ? {
                  onThought: (thought: string) => callbacks.onThought?.(thought),
                }
              : {}),
          }
        : {}),
    };

    const rawText = await this.executeWithTimeout(
      runner,
      promptOrMessages as string,
      deliberationCallbacks,
    );
    this.trackRunnerUsage(runner);
    return this.parseChatTurnLenient(rawText);
  }

  /**
   * Resolve a fallback runner and emit the "Retrying with fallback model" thought,
   * or yield a failed event and return null if the error is not recoverable.
   *
   * Extracted from submitMessageStream() to deduplicate the turn-gating +
   * fallback-resolution skeleton that appears identically in both the native
   * tools and legacy JSON error paths.
   */
  private async *resolveFallbackOrFail(
    err: any,
    turn: number,
  ): AsyncGenerator<
    ChatEvent,
    DeepInfraApiRunner | DeepSeekApiRunner | OpenRouterApiRunner | null,
    undefined
  > {
    const cancelled = this.emitCancelledIfOperatorAbort(err);
    if (cancelled) {
      yield cancelled;
      return null;
    }
    if (
      err instanceof ProviderOutputTruncatedError ||
      /finish_reason: length/i.test(err?.message ?? '')
    ) {
      yield this.streamFailed(err?.message ?? String(err));
      return null;
    }
    if (turn > 0) {
      yield this.streamFailed(err.message);
      return null;
    }
    // Runtime Pro → Flash failover with visible reason (not verification)
    const modelId = this.options.model ?? 'deepseek-v4-pro';
    const decision = parityTryFailover(this.parity, modelId, err);
    const exactGlmLocked =
      this.modelPolicy?.provider === 'openrouter' &&
      this.modelPolicy.providerModelId === LIVE_OPENROUTER_MODEL_ID;
    if (exactGlmLocked && decision) {
      // The exact GLM campaign is provider/model locked. A generic Pro→Flash
      // decision must never cross that boundary into DeepSeek.
      yield this.streamFailed(
        `${err.message} [LIVE_MODEL_POLICY] exact GLM route refuses provider substitution`,
      );
      return null;
    }
    let fb = this.resolveFallbackRunner();
    if (!fb && decision) {
      const routedModel = resolveOpenRouterDeepSeekModelId(decision.toModel);
      if (!routedModel) {
        yield this.streamFailed(
          `${err.message} [LIVE_MODEL_POLICY] failover route is not OpenRouter-approved`,
        );
        return null;
      }
      fb = new OpenRouterApiRunner(routedModel);
      this.fallbackRunner = fb;
      this.policyEventLog.record({
        at_turn: this._turnIndex,
        kind: 'failover',
        detail: decision.reason,
      });
      recordModelFailover(this.parity.sessionEvents, this.parity.turnId || '', {
        original_model: decision.fromModel,
        new_model: decision.toModel,
        reason: decision.reason,
      });
      yield {
        type: 'thought',
        text: `[Failover] ${decision.reason} (not independent verification)`,
      };
      return fb;
    }
    if (!fb) {
      yield this.streamFailed(err.message);
      return null;
    }
    yield {
      type: 'thought',
      text: decision ? `[Failover] ${decision.reason}` : 'Retrying with fallback model…',
    };
    return fb;
  }

  private getOrBuildSystemPrompt(mode: 'native' | 'legacy' | 'text' = 'legacy'): string {
    if (mode === 'native' && this.cachedSystemPromptNative !== null) {
      return this.cachedSystemPromptNative;
    }
    if (mode === 'legacy' && this.cachedSystemPromptLegacy !== null) {
      return this.cachedSystemPromptLegacy;
    }
    if (mode === 'text' && this.cachedSystemPromptText !== null) {
      return this.cachedSystemPromptText;
    }
    const nativeTools = mode === 'native';
    const textTools = mode === 'text';
    const systemCtx = this.options.systemContext;
    let systemContent = this.services.conversation.buildSystemPrompt({
      projectRoot: this.options.projectRoot,
      nativeTools,
      textTools,
      executionFirst: true,
      runtimeMode: this.options.runtimeMode ?? 'unknown',
      ...(systemCtx ? { systemContext: systemCtx } : {}),
    });
    if (isReadOnlyChat()) {
      systemContent += '\n\nRead-only capability boundary: only read_file, read_range, list_dir, grep and glob are available. Do not request shell commands, writes, subagents or shared memory. If a read/search fails, use another available reading tool or report the missing evidence; unavailable tools cannot work around this boundary.';
    }

    // Text-tools mode: keep the prompt MINIMAL. Small models cannot attend
    // to long system prompts. Skip all the extra context that cloud models use.
    if (!textTools) {
      if (this.options.appendSystemPrompt) {
        systemContent += '\n\n' + this.options.appendSystemPrompt;
      }
      if (this.options.preflightContext) {
        systemContent += '\n\n' + this.options.preflightContext;
      }

      // R4: Inject repo map for orientation
      if (this.repoMapCache) {
        systemContent += '\n\n' + this.repoMapCache;
      }

      // R3b: Extract and surface verifier command from task
      const verifierCmd = extractVerifierCommandFn(this.options.task);
      if (verifierCmd) {
        systemContent += `\n\n## Task Verifier\nThe verifier command for this task is: \`${verifierCmd}\`\nRun it after making changes to confirm the fix works.`;
      }
    }

    if (mode === 'native') {
      this.cachedSystemPromptNative = systemContent;
    } else if (mode === 'text') {
      this.cachedSystemPromptText = systemContent;
    } else {
      this.cachedSystemPromptLegacy = systemContent;
    }
    return systemContent;
  }

  private initializeVerifierGuard(): void {
    initializeVerifierDependencyHashes(
      this.options.task,
      this.options.projectRoot,
      this.verifierDependencyHashes,
    );
  }

  private checkVerifierTamper(filePath: string): string | null {
    const state = {
      verifierDependencyHashes: this.verifierDependencyHashes,
      verifierTampered: this.verifierTampered,
      tamperCount: this.tamperCount,
      tamperedThisTurn: this.tamperedThisTurn,
    };
    const warning = checkVerifierTamperFn(filePath, this.options.projectRoot, state);
    this.verifierTampered = state.verifierTampered;
    this.tamperCount = state.tamperCount;
    this.tamperedThisTurn = state.tamperedThisTurn;
    return warning;
  }

  private applyTamperEscalation(): string | null {
    return applyTamperEscalationFn(
      {
        tamperedThisTurn: this.tamperedThisTurn,
        tamperCount: this.tamperCount,
      },
      this.stallState,
    );
  }

  private buildVerifierBlockedReport(reason: string): BlockedReport {
    return {
      schema_version: 1,
      status: 'BLOCKED',
      reason,
      missing: 'Verifier could not be satisfied after multiple attempts.',
      checked: [],
    };
  }

  private hashContent(content: string): string {
    return hashContentFn(content);
  }

  private async hashFilePath(filePath: string): Promise<string> {
    try {
      const resolved = resolveProjectPath(this.options.projectRoot, filePath);
      return this.hashContent(await readFile(resolved, 'utf-8'));
    } catch {
      return '';
    }
  }

  private resetReadInjectionContext(): void {
    this.readContextEpoch = (this.readContextEpoch ?? 0) + 1;
    this.readCache?.clear();
    this.fullReadCounts?.clear();
  }

  /** B4: Resolve runner with phase-aware model routing.
   *  Model-name resolution extracted to phaseModelRouting.ts for testability. */
  private resolveRoutedRunner():
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
    | OpenRouterApiRunner {
    const modelName = resolvePhaseModelName(this._lastPhase, {
      investigateModel: this.limits.investigateModel,
      mutateModel: this.limits.mutateModel,
    });
    if (!modelName) return this.resolveDeliberationRunner();
    if (!isOfflineChatMode()) {
      assertLiveModelId(modelName, 'live chat phase routing');
    }
    const isInvestigate = !this._lastPhase || this._lastPhase === 'investigate';
    if (isInvestigate) {
      this.investigateRunner ??= makeChatRunner(modelName);
      return this.investigateRunner;
    }
    this.mutateRunner ??= makeChatRunner(modelName);
    return this.mutateRunner;
  }

  /** C1: Inject or update the todo list system message in the conversation.
   *  Called before each LLM call to keep the model aware of active tasks. */
  private updateTodoSystemMessage(): void {
    // Remove any existing todo system message (identified by the header prefix)
    const todoMsgIdx = this.conversation.findIndex(
      (m) => m.role === 'system' && m.content.startsWith('## Active Task List'),
    );
    if (todoMsgIdx >= 0) {
      this.conversation.splice(todoMsgIdx, 1);
    }

    if (this.todos.size === 0) return;

    // Build formatted todo list (max 10 items shown directly)
    const lines: string[] = ['## Active Task List'];
    let count = 0;
    for (const [, todo] of this.todos) {
      if (count >= 10) {
        lines.push(`- ... and ${this.todos.size - count} more`);
        break;
      }
      lines.push(`- [${todo.status}] ${todo.content}`);
      count++;
    }
    const content = lines.join('\n');

    // Inject after the first system message (or at the beginning if none)
    const sysIdx = this.conversation.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) {
      this.conversation.splice(sysIdx + 1, 0, { role: 'system', content });
    } else {
      this.conversation.unshift({ role: 'system', content });
    }
  }

  private detectAndBuildBlockedReport(answer: string): BlockedReport | null {
    return detectBlockedReportFromAnswer(answer, this.toolCallLog);
  }

  /** Persist exactly one authoritative completion decision for this turn. */
  private recordCompletionDecisionOnce(decision: {
    requestedOutcome: string;
    finalOutcome: string;
    allowed: boolean;
    reason: string;
    evidenceRefs: string[];
    policyVersion: string;
  }): void {
    const turnId = String(this.parity.turnId ?? this._turnIndex);
    if (
      this.parity.sessionEvents.events.some(
        (event) => event.kind === 'completion_decision' && event.turn_id === turnId,
      )
    )
      return;
    recordCompletionDecision(this.parity.sessionEvents, turnId, decision);
  }

  private assembleRunAllowance(finalStatus: ChatResult['status']): ChatEngineRunAllowanceReport {
    const runAllowance = createRunAllowanceReport(this.limits, {
      postWriteRepairWallCapMs: this.postWriteRepairWallCapMs,
      criticRepairCostCapUsd: this.criticRepairCostCapUsd,
      terminatingLimiter: this.terminatingLimiter,
      terminalClassification: this.terminatingLimiter
        ? classifyTerminalLimiter(this.terminatingLimiter, this.terminalLimiterReason ?? undefined)
        : finalStatus === 'cancelled'
          ? 'cancelled'
          : null,
      terminalReason: this.terminalLimiterReason,
      // I3: coarse run-level child defaults; effective rounds are resolved at
      // dispatch (read 4 / mutation 8, clamped 1-20).
      childLimits: {
        maxRounds: CHILD_READ_DEFAULT_ROUNDS,
        readMaxRounds: CHILD_READ_DEFAULT_ROUNDS,
        mutationMaxRounds: CHILD_MUTATION_DEFAULT_ROUNDS,
      },
      taskCostBaselineUsd: this.taskCostBaselineUsd,
      taskCostSpentUsd: this.currentTaskCostUsd(),
    });
    if (runAllowance.terminatingLimiter === 'none' || runAllowance.terminatingLimiter == null) {
      if (runAllowance.terminalClassification === 'success') {
        runAllowance.terminalClassification = 'no_limit_triggered';
      }
    }
    this.limits.runAllowance = runAllowance;
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: 'progress_policy',
      detail: `run_allowance ${JSON.stringify(runAllowance)}`,
    });
    try {
      writeFileSync(join(this.engineRunDir, 'run-allowance.json'), JSON.stringify(runAllowance));
    } catch {
      /* evidence write must not fail the turn */
    }
    this.persistTaskCostBaseline();
    return runAllowance;
  }

  private buildResult(
    status: ChatResult['status'],
    callbacks: ChatCallbacks,
    answer?: string,
    blockedReport?: BlockedReport | null,
    knownOutcome?: TerminalOutcome,
  ): ChatResult {
    // R1: If the answer explicitly declares BLOCKED but no blockedReport was
    // provided (e.g., the detection ran in a code path that didn't provide it),
    // promote the status to 'blocked' and generate the report here.
    const hasBlocked = !!(answer && /\bBLOCKED\b/.test(answer));
    const finalStatus =
      (status === 'completed' || status === 'failed') && hasBlocked ? ('blocked' as const) : status;
    const finalBlockedReport =
      finalStatus === 'blocked' && !blockedReport
        ? this.detectAndBuildBlockedReport(answer ?? '')
        : blockedReport;

    if (this.cachedSystemPromptNative)
      stashEngineFingerprint(
        this.engineRunId,
        buildPromptFingerprint({
          systemPrompt: this.cachedSystemPromptNative,
          taskClass: this.taskClass,
          tune: getChatTaskTune(this.taskClass),
          playbookId: this.activePlaybook?.id ?? null,
        }),
      );

    // Compute truthful TerminalOutcome from status and runtime state.
    const hasMutation = this.hasAnyWrites();
    const failedCause =
      finalStatus === 'failed'
        ? (knownOutcome ?? classifyFailureText(answer ?? ''))
        : undefined;
    let outcome: TerminalOutcome | undefined =
      finalStatus === 'failed'
        ? failedCause
        : (knownOutcome ??
          computeTerminalOutcome({
            readOnly: isReadOnlyChat(),
            finalStatus,
            budgetExceeded: this.budgetExceeded,
            lastVerifierReceipt: this.lastVerifierReceipt,
            blockedReport: finalBlockedReport,
            hasAnyWrites: hasMutation,
          }));
    if (outcome !== undefined && finalStatus !== 'failed') {
      outcome = applyHonestTaskOutcomeToCompletion({
        contract: this.parity.liveAuthority?.taskContract,
        requestedOutcome: outcome,
        hasMutation,
        planMode: this.executionProfile === 'plan',
      });
    }
    const planCompletion = this.executionProfile === 'plan' && finalStatus === 'completed';
    const kernelDecision =
      outcome !== undefined && finalStatus !== 'failed'
        ? this.decideCompletion(planCompletion ? 'PLAN_COMPLETE' : outcome, hasMutation)
        : null;
    const authoritativeOutcome: TerminalOutcome | undefined =
      kernelDecision && kernelDecision.finalOutcome !== 'PLAN_COMPLETE'
        ? kernelDecision.finalOutcome
        : planCompletion
          ? 'UNVERIFIED_PATCH'
          : outcome;
    if (kernelDecision) {
      this.recordCompletionDecisionOnce({
        requestedOutcome: kernelDecision.requestedOutcome,
        finalOutcome: authoritativeOutcome ?? kernelDecision.finalOutcome,
        allowed: kernelDecision.allowed,
        reason: kernelDecision.reason,
        evidenceRefs: kernelDecision.evidenceRefs,
        policyVersion: kernelDecision.policyVersion,
      });
    }

    // P0-E: if any kill-switch ran in shadow mode, record whether the task
    // later succeeded (mutation / coding-task gate) for precision/recall.
    // P0-F: wire the derived OutcomeDimensions — the real receipt (its `stale`
    // flag was just refreshed against the live workspace by decideCompletion)
    // and the completion-gate result (authoritativeOutcome IS the gate decision).
    const codingPassed = isCodingTaskSuccess({
      terminalOutcome: authoritativeOutcome ?? null,
      hasSuccessfulMutation: hasMutation,
      verifierOk: this.lastVerifierReceipt?.exit_code === 0,
      requireVerifier: false,
      declaredBlocked: Boolean(finalBlockedReport),
      verifierReceipt: this.lastVerifierReceipt ?? null,
      contractChecksPass: authoritativeOutcome === 'VERIFIED_COMPLETE' ? true : null,
    });
    recordPolicyShadowSessionOutcome(this.policyEventLog, {
      atTurn: this._turnIndex,
      hasSuccessfulMutation: hasMutation,
      codingTaskPassed: codingPassed,
      terminalOutcome: authoritativeOutcome ?? 'unknown',
    });

    const terminal = projectChatTerminal({
      ...(authoritativeOutcome !== undefined ? { outcome: authoritativeOutcome } : {}),
      status: finalStatus,
    });

    this.settleActiveExecutionForTerminal();
    // AC3 choke point: memory + disk (idempotent if streamDone already finalized)
    finalizeParityTurnSync(this.parity, this.engineRunDir, terminal.outcome, terminal.status);

    const runAllowance = this.assembleRunAllowance(terminal.status);

    const result: ChatResult = {
      status: terminal.status,
      ...(terminal.outcome !== undefined ? { outcome: terminal.outcome } : {}),
      ...(kernelDecision?.finalOutcome === 'PLAN_COMPLETE'
        ? { planOutcome: 'PLAN_COMPLETE' as const }
        : {}),
      answer: answer ?? '',
      usage: globalCostTracker.getSessionSummary(),
      lastRequestPromptTokens: this.lastRequestPromptTokens,
      lastRequestCompletionTokens: this.lastRequestCompletionTokens,
      activeContext:
        this.lastRequestPromptTokens !== null && this.lastRequestPromptTokens !== undefined
          ? {
              tokens: this.lastRequestPromptTokens,
              modelId: this.lastRequestModelId ?? this.options.model ?? 'default',
              source: 'provider_prompt_tokens' as const,
            }
          : null,
      conversation: this.conversation,
      runDir: this.engineRunDir,
      verifierReceipt: this.lastVerifierReceipt,
      dedupeHitCount: this.dedupeHitCount,
      ...(this.verifierTampered ? { verifierTampered: true as const } : {}),
      ...(finalBlockedReport ? { blockedReport: finalBlockedReport } : {}),
      ...(this.lastCriticReceipt ? { criticReceipt: this.lastCriticReceipt } : {}),
      ...(this.budgetExceeded ? { budgetExceeded: true as const } : {}),
      ...(this.gatePolicy ? { gatePolicy: this.gatePolicy } : {}),
      ...(this.lastTurnTelemetry ? { turnTelemetry: this.lastTurnTelemetry } : {}),
      ...(this.limits.costBudget ? { costBudget: this.limits.costBudget } : {}),
      runAllowance,
      ...observabilityResultFields(this.obsHandles()),
    };

    // Persist conversation transcript to disk for session resume.
    // Write is fire-and-forget — failure must not block the turn result.
    persistTranscriptToDisk(this.engineRunDir, result.conversation).catch(() => {});

    // Tier A2: Persist policy event log alongside transcript (sync — no exit race)
    persistPolicyEventsJsonl(this.engineRunDir, this.policyEventLog);
    // Event log disk flush is owned solely by finalizeParityTurn / checkpointParityEventLog

    // Propose BABEL.md learnings after successful runs with writes only.
    if (terminal.status === 'completed' && this.writeCount > 0) {
      try {
        const changed = this.toolCallLog
          .flatMap((t) => confirmedMutationPaths({
            tool: t.tool,
            target: t.target,
            error: t.error,
            effectStatus: t.effect_status,
            mutationPaths: t.mutation_paths,
          }))
          .filter((p, i, arr) => p && arr.indexOf(p) === i)
          .slice(0, 20);
        proposeProjectMemoryWriteback({
          projectRoot: this.options.projectRoot,
          taskSummary: this.options.task,
          changedFiles: changed,
          verifierSummary: this.lastVerifierReceipt
            ? `${this.lastVerifierReceipt.command} → exit ${this.lastVerifierReceipt.exit_code}`
            : null,
        });
      } catch {
        /* write-back must never fail the turn */
      }
    }

    return result;
  }

  public resetCompactionCircuitBreaker(): void {
    this.compactionConsecutiveFailures = 0;
  }
}
