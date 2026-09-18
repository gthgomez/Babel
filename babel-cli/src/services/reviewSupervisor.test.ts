import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  createReviewAuthoritySupervisor,
  finiteReviewHostLifetime,
  followReviewAuthorityLifetime,
  restoreReviewAuthoritySupervisor,
  type ReviewAuthorityCandidate,
  type ReviewTaskAllowance,
} from './reviewSupervisor.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-authority-'))
  roots.push(root)
  const statePath = join(root, 'authority.json')
  const candidate: ReviewAuthorityCandidate = {
    repository: 'gthgomez/Babel',
    prNumber: 201,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    candidateDigest: 'c'.repeat(64),
  }
  const allowance: ReviewTaskAllowance = {
    allowanceId: 'allowance-201',
    taskId: 'task-201',
    executionId: 'execution-201',
    startedAt: '2026-09-18T05:00:00.000Z',
    elapsedLimitMs: 50,
    evidenceLineage: ['candidate-collected', 'snapshot-verified'],
  }
  return { root, statePath, candidate, allowance }
}

describe('trusted review authority-following lifetime', () => {
  it('represents finite and follow-authority host lifetimes without sentinel timer values', () => {
    assert.deepEqual(finiteReviewHostLifetime(1_260_000), {
      kind: 'finite',
      timeoutMs: 1_260_000,
      cleanupTimeoutMs: 5_000,
    })
    assert.deepEqual(followReviewAuthorityLifetime({ pollIntervalMs: 25, cleanupTimeoutMs: 750 }), {
      kind: 'follow_authority',
      pollIntervalMs: 25,
      cleanupTimeoutMs: 750,
    })
    for (const invalid of [0, Number.POSITIVE_INFINITY, 2 ** 31]) {
      assert.throws(() => finiteReviewHostLifetime(invalid), /finite host lifetime/i)
    }
  })

  it('keeps task elapsed allowance independent from renewable host authority', () => {
    const { statePath, candidate, allowance } = fixture()
    let now = Date.parse('2026-09-18T05:00:00.000Z')
    const supervisor = createReviewAuthoritySupervisor({
      statePath,
      candidate,
      allowance,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10_000).toISOString(),
      now: () => now,
    })

    now += allowance.elapsedLimitMs + 1
    const admission = supervisor.monitor.inspect(candidate)
    assert.equal(admission.admitted, true, 'host authority must not consume or reinterpret task elapsed allowance')
    assert.equal(supervisor.monitor.snapshot().allowance.elapsedLimitMs, 50)
    assert.equal('renew' in supervisor.monitor, false, 'worker-facing monitor cannot mint or renew authority')
  })

  it('renews only at the current fence and rejects stale renewals and publication', () => {
    const { statePath, candidate, allowance } = fixture()
    let now = Date.parse('2026-09-18T05:00:00.000Z')
    const supervisor = createReviewAuthoritySupervisor({
      statePath,
      candidate,
      allowance,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 1_000).toISOString(),
      now: () => now,
    })
    const first = supervisor.monitor.snapshot().authority

    now += 100
    const renewed = supervisor.controller.renew({
      fencingEpoch: first.fencingEpoch,
      candidate,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 1_000).toISOString(),
    })
    assert.equal(renewed.fencingEpoch, first.fencingEpoch + 1)
    assert.throws(() => supervisor.controller.renew({
      fencingEpoch: first.fencingEpoch,
      candidate,
      issuedAt: new Date(now + 1).toISOString(),
      expiresAt: new Date(now + 1_001).toISOString(),
    }), /STALE_FENCE/)
    assert.throws(() => supervisor.controller.admitPublication({ candidate, authority: first }), /STALE_FENCE/)
    assert.deepEqual(supervisor.controller.admitPublication({ candidate, authority: renewed }), {
      admitted: true,
      fencingEpoch: renewed.fencingEpoch,
      candidateDigest: candidate.candidateDigest,
    })
  })

  it('invalidates renewal and publication when repository, PR, base, head, or digest changes', () => {
    const fields: Array<keyof ReviewAuthorityCandidate> = [
      'repository',
      'prNumber',
      'baseSha',
      'headSha',
      'candidateDigest',
    ]
    for (const field of fields) {
      const { statePath, candidate, allowance } = fixture()
      const now = Date.parse('2026-09-18T05:00:00.000Z')
      const supervisor = createReviewAuthoritySupervisor({
        statePath,
        candidate,
        allowance,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 10_000).toISOString(),
        now: () => now,
      })
      const changed: ReviewAuthorityCandidate = {
        ...candidate,
        [field]: field === 'prNumber'
          ? candidate.prNumber! + 1
          : field === 'repository'
            ? 'gthgomez/Another'
            : field === 'candidateDigest'
              ? 'd'.repeat(64)
              : 'e'.repeat(40),
      }
      supervisor.controller.observeCandidate(changed)
      const stopped = supervisor.monitor.inspect(candidate)
      assert.equal(stopped.admitted, false, `${field} change must stop authority`)
      if (!stopped.admitted) assert.equal(stopped.cause, 'candidate_changed')
      assert.throws(() => supervisor.controller.renew({
        fencingEpoch: supervisor.monitor.snapshot().authority.fencingEpoch,
        candidate,
        issuedAt: new Date(now + 1).toISOString(),
        expiresAt: new Date(now + 10_001).toISOString(),
      }), /CANDIDATE_CHANGED/)
      assert.throws(() => supervisor.controller.admitPublication({
        candidate,
        authority: supervisor.monitor.snapshot().authority,
      }), /CANDIDATE_CHANGED/)
    }
  })

  it('restores task, allowance, authority fence, and evidence lineage without minting allowance', () => {
    const { statePath, candidate, allowance } = fixture()
    let now = Date.parse('2026-09-18T05:00:00.000Z')
    const initial = createReviewAuthoritySupervisor({
      statePath,
      candidate,
      allowance,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10_000).toISOString(),
      now: () => now,
    })
    const renewed = initial.controller.renew({
      fencingEpoch: 1,
      candidate,
      issuedAt: new Date(now + 100).toISOString(),
      expiresAt: new Date(now + 10_100).toISOString(),
    })
    assert.equal(existsSync(statePath), true)

    now += 200
    const restored = restoreReviewAuthoritySupervisor({ statePath, now: () => now })
    const checkpoint = restored.monitor.snapshot()
    assert.equal(checkpoint.allowance.allowanceId, allowance.allowanceId)
    assert.equal(checkpoint.allowance.taskId, allowance.taskId)
    assert.equal(checkpoint.allowance.executionId, allowance.executionId)
    assert.deepEqual(checkpoint.allowance.evidenceLineage, allowance.evidenceLineage)
    assert.equal(checkpoint.authority.fencingEpoch, renewed.fencingEpoch)
    assert.equal(checkpoint.mutationReplayAllowed, false)
    assert.equal('issueAllowance' in restored.controller, false)
  })

  it('turns controller loss or expiry into a terminal stop admission and durable cause', () => {
    const { statePath, candidate, allowance } = fixture()
    let now = Date.parse('2026-09-18T05:00:00.000Z')
    const supervisor = createReviewAuthoritySupervisor({
      statePath,
      candidate,
      allowance,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 100).toISOString(),
      now: () => now,
    })
    supervisor.controller.stop('controller_lost')
    const stopped = supervisor.monitor.inspect(candidate)
    assert.equal(stopped.admitted, false)
    if (!stopped.admitted) assert.equal(stopped.cause, 'controller_lost')

    const second = createReviewAuthoritySupervisor({
      statePath: join(fixture().root, 'expired.json'),
      candidate,
      allowance,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 100).toISOString(),
      now: () => now,
    })
    now += 101
    const expired = second.monitor.inspect(candidate)
    assert.equal(expired.admitted, false)
    if (!expired.admitted) assert.equal(expired.cause, 'authority_expired')
    assert.equal(second.monitor.snapshot().terminalCause, 'authority_expired')
  })
})
