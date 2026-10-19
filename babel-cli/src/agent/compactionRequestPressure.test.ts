import assert from 'node:assert/strict'
import test from 'node:test'
import { CompactionManager, HeuristicTruncationStrategy, LLMSummarizeCompaction, estimateTokens, type ChatMessage } from './chatCompaction.js'
import { prepareProviderRequest } from '../runners/preparedProviderRequest.js'
import { deriveCompactionRecoveryPressure, rebuildTextRecoveryRequest } from './compactionRequestPressure.js'
import { runChatEngineCompaction, type ChatEngineCompactionHost } from './compactionCommit.js'
import { createThreadEventLog, startTurn, recordUserMessage, recordAssistantMessage,
  rebuildProviderMessagesFromEvents } from './threadEventLog.js'
import { createSessionEventLog } from './sessionEvents.js'
import { CondensationFactEmitter } from '../services/condensationFacts.js'

test('request overflow recovers removable history below the routine history threshold', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? 'assistant' as const : 'user' as const,
    content: 'history '.repeat(25),
  }))
  const body = {
    model: 'synthetic-model',
    messages: [{ role: 'system', content: 'instruction '.repeat(50) }, ...messages],
    tools: [{ type: 'function', function: {
      name: 'inspect', description: 'tool schema '.repeat(50),
      parameters: { type: 'object', properties: {} },
    } }],
    max_tokens: 512,
  }
  const unbounded = prepareProviderRequest({
    body: JSON.stringify(body), mode: 'native', provider: 'synthetic',
    requestedModelId: body.model, contextLimitTokens: null, reservedCompletionTokens: 512,
  })
  assert.ok(unbounded.accounting.estimated_total_tokens !== null)
  const ceiling = unbounded.accounting.estimated_total_tokens - 100
  const request = prepareProviderRequest({
    body: JSON.stringify(body), mode: 'native', provider: 'synthetic',
    requestedModelId: body.model, contextLimitTokens: ceiling, reservedCompletionTokens: 512,
  })
  assert.equal(request.admission, 'over_limit')
  const historyTokens = estimateTokens(messages)
  assert.ok(historyTokens < 9000)
  // A control proves the fixed instructions, tools and reserve leave room for
  // a pruned conversation under the same ceiling that rejected the request.
  const strategy = new HeuristicTruncationStrategy()
  const compacted = await strategy.compact(messages, { model: body.model, maxTokens: 10000 })
  const control = prepareProviderRequest({
    body: JSON.stringify({ ...body, messages: [body.messages[0], ...compacted] }),
    mode: 'native', provider: 'synthetic', requestedModelId: body.model,
    contextLimitTokens: ceiling, reservedCompletionTokens: 512,
  })
  assert.equal(control.admission, 'qualified')
  const result = await new CompactionManager([strategy]).compactWithResult(messages, {
    model: body.model, maxTokens: 10000, allowAmbientProvider: false,
    requestContext: {
      reason: 'request_overflow', historyTokenEstimate: historyTokens,
      eligibilityTokenCap: 9000, maxTokens: 10000, compactionRequested: true,
      recoveryPressure: {
        requestId: request.request_id, requestDigest: request.body_digest,
        contextLimitTokens: ceiling,
        inputTokens: request.accounting.estimated_input_tokens!,
        reservedCompletionTokens: 512, requiredReductionTokens: 100,
      },
    },
  })
  assert.equal(result.changed, true)
  assert.equal(result.status, 'applied')
})

test('pressure uses the complete request accounting and counts output reserve once', () => {
  for (const mode of ['native', 'text', 'legacy'] as const) {
    const body = JSON.stringify({ model: 'synthetic-model',
      messages: [{ role: 'system', content: 'rules '.repeat(2000) }],
      tools: [{ description: 'schema '.repeat(2000) }] })
    const unbounded = prepareProviderRequest({ body, mode, provider: 'synthetic',
      requestedModelId: 'synthetic-model', contextLimitTokens: null, reservedCompletionTokens: 512 })
    assert.equal(deriveCompactionRecoveryPressure(unbounded), null)
    const limit = unbounded.accounting.estimated_total_tokens! - 2000
    const request = prepareProviderRequest({ body, mode, provider: 'synthetic',
      requestedModelId: 'synthetic-model', contextLimitTokens: limit, reservedCompletionTokens: 512 })
    const pressure = deriveCompactionRecoveryPressure(request)!
    assert.equal(pressure.requiredReductionTokens, 2000)
    assert.equal(pressure.inputTokens + pressure.reservedCompletionTokens - limit, 2000)
    assert.equal(pressure.requestId, request.request_id)
    assert.equal(pressure.requestDigest, request.body_digest)
    assert.equal(Object.isFrozen(pressure), true)
  }
})

for (const managerEnabled of [true, false]) for (const capacity of ['fits', 'failed-ceiling', 'current-ceiling', 'summary-overhead',
  'summary-overhead-fails', ...(managerEnabled ? ['summary-cancelled'] : [])]) {
  test(`atomic recovery (LLM manager ${managerEnabled ? 'enabled' : 'disabled'}, ${capacity})`, async t => {
    const cannotFit = capacity === 'failed-ceiling' || capacity === 'current-ceiling' ||
      capacity === 'summary-overhead-fails' || capacity === 'summary-cancelled'
    const summaryCase = capacity.startsWith('summary-')
    const task = 'preserve this task'
    const model = 'deepseek-v4-flash'
    const threadLog = createThreadEventLog()
    const sessionLog = createSessionEventLog()
    const turnId = startTurn(threadLog, { task, model, provider: 'synthetic',
      projectRoot: '.', policyPreset: 'chat' })
    const conversation: ChatMessage[] = [{ role: 'system', content: 'current instructions' }]
    for (let index = 0; index < 8; index++) {
      const user = `${task} old user ${index} ${'x'.repeat(4000)}`
      const assistant = `old answer ${index} ${'x'.repeat(4000)}`
      recordUserMessage(threadLog, turnId, user)
      recordAssistantMessage(threadLog, turnId, assistant)
      conversation.push({ role: 'user', content: user }, { role: 'assistant', content: assistant })
    }
    const serialize = () => JSON.stringify({ model,
      messages: [{ role: 'system', content: 'mandatory rule '.repeat(2000) },
        ...rebuildProviderMessagesFromEvents(threadLog)],
      tools: [{ description: 'mandatory schema '.repeat(2000) }], max_tokens: 512 })
    const original = serialize()
    const draft = prepareProviderRequest({ body: original, mode: 'native', provider: 'synthetic',
      requestedModelId: model, contextLimitTokens: null, reservedCompletionTokens: 512 })
    const ceiling = capacity === 'failed-ceiling' || capacity === 'summary-overhead-fails' ? 1024
      : draft.accounting.estimated_total_tokens! - (summaryCase ? 11000 : 3000)
    const failed = prepareProviderRequest({ body: original, mode: 'native', provider: 'synthetic',
      requestedModelId: model, contextLimitTokens: ceiling, reservedCompletionTokens: 512 })
    const pressure = deriveCompactionRecoveryPressure(failed)!
    let checkpointCount = 0
    let observedReason = ''
    const manager = new CompactionManager(summaryCase
      ? [new LLMSummarizeCompaction(), new HeuristicTruncationStrategy()]
      : [new HeuristicTruncationStrategy()])
    let summaryCalls = 0
    let usageSettlements = 0
    const facts: unknown[] = []
    let sequence = 0
    const emitter = new CondensationFactEmitter({ threadId: 'fixture', runId: 'fixture' }, () => ++sequence)
    const abortController = new AbortController()
    const host: ChatEngineCompactionHost = {
      conversation, options: { task, model },
      modelPolicy: { contextWindow: capacity === 'current-ceiling' ? 1024 : 1_000_000 },
      limits: { maxEstimatedTokens: 100_000 }, abortSignal: abortController.signal,
      writeCount: 0, turnIndex: 1, toolCallLog: [],
      progress: { receipts: [], consecutiveNoProgress: 0 }, threadLog, sessionLog, turnId,
      compactionManager: { compactWithResult: async (messages, options) => {
        observedReason = options.requestContext!.reason
        assert.equal(options.requestContext!.recoveryPressure, pressure)
        return manager.compactWithResult(messages, options)
      } },
      compactionProviderId: 'synthetic', providerReservedCompletionTokens: 512,
      shouldUseTextTools: () => false, compactHeuristic: () => assert.fail('manager must be eligible'),
      checkpoint: async () => { checkpointCount++ }, reserveTokens: 8000, textToolsReserve: 1024,
      resolveModel: () => model, shouldCompactByTokens: () => false,
      estimateTokens, recoveryPressure: pressure, serializeNativeProviderRequestBody: serialize,
    }
    if (summaryCase) {
      t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        summaryCalls++
        const tokens = JSON.parse(String(init.body)).max_tokens
        assert.ok(tokens > 0 && tokens < 4000)
        return new Response(JSON.stringify({ choices: [{ message: { content: 'S'.repeat(tokens * 4) } }],
          usage: { prompt_tokens: 100, completion_tokens: tokens } }), { status: 200 })
      })
      host.summarizationProvider = { apiKey: 'fixture-only', baseUrl: 'https://openrouter.invalid/chat/completions', defaultModel: model }
      host.onCompactionUsage = () => {
        usageSettlements++
        if (capacity === 'summary-cancelled') abortController.abort()
      }
      host.condensationFacts = { emitter, emit: fact => facts.push(fact) }
    }
    if (!managerEnabled) delete host.compactionManager
    const priorEvents = JSON.stringify(threadLog)
    const result = await runChatEngineCompaction(host)
    if (managerEnabled) assert.equal(observedReason, 'request_overflow')
    if (cannotFit) {
      assert.equal(result, null)
      assert.equal(JSON.stringify(threadLog), priorEvents)
      assert.equal(serialize(), original)
      assert.equal(checkpointCount, 0)
      assert.equal(host.conversation, conversation)
      if (summaryCase) {
        assert.equal(summaryCalls, managerEnabled ? 1 : 0)
        assert.equal(usageSettlements, managerEnabled ? 1 : 0)
        const openEpisodes = capacity === 'summary-cancelled' ? 0 : 1
        assert.equal(facts.length, openEpisodes)
        assert.equal(emitter.openCompactionIds().length, openEpisodes)
      }
    } else {
      assert.equal(result?.changed, true)
      assert.equal(checkpointCount, 1)
      const rebuilt = prepareProviderRequest({ body: serialize(), mode: 'native', provider: 'synthetic',
        requestedModelId: model, contextLimitTokens: ceiling, reservedCompletionTokens: 512 })
      assert.equal(rebuilt.admission, 'qualified')
      assert.equal(serialize().includes(task), true)
      if (capacity === 'summary-overhead') {
        assert.equal(result?.mode, 'heuristic')
        assert.equal(summaryCalls, managerEnabled ? 1 : 0)
        assert.equal(usageSettlements, managerEnabled ? 1 : 0)
        assert.equal(serialize().includes('S'.repeat(100)), false)
        assert.equal(facts.length, 2, 'one recovery episode has one started/completed pair')
        assert.equal(emitter.openCompactionIds().length, 0)
      }
    }
  })
}

test('overflow summary output is bounded by the recovery target', async t => {
  let requestedOutput = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requestedOutput = JSON.parse(String(init.body)).max_tokens
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Retained facts.' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 } }), { status: 200 })
  })
  const messages: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: 'history '.repeat(25),
  }))
  const result = await new LLMSummarizeCompaction().compact(messages, {
    model: 'synthetic-model', maxTokens: 10000, allowAmbientProvider: false,
    summarizationProvider: { apiKey: 'fixture-only', baseUrl: 'https://openrouter.invalid/chat/completions',
      defaultModel: 'synthetic-model' },
    requestContext: { reason: 'request_overflow', historyTokenEstimate: estimateTokens(messages),
      eligibilityTokenCap: 9000, maxTokens: 10000, compactionRequested: true,
      recoveryPressure: { requestId: 'fixture', requestDigest: 'fixture', contextLimitTokens: 1000,
        inputTokens: 600, reservedCompletionTokens: 500, requiredReductionTokens: 100 } },
  })
  assert.ok(result.some(message => message.name === 'compaction_summary'))
  assert.ok(requestedOutput > 0 && requestedOutput < 4000)
})

test('text recovery preserves mandatory system content and all request policy fields', () => {
  const original = { model: 'synthetic-model', temperature: 0, max_tokens: 512,
    provider: { allow_fallbacks: false }, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: 'mandatory '.repeat(1000) },
      { role: 'user', content: 'old conversation '.repeat(1000) }] }
  const request = prepareProviderRequest({ body: JSON.stringify(original), mode: 'text', provider: 'synthetic',
    requestedModelId: original.model, contextLimitTokens: 1000, reservedCompletionTokens: 512 })
  const pressure = deriveCompactionRecoveryPressure(request)!
  const rebuilt = JSON.parse(rebuildTextRecoveryRequest(pressure, 'retained conversation')!)
  assert.deepEqual(rebuilt, { ...original, messages: [original.messages[0],
    { role: 'user', content: 'retained conversation' }] })
  assert.equal(Object.isFrozen(pressure.textRequest), true)
  const unsupported = prepareProviderRequest({ ...{
    body: JSON.stringify({ ...original, messages: [...original.messages, { role: 'user', content: 'extra' }] }),
    mode: 'text' as const, provider: 'synthetic', requestedModelId: original.model,
    contextLimitTokens: 1000, reservedCompletionTokens: 512 } })
  assert.equal(rebuildTextRecoveryRequest(deriveCompactionRecoveryPressure(unsupported)!, 'replacement'), null)
})
