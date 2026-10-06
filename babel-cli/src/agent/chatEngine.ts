/**
 * ChatEngine — unified conversational agent loop for Babel chat mode.
 * Chat investigates and executes; deep mode remains the governed pipeline.
 * Compaction: chatCompaction.ts. Critic/budget: chatEngineCriticBudget.ts.
 */

import {
  completeChatStream,
  failChatStream,
  cancelChatStream,
  assembleChatResult,
  type ChatTerminalInput,
  type ChatStreamDoneExtra,
} from "./chatEngineTerminalRuntime.js";
import {
  resolveChatDeliberationRunner,
  resolveChatFallbackRunner,
  resolveChatSynthesisRunner,
  synthesizeChatAnswer,
  executeChatRunnerWithTimeout,
  shouldUseChatNativeTools,
  shouldUseChatTextTools,
  deliberateChatTurn,
  resolveChatFallbackOrFail,
  type ChatProviderRunner,
  type ChatProviderUsageEffects,
} from "./chatEngineProviderRuntime.js";
import type {
  TaskIntent,
  ChatAllowanceGrant,
  ChatTaskAllowanceSnapshot,
  SubmitMessageOptions,
  ChatEngineOptions,
  ChatEngineTurnPreparation,
  ContextCompactedInfo,
  ChatCallbacks,
  ChatEvent,
  ChatResult,
} from "./chatEngineContracts.js";
import {
  deriveChildDelegationId,
  formatTextToolResults,
  parseChatTurnLenient,
} from "./chatEngineHelpers.js";
import { classifyChatTaskIntent } from "./chatEngineTaskIntent.js";

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { resolveProjectPath } from "../utils/projectPath.js";

import { trace } from "@opentelemetry/api";

import {
  chatSessionDir,
  transcriptPath as layoutTranscriptPath,
} from "../cli/runsLayout.js";
import { allocateThreadId } from "../services/threadStore/threadIds.js";
import { DeepInfraApiRunner } from "../runners/deepInfraApi.js";
import { DeepSeekApiRunner } from "../runners/deepSeekApi.js";
import { OllamaApiRunner } from "../runners/ollamaApi.js";

import { OpenRouterApiRunner } from "../runners/openRouterApi.js";
import type { ProviderMessage, RunnerCallbacks } from "../runners/base.js";
import { mapProviderMessagesToWire } from "../runners/providerMessages.js";
import {
  assertLiveModelId,
  LIVE_OPENROUTER_MODEL_ID,
  type ResolvedModelPolicy,
} from "../modelPolicy.js";
import {
  isOfflineChatMode,
  resolveChatModelPolicy,
} from "./chatModelPolicy.js";
import { globalCostTracker } from "../services/costTracker.js";

import {
  selectPlaybookForChatTask,
  type PlaybookDefinition,
} from "../services/playbooks/playbookService.js";
import { shouldRequireTodoPlan } from "./planThenExecute.js";
import {
  operatorModeIsHardPlan,
  resolveForceMutateTurnsForHandoff,
  type ChatOperatorMode,
  type ChatPlanExecuteHandoff,
} from "./planExecuteMode.js";

import type {
  BlockedReport,
  TerminalOutcome,
  TerminalReasonCode,
} from "../schemas/agentContracts.js";
import {
  CompactionManager,
  DEFAULT_COMPACTION_CONFIG,
  estimateTokens,
  resolveCompactionModelId,
} from "./chatCompaction.js";
import { runChatEngineCompaction } from "./compactionCommit.js";
import { PreparedRequestAdmissionError } from "../runners/preparedProviderRequest.js";
import {
  initLiveAuthorityOnEngine,
  projectEngineLiveSession,
  refreshEngineInstructionManifest,
  restoreEngineSessionEvents,
  engineCanMutateKey,
} from "./chatEngineLiveSession.js";
import {
  AUTHORITY_SESSION_FILENAME,
  restoreAuthoritySession,
} from "../authority/sessionContext.js";
import {
  loadLiveSessionAuthorityStrict,
  persistLiveSessionAuthority,
  recoverCheckpointArtifacts,
} from "./liveSessionBridge.js";
import type { LiveSessionV1 } from "./liveSession.js";
import {
  createFailureBudgetTrackerFromContract,
  type FailureClassBudgetTracker,
  type FailureCapsuleV1,
} from "./taskContract.js";

import {
  explicitFiniteCostOverride,
  resolveChatEngineLimits,
  shouldShrinkWallForPostWriteRepair,
  type ChatEngineLimits,
  type ChatRunLimiter,
} from "../config/chatEngineLimits.js";
import {
  classifyFailureText,
  projectChatTerminal,
} from "./chatFailureClassification.js";

import {
  resolveChatTaskClass,
  getChatTaskTune,
  type ChatTaskClass,
  type VerificationPolicy,
} from "../config/chatTaskClass.js";
import {
  buildGateRejectUserMessageForEngine,
  evaluateCompletionGateForEngine,
  isAuthoritativeVerifierCommand,
} from "./completionGatePolicy.js";
import {
  formatTestCommandsForGate,
  type DiscoveredTestCommand,
  discoverProjectTestCommands,
} from "./projectTestDiscovery.js";

import {
  isExplorationBudgetTool,
  normalizeReadCacheKey,
} from "./readThrashPolicy.js";
import {
  applyWorkingStateEvent,
  createWorkingState,
  restoreWorkingStateSnapshot,
  sameRecoveryBinding,
  resetOneShotSnapshot,
  type RecoveryCandidateBinding,
  resolveNextTurnToolAccess,
  snapshotOnce,
  type ReadInjectionCache,
  type WorkingState,
} from "./codingLoop/index.js";

import { recoveryTargetIdentity } from "./codingLoop/recoveryIdentity.js";

import {
  beginLocalizationCall,
  discoverTestCandidates,
  finishLocalizationCall,
} from "./codingLoop/failureLocalization.js";

import {
  buildAnswerSynthesisPrompt,
  chatActionToolName,
  chatActionTarget,
  type ChatMessage,
  type ChatToolAction,
  type ChatTurn,
} from "./chatToolDefinitions.js";

import {
  type ChatEngineServices,
  type ChatExecutionProfile,
} from "./chatEngineServices.js";
import {
  createExecutorKernel,
  type ExecutorKernel,
} from "../executor/kernel.js";
import {
  evaluateChatCompletionProof,
  mutationPathsFromSessionEvents,
  refreshChatVerifierReceiptStalenessSync,
  toGateToolLog,
  type BoundChatVerifierReceipt,
} from "../evidence/chatRevisionBinding.js";
import { RevisionManager } from "../evidence/revisionBoundReceipt.js";
import { resolveIsolationBrokerFlags } from "./chatEngineIsolationFlags.js";

import {
  planToolBatches,
  orderChatToolActions,
  isCircuitBreakerObservation,
} from "./agentLoopReducer.js";
import {
  createParityRuntime,
  paritySettleToolStarted,
  paritySettleToolNotStarted,
  parityAuthorizeRecoveredOutcomeRetry,
  parityShouldCompact,
  parityTryFailover,
  finalizeParityTurnSync,
  finalizeParityCancel,
  checkpointParityEventLogStrict,
  type ParityRuntime,
} from "./chatEngineParityBridge.js";
import { loadThreadEventLogFromDir } from "./threadEventLog.js";
import { isOperatorAbortError } from "./operatorAbort.js";
import {
  loadSessionEventLogForResume,
  loadSessionEventLogIfPresentForResume,
  recordModelFailover,
  recordWorkingStateSnapshot,
  flushSessionEventLogStrict,
  resumedToolRecoveryGuidance,
  operationFingerprint,
  requiresRecoveredOutcomeReconciliation,
  type SessionEventLog,
} from "./sessionEvents.js";
import { type ObservationRefV1 } from "../evidence/observationStore.js";
import {
  type ContextCheckpointOwnerV1,
  type ContextCheckpointPreparationResultV1,
  type LiveOperationalSourcesV1,
} from "../runtime/contextCheckpoints.js";
import type { AdmissionStore } from "../runtime/admission.js";

import { captureSessionEventAppendFailure } from "./sessionEventDiagnostics.js";
import { buildRepoMapPreamble } from "./repoMapPreamble.js";
import { getChatApprovalSession } from "./chatApproval.js";

import {
  scopeAsyncGenerator,
  type ExecutionContext,
} from "./executionContext.js";
import {
  clearBackgroundShellRegistry,
  killAllBackgroundShells,
} from "./backgroundShell.js";
import {
  createProviderProtocolInvariant,
  createRequestReconstructionInvariant,
  MODEL_VISIBLE_EQUALS_PERSISTED,
  PROVIDER_PROTOCOL_VALID,
  resolveRuntimeInvariantMode,
  RuntimeInvariantRegistry,
  type RequestReconstructionContext,
} from "./runtimeInvariants.js";
import { validateProviderMessageProtocol } from "../runners/providerMessages.js";
import { createHash, randomUUID } from "node:crypto";
import { type ContextDeliveryMode } from "./contextManifest.js";
import { type ModelRouteStage } from "./modelRouteReceipt.js";

import {
  buildProviderRetryCallbacks,
  captureUsageAttribution,
  trackRunnerUsage as trackProviderRunnerUsage,
  type ChatProviderRetryHost,
  type ChatUsageScope,
} from "./chatEngineProviderAccounting.js";
import {
  ChatEngineP11Authority,
  type ChatEngineAdmissionClaim,
  type ChatEngineP11Host,
} from "./chatEngineP11Authority.js";

export { childAttemptDir } from "./chatEngineChildExecution.js";
import {
  ChatEngineOwnerAccounting,
  type OwnerAccountingFault,
  type ChatEngineOwnerAccountingHost,
} from "./chatEngineOwnerAccounting.js";
import {
  allowanceCostCapUsd,
  parseTaskAllowance,
  ChatEngineTaskAllowance,
  type ChatTaskAllowanceHost,
} from "./chatEngineTaskAllowance.js";
import {
  ChatEngineActionExecutor,
  type ChatEngineActionExecutorHost,
} from "./chatEngineActionExecutor.js";
import {
  ChatEngineStreamingLoop,
  type ChatEngineStreamingLoopHost,
} from "./chatEngineStreamingLoop.js";
export { reconcileStreamedAnswer } from "./chatEngineStreamingProtocol.js";
import {
  type ChildBudgetLimiter,
  type InheritedChildAllowance,
} from "./childBudget.js";
import { childBudgetAttribution } from "./lanes/runMutationAgentLoop.js";

import { type ToolContext } from "../localTools.js";
import {
  createStallDetector,
  getStallInterventionMessage,
} from "./stallDetector.js";
import type { StallState, StallIntervention } from "./stallDetector.js";
import type { ProgressController } from "./progressController.js";

import { type ChatPhase } from "./chatPhaseNudge.js";
import {
  isSuccessfulDirectMutation,
  type MutationEffectStatus,
} from "./mutationTools.js";
import {
  ChatTurnTelemetryCollector,
  type ChatTurnTelemetryRecord,
} from "./chatTurnTelemetry.js";
import type { DiffCriticVerdict } from "./diffCritic.js";

import {
  applyExploreFuses as applyExploreFusesPolicy,
  type ExploreFuseResult,
} from "./chatZeroWritePolicy.js";
import { PolicyEventLog } from "./policyEventLog.js";
import { type TerminalReason } from "./chatTerminalReason.js";
import {
  resolveStallInterventionsEnabled,
  resolveStallShadowMode,
} from "./policyShadow.js";

import { BlockedAttemptLedger } from "./blockedAttemptLedger.js";
import { TurnRoutingReceiptLog } from "./turnRoutingReceipt.js";
import { resolvePhaseModelName } from "./phaseModelRouting.js";
import {
  ObservationTailBuffer,
  resolveObservationTailChars,
} from "./observationTails.js";
import {
  makeChatRunner,
  type ObservabilityHandles,
} from "./chatEngineObservability.js";

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
} from "./chatEngineCriticBudget.js";
import {
  detectAndBuildBlockedReport as detectBlockedReportFromAnswer,
  runPostEditStaticCheck as runPostEditStaticCheckFn,
  summarizeDroppedTurns as summarizeDroppedTurnsFn,
  compactHeuristicConversation,
} from "./chatEngineSupport.js";
import {
  applyTamperEscalation as applyTamperEscalationFn,
  checkVerifierTamper as checkVerifierTamperFn,
  extractVerifierCommand as extractVerifierCommandFn,
  hashContent as hashContentFn,
  initializeVerifierDependencyHashes,
} from "./chatEngineVerifierSession.js";

import { RepetitionDetector } from "./repetitionDetector.js";
import { captureThought } from "./thoughtCapture.js";
import {
  prepareKernelVerifierInput,
  resolveEngineRequiredVerifiers,
  restorePersistedVerifierEvidence,
} from "./chatEngineVerifierAdapter.js";
import {
  beginUserSubmission,
  type TurnRuntimeSnapshot,
} from "./turnRuntime.js";

import { isReadOnlyChat } from "./chatReadOnly.js";

/**
 * Version label for the chat tool surface offered to admitted commands. Part
 * of the canonical admission digest; bump when the offered chat tool schema
 * changes so a digest can never call two different tool surfaces "the same
 * admitted command".
 */
const CHAT_ADMISSION_TOOL_SCHEMA_VERSION = "chat-tools-v1";

/**
 * R1/T5: placeholder compiled-request identity for the side-effect-free
 * candidate prepare. The real identity can only be computed after this turn's
 * provider messages are rebuilt from the candidate (the identity hashes that
 * exact message sequence), and `installP11ContextCheckpoint` always
 * re-prepares from the live sources with the real identity — so this marker is
 * never installed and never becomes durable authority.
 */
const PENDING_COMPILED_REQUEST_IDENTITY = "pending-compiled-request-identity";

// ─── Constants ────────────────────────────────────────────────────────────

const TURN_TIMEOUT_MS = 120_000; // per-turn LLM call deadline
const MAX_TOOL_CONCURRENCY = 6;

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
  private readonly ownerAccounting: ChatEngineOwnerAccounting;
  private readonly taskAllowanceOwner: ChatEngineTaskAllowance;
  private readonly actionExecutor: ChatEngineActionExecutor;
  private readonly streamingLoop: ChatEngineStreamingLoop;
  private readonly p11Authority: ChatEngineP11Authority;
  /** P11 A11a: exact approved observation refs retained for the installed context. */
  private p11ObservationRefs: ObservationRefV1[] = [];
  private p11ObservationCaptureIssues: string[] = [];
  /** P11 install diagnostics: structured block reason of the last refused install. */
  p11InstallBlock: { code: string; details: string[] } | null = null;
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
  private logicalTurnToolPolicy: import("./codingLoop/oneShotToolPolicy.js").OneShotPolicySnapshot<
    ReturnType<typeof resolveNextTurnToolAccess>
  > = { taken: false };
  private _sessionStartTime = 0;
  /** Legacy observable baseline; enforcement uses task-indexed accounting. */
  private taskCostBaselineUsd = 0;
  /** Durable allowance for the current immutable task owner. */
  private taskAllowance: ChatTaskAllowanceSnapshot | null = null;
  /** Owner-bound accounting faults travel with the existing owner charge receipt checkpoint. */
  private readonly ownerAccountingFaults = new Map<
    string,
    OwnerAccountingFault[]
  >();
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
  private operatorMode: ChatOperatorMode = "default";
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

  private readPersistedTaskBudget(
    runDir: string,
  ): ChatTaskAllowanceSnapshot | null {
    const path = join(runDir, "task-budget.json");
    if (!existsSync(path)) return null;
    try {
      return parseTaskAllowance(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  }

  private ownerChargeDir(runDir = this.engineRunDir): string {
    return this.ownerAccounting.ownerChargeDir(runDir);
  }

  private ownerChargePath(ownerId: string, runDir = this.engineRunDir): string {
    return this.ownerAccounting.ownerChargePath(ownerId, runDir);
  }

  private recordOwnerAccountingFault(
    scope: ChatUsageScope,
    kind: OwnerAccountingFault["kind"],
    reason: string,
    appliesToCurrent: boolean,
  ): void {
    this.ownerAccounting.recordOwnerAccountingFault(
      scope,
      kind,
      reason,
      appliesToCurrent,
    );
  }

  private persistOwnerAccountingFaultCheckpoint(): void {
    this.ownerAccounting.persistOwnerAccountingFaultCheckpoint();
  }

  private persistOwnerCharges(
    ownerId: string,
    runDir = this.engineRunDir,
  ): void {
    this.ownerAccounting.persistOwnerCharges(ownerId, runDir);
  }

  private restoreOwnerCharges(runDir: string): boolean {
    return this.ownerAccounting.restoreOwnerCharges(runDir);
  }

  private checkpointActiveWall(nowMs = Date.now()): void {
    this.taskAllowanceOwner.checkpointActiveWall(nowMs);
  }

  private persistTaskAllowance(): void {
    this.taskAllowanceOwner.persistTaskAllowance();
  }

  /** Compatibility wrapper retained for existing checkpoint call sites. */
  private persistTaskCostBaseline(): void {
    this.persistTaskAllowance();
  }

  private createTaskAllowance(): ChatTaskAllowanceSnapshot {
    return this.taskAllowanceOwner.createTaskAllowance();
  }

  private startIndependentTaskCostScope(): void {
    this.taskAllowanceOwner.startIndependentTaskCostScope();
  }

  private currentTaskCostUsd(): number {
    return this.taskAllowanceOwner.currentTaskCostUsd();
  }

  private currentTaskActiveWallMs(nowMs = Date.now()): number {
    return this.taskAllowanceOwner.currentTaskActiveWallMs(nowMs);
  }

  private restorePersistedTaskBudget(
    persisted: ChatTaskAllowanceSnapshot | null,
  ): void {
    this.taskAllowanceOwner.restorePersistedTaskBudget(persisted);
  }

  public getTaskAllowanceSnapshot(): ChatTaskAllowanceSnapshot | null {
    return this.taskAllowanceOwner.getTaskAllowanceSnapshot();
  }

  /** Explicitly replace the current grant. No other path may increase caps. */
  public renewAllowance(grant: ChatAllowanceGrant): void {
    this.taskAllowanceOwner.renewAllowance(grant);
  }

  private beginActiveExecution(): void {
    this.taskAllowanceOwner.beginActiveExecution();
  }

  private pauseActiveExecution(): void {
    this.taskAllowanceOwner.pauseActiveExecution();
  }

  /** Settle the active task interval before exposing any terminal truth. */
  private settleActiveExecutionForTerminal(): void {
    this.taskAllowanceOwner.settleActiveExecutionForTerminal();
  }

  private consumeTaskTurn(): void {
    this.taskAllowanceOwner.consumeTaskTurn();
  }

  private effectiveCostCapUsd(): number {
    return this.taskAllowanceOwner.effectiveCostCapUsd();
  }

  private effectiveWallCapMs(): number {
    return this.taskAllowanceOwner.effectiveWallCapMs();
  }

  private deriveChildAllowance(maxRounds: number): InheritedChildAllowance {
    return this.taskAllowanceOwner.deriveChildAllowance(maxRounds);
  }

  private markChildBudgetExhausted(
    limiter: ChildBudgetLimiter,
    reason: string,
  ): void {
    this.taskAllowanceOwner.markChildBudgetExhausted(limiter, reason);
  }
  constructor(options: ChatEngineOptions) {
    this.options = options;
    this.ownerAccounting = new ChatEngineOwnerAccounting(
      this as unknown as ChatEngineOwnerAccountingHost,
    );
    this.taskAllowanceOwner = new ChatEngineTaskAllowance(
      this as unknown as ChatTaskAllowanceHost,
    );
    this.actionExecutor = new ChatEngineActionExecutor(
      this as unknown as ChatEngineActionExecutorHost,
    );
    this.streamingLoop = new ChatEngineStreamingLoop(
      this as unknown as ChatEngineStreamingLoopHost,
    );
    this.p11Authority = new ChatEngineP11Authority(
      this as unknown as ChatEngineP11Host,
    );
    this.testWorkspaceRevisionHash = options.testWorkspaceRevisionHash;
    this.executionProfile = options.executionProfile ?? "chat";
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
        ...(options.maxTurns !== undefined
          ? { maxTurns: options.maxTurns }
          : {}),
        ...(options.maxConversationMessages !== undefined
          ? { maxConversationMessages: options.maxConversationMessages }
          : {}),
        ...(options.maxEstimatedTokens !== undefined
          ? { maxEstimatedTokens: options.maxEstimatedTokens }
          : {}),
        ...(options.maxTokensPerRound !== undefined
          ? { maxTokensPerRound: options.maxTokensPerRound }
          : {}),
        ...(options.maxWallMs !== undefined
          ? { maxWallMs: options.maxWallMs }
          : {}),
        ...(options.maxCostUsd !== undefined
          ? { maxCostUsd: options.maxCostUsd }
          : {}),
      },
      undefined,
      { taskClass: this.taskClass, taskText: options.task },
    );
    this.abortController = new AbortController();
    this.engineRunId = options.runId ?? allocateThreadId();
    // definite assignment: engineRunId set immediately above
    this.parity = createParityRuntime(this.engineRunId);
    if (options.admissionStore)
      this.parity.admissionStore = options.admissionStore;
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
    if (process.env["BABEL_COMPACTION"] !== "off") {
      this.compactionManager = new CompactionManager();
    }
    mkdirSync(this.engineRunDir, { recursive: true });
    const persistedTaskBudget = options.resumeExisting
      ? this.readPersistedTaskBudget(this.engineRunDir)
      : null;
    const chargeFilesValid =
      !options.resumeExisting || this.restoreOwnerCharges(this.engineRunDir);
    if (options.resumeExisting)
      this.restorePersistedTaskBudget(persistedTaskBudget);
    else {
      this.taskAllowance = this.createTaskAllowance();
      this.taskCostBaselineUsd = this.taskAllowance.taskCostBaselineUsd;
    }
    if (!chargeFilesValid) this.taskCostScopeUnavailable = true;
    this.persistTaskCostBaseline();

    if (options.resumeExisting) {
      this.parity.liveAuthority = loadLiveSessionAuthorityStrict(
        this.engineRunDir,
      );
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
    this.patchRecoveryPath = join(this.engineRunDir, "patches.recovery.log");

    // R9: Initialize verifier guard — track hashes of verifier dependency
    // files so tampering can be detected and flagged in real-time.
    this.initializeVerifierGuard();

    // Playbook selection still drives the todo gate. Its prose is not copied
    // into the prompt; project instructions come from AGENTS.md and ENGINEERING.md.
    const chatPlaybook = selectPlaybookForChatTask(this.options.task);
    if (chatPlaybook) {
      this.activePlaybook = chatPlaybook;
    }
    // Plan-then-execute hard gate when playbook/size threshold says so.
    this.requireTodoBeforeMutate = shouldRequireTodoPlan(
      this.options.task,
      this.activePlaybook,
    );

    // Implementor W1.3 / W1.4: operator mode + hard plan + plan handoff.
    this.operatorMode = options.operatorMode ?? "default";
    this.hardPlanMode =
      this.executionProfile === "plan" ||
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
    const { policy: modelPolicy, offline: isOffline } =
      options.providerPolicy && options.providerRunner
        ? { policy: options.providerPolicy, offline: false }
        : resolveChatModelPolicy({
            ...(options.model !== undefined ? { model: options.model } : {}),
            ...(options.modelTier !== undefined
              ? { modelTier: options.modelTier }
              : {}),
            ...(options.allowExpensive === true
              ? { allowExpensive: true }
              : {}),
            ...(process.env["BABEL_ROOT"]
              ? { babelRoot: process.env["BABEL_ROOT"] }
              : {}),
          });
    this.modelPolicy = modelPolicy;
    if (options.providerRunner) {
      this.deliberationRunner =
        this.synthesisRunner =
        this.fallbackRunner =
          options.providerRunner;
    }
    // Exact experimental routes are campaign boundaries: phase-specific
    // environment overrides must not recruit another provider/model.
    if (
      this.modelPolicy.provider === "openrouter" &&
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
    this.discoveredTestCommands = discoverProjectTestCommands(
      this.options.projectRoot,
    );
    // Repetition loop detector: safety net for text-tools path gemma loops.
    this.repetitionDetector = new RepetitionDetector();
    // Tier A5: Observation tail buffer sized from env.
    this.observationTails = new ObservationTailBuffer({
      maxEntries: 5,
      tailChars: resolveObservationTailChars(),
    });
  }
  static classifyChatTaskIntent(task: string): TaskIntent {
    return classifyChatTaskIntent(task);
  }

  private evaluateCompletionGate(
    turnResult: ChatTurn,
    taskIntent: TaskIntent,
  ): "allow" | "reject" {
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
        const paths = mutationPathsFromSessionEvents(
          this.parity.sessionEvents.events,
        );
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
        ...(currentWorkspaceRevisionHash
          ? { currentWorkspaceRevisionHash }
          : {}),
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
      ...(testCommands
        ? { projectTestCommands: testCommands.split(", ") }
        : {}),
    });
  }

  private criticState(
    onThought: ((msg: string) => void) | undefined,
    ownerGeneration: number,
  ): AsymmetricCriticState {
    const conversation = this.conversation.map((message) => ({ ...message }));
    const toolCallLog = this.toolCallLog.map((entry) => ({
      ...entry,
      ...(entry.mutation_paths
        ? { mutation_paths: [...entry.mutation_paths] }
        : {}),
    }));
    const isOwnerCurrent = (): boolean =>
      this.isSubmissionCurrent(ownerGeneration);
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
        ? { primaryModel: this.modelPolicy.providerModelId, primaryProvider: this.modelPolicy.provider }
        : {}),
      resolveDeliberationRunner: () => this.resolveDeliberationRunner(),
      providerCallbacks: this.providerRetryCallbacks({
        deliveryMode: "text",
        conversationState: conversation,
        userTaskPrompt: this.options.task,
        // The critic receives a synthesized text prompt, not provider-native
        // tool messages. Record that boundary explicitly so preservation is
        // determinable even when the run had earlier tool calls.
        expectedPriorEventIds: [],
        deliveredPriorEventIds: [],
        executionStage: "critic",
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
  ): Promise<"allow" | "reject" | "block"> {
    const criticSpan = this.currentTurnTelemetry?.startCriticSpan();
    const ownerGeneration = this.activeSubmissionGeneration;
    const conversationStart = this.conversation.length;
    try {
      const state = this.criticState(callbacks.onThought, ownerGeneration);
      const decision = await runAsymmetricDiffCriticImpl(
        state,
        answer,
        taskIntent,
        opts,
      );
      if (!this.applyCriticState(state, ownerGeneration, conversationStart))
        return "allow";
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
      kind: "budget_kill",
      detail: reason.slice(0, 200),
    });
    if (
      this.terminatingLimiter !== "cost" &&
      !this.budgetLastChanceDone &&
      this.hasAnyWrites() &&
      isDiffCriticEnabled()
    ) {
      this.budgetLastChanceDone = true;
      callbacks.onThought?.("[Budget: last-chance critic before kill…]");
      const critic = await this.runAsymmetricDiffCritic(
        `Budget last-chance review: ${reason}`,
        callbacks,
        taskIntent,
        { terminal: true },
      );
      // R0-8: the last-chance critic is a suspension point. If the submission
      // was superseded while it ran, do not finalize or budget-kill the task
      // that now owns the engine; the caller returns without a terminal.
      if (
        ownerGeneration !== undefined &&
        !this.isSubmissionCurrent(ownerGeneration)
      ) {
        return null;
      }
      if (critic === "block" || critic === "reject") {
        const report = this.buildCriticBlockedReport(
          this.lastCriticReceipt ?? {
            verdict: "reject",
            reasons: ["critic reject on budget last-chance"],
            confidence: 1,
          },
        );
        this.budgetExceeded = true;
        return this.buildResult(
          "blocked",
          callbacks,
          this.buildCriticBlockedAnswer(report),
          report,
          undefined,
          undefined,
          ownerGeneration,
        );
      }
    }

    if (
      ownerGeneration !== undefined &&
      !this.isSubmissionCurrent(ownerGeneration)
    ) {
      return null;
    }
    this.budgetExceeded = true;
    return this.buildResult(
      "budget_exhausted",
      callbacks,
      formatBudgetKillAnswer(
        reason,
        this.toolCallLog,
        this.lastCriticReceipt?.verdict ?? null,
      ),
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

  private noteToolForReadThrash(
    tool: string,
    opts?: { error?: string; detail?: string },
  ): void {
    if (isSuccessfulDirectMutation(tool, opts?.error)) {
      this.consecutiveReadOnlyTools = 0;
      this.consecutiveNonMutatingShells = 0;
      this.toolsWithoutWrite = 0;
      return;
    }
    if (
      tool === "sub_agent" &&
      opts?.error !== "blocked" &&
      /[1-9]\d*\s+changed/.test(opts?.detail ?? "")
    ) {
      this.consecutiveReadOnlyTools = 0;
      this.consecutiveNonMutatingShells = 0;
      this.toolsWithoutWrite = 0;
      return;
    }
    this.toolsWithoutWrite += 1;
    // Implementor: track shell-only thrash separately (shell soft budget).
    if (
      tool === "run_command" ||
      tool === "shell_exec" ||
      tool === "test_run" ||
      tool === "bash" ||
      tool === "shell"
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
      pushUser: (content) => this.conversation.push({ role: "user", content }),
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

  private checkBudgets(skipTurnLimit = false): {
    ok: boolean;
    reason?: string;
    limiter?: ChatRunLimiter;
  } {
    if (this.taskCostScopeUnavailable || !this.taskAllowance) {
      const reason =
        "Cannot restore durable task cost scope for resumed run; refusing a fresh allowance.";
      this.terminatingLimiter = "cost";
      this.terminalLimiterReason = reason;
      return { ok: false, reason, limiter: "cost" };
    }
    if (
      !skipTurnLimit &&
      this.taskAllowance.consumed.turns >= this.taskAllowance.grant.turnCap
    ) {
      const reason =
        `Task turn allowance exhausted (${this.taskAllowance.consumed.turns} of ` +
        `${this.taskAllowance.grant.turnCap}).`;
      this.terminatingLimiter = "turns";
      this.terminalLimiterReason = reason;
      return { ok: false, reason, limiter: "turns" };
    }
    const taskCost = this.currentTaskCostUsd();
    const taskWallMs = this.currentTaskActiveWallMs();
    // After first critic reject or post-write repair, use the tighter cost cap.
    const grantedCostCapUsd = allowanceCostCapUsd(
      this.taskAllowance.grant.costCap,
    );
    const maxCostUsd =
      Number.isFinite(grantedCostCapUsd) && this.criticRepairCostCapUsd != null
        ? Math.min(grantedCostCapUsd, this.criticRepairCostCapUsd)
        : grantedCostCapUsd;
    const costSummary = globalCostTracker.getTaskSummary(this.taskAllowance.taskOwnerId);
    if (
      Number.isFinite(maxCostUsd) &&
      (costSummary.estimateComplete ?? costSummary.costComplete) === false
    ) {
      const reason =
        "Task cost is incomplete because a provider charge has unknown pricing; refusing paid dispatch under a finite dollar cap.";
      this.terminatingLimiter = "cost";
      this.terminalLimiterReason = reason;
      return { ok: false, reason, limiter: "cost" };
    }
    // After first write: absolute wall cap from session start (repair window).
    const maxWallMs =
      this.postWriteRepairWallCapMs != null
        ? Math.min(
            this.taskAllowance.grant.wallCapMs,
            this.postWriteRepairWallCapMs,
          )
        : this.taskAllowance.grant.wallCapMs;
    const result = checkCostWallBudgets({
      totalCostUsd: taskCost,
      maxCostUsd,
      sessionStartTime: Date.now() - taskWallMs,
      maxWallMs,
      declaredCostUsd:
        this.limits.costBudget?.requestedCostUsd ?? this.limits.maxCostUsd,
      declaredWallMs:
        this.limits.wallBudget?.requestedMs ?? this.limits.maxWallMs,
      postWriteRepairWallCapMs: this.postWriteRepairWallCapMs,
      criticRepairCostCapUsd: this.criticRepairCostCapUsd,
    });
    if (!result.ok) {
      this.terminatingLimiter = result.limiter ?? "cost";
      this.terminalLimiterReason = result.reason ?? "Budget limit exceeded.";
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
      kind: "progress_policy",
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
    if (this.taskClass === "investigate") return;

    const elapsedMs = this.currentTaskActiveWallMs();
    // An explicitly authorized long-task run keeps its full wall: the
    // anti-thrash repair window would otherwise kill it minutes after the
    // first write. Hard wall, stall, turn and cost budgets still apply.
    const shrinkWall = shouldShrinkWallForPostWriteRepair(
      this.limits.wallBudget,
    );
    const repairWall = shrinkWall
      ? computePostWriteRepairWallMs({
          elapsedMs,
          sessionMaxWallMs: this.limits.maxWallMs,
        })
      : {
          capMs: this.limits.maxWallMs,
          repairWindowMs: Math.max(0, this.limits.maxWallMs - elapsedMs),
        };
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
        explicitCostCeiling:
          this.limits.costBudget?.explicitCostCeiling === true,
        criticStrikes: this.criticStrikes,
        limits: this.limits,
      });
      this.criticRepairCostCapUsd = capUsd;
      this.policyEventLog.record({
        at_turn: this._turnIndex,
        kind: "progress_policy",
        detail:
          `post_write_repair_cost spent=${spent.toFixed(3)} ` +
          `repair_window=${repairWindowUsd.toFixed(3)} cap=${capUsd.toFixed(3)}`,
      });
    }

    const remainingWallSec = Math.max(
      0,
      Math.round((this.limits.maxWallMs - elapsedMs) / 1000),
    );
    const repairWindowSec = Math.round(repairWindowMs / 1000);
    const msg = buildPostWriteRepairMessage({
      repairWindowSec,
      remainingWallSec,
    });
    this.conversation.push({ role: "user", content: msg });
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: "progress_policy",
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
        "The model produced only text without using any tools. This is a text-loop.",
        `Per-round token limit: ${this.limits.maxTokensPerRound.toLocaleString()}. ` +
          `Actual: ${perRoundTokens.toLocaleString()}.`,
      ].join("\n");
    }
    return null;
  }

  /** R2: Check for stall and return the escalating intervention if stalled.
   *  Returns null when not stalled or when the intervention has already been
   *  applied for the current stall state.
   *
   *  P0-E: stall_kill mode shadow|enforce|off (env ablation or task-class default).
   *  Shadow downgrades kill → nudge and logs stall_shadow_kill. */
  private checkStallIntervention(
    isReadOnlyInspection: boolean,
  ): StallIntervention | null {
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
        kind: "stall_shadow_kill",
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
      cb.onToolComplete = (
        id: number,
        detail?: string,
        error?: string,
        exitCode?: number,
      ) => {
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
      kind: "done" | "failed" | "cancelled";
      answer?: string;
      blockedReport?: BlockedReport | null;
      error?: string;
      /** Authoritative outcome from streamDone (P0-D B4). */
      outcome?: TerminalOutcome;
      budgetExceeded?: boolean;
      /** D03: structured reason from the terminal event. */
      reason_code?: TerminalReasonCode;
      cause_class?:
        | "model"
        | "provider"
        | "environment"
        | "harness"
        | "verification"
        | null;
    } | null = null;

    try {
      for await (const event of this.submitMessageStream(
        userInput,
        taskIntent,
        {
          submissionGeneration: generation,
        },
      )) {
        switch (event.type) {
          case "answer_chunk":
            cb.onAnswerChunk?.(event.text);
            break;
          case "thinking":
            // Generation boundary — the same semantic the streaming dispatcher
            // forwards, so non-streaming presentation stays equivalent.
            cb.onGenerationBoundary?.();
            break;
          case "thought":
            cb.onThought?.(event.text);
            break;
          case "context_compacted":
            cb.onContextCompacted?.(event);
            break;
          case "tool_start":
            {
              const id = cb.onToolStart?.(event.tool, event.target) ?? -1;
              if (event.toolCallId) callbackToolIds.set(event.toolCallId, id);
              else legacyCallbackToolIds.push(id);
            }
            break;
          case "tool_complete":
          case "tool_failed": {
            const id = event.toolCallId
              ? callbackToolIds.get(event.toolCallId)
              : legacyCallbackToolIds.shift();
            cb.onToolComplete?.(
              id ?? -1,
              event.detail,
              event.error,
              event.exitCode,
            );
            if (event.toolCallId) callbackToolIds.delete(event.toolCallId);
            break;
          }
          case "file_changed":
            cb.onFileChanged?.(
              event.path,
              event.additions,
              event.deletions,
              event.content,
            );
            break;
          case "sub_agent_start":
            cb.onSubAgentStart?.({
              id: event.id,
              label: event.label,
              ...(event.model !== undefined ? { model: event.model } : {}),
            });
            break;
          case "sub_agent_complete":
            cb.onSubAgentComplete?.({
              id: event.id,
              summary: event.summary,
              ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
            });
            break;
          case "sub_agent_failed":
            cb.onSubAgentFailed?.({ id: event.id, error: event.error });
            break;
          case "done":
            terminal = {
              kind: "done",
              answer: event.answer,
              blockedReport: event.blockedReport ?? null,
              ...(event.outcome !== undefined
                ? { outcome: event.outcome }
                : {}),
              ...(event.budgetExceeded ? { budgetExceeded: true } : {}),
              ...(event.reason_code !== undefined
                ? { reason_code: event.reason_code }
                : {}),
              ...(event.cause_class !== undefined
                ? { cause_class: event.cause_class }
                : {}),
            };
            break;
          case "failed":
            terminal = {
              kind: "failed",
              error: event.error,
              ...(event.outcome !== undefined
                ? { outcome: event.outcome }
                : {}),
              ...(event.reason_code !== undefined
                ? { reason_code: event.reason_code }
                : {}),
              ...(event.cause_class !== undefined
                ? { cause_class: event.cause_class }
                : {}),
            };
            break;
          case "cancelled":
            terminal = {
              kind: "cancelled",
              ...(event.reason_code !== undefined
                ? { reason_code: event.reason_code }
                : {}),
              ...(event.cause_class !== undefined
                ? { cause_class: event.cause_class }
                : {}),
            };
            break;
          default:
            break;
        }
      }
    } catch (error) {
      // Unexpected throw still finalizes the turn; unknown stays inconclusive.
      const captured = captureSessionEventAppendFailure(
        error,
        this.engineRunDir,
      );
      const message =
        captured?.operatorMessage ??
        (error instanceof Error ? error.message : String(error));
      return this.buildResult(
        "failed",
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
        "failed",
        cb,
        "Stream ended without a terminal event — possible internal error",
        undefined,
        undefined,
        undefined,
        generation,
      );
    }
    // D03: carry the terminal event's explicit reason into the sync result path.
    const reasonFromTerminal: TerminalReason | undefined =
      terminal.reason_code !== undefined
        ? {
            code: terminal.reason_code,
            cause_class: terminal.cause_class ?? null,
          }
        : undefined;
    if (terminal.kind === "cancelled") {
      return this.buildResult(
        "cancelled",
        cb,
        undefined,
        undefined,
        undefined,
        undefined,
        generation,
      );
    }
    if (terminal.kind === "failed") {
      const failedOutcome =
        terminal.outcome ?? classifyFailureText(terminal.error ?? "");
      if (failedOutcome === "BUDGET_EXHAUSTED" || this.budgetExceeded) {
        this.budgetExceeded = true;
        return this.buildResult(
          "budget_exhausted",
          cb,
          terminal.error ?? "Stream failed",
          undefined,
          "BUDGET_EXHAUSTED",
          reasonFromTerminal,
          generation,
        );
      }
      if (
        failedOutcome === "BLOCKED_POLICY" ||
        failedOutcome === "BLOCKED_EXTERNAL" ||
        failedOutcome === "NEEDS_HUMAN_DECISION" ||
        failedOutcome === "INVALID_TASK"
      ) {
        return this.buildResult(
          "blocked",
          cb,
          terminal.error ?? "Stream failed",
          undefined,
          failedOutcome,
          reasonFromTerminal,
          generation,
        );
      }
      return this.buildResult(
        "failed",
        cb,
        terminal.error ?? "Stream failed",
        undefined,
        failedOutcome,
        reasonFromTerminal,
        generation,
      );
    }
    if (
      terminal.budgetExceeded ||
      terminal.outcome === "BUDGET_EXHAUSTED" ||
      this.budgetExceeded
    ) {
      this.budgetExceeded = true;
    }
    const doneTerminal = projectChatTerminal({
      ...(terminal.outcome !== undefined ? { outcome: terminal.outcome } : {}),
      status: terminal.blockedReport
        ? "blocked"
        : this.budgetExceeded
          ? "budget_exhausted"
          : "completed",
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
    yield* this.streamingLoop.submitMessageStreamLoop(
      userInput,
      taskIntent,
      submitOpts,
    );
  }

  /**
   * Map operator abort / in-flight cancel to a cancelled stream event.
   * cancel() replaces AbortController, so signal.aborted on the new
   * controller is not sufficient — also honor _cancelled and runner wrap.
   */
  private emitCancelledIfOperatorAbort(err?: unknown): ChatEvent | null {
    if (
      this._cancelled ||
      this.abortController.signal.aborted ||
      isOperatorAbortError(err)
    ) {
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
  getRuntimeInvariantViolationCount(
    invariantId = MODEL_VISIBLE_EQUALS_PERSISTED,
  ): number {
    return this.runtimeInvariants.getViolationCount(invariantId);
  }

  /** Assert native wire reconstruction equality and provider protocol validity. */
  private assertNativeRequestMatchesDurable(
    outbound: readonly ProviderMessage[],
    systemPrompt: string,
    systemPromptOverride: string | undefined,
  ): void {
    const reconstructed = this.services.conversation.rebuildProviderMessages(
      this.parity.eventLog,
      {
        systemPrompt,
        ...(this.parity.contextCheckpoint
          ? { installedContextCheckpoint: this.parity.contextCheckpoint }
          : {}),
      },
    );
    // Native runners share this deterministic final serializer. Compare its
    // exact output rather than neutral messages so committed capsules cannot
    // disappear between C1 and the provider POST body.
    const context: RequestReconstructionContext = {
      outbound: mapProviderMessagesToWire(
        [...outbound],
        systemPrompt,
        systemPromptOverride,
      ),
      reconstructed: mapProviderMessagesToWire(
        reconstructed,
        systemPrompt,
        systemPromptOverride,
      ),
    };
    for (const invariantId of [
      MODEL_VISIBLE_EQUALS_PERSISTED,
      PROVIDER_PROTOCOL_VALID,
    ]) {
      const evaluation = this.runtimeInvariants.evaluate(invariantId, context);
      if (!evaluation.passed && evaluation.violation) {
        trace.getActiveSpan()?.addEvent("runtime_invariant_mismatch", {
          "runtime_invariant.id": evaluation.invariantId,
          "runtime_invariant.expected_hash": evaluation.violation.expectedHash,
          "runtime_invariant.actual_hash": evaluation.violation.actualHash,
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
  restoreEventLog(log: import("./threadEventLog.js").ThreadEventLog): void {
    this.parity.eventLog = log;
    this.clearVerifierEvidenceState();
    const lastTurn = [...log.events]
      .reverse()
      .find((e) => e.kind === "turn_started");
    if (lastTurn) this.parity.turnId = lastTurn.turn_id;
  }
  /** W2.2+H2: restore session events, settle interrupted tools, reload authority, reproject LiveSession. */
  restoreSessionEvents(
    log: SessionEventLog,
    options?: { runDir?: string },
  ): number {
    this.clearVerifierEvidenceState();
    const interrupted = restoreEngineSessionEvents({
      parity: this.parity,
      log,
      runDir: options?.runDir ?? this.engineRunDir,
    });
    this.restorePersistedVerifierEvidence(log);
    this.restoreRecoveryWorkingState(log);
    const repairGuidance = resumedToolRecoveryGuidance(
      this.parity.sessionEvents,
    );
    if (
      repairGuidance &&
      !this.conversation.some((message) => message.content === repairGuidance)
    ) {
      this.conversation.push({ role: "system", content: repairGuidance });
    }
    return interrupted;
  }

  private persistRecoveryWorkingState(): void {
    try {
      recordWorkingStateSnapshot(
        this.parity.sessionEvents,
        this.workingState,
        this.parity.turnId ?? null,
      );
      flushSessionEventLogStrict(this.engineRunDir, this.parity.sessionEvents);
    } catch {
      // A settled tool must not throw into the generic settlement catch and
      // append a duplicate terminal. Future mutations fail closed instead.
      this.recoveryStatePersistenceUnavailable = true;
    }
  }

  private beginRecoveryLocalizationInspection(
    tool: string,
    rawTarget: string,
  ): boolean {
    const localization = this.workingState.localization;
    if (!localization || localization.phase === "localized") return true;
    if (
      localization.phase === "exhausted" ||
      localization.calls >= 4 ||
      localization.rounds >= 2
    ) {
      this.workingState = applyWorkingStateEvent(this.workingState, {
        type: "localization_update",
        localization: { ...localization, phase: "exhausted" },
      });
      this.persistRecoveryWorkingState();
      return false;
    }
    const current = this.currentRecoveryBinding();
    if (!current || !sameRecoveryBinding(localization.binding, current)) {
      this.workingState = applyWorkingStateEvent(this.workingState, {
        type: "recovery_candidate_drift",
      });
      this.persistRecoveryWorkingState();
      return false;
    }
    const target =
      recoveryTargetIdentity(this.options.projectRoot, rawTarget) ?? undefined;
    this.workingState = applyWorkingStateEvent(this.workingState, {
      type: "localization_update",
      localization: beginLocalizationCall(localization, target),
    });
    this.persistRecoveryWorkingState();
    return true;
  }

  private finishRecoveryLocalizationInspection(input: {
    tool: string;
    rawTarget: string;
    content?: string;
    succeeded: boolean;
    startLine?: number;
    pattern?: string;
  }): void {
    const localization = this.workingState.localization;
    if (!localization || localization.phase !== "LOCALIZE_FAILURE") return;
    const target =
      recoveryTargetIdentity(this.options.projectRoot, input.rawTarget) ??
      undefined;
    const withCandidates =
      input.tool === "glob" && input.succeeded && input.pattern && input.content
        ? discoverTestCandidates(
            localization,
            this.options.projectRoot,
            input.pattern,
            input.content,
          )
        : localization;
    const updated = finishLocalizationCall(withCandidates, {
      type: input.tool,
      succeeded: input.succeeded,
      projectRoot: this.options.projectRoot,
      ...(target ? { target } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
    });
    this.workingState = applyWorkingStateEvent(this.workingState, {
      type: "localization_update",
      localization: updated,
    });
    if (
      updated.phase === "localized" &&
      updated.acceptedPath &&
      updated.observationDigest &&
      this.workingState.recoveryGate
    ) {
      this.workingState = {
        ...this.workingState,
        recoveryGate: {
          ...this.workingState.recoveryGate,
          failingTargets: [updated.acceptedPath],
        },
      };
      this.workingState = applyWorkingStateEvent(this.workingState, {
        type: "add_evidence",
        evidence: `${input.tool}:${updated.acceptedPath}`,
        discriminating: true,
        provenance: {
          tool: input.tool,
          target: updated.acceptedPath,
          failureSignature: updated.failureSignature,
          binding: updated.binding,
          observationDigest: updated.observationDigest,
        },
      });
    }
    this.persistRecoveryWorkingState();
  }

  private restoreRecoveryWorkingState(log: SessionEventLog): void {
    const latestSnapshot = [...log.events]
      .reverse()
      .find((event) => event.kind === "working_state_snapshot");
    const latestVerifier = [...log.events]
      .reverse()
      .find(
        (event) =>
          event.kind === "verifier_attempt" &&
          event.authoritative &&
          event.exit_code !== undefined,
      );
    const latestSubmission = [...log.events]
      .reverse()
      .find((event) => event.kind === "user_submitted");
    if (
      latestSubmission?.kind === "user_submitted" &&
      latestSubmission.continued_task === false &&
      (!latestSnapshot || latestSnapshot.seq < latestSubmission.seq) &&
      (!latestVerifier || latestVerifier.seq < latestSubmission.seq)
    ) {
      this.workingState = createWorkingState(latestSubmission.task_preview);
      return;
    }
    if (
      latestSubmission?.kind === "user_submitted" &&
      latestSubmission.continued_task !== true &&
      latestSnapshot &&
      latestSnapshot.seq < latestSubmission.seq
    ) {
      this.workingState = applyWorkingStateEvent(
        createWorkingState(latestSubmission.task_preview),
        {
          type: "recovery_gate",
          failureSignature: "resumed-unknown-task-boundary",
          requiredEvidence: "Rerun an authoritative verifier before recovery.",
        },
      );
      return;
    }
    if (
      latestSnapshot?.kind === "working_state_snapshot" &&
      (!latestVerifier || latestSnapshot.seq > latestVerifier.seq)
    ) {
      const restored = restoreWorkingStateSnapshot(latestSnapshot.state);
      if (restored) {
        this.workingState = restored;
        return;
      }
    }
    if (
      latestSnapshot ||
      (latestVerifier?.kind === "verifier_attempt" &&
        latestVerifier.exit_code !== 0)
    ) {
      this.workingState = applyWorkingStateEvent(
        createWorkingState(this.options.task),
        {
          type: "recovery_gate",
          failureSignature: "resumed-unbound-red-verifier",
          requiredEvidence:
            "Rerun the failed verifier to bind recovery to the current candidate.",
        },
      );
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
    const loaded = loadSessionEventLogIfPresentForResume(
      targetDir,
      this.engineRunId,
    );
    return loaded
      ? this.restoreSessionEvents(loaded, { runDir: targetDir })
      : 0;
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
    results: ReadonlyArray<{
      tool_name: string;
      content?: string;
      exit_code?: number;
    }>,
  ): boolean {
    const verifierTools = new Set(["run_command", "test_run", "shell_exec"]);
    const relevant = results.filter((r) => verifierTools.has(r.tool_name));
    if (relevant.length === 0) return false;
    const signature = relevant
      .map(
        (r) =>
          `${r.tool_name}:${r.exit_code ?? ""}:` +
          createHash("sha256")
            .update(r.content ?? "")
            .digest("hex")
            .slice(0, 16),
      )
      .join("|");
    const changed = signature !== this.lastVerifierSignalSignature;
    this.lastVerifierSignalSignature = signature;
    return changed;
  }

  private restorePersistedVerifierEvidence(log: SessionEventLog): void {
    this.lastVerifierReceipt = restorePersistedVerifierEvidence(
      log,
      this.executedVerifierLedger,
    );
  }

  /** Build the single canonical verifier input shared by every completion gate. */
  private buildVerifierInput(): ReturnType<
    typeof prepareKernelVerifierInput
  > & {
    requiredVerifierCommands: string[];
  } {
    return {
      ...prepareKernelVerifierInput(
        this.lastVerifierReceipt,
        this.executedVerifierLedger,
      ),
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
    return (
      this.lastTurnRuntime?.effectiveOperation === "READ_ONLY" ||
      isReadOnlyChat()
    );
  }

  private decideCompletion(
    requestedOutcome: TerminalOutcome | "PLAN_COMPLETE",
    hasMutation: boolean,
  ) {
    refreshChatVerifierReceiptStalenessSync(
      this.options.projectRoot,
      this.lastVerifierReceipt,
    );
    for (const receipt of this.executedVerifierLedger)
      refreshChatVerifierReceiptStalenessSync(
        this.options.projectRoot,
        receipt,
      );
    const verifierInput = this.buildVerifierInput();

    return this.executorKernel.completion.decide({
      mode: this.executionProfile,
      requestedOutcome,
      hasWrite: hasMutation,
      verificationPolicy: this.gatePolicy ?? "required",
      lastVerifierReceipt: verifierInput.lastVerifierReceipt,
      executedVerifierLedger: verifierInput.executedVerifierLedger,
      verifierEvidenceErrors: verifierInput.verifierEvidenceErrors,
      requiredVerifierCommands: verifierInput.requiredVerifierCommands,
      toolCallLog: toGateToolLog(this.toolCallLog),
      ...(this.lastVerifierReceipt?.boundRevision
        ? { workspaceRevision: this.lastVerifierReceipt.boundRevision }
        : {}),
      proof:
        requestedOutcome === "VERIFIED_COMPLETE"
          ? this.buildCompletionProof(hasMutation)
          : {
              compliant: false,
              errors: ["requested outcome was not verified"],
            },
    });
  }
  private streamDone(answer: string, extra?: ChatStreamDoneExtra): ChatEvent {
    return completeChatStream(this.terminalRuntimeInput(), answer, extra);
  }
  private streamFailed(error: string): ChatEvent {
    return failChatStream(this.terminalRuntimeInput(), error);
  }
  private streamCancelled(): ChatEvent {
    return cancelChatStream(this.terminalRuntimeInput());
  }

  getConversation(): ChatMessage[] {
    return [...this.conversation];
  }

  getEngineRunId(): string {
    return this.engineRunId;
  }

  assignRunId(runId: string): void {
    if (runId === this.engineRunId) return;
    if (
      this.parity.eventLog.events.length > 0 ||
      this.parity.sessionEvents.events.length > 0
    ) {
      throw new Error(
        "Cannot change ChatEngine run identity after durable events exist",
      );
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
    this.failureBudgetTracker = createFailureBudgetTrackerFromContract(
      authority?.taskContract,
    );
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
      this.settleAdmissionClaim(claim, "aborted", {
        finalOutcome: "SESSION_CLOSED",
      });
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
    return this.services.conversation.rebuildProviderMessages(
      this.parity.eventLog,
      {
        ...(this.parity.contextCheckpoint
          ? { installedContextCheckpoint: this.parity.contextCheckpoint }
          : {}),
      },
    );
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
      indexWritePolicy: "allow",
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
      ...(this.options.model !== undefined
        ? { model: this.options.model }
        : {}),
      ...(input.taskIntent !== undefined
        ? { taskIntent: input.taskIntent }
        : {}),
      ...(input.continueTask !== undefined
        ? { continueTask: input.continueTask }
        : {}),
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
      input.continueTask === true &&
      !runtime.continuedTask &&
      this.taskCostScopeUnavailable;
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
      this.p11InstallBlock = null;
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
          ...(this.options.maxTurns !== undefined
            ? { maxTurns: this.options.maxTurns }
            : {}),
          ...(this.options.maxConversationMessages !== undefined
            ? { maxConversationMessages: this.options.maxConversationMessages }
            : {}),
          ...(this.options.maxEstimatedTokens !== undefined
            ? { maxEstimatedTokens: this.options.maxEstimatedTokens }
            : {}),
          ...(this.options.maxTokensPerRound !== undefined
            ? { maxTokensPerRound: this.options.maxTokensPerRound }
            : {}),
          ...(this.options.maxWallMs !== undefined
            ? { maxWallMs: this.options.maxWallMs }
            : {}),
          ...(this.options.maxCostUsd !== undefined
            ? { maxCostUsd: this.options.maxCostUsd }
            : {}),
          ...(this.limits.costBudget
            ? { costBudget: this.limits.costBudget }
            : {}),
        },
        undefined,
        { taskClass: runtime.taskClass, taskText: runtime.taskText },
      );
      if (
        this.modelPolicy?.provider === "openrouter" &&
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
      this.requireTodoBeforeMutate = shouldRequireTodoPlan(
        runtime.taskText,
        this.activePlaybook,
      );
      // System prompt may embed class/playbook hints — rebuild next LLM call.
      this.clearSystemPromptCache();
    }

    if (continuationScopeUnavailable) {
      this.budgetExceeded = true;
      this.budgetLastChanceDone = true;
      this.terminatingLimiter = "cost";
      this.terminalLimiterReason =
        "Cannot restore durable task cost scope for explicit continuation.";
    }

    this.lastTurnRuntime = runtime;
    this.persistTaskCostBaseline();
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: "progress_policy",
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
    if (preparation.projectRoot !== undefined)
      nextOptions.projectRoot = preparation.projectRoot;
    if (preparation.instructionRoot !== undefined)
      nextOptions.instructionRoot = preparation.instructionRoot;
    if (preparation.systemContext !== undefined)
      nextOptions.systemContext = preparation.systemContext;
    if (preparation.appendSystemPrompt !== undefined)
      nextOptions.appendSystemPrompt = preparation.appendSystemPrompt;
    if (preparation.preflightContext !== undefined)
      nextOptions.preflightContext = preparation.preflightContext;
    if (preparation.model !== undefined) nextOptions.model = preparation.model;
    if (preparation.executionProfile !== undefined)
      nextOptions.executionProfile = preparation.executionProfile;
    if (preparation.runtimeMode !== undefined)
      nextOptions.runtimeMode = preparation.runtimeMode;
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
    // systemContext is replaced by preparation above. Do not append a second
    // memory or playbook document here.
    if (preparation.limits) {
      this.limits = preparation.limits;
      this.options.maxTurns = preparation.limits.maxTurns;
      this.options.maxConversationMessages =
        preparation.limits.maxConversationMessages;
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
            kind: "progress_policy",
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
  static async restore(
    engineRunId: string,
    options: ChatEngineOptions,
  ): Promise<ChatEngine> {
    const transcriptPath = layoutTranscriptPath(engineRunId);
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(transcriptPath, "utf-8");
    const messages: ChatMessage[] = content
      .split("\n")
      .filter((line) => line.trim() !== "")
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
    this.p11Authority.loadObservationMembership(sessionDir);
  }

  hydrateInstalledContextAuthority(sessionDir: string = this.engineRunDir): {
    applied: boolean;
    issues: string[];
  } {
    return this.p11Authority.hydrateInstalledContextAuthority(sessionDir);
  }

  // ── Private Methods ─────────────────────────────────────────────────────

  private buildP11Sources(
    routeOverride?: NonNullable<LiveOperationalSourcesV1["route"]>,
  ): LiveOperationalSourcesV1 | null {
    return this.p11Authority.buildP11Sources(routeOverride);
  }

  private currentP11Owner(): ContextCheckpointOwnerV1 | null {
    return this.p11Authority.currentP11Owner();
  }

  private admitCurrentSubmission(
    submissionGeneration: number,
    userInput: string,
  ): ChatEngineAdmissionClaim | null {
    return this.p11Authority.admitCurrentSubmission(
      submissionGeneration,
      userInput,
    );
  }

  private settleAdmissionClaim(
    claim: ChatEngineAdmissionClaim,
    state: "settled" | "aborted" | "indeterminate",
    outcome: unknown,
  ): void {
    this.p11Authority.settleAdmissionClaim(claim, state, outcome);
  }

  private settleClaimOnExit(claim: ChatEngineAdmissionClaim | null): void {
    this.p11Authority.settleClaimOnExit(claim);
  }

  private settleActiveAdmissionClaim(): void {
    this.p11Authority.settleActiveAdmissionClaim();
  }

  private currentRecoveryBinding(): RecoveryCandidateBinding | null {
    return this.p11Authority.currentRecoveryBinding();
  }

  private hasPendingCompactionAuthority(): boolean {
    return this.p11Authority.hasPendingCompactionAuthority();
  }

  private prepareP11ContextCheckpointCandidate(route: {
    tool_profile: string;
    model_route: string;
  }): ContextCheckpointPreparationResultV1 | null {
    return this.p11Authority.prepareP11ContextCheckpointCandidate(route);
  }

  private installP11ContextCheckpoint(
    routeOverride?: NonNullable<LiveOperationalSourcesV1["route"]>,
  ): Promise<boolean> {
    return this.p11Authority.installP11ContextCheckpoint(routeOverride);
  }

  private captureP11Observation(
    action: ChatToolAction,
    result: { index: number; observation: string },
    meta: { index: number; idempotencyKey: string; ownerGeneration: number },
  ): void {
    this.p11Authority.captureP11Observation(action, result, meta);
  }

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
      babelRoot: process.env["BABEL_ROOT"] ?? process.cwd(),
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
          ...(a.type === "sub_agent"
            ? { mutation: (a as { mutation?: boolean }).mutation }
            : {}),
        })),
      ),
    );

    const allResults: Awaited<ReturnType<typeof this.executeOneAction>>[] = [];
    let stopTerminal = false;
    // R0-8: a superseded generator must not run the new owner's tools. The
    // generation check runs between every action and batch, including after
    // an awaited tool/child returns.
    const superseded = (): boolean =>
      !this.isSubmissionCurrent(ownerGeneration);
    for (const batch of batches) {
      if (
        this._cancelled ||
        this.abortController.signal.aborted ||
        stopTerminal ||
        superseded()
      )
        break;
      if (batch.kind === "parallel_reads") {
        const containsSubAgent = batch.indices.some(
          (index) => actions[index]?.type === "sub_agent",
        );
        if (containsSubAgent) {
          for (const index of batch.indices) {
            if (
              this._cancelled ||
              this.abortController.signal.aborted ||
              stopTerminal ||
              superseded()
            )
              break;
            const result = await this.executeOneAction(
              actions[index]!,
              toolContext,
              callbacks,
              {
                index,
                ownerGeneration,
                idempotencyKey:
                  this._streamNativeToolCallIds[index] ??
                  `tool_call_${this._turnIndex}_${index}`,
              },
            );
            allResults.push(result);
            this.captureP11Observation(actions[index]!, result, {
              index,
              ownerGeneration,
              idempotencyKey:
                this._streamNativeToolCallIds[index] ??
                `tool_call_${this._turnIndex}_${index}`,
            });
            if (result.stop) stopTerminal = true;
          }
          continue;
        }
        for (let c = 0; c < batch.indices.length; c += MAX_TOOL_CONCURRENCY) {
          if (
            this._cancelled ||
            this.abortController.signal.aborted ||
            superseded()
          )
            break;
          const chunk = batch.indices.slice(c, c + MAX_TOOL_CONCURRENCY);
          const parallelResults = await Promise.all(
            chunk.map((index) =>
              this.executeOneAction(actions[index]!, toolContext, callbacks, {
                index,
                ownerGeneration,
                idempotencyKey:
                  this._streamNativeToolCallIds[index] ??
                  `tool_call_${this._turnIndex}_${index}`,
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
                  this._streamNativeToolCallIds[index] ??
                  `tool_call_${this._turnIndex}_${index}`,
              });
            }
          }
        }
      } else {
        const result = await this.executeOneAction(
          actions[batch.index]!,
          toolContext,
          callbacks,
          {
            index: batch.index,
            ownerGeneration,
            idempotencyKey:
              this._streamNativeToolCallIds[batch.index] ??
              `tool_call_${this._turnIndex}_${batch.index}`,
          },
        );
        allResults.push(result);
        this.captureP11Observation(actions[batch.index]!, result, {
          index: batch.index,
          ownerGeneration,
          idempotencyKey:
            this._streamNativeToolCallIds[batch.index] ??
            `tool_call_${this._turnIndex}_${batch.index}`,
        });
        if (result.stop || isCircuitBreakerObservation(result.observation))
          stopTerminal = true;
      }
    }

    allResults.sort((a, b) => a.index - b.index);
    // Align one observation slot per requested action index (empty if skipped).
    const observationList = actions.map((_, i) => {
      const hit = allResults.find((r) => r.index === i);
      return hit?.observation ?? "";
    });
    return {
      observations: allResults
        .map((r) => r.observation)
        .filter(Boolean)
        .join("\n\n"),
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
        ...(this._activeToolBatchId
          ? { batch_id: this._activeToolBatchId }
          : {}),
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
        ...(this._activeToolBatchId
          ? { batch_id: this._activeToolBatchId }
          : {}),
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
      effect_status: "indeterminate",
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
  private childDelegationIdForAction(
    action: ChatToolAction,
    meta: { index: number },
  ): string {
    const turnId = String(this.parity.turnId ?? this._turnIndex);
    const batchId =
      this._activeToolBatchId ??
      `batch_${this._turnIndex}_${this._turnToolCallLogStart}`;
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
    const fingerprint = operationFingerprint(
      chatActionToolName(action),
      action,
    );
    if (
      !requiresRecoveredOutcomeReconciliation(
        this.parity.sessionEvents,
        fingerprint,
      )
    )
      return { allowed: true };
    return {
      allowed: false,
      message:
        "Equivalent recovered effect has TOOL_OUTCOME_UNKNOWN; inspect/reconcile its state, then require an explicit durable reconciliation authorization before retrying this fingerprint.",
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
    const fingerprint = operationFingerprint(
      chatActionToolName(action),
      action,
    );
    if (
      !requiresRecoveredOutcomeReconciliation(
        this.parity.sessionEvents,
        fingerprint,
        recoveredIdempotencyKey,
      )
    ) {
      throw new Error(
        "No matching unreconciled TOOL_OUTCOME_UNKNOWN effect exists for this authorization.",
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
      const raw = mutationPathsFromSessionEvents(
        this.parity.sessionEvents.events,
      );
      if (raw.length === 0) return null;
      // Session mutation batches may carry absolute or repo-relative paths;
      // RevisionManager requires canonical repository-relative paths.
      const root = resolve(this.options.projectRoot);
      const relativePaths: string[] = [];
      for (const candidate of raw) {
        const absolute = isAbsolute(candidate)
          ? candidate
          : resolve(root, candidate);
        const rel = relative(root, absolute);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
        relativePaths.push(rel.split(sep).join("/"));
      }
      const unique = [...new Set(relativePaths)].sort();
      if (unique.length === 0) return null;
      return RevisionManager.computeRevisionSync(
        this.options.projectRoot,
        unique,
      ).compositeTreeHash;
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
        "status: stale",
        "attribution: child_stale_result",
        `reason: ${reason}`,
        "This child result is historical evidence from a superseded parent",
        "candidate and does not apply to the current task. It is deliberately",
        "excluded from the current tool log, budget, verifier ledger, working",
        "state, and mutation attribution.",
      ].join("\n"),
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
        "status: stale",
        `reason: ${reason}`,
        "This action completed after its submission was superseded and is not",
        "applied to the current task.",
      ].join("\n"),
    };
  }

  private async executeOneAction(
    action: ChatToolAction,
    toolContext: ToolContext,
    callbacks: ChatCallbacks,
    meta: { index: number; idempotencyKey?: string; ownerGeneration?: number },
  ): Promise<{ index: number; observation: string; stop?: boolean }> {
    return this.actionExecutor.executeOneAction(
      action,
      toolContext,
      callbacks,
      meta,
    );
  }

  /**
   * Build tool result feedback in text-tools format for small local models.
   * Returns simple [OK]/[RESULT]/[ERROR] text that the model can parse on
   * the next turn instead of a role:tool message it does not understand.
   */
  private buildTextToolResults(startIndex: number): string {
    return formatTextToolResults(this.toolCallLog.slice(startIndex));
  }

  private async runPostEditStaticCheck(
    filePath: string,
  ): Promise<string | null> {
    return runPostEditStaticCheckFn(filePath, this.options.projectRoot);
  }

  /**
   * R4: Generate a compact repository map for model orientation.
   * Lists top-level directories, key config files, and build/test commands.
   */
  private async generateRepoMap(): Promise<string> {
    return buildRepoMapPreamble(this.options.projectRoot);
  }
  private async synthesizeAnswer(
    toolObservations: string,
    callbacks: ChatCallbacks,
  ): Promise<string> {
    const ownerGeneration = this.activeSubmissionGeneration;
    const prompt = buildAnswerSynthesisPrompt({
      conversation: this.conversation,
      task: this.options.task,
      toolObservations,
    });
    this.synthesisRunner = resolveChatSynthesisRunner(
      this.synthesisRunner,
      this.modelPolicy,
      this.modelPolicy?.provider === "opencode-go" && !this.options.providerRunner
        ? this.taskAllowanceOwner.resolveGoRunnerOptions() : undefined,
    );
    const usageScope = this.captureProviderUsageScope(ownerGeneration);
    return synthesizeChatAnswer(
      this.synthesisRunner,
      prompt,
      callbacks,
      usageScope,
      this.providerUsageEffects(),
    );
  }

  /** Record token usage from a runner invocation into the global cost tracker.
   *  #12: Also accumulates API-reported token counts for accurate estimation. */
  private trackRunnerUsage(
    runner:
      | DeepInfraApiRunner
      | DeepSeekApiRunner
      | OllamaApiRunner
      | OpenRouterApiRunner,
    usageScope?: ChatUsageScope,
  ): void {
    trackProviderRunnerUsage(this.providerAccountingHost(), runner, usageScope);
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
      taskOwnerId: string | null;
      projectRoot: string;
      accountingEpoch: string;
      turnId: string | null;
      chargeId: string | null;
      provider?: string | null;
      requestId?: string;
      attemptId?: string;
      runDir?: string;
      ownerGeneration: number;
    } = {
      taskOwnerId: compactionOwnerId,
      projectRoot: realpathSync(this.options.projectRoot),
      accountingEpoch: compactionEpoch,
      turnId: compactionTurnId,
      chargeId: null as string | null,
      ownerGeneration,
    };
    const host: import("./compactionCommit.js").ChatEngineCompactionHost = {
      conversation: this.conversation,
      options: this.options,
      ...(this.modelPolicy ? { modelPolicy: this.modelPolicy } : {}),
      limits: this.limits,
      abortSignal: this.abortController.signal,
      writeCount: this.writeCount,
      turnIndex: this._turnIndex,
      toolCallLog: this.toolCallLog,
      ...(this.lastVerifierReceipt
        ? { lastVerifierReceipt: this.lastVerifierReceipt }
        : {}),
      progress: this.parity.progress,
      threadLog: this.parity.eventLog,
      sessionLog: this.parity.sessionEvents,
      turnId: this.parity.turnId,
      providerCallbacks: this.providerRetryCallbacks({
        deliveryMode: this.shouldUseTextTools() ? "text" : "native",
        executionStage: "compaction",
        usageScope,
        isOwnerCurrent: () => this.isSubmissionCurrent(ownerGeneration),
      }),
      onCompactionUsage: (usage) => {
        const attribution = compactionOwnerId
          ? captureUsageAttribution(
              usageScope,
              usage.inferenceId,
              usageScope.chargeId === usage.inferenceId
                ? usageScope.requestId
                : undefined,
              usageScope.chargeId === usage.inferenceId
                ? usageScope.attemptId
                : undefined,
            )
          : undefined;
        const update = globalCostTracker.settleUsage(
          usage.modelId,
          usage.inputTokens ?? 0,
          usage.outputTokens ?? 0,
          null,
          null,
          attribution,
          usage.inputTokens !== null && usage.outputTokens !== null,
          usageScope.provider ?? null,
        );
        if (update.kind === "conflict") {
          this.recordOwnerAccountingFault(
            { ...usageScope, chargeId: usage.inferenceId },
            "settlement-conflict",
            update.reason,
            compactionOwnerId === this.taskAllowance?.taskOwnerId &&
              this.isSubmissionCurrent(ownerGeneration),
          );
          try {
            if (compactionOwnerId)
              this.persistOwnerCharges(compactionOwnerId, compactionRunDir);
          } catch (error) {
            this.recordOwnerAccountingFault(
              { ...usageScope, chargeId: usage.inferenceId },
              "persistence-failure",
              error instanceof Error ? error.message : String(error),
              compactionOwnerId === this.taskAllowance?.taskOwnerId &&
                this.isSubmissionCurrent(ownerGeneration),
            );
          }
          return;
        }
        if (compactionOwnerId && update.kind !== "duplicate") {
          try {
            this.persistOwnerCharges(compactionOwnerId, compactionRunDir);
          } catch (error) {
            this.recordOwnerAccountingFault(
              { ...usageScope, chargeId: usage.inferenceId },
              "persistence-failure",
              error instanceof Error ? error.message : String(error),
              compactionOwnerId === this.taskAllowance?.taskOwnerId &&
                this.isSubmissionCurrent(ownerGeneration),
            );
          }
        }
        if (this.isSubmissionCurrent(ownerGeneration))
          this.persistTaskCostBaseline();
      },
      shouldUseTextTools: () => this.shouldUseTextTools(),
      compactHeuristic: () => {
        if (!this.isSubmissionCurrent(ownerGeneration)) return;
        this.compactConversation();
        host.conversation = this.conversation;
      },
      checkpoint: async () => {
        if (!this.isSubmissionCurrent(ownerGeneration)) return;
        const receipt = await checkpointParityEventLogStrict(
          compactionParity,
          compactionRunDir,
        );
        if (receipt.status !== "committed") {
          throw new Error(receipt.error ?? "checkpoint persistence blocked");
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
      summarizeDroppedTurns: (d: ChatMessage[]) =>
        this.summarizeDroppedTurns(d),
    };
    compactHeuristicConversation(state);
    this.conversation = state.conversation;
    this.apiTokenCount = state.apiTokenCount;
    this.compactionConsecutiveFailures = state.compactionConsecutiveFailures;
  }

  private summarizeDroppedTurns(dropped: ChatMessage[]): string {
    return summarizeDroppedTurnsFn(dropped);
  }
  private parseChatTurnLenient(rawText: string): ChatTurn {
    return parseChatTurnLenient(rawText);
  }
  private resolveDeliberationRunner():
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner {
    this.deliberationRunner = resolveChatDeliberationRunner(
      this.deliberationRunner,
      this.modelPolicy,
      this.modelPolicy?.provider === "opencode-go" && !this.options.providerRunner
        ? this.taskAllowanceOwner.resolveGoRunnerOptions() : undefined,
    );
    return this.deliberationRunner;
  }

  /**
   * Execute a runner call with a per-turn deadline. If the deadline expires,
   * the shared AbortController is signalled so the HTTP fetch is cancelled
   * and the Promise.race rejects with a descriptive error.
   */
  /** Persist provider retry facts without exposing provider payloads in durable state. */
  private providerAccountingHost(): ChatProviderRetryHost {
    const engine = this;
    return {
      conversation: this.conversation,
      engineRunDir: this.engineRunDir,
      options: this.options,
      parity: this.parity,
      get taskAllowance() {
        return engine.taskAllowance;
      },
      get _turnIndex() {
        return engine._turnIndex;
      },
      get _lastPhase() {
        return engine._lastPhase;
      },
      get routingReceiptLog() {
        return engine.routingReceiptLog;
      },
      get apiTokenCount() {
        return engine.apiTokenCount;
      },
      set apiTokenCount(value) {
        engine.apiTokenCount = value;
      },
      get lastRequestCompletionTokens() {
        return engine.lastRequestCompletionTokens;
      },
      set lastRequestCompletionTokens(value) {
        engine.lastRequestCompletionTokens = value;
      },
      get lastRequestModelId() {
        return engine.lastRequestModelId;
      },
      set lastRequestModelId(value) {
        engine.lastRequestModelId = value;
      },
      get lastRequestPromptTokens() {
        return engine.lastRequestPromptTokens;
      },
      set lastRequestPromptTokens(value) {
        engine.lastRequestPromptTokens = value;
      },
      get lastLogicalRequestId() {
        return engine.lastLogicalRequestId;
      },
      set lastLogicalRequestId(value) {
        engine.lastLogicalRequestId = value;
      },
      get pendingParentRequestId() {
        return engine.pendingParentRequestId;
      },
      set pendingParentRequestId(value) {
        engine.pendingParentRequestId = value;
      },
      get pendingUsageChargeId() {
        return engine.pendingUsageChargeId;
      },
      set pendingUsageChargeId(value) {
        engine.pendingUsageChargeId = value;
      },
      checkBudgets: (skipTurnLimit) => engine.checkBudgets(skipTurnLimit),
      persistOwnerCharges: (ownerId, runDir) =>
        engine.persistOwnerCharges(ownerId, runDir),
      persistTaskCostBaseline: () => engine.persistTaskCostBaseline(),
      recordOwnerAccountingFault: (scope, kind, reason, appliesToCurrent) =>
        engine.recordOwnerAccountingFault(
          scope,
          kind,
          reason,
          appliesToCurrent,
        ),
    };
  }

  private providerRetryCallbacks(
    context: {
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
    } = {},
  ): RunnerCallbacks {
    return buildProviderRetryCallbacks(this.providerAccountingHost(), context);
  }
  private async executeWithTimeout(
    runner: ChatProviderRunner,
    prompt: string,
    callbacks: RunnerCallbacks | undefined,
    systemPrompt?: string,
  ): Promise<string> {
    return executeChatRunnerWithTimeout(
      runner,
      prompt,
      callbacks,
      () => this.abortController,
      systemPrompt,
    );
  }
  private resolveFallbackRunner(): ChatProviderRunner | null {
    if (this.options.providerRunner) return this.options.providerRunner;
    const runner = resolveChatFallbackRunner(
      this.fallbackRunner,
      this.options,
      this.modelPolicy,
    );
    if (runner) this.fallbackRunner = runner;
    return runner;
  }
  private shouldUseNativeTools(runner: ChatProviderRunner): boolean {
    return shouldUseChatNativeTools(runner);
  }
  private shouldUseTextTools(): boolean {
    return shouldUseChatTextTools(() => this.resolveDeliberationRunner());
  }
  private async deliberateTurn(
    runner: ChatProviderRunner,
    promptOrMessages: string | ProviderMessage[],
    useNativeTools: boolean,
    callbacks: ChatCallbacks,
    hooks: { onStreamedChunks?: (text: string) => void } = {},
  ): Promise<ChatTurn> {
    resetOneShotSnapshot(this.logicalTurnToolPolicy);
    const usageScope = this.captureProviderUsageScope();
    return deliberateChatTurn({
      runner,
      promptOrMessages,
      useNativeTools,
      callbacks,
      hooks,
      usageScope,
      tools: this.services.tools,
      takeToolPolicy: () => this.nextTurnToolPolicy(),
      acceptedOperation: this.getTurnRuntimeSnapshot()?.effectiveOperation,
      requiredVerifierCommands: this.getResolvedRequiredVerifiers(),
      systemPrompt: (mode) => this.getOrBuildSystemPrompt(mode),
      useTextTools: () => this.shouldUseTextTools(),
      effects: this.providerUsageEffects(),
    });
  }
  private async *resolveFallbackOrFail(
    err: any,
    turn: number,
    ownerGeneration?: number,
  ): AsyncGenerator<
    ChatEvent,
    DeepInfraApiRunner | DeepSeekApiRunner | OpenRouterApiRunner | null,
    undefined
  > {
    return yield* resolveChatFallbackOrFail({
      err,
      turn,
      ownerGeneration,
      options: this.options,
      modelPolicy: this.modelPolicy,
      isSubmissionCurrent: (generation) => this.isSubmissionCurrent(generation),
      cancelled: (error) => this.emitCancelledIfOperatorAbort(error),
      failed: (error) => this.streamFailed(error),
      tryFailover: (modelId, error) =>
        parityTryFailover(this.parity, modelId, error),
      resolveFallback: () => this.resolveFallbackRunner(),
      installFailover: (runner, decision) => {
        this.fallbackRunner = runner;
        this.policyEventLog.record({
          at_turn: this._turnIndex,
          kind: "failover",
          detail: decision.reason,
        });
        recordModelFailover(
          this.parity.sessionEvents,
          this.parity.turnId || "",
          {
            original_model: decision.fromModel,
            new_model: decision.toModel,
            reason: decision.reason,
          },
        );
      },
    });
  }

  private getOrBuildSystemPrompt(
    mode: "native" | "legacy" | "text" = "legacy",
  ): string {
    if (mode === "native" && this.cachedSystemPromptNative !== null) {
      return this.cachedSystemPromptNative;
    }
    if (mode === "legacy" && this.cachedSystemPromptLegacy !== null) {
      return this.cachedSystemPromptLegacy;
    }
    if (mode === "text" && this.cachedSystemPromptText !== null) {
      return this.cachedSystemPromptText;
    }
    const nativeTools = mode === "native";
    const textTools = mode === "text";
    const systemCtx = this.options.systemContext;
    let systemContent = this.services.conversation.buildSystemPrompt({
      projectRoot: this.options.projectRoot,
      nativeTools,
      textTools,
      executionFirst: true,
      runtimeMode: this.options.runtimeMode ?? "unknown",
      ...(systemCtx ? { systemContext: systemCtx } : {}),
    });
    if (isReadOnlyChat()) {
      systemContent +=
        "\n\nRead-only capability boundary: only read_file, read_range, list_dir, grep and glob are available. Do not request shell commands, writes, subagents or shared memory. If a read/search fails, use another available reading tool or report the missing evidence; unavailable tools cannot work around this boundary.";
    }

    // Text-tools mode: keep the prompt MINIMAL. Small models cannot attend
    // to long system prompts. Skip all the extra context that cloud models use.
    if (!textTools) {
      if (this.options.appendSystemPrompt) {
        systemContent += "\n\n" + this.options.appendSystemPrompt;
      }
      if (this.options.preflightContext) {
        systemContent += "\n\n" + this.options.preflightContext;
      }

      // R4: Inject repo map for orientation
      if (this.repoMapCache) {
        systemContent += "\n\n" + this.repoMapCache;
      }

      // R3b: Extract and surface verifier command from task
      const verifierCmd = extractVerifierCommandFn(this.options.task);
      if (verifierCmd) {
        systemContent += `\n\n## Task Verifier\nThe verifier command for this task is: \`${verifierCmd}\`\nRun it after making changes to confirm the fix works.`;
      }
    }

    if (mode === "native") {
      this.cachedSystemPromptNative = systemContent;
    } else if (mode === "text") {
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
    const warning = checkVerifierTamperFn(
      filePath,
      this.options.projectRoot,
      state,
    );
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
      status: "BLOCKED",
      reason_code: "recovery_exhausted",
      cause_class: "harness",
      reason: `Verifier integrity compromised — ${this.tamperCount} verifier dependency files were modified. The task cannot be completed honestly.`,
      missing:
        "An unmodified verifier dependency set for an independent verification.",
      checked: [
        {
          action: "verifier_integrity",
          target: "verifier_dependencies",
          finding: `${this.tamperCount} verifier dependency modification(s) recorded by the R9 tamper guard`,
        },
      ],
    };
  }

  private buildVerifierBlockedReport(reason: string): BlockedReport {
    if (this.workingState.localization?.phase === "exhausted") {
      const localization = this.workingState.localization;
      return {
        schema_version: 1,
        status: "BLOCKED",
        reason_code: "localization_exhausted",
        cause_class: "harness",
        reason:
          "LOCALIZATION_EXHAUSTED: no diagnostic candidate was corroborated within the bounded allowance.",
        missing:
          "A source or test location supported by a content-bearing read and the failure diagnostic.",
        checked: [
          {
            action: "localize_failure",
            target: localization.failureSignature.slice(0, 180),
            finding: `${localization.calls} inspection call(s), ${localization.rounds} candidate scope(s); no accepted target`,
          },
        ],
      };
    }
    // R0-A: a harness-origin block must carry REAL checked evidence, never an
    // empty `checked` array (BlockedReportSchema requires >=1) and never a fake
    // placeholder. Prefer the actual verifier attempt when one ran red; else the
    // completion gate's own rejection is the evidence of record.
    const receipt = this.lastVerifierReceipt;
    const redReceipt =
      receipt && receipt.exit_code !== 0 && receipt.stale !== true
        ? receipt
        : null;
    if (redReceipt) {
      const finding = (
        redReceipt.summary && redReceipt.summary.trim() !== ""
          ? redReceipt.summary
          : `exit ${redReceipt.exit_code}`
      ).slice(0, 500);
      return {
        schema_version: 1,
        status: "BLOCKED",
        reason,
        missing:
          "A passing authoritative verifier for the current workspace revision.",
        reason_code: "verification_failed",
        cause_class: "verification",
        checked: [
          {
            action: "run_command",
            target: redReceipt.command || "verifier",
            finding,
          },
        ],
      };
    }
    return {
      schema_version: 1,
      status: "BLOCKED",
      reason,
      missing:
        "A completion that satisfies the artifact and verifier honesty gate.",
      reason_code: "recovery_exhausted",
      cause_class: "harness",
      checked: [
        {
          action: "completion_gate",
          target: this.hasAnyWrites()
            ? "verifier_honesty"
            : "zero_successful_writes",
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
      return this.hashContent(await readFile(resolved, "utf-8"));
    } catch {
      return "";
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
    const modelName = this.modelPolicy?.provider === "opencode-go" ? undefined : resolvePhaseModelName(this._lastPhase, {
      investigateModel: this.limits.investigateModel,
      mutateModel: this.limits.mutateModel,
    });
    if (!modelName) return this.resolveDeliberationRunner();
    if (!isOfflineChatMode()) {
      assertLiveModelId(modelName, "live chat phase routing");
    }
    const isInvestigate = !this._lastPhase || this._lastPhase === "investigate";
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
      (m) => m.role === "system" && m.content.startsWith("## Active Task List"),
    );
    if (todoMsgIdx >= 0) {
      this.conversation.splice(todoMsgIdx, 1);
    }

    if (this.todos.size === 0) return;

    // Build formatted todo list (max 10 items shown directly)
    const lines: string[] = ["## Active Task List"];
    let count = 0;
    for (const [, todo] of this.todos) {
      if (count >= 10) {
        lines.push(`- ... and ${this.todos.size - count} more`);
        break;
      }
      lines.push(`- [${todo.status}] ${todo.content}`);
      count++;
    }
    const content = lines.join("\n");

    // Inject after the first system message (or at the beginning if none)
    const sysIdx = this.conversation.findIndex((m) => m.role === "system");
    if (sysIdx >= 0) {
      this.conversation.splice(sysIdx + 1, 0, { role: "system", content });
    } else {
      this.conversation.unshift({ role: "system", content });
    }
  }

  private detectAndBuildBlockedReport(answer: string): BlockedReport | null {
    return detectBlockedReportFromAnswer(answer, this.toolCallLog);
  }
  private buildResult(
    status: ChatResult["status"],
    callbacks: ChatCallbacks,
    answer?: string,
    blockedReport?: BlockedReport | null,
    knownOutcome?: TerminalOutcome,
    knownReason?: TerminalReason,
    ownerGeneration?: number,
  ): ChatResult {
    return assembleChatResult(
      this.terminalRuntimeInput(),
      status,
      callbacks,
      answer,
      blockedReport,
      knownOutcome,
      knownReason,
      ownerGeneration,
    );
  }

  public resetCompactionCircuitBreaker(): void {
    this.compactionConsecutiveFailures = 0;
  }
  /** Capture provider ownership once before an inference suspension point. */
  private captureProviderUsageScope(
    ownerGeneration = this.activeSubmissionGeneration,
  ): ChatUsageScope {
    return {
      taskOwnerId: this.taskAllowance?.taskOwnerId ?? null,
      projectRoot: realpathSync(this.options.projectRoot),
      accountingEpoch: globalCostTracker.getAccountingEpoch(),
      turnId: this.parity.turnId,
      chargeId: null,
      ownerGeneration,
      isOwnerCurrent: () => this.isSubmissionCurrent(ownerGeneration),
    };
  }
  private providerUsageEffects(): ChatProviderUsageEffects {
    return {
      retryCallbacks: (context) => this.providerRetryCallbacks(context),
      settleUsage: (runner, scope) => this.trackRunnerUsage(runner, scope),
      getAbortController: () => this.abortController,
    };
  }

  /** Supply terminal evidence and explicit effects without exposing the engine to the result owner. */
  private terminalRuntimeInput(): ChatTerminalInput {
    return {
      snapshot: {
        context: {
          options: this.options,
          executionProfile: this.executionProfile,
          taskClass: this.taskClass,
          engineRunId: this.engineRunId,
          engineRunDir: this.engineRunDir,
          turnIndex: this._turnIndex,
          turnId: this.parity.turnId,
          taskContract: this.parity.liveAuthority?.taskContract,
        },
        outcome: {
          hasMutation: this.hasAnyWrites(),
          readOnly: this.isAcceptedReadOnlyTerminal(),
          budgetExceeded: this.budgetExceeded,
          terminatingLimiter: this.terminatingLimiter,
          terminalLimiterReason: this.terminalLimiterReason,
          lastVerifierReceipt: this.lastVerifierReceipt,
          gatePolicy: this.gatePolicy,
          lastCriticReceipt: this.lastCriticReceipt,
          verifierTampered: this.verifierTampered,
          writeCount: this.writeCount,
        },
        presentation: {
          conversation: this.conversation,
          cachedSystemPromptNative: this.cachedSystemPromptNative,
          playbookId: this.activePlaybook?.id ?? null,
          dedupeHitCount: this.dedupeHitCount,
          lastRequestPromptTokens: this.lastRequestPromptTokens,
          lastRequestCompletionTokens: this.lastRequestCompletionTokens,
          lastRequestModelId: this.lastRequestModelId,
          currentTurnTelemetry: this.currentTurnTelemetry,
          lastTurnTelemetry: this.lastTurnTelemetry,
        },
        evidence: {
          sessionEvents: this.parity.sessionEvents,
          policyEventLog: this.policyEventLog,
          observability: this.obsHandles(),
        },
        allowance: {
          limits: this.limits,
          postWriteRepairWallCapMs: this.postWriteRepairWallCapMs,
          criticRepairCostCapUsd: this.criticRepairCostCapUsd,
          taskCostBaselineUsd: this.taskCostBaselineUsd,
        },
      },
      effects: {
        decideCompletion: (requested, hasMutation) =>
          this.decideCompletion(requested, hasMutation),
        settleActiveExecution: () => this.settleActiveExecutionForTerminal(),
        finalizeTurn: (outcome, status, reason) =>
          finalizeParityTurnSync(
            this.parity,
            this.engineRunDir,
            outcome,
            status,
            reason,
          ),
        storeTelemetry: (record) => {
          this.lastTurnTelemetry = record;
        },
        setLimiter: (limiter, reason) => {
          this.terminatingLimiter = limiter;
          this.terminalLimiterReason = reason;
        },
        setBudgetExceeded: () => {
          this.budgetExceeded = true;
        },
        isSubmissionCurrent: (generation) =>
          this.isSubmissionCurrent(generation),
        currentTaskCostUsd: () => this.currentTaskCostUsd(),
        persistTaskCostBaseline: () => this.persistTaskCostBaseline(),
      },
    };
  }
}

export type {
  TaskIntent,
  ChatAllowanceCostCap,
  ChatAllowanceGrant,
  ChatTaskAllowanceSnapshot,
  SubmitMessageOptions,
  ChatEngineOptions,
  ChatEngineTurnPreparation,
  ContextCompactedInfo,
  ChatCallbacks,
  StreamEvent,
  ChatEvent,
  ChatResult,
} from "./chatEngineContracts.js";
export type { ChatEngineActionExecutorHost } from "./chatEngineActionExecutor.js";
export type { ChatEngineStreamingLoopHost } from "./chatEngineStreamingLoop.js";
export {
  deriveChildDelegationId,
  formatTextToolResults,
  isDiscriminatingInspectionEvidence,
  wrapPresentationCallbacks,
} from "./chatEngineHelpers.js";
export type { TextToolResultEntry } from "./chatEngineHelpers.js";
