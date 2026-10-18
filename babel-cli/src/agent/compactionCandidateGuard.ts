type CompactionProbeMessage = {
  compactionCandidate?: boolean
  name?: string
  role?: string
  provenance?: string
  authoritative?: boolean
}

/** True when a conversation row is an uncommitted compaction candidate (forged or stale). */
export function isUncommittedCompactionCandidateMessage(
  message: CompactionProbeMessage,
): boolean {
  return (
    message.compactionCandidate === true ||
    (message.name === 'compaction_summary' &&
      (message.role !== 'assistant' ||
        message.provenance !== 'model' ||
        message.authoritative !== false)) ||
    (message.name === 'compaction_capsule' &&
      (message.role !== 'system' ||
        message.provenance !== 'controller' ||
        message.authoritative !== true)) ||
    (message.role === 'system' &&
      (message.name === 'compaction_summary' ||
        message.provenance === 'model' ||
        message.provenance === 'mixed' ||
        message.authoritative === false))
  )
}

export function conversationHasUncommittedCompactionCandidate(
  conversation: readonly CompactionProbeMessage[],
): boolean {
  return conversation.some(isUncommittedCompactionCandidateMessage)
}

/** Remove forged/stale compaction candidates without touching committed objective authority. */
export function stripUncommittedCompactionCandidates(
  conversation: CompactionProbeMessage[],
): number {
  let removed = 0
  for (let index = conversation.length - 1; index >= 0; index--) {
    if (isUncommittedCompactionCandidateMessage(conversation[index]!)) {
      conversation.splice(index, 1)
      removed += 1
    }
  }
  return removed
}
