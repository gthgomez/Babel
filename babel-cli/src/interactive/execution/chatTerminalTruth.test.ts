import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatEvent } from '../../agent/chatEngine.js';
import { globalCostTracker } from '../../services/costTracker.js';
import {
  classifyChatStreamError,
  consumeChatStream,
  runChatEngineOnce,
} from './chatCore.js';
import {
  dispatchChatEvent,
  isInfrastructureErrorText,
} from './chatEventDispatch.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { RuntimeInvariantViolationError } from '../../agent/runtimeInvariants.js';

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

describe('chatTerminalTruth (Astra Probes P15, P16 & Evidence Projection)', () => {
  describe('Astra Probe P15: stream ending without terminal event', () => {
    it('returns inconclusive outcome (undefined, status: failed), never CANCELLED', async () => {
      async function* truncatedStream(): AsyncGenerator<ChatEvent, void, undefined> {
        yield { type: 'thinking' };
        yield { type: 'answer_chunk', text: 'Partial text before abrupt EOF' };
      }

      const result = await consumeChatStream(truncatedStream(), null);

      assert.equal(result.status, 'failed');
      assert.equal(
        result.outcome,
        undefined,
        'Stream ending without terminal event must be inconclusive (undefined), never CANCELLED',
      );
      assert.notEqual(
        result.outcome,
        'CANCELLED',
        'P15: abrupt EOF must never be attributed to operator CANCELLED',
      );
      assert.match(result.answer, /Stream ended without a terminal event/);
    });

    it('preserves accumulated toolCalls and runDir when stream ends without terminal event', async () => {
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
      assert.ok(result.toolCalls, 'accumulated tool calls must be preserved');
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.toolCalls?.[0]?.tool, 'read_file');
      assert.equal(result.toolCalls?.[0]?.detail, '42 lines read');
    });
  });

  describe('Astra Probe P16: infrastructure failures vs agent failures', () => {
    it('classifies ENOSPC disk-full error as INFRA_FAILURE, not AGENT_FAILURE', async () => {
      async function* enospcStream(): AsyncGenerator<ChatEvent, void, undefined> {
        yield { type: 'tool_start', tool: 'write_file', target: 'out.txt' };
        yield {
          type: 'tool_complete',
          tool: 'write_file',
          target: 'out.txt',
          error: 'ENOSPC',
        };
        const enospcErr = new Error('ENOSPC: no space left on device, write');
        (enospcErr as unknown as { code: string }).code = 'ENOSPC';
        throw enospcErr;
      }

      const result = await consumeChatStream(enospcStream(), null);

      assert.equal(result.status, 'failed');
      assert.equal(
        result.outcome,
        'INFRA_FAILURE',
        'P16: disk space exhaustion (ENOSPC) must be classified as INFRA_FAILURE',
      );
      assert.notEqual(result.outcome, 'AGENT_FAILURE');
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.toolCalls?.[0]?.tool, 'write_file');
    });

    it('classifies network connection reset as INFRA_FAILURE', async () => {
      async function* networkResetStream(): AsyncGenerator<ChatEvent, void, undefined> {
        const netErr = new Error('read ECONNRESET: connection reset by peer');
        (netErr as unknown as { code: string }).code = 'ECONNRESET';
        throw netErr;
      }

      const result = await consumeChatStream(networkResetStream(), null);

      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, 'INFRA_FAILURE');
    });

    it('classifies provider stream idle timeout as INFRA_FAILURE', async () => {
      async function* timeoutStream(): AsyncGenerator<ChatEvent, void, undefined> {
        throw new Error('[deepSeekApi] provider stream idle timeout after 120000ms');
      }

      const result = await consumeChatStream(timeoutStream(), null);

      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, 'INFRA_FAILURE');
    });

    it('classifies RuntimeInvariantViolationError as INFRA_FAILURE', async () => {
      async function* invariantStream(): AsyncGenerator<ChatEvent, void, undefined> {
        throw new RuntimeInvariantViolationError({
          invariantId: 'provider_message_shape',
          message: 'Malformed shape detected',
          expectedHash: 'abc',
          actualHash: 'def',
          expectedShape: [],
          actualShape: [],
        });
      }

      const result = await consumeChatStream(invariantStream(), null);

      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, 'INFRA_FAILURE');
    });

    it('classifies standard runtime logic error as AGENT_FAILURE', async () => {
      async function* agentFailStream(): AsyncGenerator<ChatEvent, void, undefined> {
        throw new Error('Unexpected JSON schema validation failure');
      }

      const result = await consumeChatStream(agentFailStream(), null);

      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, 'AGENT_FAILURE');
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

    it('classifies budget exceeded exception as BUDGET_EXHAUSTED', async () => {
      async function* budgetStream(): AsyncGenerator<ChatEvent, void, undefined> {
        throw new Error('Total session cost budget exceeded: .00 limit reached');
      }

      const result = await consumeChatStream(budgetStream(), null);

      assert.equal(result.status, 'budget_exhausted');
      assert.equal(result.outcome, 'BUDGET_EXHAUSTED');
    });
  });

  describe('classifyChatStreamError helper', () => {
    it('detects operator abort', () => {
      const abortErr = new Error('request cancelled');
      assert.deepEqual(classifyChatStreamError(abortErr), {
        status: 'cancelled',
        outcome: 'CANCELLED',
      });
    });

    it('detects budget exceeded', () => {
      assert.deepEqual(
        classifyChatStreamError(new Error('wall time budget exceeded')),
        {
          status: 'budget_exhausted',
          outcome: 'BUDGET_EXHAUSTED',
        },
      );
    });

    it('detects disk and network codes as INFRA_FAILURE', () => {
      for (const code of ['ENOSPC', 'EROFS', 'EIO', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']) {
        const err = Object.assign(new Error('Failed with ' + code), { code });
        assert.deepEqual(
          classifyChatStreamError(err),
          { status: 'failed', outcome: 'INFRA_FAILURE' },
          'Code ' + code + ' should map to INFRA_FAILURE',
        );
      }
    });

    it('falls back to AGENT_FAILURE for general errors', () => {
      assert.deepEqual(
        classifyChatStreamError(new Error('Uncaught syntax error in generated code')),
        { status: 'failed', outcome: 'AGENT_FAILURE' },
      );
    });
  });

  describe('isInfrastructureErrorText helper', () => {
    it('identifies disk, network, provider, and invariant error strings', () => {
      assert.ok(isInfrastructureErrorText('ENOSPC: no space left on device'));
      assert.ok(isInfrastructureErrorText('EROFS: read-only file system'));
      assert.ok(isInfrastructureErrorText('ECONNRESET connection reset'));
      assert.ok(isInfrastructureErrorText('fetch failed: socket hang up'));
      assert.ok(isInfrastructureErrorText('provider stream idle timeout'));
      assert.ok(isInfrastructureErrorText('request deadline exceeded after 600000ms'));
      assert.ok(isInfrastructureErrorText('[provider] Provider error during generation'));
      assert.ok(isInfrastructureErrorText('503 Service Unavailable'));
      assert.ok(isInfrastructureErrorText('[runtime-invariant:provider_tool_protocol] violation'));
    });

    it('returns false for normal agent or domain errors', () => {
      assert.equal(isInfrastructureErrorText('AssertionError: expected true but got false'), false);
      assert.equal(isInfrastructureErrorText('SyntaxError: Unexpected token < in JSON'), false);
      assert.equal(isInfrastructureErrorText('File not found: foo.ts'), false);
      assert.equal(isInfrastructureErrorText(''), false);
    });
  });

  describe('Evidence projection on terminal dispatch', () => {
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

    it('dispatchChatEvent preserves toolCalls, runDir, telemetry on failed event', () => {
      const failedEvent: ChatEvent = {
        type: 'failed',
        error: 'ENOSPC write error',
        toolCalls: [{ tool: 'execute_command', target: 'npm run build' }],
        runDir: '/tmp/runs/run-123',
        turnTelemetry: mockTelemetry,
      };

      const result = dispatchChatEvent(failedEvent, {});
      assert.ok(result);
      assert.equal(result.status, 'failed');
      assert.equal(result.outcome, 'INFRA_FAILURE');
      assert.equal(result.runDir, '/tmp/runs/run-123');
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.toolCalls?.[0]?.tool, 'execute_command');
      assert.equal(result.turnTelemetry?.turnId, 'turn-1');
    });

    it('dispatchChatEvent preserves toolCalls, runDir, telemetry on cancelled event', () => {
      const cancelledEvent: ChatEvent = {
        type: 'cancelled',
        turnTelemetry: mockTelemetry,
      };
      (cancelledEvent as unknown as { toolCalls: unknown; runDir: string }).toolCalls = [
        { tool: 'read_file', target: 'package.json' },
      ];
      (cancelledEvent as unknown as { runDir: string }).runDir = '/tmp/runs/cancel-456';

      const result = dispatchChatEvent(cancelledEvent, {});
      assert.ok(result);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.outcome, 'CANCELLED');
      assert.equal(result.runDir, '/tmp/runs/cancel-456');
      assert.equal(result.toolCalls?.length, 1);
      assert.equal(result.turnTelemetry?.turnId, 'turn-1');
    });
  });

  describe('Unconditional turn persistence and protocol finalization', () => {
    it('runs persistence and finalization even when turn fails', async () => {
      const mockEngine = {
        submitMessage: async () => ({
          status: 'failed' as const,
          outcome: 'AGENT_FAILURE' as const,
          answer: 'Task failed during execution',
          usage: EMPTY_USAGE,
          conversation: [],
        }),
        submitMessageStream: async function* () {
          yield { type: 'failed' as const, error: 'Task failed during execution' };
        },
        cancel: () => {},
        getTaskContract: () => null,
      };

      const target = makeTarget('/tmp/project');
      const result = await runChatEngineOnce({
        task: 'failing task',
        target,
        engineFactory: () => mockEngine as unknown as import('../../agent/chatEngine.js').ChatEngine,
        useStreaming: false,
        preflightContext: '',
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.answer, 'Task failed during execution');
    });

    it('runs persistence and finalization when turn is cancelled', async () => {
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
        getTaskContract: () => null,
      };

      const target = makeTarget('/tmp/project');
      const result = await runChatEngineOnce({
        task: 'cancelled task',
        target,
        engineFactory: () => mockEngine as unknown as import('../../agent/chatEngine.js').ChatEngine,
        useStreaming: true,
        preflightContext: '',
      });

      assert.equal(result.status, 'cancelled');
      assert.equal(result.outcome, 'CANCELLED');
    });
  });
});
