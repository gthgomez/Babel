/**
 * Regression: compaction admission must call runner wire builders with receiver intact.
 * Direct runner parity tests do not catch unbound method extraction in ChatEngine.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import type { ResolvedModelPolicy } from '../modelPolicy.js'
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js'
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js'
import { ChatEngine } from './chatEngine.js'
import type { ChatEngineOptions } from './chatEngineContracts.js'
import {
  rebuildProviderMessagesFromEvents,
  recordUserMessage,
  startTurn,
  type ThreadEventLog,
} from './threadEventLog.js'
import { availableChatTools } from './chatToolAvailability.js'
import { resolveTaskShape, type TaskOperation } from '../config/chatTaskClass.js'
import { prepareProviderRequest, PreparedRequestAdmissionError } from '../runners/preparedProviderRequest.js'
import type { CompactionRecoveryPressure } from './compactionRequestPressure.js'
import { CompactionManager, HeuristicTruncationStrategy, type ChatMessage } from './chatCompaction.js'
import { recordAssistantMessage } from './threadEventLog.js'
import { buildChatTurnPrompt } from './chatToolDefinitions.js'
import { noteChatWorkspaceMutation } from './chatEngineSupport.js'

const DEEPINFRA_POLICY: ResolvedModelPolicy = {
  policyPath: 'native-wire-binding',
  family: 'deepinfra',
  selectedTier: 'cheap',
  resolvedBackendKey: 'deepinfra',
  provider: 'deepinfra',
  providerModelId: 'deepseek-v4-flash',
  expensive: false,
  enabled: true,
  experimental: false,
  blockedWithoutExplicitOptIn: false,
  approximateInputTokens: 0,
  approximateOutputTokens: 0,
  warnings: [],
  waterfall: [],
  stagePolicies: [],
  contextWindow: 128_000,
  contextLimit: 128_000,
  maxOutputTokens: 32_000,
  nativeToolUse: true,
}

const DEEPSEEK_POLICY: ResolvedModelPolicy = {
  ...DEEPINFRA_POLICY,
  policyPath: 'deepseek-direct-wire',
  family: 'deepseek',
  resolvedBackendKey: 'deepseek',
  provider: 'deepseek',
  providerModelId: 'deepseek-v4-flash',
}

function seedEngine(
  runner: DeepInfraApiRunner | DeepSeekApiRunner,
  policy: ResolvedModelPolicy,
): { root: string; engine: ChatEngine; parity: { eventLog: ThreadEventLog; turnId: string | null }; runner: typeof runner } {
  const root = mkdtempSync(join(tmpdir(), 'babel-native-wire-binding-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const engine = new ChatEngine({
    task: 'native wire binding regression',
    projectRoot: root,
    model: policy.providerModelId,
    providerRunner: runner as never,
    providerPolicy: policy,
  })
  const parity = (engine as unknown as { parity: { eventLog: ThreadEventLog; turnId: string | null } }).parity
  const turnId = startTurn(parity.eventLog, {
    task: 'native wire binding regression',
    model: policy.providerModelId,
    provider: policy.provider,
    projectRoot: root,
    policyPreset: 'chat',
  })
  parity.turnId = turnId
  recordUserMessage(parity.eventLog, turnId, 'seed message for admission wire')
  return { root, engine, parity, runner }
}

function expectedWireBody(
  engine: ChatEngine,
  parity: { eventLog: ThreadEventLog },
  runner: DeepInfraApiRunner | DeepSeekApiRunner,
): string {
  const internal = engine as unknown as {
    getOrBuildSystemPrompt: (mode: 'native') => string
    services: { tools: { buildDefinitions: () => import('../runners/base.js').ToolDefinition[] } }
    options: Pick<ChatEngineOptions, 'task' | 'operation'>
    getResolvedRequiredVerifiers: () => readonly string[]
    isolationBrokerFlags: () => { hostFallbackAllowed: boolean }
  }
  const systemPrompt = internal.getOrBuildSystemPrompt('native')
  const operation = resolveTaskShape(
    internal.options.task,
    internal.options.operation,
  ).operation as TaskOperation
  const toolDefs = availableChatTools(internal.services.tools.buildDefinitions(), {
    operation,
    requiredVerifiers: internal.getResolvedRequiredVerifiers(),
    hostFallbackAllowed: internal.isolationBrokerFlags().hostFallbackAllowed,
  })
  const messages = rebuildProviderMessagesFromEvents(parity.eventLog, { systemPrompt })
  return runner.buildNativeToolsWireBody(messages, toolDefs, systemPrompt, { stream: true })
}

test('ChatEngine native admission wire matches DeepInfra runner transport bytes', () => {
  const runner = new DeepInfraApiRunner(
    'deepseek-v4-flash',
    'DEEPINFRA_API_KEY',
    { maxTokens: 32_000, temperature: 0 },
    { provider: 'deepinfra', explicitCredential: 'fixture-only' },
  )
  const { engine, parity } = seedEngine(runner, DEEPINFRA_POLICY)
  const body = engine.buildNativeCompactionAdmissionWireBody()
  assert.equal(body, expectedWireBody(engine, parity, runner))
})

test('empty Python workspace guidance does not invent a Node test target', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-empty-python-tests-'))
  try {
    writeFileSync(join(root, 'solution.py'), 'def add(a, b):\n    return a + b\n')
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'Implement the requested Python function and report verification accurately.', projectRoot: root })
    const internal = engine as unknown as { getOrBuildSystemPrompt: (mode: 'native') => string; discoveredTestCommands: unknown[] }
    const prompt = internal.getOrBuildSystemPrompt('native')
    assert.equal(internal.discoveredTestCommands.length, 0)
    assert.match(prompt, /host found no project test command/i)
    assert.match(prompt, /compatible runner is available/i)
    assert.match(prompt, /Keep a new check diagnostic until the contract accepts it/i)
    assert.match(prompt, /denied before dispatch did not run/i)
    assert.doesNotMatch(prompt, /tests\/solution\.test\.js|node --test tests\/solution/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a Python check created in the current task refreshes native wire guidance without altering admission', () => {
  const runner = new DeepInfraApiRunner('deepseek-v4-flash', 'DEEPINFRA_API_KEY',
    { maxTokens: 4096 }, { provider: 'deepinfra', explicitCredential: 'fixture-only' })
  const { root, engine } = seedEngine(runner, DEEPINFRA_POLICY)
  const state = engine as unknown as Parameters<typeof noteChatWorkspaceMutation>[0] & {
    discoveredTestCommands: unknown[]
  }
  const systemPrompt = () => {
    const wire = engine.buildNativeCompactionAdmissionWireBody()
    assert.ok(wire)
    const parsed = JSON.parse(wire) as { messages: Array<{ role: string; content: string }> }
    return parsed.messages.find(message => message.role === 'system')?.content ?? ''
  }
  try {
    assert.match(systemPrompt(), /host found no project test command/i)
    const path = join(root, 'test_solution.py')
    const config = join(root, 'pyproject.toml')
    writeFileSync(config, '[project]\nname = "example"\n')
    writeFileSync(path, [
      'import unittest',
      'class ExampleTest(unittest.TestCase):',
      '    def test_addition(self):',
      '        self.assertEqual(2 + 3, 5)',
      '',
    ].join('\n'))
    noteChatWorkspaceMutation(state)

    const refreshed = systemPrompt()
    assert.match(refreshed, /Test discovery:.*python3? -m unittest discover/i)
    assert.doesNotMatch(refreshed, /host found no project test command/i)
    assert.deepEqual(state.discoveredTestCommands, [])
    const reopened = new ChatEngine({ model: DEEPINFRA_POLICY.providerModelId,
      task: 'Inspect verification options', projectRoot: root, providerRunner: runner as never,
      providerPolicy: DEEPINFRA_POLICY }) as unknown as Pick<typeof state, 'discoveredTestCommands'>
    assert.deepEqual(reopened.discoveredTestCommands, [{ command: 'python -m pytest', source: 'convention (pytest config)' }])

    rmSync(path)
    rmSync(config)
    noteChatWorkspaceMutation(state)
    assert.match(systemPrompt(), /host found no project test command/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit continuation refreshes test guidance after an external Makefile edit', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-continue-test-discovery-'))
  try {
    const engine = new ChatEngine({ task: 'Fix the fixture and verify the change',
      projectRoot: root, model: DEEPINFRA_POLICY.providerModelId })
    const internal = engine as unknown as { getOrBuildSystemPrompt(mode: 'native'): string }
    const makefile = join(root, 'Makefile')
    writeFileSync(makefile, 'build:\n\techo build\n')
    engine.applyPreparedUserSubmission(engine.prepareUserSubmission({ userInput: 'Fix the fixture and verify the change' }))
    assert.match(internal.getOrBuildSystemPrompt('native'), /host found no project test command/i)

    writeFileSync(makefile, 'build:\n\techo build\ntest:\n\techo check\n')
    const continued = engine.prepareUserSubmission({ userInput: 'continue', continueTask: true })
    assert.equal(continued.runtime.continuedTask, true)
    engine.applyPreparedUserSubmission(continued)
    assert.match(internal.getOrBuildSystemPrompt('native'), /Test discovery: make test/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ChatEngine native admission wire matches DeepSeek-direct runner transport bytes', () => {
  const runner = new DeepSeekApiRunner('deepseek-v4-flash', {
    explicitCredential: 'sk-fixture-only',
  })
  const { engine, parity } = seedEngine(runner, DEEPSEEK_POLICY)
  const body = engine.buildNativeCompactionAdmissionWireBody()
  assert.equal(body, expectedWireBody(engine, parity, runner))
})

test('request recovery fences stale owners, propagates actual pressure and permits one attempt', async () => {
  const request = prepareProviderRequest({ body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }),
    mode: 'native', provider: 'synthetic', requestedModelId: 'synthetic-model',
    contextLimitTokens: 1000, reservedCompletionTokens: 512 })
  const error = new PreparedRequestAdmissionError(request)
  let attempts = 0
  let capturedPressure: CompactionRecoveryPressure | undefined
  const owner = {
    activeSubmissionGeneration: 7, preparedAdmissionCompactionAttempts: 0,
    pendingParentRequestId: 'current-parent',
    isSubmissionCurrent: (generation: number) => generation === 7,
    compactIfNeeded: async (_callbacks: unknown, force: boolean, generation: number,
      pressure: CompactionRecoveryPressure) => {
      assert.equal(force, true)
      assert.equal(generation, 7)
      attempts++
      capturedPressure = pressure
      return null
    },
  }
  const recover = (ChatEngine.prototype as unknown as {
    recoverPreparedRequestAdmission(this: typeof owner, error: unknown, generation: number): Promise<unknown>
  }).recoverPreparedRequestAdmission
  assert.equal(await recover.call(owner, error, 6), null)
  assert.equal(owner.preparedAdmissionCompactionAttempts, 0)
  assert.equal(owner.pendingParentRequestId, 'current-parent')
  await recover.call(owner, error, 7)
  assert.equal(attempts, 1)
  assert.equal(owner.pendingParentRequestId, request.request_id)
  assert.equal(capturedPressure?.requiredReductionTokens, request.accounting.estimated_total_tokens! - 1000)
  await recover.call(owner, error, 7)
  assert.equal(attempts, 1, 'unsuccessful recovery must not retry indefinitely')
})

for (const mode of ['native', 'text', 'legacy'] as const) test(`successful ${mode} engine overflow recovery retains the failed request as the retry parent`, async () => {
  const runner = new DeepInfraApiRunner('deepseek-v4-flash', 'DEEPINFRA_API_KEY',
    { maxTokens: 32_000 }, { provider: 'deepinfra', explicitCredential: 'fixture-only' })
  const { engine, parity } = seedEngine(runner, DEEPINFRA_POLICY)
  const internal = engine as unknown as {
    conversation: ChatMessage[]
    compactionManager: CompactionManager
    lastLogicalRequestId: string | null
    pendingParentRequestId: string | null
    preparedAdmissionCompactionAttempts: number
    activeSubmissionGeneration: number
    shouldUseTextTools(): boolean
    getOrBuildSystemPrompt(mode: 'text' | 'legacy'): string
    prepareCompactionGuard(): () => boolean
    recoverPreparedRequestAdmission(error: unknown, generation: number): Promise<unknown>
  }
  const conversation: ChatMessage[] = [{ role: 'system', content: 'preserved controller instructions' }]
  const turnId = parity.turnId
  assert.ok(turnId)
  for (let index = 0; index < 8; index++) {
    const user = `native wire binding regression old user ${index} ${'x'.repeat(4000)}`
    const answer = `old answer ${index} ${'x'.repeat(4000)}`
    recordUserMessage(parity.eventLog, turnId, user)
    recordAssistantMessage(parity.eventLog, turnId, answer)
    conversation.push({ role: 'user', content: user }, { role: 'assistant', content: answer })
  }
  internal.conversation = conversation
  internal.compactionManager = new CompactionManager([new HeuristicTruncationStrategy()])
  internal.shouldUseTextTools = () => mode === 'text'
  // Repository certification is the separate finding 4; this test exercises
  // request admission, durable conversation commit, and actual host wiring.
  internal.prepareCompactionGuard = () => () => true
  internal.lastLogicalRequestId = 'previous-successful-request'
  const buildBody = () => mode === 'native' ? engine.buildNativeCompactionAdmissionWireBody()
    : JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 32_000, temperature: 0, stream: true,
      ...(mode === 'legacy' ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: internal.getOrBuildSystemPrompt(mode) },
        { role: 'user', content: buildChatTurnPrompt({ conversation: internal.conversation,
          task: 'native wire binding regression', nativeTools: false, textTools: mode === 'text' }) }] })
  const body = buildBody()
  const draft = prepareProviderRequest({ body, mode, provider: 'deepinfra',
    requestedModelId: 'deepseek-v4-flash', contextLimitTokens: null, reservedCompletionTokens: 32_000 })
  const ceiling = draft.accounting.estimated_total_tokens! - 2000
  const failed = prepareProviderRequest({ body, mode, provider: 'deepinfra',
    requestedModelId: 'deepseek-v4-flash', contextLimitTokens: ceiling, reservedCompletionTokens: 32_000 })
  // A runner's native output budget need not be its flattened-text budget.
  // Recovery must reserve the output of the body it is actually rebuilding.
  if (mode !== 'native') runner.getNativeRequestReservedCompletionTokens = () => 64_000
  const result = await internal.recoverPreparedRequestAdmission(
    new PreparedRequestAdmissionError(failed), internal.activeSubmissionGeneration)
  assert.ok(result)
  assert.equal(internal.pendingParentRequestId, failed.request_id)
  assert.equal(internal.preparedAdmissionCompactionAttempts, 1)
  const rebuilt = prepareProviderRequest({ body: buildBody(),
    mode, provider: 'deepinfra', requestedModelId: 'deepseek-v4-flash',
    contextLimitTokens: ceiling, reservedCompletionTokens: 32_000 })
  assert.equal(rebuilt.admission, 'qualified')
})
