import assert from 'node:assert/strict';
import test from 'node:test';

import { DeepSeekApiRunner } from './deepSeekApi.js';
import type { ToolDefinition } from './base.js';
import { buildDeepSeekNativeToolsWireBody } from './deepSeekNativeWire.js';
import {
  createThreadEventLog,
  recordUserMessage,
  rebuildProviderMessagesFromEvents,
  startTurn,
} from '../agent/threadEventLog.js';

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'read_range',
    description: 'fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}];

test('DeepSeek transport body matches shared native wire helper', () => {
  const runner = new DeepSeekApiRunner('deepseek-v4-flash', {
    explicitCredential: 'sk-fixture-only',
  });
  const threadLog = createThreadEventLog('deepseek-wire');
  const turnId = startTurn(threadLog, {
    task: 'parity',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    projectRoot: '/tmp',
    policyPreset: 'chat',
  });
  recordUserMessage(threadLog, turnId, 'hello');
  const systemPrompt = 'policy preamble';
  const messages = rebuildProviderMessagesFromEvents(threadLog, { systemPrompt });
  const transportBody = runner.buildNativeToolsWireBody(messages, tools, systemPrompt, {
    stream: true,
  });
  const helperBody = buildDeepSeekNativeToolsWireBody({
    model: 'deepseek-v4-flash',
    maxTokens: runner.getNativeRequestReservedCompletionTokens() ?? 32_000,
    messages,
    tools,
    systemPrompt,
    stream: true,
  });
  assert.equal(helperBody, transportBody);
});
