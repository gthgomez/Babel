import assert from 'node:assert/strict';
import test from 'node:test';

import { DeepInfraApiRunner } from './deepInfraApi.js';
import type { ToolDefinition } from './base.js';
import { createSessionEventLog } from '../agent/sessionEvents.js';
import {
  createThreadEventLog,
  recordUserMessage,
  rebuildProviderMessagesFromEvents,
  startTurn,
} from '../agent/threadEventLog.js';
import {
  buildNativeProviderRequestBodyForAdmission,
  evaluateCompactionSerializedAdmission,
  resolveCompactionAdmissionContext,
} from '../agent/compactionCommit.js';
import { prepareProviderRequest } from './preparedProviderRequest.js';
import { buildOpenAiCompatibleNativeWireBody } from './openAiCompatibleNativeWire.js';
import { mapProviderMessages } from './providerResponseStream.js';
import type { ProviderMessage } from './base.js';
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js';

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_range',
    description: 'fixture tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}];

test('DeepInfra native transport body matches compaction admission helper', () => {
  const runner = new DeepInfraApiRunner(
    'deepseek-v4-flash',
    'DEEPINFRA_API_KEY',
    { maxTokens: 32_000, temperature: 0 },
    { provider: 'deepinfra', explicitCredential: 'fixture-only', contextWindowTokens: 128_000 },
  );
  const threadLog = createThreadEventLog('wire-parity');
  const turnId = startTurn(threadLog, {
    task: 'parity',
    model: 'deepseek-v4-flash',
    provider: 'deepinfra',
    projectRoot: '/tmp',
    policyPreset: 'chat',
  });
  recordUserMessage(threadLog, turnId, 'hello from chat');
  const systemPrompt = 'policy preamble for native chat';
  const messages = rebuildProviderMessagesFromEvents(threadLog, { systemPrompt });
  const transportBody = runner.buildNativeToolsWireBody(messages, tools, systemPrompt, {
    stream: true,
  });
  const admissionBody = buildNativeProviderRequestBodyForAdmission({
    threadLog,
    systemPrompt,
    modelId: 'deepseek-v4-flash',
    tools,
    maxOutputTokens: 32_000,
    temperature: 0,
    stream: true,
  });
  assert.equal(admissionBody, transportBody);

  const reserved = runner.getNativeRequestReservedCompletionTokens();
  const admissionContext = resolveCompactionAdmissionContext(
    {
      conversation: [],
      options: { task: 'parity' },
      modelPolicy: { contextWindow: 128_000 },
      compactionProviderId: 'deepinfra',
      limits: { maxEstimatedTokens: 128_000 },
      abortSignal: new AbortController().signal,
      writeCount: 0,
      turnIndex: 0,
      toolCallLog: [],
      progress: { receipts: [], consecutiveNoProgress: 0 },
      threadLog,
      sessionLog: createSessionEventLog('wire-parity-session'),
      turnId,
      shouldUseTextTools: () => false,
      compactHeuristic: () => undefined,
      checkpoint: async () => undefined,
      reserveTokens: 0,
      textToolsReserve: 0,
      resolveModel: () => 'deepseek-v4-flash',
      shouldCompactByTokens: () => true,
      estimateTokens: () => 0,
      providerReservedCompletionTokens: reserved,
    },
    'deepseek-v4-flash',
  );
  const compactionAdmission = evaluateCompactionSerializedAdmission(transportBody, {
    modelId: 'deepseek-v4-flash',
    providerId: 'deepinfra',
    ...admissionContext,
  });
  const transportAdmission = prepareProviderRequest({
    body: transportBody,
    mode: 'native',
    provider: 'deepinfra',
    requestedModelId: 'deepseek-v4-flash',
    reservedCompletionTokens: reserved,
    contextLimitTokens: 128_000,
  }).admission;
  assert.equal(compactionAdmission, transportAdmission);
});

function envelopeFor(provider: 'openrouter' | 'command-code'): ResolvedExecutionEnvelope {
  return {
    configurationHash: 'e'.repeat(64),
    model: { requested: 'fixture-model', resolved: 'fixture-model' },
    output: { requested: 64, effective: 64, source: 'configured' },
    reasoning: { effectiveEffort: null, wireParameter: null },
    sampling: { temperature: { effective: 0 }, topP: {}, seed: {} },
    tools: { effective: true, choice: 'auto' },
    structuredOutput: { mode: 'none' },
    provider: { gateway: provider },
    routing: { allowFallbacks: false, requireParameters: true, order: [] },
  } as unknown as ResolvedExecutionEnvelope;
}

test('configured and ordinary compatible wires share effective messages across both qualified routes', () => {
  const messages: ProviderMessage[] = [
    { role: 'system', content: 'base policy' },
    { role: 'system', content: 'committed capsule', name: 'compaction_capsule', provenance: 'controller', authoritative: true },
    { role: 'user', content: 'inspect the fixture' },
    {
      role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_range', arguments: '{"path":"fixture.txt"}' } }],
    },
    { role: 'tool', content: 'fixture contents', tool_call_id: 'call-1' },
    { role: 'assistant', content: 'advisory prior answer', name: 'compaction_summary', provenance: 'model', authoritative: false },
  ];
  for (const provider of ['openrouter', 'command-code'] as const) {
    for (const systemPrompt of [undefined, 'caller recovery guidance']) {
      const input = {
        model: 'fixture-model', maxTokens: 64, temperature: 0, messages, tools,
        ...(systemPrompt === undefined ? {} : { systemPrompt }), stream: true,
        mapMessages: mapProviderMessages,
      };
      const ordinary = JSON.parse(buildOpenAiCompatibleNativeWireBody(input));
      const configured = JSON.parse(buildOpenAiCompatibleNativeWireBody({
        ...input, executionEnvelope: envelopeFor(provider),
      }));
      assert.deepEqual(configured.messages, ordinary.messages, `${provider} effective messages must be identical`);
      assert.match(configured.messages[0].content, /committed capsule/);
      assert.match(configured.messages[0].content, /advisory context rule/i);
      assert.equal(configured.messages[3].tool_call_id, 'call-1');
      assert.equal(configured.messages[3].role, 'tool');
      if (systemPrompt) {
        assert.match(configured.messages[0].content, /caller recovery guidance/);
        assert.doesNotMatch(configured.messages[0].content, /^base policy$/);
      }
    }
  }
});
