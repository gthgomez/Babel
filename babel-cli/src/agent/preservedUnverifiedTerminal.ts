import type { ChatMessage } from './chatToolDefinitions.js'

const GATE_REJECT_MARKER = 'COMPLETION_GATE_REJECTED:'

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

export function findLastSubstantiveCompletionCandidate(
  messages: readonly ChatMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (!isRetainedCompletionCandidateMessage(message)) continue
    return message.content.trim()
  }
  return undefined
}

export function collectArtifactRefsFromToolLog(
  log: ReadonlyArray<{ tool: string; target?: string; mutation_paths?: readonly string[] }>,
): string[] {
  const paths = new Set<string>()
  for (const entry of log) {
    if (entry.target?.trim()) paths.add(entry.target.trim())
    for (const path of entry.mutation_paths ?? []) {
      if (path.trim()) paths.add(path.trim())
    }
  }
  return [...paths].sort()
}

/**
 * User-visible terminal: authoritative limit/gate failure first, then explicit UNVERIFIED retained work.
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
