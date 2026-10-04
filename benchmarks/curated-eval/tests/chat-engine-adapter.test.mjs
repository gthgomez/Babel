import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { adaptChatEngineResult } from '../adapters/chat-engine-result.mjs'

test('adapter preserves terminal outcome, separate model identity, usage, and explicit completion claim', () => {
  const attempt = adaptChatEngineResult({
    taskId: 'multi-file-csv-repair',
    requestedModel: 'deepseek-v4.1-flash',
    completionClaimed: true,
    completionClaimEvidence: 'Implemented and verified.',
    result: {
      status: 'completed',
      outcome: 'VERIFIED_COMPLETE',
      answer: 'Implemented and verified.',
      usage: {
        totalCostUSD: 0.012,
        totalInputTokens: 2000,
        totalOutputTokens: 400,
        totalTokens: 2400,
      },
      turnRouting: [{
        requested_model_id: 'requested-model',
        sent_model_id: 'sent-model',
        observed_model_id: 'observed-model',
      }],
    },
    harnessBuild: 'test-build',
    taskImage: 'node@sha256:abc',
    taskRevision: 'fixture-sha256:abc',
  })

  assert.equal(attempt.task_id, 'multi-file-csv-repair')
  assert.equal(attempt.terminal_status, 'completed')
  assert.equal(attempt.engine_terminal_outcome, 'VERIFIED_COMPLETE')
  assert.equal(attempt.completion_claimed, true)
  assert.equal(attempt.usage.input_tokens, 2000)
  assert.equal(attempt.usage.output_tokens, 400)
  assert.equal(attempt.usage.cost_usd, 0.012)
  assert.equal(attempt.requested_model, 'deepseek-v4.1-flash')
  assert.equal(attempt.model_routing.sent, 'sent-model')
  assert.equal(attempt.model_routing.observed, 'observed-model')
})

test('adapter classifies cancellation, budget truncation, and infrastructure distinctly', () => {
  const shared = { taskId: 'csv-rollup-cli', result: { answer: '', usage: {} } }
  assert.equal(adaptChatEngineResult({ ...shared, result: { ...shared.result, status: 'cancelled', outcome: 'CANCELLED' } }).outcome, 'cancelled')
  assert.equal(adaptChatEngineResult({ ...shared, result: { ...shared.result, status: 'budget_exhausted', outcome: 'BUDGET_EXHAUSTED' } }).outcome, 'budget_truncated')
  assert.equal(adaptChatEngineResult({ ...shared, result: { ...shared.result, status: 'failed', outcome: 'INFRA_FAILURE' } }).outcome, 'infrastructure_error')
  assert.equal(adaptChatEngineResult({ ...shared, result: { ...shared.result, status: 'failed', outcome: 'AGENT_FAILURE' } }).outcome, 'task_failure')
})

test('adapter leaves incomplete model and cost telemetry unknown', () => {
  const attempt = adaptChatEngineResult({
    taskId: 'csv-rollup-cli',
    result: { status: 'completed', answer: 'Done', usage: {}, turnRouting: [] },
  })
  assert.equal(attempt.usage.cost_usd, null)
  assert.equal(attempt.requested_model, null)
  assert.equal(attempt.sent_model, null)
  assert.equal(attempt.observed_model, null)
})

test('report schema covers every normalized ChatEngine adapter field', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const schema = JSON.parse(await readFile(path.join(root, 'report.schema.json'), 'utf8'))
  const attempt = adaptChatEngineResult({ taskId: 'csv-rollup-cli', result: { status: 'completed', answer: '', usage: {} } })
  assert.deepEqual([...schema.required].sort(), Object.keys(attempt).sort())
  for (const field of schema.required) assert.ok(schema.properties[field], `schema must define ${field}`)
  assert.ok(schema.properties.outcome.enum.includes('infrastructure_error'))
  assert.ok(schema.properties.outcome.enum.includes('budget_truncated'))
})
