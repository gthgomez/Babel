import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import type { RunnerInvocationMetadata } from '../runners/base.js'
import type { HostReviewCandidate, HostReviewExecutionRequest } from './hostReviewController.js'
import { createHostReviewWorker, type OpenCodeGoReviewRunner } from './hostReviewWorker.js'

const taskText = 'Review the exact supplied candidate.'
const numstat = ['1\t0\tsrc/example.ts']
const candidate: HostReviewCandidate = {
  repository: 'gthgomez/Babel',
  pr_number: 152,
  task_id: 'task-152',
  task_hash: digest(taskText),
  base_sha: 'a'.repeat(40),
  head_sha: 'b'.repeat(40),
  builder_id: 'builder:astra-1',
  diff_numstat_digest: digest(numstat.join('\n')),
  scope: ['src/example.ts'],
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function request(): HostReviewExecutionRequest {
  return {
    controller_id: 'host-controller:primary',
    controller_run_id: 'controller-run-1',
    execution_id: 'execution-1',
    candidate: { ...candidate, scope: [...candidate.scope] },
    reviewer_class: 'independent_readonly_ai',
    review_mode: 'exact_diff',
    required_isolation: { mode: 'text_only_no_tools', candidate_write: false, github_mutation: false, merge: false, controller_state_access: false },
  }
}

function metadata(overrides: Partial<RunnerInvocationMetadata> = {}): RunnerInvocationMetadata {
  return {
    provider: 'opencode-go',
    provider_model_id: 'deepseek-v4-flash',
    observed_model_id: 'deepseek-v4-flash',
    latency_ms: 12,
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    estimated_cost_usd: null,
    ...overrides,
  }
}

function runner(output: unknown, overrides: Partial<OpenCodeGoReviewRunner> = {}): OpenCodeGoReviewRunner & { calls: Array<{ prompt: string; systemPrompt: string | undefined }> } {
  const calls: Array<{ prompt: string; systemPrompt: string | undefined }> = []
  return {
    calls,
    execute: async <T>(prompt: string, _schema: unknown, _callbacks: undefined, systemPrompt: string | undefined): Promise<T> => {
      calls.push({ prompt, systemPrompt })
      return output as T
    },
    getLastInvocationMetadata: () => metadata(),
    getLastOpenCodeSessionId: () => 'opencode-session-1',
    ...overrides,
  }
}

function worker(modelRunner: OpenCodeGoReviewRunner) {
  return createHostReviewWorker({
    runner: modelRunner,
    reviewer_id: 'reviewer:astra-2',
    text_input: { candidate: { ...candidate, scope: [...candidate.scope] }, task_text: taskText, diff_text: 'diff --git a/src/example.ts b/src/example.ts\n+safe change', diff_numstat: [...numstat], scope: [...candidate.scope] },
    now: () => new Date('2026-09-07T00:00:00.000Z'),
  })
}

describe('hostReviewWorker', () => {
  it('makes one text-only request and records observed OpenCode-Go model and usage', async () => {
    const modelRunner = runner({ verdict: 'APPROVE', uncertain: false, findings: ['checked'], blocking_findings: [] })
    const result = await worker(modelRunner).launch(request())

    assert.equal(modelRunner.calls.length, 1)
    assert.match(modelRunner.calls[0]!.prompt, /<trusted-task-text>/)
    assert.match(modelRunner.calls[0]!.prompt, /<untrusted-diff-text>/)
    assert.doesNotMatch(modelRunner.calls[0]!.prompt, /shell|tool/i)
    assert.equal(result.review_provider, 'opencode-go')
    assert.equal(result.reviewer_model, 'deepseek-v4-flash')
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, latency_ms: 12 })
    assert.equal(result.verdict, 'APPROVE')
  })

  it('blocks explicit uncertainty and rejects malformed output without a retry', async () => {
    const uncertainRunner = runner({ verdict: 'BLOCK', uncertain: true, findings: [], blocking_findings: [] })
    const uncertain = await worker(uncertainRunner).launch(request())
    assert.equal(uncertain.verdict, 'BLOCK')
    assert.deepEqual(uncertain.blocking_findings, ['reviewer_reported_uncertainty'])

    const malformedRunner = runner({ verdict: 'UNKNOWN', uncertain: false, findings: [], blocking_findings: [] })
    await assert.rejects(worker(malformedRunner).launch(request()))
    assert.equal(malformedRunner.calls.length, 1)
  })

  it('rejects text snapshots with a wrong hash, scope, or observed provider attribution before publishing', async () => {
    const modelRunner = runner({ verdict: 'APPROVE', uncertain: false, findings: [], blocking_findings: [] })
    const badWorker = createHostReviewWorker({
      runner: modelRunner,
      reviewer_id: 'reviewer:astra-2',
      text_input: { candidate: { ...candidate }, task_text: `${taskText} changed`, diff_text: 'diff', diff_numstat: [...numstat], scope: [...candidate.scope] },
    })
    await assert.rejects(badWorker.launch(request()), /task_text does not match/)
    assert.equal(modelRunner.calls.length, 0)

    const attributionRunner = runner(
      { verdict: 'APPROVE', uncertain: false, findings: [], blocking_findings: [] },
      { getLastInvocationMetadata: () => metadata({ provider: 'unknown', observed_model_id: 'unknown' }) },
    )
    await assert.rejects(worker(attributionRunner).launch(request()), /lacks observed OpenCode-Go/)
  })
})
