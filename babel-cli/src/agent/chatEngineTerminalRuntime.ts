/** Terminal projection, result assembly, and durable evidence settlement. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BlockedReport,
  TerminalOutcome,
  TerminalReasonCode,
} from '../schemas/agentContracts.js'
import { globalCostTracker } from '../services/costTracker.js'
import { proposeProjectMemoryWriteback } from '../services/projectMemory.js'
import {
  getChatTaskTune,
  type ChatTaskClass,
  type VerificationPolicy,
} from '../config/chatTaskClass.js'
import {
  classifyTerminalLimiter,
  createRunAllowanceReport,
  type ChatEngineLimits,
  type ChatEngineRunAllowanceReport,
  type ChatRunLimiter,
} from '../config/chatEngineLimits.js'
import type {
  ChatCallbacks,
  ChatEngineOptions,
  ChatEvent,
  ChatResult,
} from './chatEngineContracts.js'
import {
  classifyFailureText,
  isProviderOutputLimitText,
  projectChatTerminal,
} from './chatFailureClassification.js'
import {
  applyHonestTaskOutcomeToCompletion,
  type TaskContractV1,
} from './taskContract.js'
import {
  terminalReasonFromClassification,
  terminalReasonFromFailureText,
  terminalReasonFromOutcome,
  terminalReasonFromVerifierFailure,
  type TerminalReason,
} from './chatTerminalReason.js'
import {
  buildPromptFingerprint,
  buildStreamDone,
  buildStreamFailed,
  computeTerminalOutcome,
  observabilityResultFields,
  outcomeFromReasonCode,
  persistPolicyEventsJsonl,
  persistTranscriptToDisk,
  stashEngineFingerprint,
  type ObservabilityHandles,
} from './chatEngineObservability.js'
import { recordPolicyShadowSessionOutcome } from './policyShadow.js'
import { isCodingTaskSuccess } from '../services/codingTaskSuccess.js'
import {
  recordCompletionDecision,
  type SessionEventLog,
} from './sessionEvents.js'
import type { PolicyEventLog } from './policyEventLog.js'
import type {
  ChatTurnTelemetryCollector,
  ChatTurnTelemetryRecord,
} from './chatTurnTelemetry.js'
import type { ChatExecutionProfile } from './chatEngineServices.js'
import type { ExecutorKernel } from '../executor/kernel.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'
import {
  CHILD_READ_DEFAULT_ROUNDS,
  CHILD_MUTATION_DEFAULT_ROUNDS,
} from './childSpec.js'
import { confirmedMutationPaths } from './mutationTools.js'
import { detectAndBuildBlockedReport } from './chatEngineSupport.js'

/** Immutable terminal inputs plus the mutable evidence objects used by existing finalizers. */
export interface ChatTerminalSnapshot {
  context: {
    options: Pick<ChatEngineOptions, 'projectRoot' | 'task' | 'model'>
    executionProfile: ChatExecutionProfile
    taskClass: ChatTaskClass
    engineRunId: string
    engineRunDir: string
    turnIndex: number
    turnId: string | null
    taskContract: TaskContractV1 | undefined
  }
  outcome: {
    hasMutation: boolean
    readOnly: boolean
    budgetExceeded: boolean
    terminatingLimiter: ChatRunLimiter | null
    terminalLimiterReason: string | null
    lastVerifierReceipt: BoundChatVerifierReceipt | null
    gatePolicy: VerificationPolicy | null
    lastCriticReceipt: import('./diffCritic.js').DiffCriticVerdict | null
    verifierTampered: boolean
    writeCount: number
  }
  presentation: {
    conversation: import('./chatToolDefinitions.js').ChatMessage[]
    cachedSystemPromptNative: string | null
    playbookId: string | null
    dedupeHitCount: number
    lastRequestPromptTokens: number | null
    lastRequestCompletionTokens: number | null
    lastRequestModelId: string | null
    currentTurnTelemetry: ChatTurnTelemetryCollector | null
    lastTurnTelemetry: ChatTurnTelemetryRecord | null
  }
  evidence: {
    sessionEvents: SessionEventLog
    policyEventLog: PolicyEventLog
    observability: ObservabilityHandles
  }
  allowance: {
    limits: ChatEngineLimits
    postWriteRepairWallCapMs: number | null
    criticRepairCostCapUsd: number | null
    taskCostBaselineUsd: number
  }
}
/** Terminal mutations stay behind explicit effects owned by the engine. */
export interface ChatTerminalEffects {
  decideCompletion: (
    requested: TerminalOutcome | 'PLAN_COMPLETE',
    hasMutation: boolean,
  ) => ReturnType<ExecutorKernel['completion']['decide']>
  settleActiveExecution: () => void
  finalizeTurn: (
    outcome: TerminalOutcome | undefined,
    status: ChatResult['status'],
    reason: TerminalReason | undefined,
  ) => void
  storeTelemetry: (record: ChatTurnTelemetryRecord | null) => void
  setLimiter: (limiter: ChatRunLimiter, reason: string) => void
  setBudgetExceeded: () => void
  isSubmissionCurrent: (generation: number) => boolean
  currentTaskCostUsd: () => number
  persistTaskCostBaseline: () => void
}
export type ChatTerminalInput = {
  snapshot: ChatTerminalSnapshot
  effects: ChatTerminalEffects
}
export type ChatStreamDoneExtra = {
  blockedReport?: BlockedReport | null
  verifierTampered?: boolean
  criticReceipt?: import('./diffCritic.js').DiffCriticVerdict | null
  reason?: TerminalReason
}

/** Finalize a completed stream through the kernel decision and durable parity owner. */
export function completeChatStream(
  input: ChatTerminalInput,
  answer: string,
  extra?: ChatStreamDoneExtra,
): ChatEvent {
  const { snapshot, effects } = input
  effects.settleActiveExecution()
  const hasMutation = snapshot.outcome.hasMutation
  let requestedOutcome = computeTerminalOutcome({
    readOnly: snapshot.outcome.readOnly,
    finalStatus: extra?.blockedReport
      ? 'blocked'
      : snapshot.outcome.budgetExceeded
        ? 'budget_exhausted'
        : 'completed',
    budgetExceeded: snapshot.outcome.budgetExceeded,
    lastVerifierReceipt: snapshot.outcome.lastVerifierReceipt,
    blockedReport: extra?.blockedReport,
    hasAnyWrites: hasMutation,
  })
  requestedOutcome = applyHonestTaskOutcomeToCompletion({
    contract: snapshot.context.taskContract,
    requestedOutcome,
    hasMutation,
    planMode: snapshot.context.executionProfile === 'plan',
  })
  const planCompletion =
    snapshot.context.executionProfile === 'plan' &&
    !extra?.blockedReport &&
    !snapshot.outcome.budgetExceeded
  const decision = effects.decideCompletion(
    planCompletion ? 'PLAN_COMPLETE' : requestedOutcome,
    hasMutation,
  )
  const decisionOutcome =
    decision.finalOutcome === 'PLAN_COMPLETE'
      ? 'UNVERIFIED_PATCH'
      : decision.finalOutcome
  const terminalReason = resolveChatTerminalReason(
    input,
    decisionOutcome,
    extra?.blockedReport,
    extra?.reason,
  )
  // R0-9: keep the tuple coherent. A read-only hard-cap that resolves a
  // `budget_exhausted` reason must not project `NO_CHANGE_REQUIRED` alongside
  // it. Exception: `verification_failed` legitimately pairs with
  // `UNVERIFIED_PATCH` on the completed path (the patch is recorded but not
  // verified); `outcomeFromReasonCode` carries the failed-path mapping
  // (AGENT_FAILURE), so the gate decision stays authoritative there.
  const reasonOutcome =
    terminalReason?.code && terminalReason.code !== 'verification_failed'
      ? outcomeFromReasonCode(terminalReason.code)
      : undefined
  const outcome = reasonOutcome ?? decisionOutcome
  {
    recordChatCompletionDecisionOnce(input, {
      requestedOutcome: decision.requestedOutcome,
      finalOutcome: outcome,
      allowed: decision.allowed,
      reason: decision.reason,
      evidenceRefs: decision.evidenceRefs,
      policyVersion: decision.policyVersion,
      ...(terminalReason !== undefined
        ? {
            reasonCode: terminalReason.code,
            causeClass: terminalReason.cause_class,
          }
        : {}),
    })
  }
  // P0-E: attach shadow later-succeeded summary before export (idempotent with buildResult).
  // P0-F: wire the derived OutcomeDimensions — the real receipt (its `stale`
  // flag was just refreshed against the live workspace by decideCompletion)
  // and the completion-gate result (the final outcome IS the gate decision).
  recordPolicyShadowSessionOutcome(snapshot.evidence.policyEventLog, {
    atTurn: snapshot.context.turnIndex,
    hasSuccessfulMutation: hasMutation,
    codingTaskPassed: isCodingTaskSuccess({
      terminalOutcome: outcome,
      hasSuccessfulMutation: hasMutation,
      verifierOk: snapshot.outcome.lastVerifierReceipt?.exit_code === 0,
      requireVerifier: false,
      declaredBlocked: Boolean(extra?.blockedReport),
      verifierReceipt: snapshot.outcome.lastVerifierReceipt ?? null,
      contractChecksPass: outcome === 'VERIFIED_COMPLETE' ? true : null,
    }),
    terminalOutcome: outcome,
  })
  // Sync flush before process exit — required for campaign shadow scoreboard.
  persistPolicyEventsJsonl(
    snapshot.context.engineRunDir,
    snapshot.evidence.policyEventLog,
  )
  const terminal = projectChatTerminal({
    outcome,
    status: extra?.blockedReport
      ? 'blocked'
      : snapshot.outcome.budgetExceeded
        ? 'budget_exhausted'
        : 'completed',
  })
  effects.finalizeTurn(terminal.outcome, terminal.status, terminalReason)
  const finalizedTelemetry =
    snapshot.presentation.currentTurnTelemetry?.finalize({
      turnId: String(snapshot.context.turnId ?? snapshot.context.turnIndex),
      taskClass: snapshot.context.taskClass,
      promptTokens: snapshot.presentation.lastRequestPromptTokens,
      completionTokens: snapshot.presentation.lastRequestCompletionTokens,
      cumulativeSessionTokens:
        globalCostTracker.getSessionSummary().totalTokens,
    })
  effects.storeTelemetry(finalizedTelemetry ?? null)
  const runAllowance = assembleChatRunAllowance(input, terminal.status)
  return buildStreamDone(snapshot.evidence.observability, answer, {
    outcome: terminal.outcome!,
    status: terminal.status,
    ...(decision.finalOutcome === 'PLAN_COMPLETE'
      ? { planOutcome: 'PLAN_COMPLETE' as const }
      : {}),
    ...(snapshot.outcome.budgetExceeded
      ? { budgetExceeded: true as const }
      : {}),
    ...(extra ?? {}),
    ...(snapshot.allowance.limits.costBudget
      ? { costBudget: snapshot.allowance.limits.costBudget }
      : {}),
    runAllowance,
    ...(finalizedTelemetry ? { turnTelemetry: finalizedTelemetry } : {}),
    ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
  })
}

/** Project failed streams without inventing unknown terminal causes. */
export function failChatStream(
  input: ChatTerminalInput,
  error: string,
): ChatEvent {
  const { snapshot, effects } = input
  effects.settleActiveExecution()
  const providerOutputLimit = isProviderOutputLimitText(error)
  if (providerOutputLimit && snapshot.outcome.terminatingLimiter == null) {
    snapshot.outcome.terminatingLimiter = 'tokens'
    snapshot.outcome.terminalLimiterReason = error
    effects.setLimiter('tokens', error)
  }
  const limiterOutcome: TerminalOutcome | undefined =
    snapshot.outcome.terminatingLimiter === 'turns' ||
    snapshot.outcome.terminatingLimiter === 'wall' ||
    snapshot.outcome.terminatingLimiter === 'cost' ||
    snapshot.outcome.terminatingLimiter === 'tokens' ||
    snapshot.outcome.terminatingLimiter === 'child_exhaustion'
      ? 'BUDGET_EXHAUSTED'
      : snapshot.outcome.terminatingLimiter === 'stall'
        ? 'BLOCKED_POLICY'
        : undefined
  // Preserve an unknown terminal cause when no classifier or limiter proves
  // one. Durable validation accepts this explicit absence; guessing would
  // make the model-visible outcome less truthful.
  const classifiedOutcome = classifyFailureText(error) ?? limiterOutcome
  const terminalReason =
    terminalReasonFromFailureText(error) ??
    resolveChatTerminalReason(input, classifiedOutcome)
  // R0-9: status/outcome/reason_code/cause_class must form one coherent tuple.
  // The typed reason is the single authority; when it maps to an outcome, that
  // outcome wins over an independent text classifier that may disagree (e.g.
  // an unsupported-operation message that also matches an infra pattern).
  const outcome =
    (terminalReason?.code
      ? outcomeFromReasonCode(terminalReason.code)
      : undefined) ?? classifiedOutcome
  if (outcome === 'BUDGET_EXHAUSTED') {
    snapshot.outcome.budgetExceeded = true
    effects.setBudgetExceeded()
  }
  const terminal = projectChatTerminal({
    ...(outcome !== undefined ? { outcome } : {}),
    status: 'failed',
  })
  const runAllowance = assembleChatRunAllowance(input, terminal.status)
  effects.finalizeTurn(terminal.outcome, terminal.status, terminalReason)
  const finalizedTelemetry =
    snapshot.presentation.currentTurnTelemetry?.finalize({
      turnId: String(snapshot.context.turnId ?? snapshot.context.turnIndex),
      taskClass: snapshot.context.taskClass,
      promptTokens: snapshot.presentation.lastRequestPromptTokens,
      completionTokens: snapshot.presentation.lastRequestCompletionTokens,
      cumulativeSessionTokens:
        globalCostTracker.getSessionSummary().totalTokens,
    })
  effects.storeTelemetry(finalizedTelemetry ?? null)
  return buildStreamFailed(snapshot.evidence.observability, error, {
    ...(outcome !== undefined ? { outcome } : {}),
    status: terminal.status,
    ...(snapshot.allowance.limits.costBudget
      ? { costBudget: snapshot.allowance.limits.costBudget }
      : {}),
    runAllowance,
    ...(finalizedTelemetry ? { turnTelemetry: finalizedTelemetry } : {}),
    ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
  })
}

/** Finalize cancellation telemetry for the current turn. */
export function cancelChatStream(input: ChatTerminalInput): ChatEvent {
  const { snapshot, effects } = input
  effects.settleActiveExecution()
  const finalizedTelemetry =
    snapshot.presentation.currentTurnTelemetry?.finalize({
      turnId: String(snapshot.context.turnId ?? snapshot.context.turnIndex),
      taskClass: snapshot.context.taskClass,
      promptTokens: snapshot.presentation.lastRequestPromptTokens,
      completionTokens: snapshot.presentation.lastRequestCompletionTokens,
      cumulativeSessionTokens:
        globalCostTracker.getSessionSummary().totalTokens,
    })
  effects.storeTelemetry(finalizedTelemetry ?? null)
  return {
    type: 'cancelled',
    status: 'cancelled',
    outcome: 'CANCELLED',
    reason_code: 'cancelled',
    cause_class: null,
    ...(finalizedTelemetry ? { turnTelemetry: finalizedTelemetry } : {}),
  }
}

/** Resolve explicit, evidence-backed, and limiter terminal reasons in their existing order. */
export function resolveChatTerminalReason(
  input: ChatTerminalInput,
  outcome: TerminalOutcome | undefined,
  blockedReport?: BlockedReport | null,
  explicit?: TerminalReason,
): TerminalReason | undefined {
  const { snapshot, effects } = input
  if (explicit) return explicit
  if (blockedReport?.reason_code !== undefined) {
    return {
      code: blockedReport.reason_code,
      cause_class: blockedReport.cause_class ?? null,
    }
  }
  const verificationFailure = resolveChatVerificationFailureReason(
    input,
    outcome,
  )
  if (verificationFailure) return verificationFailure
  return (
    terminalReasonFromClassification(
      snapshot.outcome.terminatingLimiter
        ? classifyTerminalLimiter(
            snapshot.outcome.terminatingLimiter,
            snapshot.outcome.terminalLimiterReason ?? undefined,
          )
        : null,
    ) ?? terminalReasonFromOutcome(outcome)
  )
}

/** Recognize only current authoritative verifier failures. */
export function resolveChatVerificationFailureReason(
  input: ChatTerminalInput,
  outcome: TerminalOutcome | undefined,
): TerminalReason | undefined {
  const { snapshot, effects } = input
  return terminalReasonFromVerifierFailure({
    hasMutation: snapshot.outcome.hasMutation,
    outcome,
    receipt: snapshot.outcome.lastVerifierReceipt,
  })
}

/** Persist one authoritative completion decision per turn. */
export function recordChatCompletionDecisionOnce(
  input: ChatTerminalInput,
  decision: {
    requestedOutcome: string
    finalOutcome: string
    allowed: boolean
    reason: string
    evidenceRefs: string[]
    policyVersion: string
    reasonCode?: TerminalReasonCode
    causeClass?:
      | 'model'
      | 'provider'
      | 'environment'
      | 'harness'
      | 'verification'
      | null
  },
): void {
  const { snapshot, effects } = input
  const turnId = String(snapshot.context.turnId ?? snapshot.context.turnIndex)
  if (
    snapshot.evidence.sessionEvents.events.some(
      (event) =>
        event.kind === 'completion_decision' && event.turn_id === turnId,
    )
  )
    return
  recordCompletionDecision(snapshot.evidence.sessionEvents, turnId, decision)
}

/** Report effective allowance and persist only when this submission owns the task. */
export function assembleChatRunAllowance(
  input: ChatTerminalInput,
  finalStatus: ChatResult['status'],
  persist = true,
): ChatEngineRunAllowanceReport {
  const { snapshot, effects } = input
  const runAllowance = createRunAllowanceReport(snapshot.allowance.limits, {
    postWriteRepairWallCapMs: snapshot.allowance.postWriteRepairWallCapMs,
    criticRepairCostCapUsd: snapshot.allowance.criticRepairCostCapUsd,
    terminatingLimiter: snapshot.outcome.terminatingLimiter,
    terminalClassification: snapshot.outcome.terminatingLimiter
      ? classifyTerminalLimiter(
          snapshot.outcome.terminatingLimiter,
          snapshot.outcome.terminalLimiterReason ?? undefined,
        )
      : finalStatus === 'cancelled'
        ? 'cancelled'
        : null,
    terminalReason: snapshot.outcome.terminalLimiterReason,
    // I3: coarse run-level child defaults; effective rounds are resolved at
    // dispatch (read 4 / mutation 8, clamped 1-20).
    childLimits: {
      maxRounds: CHILD_READ_DEFAULT_ROUNDS,
      readMaxRounds: CHILD_READ_DEFAULT_ROUNDS,
      mutationMaxRounds: CHILD_MUTATION_DEFAULT_ROUNDS,
    },
    taskCostBaselineUsd: snapshot.allowance.taskCostBaselineUsd,
    taskCostSpentUsd: effects.currentTaskCostUsd(),
  })
  if (
    runAllowance.terminatingLimiter === 'none' ||
    runAllowance.terminatingLimiter == null
  ) {
    if (runAllowance.terminalClassification === 'success') {
      runAllowance.terminalClassification = 'no_limit_triggered'
    }
  }
  if (!persist) {
    // R0-8: a superseded caller computes its own (obsolete) report but must
    // not overwrite the live task's run-allowance artifact or cost baseline.
    return runAllowance
  }
  snapshot.allowance.limits.runAllowance = runAllowance
  snapshot.evidence.policyEventLog.record({
    at_turn: snapshot.context.turnIndex,
    kind: 'progress_policy',
    detail: `run_allowance ${JSON.stringify(runAllowance)}`,
  })
  try {
    writeFileSync(
      join(snapshot.context.engineRunDir, 'run-allowance.json'),
      JSON.stringify(runAllowance),
    )
  } catch {
    /* evidence write must not fail the turn */
  }
  effects.persistTaskCostBaseline()
  return runAllowance
}

/** Assemble the callback result while preserving superseded-submission settlement guards. */
export function assembleChatResult(
  input: ChatTerminalInput,
  status: ChatResult['status'],
  callbacks: ChatCallbacks,
  answer?: string,
  blockedReport?: BlockedReport | null,
  knownOutcome?: TerminalOutcome,
  knownReason?: TerminalReason,
  ownerGeneration?: number,
): ChatResult {
  const { snapshot, effects } = input
  // R0-8: a superseded caller must not finalize the task that now owns the
  // engine. It still receives a truthful result for its own (obsolete)
  // submission, but no completion decision, wall settlement or durable turn
  // finalization is applied to the live task.
  const superseded =
    ownerGeneration !== undefined &&
    !effects.isSubmissionCurrent(ownerGeneration)
  // R1: If the answer explicitly declares BLOCKED but no blockedReport was
  // provided (e.g., the detection ran in a code path that didn't provide it),
  // promote the status to 'blocked' and generate the report here.
  // F4: only a protocol-shaped declaration (`BLOCKED` at the start of a line)
  // is even considered, and promotion to a blocked terminal requires an actual
  // evidence-backed report (harness-provided, or synthesized only when real
  // investigate tool calls exist). Model prose alone cannot create a block —
  // this keeps the callback surface consistent with the streaming surface.
  const declaredBlocked = !!(answer && /(?:^|\n)\s*BLOCKED\b/.test(answer))
  const synthesizedReport =
    declaredBlocked && !blockedReport
      ? detectAndBuildBlockedReport(
          answer ?? '',
          snapshot.evidence.observability.toolCallLog,
        )
      : null
  const finalBlockedReport = blockedReport ?? synthesizedReport
  const finalStatus =
    (status === 'completed' || status === 'failed') && finalBlockedReport
      ? ('blocked' as const)
      : status

  if (snapshot.presentation.cachedSystemPromptNative)
    stashEngineFingerprint(
      snapshot.context.engineRunId,
      buildPromptFingerprint({
        systemPrompt: snapshot.presentation.cachedSystemPromptNative,
        taskClass: snapshot.context.taskClass,
        tune: getChatTaskTune(snapshot.context.taskClass),
        playbookId: snapshot.presentation.playbookId,
      }),
    )

  // Compute truthful TerminalOutcome from status and runtime state.
  const hasMutation = snapshot.outcome.hasMutation
  const failedCause =
    finalStatus === 'failed'
      ? (knownOutcome ?? classifyFailureText(answer ?? ''))
      : undefined
  let outcome: TerminalOutcome | undefined =
    finalStatus === 'failed'
      ? failedCause
      : (knownOutcome ??
        computeTerminalOutcome({
          readOnly: snapshot.outcome.readOnly,
          finalStatus,
          budgetExceeded: snapshot.outcome.budgetExceeded,
          lastVerifierReceipt: snapshot.outcome.lastVerifierReceipt,
          blockedReport: finalBlockedReport,
          hasAnyWrites: hasMutation,
        }))
  if (outcome !== undefined && finalStatus !== 'failed') {
    outcome = applyHonestTaskOutcomeToCompletion({
      contract: snapshot.context.taskContract,
      requestedOutcome: outcome,
      hasMutation,
      planMode: snapshot.context.executionProfile === 'plan',
    })
  }
  const planCompletion =
    snapshot.context.executionProfile === 'plan' && finalStatus === 'completed'
  const kernelDecision =
    outcome !== undefined && finalStatus !== 'failed'
      ? effects.decideCompletion(
          planCompletion ? 'PLAN_COMPLETE' : outcome,
          hasMutation,
        )
      : null
  const authoritativeOutcome: TerminalOutcome | undefined =
    kernelDecision && kernelDecision.finalOutcome !== 'PLAN_COMPLETE'
      ? kernelDecision.finalOutcome
      : planCompletion
        ? 'UNVERIFIED_PATCH'
        : outcome
  const terminalReason =
    finalStatus === 'cancelled'
      ? ({
          code: 'cancelled' as const,
          cause_class: null,
        } satisfies TerminalReason)
      : resolveChatTerminalReason(
          input,
          authoritativeOutcome ?? outcome,
          finalBlockedReport,
          knownReason,
        )
  // R0-9: keep the tuple coherent on the callback/non-stream path. As on the
  // streaming path, `verification_failed` pairs with `UNVERIFIED_PATCH` when
  // the gate recorded a patch, so it is not remapped to AGENT_FAILURE.
  const projectedOutcome =
    (terminalReason?.code && terminalReason.code !== 'verification_failed'
      ? outcomeFromReasonCode(terminalReason.code)
      : undefined) ?? authoritativeOutcome
  if (kernelDecision && !superseded) {
    recordChatCompletionDecisionOnce(input, {
      requestedOutcome: kernelDecision.requestedOutcome,
      finalOutcome: authoritativeOutcome ?? kernelDecision.finalOutcome,
      allowed: kernelDecision.allowed,
      reason: kernelDecision.reason,
      evidenceRefs: kernelDecision.evidenceRefs,
      policyVersion: kernelDecision.policyVersion,
      ...(terminalReason !== undefined
        ? {
            reasonCode: terminalReason.code,
            causeClass: terminalReason.cause_class,
          }
        : {}),
    })
  }

  // P0-E: if any kill-switch ran in shadow mode, record whether the task
  // later succeeded (mutation / coding-task gate) for precision/recall.
  // P0-F: wire the derived OutcomeDimensions — the real receipt (its `stale`
  // flag was just refreshed against the live workspace by decideCompletion)
  // and the completion-gate result (authoritativeOutcome IS the gate decision).
  const codingPassed = isCodingTaskSuccess({
    terminalOutcome: authoritativeOutcome ?? null,
    hasSuccessfulMutation: hasMutation,
    verifierOk: snapshot.outcome.lastVerifierReceipt?.exit_code === 0,
    requireVerifier: false,
    declaredBlocked: Boolean(finalBlockedReport),
    verifierReceipt: snapshot.outcome.lastVerifierReceipt ?? null,
    contractChecksPass:
      authoritativeOutcome === 'VERIFIED_COMPLETE' ? true : null,
  })
  recordPolicyShadowSessionOutcome(snapshot.evidence.policyEventLog, {
    atTurn: snapshot.context.turnIndex,
    hasSuccessfulMutation: hasMutation,
    codingTaskPassed: codingPassed,
    terminalOutcome: authoritativeOutcome ?? 'unknown',
  })

  const terminal = projectChatTerminal({
    ...(projectedOutcome !== undefined ? { outcome: projectedOutcome } : {}),
    status: finalStatus,
  })

  if (!superseded) {
    effects.settleActiveExecution()
    // AC3 choke point: memory + disk (idempotent if streamDone already finalized)
    effects.finalizeTurn(terminal.outcome, terminal.status, terminalReason)
  }

  const runAllowance = assembleChatRunAllowance(
    input,
    terminal.status,
    !superseded,
  )

  const result: ChatResult = {
    status: terminal.status,
    ...(terminal.outcome !== undefined ? { outcome: terminal.outcome } : {}),
    ...(kernelDecision?.finalOutcome === 'PLAN_COMPLETE'
      ? { planOutcome: 'PLAN_COMPLETE' as const }
      : {}),
    answer: answer ?? '',
    usage: globalCostTracker.getSessionSummary(),
    lastRequestPromptTokens: snapshot.presentation.lastRequestPromptTokens,
    lastRequestCompletionTokens:
      snapshot.presentation.lastRequestCompletionTokens,
    activeContext:
      snapshot.presentation.lastRequestPromptTokens !== null &&
      snapshot.presentation.lastRequestPromptTokens !== undefined
        ? {
            tokens: snapshot.presentation.lastRequestPromptTokens,
            modelId:
              snapshot.presentation.lastRequestModelId ??
              snapshot.context.options.model ??
              'default',
            source: 'provider_prompt_tokens' as const,
          }
        : null,
    conversation: snapshot.presentation.conversation,
    runDir: snapshot.context.engineRunDir,
    verifierReceipt: snapshot.outcome.lastVerifierReceipt,
    dedupeHitCount: snapshot.presentation.dedupeHitCount,
    ...(snapshot.outcome.verifierTampered
      ? { verifierTampered: true as const }
      : {}),
    ...(finalBlockedReport ? { blockedReport: finalBlockedReport } : {}),
    ...(snapshot.outcome.lastCriticReceipt
      ? { criticReceipt: snapshot.outcome.lastCriticReceipt }
      : {}),
    ...(snapshot.outcome.budgetExceeded
      ? { budgetExceeded: true as const }
      : {}),
    ...(snapshot.outcome.gatePolicy
      ? { gatePolicy: snapshot.outcome.gatePolicy }
      : {}),
    ...(snapshot.presentation.lastTurnTelemetry
      ? { turnTelemetry: snapshot.presentation.lastTurnTelemetry }
      : {}),
    ...(snapshot.allowance.limits.costBudget
      ? { costBudget: snapshot.allowance.limits.costBudget }
      : {}),
    runAllowance,
    ...(terminalReason !== undefined
      ? {
          reason_code: terminalReason.code,
          cause_class: terminalReason.cause_class,
        }
      : {}),
    ...observabilityResultFields(snapshot.evidence.observability),
  }

  // Persist conversation transcript to disk for session resume.
  // Write is fire-and-forget — failure must not block the turn result.
  persistTranscriptToDisk(
    snapshot.context.engineRunDir,
    result.conversation,
  ).catch(() => {})

  // Tier A2: Persist policy event log alongside transcript (sync — no exit race)
  persistPolicyEventsJsonl(
    snapshot.context.engineRunDir,
    snapshot.evidence.policyEventLog,
  )
  // Event log disk flush is owned solely by finalizeParityTurn / checkpointParityEventLog

  // Propose BABEL.md learnings after successful runs with writes only.
  if (terminal.status === 'completed' && snapshot.outcome.writeCount > 0) {
    try {
      const changed = snapshot.evidence.observability.toolCallLog
        .flatMap((t) =>
          confirmedMutationPaths({
            tool: t.tool,
            target: t.target,
            error: t.error,
            effectStatus: t.effect_status,
            mutationPaths: t.mutation_paths,
          }),
        )
        .filter((p, i, arr) => p && arr.indexOf(p) === i)
        .slice(0, 20)
      proposeProjectMemoryWriteback({
        projectRoot: snapshot.context.options.projectRoot,
        taskSummary: snapshot.context.options.task,
        changedFiles: changed,
        verifierSummary: snapshot.outcome.lastVerifierReceipt
          ? `${snapshot.outcome.lastVerifierReceipt.command} → exit ${snapshot.outcome.lastVerifierReceipt.exit_code}`
          : null,
      })
    } catch {
      /* write-back must never fail the turn */
    }
  }

  return result
}
