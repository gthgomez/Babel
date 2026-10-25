import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runChatEngineCompactionFor, type ChatEngineCompactionBinding } from './chatEngineCompactionHost.js'
import { createParityRuntime } from './chatEngineParityBridge.js'
import { globalCostTracker } from '../services/costTracker.js'
import { captureChatUsageScope } from './chatEngineProviderAccounting.js'

for (const reportedCostUsd of [0.002, 0, undefined]) {
  test(`compaction host settles provider reported amount ${reportedCostUsd} with immutable inference identity`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'babel-compaction-charge-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const owner = randomUUID(); const inference = randomUUID()
    const taskAllowance = { taskOwnerId: owner }
    const engine = {
      options: { task: 'Inspect current app', projectRoot: root, model: 'deepseek/deepseek-v4-flash-0731' },
      modelPolicy: { provider: 'openrouter', providerModelId: 'deepseek/deepseek-v4-flash-0731' },
      limits: { maxEstimatedTokens: 1000 }, conversation: [{ role: 'user', content: 'Inspect current app' }],
      abortController: new AbortController(), writeCount: 0, _turnIndex: 1, toolCallLog: [],
      parity: createParityRuntime(owner), engineRunDir: root, taskAllowance,
      activeSubmissionGeneration: 1, lastLogicalRequestId: null, pendingParentRequestId: null, apiTokenCount: 0,
      isSubmissionCurrent: () => true, shouldUseTextTools: () => true, prepareCompactionGuard: () => () => true,
      resolveDeliberationRunnerForCompaction: () => ({}), compactConversation: () => {},
      captureProviderUsageScope: (generation: number) => captureChatUsageScope({
        options: engine.options, parity: engine.parity, taskAllowance,
        isSubmissionCurrent: value => engine.isSubmissionCurrent(value),
      }, generation),
      providerRetryCallbacks: ({ usageScope }: { usageScope: Record<string, unknown> }) => ({
        onInvocationStarted: () => Object.assign(usageScope, { chargeId: inference, requestId: 'request', attemptId: 'attempt', provider: 'openrouter' }),
      }),
      recordOwnerAccountingFault: () => { throw new Error('unexpected settlement conflict') },
      persistOwnerCharges: () => {}, persistTaskCostBaseline: () => {}, resetReadInjectionContext: () => {},
      compactionManager: { compactWithResult: async (messages: unknown[], options: import('./chatCompaction.js').CompactionOptions) => {
        options.callbacks?.onInvocationStarted?.({ inference_id: inference, provider: 'openrouter', requested_model_id: 'deepseek/deepseek-v4-flash-0731', normalized_model_id: 'deepseek/deepseek-v4-flash-0731', sent_model_id: 'deepseek/deepseek-v4-flash-0731', input_digest: 'fixture' })
        const usage = { inferenceId: inference, modelId: 'deepseek/deepseek-v4-flash-0731', inputTokens: 100, outputTokens: 10, provider: 'openrouter' as const, ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}) }
        options.onUsageRecorded?.(usage); options.onUsageRecorded?.(usage)
        return { messages, changed: false, status: 'noop', strategy: 'none', tokensBefore: 100, tokensAfter: 100, strategyErrors: [] }
      } },
    } as unknown as ChatEngineCompactionBinding
    engine.parity.liveAuthority = resolveLiveSessionAuthority({ mode: 'chat', projectRoot: root, task: 'Inspect current app' })
    await runChatEngineCompactionFor(engine, { forceCompaction: true })
    const summary = globalCostTracker.getTaskSummary(owner)
    assert.equal(summary.totalCostUSD, reportedCostUsd ?? 0)
    assert.equal(summary.unknownChargeCount, reportedCostUsd === undefined ? 1 : 0)
    assert.equal(globalCostTracker.getTaskChargeIds(owner).length, 1, 'duplicate callbacks never double charge')
    assert.equal(summary.completeCostUSD, reportedCostUsd === undefined ? null : reportedCostUsd)
  })
}
