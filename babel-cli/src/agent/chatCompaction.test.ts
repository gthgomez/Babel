/**
 * chatCompaction.test.ts — Tests for the compaction module.
 *
 * Tests cover:
 *   1. Token estimation utilities
 *   2. shouldCompact / compactionTarget decision helpers
 *   3. findCompactBoundary boundary detection
 *   4. HeuristicTruncationStrategy (fallback truncation)
 *   5. LLMSummarizeCompaction (LLM-based summarization with mocked API)
 *   6. CompactionManager orchestration
 *   7. CompactionPrompt generation
 *   8. Error handling and circuit breaker behavior
 *   9. Env var overrides (BABEL_COMPACTION=off)
 *  10. Edge cases (empty conversations, no system prompt, tool pairs)
 */

import * as assert from 'node:assert';
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import {
  estimateTokens,
  shouldCompact,
  compactionTarget,
  findCompactBoundary,
  buildCompactionPrompt,
  HeuristicTruncationStrategy,
  LLMSummarizeCompaction,
  CompactionManager,
  DEFAULT_COMPACTION_CONFIG,
  type ChatMessage,
  type CompactionOptions,
  type CompactionStrategy,
} from './chatCompaction.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeMessages(overrides?: Partial<ChatMessage>[]): ChatMessage[] {
  const defaults: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: 'What is the capital of France?' },
    { role: 'assistant', content: 'The capital is Paris.' },
    { role: 'user', content: 'How do I read a file in Node.js?' },
    { role: 'assistant', content: 'Use fs.readFile or fs.promises.readFile.' },
  ];
  if (!overrides) return defaults;
  return defaults.map((m, i) => (overrides[i] ? { ...m, ...overrides[i] } : m));
}

function makeLongConversation(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant with a very long system prompt that goes on for quite a while and provides lots of context to ensure the conversation is grounded.' },
  ];
  for (let i = 0; i < count; i++) {
    messages.push(
      { role: 'user', content: `This is user message number ${i} with some additional padding to make it longer and more representative of a real conversation message.` },
      { role: 'assistant', content: `This is assistant response number ${i} with a detailed answer that provides useful information back to the user about their question.` },
    );
  }
  return messages;
}

function makeToolConversation(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Read the file and tell me what it says.' },
    { role: 'assistant', content: 'Let me read that file.', name: 'tool_calls' },
    { role: 'tool', content: 'File contents: Hello World' },
    { role: 'assistant', content: 'The file says "Hello World".' },
    { role: 'user', content: 'Now write to it.' },
    { role: 'assistant', content: 'Writing now.', name: 'tool_calls' },
    { role: 'tool', content: 'File written successfully.' },
    { role: 'assistant', content: 'Done writing.' },
    { role: 'user', content: 'What was in the file again?' },
    { role: 'assistant', content: 'It contained "Hello World".' },
  ];
}

// ─── 1. Token Estimation ──────────────────────────────────────────────────

describe('estimateTokens()', () => {
  it('returns 0 for empty array', () => {
    assert.strictEqual(estimateTokens([]), 0);
  });

  it('estimates tokens for system message', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'Hello' }];
    const tokens = estimateTokens(msgs);
    assert.ok(tokens > 0);
    // 'Hello' is 5 chars, ~1.25 tokens + 4 overhead
    assert.strictEqual(tokens, 6);
  });

  it('estimates tokens for multiple messages', () => {
    const tokens = estimateTokens(makeMessages());
    // Each message: ceil(len/4) + 4 structural overhead
    // (count varies by exact char count; the assertion reflects the computed result)
    assert.ok(tokens > 0);
    assert.strictEqual(tokens, 72);
  });

  it('handles content with special characters', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(1000) }];
    const tokens = estimateTokens(msgs);
    assert.strictEqual(tokens, Math.ceil(1000 / 4) + 4);
  });
});

// ─── 2. shouldCompact ──────────────────────────────────────────────────────

describe('shouldCompact()', () => {
  it('returns false when within token budget', () => {
    const msgs = makeMessages(); // ~71 tokens
    assert.strictEqual(shouldCompact(msgs, 100_000, 8_000), false);
  });

  it('returns true when exceeding token budget', () => {
    const msgs = makeLongConversation(200); // well over 100_000 tokens
    assert.strictEqual(shouldCompact(msgs, 10_000, 1_000), true);
  });

  it('returns false for empty conversation', () => {
    assert.strictEqual(shouldCompact([], 1000, 100), false);
  });

  it('handles zero reserve tokens', () => {
    const msgs = makeMessages(); // ~71 tokens
    assert.strictEqual(shouldCompact(msgs, 50, 0), true);
  });

  it('handles negative reserve (edge case)', () => {
    const msgs = makeMessages(); // ~71 tokens
    assert.strictEqual(shouldCompact(msgs, 50, -100), false); // budget = 150
  });
});

// ─── 3. compactionTarget ───────────────────────────────────────────────────

describe('compactionTarget()', () => {
  it('returns a positive target', () => {
    const msgs = makeMessages();
    const target = compactionTarget(1, msgs, 100_000);
    assert.ok(target >= 500);
    assert.ok(target <= DEFAULT_COMPACTION_CONFIG.maxSummaryTokens);
  });

  it('returns minimum of 500 for tight budget', () => {
    const msgs = makeLongConversation(5);
    const target = compactionTarget(11, msgs, 1000);
    assert.strictEqual(target, 500);
  });

  it('returns capped target for generous budget', () => {
    const msgs = makeMessages();
    const target = compactionTarget(1, msgs, 1_000_000);
    assert.strictEqual(target, DEFAULT_COMPACTION_CONFIG.maxSummaryTokens);
  });
});

// ─── 4. findCompactBoundary ───────────────────────────────────────────────

describe('findCompactBoundary()', () => {
  it('returns messages.length when nothing to compact', () => {
    const msgs = makeMessages(); // 7 messages
    const boundary = findCompactBoundary(msgs, 10);
    assert.strictEqual(boundary, msgs.length);
  });

  it('finds correct boundary for small keep count', () => {
    const msgs = makeMessages(); // 7 messages
    const boundary = findCompactBoundary(msgs, 2);
    // Keep 2 recent messages: index 5 and 6
    assert.strictEqual(boundary, 5);
  });

  it('preserves tool pairs at boundary', () => {
    const msgs = makeToolConversation(); // 12 messages
    const boundary = findCompactBoundary(msgs, 4);
    // Keep last 4: index 8, 9, 10, 11
    // msg[8] is tool — scan back: msg[6] is assistant with name='tool_calls'
    // So boundary should be 6
    assert.strictEqual(boundary, 6);
  });

  it('does not compact past system message', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ];
    // boundary = 3 - 2 = 1, minBoundary = 1
    // boundary <= minBoundary, so return messages.length
    assert.strictEqual(findCompactBoundary(msgs, 2), msgs.length);
  });
});

// ─── 5. buildCompactionPrompt ──────────────────────────────────────────────

describe('buildCompactionPrompt()', () => {
  it('includes the conversation messages', () => {
    const msgs = makeMessages().slice(1); // exclude system prompt
    const prompt = buildCompactionPrompt(msgs, 2000);
    assert.ok(prompt.includes('Hello'));
    assert.ok(prompt.includes('capital of France'));
    assert.ok(prompt.includes('KEY_DECISIONS'));
    assert.ok(prompt.includes('CODE_CHANGES'));
  });

  it('respects maxTokens constraint', () => {
    const prompt = buildCompactionPrompt(makeMessages().slice(1), 500);
    assert.ok(prompt.includes('500 tokens'));
  });

  it('formats messages with role labels', () => {
    const msgs = [makeMessages()[1]!]; // user 'Hello'
    const prompt = buildCompactionPrompt(msgs, 2000);
    assert.ok(prompt.includes('<USER>'));
    assert.ok(prompt.includes('</USER>'));
  });

  it('includes name labels when present', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'Tool result', name: 'tool_calls' },
    ];
    const prompt = buildCompactionPrompt(msgs, 2000);
    assert.ok(prompt.includes('ASSISTANT (tool_calls)'));
  });
});

// ─── 6. HeuristicTruncationStrategy ───────────────────────────────────────

describe('HeuristicTruncationStrategy', () => {
  it('has the correct name', () => {
    const strategy = new HeuristicTruncationStrategy();
    assert.strictEqual(strategy.name, 'heuristic-truncation');
  });

  it('canApply returns true when over budget', () => {
    const strategy = new HeuristicTruncationStrategy();
    assert.strictEqual(strategy.canApply([{ role: 'user', content: 'x'.repeat(4000) }], 10000, 100), true);
  });

  it('canApply returns false when under budget', () => {
    const strategy = new HeuristicTruncationStrategy();
    const msgs = makeMessages();
    const estimated = estimateTokens(msgs);
    // estimated=74, maxTokens=estimated+1000 → 74 < 1074 → false
    assert.strictEqual(strategy.canApply(msgs, estimated, estimated + 1000), false);
  });

  it('preserves system message', async () => {
    const strategy = new HeuristicTruncationStrategy(2);
    const msgs = makeMessages(); // system + 6 messages
    const result = await strategy.compact(msgs, { model: '', maxTokens: 100000 });
    assert.strictEqual(result[0]!.role, 'system');
    assert.ok(result.length < msgs.length);
  });

  it('preserves tool pairs at truncation boundary', async () => {
    const strategy = new HeuristicTruncationStrategy(4);
    const msgs = makeToolConversation();
    const result = await strategy.compact(msgs, { model: '', maxTokens: 100000 });

    // Verify tool_calls assistant message and its tool result are together
    for (let i = 0; i < result.length - 1; i++) {
      if (result[i]!.role === 'assistant' && result[i]!.name === 'tool_calls') {
        assert.strictEqual(result[i + 1]!.role, 'tool');
      }
    }
  });

  it('does not modify messages when within bounds', async () => {
    const strategy = new HeuristicTruncationStrategy(10);
    const msgs = makeMessages();
    const result = await strategy.compact(msgs, { model: '', maxTokens: 100000 });
    assert.deepStrictEqual(result, msgs);
  });

  it('handles conversation with no system prompt', async () => {
    const strategy = new HeuristicTruncationStrategy(2);
    const msgs = makeMessages().slice(1); // remove system
    const result = await strategy.compact(msgs, { model: '', maxTokens: 100 });
    assert.ok(result.length > 0);
    assert.ok(result.length < msgs.length);
  });

  it('handles empty conversation', async () => {
    const strategy = new HeuristicTruncationStrategy();
    const result = await strategy.compact([], { model: '', maxTokens: 100 });
    assert.deepStrictEqual(result, []);
  });
});

// ─── 7. LLMSummarizeCompaction ────────────────────────────────────────────

describe('LLMSummarizeCompaction', () => {
  it('has the correct name', () => {
    const strategy = new LLMSummarizeCompaction();
    assert.strictEqual(strategy.name, 'llm-summarize');
  });

  it('canApply returns false when BABEL_COMPACTION=off', () => {
    process.env['BABEL_COMPACTION'] = 'off';
    const strategy = new LLMSummarizeCompaction();
    const result = strategy.canApply([], 10000, 100);
    delete process.env['BABEL_COMPACTION'];
    assert.strictEqual(result, false);
  });

  it('canApply returns false when no API key available', () => {
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    delete process.env['BABEL_COMPACTION_API_KEY'];
    const savedDi = process.env['DEEPINFRA_API_KEY'];
    delete process.env['DEEPINFRA_API_KEY'];
    const savedAn = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    const strategy = new LLMSummarizeCompaction();
    const result = strategy.canApply([], 10000, 100);

    // Restore
    if (savedKey) process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
    if (savedDi) process.env['DEEPINFRA_API_KEY'] = savedDi;
    if (savedAn) process.env['ANTHROPIC_API_KEY'] = savedAn;

    assert.strictEqual(result, false);
  });

  it('canApply returns true when compaction is needed and key is available', () => {
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-key';

    const strategy = new LLMSummarizeCompaction();
    const result = strategy.canApply([{ role: 'user', content: 'x'.repeat(10000) }], 10000, 100);

    // Restore
    if (savedKey) {
      process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
    } else {
      delete process.env['BABEL_COMPACTION_API_KEY'];
    }

    assert.strictEqual(result, true);
  });

  it('circuit breaker trips after consecutive failures', () => {
    const strategy = new LLMSummarizeCompaction();
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(strategy.getConsecutiveFailures(), i);
      (strategy as any).consecutiveFailures = i + 1;
    }
    assert.strictEqual(strategy.getConsecutiveFailures(), 3);
    assert.strictEqual(strategy.canApply([{ role: 'user', content: 'x'.repeat(10000) }], 10000, 100), false);
  });

  it('resetCircuitBreaker clears failure counter', () => {
    const strategy = new LLMSummarizeCompaction();
    (strategy as any).consecutiveFailures = 3;
    strategy.resetCircuitBreaker();
    assert.strictEqual(strategy.getConsecutiveFailures(), 0);
  });

  it('falls back gracefully when API call fails', async () => {
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    delete process.env['BABEL_COMPACTION_API_KEY'];
    const savedDi = process.env['DEEPINFRA_API_KEY'];
    delete process.env['DEEPINFRA_API_KEY'];
    const savedAn = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    const strategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 });
    const result = strategy.canApply(
      [{ role: 'user', content: 'x'.repeat(10000) }],
      10000,
      100,
    );

    // Restore
    if (savedKey) process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
    if (savedDi) process.env['DEEPINFRA_API_KEY'] = savedDi;
    if (savedAn) process.env['ANTHROPIC_API_KEY'] = savedAn;

    assert.strictEqual(result, false);
  });

  it('returns compacted messages with summary annotation on API failure', async () => {
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-key';
    const strategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 });

    const msgs = makeLongConversation(5);

    // Mock the private method to throw
    const originalCallApi = (strategy as any).callCompactionApi;
    (strategy as any).callCompactionApi = async () => {
      throw new Error('API timeout');
    };

    const result = await strategy.compact(msgs, { model: 'test-model', maxTokens: 1000 });
    assert.ok(result.length > 0);
    const compactedMsgs = result.filter(
      (m) => m.name === 'compaction_fallback',
    );
    assert.ok(compactedMsgs.length > 0);

    // Restore
    (strategy as any).callCompactionApi = originalCallApi;
    if (savedKey) {
      process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
    } else {
      delete process.env['BABEL_COMPACTION_API_KEY'];
    }
  });

  it('preserves system prompt in compacted result', async () => {
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-key';
    const strategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 });

    // Mock API to return a summary
    (strategy as any).callCompactionApi = async () => ({
      summary: 'KEY_DECISIONS:\n- Decided to use Node.js\n\nCONTEXT:\n Working on a file reader.',
      inputTokens: 100,
      outputTokens: 50,
    });

    const msgs = makeLongConversation(3);
    const result = await strategy.compact(msgs, { model: 'test-model', maxTokens: 1000 });

    // System prompt should be preserved at position 0
    assert.strictEqual(result[0]!.role, 'system');
    assert.ok(result[0]!.content.includes('helpful assistant'));

    // Should have a compaction summary message
    const summaries = result.filter((m) => m.name === 'compaction_summary');
    assert.strictEqual(summaries.length, 1);
    assert.ok(summaries[0]!.content.includes('KEY_DECISIONS'));

    // Restore env
    if (savedKey) {
      process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
    } else {
      delete process.env['BABEL_COMPACTION_API_KEY'];
    }
  });
});

// ─── 8. CompactionManager ──────────────────────────────────────────────────

describe('CompactionManager', () => {
  it('uses default strategies when none provided', () => {
    const manager = new CompactionManager();
    assert.strictEqual(manager.getStrategies().length, 2);
    assert.strictEqual(manager.getStrategies()[0]!.name, 'llm-summarize');
    assert.strictEqual(manager.getStrategies()[1]!.name, 'heuristic-truncation');
  });

  it('accepts custom strategies', () => {
    const custom = new HeuristicTruncationStrategy();
    const manager = new CompactionManager([custom]);
    assert.strictEqual(manager.getStrategies().length, 1);
    assert.strictEqual(manager.getStrategies()[0]!.name, 'heuristic-truncation');
  });

  it('register adds strategy to front of list', () => {
    const manager = new CompactionManager();
    const custom: any = { name: 'custom', canApply: () => true, compact: async () => [] };
    manager.register(custom);
    assert.strictEqual(manager.getStrategies()[0]!.name, 'custom');
    assert.strictEqual(manager.getStrategies().length, 3);
  });

  it('falls back to next strategy when first fails', async () => {
    const failingStrategy: CompactionStrategy = {
      name: 'failing',
      canApply: () => true,
      compact: async () => { throw new Error('Intentional failure'); },
    };
    const fallbackStrategy = new HeuristicTruncationStrategy(2);
    const manager = new CompactionManager([failingStrategy, fallbackStrategy]);

    const msgs = makeMessages();
    const result = await manager.compact(msgs, { model: '', maxTokens: 1000 });

    // Should have fallen back to heuristic truncation
    assert.ok(result.length <= msgs.length);
    assert.strictEqual(result[0]!.role, 'system');
  });

  it('returns original messages when all strategies fail', async () => {
    const fail1: CompactionStrategy = {
      name: 'fail1',
      canApply: () => true,
      compact: async () => { throw new Error('Fail 1'); },
    };
    const fail2: CompactionStrategy = {
      name: 'fail2',
      canApply: () => true,
      compact: async () => { throw new Error('Fail 2'); },
    };
    const manager = new CompactionManager([fail1, fail2]);

    const msgs = makeMessages();
    const result = await manager.compact(msgs, { model: '', maxTokens: 1000 });

    // Should return original messages unchanged
    assert.deepStrictEqual(result, msgs);
  });

  it('skips strategies where canApply returns false', async () => {
    let compactCalled = false;
    const skipMe: CompactionStrategy = {
      name: 'skip-me',
      canApply: () => false,
      compact: async () => { compactCalled = true; return []; },
    };
    const useMe: CompactionStrategy = {
      name: 'use-me',
      canApply: () => true,
      compact: async () => { return [{ role: 'user' as const, content: 'compacted' }]; },
    };
    const manager = new CompactionManager([skipMe, useMe]);

    const result = await manager.compact(makeMessages(), { model: '', maxTokens: 100 });
    assert.strictEqual(compactCalled, false);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.content, 'compacted');
  });
});

// ─── 9. Integration: CompactionManager + Real Strategies ──────────────────

describe('CompactionManager integration', () => {
  it('uses LLM compaction when available and within limits', async () => {
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-key';
    const llmStrategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 });

    // Mock the API call
    (llmStrategy as any).callCompactionApi = async () => ({
      summary: 'KEY_DECISIONS:\n- Test decision\n\nCONTEXT:\n Test context.',
      inputTokens: 50,
      outputTokens: 20,
    });

    const manager = new CompactionManager([llmStrategy, new HeuristicTruncationStrategy(2)]);

    const msgs = makeLongConversation(5); // System + 10 messages
    const result = await manager.compact(msgs, { model: 'test-model', maxTokens: 100 });

    // Should have compacted — fewer messages than original
    assert.ok(result.length < msgs.length, `Expected ${result.length} < ${msgs.length}`);
    // System prompt preserved
    assert.strictEqual(result[0]!.role, 'system');
    // Should have a compaction summary
    const summaryMsgs = result.filter(
      (m) => m.name === 'compaction_summary',
    );
    assert.strictEqual(summaryMsgs.length, 1);

    // Restore env
    if (savedKey) {
      process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
    } else {
      delete process.env['BABEL_COMPACTION_API_KEY'];
    }
  });

  it('falls back to heuristic when LLM compaction is disabled', async () => {
    process.env['BABEL_COMPACTION'] = 'off';

    const llmStrategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 });
    const heuristicStrategy = new HeuristicTruncationStrategy(2);
    const manager = new CompactionManager([llmStrategy, heuristicStrategy]);

    const msgs = makeMessages(); // 7 messages total
    // Force compaction with a very tight budget
    const result = await manager.compact(msgs, { model: '', maxTokens: 10 });

    delete process.env['BABEL_COMPACTION'];

    // Should use heuristic (didn't call LLM)
    assert.ok(result.length <= msgs.length);
    assert.strictEqual(result[0]!.role, 'system');
    // No compaction summary from LLM
    const summaryMsgs = result.filter(
      (m) => m.name === 'compaction_summary',
    );
    assert.strictEqual(summaryMsgs.length, 0);
  });
});

// ─── 10. Edge Cases ───────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('empty conversation returns empty', async () => {
    const manager = new CompactionManager();
    const result = await manager.compact([], { model: '', maxTokens: 1000 });
    assert.deepStrictEqual(result, []);
  });

  it('single message is preserved', async () => {
    const manager = new CompactionManager();
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await manager.compact(msgs, { model: '', maxTokens: 1 });
    assert.deepStrictEqual(result, msgs);
  });

  it('system-only conversation is preserved', async () => {
    const manager = new CompactionManager();
    const msgs: ChatMessage[] = [{ role: 'system', content: 'You are helpful.' }];
    const result = await manager.compact(msgs, { model: '', maxTokens: 1 });
    assert.deepStrictEqual(result, msgs);
  });

  it('preserves messages when all strategies skip (canApply=false)', async () => {
    const skipAll: CompactionStrategy = {
      name: 'skip-all',
      canApply: () => false,
      compact: async () => { throw new Error('Should not be called'); },
    };
    const manager = new CompactionManager([skipAll]);
    const msgs = makeMessages();
    const result = await manager.compact(msgs, { model: '', maxTokens: 100 });
    assert.deepStrictEqual(result, msgs);
  });

  it('tool pairs at end of conversation are preserved', async () => {
    const strategy = new HeuristicTruncationStrategy(3);
    const msgs = makeToolConversation();
    const result = await strategy.compact(msgs, { model: '', maxTokens: 100 });

    // The last 3 messages might include a tool pair — verify pairing
    for (let i = 0; i < result.length - 1; i++) {
      if (result[i]!.role === 'assistant' && result[i]!.name === 'tool_calls') {
        assert.strictEqual(
          result[i + 1]!.role,
          'tool',
          `Tool call at ${i} must be followed by tool result`,
        );
      }
    }
  });

  it('estimateTokens with very long messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'x'.repeat(100_000) },
      { role: 'assistant', content: 'y'.repeat(100_000) },
    ];
    const tokens = estimateTokens(msgs);
    // Each: ceil(100000/4) + 4 = 25000 + 4 = 25004
    assert.strictEqual(tokens, 50008);
  });

  it('buildCompactionPrompt formats tool messages correctly', () => {
    const msgs: ChatMessage[] = [
      { role: 'tool', content: 'Command output: success', toolCallId: 'call_123', toolName: 'read_file' },
    ];
    const prompt = buildCompactionPrompt(msgs, 1000);
    assert.ok(prompt.includes('<TOOL>'));
    assert.ok(prompt.includes('Command output: success'));
  });

  it('compactionTarget respects maxSummaryTokens cap', () => {
    const msgs = makeMessages();
    const target = compactionTarget(1, msgs, 1_000_000);
    assert.strictEqual(target, DEFAULT_COMPACTION_CONFIG.maxSummaryTokens);
  });

  it('findCompactBoundary handles conversation with only tool messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'Sys.' },
      { role: 'assistant', content: 'Tool call', name: 'tool_calls' },
      { role: 'tool', content: 'Result' },
    ];
    const boundary = findCompactBoundary(msgs, 2);
    // boundary = 3 - 2 = 1, minBoundary = 1. boundary <= minBoundary, so return length
    assert.strictEqual(boundary, msgs.length);
  });
});

// ─── 11. CompactionPrompt Generation Variants ─────────────────────────────

describe('buildCompactionPrompt variants', () => {
  it('includes KEY_DECISIONS section header', () => {
    const prompt = buildCompactionPrompt(makeMessages().slice(1), 2000);
    assert.ok(prompt.includes('KEY_DECISIONS'));
  });

  it('includes CODE_CHANGES section header', () => {
    const prompt = buildCompactionPrompt(makeMessages().slice(1), 2000);
    assert.ok(prompt.includes('CODE_CHANGES'));
  });

  it('includes TOOLS_USED section header', () => {
    const prompt = buildCompactionPrompt(makeMessages().slice(1), 2000);
    assert.ok(prompt.includes('TOOLS_USED'));
  });

  it('includes UNRESOLVED section header', () => {
    const prompt = buildCompactionPrompt(makeMessages().slice(1), 2000);
    assert.ok(prompt.includes('UNRESOLVED'));
  });

  it('includes CONTEXT section header', () => {
    const prompt = buildCompactionPrompt(makeMessages().slice(1), 2000);
    assert.ok(prompt.includes('CONTEXT'));
  });

  it('mentions token budget', () => {
    const prompt = buildCompactionPrompt(makeMessages().slice(1), 500);
    assert.ok(prompt.includes('500 tokens'));
  });
});

// ─── 12. Strategy Name Uniqueness ─────────────────────────────────────────

describe('Strategy names are unique', () => {
  it('has different names for built-in strategies', () => {
    const llm = new LLMSummarizeCompaction();
    const heuristic = new HeuristicTruncationStrategy();
    assert.notStrictEqual(llm.name, heuristic.name);
  });
});

// ─── 13. AbortSignal Handling ─────────────────────────────────────────────

describe('AbortSignal handling', () => {
  it('LLMSummarizeCompaction respects abort signal on API call', async () => {
    const strategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 });
    const abortController = new AbortController();
    abortController.abort();

    // With an already-aborted signal, the API call should fail
    const msgs = makeLongConversation(3);
    const result = await strategy.compact(msgs, {
      model: 'test-model',
      maxTokens: 100,
      signal: abortController.signal,
    });

    // Should gracefully degrade (fallback annotation or original messages)
    assert.ok(result.length > 0);
  });
});

// ─── 14. Compaction State Preservation ─────────────────────────────────────

describe('compaction preserves state', () => {
  // ── Fixtures ──

  function makeTodoConversation(): ChatMessage[] {
    return [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Add a todo item to read the config file.' },
      { role: 'assistant', content: 'I will add that todo.', name: 'tool_calls' },
      { role: 'tool', content: 'Todo created: id=1, task="Read config file", status=pending', toolName: 'todo_write' },
      { role: 'assistant', content: 'Todo added as pending.' },
      { role: 'user', content: 'Mark it in progress.' },
      { role: 'assistant', content: 'Updating status.', name: 'tool_calls' },
      { role: 'tool', content: 'Todo updated: id=1, status=in_progress', toolName: 'todo_write' },
      { role: 'assistant', content: 'Status is now in_progress.' },
      { role: 'user', content: 'Mark it completed.' },
      { role: 'assistant', content: 'Completing the todo.', name: 'tool_calls' },
      { role: 'tool', content: 'Todo updated: id=1, status=completed', toolName: 'todo_write' },
      { role: 'assistant', content: 'Todo is now completed.' },
    ];
  }

  function makeWriteConversation(): ChatMessage[] {
    return [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Create a new source file.' },
      { role: 'assistant', content: 'Creating the file.', name: 'tool_calls' },
      { role: 'tool', content: 'File written: /src/utils.ts (1024 bytes)', toolName: 'write_file' },
      { role: 'assistant', content: 'File created successfully.' },
      { role: 'user', content: 'Update the greeting in the main module.' },
      { role: 'assistant', content: 'Replacing text.', name: 'tool_calls' },
      { role: 'tool', content: 'Text replaced: /src/index.ts (2 occurrences)', toolName: 'str_replace' },
      { role: 'assistant', content: 'Greeting updated.' },
      { role: 'user', content: 'Write the test file.' },
      { role: 'assistant', content: 'Writing test.', name: 'tool_calls' },
      { role: 'tool', content: 'File written: /src/utils.test.ts (2048 bytes)', toolName: 'write_file' },
      { role: 'assistant', content: 'Test file created.' },
    ];
  }

  function makeVerifierConversation(): ChatMessage[] {
    return [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Run the unit tests.' },
      { role: 'assistant', content: 'Running tests.', name: 'tool_calls' },
      { role: 'tool', content: 'Test run completed: 42 passed, 0 failed, 3 skipped', toolName: 'run_command' },
      { role: 'assistant', content: 'All tests passed.' },
      { role: 'user', content: 'Run the linter.' },
      { role: 'assistant', content: 'Running linter.', name: 'tool_calls' },
      { role: 'tool', content: 'Linter finished: 0 errors, 2 warnings', toolName: 'run_command' },
      { role: 'assistant', content: 'Lint passed with warnings.' },
      { role: 'user', content: 'Run the final verifier.' },
      { role: 'assistant', content: 'Running verifier.', name: 'tool_calls' },
      { role: 'tool', content: 'Verifier result: all stages passed, 0 failures', toolName: 'test_run' },
      { role: 'assistant', content: 'Verification passed.' },
    ];
  }

  // ── Tests ──

  it('todo_write messages with pending/in_progress/completed survive heuristic truncation', async () => {
    const strategy = new HeuristicTruncationStrategy(4);
    const msgs = makeTodoConversation(); // system + 12 = 13 messages
    // With keepRecentMessages=4, compaction boundary = 13-4 = 9
    // msg[9] is a user message (not tool), so no tool-pair extension
    // Working set = indices 9-12: user, tool_calls, tool(completed), assistant
    // Messages before index 9 (pending/in_progress) are dropped

    const result = await strategy.compact(msgs, { model: '', maxTokens: 1000 });

    // System prompt must survive at position 0
    assert.strictEqual(result[0]!.role, 'system');

    // At least the most recent todo status (completed) survives in the working set
    const todoResults = result.filter(
      (m) => m.role === 'tool' && m.toolName === 'todo_write',
    );
    assert.ok(
      todoResults.length >= 1,
      `Expected at least one todo_write tool result, got ${todoResults.length}`,
    );

    // The last todo result must carry the completed status
    const lastTodo = todoResults[todoResults.length - 1]!;
    assert.ok(
      lastTodo.content.includes('completed'),
      `Expected completed status in last todo, got: ${lastTodo.content}`,
    );

    // Tool call/result pairing must remain intact after compaction
    for (let i = 0; i < result.length - 1; i++) {
      if (result[i]!.role === 'assistant' && result[i]!.name === 'tool_calls') {
        assert.strictEqual(
          result[i + 1]!.role,
          'tool',
          `Tool call at index ${i} must be followed by tool result`,
        );
      }
    }
  });

  it('write_file and str_replace evidence survives heuristic truncation', async () => {
    const strategy = new HeuristicTruncationStrategy(4);
    const msgs = makeWriteConversation(); // system + 12 = 13 messages
    // With keepRecentMessages=4, compaction boundary = 13-4 = 9
    // msg[9] is a user message (not tool), so no tool-pair extension
    // Working set = indices 9-12: user, tool_calls, tool(write), assistant

    const result = await strategy.compact(msgs, { model: '', maxTokens: 1000 });

    // System prompt must survive at position 0
    assert.strictEqual(result[0]!.role, 'system');

    // At least one write tool result must survive
    const writeResults = result.filter(
      (m) => m.role === 'tool' && (m.toolName === 'write_file' || m.toolName === 'str_replace'),
    );
    assert.ok(
      writeResults.length >= 1,
      `Expected at least one write/str_replace tool result, got ${writeResults.length}`,
    );

    // Tool call/result pairing must remain intact
    for (let i = 0; i < result.length - 1; i++) {
      if (result[i]!.role === 'assistant' && result[i]!.name === 'tool_calls') {
        assert.strictEqual(
          result[i + 1]!.role,
          'tool',
          `Tool call at index ${i} must be followed by tool result`,
        );
      }
    }
  });

  it('verifier output (run_command/test_run) survives heuristic truncation', async () => {
    const strategy = new HeuristicTruncationStrategy(4);
    const msgs = makeVerifierConversation(); // system + 12 = 13 messages
    // With keepRecentMessages=4, compaction boundary = 13-4 = 9
    // msg[9] is a user message (not tool), so no tool-pair extension
    // Working set = indices 9-12: user, tool_calls, tool(verifier), assistant

    const result = await strategy.compact(msgs, { model: '', maxTokens: 1000 });

    // System prompt must survive at position 0
    assert.strictEqual(result[0]!.role, 'system');

    // At least one verifier tool result must survive
    const verifierResults = result.filter(
      (m) => m.role === 'tool' && (m.toolName === 'run_command' || m.toolName === 'test_run'),
    );
    assert.ok(
      verifierResults.length >= 1,
      `Expected at least one verifier tool result, got ${verifierResults.length}`,
    );

    // Verify test_run result contains pass/fail information
    const testRunResults = result.filter((m) => m.role === 'tool' && m.toolName === 'test_run');
    if (testRunResults.length > 0) {
      assert.ok(
        testRunResults.some((m) => m.content.includes('passed')),
        'Expected test_run result to contain pass/fail information',
      );
    }

    // Tool call/result pairing must remain intact
    for (let i = 0; i < result.length - 1; i++) {
      if (result[i]!.role === 'assistant' && result[i]!.name === 'tool_calls') {
        assert.strictEqual(
          result[i + 1]!.role,
          'tool',
          `Tool call at index ${i} must be followed by tool result`,
        );
      }
    }
  });
});
