import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBabelReviewLease, atomicReviewJson, babelReviewVersion, findPublishedBabelReview, REVIEW_CHILD_LEASE_MS, REVIEW_FRESH_MS, validateBabelReviewArtifact, validateBabelReviewCache } from './babelReviewQueue.js'
import type { HostReviewCandidate } from './hostReviewController.js'

const now = Date.now()
const candidate: HostReviewCandidate = { repository: 'owner/repo', pr_number: 1, base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), task_id: 'task', task_hash: 'c'.repeat(64), builder_id: 'builder', diff_numstat_digest: 'd'.repeat(64), scope: ['src/a.ts'] }
const executionId = '12345678-1234-1234-1234-123456789abc'
const expected = { candidate, model: 'mimo-v2.5', round: 'round', version: 'e'.repeat(64), sourceSha: 'f'.repeat(40), now }
function cache() {
  return {
    schema_version: 2, kind: 'host_review_handoff_v2', repository: candidate.repository, pr_number: candidate.pr_number,
    base_sha: candidate.base_sha, head_sha: candidate.head_sha, task_id: candidate.task_id, task_hash: candidate.task_hash, controller_run_id: 'round',
    reviews: [{ ...candidate, schema_version: 2, kind: 'autonomous_review_evidence_v2', reviewer_id: `babel-chat-mimo-v2.5-${executionId}`, reviewer_class: 'independent_readonly_ai', execution_id: executionId,
      review_provider: 'opencode-go', reviewer_model: 'mimo-v2.5', review_mode: 'exact_diff', reviewed_at: new Date(now).toISOString(), verdict: 'APPROVE', findings: [], blocking_findings: [],
      isolation: { mode: 'readonly_sandbox', candidate_write: false, github_mutation: false, merge: false, controller_state_access: false },
      harness: { name: 'babel', mode: 'chat', version: expected.version, source_sha: expected.sourceSha, execution_id: executionId },
    }],
  }
}

test('cache admits only a fresh full candidate and trusted harness execution', () => {
  assert.equal(validateBabelReviewCache(cache(), expected).reviews[0].execution_id, executionId)
  const changed = () => structuredClone(cache())
  const wrongSha = changed(); wrongSha.reviews[0]!.head_sha = '0'.repeat(40)
  const wrongScope = changed(); wrongScope.reviews[0]!.scope = ['other.ts']
  const writable = changed(); writable.reviews[0]!.isolation.candidate_write = true
  const wrongHarness = changed(); wrongHarness.reviews[0]!.harness.execution_id = 'another-run'
  const wrongRound = changed(); wrongRound.controller_run_id = 'other-round'
  const unknownModel = changed(); unknownModel.reviews[0]!.reviewer_model = 'UNKNOWN'
  const future = changed(); future.reviews[0]!.reviewed_at = new Date(now + 1).toISOString()
  const stale = changed(); stale.reviews[0]!.reviewed_at = new Date(now - REVIEW_FRESH_MS).toISOString()
  for (const invalid of [wrongSha, wrongScope, writable, wrongHarness, wrongRound, unknownModel, future, stale]) assert.throws(() => validateBabelReviewCache(invalid, expected))
  assert.throws(() => validateBabelReviewCache(cache(), { ...expected, version: '0'.repeat(64) }))
})

test('a completed BLOCK remains BLOCK and cannot carry forged approval findings', () => {
  const blocked = cache(); blocked.reviews[0]!.verdict = 'BLOCK'
  blocked.reviews[0]!.blocking_findings = ['arithmetic defect'] as never
  assert.equal(validateBabelReviewCache(blocked, expected).reviews[0].verdict, 'BLOCK')
  blocked.reviews[0]!.verdict = 'APPROVE'
  assert.throws(() => validateBabelReviewCache(blocked, expected))
})

function artifact() {
  const verdict = { verdict: 'APPROVE', uncertain: false, reviewed_files: ['src/a.ts'], findings: [], blocking_findings: [] }
  return { schema_version: 1, harness: 'babel', mode: 'chat', status: 'review_completed', execution_id: executionId, model: 'mimo-v2.5', verdict,
    payload: { mode: 'chat', write_count: 0, terminal_outcome: 'NO_CHANGE_REQUIRED', answer: { answer: JSON.stringify(verdict) } },
    calls: [{ status: 'completed', metadata: { provider: 'opencode-go', observed_model_id: 'mimo-v2.5', prompt_tokens: null, completion_tokens: 4, latency_ms: null } }],
  }
}
test('artifact binding checks execution, actual verdict and observed model while preserving unknown usage', () => {
  const expect = { executionId, model: 'mimo-v2.5', scope: ['src/a.ts'] }
  const parsed = validateBabelReviewArtifact(artifact(), expect)
  assert.deepEqual(parsed.usage, { prompt_tokens: null, completion_tokens: 4, total_tokens: null, latency_ms: null })
  assert.throws(() => validateBabelReviewArtifact(artifact(), { ...expect, executionId: 'wrong' }))
  const bad = artifact(); bad.verdict.verdict = 'BLOCK'
  assert.throws(() => validateBabelReviewArtifact(bad, expect))
  const failed = artifact(); failed.calls[0]!.status = 'failed'
  assert.throws(() => validateBabelReviewArtifact(failed, expect))
})

test('publication reconciliation admits completed local review and deduplicates an uncertain POST', () => {
  const body = '<!-- babel-controller-ai-reviews-v2 -->\n' + JSON.stringify(cache())
  assert.equal(findPublishedBabelReview([], 7, body), null) // local completion still needs publication
  const posted = { id: 10, body, user: { id: 7, type: 'User' } }
  assert.equal(findPublishedBabelReview([posted], 7, body), '10') // POST succeeded before receipt save
  assert.equal(findPublishedBabelReview([{ ...posted, user: { id: 8, type: 'User' } }], 7, body), null)
  const superseding = cache(); superseding.reviews[0]!.verdict = 'BLOCK'
  assert.equal(findPublishedBabelReview([posted, { ...posted, id: 11, body: '<!-- babel-controller-ai-reviews-v2 -->\n' + JSON.stringify(superseding) }], 7, body), null)
})

test('source version changes when only an untracked implementation changes', () => {
  const one = [{ path: 'tools/worker.mts', bytes: Buffer.from('first') }]
  const two = [{ path: 'tools/worker.mts', bytes: Buffer.from('second') }]
  assert.notEqual(babelReviewVersion('head', 'diff', one), babelReviewVersion('head', 'diff', two))
})

test('atomic JSON keeps a parseable current checkpoint and exclusive initialized leases', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-queue-'))
  const data = join(root, 'state.json'); atomicReviewJson(data, { result: 1 }); atomicReviewJson(data, { result: 2 })
  assert.deepEqual(JSON.parse(readFileSync(data, 'utf8')), { result: 2 })
  const lock = join(root, 'running.lock')
  const first = acquireBabelReviewLease(lock)
  assert.ok(first)
  assert.equal(acquireBabelReviewLease(lock), null)
  first.child(123456, executionId)
  first.release()
  assert.equal(existsSync(lock), true) // never remove evidence of a possibly active child
  first.childExited(); first.release()
  assert.equal(existsSync(lock), false)
})

test('orphan reconciliation waits for the child then quarantines before the next acquisition', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-orphan-')); const path = join(root, 'running.lock')
  atomicReviewJson(path, { token: 'old', pid: 41, startedAt: now, child: { pid: 42, executionId, deadline: now + 1000 } })
  assert.equal(acquireBabelReviewLease(path, pid => pid === 42, now), null)
  assert.equal(existsSync(path), true)
  assert.equal(acquireBabelReviewLease(path, () => false, now), null)
  assert.equal(existsSync(path), false)
  const lease = acquireBabelReviewLease(path, () => false, now)
  assert.ok(lease); lease.release()
})

test('legacy malformed lock cannot crash the queue and an unknown launch waits its bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-malformed-')); const path = join(root, 'running.lock')
  writeFileSync(path, '')
  assert.equal(acquireBabelReviewLease(path, () => false, now), null)
  utimesSync(path, new Date(now - REVIEW_CHILD_LEASE_MS - 1000), new Date(now - REVIEW_CHILD_LEASE_MS - 1000))
  assert.equal(acquireBabelReviewLease(path, () => false, now), null)
  assert.equal(existsSync(path), false)
  atomicReviewJson(path, { token: 'old', pid: 41, startedAt: now, child: { pid: null, executionId, deadline: now + 1000 } })
  assert.equal(acquireBabelReviewLease(path, () => false, now), null)
  assert.equal(existsSync(path), true)
  assert.equal(acquireBabelReviewLease(path, () => false, now + 1001), null)
  assert.equal(existsSync(path), false)
})

test('recycled live PID does not strand a completed child lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-recycled-')); const path = join(root, 'running.lock')
  atomicReviewJson(path, { token: 'old', pid: 41, processIdentity: 'first-parent', startedAt: now, child: { pid: 42, processIdentity: 'first-child', executionId, deadline: now + 1000 } })
  assert.equal(acquireBabelReviewLease(path, () => true, now, () => 'different-process'), null)
  assert.equal(existsSync(path), false)
})

test('cache admits controller-emitted host provenance fields (schema-drift regression)', () => {
  // The review controller emits tool_traces and changes_diff_fully_read on
  // every fresh review. The strict evidence schema must admit exactly those
  // fields (and nothing else), or the controller can never cache or publish a
  // fresh review round.
  const withProvenance = () => {
    const value = cache() as Record<string, unknown>
    ;(value.reviews as Array<Record<string, unknown>>)[0]!.tool_traces = [{ tool: 'read_file', targetPath: 'src/a.ts', args: { path: 'src/a.ts' } }]
    ;(value.reviews as Array<Record<string, unknown>>)[0]!.changes_diff_fully_read = true
    return value
  }
  const validated = validateBabelReviewCache(withProvenance(), expected)
  assert.equal(validated.reviews[0].execution_id, executionId)
  assert.deepEqual(validated.reviews[0].tool_traces, [{ tool: 'read_file', targetPath: 'src/a.ts', args: { path: 'src/a.ts' } }])
  assert.equal(validated.reviews[0].changes_diff_fully_read, true)
  // Unknown extra fields still fail closed.
  const withUnknown = withProvenance() as { reviews: Array<Record<string, unknown>> }
  withUnknown.reviews[0]!['controller_secret'] = 'x'
  assert.throws(() => validateBabelReviewCache(withUnknown, expected))
})
