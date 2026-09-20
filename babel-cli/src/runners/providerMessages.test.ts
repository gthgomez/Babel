import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ProviderMessage } from './base.js';
import {
  countMarkdownHistoryMarkers,
  accountProviderRequest,
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

describe('provider request accounting', () => {
  test('digests the exact body and includes tools, messages, and reserved output', () => {
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'read' }] });
    const accounting = accountProviderRequest(body, { reservedCompletionTokens: 128, inputLimitTokens: 256 });
    assert.equal(accounting.request_digest.length, 64);
    assert.equal(accounting.input_message_count, 1);
    assert.equal(accounting.reserved_completion_tokens, 128);
    assert.equal(accounting.estimated_total_tokens, (accounting.estimated_input_tokens ?? 0) + 128);
    assert.equal(accounting.within_limit, true);
  });

  test('keeps unknown limits and malformed accounting inputs explicit', () => {
    const accounting = accountProviderRequest('not-json', { reservedCompletionTokens: null });
    assert.equal(accounting.input_message_count, null);
    assert.equal(accounting.estimated_total_tokens, null);
    assert.equal(accounting.within_limit, null);
  });
});

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

  test('mapProviderMessagesToWire exposes non-authority semantics for model advisory context', () => {
    const wire = mapProviderMessagesToWire([
      { role: 'system', content: 'base system prompt' },
      { role: 'assistant', name: 'compaction_summary', content: 'model summary', provenance: 'model', authoritative: false },
      { role: 'user', content: 'continue' },
    ], 'default system prompt');
    assert.match(wire[0]!.content, /advisory/i);
    assert.match(wire[0]!.content, /not.*authority|cannot.*approve|not.*permission/i);
    assert.equal(wire[1]!.role, 'assistant');
    assert.equal(wire[1]!.content, 'model summary');
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

  test('Astra Probe P02: compaction preserves the retained tail and tool results in native reconstruction', () => {
    const call = (id: string, name = 'read_file') => ({
      id,
      type: 'function' as const,
      function: { name, arguments: '{}' },
    });
    const token = 'ONLY_KEPT_RESULT_HAS_THE_NONCE_4d713';
    const initialLog = createThreadEventLog('p02-thread');
    initialLog.events.push(
      {
        schema_version: 1,
        event_id: 'e0',
        thread_id: 'p02-thread',
        turn_id: 't1',
        item_id: 't1:0',
        seq: 0,
        ts: new Date().toISOString(),
        kind: 'user_message',
        content: 'Use the exact nonce returned by the tool.',
      },
      {
        schema_version: 1,
        event_id: 'e1',
        thread_id: 'p02-thread',
        turn_id: 't1',
        item_id: 't1:1',
        seq: 1,
        ts: new Date().toISOString(),
        kind: 'assistant_tool_calls',
        content: '',
        tool_calls: [call('c1')],
      },
      {
        schema_version: 1,
        event_id: 'e2',
        thread_id: 'p02-thread',
        turn_id: 't1',
        item_id: 't1:2',
        seq: 2,
        ts: new Date().toISOString(),
        kind: 'tool_result',
        tool_call_id: 'c1',
        tool_name: 'read_file',
        content: token,
      },
    );
    initialLog.nextSeq = 3;

    const liveTail = rebuildProviderMessagesFromEvents(initialLog);
    const compactedLog = {
      ...initialLog,
      events: [
        ...initialLog.events,
        {
          schema_version: 1 as const,
          event_id: 'e3',
          thread_id: 'p02-thread',
          turn_id: 't1',
          item_id: 't1:3',
          seq: 3,
          ts: new Date().toISOString(),
          kind: 'compaction_capsule' as const,
          content: 'Task: use exact nonce. Recent tool: read_file.',
          preserved_tool_call_ids: ['c1'],
        },
      ],
      nextSeq: 4,
    };

    const outbound = rebuildProviderMessagesFromEvents(compactedLog, { systemPrompt: 'System' });
    const wire = mapProviderMessagesToWire(outbound, 'System');
    assert.equal(liveTail.some((m) => m.content.includes(token)), true);
    assert.equal(outbound.some((m) => m.content.includes(token)), true);
    assert.equal(outbound.some((m) => m.tool_call_id === 'c1'), true);
    assert.equal(wire.some((m) => m.content.includes(token)), true);
    assert.deepEqual(validateProviderMessageProtocol(outbound), []);
  });

  test('Astra Probe P03: reloading durable log with compaction capsule preserves retained context', () => {
    const call = (id: string, name = 'read_file') => ({
      id,
      type: 'function' as const,
      function: { name, arguments: '{}' },
    });
    const token = 'ONLY_KEPT_RESULT_HAS_THE_NONCE_4d713';
    const initialLog = createThreadEventLog('p03-thread');
    initialLog.events.push(
      {
        schema_version: 1,
        event_id: 'e0',
        thread_id: 'p03-thread',
        turn_id: 't1',
        item_id: 't1:0',
        seq: 0,
        ts: new Date().toISOString(),
        kind: 'user_message',
        content: 'Use the exact nonce returned by the tool.',
      },
      {
        schema_version: 1,
        event_id: 'e1',
        thread_id: 'p03-thread',
        turn_id: 't1',
        item_id: 't1:1',
        seq: 1,
        ts: new Date().toISOString(),
        kind: 'assistant_tool_calls',
        content: '',
        tool_calls: [call('c1')],
      },
      {
        schema_version: 1,
        event_id: 'e2',
        thread_id: 'p03-thread',
        turn_id: 't1',
        item_id: 't1:2',
        seq: 2,
        ts: new Date().toISOString(),
        kind: 'tool_result',
        tool_call_id: 'c1',
        tool_name: 'read_file',
        content: token,
      },
      {
        schema_version: 1,
        event_id: 'e3',
        thread_id: 'p03-thread',
        turn_id: 't1',
        item_id: 't1:3',
        seq: 3,
        ts: new Date().toISOString(),
        kind: 'compaction_capsule',
        content: 'Task: use exact nonce.',
        preserved_tool_call_ids: ['c1'],
      },
    );
    initialLog.nextSeq = 4;

    const restored = JSON.parse(JSON.stringify(initialLog));
    const live = rebuildProviderMessagesFromEvents(initialLog, { systemPrompt: 'System' });
    const rebuilt = rebuildProviderMessagesFromEvents(restored, { systemPrompt: 'System' });

    assert.deepEqual(live, rebuilt);
    assert.equal(rebuilt.some((m) => m.content.includes(token)), true);
    assert.equal(rebuilt.some((m) => m.tool_call_id === 'c1'), true);
  });

  test('sequential two-batch reconstruction does not merge later tool results onto the first assistant', () => {
    const call = (id: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'read_file', arguments: '{}' },
    });
    const log = createThreadEventLog('two-batch');
    log.events.push(
      {
        schema_version: 1,
        event_id: 'e0',
        thread_id: 'two-batch',
        turn_id: 't1',
        item_id: 't1:0',
        seq: 0,
        ts: new Date().toISOString(),
        kind: 'assistant_tool_calls',
        content: 'A',
        tool_calls: [call('A')],
      },
      {
        schema_version: 1,
        event_id: 'e1',
        thread_id: 'two-batch',
        turn_id: 't1',
        item_id: 't1:1',
        seq: 1,
        ts: new Date().toISOString(),
        kind: 'tool_result',
        tool_call_id: 'A',
        tool_name: 'read_file',
        content: 'result-A',
      },
      {
        schema_version: 1,
        event_id: 'e2',
        thread_id: 'two-batch',
        turn_id: 't1',
        item_id: 't1:2',
        seq: 2,
        ts: new Date().toISOString(),
        kind: 'assistant_tool_calls',
        content: 'B',
        tool_calls: [call('B')],
      },
      {
        schema_version: 1,
        event_id: 'e3',
        thread_id: 'two-batch',
        turn_id: 't1',
        item_id: 't1:3',
        seq: 3,
        ts: new Date().toISOString(),
        kind: 'tool_result',
        tool_call_id: 'B',
        tool_name: 'read_file',
        content: 'result-B',
      },
      {
        schema_version: 1,
        event_id: 'e4',
        thread_id: 'two-batch',
        turn_id: 't1',
        item_id: 't1:4',
        seq: 4,
        ts: new Date().toISOString(),
        kind: 'compaction_capsule',
        content: 'capsule',
        preserved_tool_call_ids: ['A', 'B'],
      },
    );
    log.nextSeq = 5;
    const rebuilt = rebuildProviderMessagesFromEvents(log, { systemPrompt: 'sys' });
    const wire = mapProviderMessagesToWire(rebuilt, 'sys');
    const batches = wire
      .filter((m) => m.role === 'assistant' && m.tool_calls?.length)
      .map((m) => (m.tool_calls ?? []).map((c) => c.id));
    assert.deepEqual(batches, [['A'], ['B']]);
    assert.deepEqual(validateProviderMessageProtocol(rebuilt), []);
  });

  test('validateProviderMessageProtocol rejects duplicate declared tool IDs', () => {
    const issues = validateProviderMessageProtocol([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'same', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'same', type: 'function', function: { name: 'grep', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'one result only', tool_call_id: 'same' },
    ]);
    assert.ok(issues.some((i) => i.code === 'duplicate_tool_call_id'));
    assert.ok(issues.some((i) => i.code === 'unanswered_tool_call'));
  });

  test('validateProviderMessageProtocol rejects whitespace-only tool IDs', () => {
    const issuesAssistant = validateProviderMessageProtocol([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: '   ', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
    ]);
    assert.ok(issuesAssistant.some((i) => i.code === 'assistant_tool_call_missing_id'));

    const issuesTool = validateProviderMessageProtocol([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'valid_id', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'result', tool_call_id: '   ' },
    ]);
    assert.ok(issuesTool.some((i) => i.code === 'tool_missing_call_id'));
  });
});
