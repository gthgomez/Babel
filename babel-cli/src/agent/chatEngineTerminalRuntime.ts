/** Terminal projection, result assembly, and durable evidence settlement. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatArgvAsCommand } from '../utils/commandArgv.js'
import {
  TerminalReasonCodeSchema,
  type BlockedReport,
  type TerminalOutcome,
  type TerminalReasonCode,
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
import type { RunControl, StopRequest } from '../runtime/run-control.js'
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
import type { FinalRevisionWitnessV1 } from '../authority/finalRevision.js'
import {
  evaluateFinalRevisionWitness,
  unavailableFinalRevisionWitness,
  untestedPathsAfterLastGreenVerifier,
} from '../authority/finalRevision.js'
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
  persistChatTranscript,
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
import type { CriterionEvidenceResultV1 } from '../evidence/evidenceGraph.js'
import {
  CHILD_READ_DEFAULT_ROUNDS,
  CHILD_MUTATION_DEFAULT_ROUNDS,
} from './childSpec.js'
import { confirmedMutationPaths } from './mutationTools.js'
import { detectAndBuildBlockedReport } from './chatEngineSupport.js'
import type { ThreadTerminalResponse } from './threadEventLog.js'
import type {
  FinalizeParityTurnExtras,
  FinalizeParityTurnResult,
} from './chatEngineParityBridge.js'
import {
  classifyChatTaskIntent,
  isConversationalTurnText,
} from './chatEngineTaskIntent.js'
import { hasExplicitEditDenial, stripFencedCodeBodies } from '../config/chatTaskClass.js'
import { isSessionEventPersistenceFailure } from './sessionEventDiagnostics.js'
import { hasInspectedNoChangeEvidence } from './completionGatePolicy.js'
import { refreshChatVerifierReceiptStalenessSync } from '../evidence/chatRevisionBinding.js'
import {
  collectConfirmedMutationArtifactPaths,
  formatPreservedUnverifiedTerminalAnswer,
} from './preservedUnverifiedTerminal.js'
import { requestedChatJsonKind } from './chatResponseContract.js'
import { describeUnverifiedVerifierStatus } from './unverifiedFileDelivery.js'

export const SESSION_EVENT_PERSISTENCE_FINALIZE_MESSAGE =
  'session event persistence failed before terminal evidence could be durably recorded'

const UNVERIFIED_COMPLETION_MARKER = 'Completion status: UNVERIFIED_PATCH.'

/** Publication-time no-change proof; absent roots stay absent, never inferred. */
function publicationRevisionWitness(
  snapshot: ChatTerminalSnapshot,
  requested: TerminalOutcome | 'PLAN_COMPLETE',
): FinalRevisionWitnessV1 | undefined {
  if (requested !== 'NO_CHANGE_REQUIRED' || !snapshot.context.options.projectRoot) return undefined
  try {
    return evaluateFinalRevisionWitness({
      projectRoot: snapshot.context.options.projectRoot,
      toolCallLog: snapshot.evidence.observability.toolCallLog,
      requiredVerifierCommands: [],
    })
  } catch {
    return unavailableFinalRevisionWitness('final_revision_unavailable')
  }
}

function singleLineEvidence(value: string, maxLength = 240): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/** A recovery controller instruction is not a user-facing completion answer. */
function isRecoveryOnlyPlaceholder(answer: string): boolean {
  return /^\s*(?:Recovery:\s*[a-z][a-z0-9_-]{0,40}[.!]?\s*(?:Summarize(?:\s+evidence)?(?:\s+and\s+change\s+approach)?[.!]?)?|Repeated no-progress after recovery\s*\(\d+\s+cycles?\))\s*$/i.test(answer)
}

/** Preserve an explicit machine-readable answer; clients must use the structured outcome, not JSON model claims. */
function satisfiesRequestedBareJsonAnswer(answer: string, task: string): boolean {
  const kind = requestedChatJsonKind(task)
  if (!kind) return false
  try {
    const parsed: unknown = JSON.parse(answer)
    return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === (kind === 'array')
  } catch {
    return false
  }
}

function proofPlanLabel(plan: CriterionEvidenceResultV1['proof_plan']): string {
  switch (plan) {
    case 'none': return 'no additional proof step'
    case 'run_frozen_verifier': return 'run the verifier frozen in the task contract'
    case 'propose_focused_check': return 'propose a focused check; keep it diagnostic until the contract is explicitly amended'
    case 'repair_failing_verifier': return 'investigate the failing verifier and rerun it after repair'
    case 'resolve_evidence_integrity': return 'resolve the current evidence integrity or freshness issue'
  }
}

function frozenEvidenceCommand(
  requirement: TaskContractV1['acceptance'][number] | undefined,
): string | null {
  const verification = requirement?.verification
  if (!verification?.executable_id || !verification.argv?.length) return null
  try {
    return formatArgvAsCommand([verification.executable_id, ...verification.argv])
  } catch {
    return null
  }
}

function missingEvidenceHint(
  requirement: TaskContractV1['acceptance'][number] | undefined,
): string {
  const command = frozenEvidenceCommand(requirement)
  if (command) return `required evidence: run the frozen verifier \`${singleLineEvidence(command, 160)}\``
  return 'required evidence: no executable witness is bound yet; restate this behavior as a concretely checkable requirement (an exact test command, or a named file/path with the expected content)'
}

function appendCriterionEvidenceSummary(
  answer: string,
  evidence?: readonly CriterionEvidenceResultV1[],
  omitted = 0,
  contract?: TaskContractV1,
): string {
  if (!evidence?.length) return answer
  const statusText: Record<CriterionEvidenceResultV1['status'], string> = {
    satisfied: 'current host-accepted evidence matches the frozen verifier',
    missing: 'no current criterion-bound evidence is available',
    unknown: 'evidence could not be validated',
    failed: 'the criterion verifier failed',
    not_required: 'optional criterion; not required for completion',
  }
  const lines = [
    'Host criterion evidence (per-criterion report; overall completion status is unchanged):',
    ...evidence.map((item) => {
      const requirement = contract?.acceptance.find(candidate => candidate.id === item.requirement_id)
      const proof = item.status === 'satisfied' || item.status === 'not_required'
        ? ''
        : `; ${missingEvidenceHint(requirement)}`
      return `- ${singleLineEvidence(item.description, 180)} [${singleLineEvidence(item.requirement_id, 80)}]: ${statusText[item.status]}; next: ${proofPlanLabel(item.proof_plan)}${proof}.`
    }),
  ]
  if (omitted > 0) lines.push(`- ${omitted} additional criterion result(s) omitted.`)
  return `${answer}\n\n${lines.join('\n')}`
}

/** Make the terminal answer agree with the host completion decision without changing that decision. */
function knownRedVerifierReceipt(
  receipt: BoundChatVerifierReceipt | null | undefined,
): receipt is BoundChatVerifierReceipt {
  return (
    receipt != null &&
    receipt.stale !== true &&
    Number.isInteger(receipt.exit_code) &&
    receipt.exit_code !== 0 &&
    typeof receipt.command === 'string' &&
    receipt.command.trim().length > 0
  )
}

/**
 * A later provider/network failure must not erase a known red check from the
 * terminal explanation. The terminal cause remains the later failure; this is
 * retained evidence, not a new success claim (TF-14).
 */
export function failureExplanationWithKnownVerifierState(
  answer: string,
  receipt: BoundChatVerifierReceipt | null | undefined,
): string {
  if (!knownRedVerifierReceipt(receipt)) return answer
  const command = singleLineEvidence(receipt.command, 160)
  if (answer.includes(command)) return answer
  const summary =
    typeof receipt.summary === 'string' && receipt.summary.trim().length > 0
      ? `: ${singleLineEvidence(receipt.summary, 240)}`
      : ''
  return [
    answer,
    '',
    `Known verification state at failure: "${command}" exited ${receipt.exit_code}${summary}.`,
    'This earlier red check remains part of the run evidence; the later failure does not turn it green.',
  ].join('\n')
}

function formatTerminalAnswerForOutcome(input: {
  answer: string
  outcome: TerminalOutcome
  status: ChatResult['status']
  hasMutation: boolean
  task: string
  toolCallLog: ChatTerminalSnapshot['evidence']['observability']['toolCallLog']
  verifierReceipt?: BoundChatVerifierReceipt | null | undefined
  preservedUnverifiedCandidate?: {
    candidate: string
    artifactRefs: readonly string[]
  }
  acceptanceEvidence?: readonly CriterionEvidenceResultV1[]
  acceptanceEvidenceOmitted?: number
  contract?: TaskContractV1
  finalRevision?: FinalRevisionWitnessV1
}): string {
  const unverifiedTerminal = input.status === 'completed' && input.outcome === 'UNVERIFIED_PATCH'
  const blockedRecovery = input.status === 'blocked' && input.outcome === 'BLOCKED_POLICY'
  const decisionDeferral = input.outcome === 'NEEDS_HUMAN_DECISION'
  if (!input.answer.trim() || satisfiesRequestedBareJsonAnswer(input.answer, input.task)) {
    return input.answer
  }
  if (input.status === 'failed') {
    return failureExplanationWithKnownVerifierState(input.answer, input.verifierReceipt)
  }
  if (input.finalRevision?.status === 'stale') {
    return [
      UNVERIFIED_COMPLETION_MARKER,
      'The accepted proof is stale: inspected files changed after the check and before publication, so task completion is not certified.',
      input.finalRevision.stale_paths.length > 0
        ? `Changed after the accepted proof: ${input.finalRevision.stale_paths.slice(0, 20).join(', ')}.`
        : 'Changed after the accepted proof: workspace bytes could not be attributed to a specific path.',
      'These are user-owned worktree bytes; inspect them and rerun the required verifier before treating the result as current.',
      '',
      'Model response (retained as an unverified report):',
      '---',
      input.answer,
    ].join('\n')

  }
  if (decisionDeferral) {
    return input.acceptanceEvidence?.length
      ? appendCriterionEvidenceSummary(
          input.answer,
          input.acceptanceEvidence,
          input.acceptanceEvidenceOmitted,
          input.contract,
        )
      : input.answer
  }
  if ((!unverifiedTerminal && !blockedRecovery) || !input.hasMutation) return input.answer

  const artifactRefs = collectConfirmedMutationArtifactPaths(input.toolCallLog)
  if (blockedRecovery && input.preservedUnverifiedCandidate) {
    const confirmedRefs = new Set(artifactRefs)
    const retainedRefs = input.preservedUnverifiedCandidate.artifactRefs
      .filter(ref => confirmedRefs.has(ref))
    if (retainedRefs.length > 0 && input.preservedUnverifiedCandidate.candidate.trim()) {
      return formatPreservedUnverifiedTerminalAnswer({
        authorityReason: [
          'Completion status: BLOCKED_POLICY.',
          `A policy or recovery boundary stopped this attempt: ${singleLineEvidence(input.answer)}`,
          describeUnverifiedVerifierStatus(input.toolCallLog),
        ].join('\n'),
        retainedCandidate: input.preservedUnverifiedCandidate.candidate,
        artifactRefs: retainedRefs,
      })
    }
  }
  if (artifactRefs.length === 0) {
    if (blockedRecovery) {
      return [
        'Completion status: BLOCKED_POLICY.',
        'A policy or recovery boundary stopped this attempt; task completion is not certified.',
        'The host recorded a mutation but could not provide an enumerated artifact path.',
        '',
        'Model response (task remains blocked):',
        '---',
        input.answer,
        '',
        'Verification status:',
        describeUnverifiedVerifierStatus(input.toolCallLog),
      ].join('\n')
    }
    return appendCriterionEvidenceSummary([
      UNVERIFIED_COMPLETION_MARKER,
      'The required task-acceptance evidence was not established. The model response below is retained as an unverified report and does not certify completion.',
      '',
      'Unverified model response:',
      '---',
      input.answer,
    ].join('\n'), input.acceptanceEvidence, input.acceptanceEvidenceOmitted, input.contract)
  }
  const recoveryOnly = isRecoveryOnlyPlaceholder(input.answer)
  const lines = [
    unverifiedTerminal ? UNVERIFIED_COMPLETION_MARKER : 'Completion status: BLOCKED_POLICY.',
    unverifiedTerminal
      ? 'The required task-acceptance evidence was not established; task completion is not certified.'
      : 'A policy or recovery boundary stopped this attempt; task completion is not certified.',
  ]
  if (artifactRefs.length > 0) {
    const shown = artifactRefs.slice(0, 20)
    lines.push('', `Paths with recorded confirmed mutations (final workspace state not re-checked): ${shown.map(path => JSON.stringify(singleLineEvidence(path))).join(', ')}${artifactRefs.length > shown.length ? `, and ${artifactRefs.length - shown.length} more` : ''}`)
  }
  const untested = untestedPathsAfterLastGreenVerifier(input.toolCallLog)
  if (unverifiedTerminal && untested.length > 0) {
    lines.push('', `Modified after the last passing verifier (not covered by that result): ${untested.slice(0, 20).map(path => JSON.stringify(singleLineEvidence(path))).join(', ')}. These worktree changes are retained, not deleted; rerun the verifier to cover them.`)
  }
  if (recoveryOnly) {
    lines.push('', 'Host-grounded delivery summary:',
      `The host recorded confirmed file changes to: ${artifactRefs.map(path => JSON.stringify(singleLineEvidence(path))).join(', ')}.`,
      describeUnverifiedVerifierStatus(input.toolCallLog))
  } else {
    if (unverifiedTerminal) lines.push('', 'Unverified model response:', '---', input.answer)
    else lines.push('', 'Model response (task remains blocked):', '---', input.answer)
    lines.push('', 'Verification status:', describeUnverifiedVerifierStatus(input.toolCallLog))
  }
  return unverifiedTerminal || blockedRecovery
    ? appendCriterionEvidenceSummary(lines.join('\n'), input.acceptanceEvidence, input.acceptanceEvidenceOmitted, input.contract)
    : lines.join('\n')
}

function replaceLastMatchingAssistantAnswer(
  conversation: ChatTerminalSnapshot['presentation']['conversation'],
  original: string,
  replacement: string,
): void {
  if (original === replacement) return
  const message = conversation.at(-1)
  if (message?.role === 'assistant' && message.content === original) message.content = replacement
}

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
    acceptedOperation?: import('../config/chatTaskClass.js').TaskOperation | undefined
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
    accountingWarnings?: string[]
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
    /** Publication-time final-revision witness for no-change/read-only claims. */
    finalRevision?: FinalRevisionWitnessV1,
  ) => ReturnType<ExecutorKernel['completion']['decide']>
  settleActiveExecution: () => void
  finalizeTurn: (
    outcome: TerminalOutcome | undefined,
    status: ChatResult['status'],
    reason: TerminalReason | undefined,
    response?: ThreadTerminalResponse,
    extras?: FinalizeParityTurnExtras,
  ) => FinalizeParityTurnResult
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
  /** Host-owned winning continuation decision; does not certify fulfillment. */
  stopRequest?: import('../runtime/run-control.js').StopRequest
  /** Controller-only deferral; never accepted as a model tool argument. */
  needsHumanDecision?: boolean
  blockedReport?: BlockedReport | null
  verifierTampered?: boolean
  criticReceipt?: import('./diffCritic.js').DiffCriticVerdict | null
  reason?: TerminalReason
  /** Host-captured, revision-bound answer preserved only for an honest blocked terminal. */
  preservedUnverifiedCandidate?: {
    candidate: string
    artifactRefs: readonly string[]
  }
}

/** A recorded, successful source read (detail text is not required here). */
function hasSuccessfulSourceRead(
  log: ChatTerminalSnapshot['evidence']['observability']['toolCallLog'],
): boolean {
  return log.some(
    (entry) =>
      (entry.tool === 'read_file' || entry.tool === 'read_range') &&
      !entry.error &&
      (entry.exit_code === undefined || entry.exit_code === 0),
  )
}

/**
 * A repository question that produced no source observation is not a grounded
 * informational answer. Task text only selects the requirement; evidence is
 * still the successful tool log.
 *
 * Heuristic boundary (declared, round-2 P3): the requirement needs BOTH an
 * explanatory/informational verb AND a repository-target keyword. An
 * explain-verb turn with no repo keyword — e.g. "Summarize what you see" —
 * escapes this guard and can still certify NO_CHANGE_REQUIRED with zero
 * reads. Widening on the verb alone is NOT safe: `isConversationalTurnText`
 * only recognizes short greetings/acknowledgements, so it would also sweep
 * conversational-informational follow-ups ("summarize what we discussed",
 * "explain your reasoning") whose referent is the conversation, not the
 * repository, and mark them UNVERIFIED_PATCH/exit 6. The referent of a
 * keyword-less deictic task is unknowable from task text alone; closing
 * this gap needs a task-referent classifier, not a wider regex.
 */
function taskRequiresRepositoryInspection(task: string): boolean {
  if (isConversationalTurnText(task)) return false
  // Only explanatory/informational requests claim repository understanding.
  // A raw read attempt that failed is handled by the completion gate, not
  // turned into a second, text-only success claim.
  if (
    !/\b(explain|describe|summari[sz]e|review|audit|analy[sz]e|overview|what|how|why|tell\s+me\s+about)\b/i.test(
      task,
    )
  ) {
    return false
  }
  return /\b(repo(?:sitory)?|codebase|project|source|files?|modules?|packages?|readme|architecture|implementation|functions?|classes?|tests?|workspace)\b/i.test(task)
}

/** Inspection can prove no change is needed; zero writes alone cannot. */
export function normalizeInspectedNoChange(
  snapshot: ChatTerminalSnapshot,
  outcome: TerminalOutcome,
): TerminalOutcome {
  const implementation = snapshot.context.acceptedOperation !== undefined
    ? snapshot.context.acceptedOperation !== 'READ_ONLY'
    : classifyChatTaskIntent(snapshot.context.options.task) === 'execute'
  if (outcome === 'NO_CHANGE_REQUIRED' && implementation && snapshot.context.options.projectRoot)
    refreshChatVerifierReceiptStalenessSync(snapshot.context.options.projectRoot, snapshot.outcome.lastVerifierReceipt)
  const verifier = snapshot.outcome.lastVerifierReceipt
  const greenCurrentVerifier = verifier?.authority === true && verifier.exit_code === 0 && verifier.stale === false
  if (outcome !== 'NO_CHANGE_REQUIRED') return outcome
  if (implementation) {
    return !hasInspectedNoChangeEvidence(snapshot.evidence.observability.toolCallLog) && !greenCurrentVerifier
      ? 'AGENT_FAILURE' : outcome
  }
  // TF-11: an informational repository answer still needs at least one
  // successful source observation. Without it the result is an unverified
  // inspection, not a successful explanation.
  // Exception (landed ordinary-admission contract): when the operator's
  // acceptance explicitly forbids edits AND the engine durably refused a
  // native mutation attempt in this turn, the no-change terminal is
  // engine-adjudicated — the recorded write denial plus zero mutations
  // proves the no-change acceptance — so the turn completes
  // NO_CHANGE_REQUIRED without demanding source reads. Either half alone
  // keeps the demotion: a bare edit-denial with no engine-refused write
  // still has the explanation as its deliverable, and a refused write
  // without the operator's no-edit contract is not the admission flow.
  if (
    snapshot.context.options.projectRoot !== undefined &&
    taskRequiresRepositoryInspection(snapshot.context.options.task) &&
    !hasSuccessfulSourceRead(snapshot.evidence.observability.toolCallLog) &&
    !greenCurrentVerifier &&
    !engineAdjudicatedNoChangeAcceptance(snapshot)
  ) {
    return 'UNVERIFIED_PATCH'
  }
  return outcome
}

/**
 * True when the operator's task acceptance explicitly forbids edits and the
 * engine's durable tool log records a refused native mutation attempt for
 * this turn. That combination is the engine-adjudicated no-change flow the
 * ordinary read-only admission contract pins (an ordinary prepared no-change
 * task whose native write proposal is denied completes NO_CHANGE_REQUIRED).
 * An informational question is excluded: its deliverable is the grounded
 * answer, which a denied write does not provide.
 */
function taskRequestsEdit(task: string): boolean {
  return /\b(?:fix|repair|change|update|implement|make|ensure|add|remove|delete|create|refactor|migrate|upgrade|replace|rename|apply|extend|adjust|write|edit|modify)\b/i.test(
    stripFencedCodeBodies(task),
  )
}

function engineAdjudicatedNoChangeAcceptance(
  snapshot: ChatTerminalSnapshot,
): boolean {
  const log = snapshot.evidence.observability.toolCallLog
  const refusedMutation = log.some(
    (entry) =>
      entry.error === 'blocked' &&
      (entry.tool === 'write_file' ||
        entry.tool === 'str_replace' ||
        entry.tool === 'apply_patch'),
  )
  return (
    refusedMutation &&
    hasExplicitEditDenial(snapshot.context.options.task) &&
    taskRequestsEdit(snapshot.context.options.task)
  )
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
  const needsHumanDecision = extra?.needsHumanDecision === true &&
    !snapshot.outcome.budgetExceeded && !snapshot.outcome.verifierTampered && !extra?.blockedReport && !extra?.verifierTampered
  const {
    needsHumanDecision: _privateDecision,
    stopRequest: stop,
    preservedUnverifiedCandidate,
    ...publicExtra
  } = extra ?? {}
  const stoppedOutcome: TerminalOutcome | undefined = stop?.kind === 'blocked' ? stop.reasonCode === 'permission_denied' ? 'BLOCKED_POLICY' : 'BLOCKED_EXTERNAL'
    : stop?.kind === 'budget_exhausted' ? 'BUDGET_EXHAUSTED' : stop?.kind === 'failed' ? 'AGENT_FAILURE'
    : stop?.kind === 'cancelled' || stop?.kind === 'superseded' ? 'CANCELLED' : undefined
  let requestedOutcome = stoppedOutcome ?? computeTerminalOutcome({
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
  if (needsHumanDecision && !stoppedOutcome) requestedOutcome = 'NEEDS_HUMAN_DECISION'
  requestedOutcome = normalizeInspectedNoChange(snapshot, requestedOutcome)
  const planCompletion =
    snapshot.context.executionProfile === 'plan' &&
    !stoppedOutcome &&
    !needsHumanDecision &&
    !extra?.blockedReport &&
    !snapshot.outcome.budgetExceeded
  const decision = effects.decideCompletion(
    planCompletion ? 'PLAN_COMPLETE' : requestedOutcome,
    hasMutation,
    publicationRevisionWitness(snapshot, planCompletion ? 'PLAN_COMPLETE' : requestedOutcome),
  )
  const decisionOutcome =
    decision.finalOutcome === 'PLAN_COMPLETE'
      ? 'UNVERIFIED_PATCH'
      : decision.finalOutcome
  if (decision.finalRevision) {
    try {
      writeFileSync(
        join(snapshot.context.engineRunDir, 'final_revision.json'),
        `${JSON.stringify(decision.finalRevision, null, 2)}\n`,
      )
    } catch {
      /* terminal evidence remains available in the completion decision */
    }
  }
  const terminalReason = resolveChatTerminalReason(
    input,
    decisionOutcome,
    extra?.blockedReport,
    extra?.reason ?? (stoppedOutcome && stop ? {
      code: stop.kind === 'budget_exhausted' ? 'budget_exhausted' : stop.kind === 'cancelled' || stop.kind === 'superseded' ? 'cancelled'
        : TerminalReasonCodeSchema.safeParse(stop.reasonCode).success ? stop.reasonCode as TerminalReasonCode : 'unknown',
      cause_class: null, detail: stop.reasonCode,
    } : undefined),
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
  const completionDecisionPayload = {
    requestedOutcome: decision.requestedOutcome,
    finalOutcome: outcome,
    allowed: decision.allowed,
    reason: decision.reason,
    evidenceRefs: decision.evidenceRefs,
    policyVersion: decision.policyVersion,
    ...(decision.finalRevision ? { finalRevision: decision.finalRevision } : {}),
    ...(decision.stalePaths?.length ? { stalePaths: [...decision.stalePaths] } : {}),
    ...(decision.acceptanceEvidence ? { acceptanceEvidence: decision.acceptanceEvidence } : {}),
    ...(decision.acceptanceEvidenceOmitted !== undefined
      ? { acceptanceEvidenceOmitted: decision.acceptanceEvidenceOmitted }
      : {}),
    ...(terminalReason !== undefined
      ? {
          reasonCode: terminalReason.code,
          causeClass: terminalReason.cause_class,
        }
      : {}),
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
  const deliveredAnswer = formatTerminalAnswerForOutcome({
    answer,
    outcome: terminal.outcome!,
    status: terminal.status,
    hasMutation,
    task: snapshot.context.options.task,
    toolCallLog: snapshot.evidence.observability.toolCallLog,
    ...(preservedUnverifiedCandidate !== undefined
      ? { preservedUnverifiedCandidate }
      : {}),
    ...(decision.acceptanceEvidence ? { acceptanceEvidence: decision.acceptanceEvidence } : {}),
    ...(decision.acceptanceEvidenceOmitted !== undefined
      ? { acceptanceEvidenceOmitted: decision.acceptanceEvidenceOmitted }
      : {}),
    ...(snapshot.context.taskContract ? { contract: snapshot.context.taskContract } : {}),
    ...(decision.finalRevision ? { finalRevision: decision.finalRevision } : {}),
  })
  replaceLastMatchingAssistantAnswer(
    snapshot.presentation.conversation,
    answer,
    deliveredAnswer,
  )
  const finalizeResult = effects.finalizeTurn(
    terminal.outcome,
    terminal.status,
    terminalReason,
    {
      kind: 'answer',
      content: deliveredAnswer,
    },
    { completionDecision: completionDecisionPayload },
  )
  if (!finalizeResult.committed) {
    return failChatStream(input, SESSION_EVENT_PERSISTENCE_FINALIZE_MESSAGE)
  }
  persistChatTranscript(snapshot.context.engineRunDir, snapshot.presentation.conversation)
  const finalizedTelemetry =
    snapshot.presentation.currentTurnTelemetry?.finalize({
      turnId: String(snapshot.context.turnId ?? snapshot.context.turnIndex),
      taskClass: snapshot.context.taskClass,
      promptTokens: snapshot.presentation.lastRequestPromptTokens,
      completionTokens: snapshot.presentation.lastRequestCompletionTokens,
      cumulativeSessionTokens:
        globalCostTracker.getSessionSummary().totalTokens,
      verifiedOutcome: terminal.outcome === 'VERIFIED_COMPLETE',
    })
  effects.storeTelemetry(finalizedTelemetry ?? null)
  const runAllowance = assembleChatRunAllowance(input, terminal.status)
  return buildStreamDone(snapshot.evidence.observability, deliveredAnswer, {
    outcome: terminal.outcome!,
    status: terminal.status,
    ...(decision.finalOutcome === 'PLAN_COMPLETE'
      ? { planOutcome: 'PLAN_COMPLETE' as const }
      : {}),
    ...(snapshot.outcome.budgetExceeded
      ? { budgetExceeded: true as const }
      : {}),
    ...publicExtra,
    ...(snapshot.allowance.limits.costBudget
      ? { costBudget: snapshot.allowance.limits.costBudget }
      : {}),
    ...(snapshot.presentation.accountingWarnings?.length ? { accountingWarnings: snapshot.presentation.accountingWarnings } : {}),
    runAllowance,
    ...(finalizedTelemetry ? { turnTelemetry: finalizedTelemetry } : {}),
    ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
    ...(snapshot.outcome.gatePolicy != null
      ? { gatePolicy: snapshot.outcome.gatePolicy }
      : {}),
  })
}

/** Project failed streams without inventing unknown terminal causes. */
export function failChatStream(
  input: ChatTerminalInput,
  error: string,
  explicitReason?: import('./chatTerminalReason.js').TerminalReason,
  presentationError?: string,
): ChatEvent {
  const { snapshot, effects } = input
  const displayError = failureExplanationWithKnownVerifierState(
    presentationError ?? error,
    snapshot.outcome.lastVerifierReceipt,
  )
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
  const classifiedOutcome = explicitReason
    ? (outcomeFromReasonCode(explicitReason.code) ?? limiterOutcome)
    : (classifyFailureText(error) ?? limiterOutcome)
  const terminalReason =
    explicitReason ?? terminalReasonFromFailureText(error) ??
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
  try {
    effects.finalizeTurn(terminal.outcome, terminal.status, terminalReason, {
      kind: 'error',
      content: displayError,
    })
  } catch (failure) {
    // A broken primary log cannot certify completion. Still deliver its
    // explicit failed event; never suppress an unrelated finalization error.
    if (!isSessionEventPersistenceFailure(error) || !isSessionEventPersistenceFailure(failure)) throw failure
  }
  persistChatTranscript(snapshot.context.engineRunDir, snapshot.presentation.conversation)
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
  return buildStreamFailed(snapshot.evidence.observability, displayError, {
    ...(outcome !== undefined ? { outcome } : {}),
    status: terminal.status,
    ...(snapshot.allowance.limits.costBudget
      ? { costBudget: snapshot.allowance.limits.costBudget }
      : {}),
    ...(snapshot.presentation.accountingWarnings?.length ? { accountingWarnings: snapshot.presentation.accountingWarnings } : {}),
    runAllowance,
    ...(finalizedTelemetry ? { turnTelemetry: finalizedTelemetry } : {}),
    ...(terminalReason !== undefined ? { reason: terminalReason } : {}),
  })
}

/** Finalize cancellation telemetry for the current turn. */
export function cancelChatStream(input: ChatTerminalInput): ChatEvent {
  const { snapshot, effects } = input
  effects.settleActiveExecution()
  persistChatTranscript(snapshot.context.engineRunDir, snapshot.presentation.conversation)
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

/** Render the recorded winner through the existing single finalizer, without inference. */
export function stoppedChatStream(
  inputForTerminal: () => ChatTerminalInput,
  stop: StopRequest,
): ChatEvent {
  if (stop.reasonCode === 'physical_settlement_unknown') {
    return completeChatStream(inputForTerminal(),
      'The command may still be running. Inspect the workspace and run evidence before continuing.',
      { stopRequest: stop });
  }
  if (stop.kind === 'cancelled' || stop.kind === 'superseded') {
    return cancelChatStream(inputForTerminal())
  }
  if (stop.kind === 'failed') {
    return failChatStream(inputForTerminal(), `Execution stopped: ${stop.reasonCode}.`)
  }
  return completeChatStream(inputForTerminal(), `Execution stopped: ${stop.reasonCode}.`, {
    stopRequest: stop,
  })
}

export function cancelledChatStream(
  inputForTerminal: () => ChatTerminalInput,
  runControl: RunControl | null,
): ChatEvent {
  const prior = runControl?.stop()
  if (prior && prior.kind !== 'cancelled' && prior.kind !== 'superseded') {
    return stoppedChatStream(inputForTerminal, prior)
  }
  runControl?.requestStop({
    owner: runControl.owner,
    kind: 'cancelled',
    reasonCode: 'cancelled',
    source: 'user',
  })
  return cancelChatStream(inputForTerminal())
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
  if (snapshot.outcome.terminalLimiterReason?.startsWith('COST_ACCOUNTING_INCOMPLETE:')) {
    return { code: 'cost_accounting_incomplete', cause_class: 'harness' }
  }
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
  answerAlreadyFormattedByStream = false,
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
    // The stream owner already normalized a supplied canonical terminal.
    // Only infer evidence here when callback assembly computes the outcome.
    if (knownOutcome === undefined) outcome = normalizeInspectedNoChange(snapshot, outcome)
  }
  const planCompletion =
    snapshot.context.executionProfile === 'plan' && finalStatus === 'completed'
  const kernelDecision =
    outcome !== undefined && finalStatus !== 'failed'
      ? effects.decideCompletion(
          planCompletion ? 'PLAN_COMPLETE' : outcome,
          hasMutation,
          publicationRevisionWitness(snapshot, planCompletion ? 'PLAN_COMPLETE' : outcome),
        )
      : null
  const authoritativeOutcome: TerminalOutcome | undefined =
    kernelDecision && kernelDecision.finalOutcome !== 'PLAN_COMPLETE'
      ? kernelDecision.finalOutcome
      : planCompletion
        ? 'UNVERIFIED_PATCH'
        : outcome
  if (kernelDecision?.finalRevision) {
    try {
      writeFileSync(
        join(snapshot.context.engineRunDir, 'final_revision.json'),
        `${JSON.stringify(kernelDecision.finalRevision, null, 2)}\n`,
      )
    } catch {
      /* terminal evidence remains available in the completion decision */
    }
  }
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
  const completionDecisionPayload =
    kernelDecision && !superseded
      ? {
          requestedOutcome: kernelDecision.requestedOutcome,
          finalOutcome: authoritativeOutcome ?? kernelDecision.finalOutcome,
          allowed: kernelDecision.allowed,
          reason: kernelDecision.reason,
          evidenceRefs: kernelDecision.evidenceRefs,
          policyVersion: kernelDecision.policyVersion,
          ...(kernelDecision.finalRevision ? { finalRevision: kernelDecision.finalRevision } : {}),
          ...(kernelDecision.stalePaths?.length ? { stalePaths: [...kernelDecision.stalePaths] } : {}),
          ...(kernelDecision.acceptanceEvidence
            ? { acceptanceEvidence: kernelDecision.acceptanceEvidence }
            : {}),
          ...(kernelDecision.acceptanceEvidenceOmitted !== undefined
            ? { acceptanceEvidenceOmitted: kernelDecision.acceptanceEvidenceOmitted }
            : {}),
          ...(terminalReason !== undefined
            ? {
                reasonCode: terminalReason.code,
                causeClass: terminalReason.cause_class,
              }
            : {}),
        }
      : undefined

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
  const deliveredAnswer = answer === undefined
    ? undefined
    : answerAlreadyFormattedByStream || superseded
      ? answer
      : formatTerminalAnswerForOutcome({
        answer,
        outcome: terminal.outcome ?? outcome ?? 'AGENT_FAILURE',
        status: terminal.status,
        hasMutation,
        task: snapshot.context.options.task,
        toolCallLog: snapshot.evidence.observability.toolCallLog,
        verifierReceipt: snapshot.outcome.lastVerifierReceipt,
        ...(kernelDecision?.acceptanceEvidence
          ? { acceptanceEvidence: kernelDecision.acceptanceEvidence }
          : {}),
        ...(kernelDecision?.acceptanceEvidenceOmitted !== undefined
          ? { acceptanceEvidenceOmitted: kernelDecision.acceptanceEvidenceOmitted }
          : {}),
        ...(kernelDecision?.finalRevision ? { finalRevision: kernelDecision.finalRevision } : {}),
      })
  if (!superseded && answer !== undefined && deliveredAnswer !== undefined) {
    replaceLastMatchingAssistantAnswer(
      snapshot.presentation.conversation,
      answer,
      deliveredAnswer,
    )
  }

  let finalizeResult: FinalizeParityTurnResult = { committed: true }
  if (!superseded) {
    effects.settleActiveExecution()
    // AC3 choke point: memory + disk (idempotent if streamDone already finalized)
    finalizeResult = effects.finalizeTurn(
      terminal.outcome,
      terminal.status,
      terminalReason,
      deliveredAnswer === undefined
        ? undefined
        : {
            kind: finalStatus === 'failed' ? 'error' : 'answer',
            content: deliveredAnswer,
          },
      completionDecisionPayload
        ? { completionDecision: completionDecisionPayload }
        : undefined,
    )
  }

  const runAllowance = assembleChatRunAllowance(
    input,
    terminal.status,
    !superseded,
  )

  const result: ChatResult = {
    status: finalizeResult.committed ? terminal.status : 'failed',
    ...(finalizeResult.committed
      ? terminal.outcome !== undefined
        ? { outcome: terminal.outcome }
        : {}
      : { outcome: 'INFRA_FAILURE' as const }),
    ...(kernelDecision?.finalOutcome === 'PLAN_COMPLETE'
      ? { planOutcome: 'PLAN_COMPLETE' as const }
      : {}),
    answer: deliveredAnswer ?? '',
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
    ...(snapshot.outcome.gatePolicy != null
      ? { gatePolicy: snapshot.outcome.gatePolicy }
      : {}),
    ...(snapshot.presentation.lastTurnTelemetry
      ? { turnTelemetry: snapshot.presentation.lastTurnTelemetry }
      : {}),
    ...(snapshot.allowance.limits.costBudget
      ? { costBudget: snapshot.allowance.limits.costBudget }
      : {}),
    ...(snapshot.presentation.accountingWarnings?.length ? { accountingWarnings: snapshot.presentation.accountingWarnings } : {}),
    runAllowance,
    ...(terminalReason !== undefined
      ? {
          reason_code: terminalReason.code,
          cause_class: terminalReason.cause_class,
        }
      : {}),
    ...observabilityResultFields(snapshot.evidence.observability),
  }

  // Settle the compatibility projection synchronously before returning.
  persistChatTranscript(
    snapshot.context.engineRunDir,
    result.conversation,
  )

  // Tier A2: Persist policy event log alongside transcript (sync — no exit race)
  persistPolicyEventsJsonl(
    snapshot.context.engineRunDir,
    snapshot.evidence.policyEventLog,
  )
  // Event log disk flush is owned solely by finalizeParityTurn / checkpointParityEventLog

  // Propose BABEL.md learnings after successful runs with writes only.
  if (terminal.status === 'completed' && snapshot.outcome.writeCount > 0 && snapshot.context.options.projectRoot) {
    try {
      const changed = snapshot.evidence.observability.toolCallLog
        .flatMap((t) =>
          confirmedMutationPaths({
            tool: t.tool,
            target: t.target,
            error: t.error,
            effectStatus: t.effect_status,
            effectScope: t.effect_scope,
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
