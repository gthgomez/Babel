/**
 * ChatEngine — unified conversational agent loop for Babel chat mode.
 * Chat investigates and executes; deep mode remains the governed pipeline.
 * Compaction: chatCompaction.ts. Critic/budget: chatEngineCriticBudget.ts.
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
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
  RunnerInvocationMetadata,
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
import type { ChargeReceipt, SessionUsageSummary, UsageAttribution } from '../services/costTracker.js';
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
import type {
  BlockedReport,
  TerminalOutcome,
  TerminalReasonCode,
} from '../schemas/agentContracts.js';
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
  refreshEngineInstructionManifest,
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
  loadLiveSessionSnapshot,
  persistLiveSessionAuthority,
  recoverCheckpointArtifacts,
} from './liveSessionBridge.js';
import type { LiveSessionV1 } from './liveSession.js';
import {
  applyHonestTaskOutcomeToCompletion,
  createFailureBudgetTrackerFromContract,
  makeFailureCapsule,
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
  formatWorkingStateBlock,
  invalidateReadCacheForPath,
  recordControllerRecoveryStrategy,
  recoveryEvidenceKey,
  restoreWorkingStateSnapshot,
  sameRecoveryBinding,
  RECOVERY_EVIDENCE_TOOLS,
  resetOneShotSnapshot,
  targetMatchesGate,
  type RecoveryEvidenceProvenance,
  type RecoveryCandidateBinding,
  resolveNextTurnToolAccess,
  selectReadWindow,
  snapshotOnce,
  upsertWorkingStateMessage,
  type ReadInjectionCache,
  type WorkingState,
} from './codingLoop/index.js';
import { ingestVerifierResult, rememberFullReadWindow } from './codingLoop/chatBindings.js';
import { recoveryTargetIdentity, recoveryWorkspaceRevision } from './codingLoop/recoveryIdentity.js';
import { actualRecoveryEdit, admitRecoveryPlan } from './codingLoop/recoveryPlan.js';
import { beginLocalizationCall, discoverTestCandidates, finishLocalizationCall } from './codingLoop/failureLocalization.js';
import { canonicalizeContained } from '../bridge/workspaceBound.js';

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
import { loadThreadEventLogFromDir, recordUserMessage, repoRootFingerprint } from './threadEventLog.js';
import { isOperatorAbortError } from './operatorAbort.js';
import {
  loadSessionEventLogForResume,
  loadSessionEventLogIfPresentForResume,
  interruptedToolRecoveries,
  recordCompletionDecision,
  recordCapabilityBindingReceipt,
  recordModelInputReceipt,
  recordModelInvocationPhase,
  recordModelResultDelivery,
  recordModelFailover,
  recordMutationBatch,
  recordPolicyIntervened,
  recordProgressRecovery,
  recordWorkingStateSnapshot,
  flushSessionEventLogStrict,
  resumedToolRecoveryGuidance,
  operationFingerprint,
  requiresRecoveredOutcomeReconciliation,
  type SessionEventLog,
} from './sessionEvents.js';
import {
  captureApprovedObservation,
  resolveObservation,
  type ObservationRefV1,
} from '../evidence/observationStore.js';
import {
  installContextCheckpoint,
  prepareContextCheckpoint,
  validateContextCheckpoint,
  type ContextCheckpointInstalledLineageV1,
  type ContextCheckpointLineageEvidenceV1,
  type ContextCheckpointOwnerV1,
  type ContextCheckpointPreparationInputV1,
  type ContextCheckpointPreparationResultV1,
  type ContextCheckpointV1,
  type LiveOperationalSourcesV1,
} from '../runtime/contextCheckpoints.js';
import type { AdmissionStore } from '../runtime/admission.js';
import { ADMISSION_REASONS } from '../runtime/admissionContracts.js';
import { projectDurableToolBatch } from './toolExecutionIdentity.js';
import { captureSessionEventAppendFailure } from './sessionEventDiagnostics.js';
import { buildRepoMapPreamble } from './repoMapPreamble.js';
import { getChatApprovalSession } from './chatApproval.js';
import { remoteMcpFailClosedObservation, remoteMcpIsFailClosed } from '../bridge/remoteApproval.js';
import { deriveSubagentApprovalSession } from './approvalRequests.js';
import {
  assertChildApprovalWithinParent,
  getExecutionContext,
  runWithExecutionContext,
  scopeAsyncGenerator,
  type ExecutionContext,
} from './executionContext.js';
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
  attachTerminalReason,
  buildPolicyTerminalBlockedReport,
  resolveInvestigateHardCapObserveOnly,
  type ExploreFuseResult,
} from './chatZeroWritePolicy.js';
import { PolicyEventLog, type PolicyEvent } from './policyEventLog.js';
import {
  terminalReasonFromClassification,
  terminalReasonFromFailureText,
  terminalReasonFromOutcome,
  terminalReasonFromVerifierFailure,
  type TerminalReason,
} from './chatTerminalReason.js';
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
  outcomeFromReasonCode,
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
    unknownChargeCount?: number;
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
  /** Owner-scoped faults mirrored when an owner-receipt write fails. */
  accountingFaults?: OwnerAccountingFault[];
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
  const accountingFaults = candidate['accountingFaults'] === undefined
    ? []
    : parseOwnerAccountingFaults(candidate['accountingFaults']);
  if (accountingFaults === null) return null;
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
      unknownChargeCount: isNonNegativeFinite(consumedRecord['unknownChargeCount'])
        ? consumedRecord['unknownChargeCount'] : 1,
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
    ...(accountingFaults.length > 0 ? { accountingFaults } : {}),
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
  /**
   * Internal: the submission generation already assigned by the caller
   * (`submitMessage`). The stream body adopts it instead of incrementing so
   * the non-streaming presentation guards and the ownership guards agree on
   * one generation. Not part of the public contract.
   */
  submissionGeneration?: number;
}

import { deniesReadOnlyChatAction, filterReadOnlyChatTools, isReadOnlyChat, resolveChatRangePath } from './chatReadOnly.js';

/**
 * Version label for the chat tool surface offered to admitted commands. Part
 * of the canonical admission digest; bump when the offered chat tool schema
 * changes so a digest can never call two different tool surfaces "the same
 * admitted command".
 */
const CHAT_ADMISSION_TOOL_SCHEMA_VERSION = 'chat-tools-v1';

/**
 * R1/T5: placeholder compiled-request identity for the side-effect-free
 * candidate prepare. The real identity can only be computed after this turn's
 * provider messages are rebuilt from the candidate (the identity hashes that
 * exact message sequence), and `installP11ContextCheckpoint` always
 * re-prepares from the live sources with the real identity — so this marker is
 * never installed and never becomes durable authority.
 */
const PENDING_COMPILED_REQUEST_IDENTITY = 'pending-compiled-request-identity';

/**
 * P05: this engine's admitted command claim. `settled` flips at command
 * settlement (terminal stream, cancellation, replacement, or session close);
 * a live (unsettled) claim matching the durable owner row is the ONLY
 * authority under which this engine may install a P11 checkpoint.
 */
interface ChatEngineAdmissionClaim {
  threadId: string;
  commandId: string;
  generation: number;
  token: string;
  /** The submission generation this claim was admitted for (wrapper capture). */
  submissionGeneration: number;
  settled: boolean;
}

export interface ChatEngineOptions {
  instructionRoot?: string;
  /** Trusted embedding seam: pins all inference phases to one observed runner. */
  providerRunner?: DeepInfraApiRunner;
  /** Immutable policy for a trusted embedded provider, never model-supplied. */
  providerPolicy?: ResolvedModelPolicy;
  task: string;
  projectRoot: string;
  runId?: string;
  /** Existing P05 durable owner/fencing authority supplied by the host. */
  admissionStore?: AdmissionStore;
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
  /**
   * Test-only: deterministic overrides threaded into the child sub-agent
   * lanes so lifecycle races can be driven through the real child
   * dispatch/completion/application seam without a live provider. Production
   * callers never set this.
   */
  testChildLaneOverrides?: {
    useDeterministicMock?: boolean;
    actionResolver?: (prompt: string, round: number) => Promise<import('./actions.js').AgentAction[]>;
    executor?: import('./toolExecutor.js').ToolExecutor;
  };
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
      /** D03: structured terminal reason code (additive; outcome unchanged). */
      reason_code?: TerminalReasonCode;
      cause_class?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
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
      /** D03: structured terminal reason code. */
      reason_code?: TerminalReasonCode;
      cause_class?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
    }
  | {
      type: 'cancelled';
      status?: ChatStatus;
      outcome?: 'CANCELLED';
      turnTelemetry?: ChatTurnTelemetryRecord;
      /** D03: cancelled is a structured terminal reason too. */
      reason_code?: TerminalReasonCode;
      cause_class?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
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
  /** D03: structured terminal reason code; survives engine → payload → clients. */
  reason_code?: TerminalReasonCode;
  /** D03: separate model-vs-harness cause axis; null = not established. */
  cause_class?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
}

type ChatUsageScope = {
  taskOwnerId: string | null;
  projectRoot?: string;
  accountingEpoch: string;
  turnId: string | null;
  chargeId: string | null;
  requestId?: string;
  attemptId?: string;
  runDir?: string;
  modelId?: string;
  usageMetadata?: RunnerInvocationMetadata | null;
  ownerGeneration?: number;
  isOwnerCurrent?: () => boolean;
};

type OwnerAccountingFault = {
  taskOwnerId: string;
  ownerGeneration: number | null;
  accountingEpoch: string;
  chargeId: string | null;
  persistenceScope: 'owner-charge-receipt';
  kind: 'settlement-conflict' | 'persistence-failure';
  reason: string;
};

function parseOwnerAccountingFaults(value: unknown): OwnerAccountingFault[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((fault) => {
    if (fault === null || typeof fault !== 'object') return true;
    const entry = fault as Record<string, unknown>;
    return typeof entry['taskOwnerId'] !== 'string' ||
      !(entry['ownerGeneration'] === null ||
        (typeof entry['ownerGeneration'] === 'number' && Number.isInteger(entry['ownerGeneration']))) ||
      typeof entry['accountingEpoch'] !== 'string' ||
      !(entry['chargeId'] === null || typeof entry['chargeId'] === 'string') ||
      entry['persistenceScope'] !== 'owner-charge-receipt' ||
      !['settlement-conflict', 'persistence-failure'].includes(String(entry['kind'])) ||
      typeof entry['reason'] !== 'string';
  })) return null;
  return value as OwnerAccountingFault[];
}

function captureUsageAttribution(
  scope: ChatUsageScope,
  chargeId = scope.chargeId,
  requestId?: string,
  attemptId?: string,
): UsageAttribution | undefined {
  if (!scope.taskOwnerId || !chargeId) return undefined;
  // Explicit undefined means omission; inherit only when the argument is absent.
  const capturedRequestId = arguments.length < 3 ? scope.requestId : requestId;
  const capturedAttemptId = arguments.length < 4 ? scope.attemptId : attemptId;
  return Object.freeze({
    taskOwnerId: scope.taskOwnerId,
    chargeId,
    accountingEpoch: scope.accountingEpoch,
    ...(scope.turnId ? { turnId: scope.turnId } : {}),
    ...(capturedRequestId ? { requestId: capturedRequestId } : {}),
    ...(capturedAttemptId ? { attemptId: capturedAttemptId } : {}),
    ...(scope.projectRoot
      ? { projectRoot: scope.projectRoot, projectRootVersion: 1 as const }
      : {}),
  });
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
    if (entry.stdout && ['read_file', 'read_range', 'grep', 'glob', 'list_dir'].includes(entry.tool)) {
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

/** Only these tools carry inspectable content that can localize a failure. */
const CONTENT_BEARING_INSPECTION_TOOLS = new Set<string>(RECOVERY_EVIDENCE_TOOLS);

/**
 * A discriminating observation is not a boolean claim. It must be
 * content-bearing, must localize a target already implicated by the failure
 * (or by the mutation that preceded it), and must not repeat an observation the
 * gate has already consumed. A directory listing or a pattern-only search can
 * never clear the gate.
 */
function isDiscriminatingInspectionEvidence(
  state: WorkingState,
  action: { type: string; path?: string | undefined; pattern?: string | undefined; file_path?: string | undefined },
  physicalTarget: string | null,
  binding: RecoveryCandidateBinding | null,
  observationDigest: string,
): { discriminating: boolean; provenance?: RecoveryEvidenceProvenance } {
  const gate = state.recoveryGate;
  if (!gate || gate.satisfied) return { discriminating: false };
  if (!gate.binding || !binding || !sameRecoveryBinding(gate.binding, binding)) return { discriminating: false };
  if (!CONTENT_BEARING_INSPECTION_TOOLS.has(action.type)) return { discriminating: false };
  if (!physicalTarget || !observationDigest) return { discriminating: false };
  // Require a concrete inspected path. A `grep` without an explicit path is a
  // repository-wide search and cannot localize the failure.
  const candidate = action.type === 'read_range' ? action.file_path : action.path;
  if (!candidate) return { discriminating: false };
  const failingTargets = gate.failingTargets ?? state.failureSurface?.failingFiles ?? [];
  if (!targetMatchesGate(physicalTarget, failingTargets)) return { discriminating: false };
  const provenance: RecoveryEvidenceProvenance = {
    tool: action.type,
    target: physicalTarget,
    failureSignature: gate.failureSignature,
    binding,
    observationDigest,
  };
  const key = recoveryEvidenceKey(provenance, gate.failureSignature);
  if (!key || (gate.observedKeys ?? []).includes(key) || state.consumedRecoveryEvidence.includes(key)) {
    return { discriminating: false };
  }
  return {
    discriminating: true,
    provenance,
  };
}

/**
 * R0-10: presentation callbacks are an observational side channel. A throwing
 * host callback must never unwind the settlement path — that would both skip
 * real execution bookkeeping and let the settlement catch append a duplicate
 * execution-truth row. Wrap every callback so a throw is logged and ignored.
 */
const PRESENTATION_CALLBACK_KEYS = [
  'onToolStart',
  'onToolComplete',
  'onFileChanged',
  'onSubAgentStart',
  'onSubAgentComplete',
  'onSubAgentFailed',
] as const;

export function wrapPresentationCallbacks(callbacks: ChatCallbacks): ChatCallbacks {
  const wrapped: Record<string, unknown> = { ...callbacks };
  for (const key of PRESENTATION_CALLBACK_KEYS) {
    const fn = (callbacks as unknown as Record<string, unknown>)[key];
    if (typeof fn === 'function') {
      wrapped[key] = (...args: unknown[]): unknown => {
        try {
          return (fn as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
          console.error(
            `[chatEngine] presentation callback ${key} failed (ignored):`,
            err,
          );
          return undefined;
        }
      };
    }
  }
  return wrapped as unknown as ChatCallbacks;
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
  private recoveryStatePersistenceUnavailable = false;
  /** P11 A11a: exact approved observation refs retained for the installed context. */
  private p11ObservationRefs: ObservationRefV1[] = [];
  private p11ObservationCaptureIssues: string[] = [];
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
  /** Owner-bound accounting faults travel with the existing owner charge receipt checkpoint. */
  private readonly ownerAccountingFaults = new Map<string, OwnerAccountingFault[]>();
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
   * of each submission (submitMessage and, on the direct streaming path,
   * submitMessageStreamBody). Streaming callbacks check this value to
   * prevent stale callbacks from a cancelled/aborted request from
   * affecting the current turn.
   */
  private generationCounter = 0;
  /**
   * R0-7/R0-8: the submission generation whose generator is currently
   * executing. Async continuations capture this value when they start and
   * compare it before writing engine state, so work started under an older
   * submission can never apply to the task that now owns the engine.
   * Projected from `generationCounter`; not a second authority.
   */
  private activeSubmissionGeneration = 0;
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

  /** P05: per-instance namespace so admitted command ids never collide across restarts. */
  private readonly admissionEpoch: string = randomUUID();
  /** P05: the (generation, token) lease this engine was last admitted under. */
  private admissionLease: { generation: number; token: string } | null = null;
  /** P05: live admitted claim for the in-flight submission, if any. */
  private activeAdmissionClaim: ChatEngineAdmissionClaim | null = null;

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

  /** A task can be retired while its provider still reports a billable result. */
  private ownerChargeDir(runDir = this.engineRunDir): string {
    return join(runDir, 'task-charges');
  }

  private ownerChargePath(ownerId: string, runDir = this.engineRunDir): string {
    const name = createHash('sha256').update(ownerId).digest('hex');
    return join(this.ownerChargeDir(runDir), `${name}.json`);
  }

  private recordOwnerAccountingFault(
    scope: ChatUsageScope,
    kind: OwnerAccountingFault['kind'],
    reason: string,
    appliesToCurrent: boolean,
  ): void {
    const ownerId = scope.taskOwnerId;
    if (!ownerId) {
      if (appliesToCurrent) this.taskCostScopeUnavailable = true;
      return;
    }
    const fault: OwnerAccountingFault = {
      taskOwnerId: ownerId,
      ownerGeneration: scope.ownerGeneration ?? null,
      accountingEpoch: scope.accountingEpoch,
      chargeId: scope.chargeId,
      persistenceScope: 'owner-charge-receipt',
      kind,
      reason,
    };
    const faults = this.ownerAccountingFaults.get(ownerId) ?? [];
    if (!faults.some((existing) => JSON.stringify(existing) === JSON.stringify(fault))) {
      faults.push(fault);
      this.ownerAccountingFaults.set(ownerId, faults);
    }
    if (appliesToCurrent && ownerId === this.taskAllowance?.taskOwnerId) {
      this.taskCostScopeUnavailable = true;
    }
    this.persistOwnerAccountingFaultCheckpoint();
  }

  /**
   * Mirror owner-scoped faults into the existing task allowance checkpoint.
   * This is a fallback when an owner receipt write fails, not a new ledger. A
   * retired owner's fault remains visible after restart without blocking the
   * currently admitted successor.
   */
  private persistOwnerAccountingFaultCheckpoint(): void {
    if (!this.taskAllowance) return;
    const accountingFaults = [...this.ownerAccountingFaults.values()].flat();
    if (accountingFaults.length === 0) return;
    this.taskAllowance.accountingFaults = accountingFaults;
    try {
      const path = join(this.engineRunDir, 'task-budget.json');
      const tmpPath = `${path}.tmp-${randomUUID()}`;
      writeFileSync(tmpPath, JSON.stringify(this.taskAllowance), 'utf8');
      renameSync(tmpPath, path);
    } catch {
      // The live owner remains fail-closed. If both established checkpoints
      // are unavailable, a cold process cannot recover an unpersisted fault.
    }
  }

  private persistOwnerCharges(ownerId: string, runDir = this.engineRunDir): void {
    const summary = globalCostTracker.getTaskSummary(ownerId);
    const chargeIds = globalCostTracker.getTaskChargeIds(ownerId);
    const chargeObservations = globalCostTracker.getTaskChargeObservations(ownerId);
    // An old ID-only snapshot cannot safely be rewritten as a complete
    // receipt ledger. Keep its task budget conservative on this path.
    if (chargeObservations.length !== chargeIds.length) {
      throw new Error('Owner charge receipts are incomplete');
    }
    const dir = this.ownerChargeDir(runDir);
    mkdirSync(dir, { recursive: true });
    const path = this.ownerChargePath(ownerId, runDir);
    const tmpPath = `${path}.tmp-${randomUUID()}`;
    writeFileSync(tmpPath, JSON.stringify({
      schemaVersion: 1,
      taskOwnerId: ownerId,
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      totalCostUSD: summary.totalCostUSD,
      unknownChargeCount: summary.unknownChargeCount ?? 0,
      chargeIds,
      chargeObservations,
      accountingFaults: this.ownerAccountingFaults.get(ownerId) ?? [],
    }), 'utf8');
    renameSync(tmpPath, path);
  }

  private restoreOwnerCharges(runDir: string): boolean {
    const dir = this.ownerChargeDir(runDir);
    if (!existsSync(dir)) return true;
    try {
      for (const name of readdirSync(dir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const raw: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (raw === null || typeof raw !== 'object') throw new Error('Invalid owner charge file');
        const data = raw as Record<string, unknown>;
        if (data['schemaVersion'] !== 1 ||
            typeof data['taskOwnerId'] !== 'string' ||
            name !== `${createHash('sha256').update(data['taskOwnerId']).digest('hex')}.json` ||
            !Array.isArray(data['chargeIds']) ||
            !Array.isArray(data['chargeObservations']) ||
            typeof data['totalCostUSD'] !== 'number' ||
            typeof data['unknownChargeCount'] !== 'number') {
          throw new Error('Invalid owner charge file');
        }
        const accountingFaults = parseOwnerAccountingFaults(data['accountingFaults'] ?? []);
        if (!accountingFaults || accountingFaults.some((fault) => fault.taskOwnerId !== data['taskOwnerId'])) {
          throw new Error('Invalid owner accounting fault');
        }
        if (accountingFaults.length > 0) {
          this.ownerAccountingFaults.set(data['taskOwnerId'], accountingFaults as OwnerAccountingFault[]);
        }
        globalCostTracker.restoreTaskUsage(data['taskOwnerId'], {
          totalCostUSD: data['totalCostUSD'],
          unknownChargeCount: data['unknownChargeCount'],
          chargeIds: data['chargeIds'] as string[],
          chargeObservations: data['chargeObservations'] as ChargeReceipt[],
        });
      }
      return true;
    } catch {
      return false;
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
      this.taskAllowance.consumed.unknownChargeCount =
        globalCostTracker.getTaskSummary(this.taskAllowance.taskOwnerId).unknownChargeCount ?? 0;
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
      const ownerFaults = [...this.ownerAccountingFaults.values()].flat();
      if (ownerFaults.length > 0) this.taskAllowance.accountingFaults = ownerFaults;
      else delete this.taskAllowance.accountingFaults;
      this.persistOwnerCharges(this.taskAllowance.taskOwnerId);
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
      consumed: { costUsd: 0, unknownChargeCount: 0, activeWallMs: 0, turns: 0 },
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
    for (const fault of persisted?.accountingFaults ?? []) {
      const faults = this.ownerAccountingFaults.get(fault.taskOwnerId) ?? [];
      if (!faults.some((existing) => JSON.stringify(existing) === JSON.stringify(fault))) faults.push(fault);
      this.ownerAccountingFaults.set(fault.taskOwnerId, faults);
    }
    this.taskCostScopeUnavailable = persisted === null || persisted.lastTurnRuntime === undefined ||
      this.ownerAccountingFaults.has(persisted.taskOwnerId);
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
      unknownChargeCount: persisted.consumed.unknownChargeCount ?? 1,
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
    if (options.admissionStore) this.parity.admissionStore = options.admissionStore;
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
    const chargeFilesValid = !options.resumeExisting || this.restoreOwnerCharges(this.engineRunDir);
    if (options.resumeExisting) this.restorePersistedTaskBudget(persistedTaskBudget);
    else {
      this.taskAllowance = this.createTaskAllowance();
      this.taskCostBaselineUsd = this.taskAllowance.taskCostBaselineUsd;
    }
    if (!chargeFilesValid) this.taskCostScopeUnavailable = true;
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

  private criticState(
    onThought: ((msg: string) => void) | undefined,
    ownerGeneration: number,
  ): AsymmetricCriticState {
    const conversation = this.conversation.map((message) => ({ ...message }));
    const toolCallLog = this.toolCallLog.map((entry) => ({
      ...entry,
      ...(entry.mutation_paths ? { mutation_paths: [...entry.mutation_paths] } : {}),
    }));
    const isOwnerCurrent = (): boolean => this.isSubmissionCurrent(ownerGeneration);
    const usageScope = {
      taskOwnerId: this.taskAllowance?.taskOwnerId ?? null,
      projectRoot: realpathSync(this.options.projectRoot),
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: this.parity.turnId,
      chargeId: null as string | null,
      ownerGeneration,
      isOwnerCurrent,
    };
    return {
      toolCallLog,
      conversation,
      projectRoot: this.options.projectRoot,
      task: this.options.task,
      lastVerifierReceipt: this.lastVerifierReceipt
        ? { ...this.lastVerifierReceipt }
        : null,
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
        conversationState: conversation,
        userTaskPrompt: this.options.task,
        // The critic receives a synthesized text prompt, not provider-native
        // tool messages. Record that boundary explicitly so preservation is
        // determinable even when the run had earlier tool calls.
        expectedPriorEventIds: [],
        deliveredPriorEventIds: [],
        executionStage: 'critic',
        usageScope,
        isOwnerCurrent,
      }),
      trackRunnerUsage: (runner) => {
        this.trackRunnerUsage(runner, usageScope);
      },
      ...(onThought
        ? {
            onThought: (message: string) => {
              if (isOwnerCurrent()) onThought(message);
            },
          }
        : {}),
    };
  }

  private applyCriticState(
    state: AsymmetricCriticState,
    ownerGeneration: number,
    conversationStart: number,
  ): boolean {
    if (!this.isSubmissionCurrent(ownerGeneration)) return false;
    this.lastCriticReceipt = state.lastCriticReceipt;
    this.criticStrikes = state.criticStrikes;
    this.criticRunner = state.criticRunner;
    this.criticProRunner = state.criticProRunner;
    this.conversation.push(...state.conversation.slice(conversationStart));
    return true;
  }

  private async runAsymmetricDiffCritic(
    answer: string,
    callbacks: ChatCallbacks,
    taskIntent: TaskIntent,
    opts?: { terminal?: boolean },
  ): Promise<'allow' | 'reject' | 'block'> {
    const criticSpan = this.currentTurnTelemetry?.startCriticSpan();
    const ownerGeneration = this.activeSubmissionGeneration;
    const conversationStart = this.conversation.length;
    try {
      const state = this.criticState(callbacks.onThought, ownerGeneration);
      const decision = await runAsymmetricDiffCriticImpl(state, answer, taskIntent, opts);
      if (!this.applyCriticState(state, ownerGeneration, conversationStart)) return 'allow';
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
    ownerGeneration?: number,
  ): Promise<ChatResult | null> {
    // Tier A2: Record budget kill event
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: 'budget_kill',
      detail: reason.slice(0, 200),
    });
    if (this.terminatingLimiter !== 'cost' && !this.budgetLastChanceDone &&
        this.hasAnyWrites() && isDiffCriticEnabled()) {
      this.budgetLastChanceDone = true;
      callbacks.onThought?.('[Budget: last-chance critic before kill…]');
      const critic = await this.runAsymmetricDiffCritic(
        `Budget last-chance review: ${reason}`,
        callbacks,
        taskIntent,
        { terminal: true },
      );
      // R0-8: the last-chance critic is a suspension point. If the submission
      // was superseded while it ran, do not finalize or budget-kill the task
      // that now owns the engine; the caller returns without a terminal.
      if (ownerGeneration !== undefined && !this.isSubmissionCurrent(ownerGeneration)) {
        return null;
      }
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
          undefined,
          undefined,
          ownerGeneration,
        );
      }
    }

    if (ownerGeneration !== undefined && !this.isSubmissionCurrent(ownerGeneration)) {
      return null;
    }
    this.budgetExceeded = true;
    return this.buildResult(
      'budget_exhausted',
      callbacks,
      formatBudgetKillAnswer(reason, this.toolCallLog, this.lastCriticReceipt?.verdict ?? null),
      undefined,
      undefined,
      undefined,
      ownerGeneration,
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

  private checkBudgets(skipTurnLimit = false): { ok: boolean; reason?: string; limiter?: ChatRunLimiter } {
    if (this.taskCostScopeUnavailable || !this.taskAllowance) {
      const reason = 'Cannot restore durable task cost scope for resumed run; refusing a fresh allowance.';
      this.terminatingLimiter = 'cost';
      this.terminalLimiterReason = reason;
      return { ok: false, reason, limiter: 'cost' };
    }
    if (!skipTurnLimit && this.taskAllowance.consumed.turns >= this.taskAllowance.grant.turnCap) {
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
    if (Number.isFinite(maxCostUsd) &&
        globalCostTracker.getTaskSummary(this.taskAllowance.taskOwnerId).costComplete === false) {
      const reason = 'Task cost is incomplete because a provider charge has unknown pricing; refusing paid dispatch under a finite dollar cap.';
      this.terminatingLimiter = 'cost';
      this.terminalLimiterReason = reason;
      return { ok: false, reason, limiter: 'cost' };
    }
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
    // R0-7/R0-8: publish the owning generation synchronously so any async
    // continuation during this submission (including before the lazy stream
    // body first runs) is bound to it.
    this.activeSubmissionGeneration = generation;

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
      /** D03: structured reason from the terminal event. */
      reason_code?: TerminalReasonCode;
      cause_class?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
    } | null = null;

    try {
      for await (const event of this.submitMessageStream(userInput, taskIntent, {
        submissionGeneration: generation,
      })) {
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
              ...(event.reason_code !== undefined ? { reason_code: event.reason_code } : {}),
              ...(event.cause_class !== undefined ? { cause_class: event.cause_class } : {}),
            };
            break;
          case 'failed':
            terminal = {
              kind: 'failed',
              error: event.error,
              ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
              ...(event.reason_code !== undefined ? { reason_code: event.reason_code } : {}),
              ...(event.cause_class !== undefined ? { cause_class: event.cause_class } : {}),
            };
            break;
          case 'cancelled':
            terminal = {
              kind: 'cancelled',
              ...(event.reason_code !== undefined ? { reason_code: event.reason_code } : {}),
              ...(event.cause_class !== undefined ? { cause_class: event.cause_class } : {}),
            };
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
      return this.buildResult(
        'failed',
        cb,
        message,
        undefined,
        classifyFailureText(message),
        undefined,
        generation,
      );
    }

    if (!terminal) {
      return this.buildResult(
        'failed',
        cb,
        'Stream ended without a terminal event — possible internal error',
        undefined,
        undefined,
        undefined,
        generation,
      );
    }
    // D03: carry the terminal event's explicit reason into the sync result path.
    const reasonFromTerminal: TerminalReason | undefined =
      terminal.reason_code !== undefined
        ? { code: terminal.reason_code, cause_class: terminal.cause_class ?? null }
        : undefined;
    if (terminal.kind === 'cancelled') {
      return this.buildResult(
        'cancelled',
        cb,
        undefined,
        undefined,
        undefined,
        undefined,
        generation,
      );
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
          reasonFromTerminal,
          generation,
        );
      }
      if (
        failedOutcome === 'BLOCKED_POLICY' ||
        failedOutcome === 'BLOCKED_EXTERNAL' ||
        failedOutcome === 'NEEDS_HUMAN_DECISION' ||
        failedOutcome === 'INVALID_TASK'
      ) {
        return this.buildResult(
          'blocked',
          cb,
          terminal.error ?? 'Stream failed',
          undefined,
          failedOutcome,
          reasonFromTerminal,
          generation,
        );
      }
      return this.buildResult(
        'failed',
        cb,
        terminal.error ?? 'Stream failed',
        undefined,
        failedOutcome,
        reasonFromTerminal,
        generation,
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
      reasonFromTerminal,
      generation,
    );
  }

  /** #1 Async generator: yields typed ChatEvents as the conversation progresses.
   *  Callers use `for await (const event of engine.submitMessageStream(...))`.
   *  Uses executeRawStream() for true chunk-by-chunk streaming.
   *
   *  S04/#214 C1: every step runs inside this turn's execution context, and the
   *  context is scoped per step (`scopeAsyncGenerator`), so no execution context
   *  survives a completed turn. */
  submitMessageStream(
    userInput: string,
    taskIntent?: TaskIntent,
    submitOpts?: SubmitMessageOptions,
  ): AsyncGenerator<ChatEvent, void, undefined> {
    return scopeAsyncGenerator(
      () => this.buildBaseExecutionContext(),
      this.submitMessageStreamBody(userInput, taskIntent, submitOpts),
    );
  }

  /**
   * P05 admission wrapper around the execution loop: admit THIS authorized
   * command BEFORE the loop runs — the production admission site, so every
   * P11 checkpoint install inside the loop is already fenced to this engine's
   * own admitted identity — and settle the claim when the stream terminates,
   * including cancellation, failure, and consumer abandonment (`finally` runs
   * on generator return/throw). A superseded claim was already settled (and
   * its generation advanced) by the replacement submission's admission.
   */
  private async *submitMessageStreamBody(
    userInput: string,
    taskIntent?: TaskIntent,
    submitOpts?: SubmitMessageOptions,
  ): AsyncGenerator<ChatEvent, void, undefined> {
    const submissionGeneration =
      submitOpts?.submissionGeneration ?? ++this.generationCounter;
    // Capture THIS wrapper's own claim: the finally must settle this exact
    // claim, never `activeAdmissionClaim` — during task replacement that slot
    // belongs to the successor, and settling it would record a false terminal
    // for a command that is still executing (stripping its install authority).
    const claim = this.admitCurrentSubmission(submissionGeneration, userInput);
    try {
      yield* this.submitMessageStreamLoop(userInput, taskIntent, {
        ...submitOpts,
        submissionGeneration,
      });
    } finally {
      this.settleClaimOnExit(claim);
    }
  }

  private async *submitMessageStreamLoop(
    userInput: string,
    taskIntent?: TaskIntent,
    submitOpts?: SubmitMessageOptions,
  ): AsyncGenerator<ChatEvent, void, undefined> {
    // R0-7/R0-8: every submission owns a distinct generation. The non-stream
    // adapter supplies the generation it already incremented; a direct
    // streaming caller gets a fresh one here (the admission wrapper above
    // pre-computes it, so this adopts rather than increments). All ownership
    // guards compare against this value, so a superseded generator can neither
    // continue the loop nor let a late async continuation write the new task's state.
    const submissionGeneration =
      submitOpts?.submissionGeneration ?? ++this.generationCounter;
    this.activeSubmissionGeneration = submissionGeneration;
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
    // S04/#214 C1: the turn's execution context is scoped per step by
    // `submitMessageStream` (scopeAsyncGenerator), so no context survives the
    // turn and no global turn id has to be set or restored here.

    // R4: Fire-and-forget repo map generation, awaited before first LLM call
    const repoMapPromise =
      this.repoMapCache === null
        ? this.generateRepoMap()
            .then((map) => {
              // R0-8: a repository map produced for a superseded submission
              // must not seed the current task's cached context.
              if (map && this.isSubmissionCurrent(submissionGeneration)) {
                this.repoMapCache = map;
              }
            })
            .catch(() => {
              /* best-effort */
            })
        : Promise.resolve();

    if (this.conversation.length === 1 || this.conversation[0]?.role !== 'system') {
      // R4: Await repo map first so it's included in the system prompt
      await repoMapPromise;
      // R0-8: the repo-map await is a suspension point; a superseded generator
      // must not install its system turn or active-execution ownership.
      if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
      // R0-8: a superseded generator must stop before it executes another
      // turn, settles execution, or emits a terminal for the new owner.
      if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
      // R0-8: the repo-map await is a suspension point; re-check ownership.
      if (!this.isSubmissionCurrent(submissionGeneration)) return;
      if (this._cancelled || this.abortController.signal.aborted) {
        // AC3: stream cancel path flushes disk (idempotent if cancel() already did)
        finalizeParityCancel(this.parity, this.engineRunDir);
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
        yield this.streamCancelled();
        return;
      }

      // Budget checks (P1): cost, wall-clock — honest receipts + last-chance critic
      if (this.terminatingLimiter === 'child_exhaustion') {
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
        const kill = await this.handleBudgetKill(
          this.terminalLimiterReason ?? 'Inherited child allowance exhausted.',
          { onThought: () => {} },
          effectiveIntent,
          submissionGeneration,
        );
        if (!kill || !this.isSubmissionCurrent(submissionGeneration)) return;
        yield this.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }
      const budget = this.checkBudgets();
      if (!budget.ok) {
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
        const kill = await this.handleBudgetKill(
          budget.reason ?? 'Budget limit exceeded.',
          { onThought: () => {} },
          effectiveIntent,
          submissionGeneration,
        );
        // AC3: every stream terminal goes through streamDone (buildResult already
        // finalized; streamDone finalize is idempotent on turn_ended).
        if (!kill || !this.isSubmissionCurrent(submissionGeneration)) return;
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
      const compactInfo = await this.compactIfNeeded(undefined, false, submissionGeneration);
      compactionSpan?.end();
      // R0-8: compaction is a suspension point; a superseded generator must not
      // rewrite the new task's working state or conversation.
      if (!this.isSubmissionCurrent(submissionGeneration)) return;
      if (compactInfo) {
        yield { type: 'context_compacted', ...compactInfo };
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
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

      if (this.conversation.some((message) => message.compactionCandidate === true ||
          (message.name === 'compaction_summary' && (message.role !== 'assistant' ||
            message.provenance !== 'model' || message.authoritative !== false)) ||
          (message.name === 'compaction_capsule' && (message.role !== 'system' ||
            message.provenance !== 'controller' || message.authoritative !== true)) ||
          (message.role === 'system' && (message.name === 'compaction_summary' ||
            message.provenance === 'model' || message.provenance === 'mixed' ||
            message.authoritative === false)))) {
        yield this.streamFailed('An uncommitted compaction candidate cannot authorize provider dispatch.');
        return;
      }

      const runner = this.resolveRoutedRunner();
      const useNativeTools = this.shouldUseNativeTools(runner);
      const useTextTools = !useNativeTools && this.shouldUseTextTools();
      const prompt = this.services.conversation.buildTurnPrompt({
        conversation: this.conversation,
        task: this.options.task,
        nativeTools: useNativeTools,
        textTools: useTextTools,
      });
      // WorkingState is mixed controller/model advisory context. Record the
      // exact revision before projecting provider messages so native warm and
      // cold requests share one durable source of model-visible truth.
      if (this.parity.turnId) {
        this.services.conversation.recordAssistantMessage(
          this.parity.eventLog,
          this.parity.turnId,
          formatWorkingStateBlock(this.workingState),
          {
            name: 'working_state',
            provenance: 'mixed',
            authoritative: false,
          },
        );
      }
      const activeSystemPrompt = this.getOrBuildSystemPrompt(
        useNativeTools ? 'native' : useTextTools ? 'text' : 'legacy',
      );
      const hadInstalledP11Context = this.parity.contextCheckpoint !== undefined;
      const usageScope = {
        taskOwnerId: this.taskAllowance?.taskOwnerId ?? null,
        projectRoot: realpathSync(this.options.projectRoot),
        accountingEpoch: globalCostTracker.getAccountingEpoch(),
        turnId: this.parity.turnId,
        chargeId: null as string | null,
        ownerGeneration: submissionGeneration,
        isOwnerCurrent: () => this.isSubmissionCurrent(submissionGeneration),
      };
      const settleRetiredUsage = (usedRunner: typeof runner): void => {
        if (!('usageMetadata' in usageScope)) Object.assign(usageScope, { usageMetadata: null });
        this.trackRunnerUsage(usedRunner, usageScope);
      };
      const requestMode = useNativeTools ? 'native' : useTextTools ? 'text' : 'legacy';
      const toolProfile = useNativeTools
        ? 'native-tools'
        : useTextTools
          ? 'text-tools'
          : 'legacy-tools';
      const modelRoute = `${providerName}:${modelName}`;
      // R1/T5 ordering invariant (task-5 brief): candidate compaction → durable
      // capsule commit (compactIfNeeded above) → validate/install the CURRENT
      // checkpoint → rebuild provider messages FROM THE INSTALLED AUTHORITY →
      // provider invocation. A durable capsule that the in-memory root does not
      // name (committed this turn, or by an earlier admission-recovery
      // iteration) makes the previous generation stale — rebuilding from it
      // would dispatch a superseded sequence (the routed Task-4 trace). The
      // candidate below is a side-effect-free prepare: it never installs and
      // never authorizes a dispatch by itself — it only roots the rebuild that
      // computes this turn's route identity. `installP11ContextCheckpoint`
      // remains the single authority swap, and the dispatched messages are
      // re-projected from the INSTALLED checkpoint below. If the install cannot
      // happen while authority is pending/promoted, dispatch is refused — a
      // stale root never authorizes a request.
      const pendingCapsuleAuthority = this.hasPendingCompactionAuthority();
      const turnCheckpointCandidate =
        useNativeTools && (pendingCapsuleAuthority || hadInstalledP11Context)
          ? this.prepareP11ContextCheckpointCandidate({
              tool_profile: toolProfile,
              model_route: modelRoute,
            })
          : null;
      const rebuildRoot =
        turnCheckpointCandidate?.status === 'prepared'
          ? turnCheckpointCandidate.checkpoint
          : this.parity.contextCheckpoint;
      let providerMessages = useNativeTools
        ? this.services.conversation.rebuildProviderMessages(this.parity.eventLog, {
            systemPrompt: activeSystemPrompt,
            ...(rebuildRoot ? { installedContextCheckpoint: rebuildRoot } : {}),
          })
        : [];
      const preparedRoute = {
        compiled_request_identity: createHash('sha256')
          .update(JSON.stringify({
            mode: requestMode,
            prompt,
            systemPrompt: activeSystemPrompt,
            providerMessages,
          }))
          .digest('hex'),
        tool_profile: toolProfile,
        model_route: modelRoute,
      } as const;
      const p11ContextInstalled = await this.installP11ContextCheckpoint(preparedRoute);
      // R0-8/R1: a superseded submission must not finalize the live turn as
      // failed nor dispatch a provider request for the new owner.
      if (!this.isSubmissionCurrent(submissionGeneration)) return;
      if (!p11ContextInstalled && (hadInstalledP11Context || pendingCapsuleAuthority)) {
        yield this.streamFailed(
          hadInstalledP11Context
            ? 'P11 context installation was blocked; the previous context generation remains authoritative and provider dispatch was refused.'
            : 'P11 context installation was blocked; this turn committed a compaction capsule that no installed context root authorizes, so provider dispatch was refused.',
        );
        return;
      }
      // Single authority: project the dispatched messages from the checkpoint
      // that is NOW installed (equal to the candidate-rooted array above by
      // construction — the reconstruction tripwire below verifies it).
      if (useNativeTools && p11ContextInstalled && this.parity.contextCheckpoint) {
        providerMessages = this.services.conversation.rebuildProviderMessages(
          this.parity.eventLog,
          {
            systemPrompt: activeSystemPrompt,
            installedContextCheckpoint: this.parity.contextCheckpoint,
          },
        );
      }
      if (useNativeTools && providerMessages.some((message) => message.name === 'compaction_capsule') &&
          !this.parity.contextCheckpoint) {
        yield this.streamFailed('An uninstalled compaction capsule cannot authorize provider dispatch.');
        return;
      }
      yield { type: 'thinking' };
      if (!this.isSubmissionCurrent(submissionGeneration)) return;
      // Compaction can itself consume a paid request after the turn-start
      // allowance check. Recheck cost and wall limits at the final dispatch
      // boundary without charging this already-admitted turn twice.
      const dispatchBudget = this.checkBudgets(true);
      if (!dispatchBudget.ok) {
        const kill = await this.handleBudgetKill(
          dispatchBudget.reason ?? 'Budget limit exceeded.',
          { onThought: () => {} },
          effectiveIntent,
          submissionGeneration,
        );
        if (!kill || !this.isSubmissionCurrent(submissionGeneration)) return;
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        yield this.streamDone(kill.answer, {
          ...(kill.blockedReport ? { blockedReport: kill.blockedReport } : {}),
          ...(kill.criticReceipt ? { criticReceipt: kill.criticReceipt } : {}),
          ...(kill.verifierTampered ? { verifierTampered: true as const } : {}),
        });
        return;
      }

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
              usageScope,
              isOwnerCurrent: () => this.isSubmissionCurrent(submissionGeneration),
            }),
          )) {
            if (!this.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(runner);
              return;
            }
            rawText += chunk;
            this.currentTurnTelemetry?.markFirstToken();
          }
          const providerEnd = performance.now();
          if (!this.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          this.trackRunnerUsage(runner, usageScope);
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          turnResult = parseTextToolTurn(rawText);
        } catch (err: any) {
          if (!this.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          const providerEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          const admissionRecovery = await this.recoverPreparedRequestAdmission(err, submissionGeneration);
          if (admissionRecovery) {
            yield { type: 'context_compacted', ...admissionRecovery };
            continue;
          }
          endSpan(_turnSpan, SpanStatusCode.ERROR);
          _turnSpan = null;
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          const cancelled = this.emitCancelledIfOperatorAbort(err);
          if (cancelled) {
            yield cancelled;
            return;
          }
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
              usageScope,
              isOwnerCurrent: () => this.isSubmissionCurrent(submissionGeneration),
            }),
          )) {
            if (!this.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(runner);
              return;
            }
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
          if (!this.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          this.trackRunnerUsage(runner, usageScope);
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          this._streamNativeToolCallIds = nativeToolCallIds;
          streamedAnswerForTurn = answerText;
          turnResult = nativeTurnFromStream({
            answerText,
            actions: nativeActions,
            finishReason: nativeFinishReason,
          });
        } catch (err: any) {
          if (!this.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          const providerEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, providerEnd - providerStart),
            providerStart,
            providerEnd,
          );
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
            const admissionRecovery = await this.recoverPreparedRequestAdmission(err, submissionGeneration);
          if (admissionRecovery) {
            yield { type: 'context_compacted', ...admissionRecovery };
            continue;
          }
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          const fb = yield* this.resolveFallbackOrFail(err, turn, submissionGeneration);
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          if (!fb) {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            return;
          }
          if (typeof fb.executeWithToolsStream !== 'function') {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
                usageScope,
                isOwnerCurrent: () => this.isSubmissionCurrent(submissionGeneration),
              }),
            )) {
              if (!this.isSubmissionCurrent(submissionGeneration)) {
                settleRetiredUsage(fb);
                return;
              }
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
            if (!this.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(fb);
              return;
            }
            this.currentTurnTelemetry?.recordProviderSpan(
              Math.max(0, fbEnd - fbStart),
              fbStart,
              fbEnd,
            );
            this.trackRunnerUsage(fb, usageScope);
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
            this._streamNativeToolCallIds = nativeToolCallIds;
            streamedAnswerForTurn = answerText;
            turnResult = nativeTurnFromStream({
              answerText,
              actions: nativeActions,
              finishReason: nativeFinishReason,
            });
          } catch (fbErr: any) {
            if (!this.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(fb);
              return;
            }
            const fbEnd = performance.now();
            this.currentTurnTelemetry?.recordProviderSpan(
              Math.max(0, fbEnd - fbStart),
              fbStart,
              fbEnd,
            );
            // If tools still fail, degrade to raw-text (buffered — the lenient
            // parser may transform the final answer; not append-compatible).
            yield { type: 'thought', text: 'Retrying without tools…' };
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
                  usageScope,
                  isOwnerCurrent: () => this.isSubmissionCurrent(submissionGeneration),
                }),
              )) {
                if (!this.isSubmissionCurrent(submissionGeneration)) {
                  settleRetiredUsage(fb);
                  return;
                }
                rawText += chunk;
                this.currentTurnTelemetry?.markFirstToken();
              }
              const rawFbEnd = performance.now();
              if (!this.isSubmissionCurrent(submissionGeneration)) {
                settleRetiredUsage(fb);
                return;
              }
              this.currentTurnTelemetry?.recordProviderSpan(
                Math.max(0, rawFbEnd - rawFbStart),
                rawFbStart,
                rawFbEnd,
              );
              this.trackRunnerUsage(fb, usageScope);
              if (!this.isSubmissionCurrent(submissionGeneration)) return;
              turnResult = this.parseChatTurnLenient(rawText);
            } catch (rawErr: any) {
              if (!this.isSubmissionCurrent(submissionGeneration)) {
                settleRetiredUsage(fb);
                return;
              }
              const rawFbEnd = performance.now();
              this.currentTurnTelemetry?.recordProviderSpan(
                Math.max(0, rawFbEnd - rawFbStart),
                rawFbStart,
                rawFbEnd,
              );
              endSpan(_turnSpan, SpanStatusCode.ERROR);
              _turnSpan = null;
              if (!this.isSubmissionCurrent(submissionGeneration)) return;
              const cancelled = this.emitCancelledIfOperatorAbort(rawErr);
              if (cancelled) {
                yield cancelled;
                return;
              }
              if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
              usageScope,
              isOwnerCurrent: () => this.isSubmissionCurrent(submissionGeneration),
            }),
          )) {
            if (!this.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(runner);
              return;
            }
            rawText += chunk;
            this.currentTurnTelemetry?.markFirstToken();
          }
          const legacyEnd = performance.now();
          if (!this.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, legacyEnd - legacyStart),
            legacyStart,
            legacyEnd,
          );
          this.trackRunnerUsage(runner, usageScope);
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
        } catch (err: any) {
          if (!this.isSubmissionCurrent(submissionGeneration)) {
            settleRetiredUsage(runner);
            return;
          }
          const legacyEnd = performance.now();
          this.currentTurnTelemetry?.recordProviderSpan(
            Math.max(0, legacyEnd - legacyStart),
            legacyStart,
            legacyEnd,
          );
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
              const admissionRecovery = await this.recoverPreparedRequestAdmission(err, submissionGeneration);
          if (admissionRecovery) {
            yield { type: 'context_compacted', ...admissionRecovery };
            continue;
          }
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          const fb = yield* this.resolveFallbackOrFail(err, turn, submissionGeneration);
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
                usageScope,
                isOwnerCurrent: () => this.isSubmissionCurrent(submissionGeneration),
              }),
            )) {
              if (!this.isSubmissionCurrent(submissionGeneration)) {
                settleRetiredUsage(fb);
                return;
              }
              rawText += chunk;
              this.currentTurnTelemetry?.markFirstToken();
            }
            this.trackRunnerUsage(fb, usageScope);
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
          } catch (fbErr: any) {
            if (!this.isSubmissionCurrent(submissionGeneration)) {
              settleRetiredUsage(fb);
              return;
            }
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
            const cancelled = this.emitCancelledIfOperatorAbort(fbErr);
            if (cancelled) {
              yield cancelled;
              return;
            }
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
        // R0-8: a superseded generator must not install a terminal limiter on
        // the task that now owns the engine.
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
        this.terminatingLimiter = 'tokens';
        this.terminalLimiterReason =
          `Token explosion with zero mutations: ${streamExplosion.tokensThisTurn} tokens this turn (ceiling ${this.limits.maxTokensPerRound}).`;
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
        const kill = await this.handleBudgetKill(
          this.terminalLimiterReason,
          { onThought: () => {} },
          effectiveIntent,
          submissionGeneration,
        );
        if (!kill || !this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
            yield this.streamDone(turnResult.thinking, {
              blockedReport: thinkingBlocked,
            });
            return;
          }
        }

        // R0-8: a superseded generator must not reserve the new task's
        // tool-call identity or propose its tools.
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
        }, submissionGeneration);

        // R0-8: tools are a suspension point. If the submission was superseded
        // while they ran, stop before mutating the new owner's state or
        // emitting a terminal on its behalf.
        if (!this.isSubmissionCurrent(submissionGeneration)) return;

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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
        }

        await new Promise((resolve) => setImmediate(resolve));
        // R0-8: the setImmediate yield is a real suspension point — a second
        // submission can start here. A superseded generator must not update the
        // new task's progress counters, phase, or durable session events.
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          // R0-8: synthesis is a suspension point; a superseded generator must
          // not append to the new task's conversation.
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          // R0/W7: the tamper violation is established by the harness
          // (applyTamperEscalation at tamperCount >= 3), so the blocked report
          // is harness-origin and typed. Model prose may supply the answer text
          // but can no longer determine whether a block exists — a prose-only
          // path could emit a false `completed` terminal.
          const tamperBlocked = this.buildTamperBlockedReport();
          const finalTamperAnswer =
            tamperAnswer && /(?:^|\n)\s*BLOCKED\b/.test(tamperAnswer)
              ? tamperAnswer
              : `BLOCKED: Verifier integrity compromised — ${this.tamperCount} verifier dependency files were modified. The task cannot be completed honestly.`;
          this.conversation.push({
            role: 'assistant',
            content: finalTamperAnswer,
          });
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          yield this.streamDone(finalTamperAnswer, {
            blockedReport: tamperBlocked,
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
            // R0-8: synthesis is a suspension point; a superseded generator must
            // not append to the new task's conversation.
            if (!this.isSubmissionCurrent(submissionGeneration)) return;

            if (synthError || !synthAnswer?.trim()) {
              const failMsg = `Answer synthesis failed after inspection completed: ${synthError?.message ?? 'no answer generated'}`;
              this.conversation.push({ role: 'assistant', content: failMsg });
              yield { type: 'answer_chunk', text: failMsg };
              if (!this.isSubmissionCurrent(submissionGeneration)) return;
              yield this.streamDone(failMsg, {
                blockedReport: attachTerminalReason(
                  {
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
                  arb.terminalReason,
                ),
                ...(arb.terminalReason !== undefined ? { reason: arb.terminalReason } : {}),
              });
              return;
            }

            const finalAnswer = synthAnswer.trim();
            const synthBlocked = this.detectAndBuildBlockedReport(finalAnswer);
            this.conversation.push({ role: 'assistant', content: finalAnswer });
            yield { type: 'answer_chunk', text: finalAnswer };
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
            yield this.streamDone(finalAnswer, {
              blockedReport: synthBlocked ?? null,
              // D03: the arbiter reason survives even when the bounded synthesis
              // produced an informational answer rather than a blocked report.
              ...(arb.terminalReason !== undefined ? { reason: arb.terminalReason } : {}),
            });
            return;
          }

          // Prefer BLOCKED synthesis when stall kill and agent already diagnosed
          if (stallIntervention?.level === 'kill') {
            const killAnswer = await this.synthesizeAnswer(allToolObservations, {
              onAnswerChunk: (_chunk: string) => {},
            }).catch(() => '');
            // R0-8: synthesis is a suspension point; a superseded generator must
            // not append to the new task's conversation.
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
            const killBlocked = killAnswer ? this.detectAndBuildBlockedReport(killAnswer) : null;
            if (killBlocked) {
              this.conversation.push({
                role: 'assistant',
                content: killAnswer,
              });
              if (!this.isSubmissionCurrent(submissionGeneration)) return;
              yield this.streamDone(killAnswer, {
                blockedReport: killBlocked,
                // D03: this branch runs inside the arbiter-terminal block, so the
                // structured reason is known — do not let the reason degrade to
                // the outcome fallback.
                ...(arb.terminalReason !== undefined ? { reason: arb.terminalReason } : {}),
              });
              return;
            }
          }
          this.conversation.push({
            role: 'assistant',
            content: arb.terminalAnswer,
          });
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          yield this.streamDone(arb.terminalAnswer, {
            blockedReport: buildPolicyTerminalBlockedReport(
              arb.policySource ?? 'progress_terminal',
              arb.terminalAnswer,
              arb.terminalReason,
            ),
            ...(arb.terminalReason !== undefined ? { reason: arb.terminalReason } : {}),
          });
          return;
        }
        if (arb.policyMessage) {
          this.conversation.push({ role: 'user', content: arb.policyMessage });
          yield { type: 'thought', text: `[Policy: ${arb.policySource}]` };
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
          }
          this.conversation.push({ role: 'assistant', content: answer });
          _turnSpan.setAttribute('babel.chat.blocked', 'true');
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
          yield this.streamDone(tokenCeilingBlocked, {
            blockedReport: {
              schema_version: 1 as const,
              status: 'BLOCKED' as const,
              // R0/W7: harness-origin budget condition. Typed so
              // computeTerminalOutcome cannot fall through to the legacy prose
              // regex and fabricate external blame.
              reason_code: 'budget_exhausted' as const,
              cause_class: 'harness' as const,
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
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
            yield this.streamDone(textBlockedMsg, {
              blockedReport: {
                schema_version: 1 as const,
                status: 'BLOCKED' as const,
                // R0/W7: harness-origin stall/recovery terminal. Typed so
                // computeTerminalOutcome cannot fabricate external blame.
                reason_code: 'recovery_exhausted' as const,
                cause_class: 'harness' as const,
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
            if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
              if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
        // R0-8: the diff critic is a suspension point; a superseded generator
        // must not install critic receipts, strikes or repair budgets on the
        // task that now owns the engine.
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
        if (this.lastCriticReceipt) {
          yield {
            type: 'thought',
            text: `[Diff critic: ${this.lastCriticReceipt.verdict}]`,
          };
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
          if (!this.isSubmissionCurrent(submissionGeneration)) return;
        }
        this.conversation.push({ role: 'assistant', content: answer });
        _turnSpan.setAttribute('babel.chat.turn', `${turn + 1}:completion`);
        if (this.lastCriticReceipt) {
          _turnSpan.setAttribute('babel.chat.critic_verdict', this.lastCriticReceipt.verdict);
        }
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
    // R0-8: synthesis is a suspension point; a superseded generator must not
    // append to the new task's conversation.
    if (!this.isSubmissionCurrent(submissionGeneration)) return;
    this.conversation.push({ role: 'assistant', content: maxTurnAnswer });

    // R1: Check synthesized answer for BLOCKED before gate — must come
    // before the gate check since BLOCKED is a valid terminal outcome
    // that bypasses the write/verifier gate.
    const maxTurnBlockedReport = this.detectAndBuildBlockedReport(maxTurnAnswer);
    if (maxTurnBlockedReport) {
      if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
      // R0-8: terminal critic inference is a suspension point. Do not read
      // its receipt or emit any terminal evidence after ownership changes.
      if (!this.isSubmissionCurrent(submissionGeneration)) return;
      if (this.lastCriticReceipt) {
        yield {
          type: 'thought',
          text: `[Diff critic: ${this.lastCriticReceipt.verdict}]`,
        };
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
        if (!this.isSubmissionCurrent(submissionGeneration)) return;
        yield this.streamDone(blockedAnswer, {
          blockedReport: report,
          ...(this.lastCriticReceipt ? { criticReceipt: this.lastCriticReceipt } : {}),
        });
        return;
      }
    }
    if (!this.isSubmissionCurrent(submissionGeneration)) return;
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
      ...(this.parity.contextCheckpoint
        ? { installedContextCheckpoint: this.parity.contextCheckpoint }
        : {}),
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
    this.restoreRecoveryWorkingState(log);
    const repairGuidance = resumedToolRecoveryGuidance(this.parity.sessionEvents);
    if (
      repairGuidance &&
      !this.conversation.some((message) => message.content === repairGuidance)
    ) {
      this.conversation.push({ role: 'system', content: repairGuidance });
    }
    return interrupted;
  }

  private persistRecoveryWorkingState(): void {
    try {
      recordWorkingStateSnapshot(this.parity.sessionEvents, this.workingState, this.parity.turnId ?? null);
      flushSessionEventLogStrict(this.engineRunDir, this.parity.sessionEvents);
    } catch {
      // A settled tool must not throw into the generic settlement catch and
      // append a duplicate terminal. Future mutations fail closed instead.
      this.recoveryStatePersistenceUnavailable = true;
    }
  }

  private beginRecoveryLocalizationInspection(tool: string, rawTarget: string): boolean {
    const localization = this.workingState.localization;
    if (!localization || localization.phase === 'localized') return true;
    if (localization.phase === 'exhausted' || localization.calls >= 4 || localization.rounds >= 2) {
      this.workingState = applyWorkingStateEvent(this.workingState, {
        type: 'localization_update', localization: { ...localization, phase: 'exhausted' },
      });
      this.persistRecoveryWorkingState();
      return false;
    }
    const current = this.currentRecoveryBinding();
    if (!current || !sameRecoveryBinding(localization.binding, current)) {
      this.workingState = applyWorkingStateEvent(this.workingState, { type: 'recovery_candidate_drift' });
      this.persistRecoveryWorkingState();
      return false;
    }
    const target = recoveryTargetIdentity(this.options.projectRoot, rawTarget) ?? undefined;
    this.workingState = applyWorkingStateEvent(this.workingState, {
      type: 'localization_update',
      localization: beginLocalizationCall(localization, target),
    });
    this.persistRecoveryWorkingState();
    return true;
  }

  private finishRecoveryLocalizationInspection(input: {
    tool: string; rawTarget: string; content?: string; succeeded: boolean; startLine?: number; pattern?: string;
  }): void {
    const localization = this.workingState.localization;
    if (!localization || localization.phase !== 'LOCALIZE_FAILURE') return;
    const target = recoveryTargetIdentity(this.options.projectRoot, input.rawTarget) ?? undefined;
    const withCandidates = input.tool === 'glob' && input.succeeded && input.pattern && input.content
      ? discoverTestCandidates(localization, this.options.projectRoot, input.pattern, input.content)
      : localization;
    const updated = finishLocalizationCall(withCandidates, {
      type: input.tool, succeeded: input.succeeded, projectRoot: this.options.projectRoot,
      ...(target ? { target } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
    });
    this.workingState = applyWorkingStateEvent(this.workingState, { type: 'localization_update', localization: updated });
    if (updated.phase === 'localized' && updated.acceptedPath && updated.observationDigest && this.workingState.recoveryGate) {
      this.workingState = {
        ...this.workingState,
        recoveryGate: { ...this.workingState.recoveryGate, failingTargets: [updated.acceptedPath] },
      };
      this.workingState = applyWorkingStateEvent(this.workingState, {
        type: 'add_evidence', evidence: `${input.tool}:${updated.acceptedPath}`, discriminating: true,
        provenance: {
          tool: input.tool, target: updated.acceptedPath,
          failureSignature: updated.failureSignature, binding: updated.binding,
          observationDigest: updated.observationDigest,
        },
      });
    }
    this.persistRecoveryWorkingState();
  }

  private restoreRecoveryWorkingState(log: SessionEventLog): void {
    const latestSnapshot = [...log.events].reverse().find((event) => event.kind === 'working_state_snapshot');
    const latestVerifier = [...log.events].reverse().find((event) =>
      event.kind === 'verifier_attempt' && event.authoritative && event.exit_code !== undefined,
    );
    const latestSubmission = [...log.events].reverse().find((event) => event.kind === 'user_submitted');
    if (latestSubmission?.kind === 'user_submitted' && latestSubmission.continued_task === false &&
        (!latestSnapshot || latestSnapshot.seq < latestSubmission.seq) &&
        (!latestVerifier || latestVerifier.seq < latestSubmission.seq)) {
      this.workingState = createWorkingState(latestSubmission.task_preview);
      return;
    }
    if (latestSubmission?.kind === 'user_submitted' && latestSubmission.continued_task !== true &&
        latestSnapshot && latestSnapshot.seq < latestSubmission.seq) {
      this.workingState = applyWorkingStateEvent(createWorkingState(latestSubmission.task_preview), {
        type: 'recovery_gate',
        failureSignature: 'resumed-unknown-task-boundary',
        requiredEvidence: 'Rerun an authoritative verifier before recovery.',
      });
      return;
    }
    if (latestSnapshot?.kind === 'working_state_snapshot' &&
        (!latestVerifier || latestSnapshot.seq > latestVerifier.seq)) {
      const restored = restoreWorkingStateSnapshot(latestSnapshot.state);
      if (restored) {
        this.workingState = restored;
        return;
      }
    }
    if (latestSnapshot || (latestVerifier?.kind === 'verifier_attempt' && latestVerifier.exit_code !== 0)) {
      this.workingState = applyWorkingStateEvent(createWorkingState(this.options.task), {
        type: 'recovery_gate',
        failureSignature: 'resumed-unbound-red-verifier',
        requiredEvidence: 'Rerun the failed verifier to bind recovery to the current candidate.',
      });
    }
  }
  restoreSessionEventsFromDir(runDir?: string): number {
    const targetDir = runDir ?? this.engineRunDir;
    // R1 durability (6b-1): recover an interrupted checkpoint batch BEFORE the
    // session log is read, so a staged/abandoned artifact can never be
    // consumed as durable state. Idempotent no-op when no journal exists; a
    // malformed journal still fails closed (CHECKPOINT_JOURNAL_INVALID), now
    // before the reads it would otherwise corrupt.
    recoverCheckpointArtifacts(targetDir);
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

  /**
   * R0/D01: terminal read-only input must be the *accepted* operation for this
   * submission, not an ambient mode inference. `effectiveOperation` is resolved
   * once from TaskShape in `beginUserSubmission`; `isReadOnlyChat()` remains a
   * sufficient explicit read-only signal (BABEL_READ_ONLY / read_only_audit).
   *
   * Unknown/missing accepted runtime falls back to explicit-only behavior so a
   * legacy caller cannot be reinterpreted as "no change" merely by writing
   * nothing. A mutating accepted operation still requires a real verifier.
   */
  private isAcceptedReadOnlyTerminal(): boolean {
    return this.lastTurnRuntime?.effectiveOperation === 'READ_ONLY' || isReadOnlyChat();
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
      /** D03: explicit structured reason from the arbiter. */
      reason?: TerminalReason;
    },
  ) {
    this.settleActiveExecutionForTerminal();
    const hasMutation = this.hasAnyWrites();
    let requestedOutcome = computeTerminalOutcome({
      readOnly: this.isAcceptedReadOnlyTerminal(),
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
    const decisionOutcome =
      decision.finalOutcome === 'PLAN_COMPLETE' ? 'UNVERIFIED_PATCH' : decision.finalOutcome;
    const terminalReason = this.resolveTerminalReason(
      decisionOutcome,
      extra?.blockedReport,
      extra?.reason,
    );
    // R0-9: keep the tuple coherent. A read-only hard-cap that resolves a
    // `budget_exhausted` reason must not project `NO_CHANGE_REQUIRED` alongside
    // it. Exception: `verification_failed` legitimately pairs with
    // `UNVERIFIED_PATCH` on the completed path (the patch is recorded but not
    // verified); `outcomeFromReasonCode` carries the failed-path mapping
    // (AGENT_FAILURE), so the gate decision stays authoritative there.
    const reasonOutcome =
      terminalReason?.code && terminalReason.code !== 'verification_failed'
        ? outcomeFromReasonCode(terminalReason.code)
        : undefined;
    const outcome = reasonOutcome ?? decisionOutcome;
    {
      this.recordCompletionDecisionOnce({
        requestedOutcome: decision.requestedOutcome,
        finalOutcome: outcome,
        allowed: decision.allowed,
        reason: decision.reason,
        evidenceRefs: decision.evidenceRefs,
        policyVersion: decision.policyVersion,
        ...(terminalReason !== undefined
          ? { reasonCode: terminalReason.code, causeClass: terminalReason.cause_class }
          : {}),
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
      terminalReason,
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
      ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
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
    const classifiedOutcome = classifyFailureText(error) ?? limiterOutcome;
    const terminalReason =
      terminalReasonFromFailureText(error) ?? this.resolveTerminalReason(classifiedOutcome);
    // R0-9: status/outcome/reason_code/cause_class must form one coherent tuple.
    // The typed reason is the single authority; when it maps to an outcome, that
    // outcome wins over an independent text classifier that may disagree (e.g.
    // an unsupported-operation message that also matches an infra pattern).
    const outcome =
      (terminalReason?.code ? outcomeFromReasonCode(terminalReason.code) : undefined) ??
      classifiedOutcome;
    if (outcome === 'BUDGET_EXHAUSTED') this.budgetExceeded = true;
    const terminal = projectChatTerminal({
      ...(outcome !== undefined ? { outcome } : {}),
      status: 'failed',
    });
    const runAllowance = this.assembleRunAllowance(terminal.status);
    finalizeParityTurnSync(
      this.parity,
      this.engineRunDir,
      terminal.outcome,
      terminal.status,
      terminalReason,
    );
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
      ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
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
      reason_code: 'cancelled',
      cause_class: null,
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
    // A2 F2/A3: the host-injected durable admission store must survive the
    // parity rebuild — this is the primary event-log resume path
    // (construct without runId, then assignRunId).
    const admissionStore = this.parity.admissionStore;
    this.engineRunId = runId;
    this.parity = createParityRuntime(runId);
    if (authority) this.parity.liveAuthority = authority;
    if (admissionStore) this.parity.admissionStore = admissionStore;
    mkdirSync(this.engineRunDir, { recursive: true });
    const persistedTaskBudget = this.readPersistedTaskBudget(this.engineRunDir);
    const chargeFilesValid = this.restoreOwnerCharges(this.engineRunDir);
    this.restorePersistedTaskBudget(persistedTaskBudget);
    if (!chargeFilesValid) this.taskCostScopeUnavailable = true;
    this.persistTaskCostBaseline();
    if (authority) persistLiveSessionAuthority(this.engineRunDir, authority);
    this.failureBudgetTracker = createFailureBudgetTrackerFromContract(authority?.taskContract);
  }

  /**
   * Host seam: attach the durable P05 admission store once the engine's final
   * run id is known (fresh sessions allocate their run id during/after
   * construction). The opening host owns open/close; the engine only reads
   * owners and admits/settles the commands it executes.
   */
  attachAdmissionStore(store: AdmissionStore): void {
    const previous = this.parity.admissionStore;
    // Close-before-replace (consistent with every other store-replace site):
    // a re-attach must never orphan the previous refcounted reference.
    if (previous && previous !== store) previous.close();
    this.parity.admissionStore = store;
  }

  /**
   * Session teardown (REPL /clear, resume replacement, headless run end,
   * protocol-host close): a session ending aborts any still-live admitted
   * claim, then releases this engine's store reference. The underlying
   * refcounted handle closes only when the last reference is released.
   */
  closeAdmissionStore(): void {
    const claim = this.activeAdmissionClaim;
    if (claim && !claim.settled) {
      this.settleAdmissionClaim(claim, 'aborted', { finalOutcome: 'SESSION_CLOSED' });
    }
    this.parity.admissionStore?.close();
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
    return this.services.conversation.rebuildProviderMessages(this.parity.eventLog, {
      ...(this.parity.contextCheckpoint
        ? { installedContextCheckpoint: this.parity.contextCheckpoint }
        : {}),
    });
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
   * S04/#214: this engine's execution context for the current turn. Approval
   * session/turn/root come from engine state, never from another engine's
   * ALS-bound scope.
   */
  private buildBaseExecutionContext(): ExecutionContext {
    return {
      threadId: this.parity.eventLog.thread_id ?? this.engineRunId,
      turnId: this.parity.turnId,
      root: this.options.projectRoot,
      approvalSession: getChatApprovalSession(),
      indexWritePolicy: 'allow',
    };
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
      // R0-1: a fresh submission owns its own WorkingState. Task A's goal,
      // hypothesis, evidence, files of interest, mutation attribution, verifier
      // receipt, failure surface, repair diagnosis, invalidated assumptions and
      // next experiment must not seed task B's reasoning or the working-state
      // block injected into task B's provider prompt. The previous block only
      // set a goal when `workingState.goal` was empty, so task A's goal survived
      // and task B never received its own. Explicit continuation (`continuedTask`)
      // preserves the current state by construction; this reset lives only in the
      // fresh-task branch. Historical durable logs are untouched.
      this.workingState = createWorkingState(runtime.taskText.slice(0, 240));
      // P11 exact observations and the installed generation are task-scoped.
      // A fresh task may not recall or checkpoint evidence captured under a
      // prior task owner, even when the physical observation bytes remain.
      this.p11ObservationRefs = [];
      this.p11ObservationCaptureIssues = [];
      delete this.parity.contextCheckpoint;
      // R0-1: failure-class budgets are task-scoped. A fresh task must not
      // inherit budgets already consumed by the previous task; recreate the
      // tracker from the live contract at the same fresh-task boundary.
      this.failureBudgetTracker = createFailureBudgetTrackerFromContract(
        this.parity.liveAuthority?.taskContract,
      );
      // R0 Scenario 8: a fresh submission must not inherit the previous task's
      // in-memory mutation/tool-call ownership. hasAnyWrites() and
      // currentTurnHasMutation() read toolCallLog, so leaving task A's confirmed
      // write in place projects task B from task A's patch (UNVERIFIED_PATCH
      // instead of NO_CHANGE_REQUIRED). This drops only in-memory task-local
      // evidence; task A's physical on-disk changes remain visible, exactly as
      // resyncTurnStateAfterBranch treats a discarded branch.
      this.toolCallLog = [];
      this._turnToolCallLogStart = 0;
      this._logIndexToTurn.clear();
      // Cancellation state belongs to the previous submission. submitMessageStream
      // also clears it, but the direct applyUserSubmission seam must be
      // self-consistent.
      this._cancelled = false;
      // A red verifier in task A must not keep reopening investigation tools, and
      // a one-shot investigate soft nudge must not stay latched for task B.
      this.lastVerifierFailed = false;
      this.investigateSoftNudgeDone = false;
      // Child delegation attempt identity and phase routing are task-local.
      this.childAttempts.clear();
      this._lastPhase = null;
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
    // S06/#4: a reused engine replaced projectRoot/instructionRoot/systemContext
    // above, so the manifest built at construction is stale. Recompute the
    // delivered-instruction authority from the current options/roots (and the
    // new turn's task class) so the persisted manifest reports what this turn
    // actually delivered.
    if (this.parity?.liveAuthority) {
      try {
        refreshEngineInstructionManifest({
          parity: this.parity,
          options: this.options,
          taskClass: this.taskClass,
          executionProfile: this.executionProfile,
          engineRunDir: this.engineRunDir,
        });
      } catch (err) {
        // Manifest refresh is best-effort telemetry: a failure must not fail
        // the turn (some test doubles run applyTurnPreparation without an
        // established authority). Record it so a persistent failure is visible.
        try {
          this.policyEventLog.record({
            at_turn: this._turnIndex,
            kind: 'progress_policy',
            detail: `instruction_manifest_refresh_failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        } catch {
          /* telemetry must not fail the turn */
        }
      }
    }
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
    const sessionDir = chatSessionDir(engineRunId);
    // R1 durability (6b-1): recover an interrupted checkpoint batch BEFORE any
    // durable artifact is read. A merely staged/abandoned artifact is NEVER
    // current authority: a crash between batch renames must not let the
    // pre-recovery thread/session logs (which may still carry an uncommitted
    // capsule) be loaded into the restored engine, and with no valid published
    // checkpoint the restore ends non-authoritative (lineage_not_committed /
    // lineage_missing → checkpoint inert, durable logs remain the only
    // source). Idempotent no-op without a journal; a malformed journal fails
    // closed (CHECKPOINT_JOURNAL_INVALID) here rather than after partial reads.
    recoverCheckpointArtifacts(sessionDir);
    const sessionLog = loadSessionEventLogForResume(sessionDir, engineRunId);
    const engine = new ChatEngine({
      ...options,
      runId: engineRunId,
      resumeExisting: true,
    });
    engine.conversation = messages;
    const threadLog = loadThreadEventLogFromDir(sessionDir);
    if (threadLog) {
      engine.restoreEventLog(threadLog);
    }
    // Load durable observation membership before session-event restore; the
    // restore re-persists the snapshot from this membership.
    engine.loadObservationMembership(sessionDir);
    engine.restoreSessionEvents(sessionLog, { runDir: sessionDir });
    // One authoritative authority-hydration path for every resume: durable
    // owner recovery + installed-lineage validation + independent observation
    // re-authorization. A checkpoint that cannot prove all three stays inert.
    engine.hydrateInstalledContextAuthority(sessionDir);
    engine.clearVerifierEvidenceState();
    engine.cachedSystemPromptLegacy = null;
    engine.cachedSystemPromptNative = null;
    engine.cachedSystemPromptText = null;
    engine.apiTokenCount = 0;
    engine.compactionConsecutiveFailures = 0;
    return engine;
  }

  /**
   * Load durable observation membership from the live-session snapshot. This
   * MUST run before session-event restore: `restoreSessionEvents` re-projects
   * and persists the snapshot from `parity.authorizedObservationIds`, so loading
   * afterwards would observe (and then erase) the durable membership.
   */
  loadObservationMembership(sessionDir: string = this.engineRunDir): void {
    const liveSnapshot = loadLiveSessionSnapshot(sessionDir);
    this.parity.authorizedObservationIds = new Set(
      liveSnapshot?.authorized_observation_ids ?? [],
    );
  }

  /**
   * Authoritative context-authority hydration — the single path used by every
   * resume/construction entrypoint. Loads `context-checkpoint.json`, requires
   * the durable owner and installed lineage to validate, independently
   * re-authorizes the observation manifest against durable session membership,
   * and only then promotes the checkpoint to provider context. A checkpoint
   * that cannot prove ownership, lineage, and observation membership stays
   * advisory/inert and the durable thread/session logs remain the only source.
   */
  hydrateInstalledContextAuthority(sessionDir: string = this.engineRunDir): {
    applied: boolean;
    issues: string[];
  } {
    const issues: string[] = [];
    const checkpointPath = join(sessionDir, 'context-checkpoint.json');
    if (!existsSync(checkpointPath)) return { applied: false, issues };
    const threadId = this.parity.eventLog.thread_id;
    // Durable session membership for model-readable observations is loaded from
    // the live-session snapshot; a checkpoint manifest cannot grant its own.
    this.loadObservationMembership(sessionDir);
    try {
      const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as ContextCheckpointV1;
      const durableOwner = this.parity.admissionStore?.readOwner(threadId) ?? null;
      const lineageEvidence: ContextCheckpointLineageEvidenceV1 = {
        threadEvents: this.parity.eventLog.events,
        sessionEvents: this.parity.sessionEvents.events,
      };
      const coldResume = validateContextCheckpoint(checkpoint, {
        expectedThreadId: threadId,
        currentOwner: durableOwner,
        requireInstalledLineage: true,
        authorizedObservationIds: [...(this.parity.authorizedObservationIds ?? [])],
        lineageEvidence,
      });
      if (coldResume.status !== 'valid') {
        issues.push(coldResume.reasons.join('; '));
        return { applied: false, issues };
      }
      const authorizedObservationIds = [...(this.parity.authorizedObservationIds ?? [])];
      const resolvedObservations = checkpoint.observation_manifest.map((observation) =>
        resolveObservation(
          observation.observation_id,
          {
            principal_id: 'agent:main',
            authorized_observation_ids: authorizedObservationIds,
          },
          {
            storage_root: join(this.engineRunDir, 'observations'),
            clock: () => new Date().toISOString(),
            policy: { durability: 'none' },
          },
        ),
      );
      const unavailable = resolvedObservations
        .map((result, index) =>
          result.status === 'resolved'
            ? null
            : `observation ${checkpoint.observation_manifest[index]?.observation_id ?? 'unknown'} unavailable: ${result.reason}`,
        )
        .filter((issue): issue is string => issue !== null);
      if (unavailable.length > 0) {
        // An authorized id with no durable payload must not silently
        // reconstruct partial trusted context.
        this.p11ObservationCaptureIssues = unavailable;
        issues.push(...unavailable);
        return { applied: false, issues };
      }
      this.parity.contextCheckpoint = checkpoint;
      this.p11ObservationRefs = resolvedObservations
        .map((result) => (result.status === 'resolved' ? result.observation : null))
        .filter((observation): observation is ObservationRefV1 => observation !== null);
      return { applied: true, issues };
    } catch (err) {
      // A malformed or stale context checkpoint is unavailable evidence;
      // durable thread/session logs remain the only resume source.
      issues.push(err instanceof Error ? err.message : String(err));
      return { applied: false, issues };
    }
  }

  // ── Private Methods ─────────────────────────────────────────────────────

  private currentP11Owner(): ContextCheckpointOwnerV1 | null {
    try {
      const store = this.parity.admissionStore;
      const claim = this.activeAdmissionClaim;
      // A live admitted claim is required: install authority is bounded to an
      // admitted command in flight, never to a settled owner row alone.
      if (!store || !claim || claim.settled) return null;
      // The reference is this engine's OWN admitted identity (from
      // admitCommand), verified against the durable owner row — not a fresh
      // read validated against itself (A5 self-referential fence).
      const durable = store.readOwner(claim.threadId);
      if (!durable) return null;
      if (durable.generation !== claim.generation || durable.token !== claim.token) return null;
      return {
        threadId: durable.threadId,
        generation: durable.generation,
        token: durable.token,
      };
    } catch {
      // A1: owner reads fail closed to null, never out of the install path.
      return null;
    }
  }

  /**
   * P05: admit the authorized command this submission is about to execute —
   * the production admission site, introduced before any P11 checkpoint
   * installation can succeed (installs run inside the stream loop this
   * wrapper precedes).
   *
   * Owner origin: the durable owner row is written ONLY by real command
   * admission — generation 1 with a fresh random lease token on a thread's
   * first command, the durable owner of record recovered on resume/restart,
   * or exactly one generation up (proving the token this engine still holds)
   * when this submission replaces an in-flight one. Never turn numbers, run
   * ids, or session-dir existence.
   *
   * Fails closed: any rejection (stale/foreign owner, corrupt state) leaves no
   * live claim and drops the lease, so `currentP11Owner` resolves null and no
   * checkpoint can install. Admission is a record, never a permission gate —
   * a rejected admission does not block execution itself.
   *
   * Returns the claim THIS admission created (or null) so the submission
   * wrapper can settle exactly that claim at exit.
   */
  private admitCurrentSubmission(
    submissionGeneration: number,
    userInput: string,
  ): ChatEngineAdmissionClaim | null {
    const store = this.parity.admissionStore;
    if (!store) return null;
    try {
      const threadId = this.parity.eventLog.thread_id;
      const commandId = `${this.admissionEpoch}:s${submissionGeneration}`;
      const prior = this.activeAdmissionClaim;
      let ownerGeneration: number;
      let ownerToken: string;
      let previousOwnerToken: string | undefined;
      if (prior && !prior.settled) {
        // Task replacement: the in-flight claim is settled as aborted first,
        // then ownership advances by exactly one generation with the old token
        // presented as proof — a stale holder can never prove takeover.
        this.settleAdmissionClaim(prior, 'aborted', { finalOutcome: 'SUPERSEDED_BY_SUBMISSION' });
        ownerGeneration = prior.generation + 1;
        previousOwnerToken = prior.token;
        ownerToken = randomUUID();
      } else if (this.admissionLease) {
        ownerGeneration = this.admissionLease.generation;
        ownerToken = this.admissionLease.token;
      } else {
        // Resume/crash restart: recover the durable owner of record; only a
        // thread with no owner row ever mints generation 1.
        const durable = store.readOwner(threadId);
        if (durable) {
          ownerGeneration = durable.generation;
          ownerToken = durable.token;
        } else {
          ownerGeneration = 1;
          ownerToken = randomUUID();
        }
      }
      const decision = store.admitCommand({
        digestInput: {
          threadId,
          taskId: this.parity.liveAuthority?.taskContract.task_id ?? this.engineRunId,
          commandId,
          mode: this.executionProfile,
          resolvedOperationPolicy: {
            taskClass: this.taskClass,
            executionProfile: this.executionProfile,
            hardPlanMode: this.options.hardPlanMode === true,
          },
          taskShapeClass: this.taskClass,
          targetRoot: this.options.projectRoot,
          offeredToolSchemaVersion: CHAT_ADMISSION_TOOL_SCHEMA_VERSION,
          contextSnapshotId: commandId,
          payload: {
            kind: 'chat_submission',
            input_sha256: createHash('sha256').update(userInput).digest('hex'),
          },
        },
        ownerGeneration,
        ownerToken,
        ...(previousOwnerToken !== undefined ? { previousOwnerToken } : {}),
        leaseId: this.admissionEpoch,
        // A chat command's durable effect is its thread/session event-log
        // append — reconcilable after a crash, never silently replayed as ok.
        effectClass: 'reconcilable_mutation',
        operationId: `chat-submission:${threadId}:${commandId}`,
      });
      if (decision.kind === 'admitted' || decision.kind === 'pending') {
        this.admissionLease = { generation: ownerGeneration, token: ownerToken };
        const claim: ChatEngineAdmissionClaim = {
          threadId,
          commandId,
          generation: ownerGeneration,
          token: ownerToken,
          submissionGeneration,
          settled: false,
        };
        this.activeAdmissionClaim = claim;
        return claim;
      }
      // Rejected or replayed: fail closed — no live claim, and a rejected
      // admission means this engine is not the durable owner.
      this.activeAdmissionClaim = null;
      if (decision.kind === 'rejected') this.admissionLease = null;
      return null;
    } catch {
      // Record-only: never break execution, but never keep claim state that
      // admission did not durably prove.
      this.activeAdmissionClaim = null;
      this.admissionLease = null;
      return null;
    }
  }

  /** Settle an admitted claim at command settlement (terminal/replacement/close). */
  private settleAdmissionClaim(
    claim: ChatEngineAdmissionClaim,
    state: 'settled' | 'aborted' | 'indeterminate',
    outcome: unknown,
  ): void {
    if (claim.settled) return;
    try {
      const store = this.parity.admissionStore;
      if (store) {
        const input = {
          threadId: claim.threadId,
          commandId: claim.commandId,
          ownerGeneration: claim.generation,
          ownerToken: claim.token,
          state,
          outcome,
        } as const;
        const decision = store.settleAdmission(input);
        // A1: a gen-N command superseded before settlement can no longer
        // prove success under current authority — record it as indeterminate
        // instead of leaving it 'claimed' forever.
        if (
          !decision.settled &&
          state === 'settled' &&
          decision.reasonCode === ADMISSION_REASONS.STALE_OWNER
        ) {
          store.settleAdmission({ ...input, state: 'indeterminate' });
        }
      }
    } catch {
      // Record-only: a failed settle leaves the claim 'claimed' for recovery
      // (fail-closed manual review) and never blocks the caller.
    } finally {
      claim.settled = true;
    }
  }

  /**
   * Exit settlement for a CAPTURED claim — never the mutable
   * `activeAdmissionClaim`, which during task replacement already belongs to
   * the successor. A claim already settled by the replacement's admission is
   * a correct no-op here. Cancellation is derived PER CLAIM: `this._cancelled`
   * only describes the submission that owns `activeSubmissionGeneration`, so a
   * successor's reset of that flag can never re-label this claim.
   */
  private settleClaimOnExit(claim: ChatEngineAdmissionClaim | null): void {
    if (!claim || claim.settled) return;
    const isCurrent =
      this.activeAdmissionClaim === claim ||
      claim.submissionGeneration === this.activeSubmissionGeneration;
    if (!isCurrent) {
      // Superseded while still live: a command that no longer executes can
      // never record success (the replacement's admission normally settled it
      // as aborted already — this covers paths that did not).
      this.settleAdmissionClaim(claim, 'indeterminate', {
        finalOutcome: 'SUPERSEDED_BY_SUBMISSION',
      });
      return;
    }
    this.settleAdmissionClaim(claim, this._cancelled ? 'aborted' : 'settled', {
      finalOutcome: this._cancelled ? 'CANCELLED' : 'CHAT_SUBMISSION_TERMINAL',
    });
  }

  /** Terminal settlement for the engine's currently-active claim. */
  private settleActiveAdmissionClaim(): void {
    this.settleClaimOnExit(this.activeAdmissionClaim);
  }

  private currentInstalledContextLineage(
    checkpointId: string,
  ): ContextCheckpointInstalledLineageV1 {
    const committed = [...this.parity.sessionEvents.events]
      .reverse()
      .find((event) => event.kind === 'compaction_committed');
    if (!committed || committed.kind !== 'compaction_committed') {
      return {
        checkpoint_id: checkpointId,
        compaction_event_id: null,
        compaction_commit_event_id: null,
        compaction_digest: null,
        thread_event_boundary_seq: null,
      };
    }
    const capsule = this.parity.eventLog.events.find(
      (event) => event.kind === 'compaction_capsule' && event.event_id === committed.thread_event_id,
    );
    return {
      checkpoint_id: checkpointId,
      compaction_event_id: committed.thread_event_id,
      compaction_commit_event_id: committed.event_id,
      compaction_digest: committed.capsule_digest,
      thread_event_boundary_seq: capsule?.seq ?? null,
    };
  }

  /**
   * R1/T5: id of the latest durable `compaction_committed` session event, or
   * null when this session has committed no compaction at all.
   */
  private latestDurableCompactionCommitId(): string | null {
    const events = this.parity.sessionEvents.events;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === 'compaction_committed') return event.event_id;
    }
    return null;
  }

  /**
   * R1/T5: true while a durable compaction commit exists that the in-memory
   * installed context root does not name — the exact "stale root silently
   * suppresses the newer capsule" window (routed Task-4 trace). False on
   * capsule-less turns and on turns whose promoted root already names the
   * latest commit, which keeps the non-compacting path byte-identical to the
   * previous ordering.
   */
  private hasPendingCompactionAuthority(): boolean {
    const latestCommit = this.latestDurableCompactionCommitId();
    if (latestCommit === null) return false;
    const installedCommit =
      this.parity.contextCheckpoint?.installed_lineage?.compaction_commit_event_id ?? null;
    return latestCommit !== installedCommit;
  }

  /**
   * Shared preparation input for the R1/T5 candidate prepare and the installing
   * prepare: identical checkpoint id, epoch, and lineage (derived AFTER the
   * capsule commit, so both name the same current capsule). Only
   * `sources.route.compiled_request_identity` differs between the two, and the
   * route identity is never an input to the rebuild or to the lineage — so the
   * candidate-rooted rebuild and the installed-authority rebuild are the same
   * message sequence by construction.
   */
  private p11CheckpointPreparationInput(
    owner: ContextCheckpointOwnerV1,
    sources: LiveOperationalSourcesV1,
  ): ContextCheckpointPreparationInputV1 {
    const checkpointId = `context:${this.parity.turnId ?? this._turnIndex}:${this.workingState.revision}`;
    return {
      checkpointId,
      sessionId: this.engineRunId,
      turnId: this.parity.turnId,
      contextEpoch: `${owner.generation}:${this.workingState.revision}:${sources.workspace?.capture_epoch ?? 'unknown'}`,
      owner,
      sources,
      installedLineage: this.currentInstalledContextLineage(checkpointId),
    };
  }

  /**
   * R1/T5: side-effect-free candidate of THIS turn's context checkpoint.
   * `prepareContextCheckpoint` is documented as detached — preparation never
   * installs — so the candidate only roots the pre-install rebuild that
   * computes this turn's compiled request identity. It never dispatches on its
   * own: only `installP11ContextCheckpoint` swaps the durable authority, and it
   * re-prepares from the live sources with the REAL identity (the candidate's
   * pending marker can therefore never become durable authority). Blocked or
   * unavailable candidate ⇒ null ⇒ the turn falls back to the in-memory root
   * and the dispatch guard refuses when authority stays pending.
   */
  private prepareP11ContextCheckpointCandidate(route: {
    tool_profile: string;
    model_route: string;
  }): ContextCheckpointPreparationResultV1 | null {
    // A5 fence (same as install): the candidate is rooted in THIS engine's own
    // admitted identity — never a synthetic owner.
    const owner = this.currentP11Owner();
    if (!owner || !this.parity.admissionStore) return null;
    const sources = this.buildP11Sources({
      ...route,
      compiled_request_identity: PENDING_COMPILED_REQUEST_IDENTITY,
    });
    if (!sources) return null;
    const prepared = prepareContextCheckpoint(this.p11CheckpointPreparationInput(owner, sources));
    return prepared.status === 'prepared' ? prepared : null;
  }

  private currentRecoveryBinding(): RecoveryCandidateBinding | null {
    try {
      const root = canonicalizeContained(this.options.projectRoot);
      const revision = recoveryWorkspaceRevision(root);
      if (!revision) return null;
      const fingerprint = repoRootFingerprint(root);
      const ownerId = this.taskAllowance?.taskOwnerId ?? this.engineRunId;
      return {
        schemaVersion: 1,
        taskId: this.parity.liveAuthority?.taskContract.task_id ?? ownerId,
        contractHash: this.parity.liveAuthority?.taskContract.contract_hash ?? `uncontracted:${ownerId}`,
        repositoryIdentity: JSON.stringify([root, fingerprint]),
        workspaceRevision: revision,
      };
    } catch {
      return null;
    }
  }

  private currentP11Workspace(): ReturnType<typeof RevisionManager.computeRevisionSync> | null {
    try {
      return RevisionManager.computeRevisionSync(this.options.projectRoot, [], {
        scope_kind: 'repository',
        git_binding: 'optional',
      });
    } catch {
      return null;
    }
  }

  private captureP11Observation(
    action: ChatToolAction,
    result: { index: number; observation: string },
    meta: { index: number; idempotencyKey: string; ownerGeneration: number },
  ): void {
    if (!result.observation || !this.isSubmissionCurrent(meta.ownerGeneration)) return;
    const taskId = this.parity.liveAuthority?.taskContract.task_id ?? this.engineRunId;
    const operationId = meta.idempotencyKey;
    const turnId = this.parity.turnId ?? `turn-${this._turnIndex}`;
    const workspace = this.currentP11Workspace();
    const logEntry = [...this.toolCallLog]
      .reverse()
      .find((entry) => entry.index === meta.index && entry.tool === chatActionToolName(action));
    const previousObservation = this.p11ObservationRefs.find(
      (observation) => observation.invocation.operation_id === operationId,
    );
    const captured = captureApprovedObservation(
      {
        invocation: {
          operation_id: operationId,
          task_id: taskId,
          run_id: this.engineRunId,
          turn_id: turnId,
          attempt_id: operationId,
        },
        sections: [{ channel: 'stdout', content: result.observation }],
        execution_status: logEntry?.exit_code === 0 || logEntry?.exit_code === undefined ? 'succeeded' : 'failed',
        permitted_principals: ['agent:main'],
        data_policy: {
          approved: true,
          policy_version: 'babel-chat-model-readable-v1',
          redaction_policy_version: 'babel-chat-redaction-v1',
        },
        ...(workspace
          ? {
              snapshot_ref: workspace.compositeTreeHash,
              coverage_ref: workspace.compositeTreeHash,
            }
          : {}),
        ...(previousObservation ? { previous_observation: previousObservation } : {}),
      },
      {
        storage_root: join(this.engineRunDir, 'observations'),
        clock: () => new Date().toISOString(),
        policy: { durability: 'fsync_file_and_dir' },
      },
    );
    if (captured.status === 'captured') {
      this.p11ObservationRefs = [
        ...this.p11ObservationRefs.filter(
          (observation) => observation.observation_id !== captured.observation.observation_id,
        ),
        captured.observation,
      ];
      (this.parity.authorizedObservationIds ??= new Set()).add(captured.observation.observation_id);
    } else {
      this.p11ObservationCaptureIssues.push(
        captured.status === 'blocked' ? captured.reason : captured.reason,
      );
    }
  }

  private buildP11Sources(
    routeOverride?: NonNullable<LiveOperationalSourcesV1['route']>,
  ): LiveOperationalSourcesV1 | null {
    const authority = this.parity.liveAuthority;
    const workspace = this.currentP11Workspace();
    const allowance = this.taskAllowance;
    const latestInput = [...this.parity.sessionEvents.events]
      .reverse()
      .find((event) => event.kind === 'model_input_receipt');
    const route = routeOverride ?? (
      latestInput && latestInput.kind === 'model_input_receipt'
        ? {
            compiled_request_identity: latestInput.body_digest ?? latestInput.input_digest,
            tool_profile: this.shouldUseTextTools() ? 'text-tools' : 'native-tools',
            model_route: `${latestInput.provider}:${latestInput.sent_model_id}`,
          }
        : null
    );
    if (!authority || !workspace || !allowance || !route) {
      return null;
    }
    const interrupted = interruptedToolRecoveries(this.parity.sessionEvents).map((item) => ({
      handle_id: item.idempotencyKey,
      kind: item.toolName.includes('sub_agent') || item.toolName.includes('child') ? 'child' as const : 'operation' as const,
      state: item.state === 'TOOL_OUTCOME_UNKNOWN' ? 'indeterminate' as const : 'pending' as const,
    }));
    const workingState = {
      current_hypothesis:
        this.workingState.currentHypothesis || this.workingState.goal || 'active chat context',
      unresolved_failures: [
        ...(this.workingState.failureSurface?.errorSignature
          ? [this.workingState.failureSurface.errorSignature]
          : []),
        ...this.workingState.openQuestions,
      ],
      next_experiment: this.workingState.nextExperiment || 'continue the current controller step',
    };
    const receipts = this.lastVerifierReceipt
      ? [{
          receipt_id: this.lastVerifierReceipt.receiptId ?? `receipt:${this.lastVerifierReceipt.command}`,
          identity: this.lastVerifierReceipt.verifierId ?? this.lastVerifierReceipt.command,
          scope: this.lastVerifierReceipt.scope ?? 'unknown',
          stale: this.lastVerifierReceipt.stale === true,
          bound_revision: this.lastVerifierReceipt.boundRevision?.compositeTreeHash ?? null,
        }]
      : [];
    const observations = this.p11ObservationRefs.map((observation) => ({
      observation_id: observation.observation_id,
      payload_sha256: observation.payloads[0]?.sha256 ?? '',
      authorized: this.parity.authorizedObservationIds?.has(observation.observation_id) === true,
    }));
    return {
      resumed: this.options.resumeExisting === true,
      task_contract: {
        goal: authority.taskContract.goal,
        acceptance_clause_ids: authority.taskContract.acceptance.map((item) => item.id),
        contract_hash: authority.taskContract.contract_hash,
      },
      working_state: workingState,
      workspace: {
        current_snapshot_revision: workspace.compositeTreeHash,
        capture_complete: true,
        coverage_ref: workspace.compositeTreeHash,
        capture_provenance: 'current_capture',
        capture_epoch: `${workspace.capturedAt}:${workspace.compositeTreeHash}`,
      },
      receipts,
      budget: {
        owner: allowance.taskOwnerId,
        remaining_allowance: Math.max(0, allowance.grant.turnCap - allowance.consumed.turns),
        cancellation_owner: allowance.taskOwnerId,
      },
      pending: interrupted,
      route,
      observations,
      observation_manifest: this.p11ObservationRefs,
      authorized_observation_ids: [...(this.parity.authorizedObservationIds ?? [])],
      observation_recovery_issues: [...this.p11ObservationCaptureIssues],
      legacy_observation_refs: [],
    };
  }

  private async installP11ContextCheckpoint(
    routeOverride?: NonNullable<LiveOperationalSourcesV1['route']>,
  ): Promise<boolean> {
    const sources = this.buildP11Sources(routeOverride);
    if (!sources) return false;
    // A5 fence: the claimed owner is THIS engine's own admitted identity
    // (admitted ∩ durable, see currentP11Owner) — never a fresh read that
    // would validate itself. A losing/superseded engine resolves null here.
    const owner = this.currentP11Owner();
    if (!owner || !this.parity.admissionStore) return false;
    // Same checkpoint id / epoch / lineage derivation as the R1/T5 candidate
    // prepare (p11CheckpointPreparationInput), now with the REAL compiled
    // request identity computed from this turn's rebuilt messages.
    const prepared = prepareContextCheckpoint(this.p11CheckpointPreparationInput(owner, sources));
    if (prepared.status !== 'prepared') return false;
    const previous = this.parity.contextCheckpoint;
    // Durable re-read: the installer's claimed (admitted) identity must still
    // match the owner row of record before the checkpoint may install.
    const ownerNow = this.parity.admissionStore.readOwner(owner.threadId);
    if (!ownerNow) return false;
    if (ownerNow.generation !== owner.generation || ownerNow.token !== owner.token) return false;
    const installed = await installContextCheckpoint(prepared, {
      currentOwner: {
        threadId: ownerNow.threadId,
        generation: ownerNow.generation,
        token: ownerNow.token,
      },
      requireInstalledLineage: true,
      authorizedObservationIds: [...(this.parity.authorizedObservationIds ?? [])],
      lineageEvidence: {
        threadEvents: this.parity.eventLog.events,
        sessionEvents: this.parity.sessionEvents.events,
      },
      readCurrentOwner: () => {
        const current = this.parity.admissionStore?.readOwner(owner.threadId) ?? null;
        return current
          ? { threadId: current.threadId, generation: current.generation, token: current.token }
          : null;
      },
      install: async (checkpoint, _owner, assertOwnerCurrent) => {
        this.parity.contextCheckpoint = checkpoint;
        const receipt = await checkpointParityEventLogStrict(this.parity, this.engineRunDir, {
          ...(assertOwnerCurrent ? { assertOwnerCurrent } : {}),
        });
        if (receipt.status !== 'committed') {
          if (previous) this.parity.contextCheckpoint = previous;
          else delete this.parity.contextCheckpoint;
          throw new Error(receipt.error ?? 'checkpoint persistence blocked');
        }
      },
    });
    return installed.status === 'installed';
  }

  /**
   * Execute a batch of tool actions sequentially through the policy gate.
   * Each action emits start/complete callbacks for the ConversationalRenderer.
   */
  private async executeActions(
    actions: ChatToolAction[],
    callbacks: ChatCallbacks,
    ownerGeneration: number = this.activeSubmissionGeneration,
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
    // R0-8: a superseded generator must not run the new owner's tools. The
    // generation check runs between every action and batch, including after
    // an awaited tool/child returns.
    const superseded = (): boolean => !this.isSubmissionCurrent(ownerGeneration);
    for (const batch of batches) {
      if (this._cancelled || this.abortController.signal.aborted || stopTerminal || superseded())
        break;
      if (batch.kind === 'parallel_reads') {
        const containsSubAgent = batch.indices.some((index) => actions[index]?.type === 'sub_agent');
        if (containsSubAgent) {
          for (const index of batch.indices) {
            if (this._cancelled || this.abortController.signal.aborted || stopTerminal || superseded())
              break;
            const result = await this.executeOneAction(actions[index]!, toolContext, callbacks, {
              index,
              ownerGeneration,
              idempotencyKey:
                this._streamNativeToolCallIds[index] ?? `tool_call_${this._turnIndex}_${index}`,
            });
            allResults.push(result);
            this.captureP11Observation(actions[index]!, result, {
              index,
              ownerGeneration,
              idempotencyKey:
                this._streamNativeToolCallIds[index] ?? `tool_call_${this._turnIndex}_${index}`,
            });
            if (result.stop) stopTerminal = true;
          }
          continue;
        }
        for (let c = 0; c < batch.indices.length; c += MAX_TOOL_CONCURRENCY) {
          if (this._cancelled || this.abortController.signal.aborted || superseded()) break;
          const chunk = batch.indices.slice(c, c + MAX_TOOL_CONCURRENCY);
          const parallelResults = await Promise.all(
              chunk.map((index) =>
                this.executeOneAction(actions[index]!, toolContext, callbacks, {
                  index,
                  ownerGeneration,
                  idempotencyKey:
                    this._streamNativeToolCallIds[index] ?? `tool_call_${this._turnIndex}_${index}`,
                }),
              ),
            );
          allResults.push(...parallelResults);
          for (const index of chunk) {
            const result = parallelResults.find((item) => item.index === index);
            if (result) {
              this.captureP11Observation(actions[index]!, result, {
                index,
                ownerGeneration,
                idempotencyKey:
                  this._streamNativeToolCallIds[index] ?? `tool_call_${this._turnIndex}_${index}`,
              });
            }
          }
        }
      } else {
        const result = await this.executeOneAction(actions[batch.index]!, toolContext, callbacks, {
          index: batch.index,
          ownerGeneration,
          idempotencyKey:
            this._streamNativeToolCallIds[batch.index] ??
            `tool_call_${this._turnIndex}_${batch.index}`,
        });
        allResults.push(result);
        this.captureP11Observation(actions[batch.index]!, result, {
          index: batch.index,
          ownerGeneration,
          idempotencyKey:
            this._streamNativeToolCallIds[batch.index] ??
            `tool_call_${this._turnIndex}_${batch.index}`,
        });
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

  /**
   * R0-7/R0-8: true while `ownerGeneration` is still the submission that owns
   * the engine. Async continuations capture their generation when they start
   * and call this before writing state, so obsolete work cannot apply to the
   * task that now owns the engine.
   */
  private isSubmissionCurrent(ownerGeneration: number): boolean {
    return this.activeSubmissionGeneration === ownerGeneration;
  }

  /**
   * R0-7: the current parent candidate revision, derived from the existing
   * session mutation batches and RevisionManager. Returns null when the parent
   * has no mutation scope yet (nothing to compare). Never invents a revision
   * authority — this is the same computation the completion gate performs.
   */
  private currentCandidateRevisionHash(): string | null {
    try {
      const raw = mutationPathsFromSessionEvents(this.parity.sessionEvents.events);
      if (raw.length === 0) return null;
      // Session mutation batches may carry absolute or repo-relative paths;
      // RevisionManager requires canonical repository-relative paths.
      const root = resolve(this.options.projectRoot);
      const relativePaths: string[] = [];
      for (const candidate of raw) {
        const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
        const rel = relative(root, absolute);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
        relativePaths.push(rel.split(sep).join('/'));
      }
      const unique = [...new Set(relativePaths)].sort();
      if (unique.length === 0) return null;
      return RevisionManager.computeRevisionSync(this.options.projectRoot, unique)
        .compositeTreeHash;
    } catch {
      return null;
    }
  }

  /**
   * R0-7: a child result that no longer applies to the current parent
   * candidate/submission is returned as historical evidence only. It must not
   * enter the current task's tool log, budget, working state, verifier
   * ledger, mutation attribution, or presentation callbacks.
   */
  private settleStaleChildResult(
    tool: string,
    target: string,
    subId: string,
    index: number,
    reason: string,
  ): { index: number; observation: string } {
    return {
      index,
      observation: [
        `### sub_agent ${subId}: stale_result`,
        'status: stale',
        'attribution: child_stale_result',
        `reason: ${reason}`,
        'This child result is historical evidence from a superseded parent',
        'candidate and does not apply to the current task. It is deliberately',
        'excluded from the current tool log, budget, verifier ledger, working',
        'state, and mutation attribution.',
      ].join('\n'),
    };
  }

  /**
   * R0-7/R0-8: an ordinary action that completes after its submission was
   * superseded must not write the current task's tool log, mutation
   * attribution, verifier ledger or budget.
   */
  private settleStaleActionResult(
    tool: string,
    target: string,
    index: number,
    reason: string,
  ): { index: number; observation: string } {
    return {
      index,
      observation: [
        `### ${tool} ${target}`,
        'status: stale',
        `reason: ${reason}`,
        'This action completed after its submission was superseded and is not',
        'applied to the current task.',
      ].join('\n'),
    };
  }

  private async executeOneAction(
    action: ChatToolAction,
    toolContext: ToolContext,
    callbacks: ChatCallbacks,
    meta: { index: number; idempotencyKey?: string; ownerGeneration?: number },
  ): Promise<{ index: number; observation: string; stop?: boolean }> {
    // R0-10: a throwing presentation callback must not unwind settlement or
    // duplicate execution truth. All callbacks below are the safe wrappers.
    callbacks = wrapPresentationCallbacks(callbacks);
    // R0-7/R0-8: the submission that owns this action. Captured once, before
    // any await, so a tool/child that settles after the engine is superseded
    // is recognised as stale instead of being applied to the new task.
    const ownerGeneration = meta.ownerGeneration ?? this.activeSubmissionGeneration;
    const ownerRunDir = this.engineRunDir;
    // R0-7: the parent turn at dispatch time. Child mutation evidence must be
    // attributed to the turn that produced it, never to whatever turn is live
    // when the child finally resolves.
    const dispatchTurnId = this.parity.turnId;
    // R0-10: baseline for "did this invocation already record an execution
    // row?". `meta.index` is not unique across a turn (it is per-round), so the
    // catch must compare against this invocation's own baseline.
    const toolCallLogStart = this.toolCallLog.length;
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

      const mutationAttempt =
        action.type === 'write_file' ||
        action.type === 'str_replace' ||
        action.type === 'apply_patch' ||
        (action.type === 'sub_agent' && (action as { mutation?: boolean }).mutation === true);
      // run_command is an arbitrary shell, so classify it as potentially
      // mutating before execution. The dedicated test_run verifier remains
      // available for observation while the recovery gate is closed.
      const shellMutationAttempt = action.type === 'run_command';
      const shellObservation = action.type === 'run_command' || action.type === 'test_run';
      let recoveryGate = this.workingState.recoveryGate;
      let driftedCandidate = false;
      let currentBinding = null as RecoveryCandidateBinding | null;
      if (recoveryGate && (mutationAttempt || shellMutationAttempt)) {
        currentBinding = this.currentRecoveryBinding();
        if (!recoveryGate.binding || !currentBinding || !sameRecoveryBinding(recoveryGate.binding, currentBinding)) {
          this.workingState = applyWorkingStateEvent(this.workingState, { type: 'recovery_candidate_drift' });
          this.persistRecoveryWorkingState();
          recoveryGate = this.workingState.recoveryGate;
          driftedCandidate = true;
        }
      }
      const proposedEdit = recoveryGate && (action.type === 'write_file' || action.type === 'str_replace' || action.type === 'apply_patch')
        ? actualRecoveryEdit(action, this.options.projectRoot)
        : null;
      let admittedThisAction = false;
      if (recoveryGate?.satisfied && mutationAttempt && proposedEdit && currentBinding && !driftedCandidate) {
        const proposal = 'repair_plan' in action ? action.repair_plan : undefined;
        const admission = admitRecoveryPlan(this.workingState, proposal, proposedEdit, currentBinding);
        if (admission.admitted) {
          this.workingState = admission.state;
          recoveryGate = this.workingState.recoveryGate;
          admittedThisAction = true;
        }
      }
      const recoveryAction = mutationAttempt || shellMutationAttempt || shellObservation;
      const actionFingerprint = recoveryAction
        ? proposedEdit?.exactFingerprint ?? operationFingerprint(chatActionToolName(action), action)
        : null;
      const equivalentRedMutation = recoveryAction &&
        recoveryGate?.satisfied === true &&
        recoveryGate.mutationFingerprint !== undefined &&
        recoveryGate.mutationFingerprint === actionFingerprint &&
        this.workingState.failureSurface?.errorSignature === recoveryGate.failureSignature;
      const planRequired =
        recoveryGate !== undefined &&
        recoveryGate.satisfied === true &&
        !admittedThisAction;
      if (
        recoveryGate &&
        (((mutationAttempt || shellMutationAttempt) && !recoveryGate.satisfied) ||
          ((mutationAttempt || shellMutationAttempt) && planRequired) ||
          equivalentRedMutation)
      ) {
        const detail = [
          driftedCandidate ? '[RECOVERY_CANDIDATE_DRIFT]'
            : equivalentRedMutation ? '[RECOVERY_STRATEGY_CHANGE_REQUIRED]'
            : planRequired ? '[RECOVERY_PLAN_REQUIRED]'
            : '[RECOVERY_EVIDENCE_REQUIRED]',
          `failure_signature=${recoveryGate.failureSignature}`,
          driftedCandidate ? 'The workspace differs from the failed candidate; rerun the verifier before repairing.'
            : equivalentRedMutation ? 'The proposed edit repeats the failed operation.'
            : planRequired ? 'Submit a scoped repair plan supported by current observation IDs and the actual edit.'
            : recoveryGate.requiredEvidence,
        ].join(' ');
        this.toolCallLog.push({
          tool,
          target,
          detail,
          error: 'blocked',
          index: meta.index,
          exit_code: 1,
        });
        callbacks?.onToolComplete?.(toolId, 'recovery-evidence-required', 'blocked', 1);
        return {
          index: meta.index,
          observation: `### ${tool} ${target}\nexit_code: 1\n${detail}`,
        };
      }
      if (admittedThisAction) {
        this.workingState = applyWorkingStateEvent(this.workingState, { type: 'recovery_plan_consumed' });
        this.persistRecoveryWorkingState();
      }
      if (this.recoveryStatePersistenceUnavailable && (mutationAttempt || shellMutationAttempt)) {
        const detail = '[RECOVERY_STATE_PERSISTENCE_UNAVAILABLE] Recovery state could not be saved before mutation.';
        this.toolCallLog.push({ tool, target, detail, error: 'blocked', index: meta.index, exit_code: 1 });
        callbacks?.onToolComplete?.(toolId, 'recovery-state-persistence-unavailable', 'blocked', 1);
        return { index: meta.index, observation: `### ${tool} ${target}\nexit_code: 1\n${detail}` };
      }

      const localizationInspection = action.type === 'read_file' || action.type === 'read_range' ||
        action.type === 'grep' || action.type === 'glob' || action.type === 'list_dir' ||
        action.type === 'semantic_search';
      if (localizationInspection) {
        const inspectionTarget = 'file_path' in action && typeof action.file_path === 'string'
          ? action.file_path : 'path' in action && typeof action.path === 'string' ? action.path : '';
        if (!this.beginRecoveryLocalizationInspection(action.type, inspectionTarget)) {
          const detail = this.workingState.localization?.phase === 'exhausted'
            ? '[LOCALIZATION_EXHAUSTED] The four-call or two-scope localization allowance is spent.'
            : '[RECOVERY_CANDIDATE_DRIFT] Rerun the verifier before localization.';
          this.toolCallLog.push({ tool, target, detail, error: 'blocked', index: meta.index, exit_code: 1 });
          callbacks?.onToolComplete?.(toolId, 'localization-blocked', 'blocked', 1);
          return { index: meta.index, observation: `### ${tool} ${target}\nexit_code: 1\n${detail}` };
        }
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
        // Test-only deterministic lane overrides (never set in production).
        const childLane = this.options.testChildLaneOverrides;

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

        // S04/#214: derive the child session ONLY from the ALS-bound parent
        // context and scope it with the async context. No global bind/restore,
        // so cancellation/rejection/exception restore the owner automatically
        // and a sibling scope can never be read.
        const parentContext = getExecutionContext() ?? this.buildBaseExecutionContext();
        const parentApproval = parentContext.approvalSession ?? getChatApprovalSession();
        const childCeiling = mutationEnabled
          ? (['shell', 'write', 'other'] as const)
          : (['other'] as const);
        const childApproval = deriveSubagentApprovalSession(parentApproval, subId, [
          ...childCeiling,
        ]);
        // Fail closed if a derived child would widen the parent lease.
        assertChildApprovalWithinParent(childApproval, parentApproval);
        const childContext: ExecutionContext = {
          ...parentContext,
          approvalSession: childApproval,
          parentTrace: { threadId: parentContext.threadId, turnId: parentContext.turnId },
        };
        // R0-7: bind this child to the parent candidate revision at dispatch.
        // A child result may become authority only while it still applies to
        // the current parent candidate. A read-only child cannot move the
        // candidate itself, so a changed revision means the parent moved; a
        // mutation child does move it, so revision movement is judged only for
        // non-mutating children and the submission/turn identity carries the
        // rest. Existing authority only (RevisionManager + submission id).
        const dispatchRevisionHash = this.currentCandidateRevisionHash();
        const childResultIsStale = (changedFiles: number): boolean => {
          if (!this.isSubmissionCurrent(ownerGeneration)) return true;
          if (this.parity.turnId !== dispatchTurnId) return true;
          if (changedFiles === 0 && dispatchRevisionHash !== this.currentCandidateRevisionHash()) {
            return true;
          }
          return false;
        };
        // R1: scope the entire child dispatch with the run-scoped helper. The
        // AsyncLocalStorage binding starts at this call and unwinds when the
        // awaited body settles, so a finished child can never leave its context
        // visible to caller or sibling work. Never use `enterWith` here (it
        // rebinds the ambient execution until a manual restore) and never
        // manually restore ambient state.
        return await runWithExecutionContext(
          childContext,
          async (): Promise<{ index: number; observation: string; stop?: boolean }> => {
        // Mutation sub-agent path (W2.1: git worktree + write_scope allowlist)
        if (mutationEnabled) {
          try {
            // M3: the start callback runs inside the run-scoped child context so
            // a throwing callback unwinds with the scope and cannot leak.
            callbacks.onSubAgentStart?.({
              id: subId,
              label: action.task.slice(0, 60),
            });
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
                  ...(childLane?.useDeterministicMock !== undefined
                    ? { useDeterministicMock: childLane.useDeterministicMock }
                    : {}),
                  ...(childLane?.executor ? { executor: childLane.executor } : {}),
                  toolContext: {
                    signal: childController.signal,
                  },
                  ...(mutationAllowance ? { inheritedAllowance: mutationAllowance } : {}),
                  onUsageRecorded: () => {
                    if (mutationAllowance?.parentTaskOwnerId) {
                      try {
                        this.persistOwnerCharges(mutationAllowance.parentTaskOwnerId, ownerRunDir);
                      } catch (error) {
                        this.recordOwnerAccountingFault({
                          taskOwnerId: mutationAllowance.parentTaskOwnerId,
                          accountingEpoch: globalCostTracker.getAccountingEpoch(),
                          turnId: this.parity.turnId,
                          chargeId: null,
                          ownerGeneration,
                        }, 'persistence-failure', error instanceof Error ? error.message : String(error),
                        mutationAllowance.parentTaskOwnerId === this.taskAllowance?.taskOwnerId &&
                          this.isSubmissionCurrent(ownerGeneration));
                        throw new Error('Delegated charge receipt could not be saved');
                      }
                    }
                    // R0-8: a superseded child must not flush the new task's
                    // cost baseline / active-execution checkpoint.
                    if (this.isSubmissionCurrent(ownerGeneration)) {
                      this.persistTaskCostBaseline();
                    }
                  },
                },
              );
              // R0-7: a child that resolves after the parent moved must not
              // install evidence, invalidate verifier authority, or spend the
              // current task's budget. Visible as historical evidence only.
              if (childResultIsStale(implResult.changedFiles.length)) {
                return this.settleStaleChildResult(
                  tool,
                  target,
                  subId,
                  meta.index,
                  'parent submission/revision superseded before the child resolved',
                );
              }
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
              if (implResult.changedFiles.length > 0) {
                this.workingState = applyWorkingStateEvent(this.workingState, {
                  type: 'mutation',
                  path: implResult.changedFiles[0]!.path,
                  fingerprint: operationFingerprint(chatActionToolName(action), action),
                });
              }
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
              ...(childLane?.useDeterministicMock !== undefined
                ? { useDeterministicMock: childLane.useDeterministicMock }
                : {}),
              ...(childLane?.actionResolver
                ? {
                    actionResolver: (prompt: string) =>
                      childLane.actionResolver!(prompt, 1),
                  }
                : {}),
              ...(childLane?.executor ? { executor: childLane.executor } : {}),
              ...(mutationAllowance ? { inheritedAllowance: mutationAllowance } : {}),
              onUsageRecorded: () => {
                if (mutationAllowance?.parentTaskOwnerId) {
                  try {
                    this.persistOwnerCharges(mutationAllowance.parentTaskOwnerId, ownerRunDir);
                  } catch (error) {
                    this.recordOwnerAccountingFault({
                      taskOwnerId: mutationAllowance.parentTaskOwnerId,
                      accountingEpoch: globalCostTracker.getAccountingEpoch(),
                      turnId: this.parity.turnId,
                      chargeId: null,
                      ownerGeneration,
                    }, 'persistence-failure', error instanceof Error ? error.message : String(error),
                    mutationAllowance.parentTaskOwnerId === this.taskAllowance?.taskOwnerId &&
                      this.isSubmissionCurrent(ownerGeneration));
                    throw new Error('Delegated charge receipt could not be saved');
                  }
                }
                // R0-8: a superseded child must not flush the new task's
                // cost baseline / active-execution checkpoint.
                if (this.isSubmissionCurrent(ownerGeneration)) {
                  this.persistTaskCostBaseline();
                }
              },
              ...(spec.resolvedModel ? { model: spec.resolvedModel } : {}),
              ...(spec.instructions ? { additionalInstructions: spec.instructions } : {}),
            });
            // R0-7: a mutation child that resolves after the parent submission
            // was superseded must not mint a mutation batch, invalidate the new
            // task's verifier receipt, or be treated as incorporated into the
            // current candidate. Its disk effects remain real and historical.
            if (childResultIsStale(mutResult.changedFiles.length)) {
              return this.settleStaleChildResult(
                tool,
                target,
                subId,
                meta.index,
                'parent submission/revision superseded before the child resolved',
              );
            }
            const attribution: SubagentAttribution = mutResult.attribution;
            const clean = subagentFinishedCleanly(attribution);
            const details = clean
              ? `${mutResult.stepsExecuted} steps, ${mutResult.changedFiles.length} changed, attribution=${attribution}`
              : `failed: ${mutResult.error || 'unknown error'}, attribution=${attribution}`;
            if (mutResult.changedFiles.length > 0) {
              this.workingState = applyWorkingStateEvent(this.workingState, {
                type: 'mutation',
                path: mutResult.changedFiles[0]!.path,
                fingerprint: operationFingerprint(chatActionToolName(action), action),
              });
            }
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
            if (mutResult.changedFiles.length > 0) {
              // R0-11: the in-tree mutation lane writes directly into the PARENT
              // candidate. A prior green parent verifier receipt is revision-
              // bound to the parent's earlier mutation scope; it must not remain
              // current for a candidate that now contains the child's changes.
              // (The worktree branch above is different: its diff is never
              // promoted into the parent tree, so a parent receipt stays valid
              // for the unchanged parent candidate.)
              invalidateVerifierLedger(
                this as never,
                'child mutation changed the parent candidate',
              );
              recordMutationBatch(
                this.parity.sessionEvents,
                // R0-7: attribute the child's change to the turn that
                // dispatched it, never to a turn that started afterwards.
                dispatchTurnId ?? String(this._turnIndex),
                { paths: mutResult.changedFiles.map((file) => file.path) },
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
            // R0-7: a child failure that surfaces after the parent was
            // superseded must not poison the current task's tool log/callbacks.
            if (!this.isSubmissionCurrent(ownerGeneration)) {
              return this.settleStaleChildResult(
                tool,
                target,
                subId,
                meta.index,
                'parent submission superseded before the child settled',
              );
            }
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
            this.abortController.signal.removeEventListener('abort', onParentAbort);
          }
        }

        // Read-only sub-agent path (existing)
        try {
          // M3: start callback inside the run-scoped child context so a throw
          // unwinds with the scope and cannot leak.
          callbacks.onSubAgentStart?.({
            id: subId,
            label: action.task.slice(0, 60),
          });
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
            ...(childLane?.useDeterministicMock !== undefined
              ? { useDeterministicMock: childLane.useDeterministicMock }
              : {}),
            ...(childLane?.actionResolver ? { actionResolver: childLane.actionResolver } : {}),
            ...(childLane?.executor ? { executor: childLane.executor } : {}),
            ...(spec.resolvedModel ? { model: spec.resolvedModel } : {}),
            ...(spec.instructions ? { additionalInstructions: spec.instructions } : {}),
            inheritedAllowance: readAllowance,
            onUsageRecorded: () => {
              if (readAllowance.parentTaskOwnerId) {
                try {
                  this.persistOwnerCharges(readAllowance.parentTaskOwnerId, ownerRunDir);
                } catch (error) {
                  this.recordOwnerAccountingFault({
                    taskOwnerId: readAllowance.parentTaskOwnerId,
                    accountingEpoch: globalCostTracker.getAccountingEpoch(),
                    turnId: this.parity.turnId,
                    chargeId: null,
                    ownerGeneration,
                  }, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  readAllowance.parentTaskOwnerId === this.taskAllowance?.taskOwnerId &&
                    this.isSubmissionCurrent(ownerGeneration));
                  throw new Error('Delegated charge receipt could not be saved');
                }
              }
              // R0-8: a superseded child must not flush the new task's
              // cost baseline / active-execution checkpoint.
              if (this.isSubmissionCurrent(ownerGeneration)) {
                this.persistTaskCostBaseline();
              }
            },
          } as any);
          // R0-7: a read-only child that resolves after the parent candidate
          // moved (or the submission was superseded) is historical evidence
          // only — it must not be attributed to the current task.
          if (childResultIsStale(0)) {
            return this.settleStaleChildResult(
              tool,
              target,
              subId,
              meta.index,
              'parent submission/revision superseded before the child resolved',
            );
          }
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
          // R0-7: a child failure that surfaces after the parent was
          // superseded must not poison the current task's tool log/callbacks.
          if (!this.isSubmissionCurrent(ownerGeneration)) {
            return this.settleStaleChildResult(
              tool,
              target,
              subId,
              meta.index,
              'parent submission superseded before the child settled',
            );
          }
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
          this.abortController.signal.removeEventListener('abort', onParentAbort);
        }
          },
        );
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
        // R0-8: an MCP call is a suspension point; a superseded submission must
        // not append its result to the current task's tool log.
        if (!this.isSubmissionCurrent(ownerGeneration)) {
          return this.settleStaleActionResult(
            tool,
            target,
            meta.index,
            'parent submission superseded before the action settled',
          );
        }
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
        // R0-8: a web call is a suspension point; a superseded submission must
        // not append its result to the current task's tool log.
        if (!this.isSubmissionCurrent(ownerGeneration)) {
          return this.settleStaleActionResult(
            tool,
            target,
            meta.index,
            'parent submission superseded before the action settled',
          );
        }
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
        // R0-8: an LSP call is a suspension point; a superseded submission must
        // not append its result to the current task's tool log.
        if (!this.isSubmissionCurrent(ownerGeneration)) {
          return this.settleStaleActionResult(
            tool,
            target,
            meta.index,
            'parent submission superseded before the action settled',
          );
        }
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
        // R0-8: hashing is a suspension point; a superseded submission must not
        // append its read result (or advance its caches) for the new task.
        if (!this.isSubmissionCurrent(ownerGeneration)) {
          return this.settleStaleActionResult(
            tool,
            target,
            meta.index,
            'parent submission superseded before the action settled',
          );
        }
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

        // R0-7/R0-8: governedStrReplace is a suspension point; a superseded
        // submission must not record a mutation batch from it.
        if (!this.isSubmissionCurrent(ownerGeneration)) {
          return this.settleStaleActionResult(
            tool,
            target,
            meta.index,
            'parent submission superseded before the action settled',
          );
        }
        if (gov.mutationPaths && gov.mutationPaths.length > 0) {
          recordMutationBatch(this.parity.sessionEvents, dispatchTurnId ?? 'unknown', {
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
          preDispatchNoEffect: gov.preDispatchNoEffect,
        });
        if (admittedThisAction && proposedEdit &&
            strReplaceEffect.status === 'confirmed_no_change' &&
            this.isSubmissionCurrent(ownerGeneration)) {
          this.workingState = applyWorkingStateEvent(this.workingState, {
            type: 'recovery_proven_no_effect', fingerprint: proposedEdit.exactFingerprint,
          });
          this.persistRecoveryWorkingState();
        }

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
            const edit = actualRecoveryEdit(action, this.options.projectRoot);
            this.workingState = applyWorkingStateEvent(this.workingState, {
              type: 'mutation',
              path: gov.absolutePath,
              fingerprint: edit?.exactFingerprint ?? operationFingerprint(chatActionToolName(action), action),
              ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
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
        const edit = actualRecoveryEdit(action, this.options.projectRoot);
        this.workingState = applyWorkingStateEvent(this.workingState, {
          type: 'mutation',
          path: gov.absolutePath,
          fingerprint: edit?.exactFingerprint ?? operationFingerprint(chatActionToolName(action), action),
          ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
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
        // R0-8: the static check is a suspension point; a superseded submission
        // must not set the new task's verifier-tamper state.
        if (!this.isSubmissionCurrent(ownerGeneration)) {
          return this.settleStaleActionResult(
            tool,
            target,
            meta.index,
            'parent submission superseded before the action settled',
          );
        }
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
        // R0-8: the read is a suspension point; a superseded submission must not
        // append its result for the new task.
        if (!this.isSubmissionCurrent(ownerGeneration)) {
          return this.settleStaleActionResult(
            tool,
            target,
            meta.index,
            'parent submission superseded before the action settled',
          );
        }
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
        if (this.isSubmissionCurrent(ownerGeneration)) {
          const evidence = `${action.type}:${target}`;
          const discrimination = isDiscriminatingInspectionEvidence(
            this.workingState,
            action,
            recoveryTargetIdentity(this.options.projectRoot, action.file_path),
            this.workingState.recoveryGate ? this.currentRecoveryBinding() : null,
            evaluated.window.lines.join('\n').trim()
              ? createHash('sha256').update(evaluated.window.lines.join('\n')).digest('hex')
              : '',
          );
          this.workingState = applyWorkingStateEvent(this.workingState, {
            type: 'add_evidence',
            evidence,
            file: action.file_path,
            discriminating: discrimination.discriminating,
            ...(discrimination.provenance ? { provenance: discrimination.provenance } : {}),
          });
          if (discrimination.discriminating) {
            this.workingState = recordControllerRecoveryStrategy(this.workingState, {
              target,
              evidence,
            });
            this.persistRecoveryWorkingState();
          }
          this.finishRecoveryLocalizationInspection({
            tool: 'read_range', rawTarget: action.file_path,
            content: evaluated.window.lines.join('\n'), succeeded: true,
            startLine: evaluated.window.startLine,
          });
        }
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
          pushLog: (entry) => {
            // R0-8: the await is a suspension point; a superseded submission
            // must not append the settled row to the new task's tool log.
            if (this.isSubmissionCurrent(ownerGeneration)) this.toolCallLog.push(entry);
          },
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
          pushLog: (entry) => {
            // R0-8: a superseded submission must not append the settled row to
            // the new task's tool log.
            if (this.isSubmissionCurrent(ownerGeneration)) this.toolCallLog.push(entry);
          },
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

      // R0-7/R0-8: the governed action was a suspension point; a superseded
      // submission must not record a mutation batch or write the current
      // task's tool log from it.
      if (!this.isSubmissionCurrent(ownerGeneration)) {
        return this.settleStaleActionResult(
          tool,
          target,
          meta.index,
          'parent submission superseded before the action settled',
        );
      }
      if (result.mutationPaths && result.mutationPaths.length > 0) {
        recordMutationBatch(this.parity.sessionEvents, dispatchTurnId ?? 'unknown', {
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
      if (admittedThisAction && proposedEdit && directMutationAction &&
          mutationEffect.status === 'confirmed_no_change' &&
          this.isSubmissionCurrent(ownerGeneration)) {
        this.workingState = applyWorkingStateEvent(this.workingState, {
          type: 'recovery_proven_no_effect', fingerprint: proposedEdit.exactFingerprint,
        });
        this.persistRecoveryWorkingState();
      }
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
          const edit = actualRecoveryEdit(action, this.options.projectRoot);
          this.workingState = applyWorkingStateEvent(this.workingState, {
            type: 'mutation',
            path: action.path,
            fingerprint: edit?.exactFingerprint ?? operationFingerprint(chatActionToolName(action), action),
            ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
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
          const edit = actualRecoveryEdit(action, this.options.projectRoot);
          this.workingState = applyWorkingStateEvent(this.workingState, {
            type: 'mutation',
            path,
            fingerprint: edit?.exactFingerprint ?? operationFingerprint(chatActionToolName(action), action),
            ...(edit ? { canonicalFingerprint: edit.editFingerprint } : {}),
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
          const mutationPaths = result.mutationPaths ?? [];
          if (confirmedShellMutation) {
            this.workingState = applyWorkingStateEvent(this.workingState, {
              type: 'mutation',
              path: mutationPaths[0] ?? target,
              fingerprint: operationFingerprint(chatActionToolName(action), action),
            });
            noteChatWorkspaceMutation(this as never);
          }

          // B1/B2: only authoritative verifier commands update the completion receipt.
          if (isFatalWindowsProcessExit(lastResult.exit_code) && target) {
            this.platformUnusableVerifiers.add(target);
          }
          let receipt: Awaited<ReturnType<typeof captureAndRecordVerifierReceipt>> = null;
          try {
            receipt = await captureAndRecordVerifierReceipt({
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
              allowRepositoryScopeForRedRecovery: lastResult.exit_code !== 0,
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
          } catch (verifierErr) {
            // R0-7/R0-8: a superseded submission must not invalidate the live
            // task's verifier ledger from a stale capture failure.
            if (!this.isSubmissionCurrent(ownerGeneration)) {
              return this.settleStaleActionResult(
                tool,
                target,
                meta.index,
                'parent submission superseded before the verifier settled',
              );
            }
            // A verifier-receipt capture failure must degrade to "no receipt",
            // never fall through to the generic catch: that path records a
            // second terminal for an already-settled tool call and corrupts the
            // outbound tool protocol on the next provider request.
            invalidateVerifierLedger(this as never, 'verifier receipt capture failed');
            obsParts.push(
              `### verifier_receipt_unavailable\n${
                verifierErr instanceof Error ? verifierErr.message : String(verifierErr)
              }`,
            );
          }
          // R0-7/R0-8: verifier capture is a suspension point. A superseded
          // submission must not install its receipt, working state or ledger
          // invalidation on the task that now owns the engine.
          if (!this.isSubmissionCurrent(ownerGeneration)) {
            return this.settleStaleActionResult(
              tool,
              target,
              meta.index,
              'parent submission superseded before the verifier settled',
            );
          }
          if (receipt) {
            this.lastVerifierReceipt = receipt;
            const previousFailureSignature = this.workingState.failureSurface?.errorSignature;
            const recoveryBinding = lastResult.exit_code !== 0
              ? this.currentRecoveryBinding()
              : null;
            const ingested = ingestVerifierResult({
              state: this.workingState,
              tool: action.type,
              target,
              exitCode: lastResult.exit_code,
              stdout: lastResult.stdout,
              stderr: lastResult.stderr,
              summary: receipt.summary ?? String(lastResult.exit_code),
              verifierId: target,
              recoveryProjectRoot: this.options.projectRoot,
              ...(recoveryBinding ? { recoveryBinding } : {}),
              ...(receipt.boundRevision?.compositeTreeHash
                ? { workspaceRevision: String(receipt.boundRevision.compositeTreeHash) }
                : {}),
            });
            this.workingState = ingested.state;
            this.persistRecoveryWorkingState();
            this.lastVerifierFailed = ingested.lastVerifierFailed;
            const surfaceKind = this.workingState.failureSurface?.kind;
            // Only a *classified* implementation failure spends implementation
            // repair budget. An unclassified/unknown failure may be a transport
            // or environment error after a mutation; charging it would blame the
            // repair strategy for something it did not cause.
            const implementationRepairSurface = surfaceKind === 'TEST_FAILURE' ||
              surfaceKind === 'TYPECHECK_FAILURE' ||
              surfaceKind === 'BUILD_FAILURE' ||
              surfaceKind === 'LINT_FAILURE' ||
              surfaceKind === 'RUNTIME_FAILURE';
            if (
              implementationRepairSurface &&
              this.workingState.failureSurface &&
              this.workingState.failureSurface.causality !== 'pre_existing' &&
              this.workingState.failureSurface.errorSignature !== previousFailureSignature
            ) {
              this.consumeFailureBudget(makeFailureCapsule(
                'implementation',
                this.workingState.failureSurface.kind,
                this.workingState.failureSurface.errorSignature,
                { evidence_refs: this.workingState.failureSurface.evidenceRefs },
              ));
            }
          } else if (lastResult.exit_code !== 0 && this.workingState.lastMutation) {
            // A red command without a durable verifier receipt cannot grant
            // recovery authority. Keep the failed candidate closed until an
            // authoritative verifier can bind a fresh failure and revision.
            this.workingState = applyWorkingStateEvent(this.workingState, {
              type: 'recovery_gate',
              failureSignature: 'unbound-red-verifier',
              requiredEvidence: 'Rerun an authoritative verifier to bind this failure to the current candidate.',
            });
            this.persistRecoveryWorkingState();
            this.lastVerifierFailed = true;
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

        // A successful inspection is the discriminating observation required
        // after a red verifier.  This is controller-owned evidence: it clears
        // the recovery gate without treating model prose as proof.
        const inspectionAction =
          action.type === 'read_file' ||
          action.type === 'grep' ||
          action.type === 'glob' ||
          action.type === 'list_dir' ||
          action.type === 'semantic_search';
        if (
          inspectionAction &&
          lastResult &&
          lastResult.exit_code === 0 &&
          this.isSubmissionCurrent(ownerGeneration)
        ) {
          const evidence = `${action.type}:${target}`;
          const discrimination = isDiscriminatingInspectionEvidence(
            this.workingState,
            action,
            recoveryTargetIdentity(this.options.projectRoot, 'path' in action && typeof action.path === 'string' ? action.path : ''),
            this.workingState.recoveryGate ? this.currentRecoveryBinding() : null,
            lastResult.stdout.trim()
              ? createHash('sha256').update(lastResult.stdout).digest('hex')
              : '',
          );
          this.workingState = applyWorkingStateEvent(this.workingState, {
            type: 'add_evidence',
            evidence,
            discriminating: discrimination.discriminating,
            ...(discrimination.provenance ? { provenance: discrimination.provenance } : {}),
            ...(action.type === 'read_file' ? { file: action.path } : {}),
          });
          if (discrimination.discriminating) {
            this.workingState = recordControllerRecoveryStrategy(this.workingState, {
              target,
              evidence,
            });
            this.persistRecoveryWorkingState();
          }
          this.finishRecoveryLocalizationInspection({
            tool: action.type,
            rawTarget: 'path' in action && typeof action.path === 'string' ? action.path : '',
            content: lastResult.stdout, succeeded: true,
            ...(action.type === 'glob' ? { pattern: action.pattern } : {}),
          });
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
          // R0-8: the static check is a suspension point; a superseded submission
          // must not set the new task's verifier-tamper state.
          if (!this.isSubmissionCurrent(ownerGeneration)) {
            return this.settleStaleActionResult(
              tool,
              target,
              meta.index,
              'parent submission superseded before the action settled',
            );
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
      // R0-7/R0-8: an action that throws after its submission was superseded
      // must not append a failure row to the current task's tool log.
      if (!this.isSubmissionCurrent(ownerGeneration)) {
        return this.settleStaleActionResult(
          tool,
          target,
          meta.index,
          'parent submission superseded before the action settled',
        );
      }
      // R0-10: presentation callbacks are an observational side channel. If a
      // callback threw AFTER this action already recorded its execution row,
      // appending a second row would duplicate execution truth. One action
      // settles exactly one log row; only a genuine executor fault with no
      // prior row adds a failure row here.
      const alreadySettled = this.toolCallLog.length > toolCallLogStart;
      if (!alreadySettled) {
        this.toolCallLog.push({
          tool,
          target,
          detail: 'error',
          error: 'error',
          index: meta.index,
          exit_code: 1,
        });
      }
      try {
        callbacks?.onToolComplete?.(
          toolId,
          'error',
          err instanceof Error ? err.message : String(err),
          1,
        );
      } catch (callbackErr) {
        console.error(
          '[chatEngine] presentation callback failed after settlement (ignored):',
          callbackErr,
        );
      }
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
    // R0-8: bind this synthesis to the submission that started it, so a late
    // completion cannot charge the task that now owns the engine.
    const ownerGeneration = this.activeSubmissionGeneration;
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

    const usageScope = {
      taskOwnerId: this.taskAllowance?.taskOwnerId ?? null,
      projectRoot: realpathSync(this.options.projectRoot),
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: this.parity.turnId,
      chargeId: null as string | null,
      ownerGeneration,
      isOwnerCurrent: () => this.isSubmissionCurrent(ownerGeneration),
    };
    const runnerCallbacks: RunnerCallbacks | undefined = callbacks.onAnswerChunk
      ? {
          ...this.providerRetryCallbacks({
            deliveryMode: 'text',
            conversationState: prompt,
            executionStage: 'synthesis',
            usageScope,
            isOwnerCurrent: () => this.isSubmissionCurrent(ownerGeneration),
          }),
          onChunk: callbacks.onAnswerChunk,
          ...(callbacks.onThought ? { onThought: callbacks.onThought } : {}),
        }
      : this.providerRetryCallbacks({
          deliveryMode: 'text',
          conversationState: prompt,
          executionStage: 'synthesis',
          usageScope,
          isOwnerCurrent: () => this.isSubmissionCurrent(ownerGeneration),
        });
    const answer = await this.executeWithTimeout(this.synthesisRunner, prompt, runnerCallbacks);
    this.trackRunnerUsage(this.synthesisRunner, usageScope);
    return answer;
  }

  /** Record token usage from a runner invocation into the global cost tracker.
   *  #12: Also accumulates API-reported token counts for accurate estimation. */
  private trackRunnerUsage(
    runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | OpenRouterApiRunner,
    usageScope?: ChatUsageScope,
  ): void {
    // A task charge must be tied to an observed invocation start. Test/offline
    // runners can return placeholder metadata without starting a paid request.
    if (usageScope && usageScope.chargeId === null) return;
    const metadata = usageScope && 'usageMetadata' in usageScope
      ? usageScope.usageMetadata
      : runner.getLastInvocationMetadata?.();
    const appliesToCurrent = !usageScope ||
      (usageScope.taskOwnerId === this.taskAllowance?.taskOwnerId &&
        (usageScope.isOwnerCurrent?.() ?? true));
    if (
      metadata?.provider_model_id &&
      metadata.prompt_tokens !== null &&
      metadata.completion_tokens !== null
    ) {
      const chargeUpdate = globalCostTracker.settleUsage(
        metadata.provider_model_id,
        metadata.prompt_tokens,
        metadata.completion_tokens,
        metadata.prompt_cache_hit_tokens,
        metadata.prompt_cache_miss_tokens,
        usageScope
          ? captureUsageAttribution(usageScope)
          : this.taskAllowance
          ? {
              taskOwnerId: this.taskAllowance.taskOwnerId,
              projectRoot: realpathSync(this.options.projectRoot),
              projectRootVersion: 1,
              chargeId: this.pendingUsageChargeId ?? randomUUID(),
            }
          : undefined,
      );
      if (chargeUpdate.kind === 'duplicate') return;
      if (chargeUpdate.kind === 'conflict') {
        const faultScope: ChatUsageScope = usageScope ?? {
          taskOwnerId: this.taskAllowance?.taskOwnerId ?? null,
          accountingEpoch: globalCostTracker.getAccountingEpoch(),
          turnId: this.parity.turnId,
          chargeId: this.pendingUsageChargeId,
        };
        this.recordOwnerAccountingFault(
          faultScope, 'settlement-conflict', chargeUpdate.reason, appliesToCurrent,
        );
        if (faultScope.taskOwnerId) {
          try {
            this.persistOwnerCharges(faultScope.taskOwnerId, usageScope?.runDir);
          } catch (error) {
            this.recordOwnerAccountingFault(
              faultScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
              appliesToCurrent,
            );
          }
        }
        return;
      }
      if (usageScope?.taskOwnerId) {
        try {
          this.persistOwnerCharges(usageScope.taskOwnerId, usageScope.runDir);
        } catch (error) {
          this.recordOwnerAccountingFault(
            usageScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
            appliesToCurrent,
          );
          return;
        }
      }
      if (!usageScope || (appliesToCurrent && this.pendingUsageChargeId === usageScope.chargeId)) {
        this.pendingUsageChargeId = null;
      }
      // Checkpoint usage immediately after accounting so a crash before the
      // enclosing turn result is persisted cannot mint a fresh continuation
      // allowance on resume.
      if (appliesToCurrent) {
        this.persistTaskCostBaseline();
      }

      // Feed token history tracker
      const tokenTracker = getGlobalTokenTracker();
      if (metadata.estimated_cost_usd !== null) tokenTracker.record({
        inputTokens: metadata.prompt_tokens,
        outputTokens: metadata.completion_tokens,
        cost: metadata.estimated_cost_usd,
        modelId: metadata.provider_model_id,
      });

      if (!appliesToCurrent) return;
      this.lastRequestPromptTokens = metadata.prompt_tokens;
      this.lastRequestCompletionTokens = metadata.completion_tokens;
      this.lastRequestModelId = metadata.provider_model_id;

      // #12: Track cumulative API-reported tokens for accurate compaction estimates
      this.apiTokenCount += metadata.prompt_tokens + metadata.completion_tokens;

      // Tier A3: Push per-turn routing receipt
      pushRoutingReceiptFromMetadata(
        this.routingReceiptLog,
        this._turnIndex,
        this._lastPhase,
        metadata,
      );
    } else {
      const chargeId = usageScope?.chargeId ?? this.pendingUsageChargeId;
      const ownerId = usageScope ? usageScope.taskOwnerId : this.taskAllowance?.taskOwnerId;
      if (chargeId && ownerId) {
        const attribution = usageScope
          ? captureUsageAttribution(usageScope, chargeId)
          : {
              taskOwnerId: ownerId,
              chargeId,
              accountingEpoch: globalCostTracker.getAccountingEpoch(),
            };
        if (!attribution) throw new Error('Missing captured provider charge attribution');
        const update = globalCostTracker.settleUsage(
          usageScope?.modelId ?? metadata?.provider_model_id ?? 'unknown-provider-model',
          0, 0, null, null, attribution, false,
        );
        if (update.kind === 'conflict') {
          const faultScope: ChatUsageScope = usageScope ?? {
            taskOwnerId: ownerId,
            accountingEpoch: globalCostTracker.getAccountingEpoch(),
            turnId: null,
            chargeId,
          };
          this.recordOwnerAccountingFault(
            faultScope, 'settlement-conflict', update.reason, appliesToCurrent,
          );
          try {
            this.persistOwnerCharges(ownerId, usageScope?.runDir);
          } catch (error) {
            this.recordOwnerAccountingFault(
              faultScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
              appliesToCurrent,
            );
          }
        }
        if (usageScope && update.kind !== 'duplicate' && update.kind !== 'conflict') {
          try {
            this.persistOwnerCharges(ownerId, usageScope.runDir);
          } catch (error) {
            this.recordOwnerAccountingFault(
              usageScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
              appliesToCurrent,
            );
          }
        }
        if (appliesToCurrent) this.persistTaskCostBaseline();
      }
    }
  }

  /** H1 compaction: delegates to runChatEngineCompaction (atomic commit path). */
  private async compactIfNeeded(
    callbacks?: ChatCallbacks,
    forceCompaction = false,
    ownerGeneration = this.activeSubmissionGeneration,
  ): Promise<ContextCompactedInfo | null> {
    const compactionParity = this.parity;
    const compactionRunDir = this.engineRunDir;
    const compactionOwnerId = this.taskAllowance?.taskOwnerId ?? null;
    const compactionEpoch = globalCostTracker.getAccountingEpoch();
    const compactionTurnId = this.parity.turnId;
    const usageScope: {
      taskOwnerId: string | null; projectRoot: string; accountingEpoch: string; turnId: string | null;
      chargeId: string | null; requestId?: string; attemptId?: string; runDir?: string;
      ownerGeneration: number;
    } = {
      taskOwnerId: compactionOwnerId,
      projectRoot: realpathSync(this.options.projectRoot),
      accountingEpoch: compactionEpoch,
      turnId: compactionTurnId,
      chargeId: null as string | null,
      ownerGeneration,
    };
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
        usageScope,
        isOwnerCurrent: () => this.isSubmissionCurrent(ownerGeneration),
      }),
      onCompactionUsage: (usage) => {
        const attribution = compactionOwnerId
          ? captureUsageAttribution(
              usageScope, usage.inferenceId,
              usageScope.chargeId === usage.inferenceId ? usageScope.requestId : undefined,
              usageScope.chargeId === usage.inferenceId ? usageScope.attemptId : undefined,
            )
          : undefined;
        const update = globalCostTracker.settleUsage(
          usage.modelId, usage.inputTokens ?? 0, usage.outputTokens ?? 0,
          null, null, attribution,
          usage.inputTokens !== null && usage.outputTokens !== null,
        );
        if (update.kind === 'conflict') {
          this.recordOwnerAccountingFault(
            { ...usageScope, chargeId: usage.inferenceId }, 'settlement-conflict', update.reason,
            compactionOwnerId === this.taskAllowance?.taskOwnerId && this.isSubmissionCurrent(ownerGeneration),
          );
          try {
            if (compactionOwnerId) this.persistOwnerCharges(compactionOwnerId, compactionRunDir);
          } catch (error) {
            this.recordOwnerAccountingFault(
              { ...usageScope, chargeId: usage.inferenceId }, 'persistence-failure',
              error instanceof Error ? error.message : String(error),
              compactionOwnerId === this.taskAllowance?.taskOwnerId && this.isSubmissionCurrent(ownerGeneration),
            );
          }
          return;
        }
        if (compactionOwnerId && update.kind !== 'duplicate') {
          try {
            this.persistOwnerCharges(compactionOwnerId, compactionRunDir);
          } catch (error) {
            this.recordOwnerAccountingFault(
              { ...usageScope, chargeId: usage.inferenceId }, 'persistence-failure',
              error instanceof Error ? error.message : String(error),
              compactionOwnerId === this.taskAllowance?.taskOwnerId && this.isSubmissionCurrent(ownerGeneration),
            );
          }
        }
        if (this.isSubmissionCurrent(ownerGeneration)) this.persistTaskCostBaseline();
      },
      shouldUseTextTools: () => this.shouldUseTextTools(),
      compactHeuristic: () => {
        if (!this.isSubmissionCurrent(ownerGeneration)) return;
        this.compactConversation();
        host.conversation = this.conversation;
      },
      checkpoint: async () => {
        if (!this.isSubmissionCurrent(ownerGeneration)) return;
        const receipt = await checkpointParityEventLogStrict(compactionParity, compactionRunDir);
        if (receipt.status !== 'committed') {
          throw new Error(receipt.error ?? 'checkpoint persistence blocked');
        }
      },
      reserveTokens: DEFAULT_COMPACTION_CONFIG.reserveTokens,
      textToolsReserve: 1024,
      forceCompaction,
      isOwnerCurrent: () => this.isSubmissionCurrent(ownerGeneration),
      resolveModel: resolveCompactionModelId,
      shouldCompactByTokens: parityShouldCompact,
      estimateTokens,
    };
    if (this.compactionManager) host.compactionManager = this.compactionManager;
    const result = await runChatEngineCompaction(host);
    if (!this.isSubmissionCurrent(ownerGeneration)) return null;
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
    ownerGeneration = this.activeSubmissionGeneration,
  ): Promise<ContextCompactedInfo | null> {
    if (!(error instanceof PreparedRequestAdmissionError)) return null;
    if (this.preparedAdmissionCompactionAttempts >= 1) return null;
    this.preparedAdmissionCompactionAttempts += 1;
    this.pendingParentRequestId = error.request.request_id;
    return this.compactIfNeeded(undefined, true, ownerGeneration);
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
    isOwnerCurrent?: () => boolean;
    usageScope?: ChatUsageScope;
  } = {}): RunnerCallbacks {
    let startedInvocation: ProviderInvocationStarted | null = null;
    let retryCount = 0;
    const seenRetryAttemptIds = new Set<string>();
    const ownerRunDir = this.engineRunDir;
    const isOwnerCurrent = context.isOwnerCurrent ?? (() => true);
    const parentRequestId =
      this.pendingParentRequestId ??
      (context.substitutionOrFallback && this.lastLogicalRequestId !== null
        ? this.lastLogicalRequestId
        : null);
    return {
      parentRequestId,
      onInvocationStarted: (event) => {
        if (context.usageScope) {
          context.usageScope.chargeId = event.inference_id;
          delete context.usageScope.usageMetadata;
          Object.assign(context.usageScope, {
            requestId: event.request_id,
            attemptId: event.attempt_id,
            runDir: ownerRunDir,
            modelId: event.sent_model_id,
          });
          if (context.usageScope.taskOwnerId) {
            const scope = context.usageScope;
            const ownerId = scope.taskOwnerId!;
            const attribution = captureUsageAttribution(
              scope, event.inference_id, event.request_id, event.attempt_id,
            );
            const update = globalCostTracker.settleUsage(
              event.sent_model_id, 0, 0, null, null, attribution, false,
            );
            if (update.kind === 'conflict') {
              const appliesToCurrent = ownerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent();
              this.recordOwnerAccountingFault(scope, 'settlement-conflict', update.reason, appliesToCurrent);
              try {
                this.persistOwnerCharges(ownerId, ownerRunDir);
              } catch (error) {
                this.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  appliesToCurrent,
                );
              }
              throw new Error(`Provider dispatch blocked by charge conflict: ${update.reason}`);
            }
            if (update.kind === 'inserted') {
              try {
                this.persistOwnerCharges(ownerId, ownerRunDir);
              } catch (error) {
                this.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  ownerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
                );
                throw new Error('Provider dispatch blocked because its charge receipt could not be saved');
              }
            }
          }
        }
        startedInvocation = event;
        if (!isOwnerCurrent()) return;
        if (!this.parity.turnId) return;
        this.pendingUsageChargeId = event.inference_id;
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
        if (event.status === 'failed' && context.usageScope?.chargeId === event.inference_id) {
          context.usageScope.usageMetadata = null;
          context.usageScope.modelId = event.model;
          if (event.inference_started === false) {
            const scope = context.usageScope;
            const attribution = captureUsageAttribution(
              scope, event.inference_id, scope.requestId, scope.attemptId,
            );
            const chargeStillPending = scope.taskOwnerId &&
              globalCostTracker.getTaskChargeIds(scope.taskOwnerId).includes(event.inference_id);
            const cleared = !!attribution && globalCostTracker.clearUnstartedCharge(attribution);
            if (cleared && scope.taskOwnerId) {
              try {
                this.persistOwnerCharges(scope.taskOwnerId, ownerRunDir);
              } catch (error) {
                this.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
                );
              }
            } else if (chargeStillPending) {
              this.recordOwnerAccountingFault(
                scope, 'settlement-conflict', 'Unstarted provider charge could not be cleared safely',
                scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
            }
            if (!chargeStillPending || cleared) context.usageScope.chargeId = null;
          }
        }
        if (event.status === 'delivered' && context.usageScope &&
            context.usageScope.chargeId === event.inference_id) {
          context.usageScope.usageMetadata = event.usage_metadata
            ? { ...event.usage_metadata } : null;
          if (!isOwnerCurrent() && context.usageScope.taskOwnerId) {
            const scope = context.usageScope;
            const metadata = scope.usageMetadata;
            const known = metadata?.prompt_tokens != null &&
              metadata.completion_tokens != null;
            const attribution = captureUsageAttribution(
              scope, event.inference_id, scope.requestId, scope.attemptId,
            );
            const update = globalCostTracker.settleUsage(
              metadata?.provider_model_id ?? event.model,
              known ? metadata!.prompt_tokens! : 0,
              known ? metadata!.completion_tokens! : 0,
              metadata?.prompt_cache_hit_tokens ?? null,
              metadata?.prompt_cache_miss_tokens ?? null,
              attribution,
              known,
            );
            if (update.kind === 'conflict') {
              const scope = context.usageScope;
              const appliesToCurrent = scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent();
              this.recordOwnerAccountingFault(scope, 'settlement-conflict', update.reason, appliesToCurrent);
              try {
                this.persistOwnerCharges(scope.taskOwnerId!, ownerRunDir);
              } catch (error) {
                this.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  appliesToCurrent,
                );
              }
            }
            if (update.kind === 'inserted' || update.kind === 'refined') {
              try {
                this.persistOwnerCharges(context.usageScope.taskOwnerId, ownerRunDir);
              } catch (error) {
                this.recordOwnerAccountingFault(
                  context.usageScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  context.usageScope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
                );
              }
            }
          }
        }
        // An inference that started and failed may still be billed. Settle its
        // attempt under the captured owner even if a successor now owns the
        // engine; authority checks below govern live state, not old billing.
        if (event.status === 'failed' && event.inference_started === true &&
            context.usageScope?.taskOwnerId &&
            globalCostTracker.getTaskChargeIds(context.usageScope.taskOwnerId).includes(event.inference_id)) {
          const scope = context.usageScope;
          const attribution = captureUsageAttribution(scope, event.inference_id, scope.requestId, scope.attemptId);
          const update = globalCostTracker.settleUsage(
            event.model, 0, 0, null, null, attribution,
            false,
          );
          if (update.kind === 'conflict') {
            const appliesToCurrent = scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent();
            this.recordOwnerAccountingFault(scope, 'settlement-conflict', update.reason, appliesToCurrent);
            try {
              this.persistOwnerCharges(scope.taskOwnerId!, ownerRunDir);
            } catch (error) {
              this.recordOwnerAccountingFault(
                scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                appliesToCurrent,
              );
            }
          }
          if (update.kind === 'inserted' || update.kind === 'refined') {
            try {
              this.persistOwnerCharges(scope.taskOwnerId!, ownerRunDir);
            } catch (error) {
              this.recordOwnerAccountingFault(
                scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
            }
            if (isOwnerCurrent()) this.persistTaskCostBaseline();
          }
        }
        if (!isOwnerCurrent()) return;
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
        if (event.phase === 'request_dispatched' && context.usageScope?.taskOwnerId && startedInvocation) {
          const scope = context.usageScope;
          const ownerId = scope.taskOwnerId!;
          if (!globalCostTracker.getTaskChargeIds(ownerId).includes(event.inference_id)) {
            const attribution = captureUsageAttribution(
              scope, event.inference_id, scope.requestId, scope.attemptId,
            );
            const update = globalCostTracker.settleUsage(
              startedInvocation.sent_model_id, 0, 0, null, null, attribution, false,
            );
            if (update.kind !== 'inserted') {
              const appliesToCurrent = ownerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent();
              this.recordOwnerAccountingFault(
                scope, 'settlement-conflict', update.kind === 'conflict'
                  ? update.reason : 'Pending provider charge was not newly admitted', appliesToCurrent,
              );
              try {
                this.persistOwnerCharges(ownerId, ownerRunDir);
              } catch (error) {
                this.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  appliesToCurrent,
                );
              }
              throw new Error('Provider dispatch blocked by a pending charge conflict');
            }
            try {
              this.persistOwnerCharges(ownerId, ownerRunDir);
            } catch (error) {
              this.recordOwnerAccountingFault(
                scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                ownerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
              throw new Error('Provider dispatch blocked because its charge receipt could not be saved');
            }
          }
        }
        if (!isOwnerCurrent()) return;
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
        // A retry schedules the next transport attempt only after the prior
        // attempt was dispatched. Preserve possible prior billing separately
        // from the final response's logical inference charge.
        const retryKey = event.attempt_id ?? `${event.request_id ?? startedInvocation?.inference_id}:${event.attempt}`;
        if (seenRetryAttemptIds.has(retryKey)) return;
        seenRetryAttemptIds.add(retryKey);
        const scope = context.usageScope;
        if (scope?.taskOwnerId && startedInvocation) {
          const priorAttemptId = scope.attemptId ?? `attempt-${event.attempt - 1}`;
          const priorAttemptScope = {
            ...scope,
            attemptId: priorAttemptId,
            chargeId: `${startedInvocation.inference_id}:${priorAttemptId}`,
          };
          const attribution = captureUsageAttribution(priorAttemptScope, priorAttemptScope.chargeId);
          const update = globalCostTracker.settleUsage(
            startedInvocation.sent_model_id, 0, 0, null, null,
            attribution,
            false,
          );
          if (update.kind === 'conflict') {
            const appliesToCurrent = scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent();
            this.recordOwnerAccountingFault(priorAttemptScope, 'settlement-conflict', update.reason, appliesToCurrent);
            try {
              this.persistOwnerCharges(scope.taskOwnerId, ownerRunDir);
            } catch (error) {
              this.recordOwnerAccountingFault(
                priorAttemptScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                appliesToCurrent,
              );
            }
          }
          if (update.kind === 'inserted' || update.kind === 'refined') {
            try {
              this.persistOwnerCharges(scope.taskOwnerId, ownerRunDir);
            } catch (error) {
              this.recordOwnerAccountingFault(
                priorAttemptScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
            }
            if (isOwnerCurrent()) this.persistTaskCostBaseline();
          }
          const pendingExists = globalCostTracker.getTaskChargeIds(scope.taskOwnerId)
            .includes(startedInvocation.inference_id);
          const currentAttemptAttribution = captureUsageAttribution(
            scope, startedInvocation.inference_id, scope.requestId, scope.attemptId,
          );
          if (pendingExists && (!currentAttemptAttribution ||
              !globalCostTracker.clearUnstartedCharge(currentAttemptAttribution))) {
            this.recordOwnerAccountingFault(
              scope, 'settlement-conflict', 'Unstarted retry charge could not be cleared safely',
              scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
            );
          } else if (pendingExists) {
            try {
              this.persistOwnerCharges(scope.taskOwnerId, ownerRunDir);
            } catch (error) {
              this.recordOwnerAccountingFault(
                scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                scope.taskOwnerId === this.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
            }
          }
        }
        if (!isOwnerCurrent()) throw new Error('Provider retry blocked by retired task owner');
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
        if (scope?.taskOwnerId) {
          const budget = this.checkBudgets(true);
          if (!budget.ok) {
            throw new Error(`Provider retry blocked by task allowance: ${budget.reason ?? 'unavailable'}`);
          }
          scope.attemptId = event.attempt_id ?? `attempt-${event.attempt}`;
        }
      },
      onRetrySettled: (event) => {
        if (!isOwnerCurrent()) return;
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
    const usageGeneration = this.activeSubmissionGeneration;
    const usageScope = {
      taskOwnerId: this.taskAllowance?.taskOwnerId ?? null,
      projectRoot: realpathSync(this.options.projectRoot),
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: this.parity.turnId,
      chargeId: null as string | null,
      ownerGeneration: usageGeneration,
      isOwnerCurrent: () => this.isSubmissionCurrent(usageGeneration),
    };
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
          usageScope,
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
      this.trackRunnerUsage(runner, usageScope);
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
          usageScope,
        }),
        systemPrompt,
      );
      const turn = parseTextToolTurn(rawText);
      this.trackRunnerUsage(runner, usageScope);
      return turn;
    }

    let streamedChunks = '';
    let looksLikeJson = false;
    const deliberationCallbacks: RunnerCallbacks = {
      ...this.providerRetryCallbacks({
        deliveryMode: 'text',
        conversationState: promptOrMessages,
        executionStage: 'chat',
        usageScope,
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
    this.trackRunnerUsage(runner, usageScope);
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
    ownerGeneration?: number,
  ): AsyncGenerator<
    ChatEvent,
    DeepInfraApiRunner | DeepSeekApiRunner | OpenRouterApiRunner | null,
    undefined
  > {
    // R0-8: a superseded generator must not resolve a fallback or emit a
    // terminal for the task that now owns the engine.
    if (ownerGeneration !== undefined && !this.isSubmissionCurrent(ownerGeneration)) {
      return null;
    }
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

  /**
   * R0/W7: harness-origin verifier-tamper block. The R9 tamper guard records
   * each integrity violation and auto-blocks at tamperCount >= 3; that origin
   * is trusted, so the report must never depend on the model's synthesized
   * prose. A repeated integrity violation is a recovery-exhausted policy block
   * with a harness cause.
   */
  private buildTamperBlockedReport(): BlockedReport {
    return {
      schema_version: 1,
      status: 'BLOCKED',
      reason_code: 'recovery_exhausted',
      cause_class: 'harness',
      reason: `Verifier integrity compromised — ${this.tamperCount} verifier dependency files were modified. The task cannot be completed honestly.`,
      missing: 'An unmodified verifier dependency set for an independent verification.',
      checked: [
        {
          action: 'verifier_integrity',
          target: 'verifier_dependencies',
          finding: `${this.tamperCount} verifier dependency modification(s) recorded by the R9 tamper guard`,
        },
      ],
    };
  }

  private buildVerifierBlockedReport(reason: string): BlockedReport {
    if (this.workingState.localization?.phase === 'exhausted') {
      const localization = this.workingState.localization;
      return {
        schema_version: 1,
        status: 'BLOCKED',
        reason_code: 'localization_exhausted',
        cause_class: 'harness',
        reason: 'LOCALIZATION_EXHAUSTED: no diagnostic candidate was corroborated within the bounded allowance.',
        missing: 'A source or test location supported by a content-bearing read and the failure diagnostic.',
        checked: [{
          action: 'localize_failure',
          target: localization.failureSignature.slice(0, 180),
          finding: `${localization.calls} inspection call(s), ${localization.rounds} candidate scope(s); no accepted target`,
        }],
      };
    }
    // R0-A: a harness-origin block must carry REAL checked evidence, never an
    // empty `checked` array (BlockedReportSchema requires >=1) and never a fake
    // placeholder. Prefer the actual verifier attempt when one ran red; else the
    // completion gate's own rejection is the evidence of record.
    const receipt = this.lastVerifierReceipt;
    const redReceipt =
      receipt && receipt.exit_code !== 0 && receipt.stale !== true ? receipt : null;
    if (redReceipt) {
      const finding = (
        redReceipt.summary && redReceipt.summary.trim() !== ''
          ? redReceipt.summary
          : `exit ${redReceipt.exit_code}`
      ).slice(0, 500);
      return {
        schema_version: 1,
        status: 'BLOCKED',
        reason,
        missing: 'A passing authoritative verifier for the current workspace revision.',
        reason_code: 'verification_failed',
        cause_class: 'verification',
        checked: [
          {
            action: 'run_command',
            target: redReceipt.command || 'verifier',
            finding,
          },
        ],
      };
    }
    return {
      schema_version: 1,
      status: 'BLOCKED',
      reason,
      missing: 'A completion that satisfies the artifact and verifier honesty gate.',
      reason_code: 'recovery_exhausted',
      cause_class: 'harness',
      checked: [
        {
          action: 'completion_gate',
          target: this.hasAnyWrites() ? 'verifier_honesty' : 'zero_successful_writes',
          finding: reason.slice(0, 500),
        },
      ],
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

  /**
   * D03: single resolution point for the structured terminal reason. Explicit
   * arbiter reason wins; then a reason already on the blocked report; then the
   * limiter classification; then the outcome fallback.
   */
  private resolveTerminalReason(
    outcome: TerminalOutcome | undefined,
    blockedReport?: BlockedReport | null,
    explicit?: TerminalReason,
  ): TerminalReason | undefined {
    if (explicit) return explicit;
    if (blockedReport?.reason_code !== undefined) {
      return {
        code: blockedReport.reason_code,
        cause_class: blockedReport.cause_class ?? null,
      };
    }
    const verificationFailure = this.resolveVerificationFailureReason(outcome);
    if (verificationFailure) return verificationFailure;
    return (
      terminalReasonFromClassification(
        this.terminatingLimiter
          ? classifyTerminalLimiter(this.terminatingLimiter, this.terminalLimiterReason ?? undefined)
          : null,
      ) ?? terminalReasonFromOutcome(outcome)
    );
  }

  /**
   * D03/S07: a mutation that ended without success while a *current*
   * authoritative verifier receipt is red is a verification failure — distinct
   * from "no verifier was run" (which stays unknown). Stale receipts cannot
   * establish this cause.
   */
  private resolveVerificationFailureReason(
    outcome: TerminalOutcome | undefined,
  ): TerminalReason | undefined {
    return terminalReasonFromVerifierFailure({
      hasMutation: this.hasAnyWrites(),
      outcome,
      receipt: this.lastVerifierReceipt,
    });
  }

  /** Persist exactly one authoritative completion decision for this turn. */
  private recordCompletionDecisionOnce(decision: {
    requestedOutcome: string;
    finalOutcome: string;
    allowed: boolean;
    reason: string;
    evidenceRefs: string[];
    policyVersion: string;
    reasonCode?: TerminalReasonCode;
    causeClass?: 'model' | 'provider' | 'environment' | 'harness' | 'verification' | null;
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

  private assembleRunAllowance(
    finalStatus: ChatResult['status'],
    persist = true,
  ): ChatEngineRunAllowanceReport {
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
    if (!persist) {
      // R0-8: a superseded caller computes its own (obsolete) report but must
      // not overwrite the live task's run-allowance artifact or cost baseline.
      return runAllowance;
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
    knownReason?: TerminalReason,
    ownerGeneration?: number,
  ): ChatResult {
    // R0-8: a superseded caller must not finalize the task that now owns the
    // engine. It still receives a truthful result for its own (obsolete)
    // submission, but no completion decision, wall settlement or durable turn
    // finalization is applied to the live task.
    const superseded =
      ownerGeneration !== undefined && !this.isSubmissionCurrent(ownerGeneration);
    // R1: If the answer explicitly declares BLOCKED but no blockedReport was
    // provided (e.g., the detection ran in a code path that didn't provide it),
    // promote the status to 'blocked' and generate the report here.
    // F4: only a protocol-shaped declaration (`BLOCKED` at the start of a line)
    // is even considered, and promotion to a blocked terminal requires an actual
    // evidence-backed report (harness-provided, or synthesized only when real
    // investigate tool calls exist). Model prose alone cannot create a block —
    // this keeps the callback surface consistent with the streaming surface.
    const declaredBlocked = !!(answer && /(?:^|\n)\s*BLOCKED\b/.test(answer));
    const synthesizedReport =
      declaredBlocked && !blockedReport ? this.detectAndBuildBlockedReport(answer ?? '') : null;
    const finalBlockedReport = blockedReport ?? synthesizedReport;
    const finalStatus =
      (status === 'completed' || status === 'failed') && finalBlockedReport
        ? ('blocked' as const)
        : status;

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
            readOnly: this.isAcceptedReadOnlyTerminal(),
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
    const terminalReason =
      finalStatus === 'cancelled'
        ? ({ code: 'cancelled' as const, cause_class: null } satisfies TerminalReason)
        : this.resolveTerminalReason(
            authoritativeOutcome ?? outcome,
            finalBlockedReport,
            knownReason,
          );
    // R0-9: keep the tuple coherent on the callback/non-stream path. As on the
    // streaming path, `verification_failed` pairs with `UNVERIFIED_PATCH` when
    // the gate recorded a patch, so it is not remapped to AGENT_FAILURE.
    const projectedOutcome =
      (terminalReason?.code && terminalReason.code !== 'verification_failed'
        ? outcomeFromReasonCode(terminalReason.code)
        : undefined) ?? authoritativeOutcome;
    if (kernelDecision && !superseded) {
      this.recordCompletionDecisionOnce({
        requestedOutcome: kernelDecision.requestedOutcome,
        finalOutcome: authoritativeOutcome ?? kernelDecision.finalOutcome,
        allowed: kernelDecision.allowed,
        reason: kernelDecision.reason,
        evidenceRefs: kernelDecision.evidenceRefs,
        policyVersion: kernelDecision.policyVersion,
        ...(terminalReason !== undefined
          ? { reasonCode: terminalReason.code, causeClass: terminalReason.cause_class }
          : {}),
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
      ...(projectedOutcome !== undefined ? { outcome: projectedOutcome } : {}),
      status: finalStatus,
    });

    if (!superseded) {
      this.settleActiveExecutionForTerminal();
      // AC3 choke point: memory + disk (idempotent if streamDone already finalized)
      finalizeParityTurnSync(
        this.parity,
        this.engineRunDir,
        terminal.outcome,
        terminal.status,
        terminalReason,
      );
    }

    const runAllowance = this.assembleRunAllowance(terminal.status, !superseded);

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
      ...(terminalReason !== undefined
        ? { reason_code: terminalReason.code, cause_class: terminalReason.cause_class }
        : {}),
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
