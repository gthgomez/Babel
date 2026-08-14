import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProviderMessage } from './base.js';
import {
  countMarkdownHistoryMarkers,
  ensureProviderUserTask,
  mapProviderMessagesToWire,
  validateProviderMessageProtocol,
} from './providerMessages.js';
import { buildProviderMessages } from '../agent/chatToolDefinitions.js';
import {
  createThreadEventLog,
  startTurn,
  recordAssistantToolCalls,
  recordToolResult,
  recordAssistantMessage,
  rebuildProviderMessagesFromEvents,
} from '../agent/threadEventLog.js';

describe('providerMessages (P0-B protocol fidelity)', () => {
  test('mapProviderMessagesToWire emits system once and preserves tool_call ids', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Fix the bug' },
      {
        role: 'assistant',
        content: 'Using tools…',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', content: 'file contents', tool_call_id: 'call_1' },
    ];
    const wire = mapProviderMessagesToWire(messages, 'default-sys', 'override-sys');
    assert.equal(wire[0]!.role, 'system');
    assert.equal(wire[0]!.content, 'override-sys');
    assert.equal(wire.filter((m) => m.role === 'system').length, 1);
    assert.equal(wire[1]!.role, 'user');
    assert.equal(wire[2]!.role, 'assistant');
    assert.equal(wire[2]!.tool_calls?.[0]?.id, 'call_1');
    assert.equal(wire[3]!.role, 'tool');
    assert.equal(wire[3]!.tool_call_id, 'call_1');
  });

  test('mapProviderMessagesToWire preserves a committed compaction capsule in its single system message', () => {
    const wire = mapProviderMessagesToWire([
      { role: 'system', content: 'base system prompt' },
      { role: 'system', content: 'COMMITTED CAPSULE: retained repair context', name: 'compaction_capsule' },
      { role: 'user', content: 'continue' },
    ], 'default system prompt', 'base system prompt');

    assert.equal(wire.filter((message) => message.role === 'system').length, 1);
    assert.match(wire[0]!.content, /base system prompt/);
    assert.match(wire[0]!.content, /COMMITTED CAPSULE: retained repair context/);
  });
  test('validateProviderMessageProtocol rejects orphan tool results', () => {
    const issues = validateProviderMessageProtocol([
      { role: 'user', content: 'task' },
      { role: 'tool', content: 'orphan', tool_call_id: 'missing' },
    ]);
    assert.ok(issues.some((i) => i.code === 'orphan_tool_result'));
  });

  test('validateProviderMessageProtocol accepts paired tool results', () => {
    const issues = validateProviderMessageProtocol([
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: 'go',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ]);
    assert.deepEqual(issues, []);
  });

  test('validateProviderMessageProtocol flags Markdown-flattened user history', () => {
    const issues = validateProviderMessageProtocol([
      {
        role: 'user',
        content: '## Conversation History\n### assistant\nhi\n## Current Request\nfix it',
      },
    ]);
    assert.ok(issues.some((i) => i.code === 'system_in_user_content'));
  });

  test('buildProviderMessages appends user task only once across rebuilds', () => {
    const conversation: ProviderMessage[] = [];
    const first = buildProviderMessages({ conversation, task: 'Fix foo' });
    assert.equal(first.filter((m) => m.role === 'user').length, 1);

    // After tools, conversation holds assistant+tool; rebuild must not stack user tasks.
    conversation.push(
      {
        role: 'assistant',
        content: 'Using tools…',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'call_a' },
    );
    // Seed user into conversation (engine path) then omitUserTurn
    ensureProviderUserTask(conversation, 'Fix foo');
    // User was seeded after tools in this test; reorder to realistic: user first
    const realistic: ProviderMessage[] = [
      { role: 'user', content: 'Fix foo' },
      conversation[0]!,
      conversation[1]!,
    ];
    const second = buildProviderMessages({
      conversation: realistic,
      task: 'Fix foo',
      omitUserTurn: false,
    });
    assert.equal(second.filter((m) => m.role === 'user' && m.content === 'Fix foo').length, 1);
    assert.equal(countMarkdownHistoryMarkers(second), 0);
    assert.deepEqual(validateProviderMessageProtocol(second), []);
  });

  test('ten-turn structured transcript has no Markdown history markers', () => {
    const conversation: ProviderMessage[] = [{ role: 'user', content: 'long task' }];
    for (let t = 0; t < 10; t++) {
      const id = `call_${t}`;
      conversation.push(
        {
          role: 'assistant',
          content: 'Using tools…',
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name: 'read_file', arguments: `{"path":"f${t}.ts"}` },
            },
          ],
        },
        { role: 'tool', content: `result ${t}`, tool_call_id: id },
      );
    }
    const messages = buildProviderMessages({
      conversation,
      task: 'long task',
    });
    assert.equal(countMarkdownHistoryMarkers(messages), 0);
    assert.equal(messages.filter((m) => m.role === 'user').length, 1);
    assert.deepEqual(validateProviderMessageProtocol(messages), []);
    // Wire shape: system + structured history (no prose dump)
    const wire = mapProviderMessagesToWire(messages, 'sys');
    assert.equal(wire[0]!.role, 'system');
    assert.ok(wire.some((m) => m.role === 'tool' && m.tool_call_id));
  });

  test('3+ native tool turns reconstruct with exact assistant/tool ID pairing', () => {
    const log = createThreadEventLog('test-thread');
    const turnId1 = startTurn(log, {
      task: 'Task 1',
      model: 'test-model',
      provider: 'test-provider',
      projectRoot: '/test',
      policyPreset: 'default',
    });
    recordAssistantToolCalls(log, turnId1, 'thinking 1', [
      { id: 't1', type: 'function', function: { name: 'f1', arguments: '{}' } },
    ]);
    recordToolResult(log, turnId1, { tool_call_id: 't1', tool_name: 'f1', content: 'r1' });

    const turnId2 = startTurn(log, {
      task: 'Task 2',
      model: 'test-model',
      provider: 'test-provider',
      projectRoot: '/test',
      policyPreset: 'default',
    });
    recordAssistantToolCalls(log, turnId2, 'thinking 2', [
      { id: 't2', type: 'function', function: { name: 'f2', arguments: '{}' } },
      { id: 't3', type: 'function', function: { name: 'f3', arguments: '{}' } },
    ]);
    recordToolResult(log, turnId2, { tool_call_id: 't2', tool_name: 'f2', content: 'r2' });
    recordToolResult(log, turnId2, { tool_call_id: 't3', tool_name: 'f3', content: 'r3' });

    recordAssistantMessage(log, turnId2, 'Done with Task 2');

    const messages = rebuildProviderMessagesFromEvents(log, { systemPrompt: 'sys' });
    assert.deepEqual(validateProviderMessageProtocol(messages), []);

    // 1 sys, 2 users, 2 assistant (tool calls), 3 tools, 1 assistant (msg) = 9 messages
    assert.equal(messages.length, 9);
    assert.equal(messages[2]!.role, 'assistant');
    assert.equal(messages[2]!.tool_calls![0]!.id, 't1');
    assert.equal(messages[3]!.role, 'tool');
    assert.equal(messages[3]!.tool_call_id, 't1');
    assert.equal(messages[8]!.role, 'assistant');
    assert.equal(messages[8]!.content, 'Done with Task 2');
  });

  test('rebuildProviderMessagesFromEvents on resume produces identical ProviderMessage[] as live', () => {
    const log = createThreadEventLog('test-thread');
    const turnId = startTurn(log, {
      task: 'Identical Test',
      model: 'm',
      provider: 'p',
      projectRoot: '/',
      policyPreset: 'default',
    });
    recordAssistantToolCalls(log, turnId, 'thinking', [
      { id: 'call_live', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ]);
    recordToolResult(log, turnId, { tool_call_id: 'call_live', tool_name: 'read_file', content: 'ok' });

    const liveMessages = rebuildProviderMessagesFromEvents(log, { systemPrompt: 'system_prompt_live' });

    // Simulate resume by rebuilding from the same log
    const resumedMessages = rebuildProviderMessagesFromEvents(log, { systemPrompt: 'system_prompt_live' });

    assert.deepEqual(liveMessages, resumedMessages);
  });

  test('DeepSeek provider wire format regression coverage', () => {
    // Tests mapProviderMessagesToWire with DeepSeek specific expectations
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'thinking', tool_calls: [{ id: 'ds_call', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
      { role: 'tool', content: 'file.txt', tool_call_id: 'ds_call' },
    ];

    const wire = mapProviderMessagesToWire(messages, 'default-sys', 'deepseek-override');
    assert.equal(wire.length, 4);
    assert.equal(wire[0]!.role, 'system');
    assert.equal(wire[0]!.content, 'deepseek-override');
    assert.equal(wire[2]!.role, 'assistant');
    assert.ok(wire[2]!.tool_calls);
    assert.equal(wire[2]!.tool_calls![0]!.id, 'ds_call');
    assert.equal(wire[3]!.role, 'tool');
    assert.equal(wire[3]!.tool_call_id, 'ds_call');
  });
});
