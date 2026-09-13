import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createIndependentReviewController,
  type IndependentReviewWorkerAdapter,
  type PersistentReviewChallenge,
  verifyAndConsumeChallenge,
} from './independentReviewController.js'
import type { CandidateEnvelope } from './hostReviewController.js'
import type { IndependentReviewEvidenceV3 } from './independentReviewEvidenceV3.js'

function createSampleCandidate(overrides?: Partial<CandidateEnvelope>): CandidateEnvelope {
  return {
    schema_version: 2,
    candidate_digest: 'c'.repeat(64),
    risk_tier: 'NORMAL',
    trust_mode: 'SELF_REVIEW',
    created_at: new Date().toISOString(),
    repository: 'gthgomez/Babel',
    pr_number: 180,
    task_id: 'task-180',
    task_hash: 'e'.repeat(64),
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    builder_id: 'codex-builder',
    diff_numstat_digest: 'd'.repeat(64),
    scope: ['src/services/auth.ts'],
    ...overrides,
  }
}

test('independentReviewController: executes review with challenge lifecycle (ISSUED -> CONSUMED)', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-ctrl-test-'))
  try {
    const mockAdapter: IndependentReviewWorkerAdapter = {
      adapter_id: 'mock-subagent-v1',
      agent_kind: 'codex',
      async launch(req) {
        return {
          status: 'COMPLETED',
          verdict: 'APPROVE',
          findings: [],
          blocking_findings: [],
          runtime: {
            agent_kind: 'codex',
            adapter_id: 'mock-subagent-v1',
            controller_execution_id: req.reviewer.execution_id,
            requested_provider: 'openai',
            observed_provider: 'openai',
            requested_model: 'gpt-5-codex',
            observed_model: 'gpt-5-codex',
            model_attribution: 'observed',
          },
        }
      },
    }

    const controller = createIndependentReviewController({
      controller_id: 'test-controller-1',
      state_dir: tempDir,
      adapter: mockAdapter,
    })

    const candidate = createSampleCandidate()
    const handoff = await controller.review(candidate)

    assert.equal(handoff.schema_version, 3)
    assert.equal(handoff.reviews.length, 1)
    const review = handoff.reviews[0]!
    assert.equal(review.verdict, 'APPROVE')
    assert.notEqual(review.reviewer.principal_id, review.builder.principal_id)
    assert.notEqual(review.reviewer.execution_id, review.builder.execution_id)

    // Verify challenge file exists and is CONSUMED
    const challengePath = join(tempDir, 'challenges', `${review.challenge_id}.json`)
    const challenge = JSON.parse(readFileSync(challengePath, 'utf8')) as PersistentReviewChallenge
    assert.equal(challenge.status, 'CONSUMED')
    assert.ok(challenge.consumed_at)

    // Replay attempt must fail closed
    assert.throws(
      () => verifyAndConsumeChallenge(tempDir, review.challenge_id, review),
      /CHALLENGE_ALREADY_CONSUMED/
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('independentReviewController: 2-review escalation generates distinct identities', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-ctrl-test-'))
  try {
    const mockAdapter: IndependentReviewWorkerAdapter = {
      adapter_id: 'mock-subagent-v1',
      agent_kind: 'claude-code',
      async launch(req) {
        return {
          status: 'COMPLETED',
          verdict: 'APPROVE',
          findings: [],
          blocking_findings: [],
          runtime: {
            agent_kind: 'claude-code',
            adapter_id: 'mock-subagent-v1',
            controller_execution_id: req.reviewer.execution_id,
            requested_provider: 'anthropic',
            observed_provider: 'anthropic',
          },
        }
      },
    }

    const controller = createIndependentReviewController({
      controller_id: 'test-controller-1',
      state_dir: tempDir,
      adapter: mockAdapter,
    })

    const candidate = createSampleCandidate()
    const handoff = await controller.review(candidate, { reviewCount: 2 })

    assert.equal(handoff.reviews.length, 2)
    const [r1, r2] = handoff.reviews
    assert.notEqual(r1!.reviewer.principal_id, r2!.reviewer.principal_id)
    assert.notEqual(r1!.reviewer.execution_id, r2!.reviewer.execution_id)
    assert.notEqual(r1!.challenge_id, r2!.challenge_id)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('independentReviewController: records block and prevents approval shopping on retry', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-ctrl-test-'))
  try {
    let returnBlock = true
    const mockAdapter: IndependentReviewWorkerAdapter = {
      adapter_id: 'mock-subagent-v1',
      agent_kind: 'codex',
      async launch(req) {
        return {
          status: 'COMPLETED',
          verdict: returnBlock ? 'BLOCK' : 'APPROVE',
          findings: returnBlock ? ['Defect found in line 1'] : [],
          blocking_findings: returnBlock ? ['Defect found in line 1'] : [],
          runtime: {
            agent_kind: 'codex',
            adapter_id: 'mock-subagent-v1',
            controller_execution_id: req.reviewer.execution_id,
          },
        }
      },
    }

    const controller = createIndependentReviewController({
      controller_id: 'test-controller-1',
      state_dir: tempDir,
      adapter: mockAdapter,
    })

    const candidate = createSampleCandidate()
    const blockHandoff = await controller.review(candidate)
    assert.equal(blockHandoff.reviews[0]!.verdict, 'BLOCK')

    // Retry on the same candidate without repair must fail closed even if adapter wants to return APPROVE
    returnBlock = false
    await assert.rejects(
      async () => controller.review(candidate),
      /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
