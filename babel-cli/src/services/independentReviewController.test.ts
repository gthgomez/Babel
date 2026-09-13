import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAutonomousEngineeringAdapter,
  createIndependentReviewController,
  type IndependentReviewWorkerAdapter,
  type PersistentReviewChallenge,
  issueReviewChallenge,
  verifyAndConsumeChallenge,
} from './independentReviewController.js'
import type { CandidateEnvelope } from './hostReviewController.js'
import type { ReviewActorIdentity } from './independentReviewEvidenceV3.js'

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

const sampleBuilder: ReviewActorIdentity = {
  kind: 'codex',
  principal_id: 'builder-principal-1',
  execution_id: 'builder-exec-1',
}

test('independentReviewController: executes review with challenge lifecycle (ISSUED -> COMPLETED -> CONSUMED)', async () => {
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
          reviewed_at: new Date().toISOString(),
          scope: [...req.candidate.scope],
          isolation: req.required_isolation,
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
    const handoff = await controller.review(candidate, { builder: sampleBuilder })

    assert.equal(handoff.schema_version, 3)
    assert.equal(handoff.provenance, 'TRUSTED_CONTROLLER_EVIDENCE')
    assert.equal(handoff.reviews.length, 1)
    const review = handoff.reviews[0]!
    assert.equal(review.verdict, 'APPROVE')
    assert.equal(review.provenance, 'TRUSTED_CONTROLLER_EVIDENCE')
    assert.notEqual(review.reviewer.principal_id, review.builder.principal_id)
    assert.notEqual(review.reviewer.execution_id, review.builder.execution_id)

    // Verify challenge file exists and is CONSUMED
    const challengePath = join(tempDir, 'challenges', `${review.challenge_id}.json`)
    const challenge = JSON.parse(readFileSync(challengePath, 'utf8')) as PersistentReviewChallenge
    assert.equal(challenge.status, 'CONSUMED')
    assert.ok(challenge.consumed_at)
    assert.equal(challenge.verdict, 'APPROVE')

    // Replay attempt must fail closed
    assert.throws(
      () => verifyAndConsumeChallenge(tempDir, review.challenge_id, review),
      /CHALLENGE_ALREADY_CONSUMED/
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('independentReviewController: consume directly from ISSUED fails closed', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-ctrl-test-'))
  try {
    const challengeId = 'issued-challenge-1'
    const challengeRecord: PersistentReviewChallenge = {
      challenge_id: challengeId,
      status: 'ISSUED',
      candidate_digest: 'c'.repeat(64),
      repository: 'gthgomez/Babel',
      pr_number: 180,
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      diff_numstat_digest: 'd'.repeat(64),
      scope: ['src/services/auth.ts'],
      builder: sampleBuilder,
      reviewer: { kind: 'codex', principal_id: 'rev-p', execution_id: 'rev-e' },
      controller_run_id: 'run-1',
      issued_at: new Date().toISOString(),
    }
    issueReviewChallenge(tempDir, challengeRecord)

    const dummyEvidence: any = {
      schema_version: 3,
      kind: 'independent_agent_review_v3',
      provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
      repository: 'gthgomez/Babel',
      pr_number: 180,
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      candidate_digest: 'c'.repeat(64),
      diff_numstat_digest: 'd'.repeat(64),
      controller_run_id: 'run-1',
      challenge_id: challengeId,
      builder: sampleBuilder,
      reviewer: { kind: 'codex', principal_id: 'rev-p', execution_id: 'rev-e' },
      verdict: 'APPROVE',
    }

    assert.throws(
      () => verifyAndConsumeChallenge(tempDir, challengeId, dummyEvidence),
      /CHALLENGE_NOT_COMPLETED/
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('independentReviewController: fails when authoritative builder identity is absent with state_dir', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-ctrl-test-'))
  try {
    const mockAdapter: IndependentReviewWorkerAdapter = {
      adapter_id: 'mock-subagent-v1',
      agent_kind: 'codex',
      async launch() {
        throw new Error('Should not launch')
      },
    }

    const controller = createIndependentReviewController({
      controller_id: 'test-controller-1',
      state_dir: tempDir,
      adapter: mockAdapter,
    })

    const candidate = createSampleCandidate()
    await assert.rejects(
      async () => controller.review(candidate),
      /AUTHORITATIVE_BUILDER_IDENTITY_REQUIRED/
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('independentReviewController: fails when worker returns no explicit verdict', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-ctrl-test-'))
  try {
    const mockAdapter: IndependentReviewWorkerAdapter = {
      adapter_id: 'mock-subagent-v1',
      agent_kind: 'codex',
      async launch(req) {
        return {
          status: 'COMPLETED',
          reviewed_at: new Date().toISOString(),
          scope: [...req.candidate.scope],
          isolation: req.required_isolation,
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
    await assert.rejects(
      async () => controller.review(candidate, { builder: sampleBuilder }),
      /REVIEW_EXECUTION_FAILED: Missing or invalid review verdict/
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('independentReviewController: non-authoritative controller stamps LOCAL_UNAUTHENTICATED', async () => {
  const mockAdapter: IndependentReviewWorkerAdapter = {
    adapter_id: 'mock-subagent-v1',
    agent_kind: 'codex',
    async launch(req) {
      return {
        status: 'COMPLETED',
        verdict: 'APPROVE',
        reviewed_at: new Date().toISOString(),
        scope: [...req.candidate.scope],
        isolation: req.required_isolation,
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
    adapter: mockAdapter,
  })

  const candidate = createSampleCandidate()
  const handoff = await controller.review(candidate)

  assert.equal(handoff.provenance, 'LOCAL_UNAUTHENTICATED')
  assert.equal(handoff.reviews[0]!.provenance, 'LOCAL_UNAUTHENTICATED')
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
          reviewed_at: new Date().toISOString(),
          scope: [...req.candidate.scope],
          isolation: req.required_isolation,
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
    const handoff = await controller.review(candidate, { reviewCount: 2, builder: sampleBuilder })

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
          reviewed_at: new Date().toISOString(),
          scope: [...req.candidate.scope],
          isolation: req.required_isolation,
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
    const blockHandoff = await controller.review(candidate, { builder: sampleBuilder })
    assert.equal(blockHandoff.reviews[0]!.verdict, 'BLOCK')

    // Retry on the same candidate without repair must fail closed even if adapter wants to return APPROVE
    returnBlock = false
    await assert.rejects(
      async () => controller.review(candidate, { builder: sampleBuilder }),
      /PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR/
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('independentReviewController: multi-review round settles BLOCK even when peer reviewer fails', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-ctrl-test-'))
  try {
    let callCount = 0
    const mockAdapter: IndependentReviewWorkerAdapter = {
      adapter_id: 'mock-subagent-v1',
      agent_kind: 'codex',
      async launch(req) {
        callCount++
        if (callCount === 1) {
          return {
            status: 'COMPLETED',
            verdict: 'BLOCK',
            findings: ['Critical defect'],
            blocking_findings: ['Critical defect'],
            reviewed_at: new Date().toISOString(),
            scope: [...req.candidate.scope],
            isolation: req.required_isolation,
            runtime: {
              agent_kind: 'codex',
              adapter_id: 'mock-subagent-v1',
              controller_execution_id: req.reviewer.execution_id,
            },
          }
        }
        throw new Error('Adapter crashed during reviewer 2 execution')
      },
    }

    const controller = createIndependentReviewController({
      controller_id: 'test-controller-1',
      state_dir: tempDir,
      adapter: mockAdapter,
    })

    const candidate = createSampleCandidate()
    const handoff = await controller.review(candidate, { reviewCount: 2, builder: sampleBuilder })

    assert.equal(handoff.reviews.length, 1)
    assert.equal(handoff.reviews[0]!.verdict, 'BLOCK')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('autonomous engineering adapter: supports review and repair modes with native coding harnesses', async () => {
  const adapter = createAutonomousEngineeringAdapter({
    adapter_id: 'codex-native-adapter',
    agent_kind: 'codex',
    async reviewRunner(req) {
      return {
        status: 'COMPLETED',
        verdict: 'APPROVE',
        reviewed_at: new Date().toISOString(),
        scope: [...req.candidate.scope],
        isolation: req.required_isolation,
        execution_purpose: 'FINAL_CERTIFICATION',
        runtime: {
          agent_kind: 'codex',
          adapter_id: 'codex-native-adapter',
          controller_execution_id: req.reviewer.execution_id,
        },
      }
    },
    async repairRunner(req) {
      return {
        status: 'COMPLETED',
        modified: true,
        original_head_sha: req.candidate.head_sha,
        new_head_sha: 'd'.repeat(40),
        new_diff_numstat_digest: 'e'.repeat(64),
        producer: req.reviewer,
        commit_message: 'fix: address autonomous review finding',
        findings: ['Fixed state leakage bug'],
      }
    },
  })

  const req = {
    controller_id: 'ctrl-1',
    controller_run_id: 'run-1',
    challenge_id: 'ch-1',
    candidate: createSampleCandidate(),
    builder: sampleBuilder,
    reviewer: { kind: 'codex', principal_id: 'p-codex-1', execution_id: 'e-codex-1' },
    review_mode: 'exact_diff' as const,
    required_isolation: {
      candidate_write: false as const,
      github_mutation: false as const,
      merge: false as const,
      controller_state_access: false as const,
    },
  }

  // Test review mode
  const reviewResult = await adapter.launch(req)
  assert.equal(reviewResult.status, 'COMPLETED')
  assert.equal(reviewResult.verdict, 'APPROVE')

  // Test repair mode
  const repairResult = await adapter.repair!(req)
  assert.equal(repairResult.status, 'COMPLETED')
  assert.equal(repairResult.modified, true)
  assert.equal(repairResult.new_head_sha, 'd'.repeat(40))
  assert.equal(repairResult.producer.execution_id, 'e-codex-1')
})

test('independentReviewController: rejects certifier whose execution produced the candidate under review', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-ctrl-test-'))
  try {
    const repairExecutionId = 'exec-repair-agent-999'
    let launched = false

    const mockAdapter: IndependentReviewWorkerAdapter = {
      adapter_id: 'mock-subagent-v1',
      agent_kind: 'codex',
      async launch() {
        launched = true
        return {
          status: 'COMPLETED',
          verdict: 'APPROVE',
          reviewed_at: new Date().toISOString(),
          scope: ['src/index.ts'],
          isolation: { candidate_write: false, github_mutation: false, merge: false, controller_state_access: false },
          runtime: { agent_kind: 'codex', adapter_id: 'mock-subagent-v1', controller_execution_id: repairExecutionId },
        }
      },
    }

    // Controller creates an ID that collides with the repair producer
    const controller = createIndependentReviewController({
      controller_id: 'test-controller-1',
      state_dir: tempDir,
      adapter: mockAdapter,
      create_id: () => repairExecutionId,
    })

    const candidateWithProducer = {
      ...createSampleCandidate(),
      producer_execution_id: repairExecutionId,
    }

    await assert.rejects(
      async () => controller.review(candidateWithProducer, { builder: sampleBuilder }),
      /CANDIDATE_PRODUCER_CANNOT_CERTIFY/
    )
    assert.equal(launched, false)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})


