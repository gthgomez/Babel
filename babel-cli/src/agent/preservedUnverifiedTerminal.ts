import type { ChatMessage } from './chatToolDefinitions.js'
import {
  assessMutationEffect,
  type MutationEffectScope,
  type MutationEffectStatus,
} from './mutationTools.js'

const GATE_REJECT_MARKER = 'COMPLETION_GATE_REJECTED:'

/** Snapshot taken at the first completion gate reject_continue in a submission. */
export type GateRejectedCompletionCapture = {
  submissionGeneration: number
  candidateText: string
  mutationRevisionKey: string
  artifactRefs: readonly string[]
}

export type PreservedUnverifiedTurnLimitResolution =
  | { kind: 'retain'; candidate: string; artifactRefs: readonly string[] }
  | { kind: 'stale_revision' }
  | { kind: 'absent' }

type ConfirmedMutationLogEntry = ReadonlyArray<{
  tool: string
  mutation_paths?: readonly string[]
  effect_status?: MutationEffectStatus
}>

const gateRejectedCompletionByHost = new WeakMap<
  object,
  GateRejectedCompletionCapture | null
>()

/** Streaming host surface for gate-seam capture (submission generation + tool log). */
export type GateRejectedCompletionCaptureHost = {
  toolCallLog: ConfirmedMutationLogEntry
  isSubmissionCurrent: (submissionGeneration: number) => boolean
}

function readGateRejectedCompletion(
  host: GateRejectedCompletionCaptureHost,
): GateRejectedCompletionCapture | null {
  return gateRejectedCompletionByHost.get(host) ?? null
}

export function resetGateRejectedCompletionCapture(
  host: GateRejectedCompletionCaptureHost,
): void {
  gateRejectedCompletionByHost.set(host, null)
}

export function captureGateRejectedCompletionAttempt(
  host: GateRejectedCompletionCaptureHost,
  answer: string,
  submissionGeneration: number,
): void {
  if (!host.isSubmissionCurrent(submissionGeneration)) return
  gateRejectedCompletionByHost.set(
    host,
    tryRecordGateRejectedCompletionCapture(
      readGateRejectedCompletion(host),
      answer,
      host.toolCallLog,
      submissionGeneration,
    ),
  )
}

export function resolvePreservedUnverifiedAtTurnLimit(
  host: GateRejectedCompletionCaptureHost,
  submissionGeneration: number,
): PreservedUnverifiedTurnLimitResolution {
  return resolveGateRejectedCompletionCapture(
    readGateRejectedCompletion(host),
    host.toolCallLog,
    submissionGeneration,
  )
}

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
 * Fingerprint of recorded confirmed mutations in the tool call log at capture or resolve time.
 * Compares harness-recorded mutation metadata only — not on-disk file hashes and not out-of-band edits.
 */
export function buildConfirmedMutationRevisionKey(
  log: ReadonlyArray<{
    tool: string
    mutation_paths?: readonly string[]
    effect_status?: MutationEffectStatus
  }>,
): string {
  const parts: string[] = []
  for (const entry of log) {
    if (entry.effect_status !== 'confirmed_change') continue
    const paths = [...(entry.mutation_paths ?? [])].map(p => p.trim()).filter(Boolean).sort()
    parts.push(`${entry.tool}:${paths.join(',')}`)
  }
  return parts.join('|')
}

/** Workspace mutator per existing {@link assessMutationEffect} candidate rules (not a second tool list). */
function isWorkspaceMutationEffectCandidate(tool: string): boolean {
  return assessMutationEffect({ tool }).status !== 'not_applicable'
}

/**
 * In-tree sub_agent effects logged with authoritative scope (see chatEngineChildExecution).
 * Isolated-child indeterminate effects are intentionally excluded from parent freshness.
 */
function isRelevantIndeterminateParentCandidateChildEffect(entry: {
  tool: string
  effect_status?: MutationEffectStatus
  effect_scope?: MutationEffectScope
  error?: string | null
}): boolean {
  if (entry.tool !== 'sub_agent' || entry.effect_status !== 'indeterminate') return false
  if (entry.error === 'blocked') return false
  if (entry.effect_scope === 'isolated_child') return false
  return entry.effect_scope === 'parent_candidate' || entry.effect_scope === 'unknown'
}

/**
 * Logged indeterminate mutation metadata: freshness is unknown for workspace mutators and for
 * parent-candidate (or unknown-scope) sub_agent effects recorded by the child execution seam.
 */
function hasRelevantIndeterminateMutation(
  log: ReadonlyArray<{
    tool: string
    mutation_paths?: readonly string[]
    effect_status?: MutationEffectStatus
    effect_scope?: MutationEffectScope
    error?: string | null
  }>,
): boolean {
  for (const entry of log) {
    if (entry.effect_status !== 'indeterminate') continue
    if (isWorkspaceMutationEffectCandidate(entry.tool)) return true
    if (isRelevantIndeterminateParentCandidateChildEffect(entry)) return true
  }
  return false
}

function isEligibleGateRejectedCompletionAnswer(answer: string): boolean {
  const trimmed = answer.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('BLOCKED:')) return false
  if (trimmed.includes(GATE_REJECT_MARKER)) return false
  return true
}

/**
 * Record the first gate-rejected completion attempt for this submission (historical capture only).
 * Same submission generation never replaces an existing capture — including after confirmed writes
 * or recovery chatter at a newer mutation revision.
 *
 * Deferred to admission-context work (not solved here): post-write deliverable replacement and
 * same-revision correction require trustworthy host-recognized answer-repair/deliverable provenance.
 * Without that, resolve returns `stale_revision` when the tool log revision no longer matches the
 * capture fingerprint — the historical capture is not presented as current.
 */
export function tryRecordGateRejectedCompletionCapture(
  existing: GateRejectedCompletionCapture | null,
  answer: string,
  log: ReadonlyArray<{
    tool: string
    mutation_paths?: readonly string[]
    effect_status?: MutationEffectStatus
  }>,
  submissionGeneration: number,
): GateRejectedCompletionCapture | null {
  const frozen =
    existing?.submissionGeneration === submissionGeneration ? existing : null
  if (frozen) return frozen
  if (!isEligibleGateRejectedCompletionAnswer(answer)) return frozen
  const mutationRevisionKey = buildConfirmedMutationRevisionKey(log)
  return {
    submissionGeneration,
    candidateText: answer.trim(),
    mutationRevisionKey,
    artifactRefs: collectConfirmedMutationArtifactPaths(log),
  }
}

/** Resolve capture for turn-limit preservation (submission generation + mutation revision). */
export function resolveGateRejectedCompletionCapture(
  capture: GateRejectedCompletionCapture | null,
  log: ReadonlyArray<{
    tool: string
    mutation_paths?: readonly string[]
    effect_status?: MutationEffectStatus
  }>,
  submissionGeneration: number,
): PreservedUnverifiedTurnLimitResolution {
  if (!capture) return { kind: 'absent' }
  if (capture.submissionGeneration !== submissionGeneration) return { kind: 'absent' }
  if (hasRelevantIndeterminateMutation(log)) return { kind: 'stale_revision' }
  if (buildConfirmedMutationRevisionKey(log) !== capture.mutationRevisionKey) {
    return { kind: 'stale_revision' }
  }
  return {
    kind: 'retain',
    candidate: capture.candidateText,
    artifactRefs: capture.artifactRefs,
  }
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
