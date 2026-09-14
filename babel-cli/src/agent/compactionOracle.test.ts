/**
 * Canary C: Compaction Oracle
 *
 * Places unique requirements/diagnostic facts only in data that must survive
 * the retained tail (excluded from old summary), forces compaction 1, executes
 * more work, forces compaction 2, simulates turn retry, and cold resume.
 * Verifies exact survival and protocol fidelity in the actual next provider request.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CompactionManager,
  LLMSummarizeCompaction,
  type ChatMessage,
} from './chatCompaction.js';
import {
  commitCompaction,
} from './compactionCommit.js';
import {
  createThreadEventLog,
  startTurn,
  recordAssistantToolCalls,
  recordToolResult,
  recordAssistantMessage,
  rebuildProviderMessagesFromEvents,
  serializeThreadEventLog,
  parseThreadEventLog,
} from './threadEventLog.js';
import { createSessionEventLog } from './sessionEvents.js';
import {
  mapProviderMessagesToWire,
  validateProviderMessageProtocol,
} from '../runners/providerMessages.js';

describe('Canary C: Compaction Oracle', () => {
  it('preserves unique diagnostic facts only in retained tail across compaction 1, more work, compaction 2, retry, and resume', async () => {
    // 1. Setup initial thread and session log
    const threadLog = createThreadEventLog('canary-c-thread');
    const sessionLog = createSessionEventLog('canary-c-thread');

    const turnId1 = startTurn(threadLog, {
      task: 'Initial task: set up environment',
      model: 'deepseek-chat',
      provider: 'deepseek',
      projectRoot: '/tmp/canary_c',
      policyPreset: 'chat',
    });

    // Create old conversation turns (turns 1..4)
    const conversation: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful coding assistant.' },
      { role: 'user', content: 'Initial message turn 1' },
      { role: 'assistant', content: 'Understood, setting up turn 1' },
      { role: 'user', content: 'Initial message turn 2' },
      { role: 'assistant', content: 'Understood, setting up turn 2' },
    ];

    // Record turn 1-2 events into threadLog
    recordAssistantMessage(threadLog, turnId1, 'Understood, setting up turn 1');
    recordAssistantMessage(threadLog, turnId1, 'Understood, setting up turn 2');

    // Turn 5 (working set / retained tail):
    // Place unique requirements and diagnostic facts ONLY in the retained tail!
    const NONCE_TAIL_1 = 'ORACLE_NONCE_TAIL_ALPHA_98765';
    const REQ_TAIL_1 = 'REQUIREMENT_TAIL_ALPHA_MUST_SURVIVE';
    const toolCall1 = {
      id: 'tool_call_tail_1',
      type: 'function' as const,
      function: { name: 'read_diagnostic', arguments: '{"target":"oracle_tail_1"}' },
    };

    recordAssistantToolCalls(threadLog, turnId1, 'Inspecting diagnostic tail', [toolCall1]);
    recordToolResult(threadLog, turnId1, {
      tool_call_id: 'tool_call_tail_1',
      tool_name: 'read_diagnostic',
      content: `Diagnostic output: nonce=${NONCE_TAIL_1}`,
    });

    const tailUserMsg: ChatMessage = { role: 'user', content: `Active instruction: verify ${REQ_TAIL_1}` };
    const tailAssistantMsg: ChatMessage = {
      role: 'assistant',
      content: 'Using tools…',
      name: 'tool_calls',
    };
    (tailAssistantMsg as any).tool_calls = [toolCall1];
    const tailToolMsg: ChatMessage = {
      role: 'tool',
      content: `Diagnostic output: nonce=${NONCE_TAIL_1}`,
      toolCallId: 'tool_call_tail_1',
      toolName: 'read_diagnostic',
    };

    conversation.push(tailUserMsg, tailAssistantMsg, tailToolMsg);

    // Mock summarizer that summarizes old prefix (turns 1-4) EXCLUDING the retained tail
    const llm1 = new LLMSummarizeCompaction({ keepRecentMessages: 3 });
    (llm1 as any).callCompactionApi = async () => ({
      summary: 'OLD_PREFIX_SUMMARY: setup turns 1-4 completed successfully. No tail facts here.',
      inputTokens: 300,
      outputTokens: 50,
    });

    const savedKey = process.env['BABEL_COMPACTION_API_KEY'];
    const savedBase = process.env['BABEL_COMPACTION_API_BASE'];
    process.env['BABEL_COMPACTION_API_KEY'] = 'test-oracle-key';
    process.env['BABEL_COMPACTION_API_BASE'] = 'https://api.deepseek.com/v1';

    try {
      const manager1 = new CompactionManager([llm1]);
      const mgrResult1 = await manager1.compactWithResult(conversation, {
        model: 'deepseek-chat',
        maxTokens: 60,
      });

      assert.strictEqual(mgrResult1.changed, true);
      // Ensure the old summary does NOT contain the unique nonce or requirement
      const summaryMsg1 = mgrResult1.messages.find((m) => m.name === 'compaction_summary');
      assert.ok(summaryMsg1);
      assert.ok(!summaryMsg1.content.includes(NONCE_TAIL_1));
      assert.ok(!summaryMsg1.content.includes(REQ_TAIL_1));

      // Force Compaction 1
      const commit1 = await commitCompaction({
        strategyMessages: mgrResult1.messages,
        priorConversation: conversation,
        strategy: mgrResult1.strategy,
        tokensBefore: mgrResult1.tokensBefore,
        tokensAfter: mgrResult1.tokensAfter,
        operational: {
          task: 'oracle verification task',
          planStep: 'step-compaction-1',
          evidenceRefs: ['ev-oracle-1'],
        },
        threadLog,
        sessionLog,
        turnId: turnId1,
        modelId: 'deepseek-chat',
      });

      assert.strictEqual(commit1.status, 'committed');

      // Check exact survival in the actual next provider request after Compaction 1
      const rebuilt1 = rebuildProviderMessagesFromEvents(threadLog, {
        systemPrompt: 'You are a helpful coding assistant.',
      });
      assert.deepEqual(validateProviderMessageProtocol(rebuilt1), []);

      const wire1 = mapProviderMessagesToWire(rebuilt1, 'You are a helpful coding assistant.');
      assert.ok(
        wire1.some((m) => m.content.includes(NONCE_TAIL_1)),
        'NONCE_TAIL_1 must survive in outbound provider wire payload after compaction 1',
      );
      assert.ok(
        wire1.some((m) => m.content.includes(REQ_TAIL_1)),
        'REQ_TAIL_1 must survive in outbound provider wire payload after compaction 1',
      );
      assert.ok(
        wire1.some((m) => m.tool_call_id === 'tool_call_tail_1'),
        'tool_call_tail_1 must survive in outbound provider wire payload after compaction 1',
      );

      // 3. More work!
      const turnId2 = startTurn(threadLog, {
        task: 'Second phase: execute mutation',
        model: 'deepseek-chat',
        provider: 'deepseek',
        projectRoot: '/tmp/canary_c',
        policyPreset: 'chat',
      });

      const NONCE_TAIL_2 = 'ORACLE_NONCE_TAIL_BETA_67890';
      const REQ_TAIL_2 = 'REQUIREMENT_TAIL_BETA_MUST_SURVIVE';
      const toolCall2 = {
        id: 'tool_call_tail_2',
        type: 'function' as const,
        function: { name: 'write_diagnostic', arguments: '{"target":"oracle_tail_2"}' },
      };

      recordAssistantToolCalls(threadLog, turnId2, 'Applying mutation for phase 2', [toolCall2]);
      recordToolResult(threadLog, turnId2, {
        tool_call_id: 'tool_call_tail_2',
        tool_name: 'write_diagnostic',
        content: `Applied mutation successfully: nonce=${NONCE_TAIL_2}`,
      });

      // Update live conversation with Phase 2 work
      const conversation2 = [...commit1.conversation];
      const tailUserMsg2: ChatMessage = { role: 'user', content: `Second phase active requirement: ${REQ_TAIL_2}` };
      const tailAssistantMsg2: ChatMessage = {
        role: 'assistant',
        content: 'Using tools…',
        name: 'tool_calls',
      };
      (tailAssistantMsg2 as any).tool_calls = [toolCall2];
      const tailToolMsg2: ChatMessage = {
        role: 'tool',
        content: `Applied mutation successfully: nonce=${NONCE_TAIL_2}`,
        toolCallId: 'tool_call_tail_2',
        toolName: 'write_diagnostic',
      };
      conversation2.push(tailUserMsg2, tailAssistantMsg2, tailToolMsg2);

      // 4. Force Compaction 2 (Repeated compaction)
      // Summarizer for compaction 2 summarizes Phase 1 (may summarize NONCE_TAIL_1),
      // but explicitly EXCLUDES Phase 2 tail (NONCE_TAIL_2 and REQ_TAIL_2).
      const llm2 = new LLMSummarizeCompaction({ keepRecentMessages: 3 });
      (llm2 as any).callCompactionApi = async () => ({
        summary: `PHASE1_CONSOLIDATED: Alpha phase completed (${NONCE_TAIL_1}). No Beta facts here.`,
        inputTokens: 500,
        outputTokens: 60,
      });

      const manager2 = new CompactionManager([llm2]);
      const mgrResult2 = await manager2.compactWithResult(conversation2, {
        model: 'deepseek-chat',
        maxTokens: 60,
      });

      assert.strictEqual(mgrResult2.changed, true);
      const summaryMsg2 = mgrResult2.messages.find((m) => m.name === 'compaction_summary');
      assert.ok(summaryMsg2);
      assert.ok(!summaryMsg2.content.includes(NONCE_TAIL_2));
      assert.ok(!summaryMsg2.content.includes(REQ_TAIL_2));

      const commit2 = await commitCompaction({
        strategyMessages: mgrResult2.messages,
        priorConversation: conversation2,
        strategy: mgrResult2.strategy,
        tokensBefore: mgrResult2.tokensBefore,
        tokensAfter: mgrResult2.tokensAfter,
        operational: {
          task: 'oracle verification task',
          planStep: 'step-compaction-2',
          evidenceRefs: ['ev-oracle-2'],
        },
        threadLog,
        sessionLog,
        turnId: turnId2,
        modelId: 'deepseek-chat',
      });

      assert.strictEqual(commit2.status, 'committed');

      // 5. Retry: Provider retry reconstructs from durable threadLog
      const retryMessages = rebuildProviderMessagesFromEvents(threadLog, {
        systemPrompt: 'You are a helpful coding assistant.',
      });
      assert.deepEqual(validateProviderMessageProtocol(retryMessages), []);
      const retryWire = mapProviderMessagesToWire(retryMessages, 'You are a helpful coding assistant.');
      assert.ok(
        retryWire.some((m) => m.content.includes(NONCE_TAIL_2)),
        'NONCE_TAIL_2 must survive on retry',
      );
      assert.ok(
        retryWire.some((m) => m.content.includes(REQ_TAIL_2)),
        'REQ_TAIL_2 must survive on retry',
      );
      assert.ok(
        retryWire.some((m) => m.tool_call_id === 'tool_call_tail_2'),
        'tool_call_tail_2 must survive on retry',
      );

      // 6. Resume: Simulate cold restart by serializing and deserializing durable threadLog
      const serializedLog = serializeThreadEventLog(threadLog);
      const restoredLog = parseThreadEventLog(serializedLog);

      const resumedMessages = rebuildProviderMessagesFromEvents(restoredLog, {
        systemPrompt: 'You are a helpful coding assistant.',
      });
      assert.deepEqual(validateProviderMessageProtocol(resumedMessages), []);

      // 7. Check exact survival in the actual next provider request
      const nextProviderRequestWire = mapProviderMessagesToWire(
        resumedMessages,
        'You are a helpful coding assistant.',
      );

      assert.ok(
        nextProviderRequestWire.some((m) => m.content.includes(NONCE_TAIL_2)),
        'Exact survival of NONCE_TAIL_2 in resumed next provider request',
      );
      assert.ok(
        nextProviderRequestWire.some((m) => m.content.includes(REQ_TAIL_2)),
        'Exact survival of REQ_TAIL_2 in resumed next provider request',
      );
      assert.ok(
        nextProviderRequestWire.some((m) => m.tool_call_id === 'tool_call_tail_2'),
        'Exact survival of tool_call_tail_2 result in resumed next provider request',
      );
      assert.deepEqual(validateProviderMessageProtocol(nextProviderRequestWire), []);
    } finally {
      if (savedKey === undefined) delete process.env['BABEL_COMPACTION_API_KEY'];
      else process.env['BABEL_COMPACTION_API_KEY'] = savedKey;
      if (savedBase === undefined) delete process.env['BABEL_COMPACTION_API_BASE'];
      else process.env['BABEL_COMPACTION_API_BASE'] = savedBase;
    }
  });
});
