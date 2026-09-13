import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIsolatedWorktreeEngineeringAdapter } from './nativeEngineeringAdapter.js'
import type { IndependentReviewExecutionRequest } from './independentReviewController.js'

const sampleReq: IndependentReviewExecutionRequest = {
  controller_id: 'ctrl-1',
  controller_run_id: 'run-1',
  challenge_id: 'ch-1',
  candidate: {
    schema_version: 2,
    candidate_digest: 'c'.repeat(64),
    risk_tier: 'NORMAL',
    trust_mode: 'SELF_REVIEW',
    created_at: new Date().toISOString(),
    repository: 'gthgomez/Babel',
    pr_number: 180,
    task_id: 'task-180',
    task_hash: 'e'.repeat(64),
    base_sha: '20061f40630541f56ecbd179679d0e8aa1a833d7',
    head_sha: '20061f40630541f56ecbd179679d0e8aa1a833d7',
    builder_id: 'test-builder',
    diff_numstat_digest: 'd'.repeat(64),
    scope: ['README.md'],
  },
  builder: { kind: 'codex', principal_id: 'builder-1', execution_id: 'exec-b-1' },
  reviewer: { kind: 'gemini', principal_id: 'reviewer-1', execution_id: 'exec-r-1' },
  review_mode: 'exact_diff',
  required_isolation: {
    candidate_write: false,
    github_mutation: false,
    merge: false,
    controller_state_access: false,
  },
  purpose: 'FINAL_CERTIFICATION',
}

test('nativeEngineeringAdapter: fails closed when worker runner is missing', async () => {
  const adapter = createIsolatedWorktreeEngineeringAdapter({
    adapter_id: 'gemini-native-adapter',
    agent_kind: 'gemini',
    repoRoot: process.cwd(),
  })

  await assert.rejects(
    async () => adapter.launch(sampleReq),
    /AUTONOMOUS_REVIEW_RUNNER_REQUIRED/
  )

  await assert.rejects(
    async () => adapter.repair!(sampleReq),
    /AUTONOMOUS_REPAIR_RUNNER_REQUIRED/
  )
})

test('nativeEngineeringAdapter: executes review and repair in isolated worktree', async () => {
  const adapter = createIsolatedWorktreeEngineeringAdapter({
    adapter_id: 'gemini-native-adapter',
    agent_kind: 'gemini',
    repoRoot: resolve(fileURLToPath(new URL('../../..', import.meta.url))),
    async workerCommandRunner(worktreeDir, req) {
      if (req.purpose === 'REVIEW_REPAIR') {
        writeFileSync(join(worktreeDir, 'repair-marker.txt'), 'repair by autonomous agent\n')
        return {
          modified: true,
          commit_message: 'fix: automated repair from native adapter test',
          findings: ['Discovered and repaired issue'],
        }
      }
      return {
        verdict: 'APPROVE',
        findings: ['Clean review'],
        blocking_findings: [],
      }
    },
  })

  // 1. Launch review mode
  const reviewResult = await adapter.launch(sampleReq)
  assert.equal(reviewResult.status, 'COMPLETED')
  assert.equal(reviewResult.verdict, 'APPROVE')
  assert.equal(reviewResult.execution_purpose, 'FINAL_CERTIFICATION')

  // 2. Launch repair mode
  const repairReq = { ...sampleReq, purpose: 'REVIEW_REPAIR' as const }
  const repairResult = await adapter.repair!(repairReq)
  assert.equal(repairResult.status, 'COMPLETED')
  assert.equal(repairResult.modified, true)
  assert.ok(repairResult.new_head_sha)
  assert.notEqual(repairResult.new_head_sha, sampleReq.candidate.head_sha)
  assert.ok(repairResult.new_diff_numstat_digest)
  assert.equal(repairResult.producer.execution_id, sampleReq.reviewer.execution_id)
})
