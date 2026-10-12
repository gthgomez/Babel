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
import { ChatEngine } from './chatEngine.js'
import {
  recordUserMessage,
  startTurn,
  type ThreadEventLog,
} from './threadEventLog.js'

const POLICY: ResolvedModelPolicy = {
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

test('ChatEngine buildNativeCompactionAdmissionWireBody keeps DeepInfra runner receiver', () => {
  const runner = new DeepInfraApiRunner(
    'deepseek-v4-flash',
    'DEEPINFRA_API_KEY',
    { maxTokens: 32_000, temperature: 0 },
    { provider: 'deepinfra', explicitCredential: 'fixture-only' },
  )
  const root = mkdtempSync(join(tmpdir(), 'babel-native-wire-binding-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const engine = new ChatEngine({
    task: 'native wire binding regression',
    projectRoot: root,
    model: 'deepseek-v4-flash',
    providerRunner: runner as never,
    providerPolicy: POLICY,
  })
  const parity = (engine as unknown as { parity: { eventLog: ThreadEventLog } }).parity
  const turnId = startTurn(parity.eventLog, {
    task: 'native wire binding regression',
    model: 'deepseek-v4-flash',
    provider: 'deepinfra',
    projectRoot: root,
    policyPreset: 'chat',
  })
  recordUserMessage(parity.eventLog, turnId, 'seed message for admission wire')

  const body = engine.buildNativeCompactionAdmissionWireBody()
  const parsed = JSON.parse(body) as { model?: string; tools?: unknown[]; max_tokens?: number }
  assert.equal(parsed.model, 'deepseek-v4-flash')
  assert.ok(Array.isArray(parsed.tools) && parsed.tools.length > 0)
  assert.equal(parsed.max_tokens, 32_000)
})
