/**
 * H1 compaction commit + integrity exit-gate fixtures.
 * Drives shipped commitCompaction / CompactionManager / rebuild paths.
 */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  CompactionManager,
  HeuristicTruncationStrategy,
  LLMSummarizeCompaction,
  estimateTokens,
  resolveCompactionModelId,
  type ChatMessage,
  type CompactionStrategy,
} from './chatCompaction.js';
import {
  assembleCompactedConversation,
  buildDurableCapsuleContent,
  commitCompaction,
  measureCriticalFactRetention,
  strategyToCompactMode,
  collectPreservedToolCallIds,
  buildRawObservationRefs,
} from './compactionCommit.js';
import {
  createThreadEventLog,
  rebuildProviderMessagesFromEvents,
  startTurn,
} from './threadEventLog.js';
import { createSessionEventLog } from './sessionEvents.js';
import {
  buildContextBudgetSnapshot,
  buildCompactionCapsule,
  formatCompactionCapsule,
} from './providerCapabilities.js';

function longConversation(n: number, critical?: string[]): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful coding assistant.' },
  ];
  for (let i = 0; i < n; i++) {
    const fact =
      critical && critical[i % critical.length]
        ? critical[i % critical.length]!
        : `turn-${i}`;
    msgs.push({ role: 'user', content: `User message ${i}: remember ${fact}` });
    msgs.push({
      role: 'assistant',
      content: `Acknowledged ${fact}. Working on step ${i}.`,
    });
  }
  return msgs;
}

describe('H1 resolveCompactionModelId', () => {
  it('prefers providerModelId over family', () => {
    const id = resolveCompactionModelId({
      providerModelId: 'deepseek-chat',
      family: 'DeepSeek',
    });
    assert.strictEqual(id, 'deepseek-chat');
  });

  it('does not use bare family as model id', () => {
    const id = resolveCompactionModelId({ family: 'DeepSeek' });
    assert.notStrictEqual(id, 'DeepSeek');
    assert.ok(id.length > 0);
  });

  it('honors BABEL_COMPACTION_MODEL env', () => {
    const prev = process.env['BABEL_COMPACTION_MODEL'];
    process.env['BABEL_COMPACTION_MODEL'] = 'Qwen/Qwen3-test';
    try {
      const id = resolveCompactionModelId({
        providerModelId: 'other',
        family: 'DeepSeek',
      });
      assert.strictEqual(id, 'Qwen/Qwen3-test');
    } finally {
      if (prev === undefined) delete process.env['BABEL_COMPACTION_MODEL'];
      else process.env['BABEL_COMPACTION_MODEL'] = prev;
    }
  });
});

describe('H1 ContextBudgetSnapshot', () => {
  it('covers next-request, reserves, window, headroom', () => {
    const snap = buildContextBudgetSnapshot({
      nextRequestTokens: 10_000,
      activeWindowTokens: 8_000,
      canonicalStateTokens: 500,
      retrievedContextTokens: 200,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    });
    assert.strictEqual(snap.nextRequestTokens, 10_000);
    assert.ok(snap.systemToolReserve > 0);
    assert.strictEqual(snap.activeWindowTokens, 8_000);
    assert.strictEqual(snap.canonicalStateTokens, 500);
    assert.strictEqual(snap.retrievedContextTokens, 200);
    assert.strictEqual(snap.outputReserve, 8_192);
    assert.ok(snap.headroom >= 0);
    assert.strictEqual(snap.contextWindow, 128_000);
    assert.ok(snap.contextBudget > 0);
  });
});

describe('H1 expanded capsule', () => {
  it('includes task, acceptance, plan, paths, failures, freshness, budgets, revision, evidence, raw refs', () => {
    const c = buildCompactionCapsule({
      task: 'fix bug',
      taskAcceptanceId: 'acc-1',
      planStep: 'step-2',
      changedPaths: ['src/a.ts'],
      unresolvedFailures: ['verifier_timeout'],
      verifierFreshness: 'revision=abc',
      approvalsSummary: 'none',
      budgetsSummary: 'turns=3',
      workspaceRevision: 'abc',
      evidenceRefs: ['ev-1'],
      rawObservationRefs: ['obs:deadbeef'],
      recentToolResults: ['read src/a.ts'],
    });
    const text = formatCompactionCapsule(c);
    assert.ok(text.includes('TaskAcceptanceId: acc-1'));
    assert.ok(text.includes('PlanStep: step-2'));
    assert.ok(text.includes('src/a.ts'));
    assert.ok(text.includes('verifier_timeout'));
    assert.ok(text.includes('VerifierFreshness: revision=abc'));
    assert.ok(text.includes('Budgets: turns=3'));
    assert.ok(text.includes('WorkspaceRevision: abc'));
    assert.ok(text.includes('ev-1'));
    assert.ok(text.includes('obs:deadbeef'));
  });
});

describe('H1 assembleCompactedConversation preserves LLM summary', () => {
  it('keeps compaction_summary alongside capsule (D1 fix)', () => {
    const strategyMessages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'system',
        content: 'SUMMARY: use Node.js fs.promises',
        name: 'compaction_summary',
      },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'ok' },
    ];
    // Pre-H1 bug path: slice(0,1) system only + capsule dropped the summary.
    const assembled = assembleCompactedConversation(
      strategyMessages,
      '# capsule\nTask: t',
    );
    const summaries = assembled.filter((m) => m.name === 'compaction_summary');
    const capsules = assembled.filter((m) => m.name === 'compaction_capsule');
    assert.strictEqual(summaries.length, 1);
    assert.ok(summaries[0]!.content.includes('Node.js'));
    assert.strictEqual(capsules.length, 1);
    assert.strictEqual(assembled[0]!.role, 'system');
    assert.ok(!assembled[0]!.name || assembled[0]!.name !== 'compaction_summary');
  });
});

describe('H1 CompactionManager structured result + heuristic fallback', () => {
  it('labels strategy from the strategy that actually ran (D4 fix)', async () => {
    const heuristic = new HeuristicTruncationStrategy(2);
    const manager = new CompactionManager([heuristic]);
    const msgs = longConversation(8);
    const result = await manager.compactWithResult(msgs, {
      model: 'test',
      maxTokens: 50,
    });
    assert.strictEqual(result.strategy, 'heuristic-truncation');
    assert.notStrictEqual(result.strategy, 'llm-summarize');
    assert.ok(result.tokensBefore >= result.tokensAfter || !result.changed);
  });

  it('on LLM throw advances to heuristic without destructive loss (D2 fix)', async () => {
    const llm = new LLMSummarizeCompaction({ keepRecentMessages: 2 });
    (llm as any).callCompactionApi = async () => {
      throw new Error('simulated LLM failure');
    };
    // Force canApply true
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-key';
    try {
      const heuristic = new HeuristicTruncationStrategy(2);
      const manager = new CompactionManager([llm, heuristic]);
      const msgs = longConversation(10);
      const before = estimateTokens(msgs);
      const result = await manager.compactWithResult(msgs, {
        model: 'provider-model-id',
        maxTokens: 100,
      });
      assert.strictEqual(result.strategy, 'heuristic-truncation');
      assert.ok(result.strategyErrors.some((e) => e.includes('llm-summarize')));
      // No compaction_fallback annotation path
      assert.ok(!result.messages.some((m) => m.name === 'compaction_fallback'));
      // System prompt preserved
      assert.strictEqual(result.messages[0]?.role, 'system');
      assert.ok(result.messages[0]?.content.includes('helpful'));
      assert.ok(result.tokensAfter <= before);
    } finally {
      if (savedKey) process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
      else delete process.env['BABEL_COMPACTION_API_KEY'];
    }
  });

  it('successful LLM summary is present in manager messages', async () => {
    const llm = new LLMSummarizeCompaction({ keepRecentMessages: 2 });
    (llm as any).callCompactionApi = async () => ({
      summary: 'KEY_FACT: use_workspace_revision_xyz',
      inputTokens: 200,
      outputTokens: 40,
    });
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-key';
    try {
      const manager = new CompactionManager([llm, new HeuristicTruncationStrategy(2)]);
      const msgs = longConversation(6);
      const result = await manager.compactWithResult(msgs, {
        model: 'provider-model-id',
        maxTokens: 100,
      });
      assert.strictEqual(result.strategy, 'llm-summarize');
      const summaries = result.messages.filter((m) => m.name === 'compaction_summary');
      assert.strictEqual(summaries.length, 1);
      assert.ok(summaries[0]!.content.includes('use_workspace_revision_xyz'));
    } finally {
      if (savedKey) process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
      else delete process.env['BABEL_COMPACTION_API_KEY'];
    }
  });
});

describe('H1 commitCompaction dual-write + resume equivalence', () => {
  it('writes thread capsule + session compaction_created; live≡rebuild', async () => {
    const prior = longConversation(6, ['SECRET_FACT_ALPHA']);
    const llm = new LLMSummarizeCompaction({ keepRecentMessages: 2 });
    (llm as any).callCompactionApi = async () => ({
      summary: 'CRITICAL: SECRET_FACT_ALPHA must be retained',
      inputTokens: 100,
      outputTokens: 20,
    });
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-key';
    try {
      const manager = new CompactionManager([llm, new HeuristicTruncationStrategy(2)]);
      const mgr = await manager.compactWithResult(prior, {
        model: 'deepseek-chat',
        maxTokens: 80,
      });
      assert.ok(mgr.changed);

      const threadLog = createThreadEventLog('thread-h1');
      const sessionLog = createSessionEventLog('thread-h1');
      startTurn(threadLog, {
        task: 'retain facts',
        model: 'deepseek-chat',
        provider: 'deepseek',
        projectRoot: '/tmp/proj',
        policyPreset: 'chat',
      });
      const turnId = threadLog.events.find((e) => e.kind === 'turn_started')!.turn_id;

      const commit = await commitCompaction({
        strategyMessages: mgr.messages,
        priorConversation: prior,
        strategy: mgr.strategy,
        tokensBefore: mgr.tokensBefore,
        tokensAfter: mgr.tokensAfter,
        operational: {
          task: 'retain facts',
          taskAcceptanceId: 'acc-h1',
          planStep: 's1',
          workspaceRevision: 'rev-1',
          evidenceRefs: ['pre-ev'],
        },
        threadLog,
        sessionLog,
        turnId,
        modelId: 'deepseek-chat',
      });

      assert.strictEqual(commit.status, 'committed');
      // Summary survives into conversation (next provider request material)
      assert.ok(
        commit.conversation.some(
          (m) =>
            m.name === 'compaction_summary' &&
            m.content.includes('SECRET_FACT_ALPHA'),
        ),
      );
      // Thread event written
      const capsules = threadLog.events.filter((e) => e.kind === 'compaction_capsule');
      assert.strictEqual(capsules.length, 1);
      assert.ok(
        (capsules[0] as { content: string }).content.includes('SECRET_FACT_ALPHA'),
      );
      // Session event written
      const sess = sessionLog.events.filter((e) => e.kind === 'compaction_created');
      assert.strictEqual(sess.length, 1);

      // Live conversation vs cold-resume rebuild equivalence on capsule+summary content
      const rebuilt = rebuildProviderMessagesFromEvents(threadLog, {
        systemPrompt: 'You are a helpful coding assistant.',
      });
      const liveCapsule = commit.conversation.find((m) => m.name === 'compaction_capsule');
      const rebuildCapsule = rebuilt.find((m) => m.name === 'compaction_capsule');
      assert.ok(liveCapsule);
      assert.ok(rebuildCapsule);
      assert.strictEqual(liveCapsule!.content, rebuildCapsule!.content);
      assert.ok(rebuildCapsule!.content.includes('SECRET_FACT_ALPHA'));
    } finally {
      if (savedKey) process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
      else delete process.env['BABEL_COMPACTION_API_KEY'];
    }
  });

  it('persistence failure yields degraded status, not silent success', async () => {
    const prior = longConversation(4);
    const strategyMessages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ];
    const threadLog = createThreadEventLog();
    const sessionLog = createSessionEventLog();
    const commit = await commitCompaction({
      strategyMessages,
      priorConversation: prior,
      strategy: 'heuristic-truncation',
      tokensBefore: 1000,
      tokensAfter: 100,
      operational: { task: 't' },
      threadLog,
      sessionLog,
      turnId: 't1',
      modelId: 'm',
      persist: () => {
        throw new Error('disk full');
      },
    });
    assert.strictEqual(commit.status, 'degraded_persistence');
    assert.ok(commit.error?.includes('disk full'));
  });

  it('blocked_persistence when blockOnPersistFailure is set', async () => {
    const strategyMessages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
    ];
    const commit = await commitCompaction({
      strategyMessages,
      priorConversation: strategyMessages,
      strategy: 'heuristic-truncation',
      tokensBefore: 100,
      tokensAfter: 50,
      operational: { task: 't' },
      threadLog: createThreadEventLog(),
      sessionLog: createSessionEventLog(),
      turnId: 't1',
      modelId: 'm',
      blockOnPersistFailure: true,
      persist: () => false,
    });
    assert.strictEqual(commit.status, 'blocked_persistence');
  });

  it('repeated commits use only the latest authoritative capsule on rebuild', async () => {
    const threadLog = createThreadEventLog('rep');
    const sessionLog = createSessionEventLog('rep');
    startTurn(threadLog, {
      task: 't',
      model: 'm',
      provider: 'p',
      projectRoot: '/',
      policyPreset: 'chat',
    });
    const turnId = threadLog.events.find((e) => e.kind === 'turn_started')!.turn_id;

    const c1 = await commitCompaction({
      strategyMessages: [
        { role: 'system', content: 'sys' },
        {
          role: 'system',
          content: 'summary-v1',
          name: 'compaction_summary',
        },
        { role: 'user', content: 'after1' },
      ],
      priorConversation: longConversation(3),
      strategy: 'llm-summarize',
      tokensBefore: 500,
      tokensAfter: 100,
      operational: { task: 't', planStep: 'v1' },
      threadLog,
      sessionLog,
      turnId,
      modelId: 'm',
    });
    assert.strictEqual(c1.status, 'committed');

    const c2 = await commitCompaction({
      strategyMessages: [
        { role: 'system', content: 'sys' },
        {
          role: 'system',
          content: 'summary-v2-LATEST',
          name: 'compaction_summary',
        },
        { role: 'user', content: 'after2' },
      ],
      priorConversation: c1.conversation,
      strategy: 'llm-summarize',
      tokensBefore: 200,
      tokensAfter: 80,
      operational: { task: 't', planStep: 'v2' },
      threadLog,
      sessionLog,
      turnId,
      modelId: 'm',
    });
    assert.strictEqual(c2.status, 'committed');

    const rebuilt = rebuildProviderMessagesFromEvents(threadLog, {
      systemPrompt: 'sys',
    });
    const capsule = rebuilt.find((m) => m.name === 'compaction_capsule');
    assert.ok(capsule);
    assert.ok(capsule!.content.includes('summary-v2-LATEST'));
    assert.ok(!capsule!.content.includes('summary-v1'));
  });
});

describe('H1 tool pairing + observation reduction + long-session metrics', () => {
  it('preserves tool call/result ids in working set', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: 'Using tools',
        name: 'tool_calls',
      },
      {
        role: 'tool',
        content: 'file contents',
        toolCallId: 'call_abc',
        toolName: 'read_file',
      },
      { role: 'user', content: 'thanks' },
    ];
    const assembled = assembleCompactedConversation(msgs, '# capsule');
    const ids = collectPreservedToolCallIds(assembled);
    assert.deepStrictEqual(ids, ['call_abc']);
  });

  it('builds immutable raw observation refs for dropped messages', () => {
    const prior = longConversation(5);
    const after = [prior[0]!, prior[prior.length - 2]!, prior[prior.length - 1]!];
    const refs = buildRawObservationRefs(prior, after);
    assert.ok(refs.length > 0);
    assert.ok(refs.every((r) => r.startsWith('obs:')));
  });

  it('measures critical-fact retention and token reduction on long session', async () => {
    const facts = [
      'FACT_ALPHA_42',
      'FACT_BETA_99',
      'FACT_GAMMA_7',
    ];
    const prior = longConversation(20, facts);
    const tokensBefore = estimateTokens(prior);

    const llm = new LLMSummarizeCompaction({ keepRecentMessages: 4 });
    (llm as any).callCompactionApi = async () => ({
      summary: `Preserved facts: ${facts.join(', ')}`,
      inputTokens: tokensBefore,
      outputTokens: 80,
    });
    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-key';
    try {
      const manager = new CompactionManager([
        llm,
        new HeuristicTruncationStrategy(4),
      ]);
      const mgr = await manager.compactWithResult(prior, {
        model: 'm',
        maxTokens: 200,
      });
      const commit = await commitCompaction({
        strategyMessages: mgr.messages,
        priorConversation: prior,
        strategy: mgr.strategy,
        tokensBefore: mgr.tokensBefore,
        tokensAfter: mgr.tokensAfter,
        operational: { task: 'long-session' },
        threadLog: createThreadEventLog(),
        sessionLog: createSessionEventLog(),
        turnId: 't',
        modelId: 'm',
      });
      const text = commit.conversation.map((m) => m.content).join('\n');
      const retention = measureCriticalFactRetention(text, facts);
      assert.strictEqual(retention.retained, facts.length);
      assert.strictEqual(retention.rate, 1);
      assert.ok(
        commit.tokensAfter < tokensBefore,
        `expected token reduction ${commit.tokensAfter} < ${tokensBefore}`,
      );
      assert.strictEqual(strategyToCompactMode(commit.strategy), 'llm');
    } finally {
      if (savedKey) process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
      else delete process.env['BABEL_COMPACTION_API_KEY'];
    }
  });
});

describe('H1 durable capsule content helper', () => {
  it('embeds summary for rebuild path', () => {
    const content = buildDurableCapsuleContent('# cap', 'my summary body');
    assert.ok(content.includes('# cap'));
    assert.ok(content.includes('my summary body'));
    assert.ok(content.includes('compaction_summary'));
  });
});
