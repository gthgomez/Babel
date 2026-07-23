/**
 * ChatEngine — unified conversational agent loop for Babel chat mode.
 * Chat investigates and executes; deep mode remains the governed pipeline.
 * Compaction: chatCompaction.ts. Critic/budget: chatEngineCriticBudget.ts.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';

import { isBabelHeadlessEnv } from '../utils/envFlags.js';
import { resolveProjectPath } from '../utils/projectPath.js';

import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

import { endSpan } from '../telemetry/tracing.js';
import { chatSessionDir, transcriptPath as layoutTranscriptPath } from '../cli/runsLayout.js';
import { allocateThreadId } from '../services/threadStore/threadIds.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { OllamaApiRunner } from '../runners/ollamaApi.js';
import type { ProviderMessage, RunnerCallbacks } from '../runners/base.js';
import {
  resolveFamilyModelPolicy,
  loadModelPolicyConfig,
  getAvailableModels,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';
import { globalCostTracker } from '../services/costTracker.js';
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
import {
  detectEnvBlockedFromText,
  evaluateCompletionPrefersPatch,
} from './implementorPolicy.js';
import { evaluatePhaseToolGate } from './phaseToolPolicy.js';
import { extractJson } from '../utils/extractJson.js';
import type { BlockedReport, TerminalOutcome } from '../schemas/agentContracts.js';
import {
  CompactionManager,
  DEFAULT_COMPACTION_CONFIG,
  estimateTokens,
} from './chatCompaction.js';
import { getGlobalTokenTracker } from '../ui/tokenHistory.js';
import {
  resolveChatEngineLimits,
  type ChatEngineLimits,
} from '../config/chatEngineLimits.js';
import {
  resolveChatTaskClass,
  getChatTaskTune,
  type ChatTaskClass,
  type VerificationPolicy,
} from '../config/chatTaskClass.js';
import {
  AUTO_CONTINUE_REFUSAL_MSG,
  buildAutoContinueBlockedReport,
  buildGateRejectUserMessageForEngine,
  evaluateCompletionGateForEngine,
  isAuthoritativeVerifierCommand,
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

import { parseTextToolTurn } from './textToolParser.js';
import {
  ChatTurnSchema,
  buildChatSystemPrompt,
  buildChatTurnPrompt,
  buildAnswerSynthesisPrompt,
  buildChatToolDefinitions,
  buildRestrictedChatToolDefinitions,
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
  buildProviderMessages,
} from './chatToolDefinitions.js';

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
  parityRecordToolBatch,
  parityArbitrateCycle,
  parityShouldCompact,
  parityBuildCapsule,
  parityTryFailover,
  finalizeParityTurnSync,
  finalizeParityCancel,
  checkpointParityEventLog,
  type ParityRuntime,
} from './chatEngineParityBridge.js';
import { buildRepoMapPreamble } from './repoMapPreamble.js';
import {
  requestChatActionApproval,
  bindChatApprovalSession,
  getChatApprovalSession,
  setChatApprovalTurnId,
} from './chatApproval.js';
import { deriveSubagentApprovalSession } from './approvalRequests.js';
import { clearBackgroundShellRegistry } from './backgroundShell.js';
import {
  dispatchInputArbiter,
  consumeInputArbiterEffects,
} from '../ui/inputCoordinator.js';
import { createHash } from 'node:crypto';
import {
  executeAwaitCommandAction,
  executeBackgroundRunCommandAction,
} from './chatBackgroundShell.js';

import { runReadOnlyAgentLoop } from './lanes/readOnlyAgentLoop.js';
import { runMutationAgentLoop } from './lanes/runMutationAgentLoop.js';
import { runImplementWorktreeAgent } from './implementWorktreeAgent.js';
import { executeTool, renderGitDiff, type ToolContext } from '../localTools.js';
import { createStallDetector, updateStallState, getStallInterventionMessage, isTextOnlyLoop, buildTextOnlyLoopIntervention, buildTextOnlyLoopBlockedMessage, TEXT_ONLY_FORCE_BLOCKED_THRESHOLD } from './stallDetector.js';
import type { StallState, StallIntervention } from './stallDetector.js';
import { classifyPhase, buildPhaseNudge, shouldNudge, type ChatPhase } from './chatPhaseNudge.js';
import { isSuccessfulDirectMutation } from './mutationTools.js';
import type { DiffCriticVerdict } from './diffCritic.js';
import {
  evaluateTokenExplosionAfterTurn,
} from './budgetKillPolicy.js';
import {
  applyExploreFuses as applyExploreFusesPolicy,
  buildPolicyTerminalBlockedReport,
  evaluateZeroWriteHardStop,
  resolveRestrictedToolMode,
  type ExploreFuseResult,
} from './chatZeroWritePolicy.js';
import { PolicyEventLog, type PolicyEvent } from './policyEventLog.js';
import { BlockedAttemptLedger } from './blockedAttemptLedger.js';
import {
  TurnRoutingReceiptLog,
  type TurnRoutingReceipt,
} from './turnRoutingReceipt.js';
import { resolvePhaseModelName } from './phaseModelRouting.js';
import {
  ObservationTailBuffer,
  resolveObservationTailChars,
} from './observationTails.js';
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
  type AsymmetricCriticState,
  type CriticRunner,
} from './chatEngineCriticBudget.js';
import {
  detectAndBuildBlockedReport as detectBlockedReportFromAnswer,
  runPostEditStaticCheck as runPostEditStaticCheckFn,
  summarizeDroppedTurns as summarizeDroppedTurnsFn,
  compactHeuristicConversation,
  pinProjectRootEnv,
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
  beginUserSubmission,
  type TurnRuntimeSnapshot,
} from './turnRuntime.js';

// ─── Types ────────────────────────────────────────────────────────────────

/** Classifies the user's intent for a chat turn.
 *  'execute' = user wants code changes → gate active in headless mode
 *  'explain' = user wants information → gate bypassed */
export type TaskIntent = 'execute' | 'explain';

/** Options for a single user submission (W0.3 TurnRuntime). */
export interface SubmitMessageOptions {
  /**
   * Explicit continuation linkage: preserve write/gate counters from the
   * prior submission. Default false — isolate so prior writes cannot satisfy
   * a new task's completion gate.
   */
  continueTask?: boolean;
}

export interface ChatEngineOptions {
  task: string;
  projectRoot: string;
  systemContext?: string;
  /** Batch 3: Appended system prompt fragments (plugins, skills, project memory).
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
  onToolComplete?: (id: number, detail?: string) => void;
  onFileChanged?: (path: string, additions: number, deletions: number, content?: string) => void;
  onThought?: (thought: string) => void;
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
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string };

/** Events yielded by submitMessageStream() — the ChatEngine layer. */
export type ChatEvent =
  | { type: 'thinking' }
  | { type: 'answer_chunk'; text: string }
  | { type: 'tool_start'; tool: string; target: string }
  | { type: 'tool_complete'; tool: string; target: string; detail?: string }
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
      toolCalls?: Array<{ tool: string; target: string; detail?: string; error?: string }>;
      runDir?: string;
      verifierReceipt?: { command: string; exit_code: number; summary: string } | null;
      blockedReport?: BlockedReport | null;
      /** R9: Whether the agent modified a verifier dependency file. */
      verifierTampered?: boolean;
      /** Idea 14: asymmetric diff critic receipt. */
      criticReceipt?: DiffCriticVerdict | null;
      policyEvents?: PolicyEvent[];
      turnRouting?: TurnRoutingReceipt[];
      observationTails?: Array<{ tool: string; target: string; exit_code?: number; tail: string }>;
      blockedAttempts?: import('./blockedAttemptLedger.js').BlockedAttempt[];
    }
  | {
      type: 'failed';
      error: string;
      /** Present when tools ran before failure (turn-limit / stall kill / etc.). */
      toolCalls?: Array<{ tool: string; target: string; detail?: string; error?: string }>;
      runDir?: string;
    }
  | { type: 'cancelled' };

export interface ChatResult {
  status: 'completed' | 'failed' | 'cancelled' | 'blocked' | 'budget_exhausted';
  /** P0-D: Honest terminal outcome — semantically precise, never conflated.
   *  Optional for backward compatibility with test fixtures that omit it. */
  outcome?: TerminalOutcome;
  answer: string;
  usage: SessionUsageSummary;
  conversation: ChatMessage[];
  toolCalls?: Array<{ tool: string; target: string; detail?: string; error?: string }>;
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
  observationTails?: Array<{ tool: string; target: string; exit_code?: number; tail: string }>;
  /** Tier A1: Aggregate counts derived from the tool call log. */
  toolCallAggregates?: { tool_call_count: number; write_count: number; verifier_attempt_count: number };
  promptFingerprint?: PromptFingerprint;
}

// ─── Constants ────────────────────────────────────────────────────────────

const SUB_AGENT_MAX_ROUNDS = 4;
const TURN_TIMEOUT_MS = 120_000; // per-turn LLM call deadline
const MAX_TOOL_CONCURRENCY = 6; // Batch 3 #14: prevent exhausting connection pools

// ─── ChatEngine ───────────────────────────────────────────────────────────

export class ChatEngine {
  // P0-B TODO: once ProviderMessage[] path is stable, remove legacy ChatMessage[]
  // conversation store and Markdown flattening buildChatTurnPrompt.
  private conversation: ChatMessage[] = [];
  /** P0-B: Structured provider conversation — native tool calls and results with IDs. */
  private providerConversation: ProviderMessage[] = [];
  private abortController: AbortController;
  private engineRunId: string;
  private options: ChatEngineOptions;
  private readonly limits: ChatEngineLimits;
  private modelPolicy: ResolvedModelPolicy | undefined;
  private synthesisRunner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | null = null;
  private deliberationRunner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | null = null;
  private fallbackRunner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | null = null;
  private toolCallLog: Array<{
    tool: string;
    target: string;
    detail?: string;
    error?: string;
    index: number;
    exit_code?: number;
    stdout?: string;
    stderr?: string;
    verified?: boolean;
  }> = [];
  private lastVerifierReceipt: { command: string; exit_code: number; summary: string } | null = null;
  /** Index into toolCallLog at the start of the current turn's actions.
   *  Used to correctly slice per-turn entries even as the log grows across turns. */
  private _turnToolCallLogStart = 0;
  private gatePolicy: VerificationPolicy | null = null;
  private gateStrikes = 0;
  private static readonly MAX_GATE_STRIKES = 3;
  private criticStrikes = 0;
  private lastCriticReceipt: DiffCriticVerdict | null = null;
  private criticRunner: CriticRunner | null = null;
  private criticProRunner: CriticRunner | null = null;
  private budgetExceeded = false;
  private budgetLastChanceDone = false;
  private midLoopCriticFired = false;
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
  /** Cumulative exploration tools across the entire session (never resets).
   *  Used for progressive escalation to prevent A01-class analysis paralysis. */
  private cumulativeExplorationTools = 0;
  /** Full-file read counts keyed by normalized path. */
  private fullReadCounts = new Map<string, number>();
  private apiTokenCount = 0;
  /** R11: API-reported token count at the start of the current turn.
   *  Used to compute the per-round token delta for the token ceiling check. */
  private apiTokenCountAtTurnStart = 0;
  /** R11: True when the current turn executed at least one tool action.
   *  Used by the auto-continue refusal gate — a turn with zero tool
   *  calls must not be auto-restarted. */
  private _hadToolCallsThisTurn = false;
  /** T2.3: When true, the next deliberateTurn / native-tools call restricts
   *  the tool schema to write+verify+todo+finish only (no read/exploration).
   *  Set by the stall restrict_tools intervention; cleared after one turn. */
  private restrictToolsNextTurn = false;
  private _sessionStartTime = 0;
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
  /** E5: LLM-based conversation compaction (from chatCompaction.ts).
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
  private readCache: Map<string, { hash: string; timestamp: number }> = new Map();
  private dedupeHitCount = 0;
  private writeCount = 0;
  /** R8: Verifier receipt cache — avoids re-running identical verifier commands
   *  when no writes have occurred since the last run. Keyed by command string. */
  private verifierReceiptCache: Map<
    string,
    { receipt: { command: string; exit_code: number; summary: string }; writeCountAtCache: number }
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
  private investigateRunner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | null = null;
  private mutateRunner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | null = null;
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

  private get engineRunDir(): string {
    return chatSessionDir(this.engineRunId);
  }

  constructor(options: ChatEngineOptions) {
    this.options = options;
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
      },
      undefined,
      { taskClass: this.taskClass, taskText: options.task },
    );
    this.abortController = new AbortController();
    this.engineRunId = allocateThreadId();
    // definite assignment: engineRunId set immediately above
    this.parity = createParityRuntime(this.engineRunId);
    clearBackgroundShellRegistry(); // T2.2: per-session bg shell isolation

    // E5: Initialize LLM-based compaction manager (gated behind BABEL_COMPACTION=off).
    // When disabled or on failure, falls back to the inline compactConversation() heuristic.
    if (process.env['BABEL_COMPACTION'] !== 'off') {
      this.compactionManager = new CompactionManager();
    }
    mkdirSync(this.engineRunDir, { recursive: true });

    // Crash-safe patch persistence: write-through recovery file.
    this.patchRecoveryPath = join(this.engineRunDir, 'patches.recovery.log');

    // R9: Initialize verifier guard — track hashes of verifier dependency
    // files so tampering can be detected and flagged in real-time.
    this.initializeVerifierGuard();

    // P-4.2 / Gap-2: structured memory dir with task relevance, else BABEL.md.
    const babelMd = readProjectMemoryStructured(this.options.projectRoot, this.options.task);
    if (babelMd) {
      this.options.systemContext = babelMd + (this.options.systemContext ? '\n\n' + this.options.systemContext : '');
    }

    // T3.1: Task-class playbook inject for REPL/chat (benchmark path already had this).
    const chatPlaybook = selectPlaybookForChatTask(this.options.task);
    if (chatPlaybook) {
      this.activePlaybook = chatPlaybook;
      const pbPrompt = buildPlaybookPrompt(chatPlaybook);
      if (pbPrompt) {
        this.options.systemContext =
          (this.options.systemContext ? this.options.systemContext + '\n\n' : '') + pbPrompt;
      }
    }
    // T3.3: Plan-then-execute hard gate when playbook/size threshold says so.
    this.requireTodoBeforeMutate = shouldRequireTodoPlan(this.options.task, this.activePlaybook);

    // Implementor W1.3 / W1.4: operator mode + hard plan + plan handoff.
    this.operatorMode = options.operatorMode ?? 'default';
    this.hardPlanMode =
      options.hardPlanMode === true || operatorModeIsHardPlan(this.operatorMode);
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
    const isOffline =
      process.env['BABEL_OFFLINE'] === '1' ||
      process.env['BABEL_OFFLINE'] === 'true' ||
      process.argv.includes('--offline');
    this.modelPolicy = resolveFamilyModelPolicy({
      family: isOffline ? 'Ollama' : (options.model ?? 'DeepSeek'),
      ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
      ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
      ...(process.env['BABEL_ROOT'] ? { babelRoot: process.env['BABEL_ROOT'] } : {}),
    });

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
    // Explicit markdown fenced code blocks or diff/patch snippets → execute
    if (/```(?:diff|patch|javascript|typescript|python|go|rust)\b/.test(task)) return 'execute';

    // Explicit read-only / no-edit directives → explain
    // MUST be checked before execute verb patterns so "fix this without editing
    // files" routes to explain, not execute.
    if (/\b(without\s+(editing|modifying|changing|writing|touching)|read[- ]only|do\s+not\s+(edit|modify|change|write))\b/i.test(task))
      return 'explain';

    // Fix/implement/create verbs → execute
    if (/\b(fix|repair|implement|resolve|patch|refactor|migrate|upgrade|update\s+dependency)\b/i.test(task))
      return 'execute';
    if (/\b(create|write|build|add|make)\s+(a|the|this|an?)\b/i.test(task)) return 'execute';
    if (/\b(run|execute)\s+(npm\s+test|pytest|tests?|the\s+test)\b/i.test(task)) return 'execute';
    if (/\b(change|modify|edit|rewrite|replace|remove|delete|revert|apply|set\s+up)\b/i.test(task))
      return 'execute';

    // Question/understanding patterns → explain
    if (
      /^(what|how|why|does|can\s+you\s+explain|describe|tell\s+me\s+about|show\s+me\s+how)\b/i.test(task)
    )
      return 'explain';
    if (/\b(explain|what\s+does|how\s+does|what\s+is|document|summarize)\b/i.test(task)) return 'explain';
    if (
      /\b(review|audit|analyze|diagnose|inspect|check|find|locate|search|look\s+for|compare|contrast|evaluate|assess|report\s+(tradeoffs|findings|back|on))\b(?!.*\b(and\s+fix|then\s+fix|fix\s+it)\b)/i.test(
        task,
      )
    )
      return 'explain';

    // Read-only file inspection verbs → explain (unless paired with edit intent)
    if (
      /\b(read|list|show|cat|head|tail|display|print|output)\b/i.test(task) &&
      !/\b(and\s+(fix|edit|modify|change|update|write|patch|repair)|then\s+(fix|edit|modify)|fix\s+it)\b/i.test(task)
    )
      return 'explain';

    // Default: peer-engineer posture — assume user wants execution
    return 'execute';
  }

  private evaluateCompletionGate(turnResult: ChatTurn, taskIntent: TaskIntent): 'allow' | 'reject' {
    return evaluateCompletionGateForEngine({
      turnType: turnResult.type,
      taskIntent,
      task: this.options.task,
      taskClass: this.taskClass,
      toolCallLog: this.toolCallLog,
      lastVerifierReceipt: this.lastVerifierReceipt,
    });
  }

  private buildGateRejectUserMessage(): string {
    const testCommands = formatTestCommandsForGate(this.discoveredTestCommands);
    return buildGateRejectUserMessageForEngine({
      task: this.options.task,
      taskClass: this.taskClass,
      toolCallLog: this.toolCallLog,
      lastVerifierReceipt: this.lastVerifierReceipt,
      hasAnyWrites: this.hasAnyWrites(),
      gateStrikes: this.gateStrikes,
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
      resolveDeliberationRunner: () => this.resolveDeliberationRunner(),
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
    const state = this.criticState(callbacks.onThought);
    const decision = await runAsymmetricDiffCriticImpl(
      state,
      answer,
      taskIntent,
      opts,
    );
    this.applyCriticState(state);
    return decision;
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
      formatBudgetKillAnswer(
        reason,
        this.toolCallLog,
        this.lastCriticReceipt?.verdict ?? null,
      ),
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

  private hasAnyWrites(): boolean { return sessionHasAnyWrites(this.toolCallLog); }

  private readCacheKey(filePath: string): string { return normalizeReadCacheKey(filePath, this.options.projectRoot); }

  private noteToolForReadThrash(tool: string, opts?: { error?: string; detail?: string }): void {
    if (isSuccessfulDirectMutation(tool, opts?.error)) {
      this.consecutiveReadOnlyTools = 0;
      this.consecutiveNonMutatingShells = 0;
      this.toolsWithoutWrite = 0;
      return;
    }
    if (tool === 'sub_agent' && opts?.error !== 'blocked' && /[1-9]\d*\s+changed/.test(opts?.detail ?? '')) {
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

  private buildRejectionMessage(): string { return buildGateRejectionMessage(this.toolCallLog); }

  private currentTurnHasMutation(): boolean { return turnHasMutation(this.toolCallLog, this._turnToolCallLogStart); }

  /** Force-mutate + read-thrash + cumulative exploration fuses (shared submit/stream). */
  private applyExploreFuses(executeIntent: boolean): ExploreFuseResult {
    const state = {
      turnsWithoutWrite: this.turnsWithoutWrite,
      consecutiveReadOnlyTools: this.consecutiveReadOnlyTools,
      cumulativeExplorationTools: this.cumulativeExplorationTools,
      restrictToolsNextTurn: this.restrictToolsNextTurn,
      consecutiveNonMutatingShells: this.consecutiveNonMutatingShells,
      toolsWithoutWrite: this.toolsWithoutWrite,
      phase: this._lastPhase,
    };
    const out = applyExploreFusesPolicy({
      executeIntent,
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
    return out;
  }

  /** Provider-native tool_use ids for the current stream tool batch (if any). */
  private _streamNativeToolCallIds: string[] = [];

  /** Snapshot for Tier A observability helpers (keeps chatEngine thin). */
  private obsHandles(): ObservabilityHandles {
    return {
      toolCallLog: this.toolCallLog, engineRunDir: this.engineRunDir,
      lastVerifierReceipt: this.lastVerifierReceipt, policyEventLog: this.policyEventLog,
      routingReceiptLog: this.routingReceiptLog, observationTails: this.observationTails,
      blockedAttemptLedger: this.blockedAttemptLedger,
      logIndexToTurn: this._logIndexToTurn, turnIndex: this._turnIndex,
      turnToolCallLogStart: this._turnToolCallLogStart, lastPhase: this._lastPhase,
    };
  }

  private checkBudgets(): { ok: boolean; reason?: string } {
    return checkCostWallBudgets({
      totalCostUsd: globalCostTracker.getSessionSummary().totalCostUSD,
      maxCostUsd: this.limits.maxCostUsd,
      sessionStartTime: this._sessionStartTime,
      maxWallMs: this.limits.maxWallMs,
    });
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
   *  When the task class has stallShadowMode on and the intervention would be
   *  'kill', the level is downgraded to 'nudge' (see getStallInterventionMessage)
   *  and a shadow-kill event is logged to policyEventLog. */
  private checkStallIntervention(): StallIntervention | null {
    const tune = getChatTaskTune(this.taskClass);
    const intervention = getStallInterventionMessage(
      this.stallState,
      this.limits.stallTurns,
      tune.stallShadowMode,
    );
    if (!intervention) return null;

    // Record the intervention so the next call escalates
    this.stallState.interventionLevel++;
    this.stallState.interventionHistory.push(intervention.message);

    // Shadow mode: log each time the stall detector would have killed
    if (tune.stallShadowMode && this.stallState.interventionLevel >= 4) {
      this.policyEventLog.record({
        at_turn: this._turnIndex,
        kind: 'stall_shadow_kill',
        detail: `Shadow mode: would have killed at interventionLevel=${this.stallState.interventionLevel}`,
      });
    }

    return intervention;
  }

  /**
   * P1-A: Non-stream entry is a thin adapter over submitMessageStream.
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
      cb.onToolComplete = (id: number, detail?: string) => {
        if (this.generationCounter !== generation) return;
        callbacks.onToolComplete!(id, detail);
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

    let terminal: {
      kind: 'done' | 'failed' | 'cancelled';
      answer?: string;
      blockedReport?: BlockedReport | null;
      error?: string;
    } | null = null;

    try {
      for await (const event of this.submitMessageStream(userInput, taskIntent)) {
        switch (event.type) {
          case 'answer_chunk':
            cb.onAnswerChunk?.(event.text);
            break;
          case 'thought':
            cb.onThought?.(event.text);
            break;
          case 'context_compacted':
            cb.onContextCompacted?.(event);
            break;
          case 'tool_start':
            cb.onToolStart?.(event.tool, event.target);
            break;
          case 'tool_complete':
            cb.onToolComplete?.(-1, event.detail);
            break;
          case 'done':
            terminal = {
              kind: 'done',
              answer: event.answer,
              blockedReport: event.blockedReport ?? null,
            };
            break;
          case 'failed':
            terminal = { kind: 'failed', error: event.error };
            break;
          case 'cancelled':
            terminal = { kind: 'cancelled' };
            break;
          default:
            break;
        }
      }
    } catch (error) {
      return {
        status: 'failed',
        outcome: 'AGENT_FAILURE',
        answer: error instanceof Error ? error.message : String(error),
        usage: globalCostTracker.getSessionSummary(),
        conversation: this.conversation,
      };
    }

    if (!terminal || terminal.kind === 'cancelled') {
      return this.buildResult('cancelled', cb);
    }
    if (terminal.kind === 'failed') {
      return this.buildResult('failed', cb, terminal.error ?? 'Stream failed');
    }
    if (terminal.blockedReport) {
      return this.buildResult(
        'blocked',
        cb,
        terminal.answer,
        terminal.blockedReport,
      );
    }
    return this.buildResult('completed', cb, terminal.answer);
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
    // W0.3: fresh TurnRuntime per user submission (isolate counters by default).
    const runtime = this.applyUserSubmission({
      userInput,
      ...(taskIntent !== undefined ? { taskIntent } : {}),
      ...(submitOpts?.continueTask !== undefined
        ? { continueTask: submitOpts.continueTask }
        : {}),
    });
    this.conversation.push({ role: 'user', content: userInput });
    if (this.options.intentPlanUserMessage) this.conversation.push({ role: 'user', content: this.options.intentPlanUserMessage });
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

    // P1: open parity turn (loop + durable event log)
    const modelName =
      this.options.model ?? this.modelPolicy?.family ?? 'unknown';
    const providerName = modelName.toLowerCase().includes('deepseek')
      ? 'deepseek'
      : modelName.toLowerCase().includes('ollama')
        ? 'ollama'
        : 'deepinfra';
    parityOnUserTurn(this.parity, {
      task: userInput,
      model: modelName,
      provider: providerName,
      projectRoot: this.options.projectRoot,
      policyPreset: 'workspace_write',
    });
    setChatApprovalTurnId(this.parity.turnId);

    // R4: Fire-and-forget repo map generation, awaited before first LLM call
    const repoMapPromise = this.repoMapCache === null
      ? this.generateRepoMap().then(map => {
          if (map) this.repoMapCache = map;
        }).catch(() => { /* best-effort */ })
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

    const maxTurns = this.limits.maxTurns;
    this._sessionStartTime = Date.now();

    let _turnSpan: Span | null = null;

    for (let turn = 0; turn < maxTurns; turn++) {
      // Tier A: Track turn index for per-turn observability metadata
      this._turnIndex = turn;
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
        yield { type: 'cancelled' };
        return;
      }

      // Budget checks (P1): cost, wall-clock — honest receipts + last-chance critic
      const budget = this.checkBudgets();
      if (!budget.ok) {
        const kill = await this.handleBudgetKill(
          budget.reason ?? 'Budget limit exceeded.',
          { onThought: () => {} },
          resolvedIntent,
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

      // ── OTel chat turn span ──
      const _tracer = trace.getTracer('babel-cli', '1.0.0');
      let _turnSpan: Span | null = _tracer.startSpan('babel.chat.turn');

      // Compact if needed (E5) + T4.1 user-visible notice via stream event
      const compactInfo = await this.compactIfNeeded();
      if (compactInfo) {
        yield { type: 'context_compacted', ...compactInfo };
      }

      // C1: Inject current todo list into conversation before LLM call
      this.updateTodoSystemMessage();

      const runner = this.resolveRoutedRunner();
      const useNativeTools = this.shouldUseNativeTools(runner);
      const useTextTools = !useNativeTools && this.shouldUseTextTools();
      const prompt = buildChatTurnPrompt({
        conversation: this.conversation,
        task: this.options.task,
        nativeTools: useNativeTools,
        textTools: useTextTools,
      });
      const providerMessages = useNativeTools
        ? buildProviderMessages({
            conversation: this.providerConversation,
            task: this.options.task,
          })
        : [];

      yield { type: 'thinking' };

      let turnResult: ChatTurn;
      let toolsAnnouncedInStream = false;

      if (useTextTools) {
        // ── Text-tools path — simplified format for small local models ──────
        const systemPrompt = this.getOrBuildSystemPrompt('text');
        let rawText = '';
        try {
          for await (const chunk of runner.executeRawStream(
            prompt,
            systemPrompt,
            this.abortController.signal,
          )) {
            rawText += chunk;
            yield { type: 'answer_chunk', text: chunk };
          }
          this.trackRunnerUsage(runner);
          turnResult = parseTextToolTurn(rawText);
        } catch (err: any) {
          endSpan(_turnSpan, SpanStatusCode.ERROR);
          _turnSpan = null;
          yield this.streamFailed(err?.message ?? String(err));
          return;
        }
      } else if (useNativeTools) {
        const restrictTools = this.restrictToolsNextTurn;
        this.restrictToolsNextTurn = false;
        const toolDefs = restrictTools
          ? buildRestrictedChatToolDefinitions(resolveRestrictedToolMode(this.hasAnyWrites()))
          : buildChatToolDefinitions();
        const nativeActions: ChatToolAction[] = [];
        const nativeToolCallIds: string[] = [];
        let answerText = '';
        const systemPrompt = this.getOrBuildSystemPrompt('native');

        try {
          for await (const event of runner.executeWithToolsStream(
            providerMessages,
            toolDefs,
            systemPrompt,
            this.abortController.signal,
            restrictTools ? 'required' : 'auto',
          )) {
            switch (event.type) {
              case 'text_delta':
                answerText += event.text;
                yield { type: 'answer_chunk', text: event.text };
                break;
              case 'thought_delta':
                yield { type: 'thought', text: event.text };
                break;
              case 'tool_use': {
                const action = nativeToolUseToChatAction(event.name, event.input);
                nativeActions.push(action);
                nativeToolCallIds.push(
                  event.id && event.id.length > 0
                    ? event.id
                    : `tool_call_${turn}_${nativeActions.length - 1}`,
                );
                toolsAnnouncedInStream = true;
                yield {
                  type: 'tool_start',
                  tool: event.name,
                  target: chatActionTarget(action),
                };
                break;
              }
              case 'error':
                throw new Error(event.message);
              // 'done' is handled after the loop
            }
          }
          this.trackRunnerUsage(runner);
          this._streamNativeToolCallIds = nativeToolCallIds;
          turnResult = nativeActions.length > 0
            ? { type: 'tool_calls', actions: nativeActions }
            : { type: 'completion', answer: answerText || 'OK' };
        } catch (err: any) {
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
          answerText = '';
          try {
            for await (const event of fb.executeWithToolsStream(
              providerMessages,
              toolDefs,
              undefined,
              this.abortController.signal,
            )) {
              switch (event.type) {
                case 'text_delta':
                  answerText += event.text;
                  yield { type: 'answer_chunk', text: event.text };
                  break;
                case 'thought_delta':
                  yield { type: 'thought', text: event.text };
                  break;
                case 'tool_use': {
                  const action = nativeToolUseToChatAction(event.name, event.input);
                  nativeActions.push(action);
                  nativeToolCallIds.push(
                    event.id && event.id.length > 0
                      ? event.id
                      : `tool_call_${turn}_${nativeActions.length - 1}`,
                  );
                  toolsAnnouncedInStream = true;
                  yield {
                    type: 'tool_start',
                    tool: event.name,
                    target: chatActionTarget(action),
                  };
                  break;
                }
                case 'error':
                  throw new Error(event.message);
              }
            }
            this.trackRunnerUsage(fb);
            this._streamNativeToolCallIds = nativeToolCallIds;
            turnResult = nativeActions.length > 0
              ? { type: 'tool_calls', actions: nativeActions }
              : { type: 'completion', answer: answerText || 'OK' };
          } catch (fbErr: any) {
            // If tools still fail, degrade to raw-text streaming
            yield { type: 'thought', text: 'Retrying without tools…' };
            let rawText = '';
            try {
              for await (const chunk of fb.executeRawStream(
                prompt,
                undefined,
                this.abortController.signal,
              )) {
                rawText += chunk;
                yield { type: 'answer_chunk', text: chunk };
              }
              this.trackRunnerUsage(fb);
              turnResult = this.parseChatTurnLenient(rawText);
            } catch (rawErr: any) {
              endSpan(_turnSpan, SpanStatusCode.ERROR);
              _turnSpan = null;
              yield this.streamFailed(rawErr?.message ?? String(rawErr));
              return;
            }
          }
        }
      } else {
        // ── Legacy prompt-based JSON path ─────────────────────────────────
        let rawText = '';
        try {
          for await (const chunk of runner.executeRawStream(
            prompt,
            undefined,
            this.abortController.signal,
          )) {
            rawText += chunk;
            yield { type: 'answer_chunk', text: chunk };
          }
          this.trackRunnerUsage(runner);
        } catch (err: any) {
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
            )) {
              rawText += chunk;
              yield { type: 'answer_chunk', text: chunk };
            }
            this.trackRunnerUsage(fb);
          } catch (fbErr: any) {
            endSpan(_turnSpan, SpanStatusCode.ERROR);
            _turnSpan = null;
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
        recordPolicyEvent(this.policyEventLog, this._turnIndex, 'token_explosion', `tokens_this_turn=${streamExplosion.tokensThisTurn}`);
        endSpan(_turnSpan, SpanStatusCode.OK);
        _turnSpan = null;
        const kill = await this.handleBudgetKill(
          `Token explosion with zero mutations: ${streamExplosion.tokensThisTurn} tokens this turn (ceiling ${this.limits.maxTokensPerRound}).`,
          { onThought: () => {} },
          resolvedIntent,
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
            this.conversation.push({ role: 'assistant', content: turnResult.thinking });
            _turnSpan.setAttribute('babel.chat.blocked', 'true');
            endSpan(_turnSpan, SpanStatusCode.OK);
            _turnSpan = null;
            yield this.streamDone(turnResult.thinking, { blockedReport: thinkingBlocked });
            return;
          }
        }

        if (!toolsAnnouncedInStream) {
          for (const action of turnResult.actions) {
            yield {
              type: 'tool_start',
              tool: chatActionToolName(action),
              target: chatActionTarget(action),
            };
          }
        }

        // Capture toolCallLog start index BEFORE execution so the
        // per-turn slice is correct even as the log grows across turns.
        this._turnToolCallLogStart = this.toolCallLog.length;

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
          this.repetitionDetector.record({ type: tool, fingerprint: `${tool}:${target}` });
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
          providerToolCallIds = pushProviderTurnMessages({
            conversation: this.providerConversation,
            actions: turnResult.actions,
            thinking: turnResult.thinking,
            turnIndex: this._turnIndex,
            observations,
            observationsPerTool: observationList,
            ...(this._streamNativeToolCallIds.length === turnResult.actions.length
              ? { toolCallIds: this._streamNativeToolCallIds }
              : {}),
          });
        }

        // Yield tool complete events (slice from this turn's start, sorted by
        // original action index so tool_complete order matches tool_start order
        // even when read tools complete concurrently in a different order).
        for (const tc of this.toolCallLog
          .slice(this._turnToolCallLogStart)
          .sort((a, b) => a.index - b.index)) {
          yield {
            type: 'tool_complete',
            tool: tc.tool,
            target: tc.target,
            ...(tc.detail ? { detail: tc.detail } : {}),
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
          this.midLoopCriticFired = false;
        } else {
          this.turnsWithoutWrite++;
        }

        // Mid-loop heuristic critic (stream path)
        if (
          this.currentTurnHasMutation() ||
          (this.hasAnyWrites() && this.lastVerifierReceipt)
        ) {
          this.maybeInjectMidLoopHeuristicCritic(
            { onThought: () => {} },
            resolvedIntent,
          );
        }

        const exploreFuses = this.applyExploreFuses(resolvedIntent === 'execute');
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
          recordPolicyEvent(this.policyEventLog, this._turnIndex, 'phase_change', `${this._lastPhase ?? 'start'}→${streamPhase}`);
        }
        this._lastPhase = streamPhase;
        if (shouldNudge(this._lastPhase)) {
          const hintsStr = turnCallsStr
            .filter(
              (e) =>
                e.tool === 'read_file' ||
                e.tool === 'read_range' ||
                isSuccessfulDirectMutation(e.tool, e.error),
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
          const tamperAnswer = await this.synthesizeAnswer(
            allToolObservations, { onAnswerChunk: (_chunk: string) => {} },
          ).catch(() => '');
          const tamperBlocked = tamperAnswer
            ? this.detectAndBuildBlockedReport(tamperAnswer)
            : null;
          const finalTamperAnswer = tamperBlocked
            ? tamperAnswer
            : `BLOCKED: Verifier integrity compromised — ${this.tamperCount} verifier dependency files were modified. The task cannot be completed honestly.`;
          this.conversation.push({ role: 'assistant', content: finalTamperAnswer });
          yield this.streamDone(finalTamperAnswer, { blockedReport: tamperBlocked ?? null, verifierTampered: true });
          return;
        }
        if (tamperEscalation) {
          this.conversation.push({ role: 'user', content: tamperEscalation });
          yield { type: 'thought', text: `[Tamper escalation: ${this.tamperCount} violations]` };
        }

        // R2: Escalating stall intervention — kill routed through parity arbiter
        const stallIntervention = this.checkStallIntervention();
        if (stallIntervention && stallIntervention.level !== 'kill') {
          recordPolicyEvent(
            this.policyEventLog,
            this._turnIndex,
            'stall_intervention',
            `level=${stallIntervention.level}`,
          );
          if (stallIntervention.level === 'restrict_tools') {
            this.restrictToolsNextTurn = true;
          }
          this.conversation.push({
            role: 'user',
            content: stallIntervention.message,
          });
          yield { type: 'thought', text: `[Stall intervention: ${stallIntervention.level}]` };
        }
        if (stallIntervention?.level === 'kill') {
          recordPolicyEvent(
            this.policyEventLog,
            this._turnIndex,
            'stall_intervention',
            'level=kill',
          );
        }

        // P1-B/C: record progress + durable tool results (contentHash for re-read fidelity)
        const turnSlice = this.toolCallLog.slice(this._turnToolCallLogStart);
        const resolveToolCallId = (idx: number): string => {
          if (providerToolCallIds?.[idx]) return providerToolCallIds[idx]!;
          if (this._streamNativeToolCallIds[idx]) return this._streamNativeToolCallIds[idx]!;
          return `tool_call_${turn}_${idx}`;
        };
        const toolCalls = turnSlice.map((tc, idx) => ({
          id: resolveToolCallId(idx),
          type: 'function' as const,
          function: {
            name: tc.tool,
            arguments: JSON.stringify({ target: tc.target }),
          },
        }));
        const isReadTool = (name: string) =>
          name === 'read_file' ||
          name === 'file_read' ||
          name === 'read_range' ||
          name === 'grep';
        parityRecordToolBatch(this.parity, {
          at_turn: turn,
          ...(turnResult.type === 'tool_calls' && turnResult.thinking
            ? { thinking: turnResult.thinking }
            : {}),
          toolCalls,
          results: turnSlice.map((tc, idx) => {
            const content = tc.stdout ?? tc.stderr ?? tc.detail ?? '';
            const base = {
              tool_call_id: resolveToolCallId(idx),
              tool_name: tc.tool,
              content,
              target: tc.target,
              ...(tc.exit_code !== undefined ? { exit_code: tc.exit_code } : {}),
            };
            if (isReadTool(tc.tool) && content.length > 0) {
              return {
                ...base,
                contentHash: createHash('sha256').update(content).digest('hex').slice(0, 16),
              };
            }
            return base;
          }),
          patchAttempted: turnSlice.some(
            (t) => isSuccessfulDirectMutation(t.tool, t.error) || t.tool === 'str_replace',
          ),
          patchFailed: turnSlice.some(
            (t) => t.tool === 'str_replace' && t.error != null && t.error !== '',
          ),
          verifierChanged: turnSlice.some(
            (t) => t.tool === 'run_command' || t.tool === 'test_run' || t.tool === 'shell_exec',
          ),
          // Do NOT pass every read as localizedPaths — re-reads use contentHash only.
        });
        this._streamNativeToolCallIds = [];

        const zeroWriteNudge = evaluateZeroWriteHardStop({
          executeIntent: resolvedIntent === 'execute',
          completedTurns: turn + 1,
          hasAnyWrites: this.hasAnyWrites(),
          taskClass: this.taskClass,
          onPolicyEvent: (event) => this.policyEventLog.record(event),
        });
        const arb = parityArbitrateCycle({
          rt: this.parity,
          fuseLabels: exploreFuses.labels,
          forceMutateMessage: exploreFuses.forceMutateMessage,
          readThrashMessage: exploreFuses.readThrashMessage,
          explorationFuseMessage: exploreFuses.explorationFuseMessage,
          shellSoftMessage: exploreFuses.shellSoftMessage,
          investigateBudgetMessage: exploreFuses.investigateBudgetMessage,
          stallMessage:
            stallIntervention && stallIntervention.level !== 'kill'
              ? stallIntervention.message
              : null,
          stallKillMessage:
            stallIntervention?.level === 'kill' ? stallIntervention.message : null,
          zeroWriteCandidate: zeroWriteNudge,
        });
        if (arb.policySource) {
          this.policyEventLog.record({
            at_turn: turn,
            kind: arb.terminalAnswer ? 'progress_terminal' : 'progress_policy',
            detail: `${arb.policySource}: ${arb.policyMessage ?? arb.terminalAnswer ?? ''}`,
          });
        }
        if (arb.terminalAnswer) {
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          // Prefer BLOCKED synthesis when stall kill and agent already diagnosed
          if (stallIntervention?.level === 'kill') {
            const killAnswer = await this.synthesizeAnswer(allToolObservations, {
              onAnswerChunk: (_chunk: string) => {},
            }).catch(() => '');
            const killBlocked = killAnswer
              ? this.detectAndBuildBlockedReport(killAnswer)
              : null;
            if (killBlocked) {
              this.conversation.push({ role: 'assistant', content: killAnswer });
              yield this.streamDone(killAnswer, { blockedReport: killBlocked });
              return;
            }
          }
          this.conversation.push({ role: 'assistant', content: arb.terminalAnswer });
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
        // Mid-loop checkpoint only (turn continues) — terminal paths use finalizeParityTurn
        checkpointParityEventLog(this.parity, this.engineRunDir);

        _turnSpan.setAttribute('babel.chat.turn', `${turn + 1}:tool_calls`);
        endSpan(_turnSpan, SpanStatusCode.OK); _turnSpan = null;
        continue;
      }

      if (turnResult.type === 'completion') {
        const answer = turnResult.answer;

        // R1: Check for BLOCKED declaration before the gate — the agent may
        // declare BLOCKED even though no writes were made.
        const blockedReport = this.detectAndBuildBlockedReport(answer);
        if (blockedReport) {
          yield { type: 'answer_chunk', text: answer };
          this.conversation.push({ role: 'assistant', content: answer });
          _turnSpan.setAttribute('babel.chat.blocked', 'true');
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          yield this.streamDone(answer, { blockedReport });
          return;
        }

        // Implementor I-03: refuse silent complete on execute with zero writes
        // (allow env_blocked answers through).
        const envBlocked =
          detectEnvBlockedFromText(answer) ||
          this.toolCallLog.some((t) =>
            detectEnvBlockedFromText(`${t.detail ?? ''} ${t.error ?? ''}`),
          );
        const completionPref = evaluateCompletionPrefersPatch({
          executeIntent: resolvedIntent === 'execute',
          hasAnyWrites: this.hasAnyWrites(),
          envBlocked,
        });
        if (!completionPref.allowComplete && completionPref.message) {
          this.conversation.push({ role: 'assistant', content: answer });
          this.conversation.push({ role: 'user', content: completionPref.message });
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

        // R11: Per-round token ceiling — force BLOCKED before the text-only
        // counter if a single text turn burned > maxTokensPerRound.
        const tokenCeilingBlocked = this.checkPerRoundTokenCeiling(false);
        if (tokenCeilingBlocked) {
          _turnSpan.setAttribute('babel.chat.token_ceiling_blocked', 'true');
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          this.conversation.push({ role: 'assistant', content: answer });
          this.conversation.push({ role: 'assistant', content: tokenCeilingBlocked });
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
        // text/completion responses without any tool calls.
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
            this.conversation.push({ role: 'assistant', content: textBlockedMsg });
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
          yield { type: 'thought', text: `[Text-only loop: ${this.stallState.textOnlyTurns} turns, escalating]` };
          _turnSpan.setAttribute('babel.chat.text_only_turn', this.stallState.textOnlyTurns);
          endSpan(_turnSpan, SpanStatusCode.OK);
          _turnSpan = null;
          continue;
        }

        // Execution gate: buffer streaming answer until gate check passes
        const gateResult = this.evaluateCompletionGate(turnResult, resolvedIntent);
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
            this.conversation.push({ role: 'assistant', content: AUTO_CONTINUE_REFUSAL_MSG });
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
          resolvedIntent,
        );
        if (this.lastCriticReceipt) {
          yield {
            type: 'thought',
            text: `[Diff critic: ${this.lastCriticReceipt.verdict}]`,
          };
        }
        if (streamCritic === 'reject') {
          _turnSpan.setAttribute('babel.chat.critic_strike', this.criticStrikes);
          // Inject critic feedback so the model knows WHY and can fix it.
          const receipt = this.lastCriticReceipt;
          if (receipt?.reasons?.length) {
            const reasons = receipt.reasons
              .map((r, i) => `${i + 1}. ${r}`)
              .join('\n');
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
              ].join('\n'),
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

        yield { type: 'answer_chunk', text: answer };
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
    const maxTurnAnswer = await this.synthesizeAnswer(allToolObservations, {
      onAnswerChunk: (_chunk) => {},
    }).catch(() => '');
    this.conversation.push({ role: 'assistant', content: maxTurnAnswer });

    // R1: Check synthesized answer for BLOCKED before gate — must come
    // before the gate check since BLOCKED is a valid terminal outcome
    // that bypasses the write/verifier gate.
    const maxTurnBlockedReport = this.detectAndBuildBlockedReport(maxTurnAnswer);
    if (maxTurnBlockedReport) {
      yield this.streamDone(maxTurnAnswer, { blockedReport: maxTurnBlockedReport });
      return;
    }

    if (resolvedIntent === 'execute') {
      const gateResult = this.evaluateCompletionGate(
        { type: 'completion', answer: '' },
        resolvedIntent,
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
        resolvedIntent,
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
   * Last input-arbiter effects from cancel() — hosts may read shouldExitProcess
   * after cancel (second Ctrl+C while running).
   */
  private _lastCancelArbiterEffects: {
    shouldCancelTurn: boolean;
    shouldExitProcess: boolean;
  } = { shouldCancelTurn: false, shouldExitProcess: false };

  cancel(): void {
    this._cancelled = true;
    this.abortController.abort();
    // P2-B: first Ctrl+C → cancel_turn; second may request exit_process (host-owned).
    const { effects } = dispatchInputArbiter({ type: 'ctrl_c' });
    this._lastCancelArbiterEffects = consumeInputArbiterEffects(effects);
    // AC3 choke point: cancel always flushes event log to disk
    finalizeParityCancel(this.parity, this.engineRunDir);
    // Replace with a fresh controller so future requests are not affected
    // by a stale aborted signal from a prior cancellation.
    this.abortController = new AbortController();
  }

  /** Host/REPL: whether the last cancel() also requested process exit. */
  getLastCancelArbiterEffects(): {
    shouldCancelTurn: boolean;
    shouldExitProcess: boolean;
  } {
    return { ...this._lastCancelArbiterEffects };
  }

  /** P1-C: expose durable event log for resume / tests. */
  getParityEventLog() {
    return this.parity.eventLog;
  }

  getParityRuntime(): ParityRuntime {
    return this.parity;
  }

  /** P1-C: restore persisted event log after kill/restart resume. */
  restoreEventLog(log: import('./threadEventLog.js').ThreadEventLog): void {
    this.parity.eventLog = log;
    const lastTurn = [...log.events].reverse().find((e) => e.kind === 'turn_started');
    if (lastTurn) this.parity.turnId = lastTurn.turn_id;
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
    const outcome = computeTerminalOutcome({
      finalStatus: extra?.blockedReport ? 'blocked' : 'completed',
      budgetExceeded: this.budgetExceeded,
      lastVerifierReceipt: this.lastVerifierReceipt,
      blockedReport: extra?.blockedReport,
    });
    finalizeParityTurnSync(
      this.parity,
      this.engineRunDir,
      outcome,
      extra?.blockedReport ? 'blocked' : 'completed',
    );
    return buildStreamDone(this.obsHandles(), answer, extra);
  }

  private streamFailed(error: string) {
    finalizeParityTurnSync(this.parity, this.engineRunDir, 'AGENT_FAILURE', 'failed');
    return buildStreamFailed(this.obsHandles(), error);
  }

  getConversation(): ChatMessage[] {
    return [...this.conversation];
  }

  getEngineRunId(): string {
    return this.engineRunId;
  }

  assignRunId(runId: string): void {
    this.engineRunId = runId;
    mkdirSync(this.engineRunDir, { recursive: true });
  }

  replaceConversation(messages: ChatMessage[]): void {
    this.conversation = messages;
    this.cachedSystemPromptLegacy = null;
    this.cachedSystemPromptNative = null;
    this.cachedSystemPromptText = null;
  }

  /** P1-C: restore structured provider conversation (tool call/result IDs) on resume. */
  replaceProviderConversation(messages: ProviderMessage[]): void {
    this.providerConversation = messages;
  }

  getProviderConversation(): ProviderMessage[] {
    return [...this.providerConversation];
  }

  resyncTurnStateAfterBranch(): void {
    this._cancelled = false;
    this.apiTokenCount = 0;
    this.compactionConsecutiveFailures = 0;
    this.clearSystemPromptCache();
    this.abortController = new AbortController();
    this.toolCallLog = [];
    this._turnToolCallLogStart = 0;
    this.readCache.clear();
    this.verifierReceiptCache.clear();
    this.platformUnusableVerifiers.clear();
    this.verifierDependencyHashes.clear();
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

    if (!runtime.continuedTask) {
      this.lastVerifierReceipt = null;
      this.verifierReceiptCache.clear();
      // Plan handoff force-mutate elevation must not leak into an unrelated task.
      this.forceMutateTurnsOverride = null;
    }

    this.lastTurnRuntime = runtime;
    this.policyEventLog.record({
      at_turn: this._turnIndex,
      kind: 'progress_policy',
      detail: runtime.continuedTask
        ? `turn_runtime:continue:sub=${runtime.submissionIndex}:writes=${runtime.writeCount}`
        : `turn_runtime:isolate:sub=${runtime.submissionIndex}:intent=${runtime.taskIntent}`,
    });
    return runtime;
  }

  /** Observability / tests: last TurnRuntime snapshot (not live-synced mid-loop). */
  getTurnRuntimeSnapshot(): TurnRuntimeSnapshot | null {
    if (!this.lastTurnRuntime) return null;
    return this.snapshotPreviousForBegin();
  }

  /** Current submission write count (live). */
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
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(transcriptPath, 'utf-8');
    const messages: ChatMessage[] = content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));

    // Create a fresh engine (this generates a random engineRunId and creates a
    // directory that we will not use). Then replace the run ID with the existing
    // session ID and inject the loaded conversation. Private fields are
    // accessible across instances of the same class in TypeScript.
    const engine = new ChatEngine(options);
    engine.engineRunId = engineRunId;
    engine.conversation = messages;
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
  ): Promise<{ observations: string; observationList: string[]; count: number }> {
    const toolContext: ToolContext = {
      agentId: `chat-${this.engineRunId}`,
      runId: this.engineRunId,
      runDir: this.engineRunDir,
      babelRoot: process.env['BABEL_ROOT'] ?? process.cwd(),
      signal: this.abortController.signal,
    };
    let subAgentCounter = 0;
    // P1-A: order-preserving batches (only consecutive reads may parallelize).
    const batches = planToolBatches(
      orderChatToolActions(
        actions.map((a) => ({
          type: a.type,
          ...(a.type === 'sub_agent'
            ? { mutation: (a as { mutation?: boolean }).mutation }
            : {}),
        })),
      ),
    );

    const allResults: Awaited<ReturnType<typeof this.executeOneAction>>[] = [];
    let stopTerminal = false;
    for (const batch of batches) {
      if (this._cancelled || this.abortController.signal.aborted || stopTerminal) break;
      if (batch.kind === 'parallel_reads') {
        for (let c = 0; c < batch.indices.length; c += MAX_TOOL_CONCURRENCY) {
          if (this._cancelled || this.abortController.signal.aborted) break;
          const chunk = batch.indices.slice(c, c + MAX_TOOL_CONCURRENCY);
          allResults.push(
            ...(await Promise.all(
              chunk.map((index) =>
                this.executeOneAction(actions[index]!, toolContext, callbacks, {
                  index,
                  subAgentCounter: ++subAgentCounter,
                }),
              ),
            )),
          );
        }
      } else {
        const result = await this.executeOneAction(
          actions[batch.index]!,
          toolContext,
          callbacks,
          { index: batch.index, subAgentCounter: ++subAgentCounter },
        );
        allResults.push(result);
        if (isCircuitBreakerObservation(result.observation)) stopTerminal = true;
      }
    }

    allResults.sort((a, b) => a.index - b.index);
    // Align one observation slot per requested action index (empty if skipped).
    const observationList = actions.map((_, i) => {
      const hit = allResults.find((r) => r.index === i);
      return hit?.observation ?? '';
    });
    return {
      observations: allResults.map((r) => r.observation).filter(Boolean).join('\n\n'),
      observationList,
      count: allResults.length,
    };
  }

  private async executeOneAction(
    action: ChatToolAction,
    toolContext: ToolContext,
    callbacks: ChatCallbacks,
    meta: { index: number; subAgentCounter: number },
  ): Promise<{ index: number; observation: string }> {
    const tool = chatActionToolName(action);
    const target = chatActionTarget(action);
    const toolId = callbacks.onToolStart?.(tool, target) ?? -1;
    const restoreProjectRoot = pinProjectRootEnv(this.options.projectRoot);

    try {
      // T3.3 / T3.4: plan-then-execute + optional phase tool gates (before side effects)
      const isMutationSubAgent =
        action.type === 'sub_agent' && (action as { mutation?: boolean }).mutation === true;
      // Implementor W1.3: hard plan mode (mutations blocked until /execute-plan).
      const hardPlanGate = evaluateHardPlanModeGate({
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
        callbacks.onToolComplete?.(toolId, 'hard-plan-mode');
        return { index: meta.index, observation: hardPlanGate.observation ?? '' };
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
        callbacks.onToolComplete?.(toolId, 'plan-gate');
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
        callbacks.onToolComplete?.(toolId, 'phase-gate');
        return { index: meta.index, observation: phaseGate.observation ?? '' };
      }

      if (action.type === 'sub_agent') {
        const subId = `chat-sub-${meta.subAgentCounter}`;
        const mutationEnabled = (action as any).mutation === true;
        const writeScope: string[] = (action as any).write_scope ?? [];

        // #11: Fork an isolated ToolContext with a child AbortController.
        // Cancelling the parent cascades; cancelling a sibling does not.
        const childController = new AbortController();
        const onParentAbort = () => childController.abort();
        this.abortController.signal.addEventListener('abort', onParentAbort, { once: true });

        // P1-D: subagent approval session cannot exceed parent permission ceiling
        const parentApproval = getChatApprovalSession();
        const childCeiling = mutationEnabled
          ? (['shell', 'write', 'other'] as const)
          : (['other'] as const);
        const childApproval = deriveSubagentApprovalSession(
          parentApproval,
          subId,
          [...childCeiling],
        );
        const restoreApproval = () => bindChatApprovalSession(parentApproval);
        bindChatApprovalSession(childApproval);

        // Mutation sub-agent path (W2.1: git worktree + write_scope allowlist)
        if (mutationEnabled) {
          callbacks.onSubAgentStart?.({ id: subId, label: action.task.slice(0, 60) });
          try {
            // Prefer implement-worktree isolation when write_scope is declared.
            // Empty write_scope still routes through the legacy in-tree loop so
            // read-only mutation attempts get the existing "no write scope" error.
            const useWorktree =
              writeScope.length > 0 && process.env['BABEL_IMPLEMENT_WORKTREE'] !== '0';
            if (useWorktree) {
              const implResult = await runImplementWorktreeAgent(
                {
                  id: subId,
                  task: action.task,
                  writeScope,
                  maxRounds: SUB_AGENT_MAX_ROUNDS,
                  ...((action as any).model ? { model: (action as any).model as string } : {}),
                },
                {
                  projectRoot: this.options.projectRoot,
                  runDir: join(this.engineRunDir, subId),
                  abortSignal: childController.signal,
                  cleanupWorktree: false,
                  toolContext: {
                    signal: childController.signal,
                  },
                },
              );
              const details = implResult.success
                ? `${implResult.stepsExecuted} steps, ${implResult.changedFiles.length} changed (worktree ${implResult.worktree.name})`
                : `failed: ${implResult.error || 'unknown error'}`;
              this.toolCallLog.push({
                tool,
                target,
                detail: details,
                index: meta.index,
                exit_code: implResult.success ? 0 : 1,
              });
              callbacks.onToolComplete?.(toolId, details);
              if (implResult.success) {
                callbacks.onSubAgentComplete?.({ id: subId, summary: details });
              } else {
                callbacks.onSubAgentFailed?.({
                  id: subId,
                  error: implResult.error || 'unknown error',
                });
              }
              const findings = [
                `### sub_agent ${subId}: ${action.task}`,
                `status: ${implResult.success ? 'success' : 'failed'}`,
                `isolation: git_worktree`,
                `worktree: ${implResult.worktree.path}`,
                `write_scope: ${implResult.writeScope.join(', ') || '(none)'}`,
                `parent_tree_clean: ${implResult.parentTreeClean}`,
                `steps: ${implResult.stepsExecuted}`,
                `changed_files: ${implResult.changedFiles.map((f) => f.path).join(', ') || 'none'}`,
                implResult.summary,
              ].join('\n');
              return { index: meta.index, observation: findings };
            }

            const mutResult = await runMutationAgentLoop({
              agentId: subId,
              task: action.task,
              projectRoot: this.options.projectRoot,
              writeScope,
              ...(this.options.workspaceRoot ? { workspaceRoot: this.options.workspaceRoot } : {}),
              toolContext: {
                agentId: subId,
                runId: this.engineRunId,
                runDir: join(this.engineRunDir, subId),
                babelRoot: process.env['BABEL_ROOT'] ?? process.cwd(),
                signal: childController.signal,
              },
              maxRounds: SUB_AGENT_MAX_ROUNDS,
              abortSignal: childController.signal,
              runDir: join(this.engineRunDir, subId),
              ...((action as any).model ? { model: (action as any).model as string } : {}),
            });
            const details = mutResult.success
              ? `${mutResult.stepsExecuted} steps, ${mutResult.changedFiles.length} changed`
              : `failed: ${mutResult.error || 'unknown error'}`;
            this.toolCallLog.push({
              tool,
              target,
              detail: details,
              index: meta.index,
              exit_code: mutResult.success ? 0 : 1,
            });
            callbacks.onToolComplete?.(toolId, details);
            if (mutResult.success) {
              callbacks.onSubAgentComplete?.({ id: subId, summary: details });
            } else {
              callbacks.onSubAgentFailed?.({
                id: subId,
                error: mutResult.error || 'unknown error',
              });
            }
            const findings = [
              `### sub_agent ${subId}: ${action.task}`,
              `status: ${mutResult.success ? 'success' : 'failed'}`,
              `steps: ${mutResult.stepsExecuted}`,
              `changed_files: ${mutResult.changedFiles.map(f => f.path).join(', ') || 'none'}`,
              mutResult.summary,
            ].join('\n');
            return { index: meta.index, observation: findings };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.toolCallLog.push({ tool, target, detail: 'failed', error: 'error', index: meta.index, exit_code: 1 });
            callbacks.onToolComplete?.(toolId, 'failed');
            callbacks.onSubAgentFailed?.({ id: subId, error: errMsg });
            return {
              index: meta.index,
              observation: `### sub_agent ${subId}: ${action.task}\nError: ${errMsg}`,
            };
          } finally {
            restoreApproval();
            this.abortController.signal.removeEventListener('abort', onParentAbort);
          }
        }

        // Read-only sub-agent path (existing)
        callbacks.onSubAgentStart?.({ id: subId, label: action.task.slice(0, 60) });
        try {
          const subResult = await runReadOnlyAgentLoop({
            verb: 'ask',
            task: action.task,
            projectRoot: this.options.projectRoot,
            seedPaths: [],
            toolContext: {
              agentId: subId,
              runId: this.engineRunId,
              runDir: join(this.engineRunDir, subId),
              babelRoot: process.env['BABEL_ROOT'] ?? process.cwd(),
              signal: childController.signal,
            },
            maxRounds: SUB_AGENT_MAX_ROUNDS,
            preset: 'read_only',
            abortSignal: childController.signal,
            ...((action as any).model ? { model: (action as any).model as string } : {}),
          } as any);
          const findings = formatSubAgentFindings(subId, action.task, {
            observations: subResult.observations,
            stepsExecuted: subResult.stepsExecuted,
            degraded: subResult.degraded,
          });
          this.toolCallLog.push({
            tool,
            target,
            detail: `${subResult.stepsExecuted} steps`,
            index: meta.index,
            exit_code: 0,
          });
          callbacks.onToolComplete?.(toolId, `${subResult.stepsExecuted} steps`);
          callbacks.onSubAgentComplete?.({ id: subId, summary: `${subResult.stepsExecuted} steps` });
          return { index: meta.index, observation: findings };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.toolCallLog.push({
            tool,
            target,
            detail: 'failed',
            error: 'error',
            index: meta.index,
            exit_code: 1,
          });
          callbacks.onToolComplete?.(toolId, 'failed');
          callbacks.onSubAgentFailed?.({ id: subId, error: errMsg });
          return {
            index: meta.index,
            observation: `### sub_agent ${subId}: ${action.task}\nError: ${errMsg}`,
          };
        } finally {
          restoreApproval();
          this.abortController.signal.removeEventListener('abort', onParentAbort);
        }
      }

      if (isMcpChatAction(action)) {
        // MCP calls execute without approval prompts in chat mode.
        // Safety is provided by the execution sandbox and circuit breaker,
        // not by blocking the model mid-flow.
        const mcpResult = await executeTool(mapChatMcpActionToToolRequest(action), toolContext);
        const detail =
          mcpResult.exit_code === 0 ? 'ok' : `exit ${mcpResult.exit_code ?? -1}`;
        this.toolCallLog.push({
          tool,
          target,
          detail,
          index: meta.index,
          exit_code: mcpResult.exit_code,
          stdout: mcpResult.stdout,
          stderr: mcpResult.stderr,
        });
        callbacks.onToolComplete?.(toolId, detail);
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
        const webResult = await executeTool(
          mapChatWebActionToToolRequest(action),
          toolContext,
        );
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
        callbacks.onToolComplete?.(toolId, detail);
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
        const lsp = await executeLspChatToolAction({ action, toolContext, executeTool });
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
        callbacks.onToolComplete?.(toolId, lsp.detail);
        return { index: meta.index, observation: lsp.observation };
      }

      if (action.type === 'finish') {
        this.toolCallLog.push({ tool, target, detail: 'done', index: meta.index, exit_code: 0 });
        callbacks.onToolComplete?.(toolId, 'done');
        return { index: meta.index, observation: '' };
      }

      // ── B2: Read dedupe cache — skip read_file if file unchanged ─────
      // Path-normalized keys so absolute/relative variants share one slot.
      let fileReadCacheHash: string | undefined;
      if (action.type === 'read_file') {
        const pathKey = this.readCacheKey(action.path);
        const maxFull = getChatTaskTune(this.taskClass).maxFullReadsPerFile;
        const priorFull = this.fullReadCounts.get(pathKey) ?? 0;
        if (shouldSkipFullReread({ fullReadCount: priorFull, maxFullReads: maxFull })) {
          this.dedupeHitCount++;
          this.noteToolForReadThrash(tool);
          this.toolCallLog.push({
            tool,
            target,
            detail: 'read_limit',
            index: meta.index,
            exit_code: 0,
          });
          callbacks.onToolComplete?.(toolId, 'read_limit');
          return {
            index: meta.index,
            observation: buildFullRereadSkipObservation(target, priorFull, maxFull),
          };
        }
        fileReadCacheHash = await this.hashFilePath(action.path);
        const cached = this.readCache.get(pathKey);
        if (cached && cached.hash === fileReadCacheHash) {
          const secs = Math.round((Date.now() - cached.timestamp) / 1000);
          this.dedupeHitCount++;
          this.noteToolForReadThrash(tool);
          this.toolCallLog.push({ tool, target, detail: 'cached', index: meta.index, exit_code: 0 });
          callbacks.onToolComplete?.(toolId, 'cached');
          return {
            index: meta.index,
            observation:
              `### ${tool} ${target}\nexit_code: 0\n\`\`\`\n` +
              `File ${target} unchanged since last read (${secs}s ago). Skipping re-injection.\n\`\`\``,
          };
        }
      }

      // ── P1-A: str_replace via governed mutation path (policy/checkpoint/cache) ──
      if (action.type === 'str_replace') {
        const autoApprove =
          isBabelHeadlessEnv() || process.env['BABEL_BENCHMARK_AUTO_APPROVE'] === '1';
        const gov = await governedStrReplace(
          { file_path: action.file_path, old_str: action.old_str, new_str: action.new_str },
          {
            projectRoot: this.options.projectRoot,
            context: toolContext,
            preset: 'workspace_write',
            executor: defaultToolExecutor,
            ...(autoApprove
              ? { onAskApproval: async () => true }
              : process.stdout.isTTY && !process.env['CI']
                ? { onAskApproval: requestChatActionApproval }
                : {}),
          },
        );
        if (gov.exit_code !== 0) {
          this.toolCallLog.push({
            tool, target, detail: 'error', error: gov.error ?? 'str_replace failed',
            index: meta.index, exit_code: gov.exit_code,
          });
          callbacks.onToolComplete?.(toolId, gov.policyBlocked ? 'blocked' : 'error');
          return { index: meta.index, observation: gov.observation };
        }
        try {
          const newContent = await readFile(gov.absolutePath, 'utf-8');
          this.readCache.set(this.readCacheKey(gov.absolutePath), {
            hash: this.hashContent(newContent), timestamp: Date.now(),
          });
        } catch { /* best-effort */ }
        this.fullReadCounts.delete(this.readCacheKey(gov.absolutePath));
        this.writeCount++;
        this.consecutiveReadOnlyTools = 0;
        const lineNumber = gov.lineNumber ?? 0;
        this.toolCallLog.push({ tool, target, detail: `line ${lineNumber}`, index: meta.index, exit_code: 0 });
        callbacks.onToolComplete?.(toolId, `line ${lineNumber}`);
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
          this.patchRecoveryPath ?? '', 'str_replace', action.file_path,
          `old=${action.old_str.slice(0, 200)}\nnew=${action.new_str.slice(0, 200)}`,
        );
        return { index: meta.index, observation: strObs };
      }

      // ── B1: read_range — read specific lines ────────────────────────
      if (action.type === 'read_range') {
        const rPath = resolveProjectPath(this.options.projectRoot, action.file_path);
        const rContent = await readFile(rPath, 'utf-8');
        const rHash = this.hashContent(rContent);
        const rKey = this.readCacheKey(rPath);
        const rCached = this.readCache.get(rKey);
        // read_range does not bump fullReadCounts (line windows allowed)
        this.noteToolForReadThrash(tool);
        if (rCached && rCached.hash === rHash) {
          const secs = Math.round((Date.now() - rCached.timestamp) / 1000);
          this.dedupeHitCount++;
          this.toolCallLog.push({ tool, target, detail: 'cached', index: meta.index, exit_code: 0 });
          callbacks.onToolComplete?.(toolId, 'cached');
          return {
            index: meta.index,
            observation:
              `### ${tool} ${target}\nexit_code: 0\n\`\`\`\n` +
              `File ${target} unchanged since last read (${secs}s ago). Skipping re-injection.\n\`\`\``,
          };
        }
        this.readCache.set(rKey, { hash: rHash, timestamp: Date.now() });
        const rLines = rContent.split('\n');
        if (action.start_line > rLines.length) {
          this.toolCallLog.push({ tool, target, detail: 'error', error: 'start_line out of range', index: meta.index, exit_code: 1 });
          callbacks.onToolComplete?.(toolId, 'error');
          return { index: meta.index, observation: `### read_range ${target}\nError: start_line (${action.start_line}) exceeds file length (${rLines.length})` };
        }
        const clampedEnd = Math.min(action.end_line, rLines.length);
        const selectedLines = rLines.slice(action.start_line - 1, clampedEnd);
        const numberedLines = selectedLines.map((line, i) => `${action.start_line + i}:${line}`).join('\n');
        this.toolCallLog.push({ tool, target, detail: `${selectedLines.length} lines`, index: meta.index, exit_code: 0 });
        callbacks.onToolComplete?.(toolId, `${selectedLines.length} lines`);
        return {
          index: meta.index,
          observation:
            `### read_range ${target} ${action.start_line}-${clampedEnd}\nexit_code: 0\n\`\`\`\n${numberedLines}\n\`\`\``,
        };
      }

      // ── B1: todo_write — merge-patch task list ─────────────────────
      if (action.type === 'todo_write') {
        for (const item of action.todos) {
          this.todos.set(item.id, { content: item.content, status: item.status });
        }
        const formattedTodos = [...this.todos.entries()]
          .map(([id, t]) => `- [${t.status}] ${t.content} (${id})`)
          .join('\n');
        this.toolCallLog.push({ tool, target, detail: `${this.todos.size} todos`, index: meta.index, exit_code: 0 });
        callbacks.onToolComplete?.(toolId, `${this.todos.size} todos`);
        return {
          index: meta.index,
          observation: `### todo_write\nexit_code: 0\n\`\`\`\n${formattedTodos}\n\`\`\``,
        };
      }

      // T2.2 background shell — handlers in chatBackgroundShell.ts (size ratchet)
      if (action.type === 'await_command') {
        return executeAwaitCommandAction(action, {
          projectRoot: this.options.projectRoot, tool, target, toolId,
          index: meta.index,
          pushLog: (entry) => this.toolCallLog.push(entry),
          onToolComplete: callbacks.onToolComplete,
        });
      }
      if (action.type === 'run_command' && action.background === true) {
        return executeBackgroundRunCommandAction(action, {
          projectRoot: this.options.projectRoot, tool, target, toolId,
          index: meta.index,
          pushLog: (entry) => this.toolCallLog.push(entry),
          onToolComplete: callbacks.onToolComplete,
        });
      }

      // Platform fail-fast: never re-exec a command that hard-crashed (A06 thrash).
      if (
        (action.type === 'run_command' || action.type === 'test_run') &&
        target &&
        this.platformUnusableVerifiers.has(target)
      ) {
        const prior = this.verifierReceiptCache.get(target)?.receipt.exit_code ?? 3221225794;
        return logPlatformUnusableResult({
          toolCallLog: this.toolCallLog, tool, target, exitCode: prior,
          meta, toolId, callbacks,
        });
      }

      // R8: Verifier run dedup — if the same verifier command was already run
      // and no writes have occurred since, return the cached receipt instead
      // of re-executing. This collapses repeated identical verifier runs.
      // Fatal Windows exits are not soft-cached: mark unusable and fail-fast.
      if (
        (action.type === 'run_command' || action.type === 'test_run') &&
        target
      ) {
        const cachedVerifier = this.verifierReceiptCache.get(target);
        if (cachedVerifier && cachedVerifier.writeCountAtCache === this.writeCount) {
          if (isFatalWindowsProcessExit(cachedVerifier.receipt.exit_code)) {
            this.platformUnusableVerifiers.add(target);
            return logPlatformUnusableResult({
              toolCallLog: this.toolCallLog, tool, target,
              exitCode: cachedVerifier.receipt.exit_code,
              meta, toolId, callbacks,
            });
          }
          this.dedupeHitCount++;
          this.toolCallLog.push({
            tool, target,
            detail: `cached receipt (exit ${cachedVerifier.receipt.exit_code})`,
            index: meta.index,
            exit_code: cachedVerifier.receipt.exit_code,
            stdout: cachedVerifier.receipt.summary,
          });
          callbacks.onToolComplete?.(toolId, `cached (exit ${cachedVerifier.receipt.exit_code})`);
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
      const autoApproveMutations =
        isBabelHeadlessEnv() ||
        process.env['BABEL_BENCHMARK_AUTO_APPROVE'] === '1';
      const result: PolicyGatedExecutionResult = await executeActionWithPolicy(
        agentAction,
        // workspace_write = mutations auto-execute without user approval.
        // Network-touching commands (curl, npm install) are still hard-denied.
        // Future evolutions:
        //   B — new 'auto' preset that allows everything (no approval, no denial)
        //   C — BABEL_ALLOW_NETWORK_COMMANDS=1 env flag for graduated autonomy
        'workspace_write',
        toolContext,
        {
          executor: defaultToolExecutor,
          ...(autoApproveMutations
            ? { onAskApproval: async () => true }
            : process.stdout.isTTY && !process.env['CI']
              ? { onAskApproval: requestChatActionApproval }
              : {}),
        },
      );

      const obsParts: string[] = [];
      for (const r of result.results) {
        obsParts.push(
          formatChatToolObservation(action, {
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exit_code,
          }),
        );
      }

      const lastResult = result.results[result.results.length - 1];
      const detail = lastResult
        ? lastResult.exit_code === 0
          ? formatResultDetail(action, lastResult)
          : `exit ${lastResult.exit_code}`
        : 'done';

      // Batch 1: Log tool call for structured result metadata
      this.toolCallLog.push({
        tool,
        target,
        detail,
        index: meta.index,
        ...(lastResult
          ? { exit_code: lastResult.exit_code, stdout: lastResult.stdout, stderr: lastResult.stderr }
          : {}),
        ...(result.policyBlocked ? { error: 'blocked' as const } : {}),
      });

      if (result.policyBlocked) {
        callbacks.onToolComplete?.(toolId, 'blocked');
      } else {
        callbacks.onToolComplete?.(toolId, detail);

        if (action.type === 'write_file' && !result.policyBlocked) {
          const diff = renderGitDiff(
            { tool: 'file_write', path: action.path, content: action.content },
            toolContext,
          );
          const adds = (diff.match(/^\+[^+]/gm) ?? []).length;
          const dels = (diff.match(/^-[^-]/gm) ?? []).length;
          callbacks.onFileChanged?.(action.path, adds, dels, diff);
          // R8: Seed read cache with written content so subsequent reads hit cache
          this.readCache.set(this.readCacheKey(action.path), {
            hash: this.hashContent(action.content),
            timestamp: Date.now(),
          });
          this.fullReadCounts.delete(this.readCacheKey(action.path));
          this.writeCount++;
          this.consecutiveReadOnlyTools = 0;
          // Crash-safe: persist patch to recovery log
          appendPatchRecovery(this.patchRecoveryPath ?? '', 'write_file', action.path, action.content);
        } else if (action.type === 'apply_patch' && !result.policyBlocked) {
          const { adds, dels } = countPatchStats(action.patch);
          const path = primaryPatchPath(action.patch);
          callbacks.onFileChanged?.(path, adds, dels, action.patch);
          // R8: Seed read cache after patch — hash the file on disk so
          // subsequent reads hit the dedupe cache.
          try {
            const patchedHash = await this.hashFilePath(path);
            const pKey = this.readCacheKey(path);
            this.readCache.set(pKey, { hash: patchedHash, timestamp: Date.now() });
            this.fullReadCounts.delete(pKey);
          } catch { /* file may not exist after patch — safe to skip */ }
          this.writeCount++;
          this.consecutiveReadOnlyTools = 0;
          // Crash-safe: persist patch to recovery log
          appendPatchRecovery(this.patchRecoveryPath ?? '', 'apply_patch', path, action.patch);
        }

        // B1/B2: only authoritative verifier commands update the completion receipt.
        if ((action.type === 'run_command' || action.type === 'test_run') && lastResult) {
          if (isFatalWindowsProcessExit(lastResult.exit_code) && target) {
            this.platformUnusableVerifiers.add(target);
          }
          if (isAuthoritativeVerifierCommand(target)) {
            const receipt = {
              command: target,
              exit_code: lastResult.exit_code,
              summary: (lastResult.stdout || '').slice(0, 200),
            };
            this.lastVerifierReceipt = receipt;
            // R8: cache identical verifier runs until an intervening write.
            this.verifierReceiptCache.set(target, {
              receipt,
              writeCountAtCache: this.writeCount,
            });
          }
        }

        // B2: Update read cache after successful read_file execution
        if (action.type === 'read_file' && lastResult && lastResult.exit_code === 0 && fileReadCacheHash) {
          const pathKey = this.readCacheKey(action.path);
          this.readCache.set(pathKey, { hash: fileReadCacheHash, timestamp: Date.now() });
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
      if ((action.type === 'write_file' || action.type === 'apply_patch') && !result.policyBlocked && lastResult?.exit_code === 0) {
        const editPath = action.type === 'write_file'
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
      callbacks.onToolComplete?.(toolId, 'error');
      return {
        index: meta.index,
        observation: `### ${tool} ${target}\nError: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      restoreProjectRoot();
    }
  }

  /**
   * Build tool result feedback in text-tools format for small local models.
   * Returns simple [OK]/[RESULT]/[ERROR] text that the model can parse on
   * the next turn instead of a role:tool message it does not understand.
   */
  private buildTextToolResults(startIndex: number): string {
    const entries = this.toolCallLog.slice(startIndex);
    const parts: string[] = [];

    for (const entry of entries) {
      if (entry.error === 'blocked') {
        parts.push(`[ERROR] ${entry.tool}:${entry.target} blocked`);
        continue;
      }
      if (entry.exit_code !== undefined && entry.exit_code !== 0) {
        const err = (entry.stderr || entry.stdout || '').slice(0, 500);
        parts.push(`[ERROR] ${entry.tool}:${entry.target} exit ${entry.exit_code}: ${err}`);
        continue;
      }

      // Tools whose output content the model needs to ingest
      if (entry.stdout && ['read_file', 'grep', 'glob', 'list_dir'].includes(entry.tool)) {
        const truncated = entry.stdout.length > 3000
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
      if (provider === 'ollama' && modelId) {
        try {
          this.synthesisRunner = new OllamaApiRunner(modelId);
        } catch {
          this.synthesisRunner = new DeepInfraApiRunner(this.resolveFallbackModelId());
        }
      } else if (provider === 'deepseek' && modelId) {
        try {
          this.synthesisRunner = new DeepSeekApiRunner(modelId);
        } catch {
          this.synthesisRunner = new DeepInfraApiRunner(this.resolveFallbackModelId());
        }
      } else if (modelId) {
        this.synthesisRunner = new DeepInfraApiRunner(modelId);
      } else {
        this.synthesisRunner = new DeepInfraApiRunner(this.resolveFallbackModelId());
      }
    }

    const runnerCallbacks: RunnerCallbacks | undefined = callbacks.onAnswerChunk
      ? {
          onChunk: callbacks.onAnswerChunk,
          ...(callbacks.onThought ? { onThought: callbacks.onThought } : {}),
        }
      : undefined;
    const answer = await this.executeWithTimeout(this.synthesisRunner, prompt, runnerCallbacks);
    this.trackRunnerUsage(this.synthesisRunner);
    return answer;
  }

  /** Record token usage from a runner invocation into the global cost tracker.
   *  #12: Also accumulates API-reported token counts for accurate estimation. */
  private trackRunnerUsage(runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner): void {
    const metadata = runner.getLastInvocationMetadata?.();
    if (
      metadata?.provider_model_id &&
      metadata.prompt_tokens !== null &&
      metadata.completion_tokens !== null
    ) {
      globalCostTracker.trackUsage(
        metadata.provider_model_id,
        metadata.prompt_tokens,
        metadata.completion_tokens,
        metadata.prompt_cache_hit_tokens,
        metadata.prompt_cache_miss_tokens,
      );

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
        this.routingReceiptLog, this._turnIndex, this._lastPhase, metadata,
      );
    }
  }

  /**
   * E5 + T4.1: Run compaction if over budget; notify UI when history shrinks.
   * Returns compact info when message count actually dropped, else null.
   */
  private async compactIfNeeded(
    callbacks?: ChatCallbacks,
  ): Promise<ContextCompactedInfo | null> {
    const before = this.conversation.length;
    let mode: 'llm' | 'heuristic' | null = null;
    const tokenEstimate = estimateTokens(this.conversation);
    const modelId = this.options.model ?? this.modelPolicy?.family ?? 'deepseek-v4-pro';
    // P1-E: trigger on actual request tokens (budget formula), not only message count
    const tokenTriggered = parityShouldCompact(tokenEstimate, modelId);

    if (this.compactionManager) {
      const isTextTools = this.shouldUseTextTools();
      const reserve = isTextTools ? 1024 : DEFAULT_COMPACTION_CONFIG.reserveTokens;
      if (tokenTriggered || tokenEstimate > this.limits.maxEstimatedTokens - reserve) {
        try {
          const next = await this.compactionManager.compact(this.conversation, {
            model: this.modelPolicy?.family ?? DEFAULT_COMPACTION_CONFIG.compactionModel,
            maxTokens: this.limits.maxEstimatedTokens,
            signal: this.abortController.signal,
          });
          if (next !== this.conversation) {
            // Preserve task/progress/patch/verifier capsule in history
            const capsule = parityBuildCapsule({
              task: this.options.task,
              progress: this.parity.progress,
              patchSummary: this.writeCount > 0 ? `writes=${this.writeCount}` : '',
              verifierSummary: this.lastVerifierReceipt
                ? `${this.lastVerifierReceipt.command}→${this.lastVerifierReceipt.exit_code}`
                : '',
              recentToolResults: this.toolCallLog.slice(-6).map((t) => `${t.tool} ${t.target}`),
            });
            this.conversation = [
              ...next.filter((m) => m.role === 'system').slice(0, 1),
              { role: 'system', content: capsule, name: 'compaction_capsule' },
              ...next.filter((m) => m.role !== 'system' || m.name === 'compaction_capsule'),
            ];
            mode = 'llm';
          }
        } catch {
          this.compactConversation();
          mode = 'heuristic';
        }
      }
    } else if (tokenTriggered) {
      this.compactConversation();
      mode = 'heuristic';
    } else {
      this.compactConversation();
      mode = 'heuristic';
    }

    const after = this.conversation.length;
    if (mode == null || after >= before) return null;

    const info: ContextCompactedInfo = {
      mode,
      beforeMessages: before,
      afterMessages: after,
      message: `[Context compacted…] ${before}→${after} messages (${mode})`,
    };
    // Log compaction events to stderr so they're visible in test/debug output.
    // Critical for verifying the text-tools 4K budget is working correctly.
    if (this.shouldUseTextTools()) {
      console.error(
        `[compaction] text-tools: ${before}→${after} msgs (${mode}), token estimate was ~${this.apiTokenCount}`,
      );
    }
    callbacks?.onContextCompacted?.(info);
    return info;
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
        try {
          this.deliberationRunner = new DeepSeekApiRunner(modelId);
        } catch (err) {
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
      } else if (modelId) {
        try {
          this.deliberationRunner = new DeepInfraApiRunner(modelId);
        } catch (err) {
          throw new Error(
            `Cannot start chat: DeepInfra runner failed to initialize.\n` +
              `  ${err instanceof Error ? err.message : String(err)}\n` +
              `  Set DEEPINFRA_API_KEY in your environment.\n` +
              `  Use /model to see available providers.`,
          );
        }
      } else {
        // No model configured — resolve from policy default tier.
        // Try DeepSeek first (default provider), fall back to DeepInfra.
        const fallbackId = this.resolveFallbackModelId();
        try {
          this.deliberationRunner = new DeepSeekApiRunner(fallbackId);
        } catch {
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

  /** Resolve the model ID to use when no user model is configured.
   *  Reads model-policy.json and picks the cheapest enabled model,
   *  falling back to a hardcoded default only if the policy is unavailable. */
  private resolveFallbackModelId(): string {
    try {
      const policy = loadModelPolicyConfig();
      const available = getAvailableModels();
      const enabled = available.filter((m) => m.entry.enabled !== false);
      if (enabled.length > 0) {
        // Pick cheapest by output cost per 1M tokens
        enabled.sort(
          (a, b) =>
            (a.entry.estimated_cost_per_1m_output ?? Infinity) -
            (b.entry.estimated_cost_per_1m_output ?? Infinity),
        );
        const cheapest = enabled[0]!;
        return cheapest.entry.model_id;
      }
    } catch {
      /* policy unavailable — use hardcoded fallback */
    }
    return 'deepseek-v4-flash';
  }

  /**
   * Execute a runner call with a per-turn deadline. If the deadline expires,
   * the shared AbortController is signalled so the HTTP fetch is cancelled
   * and the Promise.race rejects with a descriptive error.
   */
  private async executeWithTimeout(
    runner: DeepInfraApiRunner | DeepSeekApiRunner,
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

  private resolveFallbackRunner(): DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | null {
    if (!this.options.fallbackModel) return null;
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
    if (useNativeTools && typeof runner.executeWithToolsStream === 'function') {
      const restrictTools = this.restrictToolsNextTurn;
      this.restrictToolsNextTurn = false;
      const toolDefs = restrictTools
        ? buildRestrictedChatToolDefinitions(resolveRestrictedToolMode(this.hasAnyWrites()))
        : buildChatToolDefinitions();
      const nativeActions: ChatToolAction[] = [];
      let answerText = '';
      const systemPrompt = this.getOrBuildSystemPrompt('native');

      for await (const event of runner.executeWithToolsStream(
        Array.isArray(promptOrMessages) ? promptOrMessages : [{ role: 'user', content: promptOrMessages }] as ProviderMessage[],
        toolDefs,
        systemPrompt,
        this.abortController.signal,
        restrictTools ? 'required' : 'auto',
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
            // finishReason captured for debugging; usage is tracked via
            // getLastInvocationMetadata() called by trackRunnerUsage below
            break;
          default: {
            const _exhaustive: never = event;
            throw new Error(`Unknown stream event: ${(_exhaustive as any).type}`);
          }
        }
      }
      this.trackRunnerUsage(runner);
      return nativeActions.length > 0
        ? { type: 'tool_calls', actions: nativeActions }
        : { type: 'completion', answer: answerText || 'OK' };
    }

    // ── Text-tools path — simplified format for small local models ──────────
    if (this.shouldUseTextTools()) {
      const systemPrompt = this.getOrBuildSystemPrompt('text');
      const rawText = await this.executeWithTimeout(runner, promptOrMessages as string, undefined, systemPrompt);
      const turn = parseTextToolTurn(rawText);
      this.trackRunnerUsage(runner);
      return turn;
    }

    let streamedChunks = '';
    let looksLikeJson = false;
    const deliberationCallbacks =
      callbacks.onThought || callbacks.onAnswerChunk
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
              ? { onThought: (thought: string) => callbacks.onThought?.(thought) }
              : {}),
          }
        : undefined;

    const rawText = await this.executeWithTimeout(runner, promptOrMessages as string, deliberationCallbacks);
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
  ): AsyncGenerator<ChatEvent, DeepInfraApiRunner | DeepSeekApiRunner | null, undefined> {
    if (turn > 0) {
      yield this.streamFailed(err.message);
      return null;
    }
    // P1-E: runtime Pro → Flash failover with visible reason (not verification)
    const modelId = this.options.model ?? 'deepseek-v4-pro';
    const decision = parityTryFailover(this.parity, modelId, err);
    let fb = this.resolveFallbackRunner();
    if (!fb && decision) {
      fb = new DeepSeekApiRunner(decision.toModel);
      this.fallbackRunner = fb;
      this.policyEventLog.record({
        at_turn: this._turnIndex,
        kind: 'failover',
        detail: decision.reason,
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
      text: decision
        ? `[Failover] ${decision.reason}`
        : 'Retrying with fallback model…',
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
    let systemContent = buildChatSystemPrompt({
      projectRoot: this.options.projectRoot,
      nativeTools,
      textTools,
      executionFirst: true,
      ...(systemCtx ? { systemContext: systemCtx } : {}),
    });

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

  private applyTamperEscalation(): string | null { return applyTamperEscalationFn({ tamperedThisTurn: this.tamperedThisTurn, tamperCount: this.tamperCount }, this.stallState); }

  private buildVerifierBlockedReport(reason: string): BlockedReport {
    return {
      schema_version: 1,
      status: 'BLOCKED',
      reason,
      missing: 'Verifier could not be satisfied after multiple attempts.',
      checked: [],
    };
  }

  private hashContent(content: string): string { return hashContentFn(content); }

  private async hashFilePath(filePath: string): Promise<string> {
    try {
      const resolved = resolveProjectPath(this.options.projectRoot, filePath);
      const s = await stat(resolved);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return '';
    }
  }

  /** B4: Resolve runner with phase-aware model routing.
   *  Model-name resolution extracted to phaseModelRouting.ts for testability. */
  private resolveRoutedRunner(): DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner {
    const modelName = resolvePhaseModelName(this._lastPhase, {
      investigateModel: this.limits.investigateModel,
      mutateModel: this.limits.mutateModel,
    });
    if (!modelName) return this.resolveDeliberationRunner();
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

  private detectAndBuildBlockedReport(answer: string): BlockedReport | null { return detectBlockedReportFromAnswer(answer, this.toolCallLog); }

  private buildResult(
    status: ChatResult['status'],
    callbacks: ChatCallbacks,
    answer?: string,
    blockedReport?: BlockedReport | null,
  ): ChatResult {
    // R1: If the answer explicitly declares BLOCKED but no blockedReport was
    // provided (e.g., the detection ran in a code path that didn't provide it),
    // promote the status to 'blocked' and generate the report here.
    const hasBlocked = !!(answer && /\bBLOCKED\b/.test(answer));
    const finalStatus = (status === 'completed' || status === 'failed') && hasBlocked
      ? 'blocked' as const
      : status;
    const finalBlockedReport = (finalStatus === 'blocked' && !blockedReport)
      ? this.detectAndBuildBlockedReport(answer ?? '')
      : blockedReport;

    if (this.cachedSystemPromptNative) stashEngineFingerprint(this.engineRunId, buildPromptFingerprint({ systemPrompt: this.cachedSystemPromptNative, taskClass: this.taskClass, tune: getChatTaskTune(this.taskClass), playbookId: this.activePlaybook?.id ?? null }));

    // P0-D: Compute truthful TerminalOutcome from status and runtime state.
    const outcome: TerminalOutcome = computeTerminalOutcome({
      finalStatus,
      budgetExceeded: this.budgetExceeded,
      lastVerifierReceipt: this.lastVerifierReceipt,
      blockedReport: finalBlockedReport,
    });
    // AC3 choke point: memory + disk (idempotent if streamDone already finalized)
    finalizeParityTurnSync(this.parity, this.engineRunDir, outcome, finalStatus);

    const result: ChatResult = {
      status: finalStatus,
      outcome,
      answer: answer ?? '',
      usage: globalCostTracker.getSessionSummary(),
      conversation: this.conversation,
      runDir: this.engineRunDir,
      verifierReceipt: this.lastVerifierReceipt,
      dedupeHitCount: this.dedupeHitCount,
      ...(this.verifierTampered ? { verifierTampered: true as const } : {}),
      ...(finalBlockedReport ? { blockedReport: finalBlockedReport } : {}),
      ...(this.lastCriticReceipt ? { criticReceipt: this.lastCriticReceipt } : {}),
      ...(this.budgetExceeded ? { budgetExceeded: true as const } : {}),
      ...(this.gatePolicy ? { gatePolicy: this.gatePolicy } : {}),
      ...observabilityResultFields(this.obsHandles()),
    };

    // Batch 1 #1: Persist conversation transcript to disk for session resume.
    // Write is fire-and-forget — failure must not block the turn result.
    persistTranscriptToDisk(this.engineRunDir, result.conversation).catch(() => {});

    // Tier A2: Persist policy event log alongside transcript
    persistPolicyEventsJsonl(this.engineRunDir, this.policyEventLog).catch(() => {});
    // Event log disk flush is owned solely by finalizeParityTurn / checkpointParityEventLog

    // T3.2: Propose BABEL.md learnings after successful runs with writes only.
    if (finalStatus === 'completed' && this.writeCount > 0) {
      try {
        const changed = this.toolCallLog
          .filter((t) => isSuccessfulDirectMutation(t.tool, t.error) && t.target)
          .map((t) => t.target)
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
      } catch { /* write-back must never fail the turn */ }
    }

    return result;
  }

  public resetCompactionCircuitBreaker(): void {
    this.compactionConsecutiveFailures = 0;
  }
}
