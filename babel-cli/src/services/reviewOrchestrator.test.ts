import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CandidateEnvelope } from './hostReviewController.js'
import type {
  AutonomousEngineeringWorkerAdapter,
  AutonomousRepairResult,
  IndependentReviewExecutionRequest,
} from './independentReviewController.js'
import type {
  CandidateProducerLineage,
  ReviewActorIdentity,
} from './independentReviewEvidenceV3.js'
import { runReviewOrchestration, type CollectCandidateOptions } from './reviewOrchestrator.js'

const BUILDER: ReviewActorIdentity = {
  kind: 'codex',
  principal_id: 'builder-principal',
  execution_id: 'builder-execution',
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function headSha(n: number): string {
  return n.toString(16).padStart(40, 'a')
}

function makeCandidate(head: string, lineage?: CandidateProducerLineage, producerExecutionId?: string): CandidateEnvelope {
  const digest = sha(head)
  const candidate = {
    schema_version: 2,
    repository: 'gthgomez/Babel',
    pr_number: 267,
    task_id: 'pr-267',
    task_hash: sha('task'),
    base_sha: '0'.repeat(40),
    head_sha: head,
    tree_sha: '1'.repeat(40),
    builder_id: 'builder:babel-agent',
    diff_numstat_digest: digest,
    scope: ['babel-cli/src/services/reviewOrchestrator.ts'],
    risk_tier: 'NORMAL',
    trust_mode: 'SELF_REVIEW',
    task_contract_hash: sha('task'),
    omitted_files: [],
    created_at: new Date().toISOString(),
    candidate_digest: digest,
    ...(lineage ? { lineage } : {}),
    ...(producerExecutionId ? { producer_execution_id: producerExecutionId } : {}),
  }
  return candidate as unknown as CandidateEnvelope
}

interface ScriptedAdapterOptions {
  verdicts: Array<'APPROVE' | 'BLOCK'>
  repair?: (round: number, request: Readonly<IndependentReviewExecutionRequest>) => AutonomousRepairResult
}

function makeAdapter(options: ScriptedAdapterOptions): {
  adapter: AutonomousEngineeringWorkerAdapter
  launches: IndependentReviewExecutionRequest[]
} {
  const launches: IndependentReviewExecutionRequest[] = []
  let repairRound = 0
  const adapter: AutonomousEngineeringWorkerAdapter = {
    adapter_id: 'fake-subagent',
    agent_kind: 'opencode',
    async launch(request) {
      launches.push(request)
      const verdict = options.verdicts.shift() ?? 'APPROVE'
      return {
        status: 'COMPLETED',
        verdict,
        findings: [],
        blocking_findings: verdict === 'BLOCK' ? ['blocking defect'] : [],
        reviewed_at: new Date().toISOString(),
        scope: [...request.candidate.scope],
        isolation: request.required_isolation,
        execution_purpose: 'FINAL_CERTIFICATION',
        runtime: {
          agent_kind: 'opencode',
          adapter_id: 'fake-subagent',
          controller_execution_id: request.reviewer.execution_id,
          execution_purpose: 'FINAL_CERTIFICATION',
          requested_model: 'opencode-go/deepseek-v4.1-flash',
          model_attribution: 'configured',
          fresh_context: true,
          fresh_process: true,
        },
        usage: { tool_calls: 0 },
      }
    },
    ...(options.repair
      ? {
          async repair(request: Readonly<IndependentReviewExecutionRequest>) {
            return options.repair!(repairRound++, request)
          },
        }
      : {}),
  }
  return { adapter, launches }
}

function withStateDir(fn: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), 'review-orchestrator-'))
  return fn(stateDir).finally(() => rmSync(stateDir, { recursive: true, force: true }))
}

test('approves at the first round and returns certified V3 evidence', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter, launches } = makeAdapter({ verdicts: ['APPROVE'] })
    const collected: CollectCandidateOptions[] = []
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      collectCandidate: async (opts) => {
        collected.push(opts)
        return makeCandidate(headSha(1))
      },
    })
    assert.equal(result.status, 'MERGE_READY')
    assert.equal(result.repairRounds, 0)
    assert.equal(result.handoff?.reviews.length, 1)
    assert.equal(result.handoff?.reviews[0]!.head_sha, headSha(1))
    assert.equal(launches.length, 1)
    assert.equal(launches[0]!.reviewer.execution_id, result.handoff?.reviews[0]!.reviewer.execution_id)
  })
})

test('blocks, repairs, and fresh-certifies the new head (prior approval not reused)', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter, launches } = makeAdapter({
      verdicts: ['BLOCK', 'APPROVE'],
      repair: (round, request) => ({
        status: 'COMPLETED',
        modified: true,
        original_head_sha: request.candidate.head_sha,
        new_head_sha: headSha(2),
        new_diff_numstat_digest: sha(headSha(2)),
        producer: {
          kind: 'opencode',
          principal_id: `repair-principal-${round}`,
          execution_id: `repair-execution-${round}`,
        },
      }),
    })
    const collected: CollectCandidateOptions[] = []
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      collectCandidate: async (opts) => {
        collected.push(opts)
        const head = opts.headSha ?? headSha(1)
        return makeCandidate(head, opts.lineage, opts.producerExecutionId)
      },
    })
    assert.equal(result.status, 'MERGE_READY')
    assert.equal(result.repairRounds, 1)
    assert.equal(result.headSha, headSha(2))
    assert.equal(result.handoff?.reviews[0]!.head_sha, headSha(2))
    assert.equal(collected.length, 2)
    assert.equal(collected[1]!.headSha, headSha(2))
    assert.ok(collected[1]!.lineage, 'repair lineage recorded')
    assert.equal(collected[1]!.producerExecutionId, 'repair-execution-0')
    // Two rounds => two distinct challenges; the second review is a fresh execution.
    assert.equal(launches.length, 2)
    assert.notEqual(launches[0]!.challenge_id, launches[1]!.challenge_id)
    assert.notEqual(launches[0]!.reviewer.execution_id, launches[1]!.reviewer.execution_id)
  })
})

test('reports BLOCKED (awaiting repair) when no repair worker is configured', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter } = makeAdapter({ verdicts: ['BLOCK'] })
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      collectCandidate: async () => makeCandidate(headSha(1)),
    })
    assert.equal(result.status, 'BLOCKED')
    assert.equal(result.message, 'repair_not_supported')
    assert.deepEqual(result.blockingFindings, ['blocking defect'])
  })
})

test('escalates after the bounded repair rounds are exhausted', async () => {
  await withStateDir(async (stateDir) => {
    let round = 0
    const { adapter } = makeAdapter({
      verdicts: ['BLOCK', 'BLOCK'],
      repair: () => {
        round += 1
        return {
          status: 'COMPLETED',
          modified: true,
          original_head_sha: headSha(round),
          new_head_sha: headSha(round + 1),
          new_diff_numstat_digest: sha(headSha(round + 1)),
          producer: { kind: 'opencode', principal_id: `p-${round}`, execution_id: `e-${round}` },
        }
      },
    })
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      maxRepairRounds: 1,
      collectCandidate: async (opts) => makeCandidate(opts.headSha ?? headSha(1), opts.lineage, opts.producerExecutionId),
    })
    assert.equal(result.status, 'ESCALATED')
    assert.equal(result.message, 'max_repair_rounds_exhausted')
    assert.equal(result.repairRounds, 1)
  })
})

test('a repair producer is distinct from the fresh certifier', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter, launches } = makeAdapter({
      verdicts: ['BLOCK', 'APPROVE'],
      repair: (round, request) => ({
        status: 'COMPLETED',
        modified: true,
        original_head_sha: request.candidate.head_sha,
        new_head_sha: headSha(2),
        new_diff_numstat_digest: sha(headSha(2)),
        producer: { kind: 'opencode', principal_id: `rp-${round}`, execution_id: `repair-execution-${round}` },
      }),
    })
    await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      collectCandidate: async (opts) => makeCandidate(opts.headSha ?? headSha(1), opts.lineage, opts.producerExecutionId),
    })
    const certifier = launches[1]!
    assert.equal(certifier.candidate.lineage?.producer.execution_id, 'repair-execution-0')
    assert.notEqual(certifier.reviewer.execution_id, 'repair-execution-0')
    assert.notEqual(certifier.reviewer.principal_id, 'rp-0')
  })
})

test('a repair that does not change the candidate cannot be re-reviewed into approval', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter } = makeAdapter({
      verdicts: ['BLOCK', 'BLOCK', 'APPROVE'],
      repair: (round, request) => ({
        status: 'COMPLETED',
        modified: true,
        original_head_sha: request.candidate.head_sha,
        // Returns the SAME head: the candidate digest is unchanged, so the
        // controller's anti-approval-shopping guard must refuse a re-review.
        new_head_sha: request.candidate.head_sha,
        new_diff_numstat_digest: request.candidate.diff_numstat_digest,
        producer: { kind: 'opencode', principal_id: `rp-${round}`, execution_id: `e-${round}` },
      }),
    })
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      maxRepairRounds: 3,
      collectCandidate: async (opts) => makeCandidate(opts.headSha ?? headSha(1), opts.lineage, opts.producerExecutionId),
    })
    assert.equal(result.status, 'ESCALATED')
    assert.match(result.message, /repair_produced_no_diff_change|controller_error:/)
  })
})

test('a repair that advances the head but leaves the diff identical is rejected as a no-op mutation', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter } = makeAdapter({
      verdicts: ['BLOCK', 'APPROVE'],
      repair: (round, request) => ({
        status: 'COMPLETED',
        modified: true,
        original_head_sha: request.candidate.head_sha,
        new_head_sha: headSha(2),
        // Same diff as the blocked candidate => no real mutation.
        new_diff_numstat_digest: request.candidate.diff_numstat_digest,
        producer: { kind: 'opencode', principal_id: `rp-${round}`, execution_id: `e-${round}` },
      }),
    })
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      collectCandidate: async (opts) => {
        const head = opts.headSha ?? headSha(1)
        const collected = makeCandidate(head, opts.lineage, opts.producerExecutionId)
        // A no-op mutation: the new head carries the same diff digest.
        return head === headSha(1) ? collected : { ...collected, diff_numstat_digest: sha(headSha(1)) }
      },
    })
    assert.equal(result.status, 'ESCALATED')
    assert.equal(result.message, 'repair_produced_no_diff_change')
  })
})

test('the no-op guard does not trust an absent adapter diff digest', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter } = makeAdapter({
      verdicts: ['BLOCK', 'APPROVE'],
      repair: (round, request) => ({
        status: 'COMPLETED',
        modified: true,
        original_head_sha: request.candidate.head_sha,
        new_head_sha: headSha(2),
        // new_diff_numstat_digest intentionally omitted.
        producer: { kind: 'opencode', principal_id: `rp-${round}`, execution_id: `e-${round}` },
      }),
    })
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      collectCandidate: async (opts) => {
        const head = opts.headSha ?? headSha(1)
        const collected = makeCandidate(head, opts.lineage, opts.producerExecutionId)
        return head === headSha(1) ? collected : { ...collected, diff_numstat_digest: sha(headSha(1)) }
      },
    })
    assert.equal(result.status, 'ESCALATED')
    assert.equal(result.message, 'repair_produced_no_diff_change')
  })
})

test('a BLOCK verdict with empty blocking_findings is never certified', async () => {
  await withStateDir(async (stateDir) => {
    const adapter: AutonomousEngineeringWorkerAdapter = {
      adapter_id: 'fake-empty-block',
      agent_kind: 'opencode',
      async launch(request) {
        return {
          status: 'COMPLETED',
          verdict: 'BLOCK',
          findings: ['looks wrong'],
          blocking_findings: [],
          reviewed_at: new Date().toISOString(),
          scope: [...request.candidate.scope],
          isolation: request.required_isolation,
          execution_purpose: 'FINAL_CERTIFICATION',
          runtime: {
            agent_kind: 'opencode',
            adapter_id: 'fake-empty-block',
            controller_execution_id: request.reviewer.execution_id,
            execution_purpose: 'FINAL_CERTIFICATION',
          },
        }
      },
    }
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      collectCandidate: async () => makeCandidate(headSha(1)),
    })
    assert.notEqual(result.status, 'MERGE_READY')
    assert.equal(result.status, 'BLOCKED')
    assert.ok(result.blockingFindings.length > 0, 'a synthesized blocker is reported')
  })
})

test('rejects an invalid maxRepairRounds instead of looping unbounded', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter } = makeAdapter({ verdicts: ['APPROVE'] })
    await assert.rejects(
      runReviewOrchestration({
        adapter,
        stateDir,
        builder: BUILDER,
        maxRepairRounds: Number.NaN,
        collectCandidate: async () => makeCandidate(headSha(1)),
      }),
      /INVALID_MAX_REPAIR_ROUNDS/,
    )
  })
})

test('a policy escalation runs two independent reviewers per round', async () => {
  await withStateDir(async (stateDir) => {
    const { adapter, launches } = makeAdapter({ verdicts: ['APPROVE', 'APPROVE'] })
    const result = await runReviewOrchestration({
      adapter,
      stateDir,
      builder: BUILDER,
      collectCandidate: async () => {
        const candidate = makeCandidate(headSha(1))
        return { ...candidate, risk_tier: 'CRITICAL' } as CandidateEnvelope
      },
    })
    assert.equal(result.status, 'MERGE_READY')
    assert.equal(result.handoff?.reviews.length, 2)
    assert.equal(launches.length, 2)
    assert.notEqual(launches[0]!.reviewer.principal_id, launches[1]!.reviewer.principal_id)
  })
})
