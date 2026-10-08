import type { FailureCapsuleV1 } from './taskContract.js'
import type {
  RecoveryCandidateBinding,
  ReadInjectionCache,
} from './codingLoop/index.js'
import type { LiveSessionV1 } from './liveSession.js'
import type { IsolationBrokerFlags } from './chatEngineIsolationFlags.js'
import type { ChatToolAction, ChatTurn } from './chatToolDefinitions.js'
import type { DeepSeekApiRunner } from '../runners/deepSeekApi.js'
import type { OllamaApiRunner } from '../runners/ollamaApi.js'
import type { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import type { ProviderMessage, RunnerCallbacks } from '../runners/base.js'
import type { ChatRunLimiter } from '../config/chatEngineLimits.js'
import type { ChatTaskClass, RequestedTaskOperation } from '../config/chatTaskClass.js'
import type { ChatCompiledStack } from './chatStackCompile.js'
import type { WorkingState } from './codingLoop/index.js'
import type { ChatEngineServices } from './chatEngineServices.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import type { ParityRuntime } from './chatEngineParityBridge.js'
import type {
  ContextCheckpointPreparationResultV1,
  LiveOperationalSourcesV1,
} from '../runtime/contextCheckpoints.js'
import type { ContextDeliveryMode } from './contextManifest.js'
import type { ModelRouteStage } from './modelRouteReceipt.js'
import type { ChatUsageScope } from './chatEngineProviderAccounting.js'
import type { StallState, StallIntervention } from './stallDetector.js'
import type { ProgressController } from './progressController.js'
import type { ChatPhase } from './chatPhaseNudge.js'
import type { ChatTurnTelemetryCollector } from './chatTurnTelemetry.js'
import type { ExploreFuseResult } from './chatZeroWritePolicy.js'
import type { PolicyEventLog } from './policyEventLog.js'
import type { TerminalReason } from './chatTerminalReason.js'
import type { ObservabilityHandles } from './chatEngineObservability.js'

import type { RepetitionDetector } from './repetitionDetector.js'
/** Public chat submission, event, and result contracts. */
import type { DeepInfraApiRunner } from '../runners/deepInfraApi.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { SessionUsageSummary } from '../services/costTracker.js'
import type {
  ChatOperatorMode,
  ChatPlanExecuteHandoff,
} from './planExecuteMode.js'
import type {
  BlockedReport,
  TerminalOutcome,
  TerminalReasonCode,
} from '../schemas/agentContracts.js'
import type {
  ChatEngineLimits,
  ChatEngineRunAllowanceReport,
} from '../config/chatEngineLimits.js'
import type { ChatStatus } from './chatFailureClassification.js'
import type { VerificationPolicy } from '../config/chatTaskClass.js'
import type { ChatMessage, ChatRuntimeMode } from './chatToolDefinitions.js'
import type { ChatExecutionProfile } from './chatEngineServices.js'
import type { AdmissionStore } from '../runtime/admission.js'
import type { RuntimeInvariantMode } from './runtimeInvariants.js'
import type { OwnerAccountingFault } from './chatEngineOwnerAccounting.js'
import type { MutationEffectStatus } from './mutationTools.js'
import type { ChatTurnTelemetryRecord } from './chatTurnTelemetry.js'
import type { DiffCriticVerdict } from './diffCritic.js'
import type { PolicyEvent } from './policyEventLog.js'
import type { TurnRoutingReceipt } from './turnRoutingReceipt.js'
import type { PromptFingerprint } from './chatEngineObservability.js'
import type { TurnRuntimeSnapshot } from './turnRuntime.js'

// ─── Types ────────────────────────────────────────────────────────────────

/** Classifies the user's intent for a chat turn.
 *  'execute' = user wants code changes → gate active in headless mode
 *  'explain' = user wants information → gate bypassed */
export type TaskIntent = 'execute' | 'explain'

export type ChatAllowanceCostCap =
  | { kind: 'finite'; usd: number }
  | { kind: 'unlimited' }

export interface ChatAllowanceGrant {
  grantId: string
  provenance: string
  costCapUsd: number
  wallCapMs: number
  turnCap: number
}

export interface ChatTaskAllowanceSnapshot {
  schemaVersion: 2
  taskOwnerId: string
  accountingEpoch: string
  grant: {
    grantId: string
    /** Monotonic revision within this task owner; older grants cannot overwrite renewal. */
    revision?: number
    provenance: string
    costCap: ChatAllowanceCostCap
    wallCapMs: number
    turnCap: number
  }
  consumed: {
    costUsd: number
    unknownChargeCount?: number
    activeWallMs: number
    turns: number
  }
  repair: {
    criticRepairCostCapUsd: number | null
    postWriteRepairWallCapMs: number | null
    postWriteRepairRestrict: boolean
  }
  accountedChargeIds: string[]
  /** Go reservation ownership was checkpointed; resume must not create missing state. */
  goReservationRequired?: boolean
  activeExecution: boolean
  taskCostBaselineUsd: number
  /** Owner-scoped faults mirrored when an owner-receipt write fails. */
  accountingFaults?: OwnerAccountingFault[]
  lastTurnRuntime?: TurnRuntimeSnapshot
}

/** Options for a single user submission (W0.3 TurnRuntime). */
export interface SubmitMessageOptions {
  /**
   * Explicit continuation linkage: preserve write/gate counters from the
   * prior submission. Default false — isolate so prior writes cannot satisfy
   * a new task's completion gate.
   */
  continueTask?: boolean
  /**
   * Internal: the submission generation already assigned by the caller
   * (`submitMessage`). The stream body adopts it instead of incrementing so
   * the non-streaming presentation guards and the ownership guards agree on
   * one generation. Not part of the public contract.
   */
  submissionGeneration?: number
}

/**
 * P05: this engine's admitted command claim. `settled` flips at command
 * settlement (terminal stream, cancellation, replacement, or session close);
 * a live (unsettled) claim matching the durable owner row is the ONLY
 * authority under which this engine may install a P11 checkpoint.
 */

export interface ChatEngineOptions {
  /** Caller-selected intent only; never grants effects or bypasses admission. */
  operation?: RequestedTaskOperation
  /** Exact repository context selected by preparation; compiled locally when omitted. */
  compiledChatStack?: ChatCompiledStack
  instructionRoot?: string
  /** Trusted embedding seam: pins all inference phases to one observed runner. */
  providerRunner?: DeepInfraApiRunner
  /** Immutable policy for a trusted embedded provider, never model-supplied. */
  providerPolicy?: ResolvedModelPolicy
  task: string
  projectRoot: string
  runId?: string
  /** Existing P05 durable owner/fencing authority supplied by the host. */
  admissionStore?: AdmissionStore
  resumeExisting?: boolean
  systemContext?: string
  /** Appended system prompt fragments (plugins, skills, project memory).
   *  Injected after the base system prompt for layered context assembly. */
  appendSystemPrompt?: string
  /** Pre-flight context injected into the system prompt (git state, session info, etc.).
   *  Gathered once per engine session and appended after appendSystemPrompt. */
  preflightContext?: string
  model?: string
  modelTier?: string
  provider?: string
  maxTurns?: number
  maxConversationMessages?: number
  maxEstimatedTokens?: number
  /** R11: Per-round token ceiling — a single turn exceeding this with zero
   *  tool calls is force-BLOCKED. Default 200_000. */
  maxTokensPerRound?: number
  /** Explicit wall-budget request. Still clamped by the resolver's ceiling
   *  (one hour, or LONG_TASK ceiling when BABEL_CHAT_LONG_TASK is authorized);
   *  requested vs effective stays observable via limits.wallBudget. */
  maxWallMs?: number
  /** Explicit cost-budget request. Marks costBudget.explicitCostCeiling. */
  maxCostUsd?: number
  allowExpensive?: boolean
  workspaceRoot?: string | null
  fallbackModel?: string
  /** C1: Structured intent plan user message injected at session start
   *  for execute tasks when the intent compiler is enabled. */
  intentPlanUserMessage?: string
  /**
   * Implementor W1.3: hard plan mode — block all mutations until /execute-plan.
   * Also implied by operatorMode === 'hard_plan'.
   */
  hardPlanMode?: boolean
  /** Implementor W1.4 operator policy (orthogonal to chat/plan/deep ValidMode). */
  operatorMode?: import('./planExecuteMode.js').ChatOperatorMode
  /** Implementor W1.3: plan→execute handoff injected at first user turn. */
  planHandoff?: import('./planExecuteMode.js').ChatPlanExecuteHandoff
  /** Shared kernel profile. Plan is read-only; deep retains governed writes. */
  executionProfile?: ChatExecutionProfile
  /** Externally supplied required verifier commands for completion gate scope. */
  requiredVerifierCommands?: readonly string[] | null
  /** C1/B7 rollout: enforce in development/CI, shadow in production by default. */
  runtimeInvariantMode?: RuntimeInvariantMode
  /** Test-only: explicit live workspace revision hash for gate freshness tests. */
  testWorkspaceRevisionHash?: string | null
  /**
   * Test-only: deterministic overrides threaded into the child sub-agent
   * lanes so lifecycle races can be driven through the real child
   * dispatch/completion/application seam without a live provider. Production
   * callers never set this.
   */
  testChildLaneOverrides?: {
    useDeterministicMock?: boolean
    actionResolver?: (
      prompt: string,
      round: number,
    ) => Promise<import('./actions.js').AgentAction[]>
    executor?: import('./toolExecutor.js').ToolExecutor
  }
  /** Truthful delivery surface for the model-visible runtime metadata. */
  runtimeMode?: ChatRuntimeMode
}

/** Shared TUI/headless/direct preparation applied to a live or reused engine. */
export interface ChatEngineTurnPreparation {
  task: string
  operation?: RequestedTaskOperation | undefined
  compiledChatStack?: ChatCompiledStack | undefined
  projectRoot?: string | undefined
  instructionRoot?: string | undefined
  systemContext?: string | undefined
  appendSystemPrompt?: string | undefined
  preflightContext?: string | undefined
  model?: string | undefined
  intentPlanUserMessage?: string | undefined
  limits?: ChatEngineLimits
  executionProfile?: ChatExecutionProfile
  runtimeMode?: ChatRuntimeMode
}

export interface ContextCompactedInfo {
  mode: 'llm' | 'heuristic'
  beforeMessages: number
  afterMessages: number
  message: string
}

export interface ChatCallbacks {
  onAnswerChunk?: (chunk: string) => void
  onToolStart?: (tool: string, target: string) => number
  onToolComplete?: (
    id: number,
    detail?: string,
    error?: string,
    exitCode?: number,
  ) => void
  onFileChanged?: (
    path: string,
    additions: number,
    deletions: number,
    content?: string,
  ) => void
  onThought?: (thought: string) => void
  /**
   * A new model generation is starting (engine 'thinking' event). Consumers
   * must commit any in-flight streamed answer instead of concatenating onto
   * it — keeps streaming and non-streaming presentation semantically equal.
   */
  onGenerationBoundary?: () => void
  onContextCompacted?: (info: ContextCompactedInfo) => void
  onSubAgentStart?: (info: {
    id: string
    label: string
    model?: string
  }) => void
  onSubAgentComplete?: (info: {
    id: string
    summary: string
    tokens?: number
  }) => void
  onSubAgentFailed?: (info: { id: string; error: string }) => void
}

// ─── #5 Typed streaming events ───────────────────────────────────────────

/** Events yielded by executeRawStream() — the runner layer. */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
    }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string }

/** Events yielded by submitMessageStream() — the ChatEngine layer. */
export type ChatEvent =
  | { type: 'thinking' }
  | { type: 'answer_chunk'; text: string }
  | { type: 'tool_start'; toolCallId?: string; tool: string; target: string }
  | {
      type: 'tool_complete'
      toolCallId?: string
      tool: string
      target: string
      detail?: string
      error?: string
      exitCode?: number
      effect_status?: MutationEffectStatus
      mutation_paths?: string[]
    }
  | {
      type: 'tool_failed'
      toolCallId?: string
      tool: string
      target: string
      detail?: string
      error?: string
      exitCode?: number
      effect_status?: MutationEffectStatus
      mutation_paths?: string[]
    }
  | { type: 'thought'; text: string }
  | {
      type: 'context_compacted'
      mode: 'llm' | 'heuristic'
      beforeMessages: number
      afterMessages: number
      message: string
    }
  | { type: 'sub_agent_start'; id: string; label: string; model?: string }
  | { type: 'sub_agent_complete'; id: string; summary: string; tokens?: number }
  | { type: 'sub_agent_failed'; id: string; error: string }
  | {
      type: 'file_changed'
      path: string
      additions: number
      deletions: number
      content?: string
    }
  | {
      type: 'done'
      answer: string
      usage: SessionUsageSummary
      /** Canonical legacy status derived from outcome when known. */
      status?: ChatStatus
      /** Authoritative terminal outcome from the engine (P0-D lossless). */
      outcome?: TerminalOutcome
      planOutcome?: 'PLAN_COMPLETE'
      budgetExceeded?: boolean
      toolCalls?: Array<{
        toolCallId?: string
        tool: string
        target: string
        detail?: string
        error?: string
        effect_status?: MutationEffectStatus
        mutation_paths?: string[]
      }>
      runDir?: string
      verifierReceipt?: {
        command: string
        exit_code: number
        summary: string
      } | null
      blockedReport?: BlockedReport | null
      /** R9: Whether the agent modified a verifier dependency file. */
      verifierTampered?: boolean
      /** Idea 14: asymmetric diff critic receipt. */
      criticReceipt?: DiffCriticVerdict | null
      policyEvents?: PolicyEvent[]
      turnRouting?: TurnRoutingReceipt[]
      observationTails?: Array<{
        tool: string
        target: string
        exit_code?: number
        tail: string
      }>
      blockedAttempts?: import('./blockedAttemptLedger.js').BlockedAttempt[]
      turnTelemetry?: ChatTurnTelemetryRecord
      costBudget?: ChatEngineLimits['costBudget']
      runAllowance?: ChatEngineRunAllowanceReport
      /** D03: structured terminal reason code (additive; outcome unchanged). */
      reason_code?: TerminalReasonCode
      cause_class?:
        | 'model'
        | 'provider'
        | 'environment'
        | 'harness'
        | 'verification'
        | null
    }
  | {
      type: 'failed'
      error: string
      status?: ChatStatus
      /** Present when tools ran before failure (turn-limit / stall kill / etc.). */
      toolCalls?: Array<{
        toolCallId?: string
        tool: string
        target: string
        detail?: string
        error?: string
        effect_status?: MutationEffectStatus
        mutation_paths?: string[]
      }>
      runDir?: string
      /** Preserve INFRA_FAILURE vs AGENT_FAILURE when the engine already classified. */
      outcome?: import('../schemas/agentContracts.js').TerminalOutcome
      turnTelemetry?: ChatTurnTelemetryRecord
      costBudget?: ChatEngineLimits['costBudget']
      runAllowance?: ChatEngineRunAllowanceReport
      /** D03: structured terminal reason code. */
      reason_code?: TerminalReasonCode
      cause_class?:
        | 'model'
        | 'provider'
        | 'environment'
        | 'harness'
        | 'verification'
        | null
    }
  | {
      type: 'cancelled'
      status?: ChatStatus
      outcome?: 'CANCELLED'
      turnTelemetry?: ChatTurnTelemetryRecord
      /** D03: cancelled is a structured terminal reason too. */
      reason_code?: TerminalReasonCode
      cause_class?:
        | 'model'
        | 'provider'
        | 'environment'
        | 'harness'
        | 'verification'
        | null
    }
  | {
      type: 'progress_recovery'
      intervention: import('./progressController.js').ProgressInterventionLevel
      source: string
      score: number
      message?: string
    }

export interface ChatResult {
  status: ChatStatus
  /** Honest terminal outcome — semantically precise, never conflated.
   *  Optional for backward compatibility with test fixtures that omit it. */
  outcome?: TerminalOutcome
  /** Separate plan-mode completion result; never an executor terminal. */
  planOutcome?: 'PLAN_COMPLETE'
  answer: string
  usage: SessionUsageSummary
  conversation: ChatMessage[]
  toolCalls?: Array<{
    toolCallId?: string
    tool: string
    target: string
    detail?: string
    error?: string
    effect_status?: MutationEffectStatus
    mutation_paths?: string[]
  }>
  runDir?: string
  verifierReceipt?: {
    command: string
    exit_code: number
    summary: string
  } | null
  blockedReport?: BlockedReport | null
  dedupeHitCount?: number
  verifierTampered?: boolean
  criticReceipt?: DiffCriticVerdict | null
  budgetExceeded?: boolean
  gatePolicy?: VerificationPolicy
  /** Tier A2: Policy events emitted during the session. */
  policyEvents?: PolicyEvent[]
  /** Tier A3: Per-turn routing receipts. */
  turnRouting?: TurnRoutingReceipt[]
  /** Tier A5: Last-N tool observation tails. */
  observationTails?: Array<{
    tool: string
    target: string
    exit_code?: number
    tail: string
  }>
  /** Tier A1: Aggregate counts derived from the tool call log. */
  toolCallAggregates?: {
    tool_call_count: number
    write_count: number
    verifier_attempt_count: number
  }
  promptFingerprint?: PromptFingerprint
  /** Active input prompt tokens from latest single model invocation */
  lastRequestPromptTokens?: number | null
  /** Active completion output tokens from latest single model invocation */
  lastRequestCompletionTokens?: number | null
  /** Structured active context telemetry from latest provider invocation */
  activeContext?: {
    tokens: number
    modelId: string
    source: 'provider_prompt_tokens' | 'estimated' | 'unknown'
  } | null
  turnTelemetry?: ChatTurnTelemetryRecord
  /** Enumerable cost-budget provenance — survives JSON / spreads / manifests. */
  costBudget?: ChatEngineLimits['costBudget']
  /** Enumerable declared vs effective run allowance + terminating limiter. */
  runAllowance?: ChatEngineRunAllowanceReport
  /** D03: structured terminal reason code; survives engine → payload → clients. */
  reason_code?: TerminalReasonCode
  /** D03: separate model-vs-harness cause axis; null = not established. */
  cause_class?:
    | 'model'
    | 'provider'
    | 'environment'
    | 'harness'
    | 'verification'
    | null
}

export interface ChatEngineStreamingLoopHost {
  _activeToolBatchId: string | null
  _cancelled: boolean
  _hadToolCallsThisTurn: boolean
  _lastPhase: ChatPhase | null
  _sessionStartTime: number
  _streamNativeToolCallIds: string[]
  _turnIndex: number
  _turnToolCallLogStart: number
  readonly abortController: AbortController
  activeSubmissionGeneration: number
  readonly apiTokenCount: number
  apiTokenCountAtTurnStart: number
  readonly applyCriticRepairCostBudget: () => void
  readonly applyExploreFuses: (
    executeIntent: boolean,
    readOnlyOperation: boolean,
  ) => ExploreFuseResult
  readonly applyPostWriteRepairBudget: () => void
  readonly applyTamperEscalation: () => string | null
  readonly applyUserSubmission: (input: {
    userInput: string
    taskIntent?: TaskIntent
    continueTask?: boolean
  }) => TurnRuntimeSnapshot
  readonly assertNativeRequestMatchesDurable: (
    outbound: readonly ProviderMessage[],
    systemPrompt: string,
    systemPromptOverride: string | undefined,
  ) => void
  readonly beginActiveExecution: () => void
  readonly buildCriticBlockedAnswer: (report: BlockedReport) => string
  readonly buildCriticBlockedReport: (
    verdict: DiffCriticVerdict,
  ) => BlockedReport
  readonly buildGateRejectUserMessage: () => string
  readonly buildRejectionMessage: () => string
  readonly buildTamperBlockedReport: () => BlockedReport
  readonly buildTextToolResults: (startIndex: number) => string
  readonly buildVerifierBlockedReport: (reason: string) => BlockedReport
  readonly checkBudgets: (skipTurnLimit?: boolean) => {
    ok: boolean
    reason?: string
    limiter?: ChatRunLimiter
  }
  readonly checkPerRoundTokenCeiling: (hadToolCalls: boolean) => string | null
  readonly checkStallIntervention: (
    isReadOnlyInspection: boolean,
  ) => StallIntervention | null
  readonly compactIfNeeded: (
    callbacks?: ChatCallbacks,
    forceCompaction?: boolean,
    ownerGeneration?: number,
  ) => Promise<ContextCompactedInfo | null>
  readonly computeVerifierChanged: (
    results: ReadonlyArray<{
      tool_name: string
      content?: string
      exit_code?: number
    }>,
  ) => boolean
  consecutiveNonMutatingShells: number
  consecutiveReadOnlyTools: number
  readonly consumeTaskTurn: () => void
  conversation: ChatMessage[]
  readonly criticRepairCostCapUsd: number | null
  criticStrikes: number
  readonly currentTurnHasMutation: () => boolean
  currentTurnTelemetry: ChatTurnTelemetryCollector | null
  readonly detectAndBuildBlockedReport: (answer: string) => BlockedReport | null
  readonly emitCancelledIfOperatorAbort: (err?: unknown) => ChatEvent | null
  readonly engineRunDir: string
  readonly evaluateCompletionGate: (
    turnResult: ChatTurn,
    taskIntent: TaskIntent,
  ) => 'allow' | 'reject'
  readonly executeActions: (
    actions: ChatToolAction[],
    callbacks: ChatCallbacks,
    ownerGeneration?: number,
  ) => Promise<{
    observations: string
    observationList: string[]
    count: number
  }>
  gatePolicy: VerificationPolicy | null
  gateStrikes: number
  readonly generateRepoMap: () => Promise<string>
  generationCounter: number
  readonly getOrBuildSystemPrompt: (
    mode?: 'native' | 'legacy' | 'text',
  ) => string
  readonly getResolvedRequiredVerifiers: () => string[]
  readonly isolationBrokerFlags: () => ReturnType<typeof import('./chatEngineIsolationFlags.js').resolveIsolationBrokerFlags>
  readonly handleBudgetKill: (
    reason: string,
    callbacks: ChatCallbacks,
    taskIntent: TaskIntent,
    ownerGeneration?: number,
  ) => Promise<ChatResult | null>
  readonly hasAnyWrites: () => boolean
  readonly hasPendingCompactionAuthority: () => boolean
  readonly installP11ContextCheckpoint: (
    routeOverride?: NonNullable<LiveOperationalSourcesV1['route']>,
  ) => Promise<boolean>
  /** Structured diagnostic from the most recent refused P11 install (codes only). */
  p11InstallBlock: { code: string; details: string[] } | null
  investigateSoftNudgeDone: boolean
  readonly isSubmissionCurrent: (ownerGeneration: number) => boolean
  readonly lastCriticReceipt: DiffCriticVerdict | null
  lastRequestCompletionTokens: number | null
  lastRequestModelId: string | null
  lastRequestPromptTokens: number | null
  readonly lastVerifierReceipt: BoundChatVerifierReceipt | null
  readonly limits: ChatEngineLimits
  readonly logicalTurnToolPolicy: import('./codingLoop/index.js').OneShotPolicySnapshot<
    import('./codingLoop/index.js').NextTurnToolPolicy
  >
  readonly maybeInjectMidLoopHeuristicCritic: (
    callbacks: ChatCallbacks,
    taskIntent: TaskIntent,
  ) => void
  midLoopCriticFired: boolean
  readonly modelPolicy: ResolvedModelPolicy | undefined
  readonly nextTurnToolPolicy: () => import('./codingLoop/index.js').NextTurnToolPolicy
  readonly obsHandles: () => ObservabilityHandles
  readonly options: ChatEngineOptions
  readonly parity: ParityRuntime
  readonly parseChatTurnLenient: (rawText: string) => ChatTurn
  readonly planHandoff: ChatPlanExecuteHandoff | null
  readonly policyEventLog: PolicyEventLog
  readonly prepareP11ContextCheckpointCandidate: (route: {
    tool_profile: string
    model_route: string
  }) => ContextCheckpointPreparationResultV1 | null
  preparedAdmissionCompactionAttempts: number
  readonly progressController: ProgressController
  readonly providerRetryCallbacks: (context?: {
    deliveryMode?: ContextDeliveryMode
    conversationState?: unknown
    systemPolicyPrompt?: unknown
    userTaskPrompt?: unknown
    toolSchema?: unknown
    promptInputTokenCount?: number | null
    contextTruncated?: boolean | null
    expectedPriorEventIds?: readonly string[]
    deliveredPriorEventIds?: readonly string[]
    executionStage?: ModelRouteStage
    contractRef?: string
    substitutionOrFallback?: boolean
    isOwnerCurrent?: () => boolean
    usageScope?: ChatUsageScope
  }) => RunnerCallbacks
  readonly readContextEpoch: number
  readonly recoverPreparedRequestAdmission: (
    error: unknown,
    ownerGeneration?: number,
  ) => Promise<ContextCompactedInfo | null>
  readonly repetitionDetector: RepetitionDetector
  repoMapCache: string | null
  readonly resolveDeliberationRunner: () =>
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
  readonly resolveFallbackOrFail: (
    err: any,
    turn: number,
    ownerGeneration?: number,
  ) => AsyncGenerator<
    ChatEvent,
    DeepInfraApiRunner | DeepSeekApiRunner | OpenRouterApiRunner | null,
    undefined
  >
  readonly resolveRoutedRunner: () =>
    | DeepInfraApiRunner
    | DeepSeekApiRunner
    | OllamaApiRunner
    | OpenRouterApiRunner
  restrictToolsNextTurn: boolean
  readonly runAsymmetricDiffCritic: (
    answer: string,
    callbacks: ChatCallbacks,
    taskIntent: TaskIntent,
    opts?: { terminal?: boolean },
  ) => Promise<'allow' | 'reject' | 'block'>
  readonly services: ChatEngineServices
  readonly shouldUseNativeTools: (
    runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner,
  ) => boolean
  readonly shouldUseTextTools: () => boolean
  stallState: StallState
  readonly streamCancelled: () => ChatEvent
  readonly streamDone: (
    answer: string,
    extra?: {
      blockedReport?: BlockedReport | null
      verifierTampered?: boolean
      criticReceipt?: DiffCriticVerdict | null
      reason?: TerminalReason
    },
  ) => ChatEvent
  readonly streamFailed: (error: string) => ChatEvent
  readonly synthesizeAnswer: (
    toolObservations: string,
    callbacks: ChatCallbacks,
  ) => Promise<string>
  readonly tamperCount: number
  tamperedThisTurn: boolean
  readonly taskAllowance: ChatTaskAllowanceSnapshot | null
  readonly taskClass: ChatTaskClass
  terminalLimiterReason: string | null
  terminatingLimiter: ChatRunLimiter | null
  readonly toolCallLog: {
    toolCallId?: string
    tool: string
    target: string
    detail?: string
    error?: string
    index: number
    exit_code?: number
    stdout?: string
    stderr?: string
    verified?: boolean
    mutation_paths?: string[]
    effect_status?: MutationEffectStatus
  }[]
  toolsWithoutWrite: number
  readonly trackRunnerUsage: (
    runner:
      | DeepInfraApiRunner
      | DeepSeekApiRunner
      | OllamaApiRunner
      | OpenRouterApiRunner,
    usageScope?: ChatUsageScope,
  ) => void
  turnsWithoutWrite: number
  readonly updateTodoSystemMessage: () => void
  readonly verifierTampered: boolean
  workingState: WorkingState
}

// ─── ChatEngine ───────────────────────────────────────────────────────────

/** @internal Host port for single-action execution lifecycle. */
export interface ChatEngineActionExecutorHost {
  _lastPhase: ChatPhase | null
  _streamNativeToolCallIds: string[]
  _turnIndex: number
  activeSubmissionGeneration: number
  beginRecoveryLocalizationInspection: (
    tool: string,
    rawTarget: string,
  ) => boolean
  checkVerifierTamper: (filePath: string) => string | null
  consumeFailureBudget: (failure: FailureCapsuleV1) => boolean
  currentRecoveryBinding: () => RecoveryCandidateBinding | null
  currentTurnTelemetry: ChatTurnTelemetryCollector | null
  dedupeHitCount: number
  engineRunDir: string
  engineRunId: string
  executedVerifierLedger: BoundChatVerifierReceipt[]
  executionProfile: ChatExecutionProfile
  finishRecoveryLocalizationInspection: (input: {
    tool: string
    rawTarget: string
    content?: string
    succeeded: boolean
    startLine?: number
    pattern?: string
  }) => void
  fullReadCounts: Map<string, number>
  getTurnRuntimeSnapshot: () => TurnRuntimeSnapshot | null
  getResolvedRequiredVerifiers: () => string[]
  getLiveSession: (
    c?:
      | {
          turns?: number
          tokens?: number
          repair_attempts?: number
          infra_retries?: number
        }
      | undefined,
  ) => LiveSessionV1
  hardPlanMode: boolean
  hashContent: (content: string) => string
  hashFilePath: (filePath: string) => Promise<string>
  isSubmissionCurrent: (ownerGeneration: number) => boolean
  isolationBrokerFlags: () => IsolationBrokerFlags
  lastVerifierFailed: boolean
  lastVerifierReceipt: BoundChatVerifierReceipt | null
  noteToolForReadThrash: (
    tool: string,
    opts?: { error?: string; detail?: string } | undefined,
  ) => void
  options: ChatEngineOptions
  parity: ParityRuntime
  patchRecoveryPath: string | null
  persistRecoveryWorkingState: () => void
  persistToolStartedAtExecutorDispatch: (
    action: ChatToolAction,
    meta: { index: number; idempotencyKey?: string },
  ) => void
  platformUnusableVerifiers: Set<string>
  policyEventLog: PolicyEventLog
  progressController: ProgressController
  readCache: ReadInjectionCache
  readCacheKey: (filePath: string) => string
  readContextEpoch: number
  recoveredOperationDispatchAuthorization: (action: ChatToolAction) => {
    allowed: boolean
    message?: string
  }
  recoveryStatePersistenceUnavailable: boolean
  requireTodoBeforeMutate: boolean
  runPostEditStaticCheck: (filePath: string) => Promise<string | null>
  settleStaleActionResult: (
    tool: string,
    target: string,
    index: number,
    reason: string,
  ) => { index: number; observation: string }
  taskClass: ChatTaskClass
  todos: Map<string, { content: string; status: string }>
  toolCallLog: {
    toolCallId?: string
    tool: string
    target: string
    detail?: string
    error?: string
    index: number
    exit_code?: number
    stdout?: string
    stderr?: string
    verified?: boolean
    mutation_paths?: string[]
    effect_status?: MutationEffectStatus
  }[]
  verifierReceiptCache: Map<
    string,
    {
      receipt: BoundChatVerifierReceipt
      writeCountAtCache: number
      /** Physical working directory the cached command ran in (set by capture). */
      cwd?: string
      /** Fingerprint of the execution environment at capture time (set by capture). */
      envKey?: string
    }
  >
  workingState: WorkingState
  writeCount: number
}
