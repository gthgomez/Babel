import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { atomicReviewJson } from './babelReviewQueue.js'
import { assertReviewStateOutsideGit } from './babelReviewSnapshot.js'
import type { CandidateEnvelope } from './hostReviewController.js'
import {
  issueReviewChallenge, settleReviewChallenge,
  type PersistentReviewChallenge,
} from './independentReviewController.js'
import { assertNoUnresolvedPriorBlock, recordUnresolvedBlock } from './independentReviewPolicy.js'
import {
  validateHostReviewHandoffV3, validateIndependentReviewEvidenceV3,
  type HostReviewHandoffV3, type IndependentReviewEvidenceV3, type ReviewActorIdentity,
} from './independentReviewEvidenceV3.js'
import { classifyReviewRisk, resolveReviewAuthority, resolveReviewPolicy, type ReviewAuthority } from './reviewPolicy.js'
import { assertTrustedReviewCodePath, assertTrustedReviewInstallation } from './trustedReviewInstallation.js'

/** Bind this executing protocol module to the exact trusted base source. */
export function assertExecutingHarnessReviewProtocol(installationRoot: string, baseSha: string): string {
  return assertTrustedReviewCodePath(installationRoot, baseSha,
    fileURLToPath(import.meta.url), 'babel-cli/src/services/harnessReviewProtocol.ts')
}

export interface HarnessReviewCapabilities {
  freshSubagents: boolean
  childSessionIdentity: boolean
  readOnlyReview: boolean
  repairWorkers: boolean
  /** Strongest authority this adapter can attest for a final certification. */
  authority: ReviewAuthority
}

export interface HarnessReviewRequest {
  controller_run_id: string
  challenge_id: string
  candidate: CandidateEnvelope
  builder: ReviewActorIdentity
  reviewer: ReviewActorIdentity
  snapshot_root: string
  diff_sha256: string
  diff_lines_total: number
  purpose: 'FINAL_CERTIFICATION'
  authority: ReviewAuthority
  review_mission: string
}

export interface HarnessReviewResult {
  challenge_id: string
  verdict: 'APPROVE' | 'BLOCK'
  findings: string[]
  blocking_findings: string[]
  reviewed_at: string
  host_observation: {
    child_execution_id: string
    parent_execution_id: string
    session_id: string
    fresh_context: boolean
    fresh_process?: boolean
    read_only_enforced: boolean
    controller_state_isolated: boolean
    diff_sha256: string
    diff_lines_total: number
    diff_lines_read: number
    source_paths_opened: string[]
    tool_calls: number
    requested_model?: string
    observed_model?: string | null
    model_attribution?: 'observed' | 'configured' | 'unavailable'
    requested_provider?: string
    observed_provider?: string
    source_sha?: string
    authority?: ReviewAuthority
  }
}

export interface HarnessReviewAdapter {
  readonly id: string
  readonly agentKind: string
  capabilities(): HarnessReviewCapabilities
  review(request: Readonly<HarnessReviewRequest>): Promise<HarnessReviewResult>
  repair?: (request: unknown) => Promise<unknown>
}

interface ReviewRun {
  run_id: string
  candidate: CandidateEnvelope
  builder: ReviewActorIdentity
  adapter_id: string
  agent_kind: string
  authority: ReviewAuthority
  trusted_controller_root?: string
  trusted_controller_source_sha?: string
  requests: HarnessReviewRequest[]
  reviews: IndependentReviewEvidenceV3[]
  pending_results?: Record<string, HarnessReviewResult>
  status: 'PENDING' | 'BLOCKED' | 'MERGE_READY'
  handoff?: HostReviewHandoffV3
}

function countDiffLines(diff: string): number {
  return diff.length === 0 ? 0 : diff.split('\n').length - (diff.endsWith('\n') ? 1 : 0)
}

/** Deterministic complementary reviewer focus; every slot still reviews the full diff. */
export function reviewMission(scope: readonly string[], slot: number): string {
  if (slot !== 0 && slot !== 1) throw new Error('REVIEW_SLOT_NOT_FOUND')
  const paths = scope.map((path) => path.toLowerCase().replaceAll('\\', '/'))
  const trust = paths.some((path) => /(^\.github\/workflows\/|^config\/review-risk-policy|^scripts\/(agent-pr-gate|agent-review|trusted-merge-gate|agent-pr-merge)|^babel-cli\/src\/(services\/(review|independentreview|harnessreview|hostreview|mergereadiness|trustedreview|codexharnessreview|opencodeharnessreview|orchestratorreviewadapter|controllermediatedharnessreview)|authority\/))/.test(path))
  const tui = paths.some((path) => /(^babel-cli\/src\/interactive\/|\/tui\/|\/ui\/)/.test(path))
  const codingLoop = paths.some((path) => /(^babel-cli\/src\/(agent\/|executor\/|pipeline\/)|coding-loop)/.test(path))
  if (trust) return slot === 0
    ? 'Inspect trust boundaries, privilege escalation, evidence forgery, stale or replayed evidence, exact-head binding, and bypasses.'
    : 'Inspect implementation correctness, state transitions, concurrency, crash recovery, tests, and failure modes.'
  if (tui) return slot === 0
    ? 'Inspect input ownership, lifecycle, terminal leases, and concurrency.'
    : 'Inspect rendering, state projection, interactions, and user-visible regressions.'
  if (codingLoop) return slot === 0
    ? 'Inspect correctness, state, concurrency, and invariants.'
    : 'Inspect regressions, tests, failure recovery, cancellation, and persistence.'
  return slot === 0
    ? 'Inspect correctness, security boundaries, and invariants.'
    : 'Inspect regressions, tests, recovery, and user-visible failure modes.'
}

function runPath(stateDir: string, runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('UNSAFE_REVIEW_RUN_ID')
  return join(stateDir, 'harness-runs', `${runId}.json`)
}

export function prepareHarnessReview(input: {
  candidate: CandidateEnvelope
  builder: ReviewActorIdentity
  agentKind: string
  adapterId: string
  reviewCount: 1 | 2
  stateDir: string
  snapshotRoot: string
  trustedControllerRoot?: string
}): { run_id: string; requests: HarnessReviewRequest[] } {
  if (input.reviewCount !== 1 && input.reviewCount !== 2) throw new Error('INVALID_REVIEWER_COUNT')
  const derivedRisk = classifyReviewRisk(input.candidate.scope)
  const authority = resolveReviewAuthority(input.candidate.scope)
  if (input.candidate.risk_tier !== derivedRisk) throw new Error('CANDIDATE_RISK_TIER_MISMATCH')
  const requiredCount = resolveReviewPolicy({ riskLane: derivedRisk, requireAuthoritative: true }).finalCertificationCount
  if (input.reviewCount !== requiredCount) throw new Error('REVIEWER_COUNT_POLICY_MISMATCH')
  if (authority === 'HOST_PROTECTED' && !input.trustedControllerRoot) throw new Error('TRUSTED_REVIEW_CONTROLLER_REQUIRED')
  const trustedControllerSourceSha = input.trustedControllerRoot
    ? assertTrustedReviewInstallation(input.trustedControllerRoot, input.candidate.base_sha) : undefined
  if (!input.agentKind.trim() || !input.adapterId.trim()) throw new Error('HARNESS_IDENTITY_REQUIRED')
  if (!input.builder.execution_id || !input.builder.principal_id) throw new Error('AUTHORITATIVE_BUILDER_IDENTITY_REQUIRED')
  const stateDir = assertReviewStateOutsideGit(input.stateDir)
  assertNoUnresolvedPriorBlock(input.candidate.candidate_digest, stateDir)
  const runId = randomUUID()
  const diff = readFileSync(join(input.snapshotRoot, 'changes.diff'), 'utf8')
  const diffSha256 = createHash('sha256').update(diff).digest('hex')
  const diffLinesTotal = countDiffLines(diff)
  if (diffLinesTotal === 0) throw new Error('EMPTY_REVIEW_DIFF')
  const requests: HarnessReviewRequest[] = Array.from({ length: input.reviewCount }, (_, slot) => ({
    controller_run_id: runId,
    challenge_id: randomUUID(),
    candidate: input.candidate,
    builder: input.builder,
    reviewer: { kind: input.agentKind, principal_id: randomUUID(), execution_id: randomUUID() },
    snapshot_root: input.snapshotRoot,
    diff_sha256: diffSha256,
    diff_lines_total: diffLinesTotal,
    purpose: 'FINAL_CERTIFICATION',
    authority,
    review_mission: reviewMission(input.candidate.scope, slot),
  }))
  for (const request of requests) {
    const challenge: PersistentReviewChallenge = {
      challenge_id: request.challenge_id, status: 'ISSUED', candidate_digest: input.candidate.candidate_digest,
      repository: input.candidate.repository, pr_number: input.candidate.pr_number ?? 1,
      base_sha: input.candidate.base_sha, head_sha: input.candidate.head_sha,
      diff_numstat_digest: input.candidate.diff_numstat_digest, scope: [...input.candidate.scope],
      builder: input.builder, reviewer: request.reviewer, controller_run_id: runId,
      issued_at: new Date().toISOString(),
    }
    issueReviewChallenge(stateDir, challenge)
  }
  const run: ReviewRun = {
    run_id: runId, candidate: input.candidate, builder: input.builder,
    adapter_id: input.adapterId, agent_kind: input.agentKind, authority, requests, reviews: [], status: 'PENDING',
    ...(input.trustedControllerRoot ? { trusted_controller_root: input.trustedControllerRoot } : {}),
    ...(trustedControllerSourceSha ? { trusted_controller_source_sha: trustedControllerSourceSha } : {}),
  }
  mkdirSync(join(stateDir, 'harness-runs'), { recursive: true, mode: 0o700 })
  atomicReviewJson(runPath(stateDir, runId), run)
  return { run_id: runId, requests }
}

function submitHarnessReviewUnlocked(
  stateDir: string, runId: string, result: HarnessReviewResult,
): { status: 'PENDING' | 'BLOCKED' | 'MERGE_READY'; handoff?: HostReviewHandoffV3 } {
  const path = runPath(stateDir, runId)
  if (!existsSync(path)) throw new Error('REVIEW_RUN_NOT_FOUND')
  const run = JSON.parse(readFileSync(path, 'utf8')) as ReviewRun
  const request = run.requests.find((item) => item.challenge_id === result.challenge_id)
  if (!request) throw new Error('CHALLENGE_NOT_IN_RUN')
  if (run.reviews.some((review) => review.challenge_id === result.challenge_id)) throw new Error('CHALLENGE_ALREADY_CONSUMED')
  if (run.status !== 'PENDING') throw new Error('REVIEW_RUN_ALREADY_SETTLED')
  if (result.verdict !== 'APPROVE' && result.verdict !== 'BLOCK') throw new Error('INVALID_REVIEW_VERDICT')
  if (result.verdict === 'APPROVE') assertNoUnresolvedPriorBlock(run.candidate.candidate_digest, stateDir)
  if (!Array.isArray(result.findings) || !Array.isArray(result.blocking_findings) ||
      result.findings.some((v) => typeof v !== 'string') || result.blocking_findings.some((v) => typeof v !== 'string')) {
    throw new Error('INVALID_REVIEW_FINDINGS')
  }
  const host = result.host_observation
  if (!host || host.fresh_context !== true || host.fresh_process !== true || host.read_only_enforced !== true || host.controller_state_isolated !== true ||
      !host.child_execution_id || !host.session_id || host.parent_execution_id !== run.builder.execution_id) {
    throw new Error('HOST_ISOLATION_ATTESTATION_REQUIRED')
  }
  if (request.authority === 'HOST_PROTECTED') {
    // A host-protected slot must observe the protected authority, not merely omit it.
    if (host.authority !== 'HOST_PROTECTED') throw new Error('HARNESS_AUTHORITY_MISMATCH')
    if (!run.trusted_controller_root || !run.trusted_controller_source_sha) throw new Error('TRUSTED_REVIEW_CONTROLLER_REQUIRED')
    const currentSourceSha = assertTrustedReviewInstallation(run.trusted_controller_root, run.candidate.base_sha)
    if (currentSourceSha !== run.trusted_controller_source_sha || host.source_sha !== currentSourceSha) {
      throw new Error('TRUSTED_CONTROLLER_SOURCE_MISMATCH')
    }
  } else if (host.authority && host.authority !== request.authority) {
    throw new Error('HARNESS_AUTHORITY_MISMATCH')
  }
  if (run.candidate.repository.toLowerCase() === 'gthgomez/babel' && !/^[0-9a-f]{40}$/i.test(host.source_sha ?? '')) {
    throw new Error('TRUSTED_CONTROLLER_SOURCE_REQUIRED')
  }
  const forbidden = [run.builder.execution_id, run.candidate.producer_execution_id,
    run.candidate.lineage?.producer.execution_id].filter(Boolean).map((v) => v!.toLowerCase())
  const used = run.reviews.flatMap((review) => [review.runtime.provider_execution_id, review.runtime.session_id])
    .filter(Boolean).map((v) => v!.toLowerCase())
  if (forbidden.includes(host.child_execution_id.toLowerCase()) || used.includes(host.child_execution_id.toLowerCase()) ||
      used.includes(host.session_id.toLowerCase()) || host.session_id.toLowerCase() === host.parent_execution_id.toLowerCase()) {
    throw new Error('OBSERVED_REVIEWER_NOT_INDEPENDENT')
  }
  if (host.diff_sha256 !== request.diff_sha256 || host.diff_lines_total !== request.diff_lines_total ||
      host.diff_lines_read !== request.diff_lines_total || !Number.isInteger(host.diff_lines_read)) {
    throw new Error('FULL_DIFF_NOT_OBSERVED')
  }
  if (!Array.isArray(host.source_paths_opened) || !Number.isInteger(host.tool_calls) || host.tool_calls < 0) {
    throw new Error('INVALID_REVIEW_TELEMETRY')
  }
  const evidence: IndependentReviewEvidenceV3 = {
    schema_version: 3, kind: 'independent_agent_review_v3', provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    repository: run.candidate.repository, pr_number: run.candidate.pr_number ?? 1,
    base_sha: run.candidate.base_sha, head_sha: run.candidate.head_sha,
    candidate_digest: run.candidate.candidate_digest, diff_numstat_digest: run.candidate.diff_numstat_digest,
    task_id: run.candidate.task_id, task_hash: run.candidate.task_hash,
    builder: run.builder, reviewer: request.reviewer, controller_run_id: runId, challenge_id: request.challenge_id,
    runtime: {
      agent_kind: run.agent_kind, adapter_id: run.adapter_id,
      controller_execution_id: request.reviewer.execution_id,
      provider_execution_id: host.child_execution_id, session_id: host.session_id,
      parent_execution_id: host.parent_execution_id, fresh_context: true,
      fresh_process: true, read_only_enforced: true,
      execution_purpose: 'FINAL_CERTIFICATION',
      model_attribution: host.model_attribution ?? 'unavailable',
      ...(host.source_sha ? { source_sha: host.source_sha } : {}),
      ...(host.requested_model ? { requested_model: host.requested_model } : {}),
      ...(host.observed_model !== undefined ? { observed_model: host.observed_model } : {}),
      ...(host.requested_provider ? { requested_provider: host.requested_provider } : {}),
      ...(host.observed_provider ? { observed_provider: host.observed_provider } : {}),
    },
    review_mode: 'exact_diff', execution_purpose: 'FINAL_CERTIFICATION', reviewed_at: result.reviewed_at,
    scope: [...run.candidate.scope], verdict: result.verdict, findings: result.findings,
    blocking_findings: result.blocking_findings,
    isolation: { candidate_write: false, github_mutation: false, merge: false, controller_state_access: false },
    coverage: {
      diff_consumed: true, diff_sha256: host.diff_sha256, diff_lines_total: host.diff_lines_total,
      diff_lines_read: host.diff_lines_read, changed_paths: run.candidate.scope.length,
      source_paths_opened: host.source_paths_opened,
    },
    usage: { tool_calls: host.tool_calls },
  }
  validateIndependentReviewEvidenceV3(evidence, {
    candidateScope: run.candidate.scope, requireAuthoritative: true,
    producerExecutionId: run.candidate.producer_execution_id, lineage: run.candidate.lineage,
    purpose: 'FINAL_CERTIFICATION',
  })
  const priorPending = run.pending_results?.[request.challenge_id]
  if (priorPending && JSON.stringify(priorPending) !== JSON.stringify(result)) throw new Error('PENDING_REVIEW_RESULT_MISMATCH')
  if (!priorPending) {
    run.pending_results = { ...run.pending_results, [request.challenge_id]: result }
    atomicReviewJson(path, run)
  }
  if (result.verdict === 'BLOCK') recordUnresolvedBlock(run.candidate.candidate_digest, stateDir, evidence)
  settleReviewChallenge(stateDir, request.challenge_id, evidence, result.reviewed_at)
  run.reviews.push(evidence)
  delete run.pending_results?.[request.challenge_id]
  if (result.verdict === 'BLOCK') {
    run.status = 'BLOCKED'
  } else if (run.reviews.length === run.requests.length && run.reviews.every((review) => review.verdict === 'APPROVE')) {
    run.status = 'MERGE_READY'
  }
  if (run.status === 'PENDING') {
    atomicReviewJson(path, run)
    return { status: 'PENDING' }
  }
  const handoff: HostReviewHandoffV3 = {
    schema_version: 3, kind: 'host_review_handoff_v3', provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    repository: run.candidate.repository, pr_number: run.candidate.pr_number ?? 1,
    base_sha: run.candidate.base_sha, head_sha: run.candidate.head_sha,
    candidate_digest: run.candidate.candidate_digest, diff_numstat_digest: run.candidate.diff_numstat_digest,
    task_id: run.candidate.task_id, task_hash: run.candidate.task_hash, controller_run_id: runId,
    reviews: run.reviews as HostReviewHandoffV3['reviews'],
  }
  validateHostReviewHandoffV3(handoff, { candidateDigest: run.candidate.candidate_digest, scope: run.candidate.scope,
    requireAuthoritative: true, purpose: 'FINAL_CERTIFICATION' })
  run.handoff = handoff
  atomicReviewJson(path, run)
  return { status: run.status, handoff }
}

export function submitHarnessReview(
  stateDir: string, runId: string, result: HarnessReviewResult,
): { status: 'PENDING' | 'BLOCKED' | 'MERGE_READY'; handoff?: HostReviewHandoffV3 } {
  const path = runPath(stateDir, runId)
  if (!existsSync(path)) throw new Error('REVIEW_RUN_NOT_FOUND')
  const lockPath = join(stateDir, 'harness-runs', 'submit-lock.sqlite')
  const db = new DatabaseSync(lockPath)
  try {
    chmodSync(lockPath, 0o600)
    db.exec('PRAGMA busy_timeout=1000')
    try { db.exec('BEGIN EXCLUSIVE') }
    catch (error) {
      if ((error as Error).message.includes('database is locked')) throw new Error('REVIEW_RUN_BUSY')
      throw error
    }
    try {
      const outcome = submitHarnessReviewUnlocked(stateDir, runId, result)
      db.exec('COMMIT')
      return outcome
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  finally { db.close() }
}

export function readHarnessReviewHandoff(stateDir: string, runId: string): {
  candidate: CandidateEnvelope
  status: 'BLOCKED' | 'MERGE_READY'
  handoff: HostReviewHandoffV3
} {
  const path = runPath(stateDir, runId)
  if (!existsSync(path)) throw new Error('REVIEW_RUN_NOT_FOUND')
  const run = JSON.parse(readFileSync(path, 'utf8')) as ReviewRun
  if ((run.status !== 'MERGE_READY' && run.status !== 'BLOCKED') || !run.handoff) {
    throw new Error('REVIEW_RUN_NOT_CERTIFIED')
  }
  if (run.status === 'MERGE_READY') assertNoUnresolvedPriorBlock(run.candidate.candidate_digest, stateDir)
  validateHostReviewHandoffV3(run.handoff, {
    candidateDigest: run.candidate.candidate_digest, scope: run.candidate.scope,
    requireAuthoritative: true, purpose: 'FINAL_CERTIFICATION',
  })
  return { candidate: run.candidate, status: run.status, handoff: run.handoff }
}

/** Keep the block ledger stable while the trusted host publishes a certified handoff. */
export async function withHarnessReviewPublicationLock<T>(
  stateDir: string, runId: string,
  publish: (certified: ReturnType<typeof readHarnessReviewHandoff>) => Promise<T>,
): Promise<T> {
  const lockPath = join(stateDir, 'harness-runs', 'submit-lock.sqlite')
  const db = new DatabaseSync(lockPath)
  try {
    chmodSync(lockPath, 0o600)
    db.exec('PRAGMA busy_timeout=30000')
    db.exec('BEGIN EXCLUSIVE')
    try {
      const certified = readHarnessReviewHandoff(stateDir, runId)
      const result = await publish(certified)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally { db.close() }
}

export function readHarnessReviewRequest(stateDir: string, runId: string, slot: number): HarnessReviewRequest {
  if (!Number.isInteger(slot) || slot < 0) throw new Error('REVIEW_SLOT_NOT_FOUND')
  const path = runPath(stateDir, runId)
  if (!existsSync(path)) throw new Error('REVIEW_RUN_NOT_FOUND')
  const run = JSON.parse(readFileSync(path, 'utf8')) as ReviewRun
  const request = run.requests[slot]
  if (!request) throw new Error('REVIEW_SLOT_NOT_FOUND')
  return request
}

/** A HOST_PROTECTED run may only be reviewed by an adapter that attests HOST_PROTECTED. */
function assertAdapterAuthority(adapter: HarnessReviewAdapter, required: ReviewAuthority): void {
  if (required === 'HOST_PROTECTED' && adapter.capabilities().authority !== 'HOST_PROTECTED') {
    throw new Error('HARNESS_AUTHORITY_INSUFFICIENT')
  }
}

/** Trusted-host entrypoint: the adapter produces the observation in this process. */
export async function executePreparedHarnessReviewSlot(
  stateDir: string, runId: string, slot: number, adapter: HarnessReviewAdapter, parent: ReviewActorIdentity,
): Promise<{ status: 'PENDING' | 'BLOCKED' | 'MERGE_READY'; handoff?: HostReviewHandoffV3 }> {
  if (!Number.isInteger(slot) || slot < 0) throw new Error('REVIEW_SLOT_NOT_FOUND')
  const path = runPath(stateDir, runId)
  if (!existsSync(path)) throw new Error('REVIEW_RUN_NOT_FOUND')
  const run = JSON.parse(readFileSync(path, 'utf8')) as ReviewRun
  if (parent.kind !== run.builder.kind || parent.principal_id !== run.builder.principal_id ||
      parent.execution_id !== run.builder.execution_id) throw new Error('REVIEW_PARENT_IDENTITY_MISMATCH')
  if (adapter.id !== run.adapter_id || adapter.agentKind !== run.agent_kind) throw new Error('HARNESS_ADAPTER_MISMATCH')
  const capabilities = adapter.capabilities()
  if (!capabilities.freshSubagents || !capabilities.childSessionIdentity || !capabilities.readOnlyReview) {
    throw new Error('HARNESS_REVIEW_CAPABILITIES_INSUFFICIENT')
  }
  // Legacy persisted runs predate `authority`; recompute it from the bound scope.
  assertAdapterAuthority(adapter, run.authority ?? resolveReviewAuthority(run.candidate.scope))
  const request = run.requests[slot]
  if (!request) throw new Error('REVIEW_SLOT_NOT_FOUND')
  if (run.status !== 'PENDING' || run.reviews.some((review) => review.challenge_id === request.challenge_id)) {
    throw new Error('REVIEW_SLOT_ALREADY_SETTLED')
  }
  const pending = run.pending_results?.[request.challenge_id]
  if (pending) return submitHarnessReview(stateDir, runId, pending)
  return submitHarnessReview(stateDir, runId, await adapter.review(request))
}

/** Launch all prepared final slots together while keeping each durable challenge independent. */
export async function executePreparedHarnessReviewRun(
  stateDir: string, runId: string, adapter: HarnessReviewAdapter, parent: ReviewActorIdentity,
): Promise<{ status: 'BLOCKED' | 'MERGE_READY'; handoff: HostReviewHandoffV3 }> {
  const path = runPath(stateDir, runId)
  if (!existsSync(path)) throw new Error('REVIEW_RUN_NOT_FOUND')
  const run = JSON.parse(readFileSync(path, 'utf8')) as ReviewRun
  if (run.status !== 'PENDING') {
    const certified = readHarnessReviewHandoff(stateDir, runId)
    return { status: certified.status, handoff: certified.handoff }
  }
  const remainingSlots = run.requests.flatMap((request, slot) =>
    run.reviews.some((review) => review.challenge_id === request.challenge_id) ? [] : [slot])
  const settled = await Promise.allSettled(remainingSlots.map((slot) =>
    executePreparedHarnessReviewSlot(stateDir, runId, slot, adapter, parent)))
  const blocked = settled.find((entry) => entry.status === 'fulfilled' && entry.value.status === 'BLOCKED')
  if (blocked?.status === 'fulfilled' && blocked.value.handoff) {
    return { status: 'BLOCKED', handoff: blocked.value.handoff }
  }
  if (settled.some((entry) => entry.status === 'rejected')) throw new Error('REVIEW_EXECUTION_INCOMPLETE')
  const certified = readHarnessReviewHandoff(stateDir, runId)
  return { status: certified.status, handoff: certified.handoff }
}

export async function runHarnessReview(input: {
  candidate: CandidateEnvelope
  builder: ReviewActorIdentity
  stateDir: string
  snapshotRoot: string
  reviewCount: 1 | 2
  adapter: HarnessReviewAdapter
  trustedControllerRoot?: string
}): Promise<{ status: 'PENDING' | 'BLOCKED' | 'MERGE_READY'; handoff?: HostReviewHandoffV3 }> {
  const capabilities = input.adapter.capabilities()
  if (!capabilities.freshSubagents || !capabilities.childSessionIdentity || !capabilities.readOnlyReview) {
    throw new Error('HARNESS_REVIEW_CAPABILITIES_INSUFFICIENT')
  }
  assertAdapterAuthority(input.adapter, resolveReviewAuthority(input.candidate.scope))
  const prepared = prepareHarnessReview({ ...input, agentKind: input.adapter.agentKind, adapterId: input.adapter.id })
  const settled = await Promise.allSettled(prepared.requests.map((request) => input.adapter.review(request)))
  const blocks = settled.flatMap((item) => item.status === 'fulfilled' && item.value.verdict === 'BLOCK' ? [item.value] : [])
  if (blocks.length > 0) return submitHarnessReview(input.stateDir, prepared.run_id, blocks[0]!)
  let outcome: ReturnType<typeof submitHarnessReview> = { status: 'PENDING' }
  for (let i = 0; i < settled.length; i++) {
    const item = settled[i]!
    if (item.status === 'fulfilled') outcome = submitHarnessReview(input.stateDir, prepared.run_id, item.value)
  }
  if (outcome.status === 'PENDING') throw new Error('REVIEW_EXECUTION_INCOMPLETE')
  return outcome
}
