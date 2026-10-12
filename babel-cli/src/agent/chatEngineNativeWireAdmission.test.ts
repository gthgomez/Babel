/**
 * Regression: compaction admission must call runner wire builders with receiver intact.
 * Direct runner parity tests do not catch unbound method extraction in ChatEngine.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
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
): { engine: ChatEngine; parity: { eventLog: ThreadEventLog }; runner: typeof runner } {
  const root = mkdtempSync(join(tmpdir(), 'babel-native-wire-binding-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const engine = new ChatEngine({
    task: 'native wire binding regression',
    projectRoot: root,
    model: policy.providerModelId,
    providerRunner: runner as never,
    providerPolicy: policy,
  })
  const parity = (engine as unknown as { parity: { eventLog: ThreadEventLog } }).parity
  const turnId = startTurn(parity.eventLog, {
    task: 'native wire binding regression',
    model: policy.providerModelId,
    provider: policy.provider,
    projectRoot: root,
    policyPreset: 'chat',
  })
  recordUserMessage(parity.eventLog, turnId, 'seed message for admission wire')
  return { engine, parity, runner }
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

test('ChatEngine native admission wire matches DeepSeek-direct runner transport bytes', () => {
  const runner = new DeepSeekApiRunner('deepseek-v4-flash', {
    explicitCredential: 'sk-fixture-only',
  })
  const { engine, parity } = seedEngine(runner, DEEPSEEK_POLICY)
  const body = engine.buildNativeCompactionAdmissionWireBody()
  assert.equal(body, expectedWireBody(engine, parity, runner))
})
