import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOpenCodeReviewAdapter,
  type OpenCodeSpawnFn,
  type OpenCodeSpawnResult,
} from './orchestratorReviewAdapter.js'
import type { IndependentReviewExecutionRequest } from './independentReviewController.js'

function createRequest(overrides?: Partial<IndependentReviewExecutionRequest>): IndependentReviewExecutionRequest {
  return {
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
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      builder_id: 'test-builder',
      diff_numstat_digest: 'd'.repeat(64),
      scope: ['src/services/orchestratorReviewAdapter.ts'],
    },
    builder: { kind: 'codex', principal_id: 'builder-1', execution_id: 'exec-b-1' },
    reviewer: { kind: 'opencode', principal_id: 'reviewer-1', execution_id: 'exec-r-1' },
    review_mode: 'exact_diff',
    required_isolation: {
      candidate_write: false,
      github_mutation: false,
      merge: false,
      controller_state_access: false,
    },
    purpose: 'FINAL_CERTIFICATION',
    ...overrides,
  }
}

function reviewTextEvent(payload: unknown): { type: string; text: string } {
  return { type: 'text', text: JSON.stringify(payload) }
}

function successSpawn(payload: unknown, sessionId = 'sess-abc'): OpenCodeSpawnFn {
  return async (): Promise<OpenCodeSpawnResult> => ({
    exitCode: 0,
    events: [
      { type: 'tool', name: 'file_read' },
      reviewTextEvent(payload),
    ],
    sessionId,
  })
}

function createAdapter(spawnFn: OpenCodeSpawnFn) {
  return createOpenCodeReviewAdapter({
    model: 'opencode-go/glm-5',
    cwd: process.cwd(),
    agentConfigPath: 'agents/reviewer.md',
    spawnFn,
  })
}

test('orchestratorReviewAdapter: maps a successful spawn to COMPLETED evidence without fabricating a provider', async () => {
  const req = createRequest()
  const adapter = createAdapter(
    successSpawn({
      verdict: 'APPROVE',
      findings: ['looks good'],
      blocking_findings: [],
      reviewed_files: ['src/services/orchestratorReviewAdapter.ts'],
      summary: 'clean review',
    })
  )

  const result = await adapter.launch(req)

  assert.equal(result.status, 'COMPLETED')
  assert.equal(result.verdict, 'APPROVE')
  assert.deepEqual(result.scope, req.candidate.scope)
  assert.equal(result.execution_purpose, 'FINAL_CERTIFICATION')
  assert.equal(result.isolation, req.required_isolation)
  assert.ok(result.reviewed_at)

  const runtime = result.runtime
  assert.ok(runtime)
  assert.equal(runtime.agent_kind, 'opencode')
  assert.equal(runtime.adapter_id, 'opencode-subagent-v1')
  assert.equal(runtime.controller_execution_id, req.reviewer.execution_id)
  assert.equal(runtime.requested_model, 'opencode-go/glm-5')
  assert.equal(runtime.model_attribution, 'configured')
  assert.equal(runtime.fresh_context, true)
  assert.equal(runtime.fresh_process, true)
  assert.equal(runtime.session_id, 'sess-abc')

  // External adapter must not claim a provider it cannot observe/attribute.
  assert.equal(runtime.requested_provider, undefined)
  assert.equal(runtime.observed_provider, undefined)
  assert.equal('requested_provider' in runtime, false)
  assert.equal('observed_provider' in runtime, false)

  // Required interface identity.
  assert.equal(adapter.adapter_id, 'opencode-subagent-v1')
  assert.equal(adapter.agent_kind, 'opencode')
})

test('orchestratorReviewAdapter: non-zero exit is FAILED and never APPROVE', async () => {
  const adapter = createAdapter(async () => ({
    exitCode: 1,
    events: [reviewTextEvent({ verdict: 'APPROVE', findings: [], blocking_findings: [] })],
  }))

  const result = await adapter.launch(createRequest())

  assert.equal(result.status, 'FAILED')
  assert.match(result.failure_reason ?? '', /OPENCODE_EXIT_1/)
  assert.notEqual(result.verdict, 'APPROVE')
})

test('orchestratorReviewAdapter: truncated or invalid JSON is FAILED and never APPROVE', async () => {
  const adapter = createAdapter(async () => ({
    exitCode: 0,
    events: [{ type: 'text', text: '{"verdict":"APPROVE","findings":[' }],
  }))

  const result = await adapter.launch(createRequest())

  assert.equal(result.status, 'FAILED')
  assert.notEqual(result.verdict, 'APPROVE')
})

test('orchestratorReviewAdapter: malformed blocking_findings fails closed instead of coercing to empty', async () => {
  const adapter = createAdapter(
    successSpawn({ verdict: 'APPROVE', findings: [], blocking_findings: 'a critical defect', reviewed_files: [] })
  )

  const result = await adapter.launch(createRequest())

  assert.equal(result.status, 'FAILED')
  assert.notEqual(result.verdict, 'APPROVE')
})

test('orchestratorReviewAdapter: malformed findings array fails closed', async () => {
  const adapter = createAdapter(
    successSpawn({ verdict: 'APPROVE', findings: { claim: 'x' }, blocking_findings: [], reviewed_files: [] })
  )

  const result = await adapter.launch(createRequest())

  assert.equal(result.status, 'FAILED')
  assert.notEqual(result.verdict, 'APPROVE')
})

test('orchestratorReviewAdapter: APPROVE with a blocking finding is downgraded to BLOCK', async () => {
  const adapter = createAdapter(
    successSpawn({
      verdict: 'APPROVE',
      findings: ['a blocking defect'],
      blocking_findings: ['a blocking defect'],
      reviewed_files: [],
      summary: 'contradictory verdict',
    })
  )

  const result = await adapter.launch(createRequest())

  assert.equal(result.status, 'COMPLETED')
  assert.notEqual(result.verdict, 'APPROVE')
  assert.equal(result.verdict, 'BLOCK')
  assert.deepEqual(result.blocking_findings, ['a blocking defect'])
})

test('orchestratorReviewAdapter: distinct reviewer executions produce distinct controller execution ids', async () => {
  const adapter = createAdapter(successSpawn({ verdict: 'APPROVE', findings: [], blocking_findings: [] }))

  const first = await adapter.launch(createRequest({ reviewer: { kind: 'opencode', principal_id: 'p-1', execution_id: 'exec-1' } }))
  const second = await adapter.launch(createRequest({ reviewer: { kind: 'opencode', principal_id: 'p-2', execution_id: 'exec-2' } }))

  assert.equal(first.runtime?.controller_execution_id, 'exec-1')
  assert.equal(second.runtime?.controller_execution_id, 'exec-2')
  assert.notEqual(first.runtime?.controller_execution_id, second.runtime?.controller_execution_id)
})

test('orchestratorReviewAdapter: throws when model, cwd, or agentConfigPath is missing', () => {
  assert.throws(
    () => createOpenCodeReviewAdapter({ model: '', cwd: process.cwd(), agentConfigPath: 'a.md' }),
    /OPENCODE_ADAPTER_MODEL_REQUIRED/
  )
  assert.throws(
    () => createOpenCodeReviewAdapter({ model: 'm', cwd: '', agentConfigPath: 'a.md' }),
    /OPENCODE_ADAPTER_CWD_REQUIRED/
  )
  assert.throws(
    () => createOpenCodeReviewAdapter({ model: 'm', cwd: process.cwd(), agentConfigPath: '   ' }),
    /OPENCODE_ADAPTER_AGENT_CONFIG_REQUIRED/
  )
})
