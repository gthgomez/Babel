import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

import type {
  IndependentReviewerClassV1,
  ReviewChallengeRecordV1,
  ReviewChallengeV1,
} from '../evidence/independentReview.js'

const MAX_FINITE_HOST_LIFETIME_MS = 24 * 60 * 60 * 1000
const MIN_AUTHORITY_POLL_MS = 10
const MAX_AUTHORITY_POLL_MS = 60_000
const MIN_CLEANUP_TIMEOUT_MS = 100
const MAX_CLEANUP_TIMEOUT_MS = 30_000

export interface ReviewSupervisor {
  issue(input: Omit<ReviewChallengeV1, 'challenge_id'> & {
    repository: string
    pr_number?: number
    reviewer_class: IndependentReviewerClassV1
  }): ReviewChallengeV1
  get(challengeId: string): ReviewChallengeRecordV1 | undefined
  revoke(challengeId: string): void
}

export interface ReviewSupervisorBackend extends ReviewSupervisor {}

/**
 * Keeps challenge lifecycle authority separate from substantive AI review and
 * from the builder. The backend owns supervisor signing and ledger custody.
 */
export function createReviewSupervisor(backend: ReviewSupervisorBackend): ReviewSupervisor {
  return Object.freeze({
    issue: (input: Parameters<ReviewSupervisor['issue']>[0]) => backend.issue(input),
    get: (challengeId: string) => backend.get(challengeId),
    revoke: (challengeId: string) => backend.revoke(challengeId),
  })
}

/** A finite host deadline preserves the legacy timeout contract. */
export interface FiniteReviewHostLifetime {
  kind: 'finite'
  timeoutMs: number
  cleanupTimeoutMs: number
}

/**
 * Authority-following hosts use a small recurring poll, never Infinity, zero,
 * or a timer sized to the expected task duration.
 */
export interface FollowAuthorityReviewHostLifetime {
  kind: 'follow_authority'
  pollIntervalMs: number
  cleanupTimeoutMs: number
}

export type ReviewHostLifetime = FiniteReviewHostLifetime | FollowAuthorityReviewHostLifetime

/** Construct a validated legacy-compatible finite host lifetime. */
export function finiteReviewHostLifetime(
  timeoutMs: number,
  cleanupTimeoutMs = 5_000,
): FiniteReviewHostLifetime {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_FINITE_HOST_LIFETIME_MS) {
    throw new Error('Review finite host lifetime must be a positive bounded integer.')
  }
  assertCleanupTimeout(cleanupTimeoutMs)
  return Object.freeze({ kind: 'finite', timeoutMs, cleanupTimeoutMs })
}

/** Construct a validated renewable-authority host lifetime. */
export function followReviewAuthorityLifetime(input: {
  pollIntervalMs?: number
  cleanupTimeoutMs?: number
} = {}): FollowAuthorityReviewHostLifetime {
  const pollIntervalMs = input.pollIntervalMs ?? 1_000
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? 5_000
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < MIN_AUTHORITY_POLL_MS ||
    pollIntervalMs > MAX_AUTHORITY_POLL_MS
  ) {
    throw new Error('Review authority poll interval must be a bounded positive integer.')
  }
  assertCleanupTimeout(cleanupTimeoutMs)
  return Object.freeze({ kind: 'follow_authority', pollIntervalMs, cleanupTimeoutMs })
}

function assertCleanupTimeout(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_CLEANUP_TIMEOUT_MS ||
    value > MAX_CLEANUP_TIMEOUT_MS
  ) {
    throw new Error('Review cleanup timeout must be a bounded positive integer.')
  }
}

export interface ReviewAuthorityCandidate {
  repository: string
  prNumber?: number
  baseSha: string
  headSha: string
  candidateDigest: string
}

/**
 * Task allowance metadata is evidence owned by the task controller. The review
 * host preserves it but never decrements, extends, or mints it.
 */
export interface ReviewTaskAllowance {
  allowanceId: string
  taskId: string
  executionId: string
  startedAt: string
  elapsedLimitMs: number
  evidenceLineage: string[]
}

export interface RenewableReviewAuthority {
  schemaVersion: 1
  taskId: string
  executionId: string
  fencingEpoch: number
  candidate: ReviewAuthorityCandidate
  candidateDigest: string
  allowanceIdentity: string
  issuedAt: string
  expiresAt: string
}

export type ReviewAuthorityTerminalCause =
  | 'authority_expired'
  | 'candidate_changed'
  | 'controller_lost'
  | 'finite_timeout'
  | 'host_abort'
  | 'cleanup_timeout'
  | 'worker_exit'

export interface ReviewAuthorityCheckpoint {
  schemaVersion: 1
  kind: 'review_authority_checkpoint_v1'
  candidate: ReviewAuthorityCandidate
  allowance: ReviewTaskAllowance
  authority: RenewableReviewAuthority
  status: 'active' | 'terminal'
  terminalCause?: ReviewAuthorityTerminalCause
  mutationReplayAllowed: false
}

export type ReviewAuthorityAdmission =
  | { admitted: true; authority: RenewableReviewAuthority }
  | { admitted: false; cause: ReviewAuthorityTerminalCause }

export interface ReviewAuthorityMonitor {
  inspect(candidate: ReviewAuthorityCandidate): ReviewAuthorityAdmission
  snapshot(): ReviewAuthorityCheckpoint
  recordTerminal(cause: ReviewAuthorityTerminalCause): void
}

export interface ReviewAuthorityController {
  renew(input: {
    fencingEpoch: number
    candidate: ReviewAuthorityCandidate
    issuedAt: string
    expiresAt: string
  }): RenewableReviewAuthority
  observeCandidate(candidate: ReviewAuthorityCandidate): void
  stop(cause: ReviewAuthorityTerminalCause): void
  admitPublication(input: {
    candidate: ReviewAuthorityCandidate
    authority: RenewableReviewAuthority
  }): {
    admitted: true
    fencingEpoch: number
    candidateDigest: string
  }
}

export interface ReviewAuthoritySupervisor {
  monitor: ReviewAuthorityMonitor
  controller: ReviewAuthorityController
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`Review authority ${field} is required.`)
}

function assertInstant(value: string, field: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`Review authority ${field} must be an ISO timestamp.`)
  return parsed
}

function assertCandidate(candidate: ReviewAuthorityCandidate): void {
  requireText(candidate.repository, 'repository')
  if (candidate.prNumber !== undefined && (!Number.isSafeInteger(candidate.prNumber) || candidate.prNumber < 1)) {
    throw new Error('Review authority prNumber must be positive.')
  }
  if (!/^[a-f0-9]{40}$/i.test(candidate.baseSha)) throw new Error('Review authority baseSha must be a full SHA.')
  if (!/^[a-f0-9]{40}$/i.test(candidate.headSha)) throw new Error('Review authority headSha must be a full SHA.')
  if (!/^[a-f0-9]{64}$/i.test(candidate.candidateDigest)) throw new Error('Review authority candidateDigest must be SHA-256.')
}

function assertAllowance(allowance: ReviewTaskAllowance): void {
  requireText(allowance.allowanceId, 'allowanceId')
  requireText(allowance.taskId, 'taskId')
  requireText(allowance.executionId, 'executionId')
  assertInstant(allowance.startedAt, 'allowance.startedAt')
  if (!Number.isSafeInteger(allowance.elapsedLimitMs) || allowance.elapsedLimitMs < 1) {
    throw new Error('Review authority elapsedLimitMs must be positive.')
  }
  if (!Array.isArray(allowance.evidenceLineage) || allowance.evidenceLineage.some((entry) => !entry.trim())) {
    throw new Error('Review authority evidenceLineage is invalid.')
  }
}

function candidatesMatch(left: ReviewAuthorityCandidate, right: ReviewAuthorityCandidate): boolean {
  return left.repository === right.repository &&
    left.prNumber === right.prNumber &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha &&
    left.candidateDigest === right.candidateDigest
}

function copyCandidate(candidate: ReviewAuthorityCandidate): ReviewAuthorityCandidate {
  return Object.freeze({ ...candidate })
}

function copyAllowance(allowance: ReviewTaskAllowance): ReviewTaskAllowance {
  return Object.freeze({
    ...allowance,
    evidenceLineage: Object.freeze([...allowance.evidenceLineage]) as unknown as string[],
  })
}

function copyAuthority(authority: RenewableReviewAuthority): RenewableReviewAuthority {
  return Object.freeze({ ...authority, candidate: copyCandidate(authority.candidate) })
}

function copyCheckpoint(state: ReviewAuthorityCheckpoint): ReviewAuthorityCheckpoint {
  return Object.freeze({
    ...state,
    candidate: copyCandidate(state.candidate),
    allowance: copyAllowance(state.allowance),
    authority: copyAuthority(state.authority),
  })
}

function assertAuthorityBinding(
  authority: RenewableReviewAuthority,
  candidate: ReviewAuthorityCandidate,
  allowance: ReviewTaskAllowance,
): void {
  if (authority.schemaVersion !== 1) throw new Error('Review authority schema version is invalid.')
  if (authority.taskId !== allowance.taskId || authority.executionId !== allowance.executionId) {
    throw new Error('Review authority task binding mismatch.')
  }
  if (authority.allowanceIdentity !== allowance.allowanceId) {
    throw new Error('Review authority allowance binding mismatch.')
  }
  if (!Number.isSafeInteger(authority.fencingEpoch) || authority.fencingEpoch < 1) {
    throw new Error('Review authority fencing epoch is invalid.')
  }
  if (!candidatesMatch(authority.candidate, candidate) || authority.candidateDigest !== candidate.candidateDigest) {
    throw new Error('Review authority candidate binding mismatch.')
  }
  const issuedAt = assertInstant(authority.issuedAt, 'issuedAt')
  const expiresAt = assertInstant(authority.expiresAt, 'expiresAt')
  if (expiresAt <= issuedAt) throw new Error('Review authority expiresAt must be after issuedAt.')
}

function terminalCode(cause: ReviewAuthorityTerminalCause): string {
  return cause === 'candidate_changed'
    ? 'REVIEW_AUTHORITY_CANDIDATE_CHANGED'
    : cause === 'authority_expired'
      ? 'REVIEW_AUTHORITY_EXPIRED'
      : cause === 'controller_lost'
        ? 'REVIEW_AUTHORITY_CONTROLLER_LOST'
        : `REVIEW_AUTHORITY_${cause.toUpperCase()}`
}

function writeCheckpoint(path: string, state: ReviewAuthorityCheckpoint): void {
  const resolved = resolve(path)
  mkdirSync(dirname(resolved), { recursive: true })
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(state)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, resolved)
}

function validateCheckpoint(value: unknown): ReviewAuthorityCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Review authority checkpoint shape is invalid.')
  }
  const state = value as ReviewAuthorityCheckpoint
  if (state.schemaVersion !== 1 || state.kind !== 'review_authority_checkpoint_v1') {
    throw new Error('Review authority checkpoint version is invalid.')
  }
  assertCandidate(state.candidate)
  assertAllowance(state.allowance)
  assertAuthorityBinding(state.authority, state.candidate, state.allowance)
  if (state.mutationReplayAllowed !== false) {
    throw new Error('Review authority checkpoint cannot authorize mutation replay.')
  }
  if (state.status !== 'active' && state.status !== 'terminal') {
    throw new Error('Review authority checkpoint status is invalid.')
  }
  if (state.status === 'terminal' && !state.terminalCause) {
    throw new Error('Review authority terminal checkpoint requires a cause.')
  }
  return copyCheckpoint(state)
}

function buildSupervisor(input: {
  statePath: string
  initial: ReviewAuthorityCheckpoint
  now: () => number
  persistInitial: boolean
}): ReviewAuthoritySupervisor {
  let state = copyCheckpoint(input.initial)

  const save = (): void => writeCheckpoint(input.statePath, state)
  if (input.persistInitial) save()

  const terminate = (cause: ReviewAuthorityTerminalCause): void => {
    if (state.status === 'terminal') return
    state = copyCheckpoint({ ...state, status: 'terminal', terminalCause: cause })
    save()
  }

  const requireActive = (): void => {
    if (state.status === 'terminal') throw new Error(terminalCode(state.terminalCause!))
    if (Date.parse(state.authority.expiresAt) <= input.now()) {
      terminate('authority_expired')
      throw new Error('REVIEW_AUTHORITY_EXPIRED')
    }
  }

  const monitor: ReviewAuthorityMonitor = Object.freeze({
    inspect(candidate: ReviewAuthorityCandidate): ReviewAuthorityAdmission {
      assertCandidate(candidate)
      if (state.status === 'terminal') return { admitted: false, cause: state.terminalCause! }
      if (!candidatesMatch(candidate, state.candidate)) {
        terminate('candidate_changed')
        return { admitted: false, cause: 'candidate_changed' }
      }
      if (Date.parse(state.authority.expiresAt) <= input.now()) {
        terminate('authority_expired')
        return { admitted: false, cause: 'authority_expired' }
      }
      return { admitted: true, authority: copyAuthority(state.authority) }
    },
    snapshot(): ReviewAuthorityCheckpoint {
      return copyCheckpoint(state)
    },
    recordTerminal(cause: ReviewAuthorityTerminalCause): void {
      terminate(cause)
    },
  })

  const controller: ReviewAuthorityController = Object.freeze({
    renew(renewal: Parameters<ReviewAuthorityController['renew']>[0]): RenewableReviewAuthority {
      requireActive()
      if (!candidatesMatch(renewal.candidate, state.candidate)) {
        terminate('candidate_changed')
        throw new Error('REVIEW_AUTHORITY_CANDIDATE_CHANGED')
      }
      if (renewal.fencingEpoch !== state.authority.fencingEpoch) {
        throw new Error('REVIEW_AUTHORITY_STALE_FENCE')
      }
      const issuedAt = assertInstant(renewal.issuedAt, 'issuedAt')
      const expiresAt = assertInstant(renewal.expiresAt, 'expiresAt')
      if (issuedAt < Date.parse(state.authority.issuedAt) || expiresAt <= issuedAt || expiresAt <= input.now()) {
        throw new Error('REVIEW_AUTHORITY_RENEWAL_WINDOW_INVALID')
      }
      const authority: RenewableReviewAuthority = {
        ...state.authority,
        fencingEpoch: state.authority.fencingEpoch + 1,
        issuedAt: renewal.issuedAt,
        expiresAt: renewal.expiresAt,
      }
      state = copyCheckpoint({ ...state, authority })
      save()
      return copyAuthority(authority)
    },
    observeCandidate(candidate: ReviewAuthorityCandidate): void {
      assertCandidate(candidate)
      if (!candidatesMatch(candidate, state.candidate)) terminate('candidate_changed')
    },
    stop(cause: ReviewAuthorityTerminalCause): void {
      terminate(cause)
    },
    admitPublication(publication: Parameters<ReviewAuthorityController['admitPublication']>[0]) {
      requireActive()
      if (!candidatesMatch(publication.candidate, state.candidate)) {
        terminate('candidate_changed')
        throw new Error('REVIEW_AUTHORITY_CANDIDATE_CHANGED')
      }
      assertAuthorityBinding(publication.authority, state.candidate, state.allowance)
      if (publication.authority.fencingEpoch !== state.authority.fencingEpoch) {
        throw new Error('REVIEW_AUTHORITY_STALE_FENCE')
      }
      if (
        publication.authority.issuedAt !== state.authority.issuedAt ||
        publication.authority.expiresAt !== state.authority.expiresAt
      ) {
        throw new Error('REVIEW_AUTHORITY_STALE_FENCE')
      }
      return {
        admitted: true as const,
        fencingEpoch: state.authority.fencingEpoch,
        candidateDigest: state.candidate.candidateDigest,
      }
    },
  })

  return Object.freeze({ monitor, controller })
}

/** Create a host-owned renewable authority bound to one task and candidate. */
export function createReviewAuthoritySupervisor(input: {
  statePath: string
  candidate: ReviewAuthorityCandidate
  allowance: ReviewTaskAllowance
  issuedAt: string
  expiresAt: string
  now?: () => number
}): ReviewAuthoritySupervisor {
  assertCandidate(input.candidate)
  assertAllowance(input.allowance)
  const authority: RenewableReviewAuthority = {
    schemaVersion: 1,
    taskId: input.allowance.taskId,
    executionId: input.allowance.executionId,
    fencingEpoch: 1,
    candidate: copyCandidate(input.candidate),
    candidateDigest: input.candidate.candidateDigest,
    allowanceIdentity: input.allowance.allowanceId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  }
  assertAuthorityBinding(authority, input.candidate, input.allowance)
  return buildSupervisor({
    statePath: input.statePath,
    now: input.now ?? Date.now,
    persistInitial: true,
    initial: {
      schemaVersion: 1,
      kind: 'review_authority_checkpoint_v1',
      candidate: copyCandidate(input.candidate),
      allowance: copyAllowance(input.allowance),
      authority,
      status: 'active',
      mutationReplayAllowed: false,
    },
  })
}

/** Restore exact authority/allowance/evidence state; restoration cannot mint allowance. */
export function restoreReviewAuthoritySupervisor(input: {
  statePath: string
  now?: () => number
}): ReviewAuthoritySupervisor {
  const initial = validateCheckpoint(JSON.parse(readFileSync(resolve(input.statePath), 'utf8')))
  return buildSupervisor({
    statePath: input.statePath,
    initial,
    now: input.now ?? Date.now,
    persistInitial: false,
  })
}
