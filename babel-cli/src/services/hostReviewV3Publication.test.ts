import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type HostReviewHandoffV3,
  type IndependentReviewEvidenceV3,
  publicIndependentReviewHandoffV3,
  validateHostReviewHandoffV3,
} from './independentReviewEvidenceV3.js'
import { V3_REVIEW_MARKER, publishIndependentReviewV3, serializeIndependentReviewV3 } from './hostReviewV3Publication.js'

const ownerId = '12345'
const repository = 'gthgomez/Babel'
const prNumber = 180

/** Minimal structurally valid V3 review used as the publication payload. */
function validEvidence(slot = 1): IndependentReviewEvidenceV3 {
  return {
    schema_version: 3,
    kind: 'independent_agent_review_v3',
    provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    repository,
    pr_number: prNumber,
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    candidate_digest: 'c'.repeat(64),
    diff_numstat_digest: 'd'.repeat(64),
    task_id: 'task-180',
    task_hash: 'e'.repeat(64),
    builder: { kind: 'codex', principal_id: 'builder-principal', execution_id: 'builder-exec' },
    reviewer: { kind: 'babel', principal_id: `reviewer-principal-${slot}`, execution_id: `reviewer-exec-${slot}` },
    controller_run_id: 'controller-run-180',
    challenge_id: `challenge-180-${slot}`,
    runtime: {
      agent_kind: 'babel',
      adapter_id: 'babel-chat-v1',
      controller_execution_id: `reviewer-exec-${slot}`,
      observed_provider: 'opencode-go',
      runtime_version: 'f'.repeat(64),
      provider_execution_id: `observed-exec-${slot}`,
      session_id: `observed-session-${slot}`,
      parent_execution_id: 'builder-exec',
      fresh_context: true,
      fresh_process: true,
      read_only_enforced: true,
      source_sha: 'a'.repeat(40),
      execution_purpose: 'FINAL_CERTIFICATION',
    },
    review_mode: 'exact_diff',
    execution_purpose: 'FINAL_CERTIFICATION',
    reviewed_at: new Date().toISOString(),
    scope: ['babel-cli/src/services/hostReviewV3Publication.ts'],
    verdict: 'APPROVE',
    findings: [],
    blocking_findings: [],
    isolation: {
      candidate_write: false,
      github_mutation: false,
      merge: false,
      controller_state_access: false,
    },
    coverage: {
      diff_consumed: true, diff_sha256: 'f'.repeat(64),
      diff_lines_total: 10, diff_lines_read: 10, changed_paths: 1,
      source_paths_opened: ['babel-cli/src/services/hostReviewV3Publication.ts'],
    },
  }
}

function validHandoff(): HostReviewHandoffV3 {
  const review = validEvidence()
  return {
    schema_version: 3,
    kind: 'host_review_handoff_v3',
    provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
    repository,
    pr_number: prNumber,
    base_sha: review.base_sha,
    head_sha: review.head_sha,
    candidate_digest: review.candidate_digest,
    diff_numstat_digest: review.diff_numstat_digest,
    task_id: review.task_id,
    task_hash: review.task_hash,
    controller_run_id: review.controller_run_id,
    reviews: [review, validEvidence(2)],
  }
}

const issueUrl = `https://github.com/${repository}/issues/${prNumber}`

test('publishes once with a marker-prefixed public V3 body', async () => {
  const handoff = validHandoff()
  validateHostReviewHandoffV3(handoff, { requireAuthoritative: true, scope: handoff.reviews[0]!.scope })
  const posted: string[] = []
  let listCalls = 0
  const result = await publishIndependentReviewV3({
    handoff,
    repository,
    prNumber,
    ownerId,
    actorId: ownerId,
    listComments: async () => {
      listCalls++
      return []
    },
    postComment: async (body) => {
      posted.push(body)
      return { id: 99 }
    },
  })

  assert.deepEqual(result, { posted: true, commentId: '99' })
  assert.equal(listCalls, 1)
  assert.equal(posted.length, 1)
  assert.ok(posted[0]!.startsWith(V3_REVIEW_MARKER))
  assert.ok(posted[0]!.includes('host_review_handoff_v3'))
  const parsed = JSON.parse(posted[0]!.slice(V3_REVIEW_MARKER.length)) as Record<string, unknown>
  assert.equal(parsed.kind, 'host_review_handoff_v3')
  assert.equal('provenance' in parsed, false)
  assert.equal('provenance' in (parsed.reviews as Array<Record<string, unknown>>)[0]!, false)
})

test('owner/actor mismatch is not posted', async () => {
  let posted = false
  const result = await publishIndependentReviewV3({
    handoff: validHandoff(),
    repository,
    prNumber,
    ownerId,
    actorId: '999',
    listComments: async () => [],
    postComment: async () => {
      posted = true
      return { id: 1 }
    },
  })

  assert.deepEqual(result, { posted: false, reason: 'owner_identity_required' })
  assert.equal(posted, false)
})

test('an identical owner comment short-circuits publication', async () => {
  const handoff = validHandoff()
  const body = `${V3_REVIEW_MARKER}\n${JSON.stringify(publicIndependentReviewHandoffV3(handoff))}`
  let posted = false
  const result = await publishIndependentReviewV3({
    handoff,
    repository,
    prNumber,
    ownerId,
    actorId: ownerId,
    listComments: async () => [
      { id: 7, body, userId: ownerId, userType: 'User', issueUrl },
      { id: 8, body, userId: '999', userType: 'User', issueUrl },
      { id: 9, body, userId: ownerId, userType: 'Bot', issueUrl },
    ],
    postComment: async () => {
      posted = true
      return { id: 2 }
    },
  })

  assert.deepEqual(result, { posted: false, commentId: '7', reason: 'already_published' })
  assert.equal(posted, false)
})

test('LOCAL_UNAUTHENTICATED provenance is rejected', async () => {
  let posted = false
  const localHandoff = validHandoff()
  localHandoff.provenance = 'LOCAL_UNAUTHENTICATED'
  const result = await publishIndependentReviewV3({
    handoff: localHandoff,
    repository,
    prNumber,
    ownerId,
    actorId: ownerId,
    listComments: async () => [],
    postComment: async () => {
      posted = true
      return { id: 3 }
    },
  })

  assert.equal(result.posted, false)
  assert.equal(result.reason, 'local_unauthenticated_evidence')
  assert.equal(posted, false)

  // A local label on any contained review must also block publication.
  const reviewLocal = validHandoff()
  delete reviewLocal.provenance
  reviewLocal.reviews[0]!.provenance = 'LOCAL_UNAUTHENTICATED'
  const nested = await publishIndependentReviewV3({
    handoff: reviewLocal,
    repository,
    prNumber,
    ownerId,
    actorId: ownerId,
    listComments: async () => [],
    postComment: async () => {
      posted = true
      return { id: 4 }
    },
  })
  assert.equal(nested.posted, false)
  assert.equal(nested.reason, 'local_unauthenticated_evidence')
  assert.equal(posted, false)
})

test('missing private provenance cannot be published as authoritative evidence', async () => {
  for (const missing of ['handoff', 'review'] as const) {
    const handoff = validHandoff()
    if (missing === 'handoff') delete handoff.provenance
    else delete handoff.reviews[0]!.provenance
    let posted = false
    const result = await publishIndependentReviewV3({
      handoff, repository, prNumber, ownerId, actorId: ownerId,
      listComments: async () => [],
      postComment: async () => { posted = true; return { id: 5 } },
    })
    assert.deepEqual(result, { posted: false, reason: 'authoritative_provenance_required' })
    assert.equal(posted, false)
  }
})

test('invalid final certification is rejected before publication', async () => {
  const handoff = validHandoff()
  handoff.reviews[0]!.coverage!.diff_lines_read = 1
  let posted = false
  const result = await publishIndependentReviewV3({
    handoff, repository, prNumber, ownerId, actorId: ownerId,
    listComments: async () => [],
    postComment: async () => { posted = true; return { id: 6 } },
  })
  assert.deepEqual(result, { posted: false, reason: 'invalid_authoritative_handoff' })
  assert.equal(posted, false)
})

test('a failed secret scan blocks publication', async () => {
  const handoff = validHandoff()
  const scanned: string[] = []
  let posted = false
  const result = await publishIndependentReviewV3({
    handoff,
    repository,
    prNumber,
    ownerId,
    actorId: ownerId,
    listComments: async () => [],
    postComment: async () => {
      posted = true
      return { id: 5 }
    },
    scanBody: async (body) => {
      scanned.push(body)
      return false
    },
  })

  assert.deepEqual(result, { posted: false, reason: 'secret_scan_failed' })
  assert.equal(scanned.length, 1)
  assert.ok(scanned[0]!.startsWith(V3_REVIEW_MARKER))
  assert.equal(posted, false)
})


test('canonical V3 serializer round-trips through the actual base-gate transport consumer', () => {
  const handoff = validHandoff()
  const body = serializeIndependentReviewV3(handoff)
  const root = mkdtempSync(join(tmpdir(), 'babel-v3-roundtrip-'))
  const comment = join(root, 'comment.json')
  try {
    writeFileSync(comment, JSON.stringify({ id: 99, user: { id: ownerId, type: 'User' }, body,
      issue_url: `https://api.github.com/repos/${repository}/issues/${prNumber}` }))
    const module = fileURLToPath(new URL('../../../scripts/agent-pr-gate-common.psm1', import.meta.url))
    const result = spawnSync('pwsh', ['-NoProfile', '-Command',
      '& { param($module,$path) Import-Module $module -Force; $comment = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json; Select-AgentHostReviewBundle -Comments @($comment) -Repository gthgomez/Babel -PR 180 -BaseSha ("a" * 40) -HeadSha ("b" * 40) -PublisherId 12345 | ConvertTo-Json -Depth 40 -Compress }', module, comment], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const selected = JSON.parse(result.stdout)
    assert.equal(selected.schema_version, 3)
    assert.equal(selected.kind, 'github_host_review_bundle_v3')
    assert.equal(selected.head_sha, handoff.head_sha)
    assert.equal(selected.handoff.reviews.length, handoff.reviews.length)
    assert.ok(!selected.transport_error)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
