import type { ChatEngineStreamingLoopHost, ChatEvent } from './chatEngineContracts.js'
import { ResponseEvidenceRetry, responseVerifierFacts } from './chatResponseEvidence.js'
import { resolveCompletionVerificationContext } from './completionGatePolicy.js'
import { unverifiedFileDeliveryPaths } from './unverifiedFileDelivery.js'
import { formatPreservedUnverifiedTerminalAnswer } from './preservedUnverifiedTerminal.js'
import { shellBlockedByIsolation } from './capabilityRecoveryScope.js'
import { refreshChatVerifierReceiptStalenessSync } from '../evidence/chatRevisionBinding.js'
import { recordChatHarnessFeedback } from './chatHarnessFeedback.js'

export type ResponseEvidenceCorrection =
  | { kind: 'retry'; feedback: string; thought: string }
  | { kind: 'fail'; message: string }
  | null

/** Refresh and summarize the verifier facts that bound a new submission. */
export function beginResponseEvidenceSession(host: ChatEngineStreamingLoopHost): ResponseEvidenceRetry {
  if (host.options.projectRoot) {
    refreshChatVerifierReceiptStalenessSync(host.options.projectRoot, host.lastVerifierReceipt)
  }
  recordChatHarnessFeedback(host, `Verification evidence at submission start: ${responseVerifierFacts(host.lastVerifierReceipt)} Never infer test execution from reading source. Preserve the requested answer format.`)
  return new ResponseEvidenceRetry()
}

/** Reconcile final, clarification, and BLOCKED responses with host-owned evidence. */
export function inspectResponseEvidence(input: {
  host: ChatEngineStreamingLoopHost
  retry: ResponseEvidenceRetry
  answer: string
  turn: number
  maxTurns: number
}): ResponseEvidenceCorrection {
  const { host, retry, answer, turn, maxTurns } = input
  if (host.options.projectRoot) {
    refreshChatVerifierReceiptStalenessSync(host.options.projectRoot, host.lastVerifierReceipt)
    for (const receipt of host.executedVerifierLedger) {
      refreshChatVerifierReceiptStalenessSync(host.options.projectRoot, receipt)
    }
  }
  const correction = retry.inspect({
    answer,
    receipt: host.lastVerifierReceipt,
    ledger: host.executedVerifierLedger,
    hasConfirmedMutation: host.hasAnyWrites(),
    turn,
    maxTurns,
  })
  if (!correction) return null
  host.conversation.push({ role: 'assistant', content: answer })
  return correction
}

/** Record a retry instruction after the streaming loop has closed its turn span. */
export function responseEvidenceRetryThought(
  host: ChatEngineStreamingLoopHost,
  correction: Extract<ResponseEvidenceCorrection, { kind: 'retry' }>,
): ChatEvent {
  recordChatHarnessFeedback(host, correction.feedback)
  return { type: 'thought', text: correction.thought }
}

/** Materialize a failed response after the caller has closed its turn span. */
export function* settleFailedResponseEvidence(
  host: ChatEngineStreamingLoopHost,
  correction: Extract<ResponseEvidenceCorrection, { kind: 'fail' }>,
  submissionGeneration: number,
): Generator<ChatEvent, void, undefined> {
  if (host._cancelled || host.abortController.signal.aborted) {
    yield host.streamCancelled()
    return
  }
  const stop = host.runControl?.owner.generation === submissionGeneration
    ? host.runControl.stop()
    : null
  if (stop) {
    yield host.streamStopped(stop)
    return
  }

  const verification = resolveCompletionVerificationContext({
    taskClass: host.taskClass,
    task: host.options.task,
    requiredVerifierCommands: host.getResolvedRequiredVerifiers(),
    toolCallLog: host.toolCallLog,
  })
  const artifactRefs = host.options.projectRoot ? unverifiedFileDeliveryPaths({
    projectRoot: host.options.projectRoot,
    taskClass: host.taskClass,
    verification,
    shellUnavailable: shellBlockedByIsolation(host.isolationBrokerFlags()),
    verifierEvidencePresent: Boolean(host.lastVerifierReceipt || host.executedVerifierLedger.length),
    verifierTampered: host.verifierTampered,
    toolCallLog: host.toolCallLog,
  }) : null
  if (!artifactRefs?.length) {
    yield host.streamFailed(correction.message)
    return
  }

  const delivery = formatPreservedUnverifiedTerminalAnswer({
    authorityReason: 'UNVERIFIED: The response could not be corrected to match recorded evidence. Confirmed file changes were read back, but required verification was unavailable; task fulfillment is not certified.',
    retainedCandidate: 'The host recorded confirmed changes to: ' + artifactRefs.join(', ') + '. No authoritative test result is recorded.',
    artifactRefs,
  })
  host.conversation.push({ role: 'assistant', content: delivery })
  if (host.isSubmissionCurrent(submissionGeneration)) {
    yield host.streamFailed(correction.message, undefined, delivery)
  }
}
