/**
 * Regression: compaction admission must reserve the same completion budget as
 * native transport (`executionEnvelope.output.effective ?? maxTokens`), not a
 * stale `maxTokens` field alone.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ResolvedExecutionEnvelope } from '../intelligence/types.js'
import {
  evaluateCompactionSerializedAdmission,
  resolveCompactionAdmissionContext,
} from '../agent/compactionCommit.js'
import { createSessionEventLog } from '../agent/sessionEvents.js'
import {
  createThreadEventLog,
  recordUserMessage,
  rebuildProviderMessagesFromEvents,
  startTurn,
} from '../agent/threadEventLog.js'
import type { ToolDefinition } from './base.js'
import { DeepInfraApiRunner } from './deepInfraApi.js'
import { prepareProviderRequest } from './preparedProviderRequest.js'

const MODEL_ID = 'deepseek-v4-flash'
const ENVELOPE_EFFECTIVE = 16_384
const STALE_MAX_TOKENS = 4_096

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_range',
    description: 'fixture tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}]

function fixtureExecutionEnvelope(effective: number): ResolvedExecutionEnvelope {
  return {
    schemaVersion: 1,
    mode: 'production_resilient',
    labModelHash: 'fixture-lab',
    providerProfileHash: 'fixture-provider',
    configurationHash: 'c'.repeat(64),
    model: {
      requested: MODEL_ID,
      resolved: MODEL_ID,
      userRequestedModelId: MODEL_ID,
      catalogModelId: MODEL_ID,
      wireModelId: MODEL_ID,
      canonicalRevisionSlug: MODEL_ID,
      aliasUsed: false,
      aliasId: null,
      aliasTarget: null,
    },
    provider: { gateway: 'deepinfra' },
    protocol: 'openai_chat_completions',
    context: {},
    output: {
      effective,
      requested: effective,
      source: 'fixture',
      resolution: 'accepted',
    },
    reasoning: {
      requestedEffort: null,
      effectiveEffort: null,
      resolution: 'accepted',
      source: 'fixture',
    },
    sampling: {
      temperature: { requested: 0, effective: 0, resolution: 'accepted', source: 'fixture' },
      topP: { requested: null, effective: null, resolution: 'accepted', source: 'fixture' },
    },
    tools: {
      enabled: true,
      effective: true,
      choice: 'auto',
      resolution: 'accepted',
      source: 'fixture',
    },
    structuredOutput: {
      mode: 'none',
      effective: false,
      resolution: 'accepted',
      source: 'fixture',
    },
    routing: {
      upstream: 'DeepInfra',
      order: ['DeepInfra'],
      resolution: 'accepted',
      source: 'fixture',
    },
    affordability: { status: 'unknown' },
  } as ResolvedExecutionEnvelope
}

type RunnerInternals = DeepInfraApiRunner & {
  executionEnvelope?: ResolvedExecutionEnvelope
  maxTokens: number | null
}

/** Mirrors `executeWithToolsStream` → `prepareProviderRequest` reserved budget. */
function transportReservedCompletionTokens(runner: DeepInfraApiRunner): number | null {
  const internal = runner as RunnerInternals
  return internal.executionEnvelope?.output.effective ?? internal.maxTokens
}

/** Pre-b4dcc8d getter behavior (maxTokens only). */
function legacyGetterReservedCompletionTokens(runner: DeepInfraApiRunner): number | null {
  return (runner as RunnerInternals).maxTokens
}

test('envelope effective output budget drives compaction and transport admission when maxTokens is stale', () => {
  const runner = new DeepInfraApiRunner(
    MODEL_ID,
    'DEEPINFRA_API_KEY',
    { maxTokens: STALE_MAX_TOKENS, temperature: 0 },
    {
      provider: 'deepinfra',
      explicitCredential: 'fixture-only',
      executionEnvelope: fixtureExecutionEnvelope(ENVELOPE_EFFECTIVE),
    },
  )
  const internal = runner as RunnerInternals
  assert.equal(internal.maxTokens, ENVELOPE_EFFECTIVE)
  internal.maxTokens = STALE_MAX_TOKENS

  const transportReserved = transportReservedCompletionTokens(runner)
  const getterReserved = runner.getNativeRequestReservedCompletionTokens()
  const legacyReserved = legacyGetterReservedCompletionTokens(runner)

  assert.equal(transportReserved, ENVELOPE_EFFECTIVE)
  assert.equal(getterReserved, ENVELOPE_EFFECTIVE)
  assert.equal(legacyReserved, STALE_MAX_TOKENS)
  assert.notEqual(legacyReserved, getterReserved)

  const threadLog = createThreadEventLog('reserved-admission')
  const turnId = startTurn(threadLog, {
    task: 'reserved parity',
    model: MODEL_ID,
    provider: 'deepinfra',
    projectRoot: '/tmp',
    policyPreset: 'chat',
  })
  recordUserMessage(threadLog, turnId, 'x'.repeat(12_000))
  const systemPrompt = 'policy preamble '.repeat(40)
  const messages = rebuildProviderMessagesFromEvents(threadLog, { systemPrompt })
  const body = runner.buildNativeToolsWireBody(messages, tools, systemPrompt, { stream: true })

  const explicitContextLimit = 18_000
  const transportAdmission = prepareProviderRequest({
    body,
    mode: 'native',
    provider: 'deepinfra',
    requestedModelId: MODEL_ID,
    reservedCompletionTokens: transportReserved,
    contextLimitTokens: explicitContextLimit,
  }).admission
  const legacyTransportAdmission = prepareProviderRequest({
    body,
    mode: 'native',
    provider: 'deepinfra',
    requestedModelId: MODEL_ID,
    reservedCompletionTokens: legacyReserved,
    contextLimitTokens: explicitContextLimit,
  }).admission

  assert.equal(transportAdmission, 'over_limit')
  assert.equal(legacyTransportAdmission, 'qualified')
  assert.notEqual(transportAdmission, legacyTransportAdmission)

  const compactionContext = resolveCompactionAdmissionContext(
    {
      conversation: [],
      options: { task: 'reserved parity' },
      limits: { maxEstimatedTokens: explicitContextLimit },
      abortSignal: new AbortController().signal,
      writeCount: 0,
      turnIndex: 0,
      toolCallLog: [],
      progress: { receipts: [], consecutiveNoProgress: 0 },
      threadLog,
      sessionLog: createSessionEventLog('reserved-admission-session'),
      turnId,
      shouldUseTextTools: () => false,
      compactHeuristic: () => undefined,
      checkpoint: async () => undefined,
      reserveTokens: 0,
      textToolsReserve: 0,
      resolveModel: () => MODEL_ID,
      shouldCompactByTokens: () => true,
      estimateTokens: () => 0,
      providerReservedCompletionTokens: getterReserved,
    },
    MODEL_ID,
  )
  assert.equal(compactionContext.reservedCompletionTokens, ENVELOPE_EFFECTIVE)
  const compactionAdmission = evaluateCompactionSerializedAdmission(body, {
    modelId: MODEL_ID,
    providerId: 'deepinfra',
    contextWindowTokens: explicitContextLimit,
    reservedCompletionTokens: compactionContext.reservedCompletionTokens,
  })
  assert.equal(compactionAdmission, transportAdmission)
})
