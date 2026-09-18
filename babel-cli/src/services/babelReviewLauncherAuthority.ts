import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

import {
  followReviewAuthorityLifetime,
  restoreReviewAuthoritySupervisor,
  type FollowAuthorityReviewHostLifetime,
  type ReviewAuthorityCandidate,
  type ReviewAuthorityCheckpoint,
  type ReviewAuthorityMonitor,
  type ReviewAuthorityTerminalCause,
} from './reviewSupervisor.js'

const AUTHORITY_CHECKPOINT_NAME = 'authority.json'
const MIN_RENEWAL_INTERVAL_MS = 250
const MAX_RENEWAL_INTERVAL_MS = 30_000

export interface BabelReviewLauncherAuthority {
  candidate: ReviewAuthorityCandidate
  executionId: string
  hostLifetime: FollowAuthorityReviewHostLifetime
  monitor: ReviewAuthorityMonitor
  renewalIntervalMs: number
  renew(candidate: ReviewAuthorityCandidate, now?: number): void
  admitPublication(candidate: ReviewAuthorityCandidate): void
  stop(cause: ReviewAuthorityTerminalCause): void
  snapshot(): ReviewAuthorityCheckpoint
}

function copyCandidate(candidate: ReviewAuthorityCandidate): ReviewAuthorityCandidate {
  return Object.freeze({ ...candidate })
}

/**
 * Restore an externally issued authority from the controller's private job
 * directory. Absence preserves the legacy finite launcher path; this adapter
 * never creates an allowance or an initial authority.
 */
export function restoreBabelReviewLauncherAuthority(input: {
  jobDir: string
  taskId: string
  candidate: ReviewAuthorityCandidate
}): BabelReviewLauncherAuthority | null {
  const statePath = join(input.jobDir, AUTHORITY_CHECKPOINT_NAME)
  if (!existsSync(statePath)) return null
  const file = lstatSync(statePath)
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('REVIEW_AUTHORITY_CHECKPOINT_UNSAFE')

  const supervisor = restoreReviewAuthoritySupervisor({ statePath })
  const initial = supervisor.monitor.snapshot()
  if (initial.allowance.taskId !== input.taskId) throw new Error('REVIEW_AUTHORITY_TASK_MISMATCH')
  const admission = supervisor.monitor.inspect(input.candidate)
  if (!admission.admitted) throw new Error(`REVIEW_AUTHORITY_${admission.cause.toUpperCase()}`)

  const renewalWindowMs = Date.parse(initial.authority.expiresAt) - Date.parse(initial.authority.issuedAt)
  if (!Number.isSafeInteger(renewalWindowMs) || renewalWindowMs < 1) {
    throw new Error('REVIEW_AUTHORITY_RENEWAL_WINDOW_INVALID')
  }
  const renewalIntervalMs = Math.max(
    MIN_RENEWAL_INTERVAL_MS,
    Math.min(MAX_RENEWAL_INTERVAL_MS, Math.floor(renewalWindowMs / 3)),
  )
  const exactCandidate = copyCandidate(input.candidate)

  return Object.freeze({
    candidate: exactCandidate,
    executionId: initial.allowance.executionId,
    hostLifetime: followReviewAuthorityLifetime(),
    monitor: supervisor.monitor,
    renewalIntervalMs,
    renew(candidate: ReviewAuthorityCandidate, now = Date.now()): void {
      supervisor.controller.observeCandidate(candidate)
      const current = supervisor.monitor.snapshot()
      const issuedAtMs = Math.max(now, Date.parse(current.authority.issuedAt))
      supervisor.controller.renew({
        fencingEpoch: current.authority.fencingEpoch,
        candidate,
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: new Date(issuedAtMs + renewalWindowMs).toISOString(),
      })
    },
    admitPublication(candidate: ReviewAuthorityCandidate): void {
      supervisor.controller.observeCandidate(candidate)
      const current = supervisor.monitor.inspect(candidate)
      if (!current.admitted) throw new Error(`REVIEW_AUTHORITY_${current.cause.toUpperCase()}`)
      supervisor.controller.admitPublication({ candidate, authority: current.authority })
    },
    stop(cause: ReviewAuthorityTerminalCause): void {
      supervisor.controller.stop(cause)
    },
    snapshot(): ReviewAuthorityCheckpoint {
      return supervisor.monitor.snapshot()
    },
  })
}
