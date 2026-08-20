/**
 * Regression: trivial conversational input must terminate after one model call.
 * Pure text completions previously auto-continued via "completion prefers patch"
 * because classifyChatTaskIntent defaulted to execute.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import type { ToolStreamEvent } from '../runners/base.js';

const READY = "I'm ready to help. What would you like me to work on?";

function installMockRunner(
  engine: ChatEngine,
  runner: {
    executeWithToolsStream: (
      ...args: unknown[]
    ) => AsyncGenerator<ToolStreamEvent, void, undefined>;
    execute: () => Promise<{ type: string; answer: string }>;
    getLastInvocationMetadata: () => {
      provider_model_id: string;
      prompt_tokens: number;
      completion_tokens: number;
    };
  },
): void {
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  anyEngine.deliberationRunner = runner;
  anyEngine.synthesisRunner = runner;
  anyEngine.shouldUseNativeTools = () => true;
}

async function collectStream(engine: ChatEngine, input: string): Promise<{
  events: ChatEvent[];
  answerChunks: string[];
  done: ChatEvent | undefined;
}> {
  const events: ChatEvent[] = [];
  const answerChunks: string[] = [];
  for await (const event of engine.submitMessageStream(input)) {
    events.push(event);
    if (event.type === 'answer_chunk') answerChunks.push(event.text);
  }
  return {
    events,
    answerChunks,
    done: events.find((e) => e.type === 'done' || e.type === 'cancelled' || e.type === 'failed'),
  };
}

describe('runtime_chat_trivial_input_terminates', () => {
  let projectRoot: string;

  before(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'babel-trivial-turn-'));
    writeFileSync(join(projectRoot, 'README.md'), '# fixture\n', 'utf-8');
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  });

  after(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
  });

  for (const input of ['?', 'hello', 'who are you?', 'what can you do?', 'thanks'] as const) {
    test(`${JSON.stringify(input)} makes one provider call and completes`, async () => {
      const engine = new ChatEngine({
        task: input,
        projectRoot,
        model: 'deepseek-v4-flash',
        maxTurns: 8,
      });
      let providerRequests = 0;
      installMockRunner(engine, {
        executeWithToolsStream: async function* () {
          providerRequests += 1;
          yield { type: 'text_delta', text: "I'm " };
          yield { type: 'text_delta', text: 'ready ' };
          yield { type: 'text_delta', text: 'to help.' };
          yield { type: 'done', finishReason: 'stop' };
        },
        execute: async () => ({ type: 'completion', answer: READY }),
        getLastInvocationMetadata: () => ({
          provider_model_id: 'deepseek-v4-flash',
          prompt_tokens: 100,
          completion_tokens: 12,
        }),
      });

      const { events, answerChunks, done } = await collectStream(engine, input);
      const toolStarts = events.filter((e) => e.type === 'tool_start');
      const joined = answerChunks.join('');

      assert.equal(providerRequests, 1, `provider_requests == 1, got ${providerRequests}`);
      assert.equal(toolStarts.length, 0, 'tool_calls == 0');
      assert.equal(done?.type, 'done');
      if (done?.type === 'done') {
        assert.equal(done.answer.includes('to help'), true);
        assert.equal(done.blockedReport ?? null, null);
      }
      assert.equal(joined, "I'm ready to help.", 'streamed answer exactly once, no full replay');
      assert.equal(events.some((e) => e.type === 'cancelled'), false);
    });
  }

  test('Case C: tool then final text uses two model calls and completes', async () => {
    const engine = new ChatEngine({
      task: 'read README.md then summarize',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 8,
    });
    let providerRequests = 0;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        providerRequests += 1;
        if (providerRequests === 1) {
          yield {
            type: 'tool_use',
            id: 'c1',
            name: 'read_file',
            input: { path: 'README.md' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: 'Here is the answer.' };
        yield { type: 'done', finishReason: 'stop' };
      },
      execute: async () => ({ type: 'completion', answer: 'Here is the answer.' }),
      getLastInvocationMetadata: () => ({
        provider_model_id: 'deepseek-v4-flash',
        prompt_tokens: 80,
        completion_tokens: 8,
      }),
    });

    const { events, done } = await collectStream(engine, 'read README.md then summarize');
    assert.equal(providerRequests, 2);
    assert.ok(events.some((e) => e.type === 'tool_start'));
    assert.equal(done?.type, 'done');
    if (done?.type === 'done') {
      assert.match(done.answer, /Here is the answer/);
    }
  });

  test('execute-classified text-only reply terminates instead of prefers-patch looping', async () => {
    const engine = new ChatEngine({
      task: 'fix the login bug',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 8,
    });
    let providerRequests = 0;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        providerRequests += 1;
        yield { type: 'text_delta', text: READY };
        yield { type: 'done', finishReason: 'stop' };
      },
      execute: async () => ({ type: 'completion', answer: READY }),
      getLastInvocationMetadata: () => ({
        provider_model_id: 'deepseek-v4-flash',
        prompt_tokens: 4000,
        completion_tokens: 40,
      }),
    });

    const { done } = await collectStream(engine, 'fix the login bug');
    assert.equal(providerRequests, 1, 'must not re-query the model when no tool was requested');
    assert.equal(done?.type, 'done');
    if (done?.type === 'done') {
      assert.equal(done.answer, READY);
      assert.equal(done.blockedReport ?? null, null);
    }
  });

  test('Case E: execute intent still continues after a real tool request', async () => {
    const engine = new ChatEngine({
      task: 'fix the failing test in src/math.js',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 8,
    });
    let providerRequests = 0;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        providerRequests += 1;
        if (providerRequests === 1) {
          yield {
            type: 'tool_use',
            id: 'c1',
            name: 'read_file',
            input: { path: 'README.md' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: 'I inspected the file.' };
        yield { type: 'done', finishReason: 'stop' };
      },
      execute: async () => ({ type: 'completion', answer: 'I inspected the file.' }),
      getLastInvocationMetadata: () => ({
        provider_model_id: 'deepseek-v4-flash',
        prompt_tokens: 90,
        completion_tokens: 10,
      }),
    });

    await collectStream(engine, 'fix the failing test in src/math.js');
    assert.equal(providerRequests, 2, 'tool iteration then text completion');
  });
});
