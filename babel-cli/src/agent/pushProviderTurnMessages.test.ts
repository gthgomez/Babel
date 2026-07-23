import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderMessage } from '../runners/base.js';
import { pushProviderTurnMessages } from './chatEngineObservability.js';
import type { ChatToolAction } from './chatToolDefinitions.js';

describe('pushProviderTurnMessages (implementor W0.2)', () => {
  test('emits one tool-result message per tool_call_id when observationsPerTool provided', () => {
    const conversation: ProviderMessage[] = [];
    const actions = [
      { type: 'read_file', path: 'a.ts' },
      { type: 'str_replace', path: 'a.ts', old_str: 'x', new_str: 'y' },
    ] as ChatToolAction[];
    const ids = pushProviderTurnMessages({
      conversation,
      actions,
      turnIndex: 2,
      observations: 'AGGREGATED',
      observationsPerTool: ['### read_file a.ts\nok', '### str_replace a.ts\nok'],
      toolCallIds: ['call_a', 'call_b'],
    });
    assert.deepEqual(ids, ['call_a', 'call_b']);
    const tools = conversation.filter((m) => m.role === 'tool');
    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.tool_call_id, 'call_a');
    assert.equal(tools[1]!.tool_call_id, 'call_b');
    assert.ok(String(tools[0]!.content).includes('read_file'));
    assert.ok(String(tools[1]!.content).includes('str_replace'));
    const assistant = conversation.find((m) => m.role === 'assistant');
    assert.equal(assistant?.tool_calls?.length, 2);
  });

  test('falls back to single aggregated tool message when per-tool list missing', () => {
    const conversation: ProviderMessage[] = [];
    const actions = [
      { type: 'read_file', path: 'a.ts' },
      { type: 'read_file', path: 'b.ts' },
    ] as ChatToolAction[];
    pushProviderTurnMessages({
      conversation,
      actions,
      turnIndex: 0,
      observations: 'BOTH',
    });
    const tools = conversation.filter((m) => m.role === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.content, 'BOTH');
    assert.equal(tools[0]!.tool_call_id, 'tool_call_0_0');
  });
});
