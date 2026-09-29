import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { CandidateEnvelope } from './hostReviewController.js'
import { prepareHarnessReview, submitHarnessReview, runHarnessReview, executePreparedHarnessReviewSlot, executePreparedHarnessReviewRun, readHarnessReviewHandoff, withHarnessReviewPublicationLock, reviewMission } from './harnessReviewProtocol.js'
import { completeReviewChallenge } from './independentReviewController.js'

const builder = { kind: 'codex', principal_id: 'builder', execution_id: 'parent-thread' }
const candidate = {
  schema_version: 2, repository: 'gthgomez/Babel', pr_number: 267,
  task_id: 'pr-267', task_hash: 'e'.repeat(64), base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40), builder_id: 'builder', diff_numstat_digest: 'd'.repeat(64),
  scope: ['src/file.ts'], candidate_digest: 'c'.repeat(64), risk_tier: 'NORMAL',
  trust_mode: 'SELF_REVIEW', created_at: new Date().toISOString(),
} as CandidateEnvelope

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-review-'))
  const snapshotRoot = join(stateDir, 'snapshot')
  const diff = 'diff --git a/src/file.ts b/src/file.ts\n+change\n'
  mkdirSync(snapshotRoot)
  writeFileSync(join(snapshotRoot, 'changes.diff'), diff)
  return { stateDir, snapshotRoot, diff, diffSha256: createHash('sha256').update(diff).digest('hex') }
}

function protectedFixture() {
  const f = fixture()
  const trustedControllerRoot = join(f.stateDir, 'trusted-controller')
  mkdirSync(trustedControllerRoot)
  const git = (args: string[]) => execFileSync('git', ['-C', trustedControllerRoot, ...args], { encoding: 'utf8' }).trim()
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(join(trustedControllerRoot, 'controller.txt'), 'trusted')
  git(['add', 'controller.txt'])
  git(['commit', '-qm', 'trusted controller'])
  const baseSha = git(['rev-parse', 'HEAD'])
  return { ...f, trustedControllerRoot, protectedCandidate: {
    ...candidate, base_sha: baseSha, scope: ['scripts/agent-pr-gate.ps1'], risk_tier: 'CRITICAL' as const,
  } }
}

function result(request: ReturnType<typeof prepareHarnessReview>['requests'][number], diffSha256: string) {
  return {
    challenge_id: request.challenge_id,
    verdict: 'APPROVE' as const,
    findings: [],
    blocking_findings: [],
    reviewed_at: new Date().toISOString(),
    host_observation: {
      child_execution_id: 'child-thread', parent_execution_id: 'parent-thread',
      session_id: 'child-session', fresh_context: true, fresh_process: true, read_only_enforced: true, controller_state_isolated: true,
      github_mutation_enabled: false, merge_enabled: false, forbidden_tool_calls: 0,
      diff_sha256: diffSha256, diff_lines_total: 2, diff_lines_read: 2,
      source_paths_opened: [], tool_calls: 1, source_sha: request.candidate.base_sha,
      authority: request.authority,
    },
  }
}

test('submit rejects reviewer GitHub mutation or merge capability', () => {
  for (const forbidden of ['github_mutation_enabled', 'merge_enabled'] as const) {
    const f = fixture()
    try {
      const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
      const observed = result(prepared.requests[0]!, f.diffSha256)
      observed.host_observation[forbidden] = true
      assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, observed), /HOST_ISOLATION_ATTESTATION_REQUIRED/)
    } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
  }
})

test('submit rejects an observed session reused from the repair producer', () => {
  const f = fixture()
  try {
    const repaired = { ...candidate, producer_execution_id: 'repair-producer' }
    const prepared = prepareHarnessReview({ ...f, candidate: repaired, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    const observed = result(prepared.requests[0]!, f.diffSha256)
    observed.host_observation.session_id = 'repair-producer'
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, observed), /OBSERVED_REVIEWER_NOT_INDEPENDENT/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('prepare and submit produces one authoritative handoff and rejects replay', () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    assert.equal(prepared.requests.length, 1)
    const submitted = submitHarnessReview(f.stateDir, prepared.run_id, result(prepared.requests[0]!, f.diffSha256))
    assert.equal(submitted.status, 'MERGE_READY')
    assert.equal(submitted.handoff?.reviews[0]?.runtime.provider_execution_id, 'child-thread')
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, result(prepared.requests[0]!, f.diffSha256)), /CHALLENGE_ALREADY_CONSUMED/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('submit rejects unobserved full diff and builder self-review', () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    const incomplete = result(prepared.requests[0]!, f.diffSha256)
    incomplete.host_observation.diff_lines_read = 1
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, incomplete), /FULL_DIFF_NOT_OBSERVED/)
    const unisolated = result(prepared.requests[0]!, f.diffSha256)
    unisolated.host_observation.controller_state_isolated = false
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, unisolated), /HOST_ISOLATION_ATTESTATION_REQUIRED/)
    const reusedProcess = result(prepared.requests[0]!, f.diffSha256)
    reusedProcess.host_observation.fresh_process = false
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, reusedProcess), /HOST_ISOLATION_ATTESTATION_REQUIRED/)
    const selfReview = result(prepared.requests[0]!, f.diffSha256)
    selfReview.host_observation.child_execution_id = builder.execution_id
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, selfReview), /OBSERVED_REVIEWER_NOT_INDEPENDENT/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('in-process adapter uses the same durable challenge path', async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.stateDir, 'fixture.txt'), 'fixture')
    const submitted = await runHarnessReview({
      ...f, candidate, builder, reviewCount: 1,
      adapter: {
        id: 'codex-native-v1', agentKind: 'codex',
        capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'SESSION_ATTESTED' as const }),
        review: async (request) => result(request, f.diffSha256),
      },
    })
    assert.equal(submitted.status, 'MERGE_READY')
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('one BLOCK wins a two-review round and remains publishable', async () => {
  const f = protectedFixture()
  try {
    const critical = f.protectedCandidate
    let calls = 0
    const outcome = await runHarnessReview({
      ...f, candidate: critical, builder, reviewCount: 2,
      adapter: {
        id: 'codex-native-v1', agentKind: 'codex',
        capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'HOST_PROTECTED' as const }),
        review: async (request) => {
          calls++
          const review = result(request, f.diffSha256)
          return calls === 2 ? { ...review, verdict: 'BLOCK' as const, blocking_findings: ['defect'] } : review
        },
      },
    })
    assert.equal(outcome.status, 'BLOCKED')
    assert.equal(outcome.handoff?.reviews[0]?.verdict, 'BLOCK')
    assert.equal(readHarnessReviewHandoff(f.stateDir, outcome.handoff!.controller_run_id).status, 'BLOCKED')
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('prepare requires the snapshot diff instead of accepting caller supplied coverage', () => {
  const f = fixture()
  try {
    rmSync(join(f.snapshotRoot, 'changes.diff'))
    assert.throws(() => prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 }), /ENOENT/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('prepare enforces the shared reviewer count for the candidate scope', () => {
  const f = fixture()
  try {
    const critical = { ...candidate, scope: ['scripts/agent-pr-gate.ps1'], risk_tier: 'CRITICAL' as const }
    assert.throws(() => prepareHarnessReview({ ...f, candidate: critical, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 }), /REVIEWER_COUNT_POLICY_MISMATCH/)
    const downgraded = { ...critical, risk_tier: 'NORMAL' as const }
    assert.throws(() => prepareHarnessReview({ ...f, candidate: downgraded, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 }), /CANDIDATE_RISK_TIER_MISMATCH/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a concurrent submit cannot overwrite another reviewer result', () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    const db = new DatabaseSync(join(f.stateDir, 'harness-runs', 'submit-lock.sqlite'))
    db.exec('BEGIN EXCLUSIVE')
    try {
      assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, result(prepared.requests[0]!, f.diffSha256)), /REVIEW_RUN_BUSY/)
    } finally { db.exec('ROLLBACK'); db.close() }
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('prepared slot executes only the matching trusted adapter', async () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    const adapter = {
      id: 'codex-native-v1', agentKind: 'codex',
      capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'SESSION_ATTESTED' as const }),
      review: async (request: (typeof prepared.requests)[number]) => result(request, f.diffSha256),
    }
    await assert.rejects(() => executePreparedHarnessReviewSlot(f.stateDir, prepared.run_id, 0, { ...adapter, id: 'other' }, builder), /HARNESS_ADAPTER_MISMATCH/)
    await assert.rejects(() => executePreparedHarnessReviewSlot(f.stateDir, prepared.run_id, 0, adapter, { ...builder, execution_id: 'other-thread' }), /REVIEW_PARENT_IDENTITY_MISMATCH/)
    const submitted = await executePreparedHarnessReviewSlot(f.stateDir, prepared.run_id, 0, adapter, builder)
    assert.equal(submitted.status, 'MERGE_READY')
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a pending result resumes after challenge completion without another reviewer execution', async () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    const stored = result(prepared.requests[0]!, f.diffSha256)
    const runPath = join(f.stateDir, 'harness-runs', `${prepared.run_id}.json`)
    const run = JSON.parse(readFileSync(runPath, 'utf8')) as Record<string, unknown>
    run.pending_results = { [stored.challenge_id]: stored }
    writeFileSync(runPath, JSON.stringify(run))
    completeReviewChallenge(f.stateDir, stored.challenge_id, { verdict: stored.verdict, completed_at: stored.reviewed_at })
    let calls = 0
    const outcome = await executePreparedHarnessReviewSlot(f.stateDir, prepared.run_id, 0, {
      id: 'codex-native-v1', agentKind: 'codex',
      capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'SESSION_ATTESTED' as const }),
      review: async () => { calls++; throw new Error('REVIEWER_SHOULD_NOT_RESTART') },
    }, builder)
    assert.equal(outcome.status, 'MERGE_READY')
    assert.equal(calls, 0)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a consumed challenge resumes from its journaled result', async () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    const stored = result(prepared.requests[0]!, f.diffSha256)
    submitHarnessReview(f.stateDir, prepared.run_id, stored)
    const runPath = join(f.stateDir, 'harness-runs', `${prepared.run_id}.json`)
    const run = JSON.parse(readFileSync(runPath, 'utf8')) as Record<string, unknown>
    run.reviews = []
    run.status = 'PENDING'
    delete run.handoff
    run.pending_results = { [stored.challenge_id]: stored }
    writeFileSync(runPath, JSON.stringify(run))
    const outcome = await executePreparedHarnessReviewSlot(f.stateDir, prepared.run_id, 0, {
      id: 'codex-native-v1', agentKind: 'codex',
      capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'SESSION_ATTESTED' as const }),
      review: async () => { throw new Error('REVIEWER_SHOULD_NOT_RESTART') },
    }, builder)
    assert.equal(outcome.status, 'MERGE_READY')
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a released process lock does not strand a prepared review', () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    const db = new DatabaseSync(join(f.stateDir, 'harness-runs', 'submit-lock.sqlite'))
    db.exec('BEGIN EXCLUSIVE')
    db.close()
    assert.equal(submitHarnessReview(f.stateDir, prepared.run_id, result(prepared.requests[0]!, f.diffSha256)).status, 'MERGE_READY')
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a block invalidates other prepared or certified rounds for the same candidate', () => {
  const f = fixture()
  try {
    const options = { ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 as const }
    const blockedRun = prepareHarnessReview(options)
    const waitingRun = prepareHarnessReview(options)
    const approvedRun = prepareHarnessReview(options)
    assert.equal(submitHarnessReview(f.stateDir, approvedRun.run_id,
      result(approvedRun.requests[0]!, f.diffSha256)).status, 'MERGE_READY')
    const block = { ...result(blockedRun.requests[0]!, f.diffSha256),
      verdict: 'BLOCK' as const, blocking_findings: ['defect'] }
    assert.equal(submitHarnessReview(f.stateDir, blockedRun.run_id, block).status, 'BLOCKED')
    assert.equal(readHarnessReviewHandoff(f.stateDir, blockedRun.run_id).handoff.reviews[0]?.verdict, 'BLOCK')
    assert.throws(() => submitHarnessReview(f.stateDir, waitingRun.run_id,
      result(waitingRun.requests[0]!, f.diffSha256)), /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/)
    assert.throws(() => readHarnessReviewHandoff(f.stateDir, approvedRun.run_id), /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('publication holds the same state lock used by submissions', async () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    submitHarnessReview(f.stateDir, prepared.run_id, result(prepared.requests[0]!, f.diffSha256))
    const observed = await withHarnessReviewPublicationLock(f.stateDir, prepared.run_id, async (certified) => {
      assert.equal(certified.status, 'MERGE_READY')
      const db = new DatabaseSync(join(f.stateDir, 'harness-runs', 'submit-lock.sqlite'))
      try {
        db.exec('PRAGMA busy_timeout=100')
        assert.throws(() => db.exec('BEGIN EXCLUSIVE'), /database is locked/)
      } finally { db.close() }
      return certified.handoff.controller_run_id
    })
    assert.equal(observed, prepared.run_id)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a host-protected scope stamps HOST_PROTECTED and refuses a session-attested adapter', async () => {
  const f = protectedFixture()
  try {
    const protectedCandidate = f.protectedCandidate
    const prepared = prepareHarnessReview({ ...f, candidate: protectedCandidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 2 })
    assert.equal(prepared.requests.length, 2)
    assert.ok(prepared.requests.every((request) => request.authority === 'HOST_PROTECTED'))
    const adapter = {
      id: 'codex-native-v1', agentKind: 'codex',
      capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'SESSION_ATTESTED' as const }),
      review: async (request: (typeof prepared.requests)[number]) => result(request, f.diffSha256),
    }
    await assert.rejects(() => executePreparedHarnessReviewSlot(f.stateDir, prepared.run_id, 0, adapter, builder), /HARNESS_AUTHORITY_INSUFFICIENT/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a normal scope stamps SESSION_ATTESTED and executes with a session-attested adapter', async () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    assert.equal(prepared.requests[0]?.authority, 'SESSION_ATTESTED')
    const adapter = {
      id: 'codex-native-v1', agentKind: 'codex',
      capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'SESSION_ATTESTED' as const }),
      review: async (request: (typeof prepared.requests)[number]) => result(request, f.diffSha256),
    }
    const submitted = await executePreparedHarnessReviewSlot(f.stateDir, prepared.run_id, 0, adapter, builder)
    assert.equal(submitted.status, 'MERGE_READY')
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a legacy persisted run without authority recomputes HOST_PROTECTED from scope', async () => {
  const f = protectedFixture()
  try {
    const protectedCandidate = f.protectedCandidate
    const prepared = prepareHarnessReview({ ...f, candidate: protectedCandidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 2 })
    const runPath = join(f.stateDir, 'harness-runs', `${prepared.run_id}.json`)
    const run = JSON.parse(readFileSync(runPath, 'utf8')) as Record<string, unknown>
    delete run.authority
    writeFileSync(runPath, JSON.stringify(run))
    const adapter = {
      id: 'codex-native-v1', agentKind: 'codex',
      capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'SESSION_ATTESTED' as const }),
      review: async (request: (typeof prepared.requests)[number]) => result(request, f.diffSha256),
    }
    await assert.rejects(() => executePreparedHarnessReviewSlot(f.stateDir, prepared.run_id, 0, adapter, builder), /HARNESS_AUTHORITY_INSUFFICIENT/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a host-protected request requires the observation to attest HOST_PROTECTED', () => {
  const f = protectedFixture()
  try {
    const protectedCandidate = f.protectedCandidate
    const prepared = prepareHarnessReview({ ...f, candidate: protectedCandidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 2 })
    const missing = result(prepared.requests[0]!, f.diffSha256)
    delete (missing.host_observation as { authority?: unknown }).authority
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, missing), /HARNESS_AUTHORITY_MISMATCH/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('submitting a result whose observed authority disagrees with the request fails closed', () => {
  const f = fixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 1 })
    const mismatched = result(prepared.requests[0]!, f.diffSha256)
    mismatched.host_observation.authority = 'HOST_PROTECTED'
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, mismatched), /HARNESS_AUTHORITY_MISMATCH/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('a protected review requires a verified base controller and matching source observation', () => {
  const f = protectedFixture()
  try {
    const input = { ...f, candidate: f.protectedCandidate, builder, agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 2 as const }
    const { trustedControllerRoot: _root, ...withoutRoot } = input
    assert.throws(() => prepareHarnessReview(withoutRoot), /TRUSTED_REVIEW_CONTROLLER_REQUIRED/)
    const prepared = prepareHarnessReview(input)
    const wrongSource = result(prepared.requests[0]!, f.diffSha256)
    wrongSource.host_observation.source_sha = 'a'.repeat(40)
    assert.throws(() => submitHarnessReview(f.stateDir, prepared.run_id, wrongSource), /TRUSTED_CONTROLLER_SOURCE_MISMATCH/)
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('prepared two-slot certification launches both reviewers concurrently', async () => {
  const f = protectedFixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate: f.protectedCandidate, builder,
      agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 2 })
    let started = 0
    let release!: () => void
    const bothStarted = new Promise<void>((resolve) => { release = resolve })
    const adapter = {
      id: 'codex-native-v1', agentKind: 'codex',
      capabilities: () => ({ freshSubagents: true, childSessionIdentity: true, readOnlyReview: true, repairWorkers: false, authority: 'HOST_PROTECTED' as const }),
      review: async (request: (typeof prepared.requests)[number]) => {
        started++
        if (started === 2) release()
        await bothStarted
        const completed = result(request, f.diffSha256)
        completed.host_observation.child_execution_id = request.challenge_id
        completed.host_observation.session_id = request.challenge_id
        return completed
      },
    }
    const outcome = await executePreparedHarnessReviewRun(f.stateDir, prepared.run_id, adapter, builder)
    assert.equal(started, 2)
    assert.equal(outcome.status, 'MERGE_READY')
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})

test('review missions specialize trust, coding loop, and TUI slots deterministically', () => {
  assert.match(reviewMission(['babel-cli/src/services/codexHarnessReview.ts'], 0), /trust boundaries/)
  assert.match(reviewMission(['babel-cli/src/services/codexHarnessReview.ts'], 1), /state transitions/)
  assert.match(reviewMission(['babel-cli/src/agent/chatEngine.ts'], 0), /correctness, state, concurrency/)
  assert.match(reviewMission(['babel-cli/src/interactive/foo.ts'], 1), /rendering/)
  assert.throws(() => reviewMission(['src/a.ts'], 2), /REVIEW_SLOT_NOT_FOUND/)
})

test('prepared run resumes only the failed slot after the other approval is durable', async () => {
  const f = protectedFixture()
  try {
    const prepared = prepareHarnessReview({ ...f, candidate: f.protectedCandidate, builder,
      agentKind: 'codex', adapterId: 'codex-native-v1', reviewCount: 2 })
    const capabilities = () => ({ freshSubagents: true, childSessionIdentity: true,
      readOnlyReview: true, repairWorkers: false, authority: 'HOST_PROTECTED' as const })
    const first = prepared.requests[0]!
    const adapter = {
      id: 'codex-native-v1', agentKind: 'codex', capabilities,
      review: async (request: (typeof prepared.requests)[number]) => {
        if (request.challenge_id !== first.challenge_id) throw new Error('transient reviewer failure')
        return result(request, f.diffSha256)
      },
    }
    await assert.rejects(() => executePreparedHarnessReviewRun(f.stateDir, prepared.run_id, adapter, builder), /REVIEW_EXECUTION_INCOMPLETE/)
    let resumed = 0
    const retry = {
      ...adapter,
      review: async (request: (typeof prepared.requests)[number]) => {
        resumed++
        assert.notEqual(request.challenge_id, first.challenge_id)
        const completed = result(request, f.diffSha256)
        completed.host_observation.child_execution_id = 'retry-child'
        completed.host_observation.session_id = 'retry-session'
        return completed
      },
    }
    const outcome = await executePreparedHarnessReviewRun(f.stateDir, prepared.run_id, retry, builder)
    assert.equal(resumed, 1)
    assert.equal(outcome.status, 'MERGE_READY')
  } finally { rmSync(f.stateDir, { recursive: true, force: true }) }
})
