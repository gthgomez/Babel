import {
  evaluateCriterionCompletionV1,
  type CriterionCompletionServiceV1,
} from '../authority/criterionCompletion.js'
import { evaluateChatCompletionProof } from '../evidence/chatRevisionBinding.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'

export function refreshNativePathListProofCompliant(
  service?: CriterionCompletionServiceV1,
): boolean {
  service?.refreshNativePathListEvidence()
  return service?.nativePathListProofCompliant() === true
}

export function buildCriterionBackedChatCompletionProof(input: {
  projectRoot: string
  hasMutation: boolean
  verifierTampered: boolean
  receipt: BoundChatVerifierReceipt | null | undefined
  events: readonly {
    kind: string
    paths?: readonly string[]
    authoritative?: boolean
    exit_code?: number
  }[]
  isAuthoritativeCommand: (command: string) => boolean
  criterionCompletion?: CriterionCompletionServiceV1 | undefined
}): { compliant: boolean; errors?: string[] } {
  const nativePathListSatisfied = refreshNativePathListProofCompliant(
    input.criterionCompletion,
  )
  const criterionRequest = input.criterionCompletion?.currentRequest()
  return evaluateChatCompletionProof({
    projectRoot: input.projectRoot,
    hasMutation: input.hasMutation,
    verifierTampered: input.verifierTampered,
    receipt: input.receipt,
    events: input.events,
    isAuthoritativeCommand: input.isAuthoritativeCommand,
    nativePathListSatisfied,
    ...(nativePathListSatisfied && criterionRequest
      ? { criterionEvaluation: evaluateCriterionCompletionV1(criterionRequest) }
      : {}),
  })
}
