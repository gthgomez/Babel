/**
 * Compaction oracle — production-boundary survival of the retained working set.
 *
 * Drives commitCompaction + rebuildProviderMessagesFromEvents +
 * mapProviderMessagesToWire (the native next-request serializer). Does not
 * declare success from projector-vs-projector agreement.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  CompactionManager,
  LLMSummarizeCompaction,
  type ChatMessage,
} from './chatCompaction.js';
import { commitCompaction } from './compactionCommit.js';
import {
  createThreadEventLog,
  startTurn,
  recordAssistantToolCalls,
  recordToolResult,
  recordAssistantMessage,
  recordUserMessage,
  rebuildProviderMessagesFromEvents,
  serializeThreadEventLog,
  parseThreadEventLog,
  type ThreadEventLog,
} from './threadEventLog.js';
import { createSessionEventLog } from './sessionEvents.js';
import {
  mapProviderMessagesToWire,
  validateProviderMessageProtocol,
  type WireProviderMessage,
} from '../runners/providerMessages.js';
import type { ProviderToolCall } from '../runners/base.js';

const SYSTEM = 'You are a helpful coding assistant.';
const PAD = 'x'.repeat(240);

function oldTurn(n: number): ChatMessage[] {
  return [
    { role: 'user', content: `old prefix ${n} ${PAD}` },
    { role: 'assistant', content: `old prefix ${n} ack ${PAD}` },
  ];
}

const savedCompactionBase = process.env['BABEL_COMPACTION_API_BASE'];
const savedCompactionModel = process.env['BABEL_COMPACTION_MODEL'];
const savedCompactionKey = process.env['BABEL_COMPACTION_API_KEY'];

beforeEach(() => {
  process.env['BABEL_COMPACTION_API_BASE'] = 'https://api.deepinfra.com/v1/openai/chat/completions';
  process.env['BABEL_COMPACTION_API_KEY'] = 'test-oracle-key';
  delete process.env['BABEL_COMPACTION_MODEL'];
});
afterEach(() => {
  if (savedCompactionBase === undefined) delete process.env['BABEL_COMPACTION_API_BASE'];
  else process.env['BABEL_COMPACTION_API_BASE'] = savedCompactionBase;
  if (savedCompactionModel === undefined) delete process.env['BABEL_COMPACTION_MODEL'];
  else process.env['BABEL_COMPACTION_MODEL'] = savedCompactionModel;
  if (savedCompactionKey === undefined) delete process.env['BABEL_COMPACTION_API_KEY'];
  else process.env['BABEL_COMPACTION_API_KEY'] = savedCompactionKey;
});

function call(id: string, name: string, args = '{}'): ProviderToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function assistantTools(content: string, tools: ProviderToolCall[]): ChatMessage {
  return { role: 'assistant', content, name: 'tool_calls', tool_calls: tools } as ChatMessage & {
    tool_calls: ProviderToolCall[];
  };
}

function toolResult(id: string, name: string, content: string): ChatMessage {
  return { role: 'tool', content, toolCallId: id, toolName: name };
}

function nextWire(log: ThreadEventLog, systemPrompt = SYSTEM): WireProviderMessage[] {
  const rebuilt = rebuildProviderMessagesFromEvents(log, { systemPrompt });
  assert.deepEqual(validateProviderMessageProtocol(rebuilt), []);
  return mapProviderMessagesToWire(rebuilt, systemPrompt);
}

function assistantBatches(wire: WireProviderMessage[]): string[][] {
  return wire
    .filter((message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0)
    .map((message) => (message.tool_calls ?? []).map((toolCall) => toolCall.id));
}

function wireHas(wire: WireProviderMessage[], needle: string): boolean {
  return wire.some((message) => message.content.includes(needle));
}

async function compactAndCommit(input: {
  conversation: ChatMessage[];
  threadLog: ThreadEventLog;
  turnId: string;
  keepRecentMessages: number;
  summary: string;
  task?: string;
}): Promise<{ conversation: ChatMessage[]; wire: WireProviderMessage[] }> {
  const llm = new LLMSummarizeCompaction({ keepRecentMessages: input.keepRecentMessages });
  (llm as any).callCompactionApi = async () => ({
    summary: input.summary,
    inputTokens: 300,
    outputTokens: 50,
  });
  const manager = new CompactionManager([llm]);
  const mgr = await manager.compactWithResult(input.conversation, {
    model: 'deepseek-chat',
    maxTokens: 60,
  });
  assert.equal(mgr.changed, true);
  const commit = await commitCompaction({
    strategyMessages: mgr.messages,
    priorConversation: input.conversation,
    strategy: mgr.strategy,
    tokensBefore: mgr.tokensBefore,
    tokensAfter: mgr.tokensAfter,
    operational: { task: input.task ?? 'oracle task' },
    threadLog: input.threadLog,
    sessionLog: createSessionEventLog(input.threadLog.thread_id),
    turnId: input.turnId,
    modelId: 'deepseek-chat',
  });
  assert.equal(commit.status, 'committed');
  return { conversation: commit.conversation, wire: nextWire(input.threadLog) };
}

describe('Canary C: Compaction Oracle', () => {
  it('1. preserves one retained tool cycle in the next provider request', async () => {
    const nonce = 'ORACLE_ONE_CYCLE_NONCE_aa91';
    const threadLog = createThreadEventLog('oracle-one');
    const turnId = startTurn(threadLog, {
      task: 'use the nonce',
      model: 'deepseek-chat',
      provider: 'deepseek',
      projectRoot: '/tmp/oracle',
      policyPreset: 'chat',
    });
    const tool = call('cycle_1', 'read_diagnostic', '{"target":"one"}');
    recordAssistantToolCalls(threadLog, turnId, 'inspect', [tool]);
    recordToolResult(threadLog, turnId, {
      tool_call_id: 'cycle_1',
      tool_name: 'read_diagnostic',
      content: `nonce=${nonce}`,
    });

    const conversation: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      ...oldTurn(1),
      ...oldTurn(2),
      { role: 'user', content: 'Use the exact nonce from the tool.' },
      assistantTools('inspect', [tool]),
      toolResult('cycle_1', 'read_diagnostic', `nonce=${nonce}`),
    ];

    const { wire } = await compactAndCommit({
      conversation,
      threadLog,
      turnId,
      keepRecentMessages: 3,
      summary: 'OLD_PREFIX_SUMMARY: setup only. No nonce here.',
    });
    assert.equal(wireHas(wire, nonce), true);
    assert.deepEqual(assistantBatches(wire), [['cycle_1']]);
    assert.equal(
      wire.some((message) => message.role === 'tool' && message.tool_call_id === 'cycle_1'),
      true,
    );
  });

  it('2. keeps two sequential retained tool batches as separate assistant messages', async () => {
    const factA = 'SEQ_FACT_A_only_in_result_A';
    const factB = 'SEQ_FACT_B_only_in_result_B';
    const threadLog = createThreadEventLog('oracle-seq');
    const turnId = startTurn(threadLog, {
      task: 'two batches',
      model: 'deepseek-chat',
      provider: 'deepseek',
      projectRoot: '/tmp/oracle',
      policyPreset: 'chat',
    });
    const callA = call('call_A', 'read_file', '{"path":"a.ts"}');
    const callB = call('call_B', 'read_file', '{"path":"b.ts"}');
    recordAssistantToolCalls(threadLog, turnId, 'read A', [callA]);
    recordToolResult(threadLog, turnId, {
      tool_call_id: 'call_A',
      tool_name: 'read_file',
      content: factA,
    });
    recordAssistantToolCalls(threadLog, turnId, 'read B', [callB]);
    recordToolResult(threadLog, turnId, {
      tool_call_id: 'call_B',
      tool_name: 'read_file',
      content: factB,
    });

    const conversation: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      ...oldTurn(1),
      ...oldTurn(2),
      { role: 'user', content: 'read both files' },
      assistantTools('read A', [callA]),
      toolResult('call_A', 'read_file', factA),
      assistantTools('read B', [callB]),
      toolResult('call_B', 'read_file', factB),
    ];

    const { wire } = await compactAndCommit({
      conversation,
      threadLog,
      turnId,
      keepRecentMessages: 5,
      summary: 'OLD_PREFIX_SUMMARY: earlier turns. No sequential facts.',
    });

    assert.equal(wireHas(wire, factA), true);
    assert.equal(wireHas(wire, factB), true);
    assert.deepEqual(
      assistantBatches(wire),
      [['call_A'], ['call_B']],
      'sequential batches must not collapse into assistant -> calls A+B',
    );
    const merged = wire.some(
      (message) =>
        message.role === 'assistant' &&
        (message.tool_calls ?? []).some((toolCall) => toolCall.id === 'call_A') &&
        (message.tool_calls ?? []).some((toolCall) => toolCall.id === 'call_B'),
    );
    assert.equal(merged, false);
  });

  it('3. preserves parallel calls in one batch as a single assistant tool_calls message', async () => {
    const threadLog = createThreadEventLog('oracle-par');
    const turnId = startTurn(threadLog, {
      task: 'parallel',
      model: 'deepseek-chat',
      provider: 'deepseek',
      projectRoot: '/tmp/oracle',
      policyPreset: 'chat',
    });
    const p1 = call('par_1', 'read_file', '{"path":"x.ts"}');
    const p2 = call('par_2', 'list_dir', '{"path":"."}');
    recordAssistantToolCalls(threadLog, turnId, 'parallel inspect', [p1, p2]);
    recordToolResult(threadLog, turnId, {
      tool_call_id: 'par_1',
      tool_name: 'read_file',
      content: 'PARALLEL_X',
    });
    recordToolResult(threadLog, turnId, {
      tool_call_id: 'par_2',
      tool_name: 'list_dir',
      content: 'PARALLEL_DIR',
    });

    const conversation: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      ...oldTurn(1),
      ...oldTurn(2),
      { role: 'user', content: 'inspect in parallel' },
      assistantTools('parallel inspect', [p1, p2]),
      toolResult('par_1', 'read_file', 'PARALLEL_X'),
      toolResult('par_2', 'list_dir', 'PARALLEL_DIR'),
    ];

    const { wire } = await compactAndCommit({
      conversation,
      threadLog,
      turnId,
      keepRecentMessages: 4,
      summary: 'OLD_PREFIX_SUMMARY: no parallel facts.',
    });
    assert.deepEqual(assistantBatches(wire), [['par_1', 'par_2']]);
    assert.equal(wireHas(wire, 'PARALLEL_X'), true);
    assert.equal(wireHas(wire, 'PARALLEL_DIR'), true);
  });

  it('4. keeps retained user/assistant text between sequential batches', async () => {
    const threadLog = createThreadEventLog('oracle-mid');
    const turnId = startTurn(threadLog, {
      task: 'between batches',
      model: 'deepseek-chat',
      provider: 'deepseek',
      projectRoot: '/tmp/oracle',
      policyPreset: 'chat',
    });
    const callA = call('mid_A', 'read_file', '{"path":"a.ts"}');
    const callB = call('mid_B', 'read_file', '{"path":"b.ts"}');
    recordAssistantToolCalls(threadLog, turnId, 'A', [callA]);
    recordToolResult(threadLog, turnId, {
      tool_call_id: 'mid_A',
      tool_name: 'read_file',
      content: 'A_BODY',
    });
    recordUserMessage(threadLog, turnId, 'BETWEEN_BATCHES_USER_TEXT');
    recordAssistantMessage(threadLog, turnId, 'BETWEEN_BATCHES_ASSISTANT_TEXT');
    recordAssistantToolCalls(threadLog, turnId, 'B', [callB]);
    recordToolResult(threadLog, turnId, {
      tool_call_id: 'mid_B',
      tool_name: 'read_file',
      content: 'B_BODY',
    });

    const conversation: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      ...oldTurn(1),
      assistantTools('A', [callA]),
      toolResult('mid_A', 'read_file', 'A_BODY'),
      { role: 'user', content: 'BETWEEN_BATCHES_USER_TEXT' },
      { role: 'assistant', content: 'BETWEEN_BATCHES_ASSISTANT_TEXT' },
      assistantTools('B', [callB]),
      toolResult('mid_B', 'read_file', 'B_BODY'),
    ];

    const { wire } = await compactAndCommit({
      conversation,
      threadLog,
      turnId,
      keepRecentMessages: 6,
      summary: 'OLD_PREFIX_SUMMARY: no between-batch text.',
    });
    assert.equal(wireHas(wire, 'BETWEEN_BATCHES_USER_TEXT'), true);
    assert.equal(wireHas(wire, 'BETWEEN_BATCHES_ASSISTANT_TEXT'), true);
    assert.deepEqual(assistantBatches(wire), [['mid_A'], ['mid_B']]);
  });

  it('5-8. second compaction, resume, and unique tail fact survive in the next provider request', async () => {
    const nonce1 = 'ORACLE_NONCE_TAIL_ALPHA_98765';
    const req1 = 'REQUIREMENT_TAIL_ALPHA_MUST_SURVIVE';
    const nonce2 = 'ORACLE_NONCE_TAIL_BETA_67890';
    const req2 = 'REQUIREMENT_TAIL_BETA_MUST_SURVIVE';

    const threadLog = createThreadEventLog('oracle-c');
    const sessionLog = createSessionEventLog('oracle-c');
    const turnId1 = startTurn(threadLog, {
      task: 'Initial task: set up environment',
      model: 'deepseek-chat',
      provider: 'deepseek',
      projectRoot: '/tmp/oracle',
      policyPreset: 'chat',
    });

    const tool1 = call('tool_call_tail_1', 'read_diagnostic', '{"target":"oracle_tail_1"}');
    recordAssistantMessage(threadLog, turnId1, 'Understood, setting up turn 1');
    recordAssistantToolCalls(threadLog, turnId1, 'Inspecting diagnostic tail', [tool1]);
    recordToolResult(threadLog, turnId1, {
      tool_call_id: 'tool_call_tail_1',
      tool_name: 'read_diagnostic',
      content: `Diagnostic output: nonce=${nonce1}`,
    });

    const conversation: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      ...oldTurn(1),
      ...oldTurn(2),
      { role: 'user', content: `Active instruction: verify ${req1}` },
      assistantTools('Inspecting diagnostic tail', [tool1]),
      toolResult('tool_call_tail_1', 'read_diagnostic', `Diagnostic output: nonce=${nonce1}`),
    ];

    const llm1 = new LLMSummarizeCompaction({ keepRecentMessages: 3 });
    (llm1 as any).callCompactionApi = async () => ({
      summary: 'OLD_PREFIX_SUMMARY: setup turns 1-4 completed successfully. No tail facts here.',
      inputTokens: 300,
      outputTokens: 50,
    });
    const mgr1 = await new CompactionManager([llm1]).compactWithResult(conversation, {
      model: 'deepseek-chat',
      maxTokens: 60,
    });
    assert.equal(mgr1.changed, true);
    const summary1 = mgr1.messages.find((message) => message.name === 'compaction_summary');
    assert.ok(summary1);
    assert.equal(summary1!.content.includes(nonce1), false);
    assert.equal(summary1!.content.includes(req1), false);

    const commit1 = await commitCompaction({
      strategyMessages: mgr1.messages,
      priorConversation: conversation,
      strategy: mgr1.strategy,
      tokensBefore: mgr1.tokensBefore,
      tokensAfter: mgr1.tokensAfter,
      operational: { task: 'oracle verification task', planStep: 'step-compaction-1' },
      threadLog,
      sessionLog,
      turnId: turnId1,
      modelId: 'deepseek-chat',
    });
    assert.equal(commit1.status, 'committed');

    const wire1 = nextWire(threadLog);
    assert.equal(wireHas(wire1, nonce1), true, 'unique tail nonce must be in next provider request');
    assert.equal(wireHas(wire1, req1), true, 'unique tail requirement must be in next provider request');
    assert.deepEqual(assistantBatches(wire1), [['tool_call_tail_1']]);

    const turnId2 = startTurn(threadLog, {
      task: 'Second phase: execute mutation',
      model: 'deepseek-chat',
      provider: 'deepseek',
      projectRoot: '/tmp/oracle',
      policyPreset: 'chat',
    });
    const tool2 = call('tool_call_tail_2', 'write_diagnostic', '{"target":"oracle_tail_2"}');
    recordAssistantToolCalls(threadLog, turnId2, 'Applying mutation for phase 2', [tool2]);
    recordToolResult(threadLog, turnId2, {
      tool_call_id: 'tool_call_tail_2',
      tool_name: 'write_diagnostic',
      content: `Applied mutation successfully: nonce=${nonce2}`,
    });

    const conversation2: ChatMessage[] = [
      ...commit1.conversation,
      { role: 'user', content: `Second phase active requirement: ${req2}` },
      assistantTools('Applying mutation for phase 2', [tool2]),
      toolResult('tool_call_tail_2', 'write_diagnostic', `Applied mutation successfully: nonce=${nonce2}`),
    ];

    const llm2 = new LLMSummarizeCompaction({ keepRecentMessages: 3 });
    (llm2 as any).callCompactionApi = async () => ({
      summary: `PHASE1_CONSOLIDATED: Alpha phase completed (${nonce1}). No Beta facts here.`,
      inputTokens: 500,
      outputTokens: 60,
    });
    const mgr2 = await new CompactionManager([llm2]).compactWithResult(conversation2, {
      model: 'deepseek-chat',
      maxTokens: 60,
    });
    assert.equal(mgr2.changed, true);
    const summary2 = mgr2.messages.find((message) => message.name === 'compaction_summary');
    assert.ok(summary2);
    assert.equal(summary2!.content.includes(nonce2), false);
    assert.equal(summary2!.content.includes(req2), false);

    const commit2 = await commitCompaction({
      strategyMessages: mgr2.messages,
      priorConversation: conversation2,
      strategy: mgr2.strategy,
      tokensBefore: mgr2.tokensBefore,
      tokensAfter: mgr2.tokensAfter,
      operational: { task: 'oracle verification task', planStep: 'step-compaction-2' },
      threadLog,
      sessionLog,
      turnId: turnId2,
      modelId: 'deepseek-chat',
    });
    assert.equal(commit2.status, 'committed');

    const wire2 = nextWire(threadLog);
    assert.equal(wireHas(wire2, nonce2), true, 'second-compaction unique tail fact must be in next provider request');
    assert.equal(wireHas(wire2, req2), true);
    assert.deepEqual(assistantBatches(wire2), [['tool_call_tail_2']]);
    assert.deepEqual(validateProviderMessageProtocol(wire2), []);

    const restored = parseThreadEventLog(serializeThreadEventLog(threadLog));
    const resumedWire = nextWire(restored);
    assert.deepEqual(resumedWire, wire2);
    assert.equal(wireHas(resumedWire, nonce2), true);
    assert.equal(wireHas(resumedWire, req2), true);
  });
});
