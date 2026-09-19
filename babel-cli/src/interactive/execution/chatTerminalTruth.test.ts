import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatEvent, ChatResult } from '../../agent/chatEngine.js';
import { RuntimeInvariantViolationError } from '../../agent/runtimeInvariants.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import {
  classifyChatStreamError,
  consumeChatStream,
  runChatEngineOnce,
} from './chatCore.js';
import {
  dispatchChatEvent,
  isInfrastructureErrorText,
  classifyFailureText,
} from './chatEventDispatch.js';
import { isLocalEnvironmentErrorText } from '../../agent/chatFailureClassification.js';

const EMPTY_USAGE = globalCostTracker.getSessionSummary();

function makeTarget(root: string): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

function evidenceOf(result: ChatResult) {
  return {
    status: result.status,
    outcome: result.outcome,
    toolCalls: result.toolCalls,
    runDir: result.runDir,
    turnRouting: result.turnRouting,
    verifierReceipt: result.verifierReceipt,
    blockedReport: result.blockedReport,
  };
}

describe('chatTerminalTruth (terminal cause and evidence)', () => {
  describe('missing terminal event is UNKNOWN, never CANCELLED', () => {
    it('returns failed with no outcome when the stream ends without a terminal event', async () => {
      async function* truncatedStream(): AsyncGenerator<ChatEvent, void, undefined> {
        yield { type: 'thinking' };
        yield { type: 'answer_chunk', text: 'Partial text before abrupt EOF' };
      }

      const result = await consumeChatStream(truncatedStream(), null);
      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, undefined);
      assert.notEqual(result.outcome, 'CANCELLED');
      assert.notEqual(result.outcome, 'AGENT_FAILURE');
      assert.match(result.answer, /Stream ended without a terminal event/);
    });

    it('preserves accumulated toolCalls when the stream ends without a terminal event', async () => {
      async function* truncatedStreamWithTools(): AsyncGenerator<ChatEvent, void, undefined> {
        yield { type: 'tool_start', tool: 'read_file', target: 'src/index.ts' };
        yield {
          type: 'tool_complete',
          tool: 'read_file',
          target: 'src/index.ts',
          detail: '42 lines read',
        };
      }

      const result = await consumeChatStream(truncatedStreamWithTools(), null);
      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, undefined);
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.toolCalls?.[0]?.tool, 'read_file');
    });
  });

  describe('cancelled stream event is CANCELLED with a recorded source', () => {
    it('maps type=cancelled to CANCELLED rather than missing-terminal UNKNOWN', async () => {
      async function* cancelledStream(): AsyncGenerator<ChatEvent, void, undefined> {
        yield { type: 'thinking' };
        yield { type: 'answer_chunk', text: 'partial' };
        yield { type: 'cancelled' };
      }

      const result = await consumeChatStream(cancelledStream(), null);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.outcome, 'CANCELLED');
    });
  });

  describe('exception classification matrix', () => {
    it('classifies local disk-full (ENOSPC) as BLOCKED_EXTERNAL, never provider blame, and preserves tool history', async () => {
      async function* enospcStream(): AsyncGenerator<ChatEvent, void, undefined> {
        yield { type: 'tool_start', tool: 'write_file', target: 'out.txt' };
        yield { type: 'tool_complete', tool: 'write_file', target: 'out.txt', error: 'ENOSPC' };
        const enospcErr = new Error('ENOSPC: no space left on device, write');
        (enospcErr as unknown as { code: string }).code = 'ENOSPC';
        throw enospcErr;
      }

      const result = await consumeChatStream(enospcStream(), null);
      // A full local disk is an environment failure. Attributing it to the
      // provider (INFRA_FAILURE) would invent false provider blame.
      assert.equal(result.status, 'blocked');
      assert.equal(result.outcome, 'BLOCKED_EXTERNAL');
      assert.equal(result.toolCalls?.length, 1);
    });

    it('classifies provider stream errors as INFRA_FAILURE, not AGENT_FAILURE', async () => {
      async function* providerStream(): AsyncGenerator<ChatEvent, void, undefined> {
        throw new Error('[deepSeekApi] stream closed before terminal [DONE] marker');
      }
      const result = await consumeChatStream(providerStream(), null);
      assert.equal(result.outcome, 'INFRA_FAILURE');
    });

    it('classifies RuntimeInvariantViolationError as INFRA_FAILURE', async () => {
      async function* invariantStream(): AsyncGenerator<ChatEvent, void, undefined> {
        throw new RuntimeInvariantViolationError({
          invariantId: 'provider_protocol_valid',
          message: 'Malformed shape detected',
          expectedHash: 'abc',
          actualHash: 'def',
          expectedShape: [],
          actualShape: [],
        });
      }
      const result = await consumeChatStream(invariantStream(), null);
      assert.equal(result.outcome, 'INFRA_FAILURE');
    });

    it('leaves unclassified internal errors UNKNOWN rather than AGENT_FAILURE', async () => {
      async function* unknownStream(): AsyncGenerator<ChatEvent, void, undefined> {
        throw new Error('Unexpected JSON schema validation failure');
      }
      const result = await consumeChatStream(unknownStream(), null);
      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, undefined);
      assert.notEqual(result.outcome, 'AGENT_FAILURE');
    });

    it('classifies operator abort as CANCELLED', async () => {
      async function* operatorCancelStream(): AsyncGenerator<ChatEvent, void, undefined> {
        const cancelErr = new Error('The operation was aborted');
        cancelErr.name = 'AbortError';
        throw cancelErr;
      }
      const result = await consumeChatStream(operatorCancelStream(), null);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.outcome, 'CANCELLED');
    });

    it('classifies budget exceeded as BUDGET_EXHAUSTED', async () => {
      async function* budgetStream(): AsyncGenerator<ChatEvent, void, undefined> {
        throw new Error('Total session cost budget exceeded: 10.00 limit reached');
      }
      const result = await consumeChatStream(budgetStream(), null);
      assert.equal(result.status, 'budget_exhausted');
      assert.equal(result.outcome, 'BUDGET_EXHAUSTED');
    });
  });

  describe('classifyChatStreamError helper', () => {
    it('detects operator abort from request cancelled text', () => {
      const abortErr = new Error('request cancelled');
      assert.deepEqual(classifyChatStreamError(abortErr), {
        status: 'cancelled',
        outcome: 'CANCELLED',
      });
    });

    it('separates local environment codes from network codes', () => {
      for (const code of ['ENOSPC', 'EROFS', 'EIO', 'EBUSY', 'EMFILE', 'ENFILE']) {
        const err = Object.assign(new Error('Failed with ' + code), { code });
        assert.deepEqual(
          classifyChatStreamError(err),
          { status: 'blocked', outcome: 'BLOCKED_EXTERNAL' },
          'Local code ' + code + ' is an environment failure, not provider infra',
        );
      }
      for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH']) {
        const err = Object.assign(new Error('Failed with ' + code), { code });
        assert.deepEqual(
          classifyChatStreamError(err),
          { status: 'failed', outcome: 'INFRA_FAILURE' },
          'Network code ' + code + ' should map to INFRA_FAILURE',
        );
      }
    });

    it('does not fall back to AGENT_FAILURE for general errors', () => {
      const classified = classifyChatStreamError(new Error('Uncaught syntax error in generated code'));
      assert.equal(classified.status, 'failed');
      assert.equal(classified.outcome, undefined);
    });
  });

  describe('isInfrastructureErrorText helper', () => {
    it('classifies provider output truncation as a token budget, not infrastructure', () => {
      assert.equal(classifyFailureText('Output truncated by provider token limit (finish_reason: length)'), 'BUDGET_EXHAUSTED');
      assert.equal(classifyFailureText('Incomplete tool call: truncated by provider token limit (finish_reason: length)'), 'BUDGET_EXHAUSTED');
      assert.equal(classifyFailureText('finish_reason: stop'), undefined);
      assert.equal(classifyFailureText('finish_reason: error'), 'INFRA_FAILURE');
      assert.equal(classifyFailureText('stream closed before terminal [DONE] marker'), 'INFRA_FAILURE');
      assert.equal(isInfrastructureErrorText('finish_reason: length'), false);
    });

    it('separates local environment errnos from network/provider/invariant errors', () => {
      // Local machine failures are environment, not infrastructure/provider.
      assert.equal(isInfrastructureErrorText('ENOSPC: no space left on device'), false);
      assert.ok(isLocalEnvironmentErrorText('ENOSPC: no space left on device'));
      assert.equal(isInfrastructureErrorText('EROFS: read-only file system'), false);
      assert.ok(isLocalEnvironmentErrorText('EIO: i/o error'));
      assert.ok(isInfrastructureErrorText('fetch failed: socket hang up'));
      assert.ok(isInfrastructureErrorText('[deepSeekApi] stream closed before terminal [DONE] marker'));
      assert.ok(isInfrastructureErrorText('request timeout after 50ms'));
      assert.ok(isInfrastructureErrorText('[runtime-invariant:provider_tool_protocol] violation'));
    });

    it('returns false for ordinary domain errors', () => {
      assert.equal(isInfrastructureErrorText('AssertionError: expected true but got false'), false);
      assert.equal(isInfrastructureErrorText('File not found: foo.ts'), false);
      assert.equal(isInfrastructureErrorText(''), false);
    });
  });

  describe('evidence projection on terminal dispatch', () => {
    const mockTelemetry = {
      turnId: 'turn-1',
      taskClass: 'swe',
      timing: {
        submittedAt: 0,
        startedAt: 0,
        firstTokenAt: 1,
        ttftMs: 1,
        providerDurationMs: 50,
        toolDurationMs: 10,
        verificationDurationMs: 0,
        criticDurationMs: 0,
        compactionDurationMs: 0,
        orchestrationOverheadMs: 0,
        totalWallTimeMs: 60,
      },
      counts: {
        modelInvocations: 1,
        toolCalls: 2,
        successfulToolCalls: 2,
        failedToolCalls: 0,
        repeatedToolCalls: 0,
        policyInterventions: 0,
      },
      promptTokens: 500,
      completionTokens: 80,
      cumulativeSessionTokens: 580,
    };

    it('dispatchChatEvent preserves toolCalls, runDir, telemetry on a local-environment block', () => {
      const failedEvent: ChatEvent = {
        type: 'failed',
        error: 'ENOSPC write error',
        toolCalls: [{ tool: 'execute_command', target: 'npm run build' }],
        runDir: '/tmp/runs/run-123',
        turnTelemetry: mockTelemetry,
      };
      const result = dispatchChatEvent(failedEvent, {});
      assert.ok(result);
      // Local disk failure: truthful external/environment terminal, never provider blame.
      assert.equal(result.status, 'blocked');
      assert.equal(result.outcome, 'BLOCKED_EXTERNAL');
      assert.equal(result.runDir, '/tmp/runs/run-123');
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.turnTelemetry?.turnId, 'turn-1');
    });

    it('does not invent AGENT_FAILURE for an unclassified failed event', () => {
      const result = dispatchChatEvent({ type: 'failed', error: 'something odd happened' }, {});
      assert.ok(result);
      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, undefined);
    });
  });

  describe('stream vs callback parity', () => {
    it('projects equivalent causal evidence from a completed done event and callback ChatResult', async () => {
      const toolCalls = [{ tool: 'read_file', target: 'src/a.ts', detail: 'ok' }];
      const turnRouting: ChatResult['turnRouting'] = [
        { turn: 0, phase: 'mutate', model: 'deepseek-v4-flash', input_tokens: 10, output_tokens: 4, cost_usd: 0 },
      ];
      async function* streamed(): AsyncGenerator<ChatEvent, void, undefined> {
        yield { type: 'tool_start', tool: 'read_file', target: 'src/a.ts' };
        yield { type: 'tool_complete', tool: 'read_file', target: 'src/a.ts', detail: 'ok' };
        yield {
          type: 'done',
          answer: 'patched',
          usage: EMPTY_USAGE,
          outcome: 'UNVERIFIED_PATCH',
          toolCalls,
          runDir: '/tmp/runs/parity',
          ...(turnRouting ? { turnRouting } : {}),
          verifierReceipt: { command: 'npm test', exit_code: 0, summary: 'pass' },
        };
      }

      const streamResult = await consumeChatStream(streamed(), null);
      const callbackResult: ChatResult = {
        status: 'completed',
        outcome: 'UNVERIFIED_PATCH',
        answer: 'patched',
        usage: EMPTY_USAGE,
        conversation: [],
        toolCalls,
        runDir: '/tmp/runs/parity',
        turnRouting,
        verifierReceipt: { command: 'npm test', exit_code: 0, summary: 'pass' },
      };

      assert.deepEqual(evidenceOf(streamResult), evidenceOf(callbackResult));
      assert.equal(streamResult.answer, callbackResult.answer);
    });
  });

  describe('unconditional protocol finalization', () => {
    it('runs persistence and finalization even when the turn fails', async () => {
      const mockEngine = {
        submitMessage: async () => ({
          status: 'failed' as const,
          answer: 'Task failed during execution',
          usage: EMPTY_USAGE,
          conversation: [],
        }),
        submitMessageStream: async function* () {
          yield { type: 'failed' as const, error: 'Task failed during execution' };
        },
        cancel: () => {},
      };

      const result = await runChatEngineOnce({
        task: 'failing task',
        target: makeTarget('/tmp/project'),
        engineFactory: () => mockEngine as unknown as import('../../agent/chatEngine.js').ChatEngine,
        useStreaming: false,
        preflightContext: '',
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.answer, 'Task failed during execution');
    });

    it('runs persistence and finalization when the turn is cancelled', async () => {
      const mockEngine = {
        submitMessage: async () => ({
          status: 'cancelled' as const,
          outcome: 'CANCELLED' as const,
          answer: 'Cancelled',
          usage: EMPTY_USAGE,
          conversation: [],
        }),
        submitMessageStream: async function* () {
          yield { type: 'cancelled' as const };
        },
        cancel: () => {},
      };

      const result = await runChatEngineOnce({
        task: 'cancelled task',
        target: makeTarget('/tmp/project'),
        engineFactory: () => mockEngine as unknown as import('../../agent/chatEngine.js').ChatEngine,
        useStreaming: true,
        preflightContext: '',
      });
      assert.equal(result.status, 'cancelled');
      assert.equal(result.outcome, 'CANCELLED');
    });
  });
});
