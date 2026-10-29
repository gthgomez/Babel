import type { BlockedReport } from '../schemas/agentContracts.js'
import type { TerminalReason } from './chatTerminalReason.js'
import { buildPolicyTerminalBlockedReport } from './chatZeroWritePolicy.js'
import {
  resolvePreservedUnverifiedCompletion,
  type GateRejectedCompletionCaptureHost,
} from './preservedUnverifiedTerminal.js'

type ProgressTerminalStreamDoneExtra = {
  blockedReport: BlockedReport
  reason?: TerminalReason
  preservedUnverifiedCandidate?: {
    candidate: string
    artifactRefs: readonly string[]
  }
}

/** Keep a current gate-rejected answer available for an honest blocked terminal. */
export function buildProgressTerminalStreamDoneExtra(input: {
  host: GateRejectedCompletionCaptureHost & { hasAnyWrites(): boolean }
  submissionGeneration: number
  policySource?: string | null
  terminalAnswer: string
  terminalReason?: TerminalReason
  effectiveExecutePolicy: boolean
}): ProgressTerminalStreamDoneExtra {
  const canRetain = input.policySource === 'progress_terminal' &&
    input.effectiveExecutePolicy && input.host.hasAnyWrites()
  const resolution = canRetain
    ? resolvePreservedUnverifiedCompletion(input.host, input.submissionGeneration)
    : { kind: 'absent' as const }
  const preservedUnverifiedCandidate = resolution.kind === 'retain' &&
    resolution.candidate.trim().length > 0 && resolution.artifactRefs.length > 0
    ? { candidate: resolution.candidate, artifactRefs: resolution.artifactRefs }
    : undefined

  return {
    blockedReport: buildPolicyTerminalBlockedReport(
      input.policySource ?? 'progress_terminal',
      input.terminalAnswer,
      input.terminalReason,
    ),
    ...(input.terminalReason !== undefined ? { reason: input.terminalReason } : {}),
    ...(preservedUnverifiedCandidate !== undefined
      ? { preservedUnverifiedCandidate }
      : {}),
  }
}
