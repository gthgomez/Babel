import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
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

test('nativeEngineeringAdapter: executes review and repair in isolated worktree', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'babel-native-adapter-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const repoRoot = join(fixture, 'seed')
  const worktreeBaseDir = join(fixture, 'workers')
  mkdirSync(repoRoot)
  mkdirSync(worktreeBaseDir)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  }).trim()
  git('init', '--initial-branch=main')
  git('config', '--local', 'user.name', 'Babel fixture')
  git('config', '--local', 'user.email', 'fixture@example.invalid')
  git('config', '--local', 'core.autocrlf', 'false')
  writeFileSync(join(repoRoot, 'README.md'), '# Isolated adapter fixture\n')
  git('add', 'README.md')
  git('commit', '-m', 'Seed fixture')
  const head = git('rev-parse', 'HEAD')
  const request = { ...sampleReq, candidate: { ...sampleReq.candidate, base_sha: head, head_sha: head } }
  const adapter = createIsolatedWorktreeEngineeringAdapter({
    adapter_id: 'gemini-native-adapter',
    agent_kind: 'gemini',
    repoRoot,
    worktreeBaseDir,
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
  const reviewResult = await adapter.launch(request)
  assert.equal(reviewResult.status, 'COMPLETED')
  assert.equal(reviewResult.verdict, 'APPROVE')
  assert.equal(reviewResult.execution_purpose, 'FINAL_CERTIFICATION')

  // 2. Launch repair mode
  const repairReq = { ...request, purpose: 'REVIEW_REPAIR' as const }
  const repairResult = await adapter.repair!(repairReq)
  assert.equal(repairResult.status, 'COMPLETED')
  assert.equal(repairResult.modified, true)
  assert.ok(repairResult.new_head_sha)
  assert.notEqual(repairResult.new_head_sha, head)
  assert.ok(repairResult.new_diff_numstat_digest)
  assert.equal(repairResult.producer.execution_id, sampleReq.reviewer.execution_id)
  assert.equal(git('rev-parse', 'HEAD'), head, 'Seed checkout must remain unchanged')
  assert.equal(git('status', '--porcelain'), '', 'Repair must not modify the seed checkout')
})
