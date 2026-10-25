import type { ChatMessage } from './chatToolDefinitions.js'
import type { MutationEffectStatus } from './mutationTools.js'

const GATE_REJECT_MARKER = 'COMPLETION_GATE_REJECTED:'

export type RetainedCandidateScope = {
  /** First conversation index owned by the current admitted submission. */
  submissionStartIndex: number
}

/** Model completion text eligible to survive a nonverified terminal (not controller harness feedback). */
export function isRetainedCompletionCandidateMessage(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  if (message.provenance === 'controller') return false
  if (message.name === 'harness_feedback') return false
  const content = message.content.trim()
  if (!content) return false
  if (content.startsWith('BLOCKED:')) return false
  if (content.includes(GATE_REJECT_MARKER)) return false
  return true
}

/**
 * True when assistant prose follows tool observations in this submission — a genuine
 * completion attempt, not pre-tool preamble or prior-submission text.
 */
export function isGenuineCompletionAttemptMessage(
  messages: readonly ChatMessage[],
  messageIndex: number,
  submissionStartIndex: number,
): boolean {
  const start = Math.max(0, submissionStartIndex)
  if (messageIndex < start) return false
  let sawToolObservation = false
  for (let index = messageIndex - 1; index >= start; index -= 1) {
    const prior = messages[index]!
    if (prior.role === 'tool') {
      sawToolObservation = true
      break
    }
    if (prior.role === 'assistant' && isRetainedCompletionCandidateMessage(prior)) {
      return false
    }
  }
  return sawToolObservation
}

export function findLastSubstantiveCompletionCandidate(
  messages: readonly ChatMessage[],
  scope: RetainedCandidateScope,
): string | undefined {
  const start = Math.max(0, scope.submissionStartIndex)
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]!
    if (!isRetainedCompletionCandidateMessage(message)) continue
    if (!isGenuineCompletionAttemptMessage(messages, index, start)) continue
    return message.content.trim()
  }
  return undefined
}

/** Paths from confirmed mutations only (no read/shell targets). */
export function collectConfirmedMutationArtifactPaths(
  log: ReadonlyArray<{
    tool: string
    target?: string
    mutation_paths?: readonly string[]
    effect_status?: MutationEffectStatus
  }>,
): string[] {
  const paths = new Set<string>()
  for (const entry of log) {
    if (entry.effect_status !== 'confirmed_change') continue
    for (const path of entry.mutation_paths ?? []) {
      if (path.trim()) paths.add(path.trim())
    }
  }
  return [...paths].sort()
}

/**
 * User-visible failure payload: authoritative limit/gate failure first, then explicit UNVERIFIED retained work.
 * Does not assert verification or passing tests.
 */
export function formatPreservedUnverifiedTerminalAnswer(input: {
  authorityReason: string
  retainedCandidate: string
  artifactRefs?: readonly string[]
}): string {
  const authority = input.authorityReason.trim()
  const candidate = input.retainedCandidate.trim()
  const lines = [
    authority,
    '',
    '---',
    'UNVERIFIED retained candidate (required authoritative checks were not satisfied):',
    candidate,
  ]
  if (input.artifactRefs && input.artifactRefs.length > 0) {
    lines.push('', 'Artifacts referenced in this submission:', ...input.artifactRefs.map(ref => `- ${ref}`))
  }
  return lines.join('\n')
}
