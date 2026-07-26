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
});
