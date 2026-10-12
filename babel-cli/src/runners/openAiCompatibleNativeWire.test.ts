import assert from 'node:assert/strict';
import test from 'node:test';

import { DeepInfraApiRunner } from './deepInfraApi.js';
import type { ToolDefinition } from './base.js';
import {
  createThreadEventLog,
  recordUserMessage,
  rebuildProviderMessagesFromEvents,
  startTurn,
} from '../agent/threadEventLog.js';
import { buildNativeProviderRequestBodyForAdmission } from '../agent/compactionCommit.js';

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
    { provider: 'deepinfra', explicitCredential: 'fixture-only' },
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
});
