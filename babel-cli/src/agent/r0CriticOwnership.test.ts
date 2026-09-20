/**
 * R0 final critic-ownership regression.
 *
 * This drives ChatEngine's production runAsymmetricDiffCritic wrapper with a
 * real asynchronous critic inference. The provider latch is released only
 * after the same engine has advanced to a new submission generation.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChatEngine } from './chatEngine.js'

const MANAGED_ENV = ['BABEL_OFFLINE', 'BABEL_DIFF_CRITIC', 'BABEL_DIFF_CRITIC_PRO'] as const
let envSnapshot: Record<string, string | undefined> = {}

before(() => {
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]))
  process.env['BABEL_OFFLINE'] = '1'
  process.env['BABEL_DIFF_CRITIC'] = '1'
  delete process.env['BABEL_DIFF_CRITIC_PRO']
})

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = envSnapshot[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed: ' + result.stderr)
}

function createModifiedGitProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-r0-critic-'))
  git(root, ['init'])
  git(root, ['config', 'user.email', 'babel-test@example.com'])
  git(root, ['config', 'user.name', 'Babel Test'])
  writeFileSync(join(root, 'main.ts'), 'export const value = 1\n', 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'init'])
  writeFileSync(join(root, 'main.ts'), 'export const value = 2\n', 'utf8')
  return root
}

function usageMetadata() {
  return {
    provider_model_id: 'critic-test-model',
    prompt_tokens: 90_000,
    completion_tokens: 12_000,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 90_000,
    estimated_cost_usd: 4.25,
  }
}

function internals(engine: ChatEngine): {
  activeSubmissionGeneration: number
  generationCounter: number
  apiTokenCount: number
  lastRequestPromptTokens: number | null
  lastRequestCompletionTokens: number | null
  lastRequestModelId: string | null
  routingReceiptLog: { all: () => ReadonlyArray<unknown> }
  conversation: Array<{ role: string; content: string }>
  lastCriticReceipt: { verdict: string } | null
  criticStrikes: number
  criticRepairCostCapUsd: number | null
  postWriteRepairWallCapMs: number | null
  taskAllowance: { consumed: { costUsd: number }; accountedChargeIds: string[] }
  toolCallLog: Array<Record<string, unknown>>
  criticRunner: unknown
  runAsymmetricDiffCritic: (
    answer: string,
    callbacks: { onThought?: (message: string) => void },
    taskIntent: 'execute' | 'explain',
    opts?: { terminal?: boolean },
  ) => Promise<'allow' | 'reject' | 'block'>
} {
  return engine as unknown as ReturnType<typeof internals>
}

test('stale critic inference cannot mutate the current task owner', async () => {
  const root = createModifiedGitProject()
  const criticStarted = deferred()
  const releaseCritic = deferred()
  let invocationCount = 0
  const criticRunner = {
    async executeRaw() {
      invocationCount += 1
      criticStarted.resolve()
      await releaseCritic.promise
      return JSON.stringify({
        verdict: 'reject',
        confidence: 0.99,
        reasons: ['Task A patch is deliberately rejected by the paused critic'],
      })
    },
    getLastInvocationMetadata() {
      return usageMetadata()
    },
  }

  try {
    const engine = new ChatEngine({
      task: 'Task A: mutate the project',
      projectRoot: root,
      model: 'deepseek-v4-flash',
      runId: 'r0-critic-' + Math.random().toString(36).slice(2, 10),
    })
    const box = internals(engine)
    box.criticRunner = criticRunner
    box.apiTokenCount = 0
    box.activeSubmissionGeneration = 1
    box.generationCounter = 1
    box.toolCallLog.push({
      tool: 'write_file',
      target: 'main.ts',
      effect_status: 'confirmed_change',
      mutation_paths: ['main.ts'],
    })

    const aCritic = box.runAsymmetricDiffCritic(
      'Task A final answer',
      {},
      'execute',
    )
    await criticStarted.promise

    // Task B is now the live owner and remains mid-turn while A is suspended.
    box.activeSubmissionGeneration = 2
    box.generationCounter = 2
    box.conversation.push({ role: 'user', content: 'Task B: inspect only' })
    box.lastCriticReceipt = { verdict: 'pass' }
    box.criticStrikes = 0
    box.criticRepairCostCapUsd = null
    box.postWriteRepairWallCapMs = null
    const baseline = {
      apiTokenCount: box.apiTokenCount,
      promptTokens: box.lastRequestPromptTokens,
      completionTokens: box.lastRequestCompletionTokens,
      modelId: box.lastRequestModelId,
      costUsd: box.taskAllowance.consumed.costUsd,
      chargeIds: [...box.taskAllowance.accountedChargeIds],
      routingReceipts: box.routingReceiptLog.all().length,
      conversation: box.conversation.map((message) => ({ ...message })),
      receipt: box.lastCriticReceipt,
      strikes: box.criticStrikes,
      repairCap: box.criticRepairCostCapUsd,
      repairWall: box.postWriteRepairWallCapMs,
    }

    releaseCritic.resolve()
    const staleDecision = await aCritic

    assert.equal(invocationCount, 1)
    assert.equal(staleDecision, 'allow', 'stale critic result is a no-op')
    assert.equal(box.apiTokenCount, baseline.apiTokenCount)
    assert.equal(box.lastRequestPromptTokens, baseline.promptTokens)
    assert.equal(box.lastRequestCompletionTokens, baseline.completionTokens)
    assert.equal(box.lastRequestModelId, baseline.modelId)
    assert.equal(box.taskAllowance.consumed.costUsd, baseline.costUsd)
    assert.deepEqual(box.taskAllowance.accountedChargeIds, baseline.chargeIds)
    assert.equal(box.routingReceiptLog.all().length, baseline.routingReceipts)
    assert.deepEqual(box.conversation, baseline.conversation)
    assert.deepEqual(box.lastCriticReceipt, baseline.receipt)
    assert.equal(box.criticStrikes, baseline.strikes)
    assert.equal(box.criticRepairCostCapUsd, baseline.repairCap)
    assert.equal(box.postWriteRepairWallCapMs, baseline.repairWall)
    assert.equal(readFileSync(join(root, 'main.ts'), 'utf8'), 'export const value = 2\n')

    // Negative control: a current-owner critic still applies its reject,
    // usage metadata, conversation feedback, and strike normally.
    box.toolCallLog.length = 0
    box.toolCallLog.push({
      tool: 'write_file',
      target: 'main.ts',
      effect_status: 'confirmed_change',
      mutation_paths: ['main.ts'],
    })
    box.criticRunner = {
      async executeRaw() {
        return JSON.stringify({
          verdict: 'reject',
          confidence: 0.99,
          reasons: ['Current-owner rejection'],
        })
      },
      getLastInvocationMetadata() {
        return usageMetadata()
      },
    }
    const currentDecision = await box.runAsymmetricDiffCritic(
      'Task B final answer',
      {},
      'execute',
    )
    assert.equal(currentDecision, 'reject')
    assert.equal(box.apiTokenCount, baseline.apiTokenCount + 102_000)
    assert.equal(box.lastRequestPromptTokens, 90_000)
    assert.equal(box.lastRequestCompletionTokens, 12_000)
    assert.equal(box.lastRequestModelId, 'critic-test-model')
    assert.equal(box.taskAllowance.consumed.costUsd > baseline.costUsd, true)
    assert.equal(box.routingReceiptLog.all().length, baseline.routingReceipts + 1)
    assert.equal(box.lastCriticReceipt?.verdict, 'reject')
    assert.equal(box.criticStrikes, 1)
    assert.equal(
      box.conversation.some((message) => message.content.includes('Current-owner rejection')),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
