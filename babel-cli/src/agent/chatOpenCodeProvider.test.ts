import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from './chatEngine.js';
import { OpenCodeApiRunner } from '../runners/openCodeApi.js';
import { OpenRouterApiRunner } from '../runners/openRouterApi.js';
import { estimateTokens } from './chatCompaction.js';
import { resolveChatModelPolicy } from './chatModelPolicy.js';
import { resolveAskModelPolicyWithLiveGate } from '../services/askAnswer.js';
import { BABEL_RUNS_DIR } from '../cli/constants.js';

/**
 * OpenCode Zen routing invariants.
 *
 * Live lanes remain DeepSeek-only by default (LIVE_MODEL_POLICY), but an
 * explicit backend key whose provider is `opencode` (e.g. ox-alpha-free) is a
 * direct operator opt-in: chat/ask must route it through OpenCodeApiRunner.
 */

function withTestEnv(fn: () => void): void {
  const previousOffline = process.env['BABEL_OFFLINE'];
  const previousKey = process.env['OPENCODE_API_KEY'];
  const previousRouterKey = process.env['OPENROUTER_API_KEY'];
  delete process.env['BABEL_OFFLINE'];
  process.env['OPENCODE_API_KEY'] = 'synthetic-opencode-key';
  process.env['OPENROUTER_API_KEY'] = 'fixture-router-key';
  try {
    fn();
  } finally {
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    if (previousKey === undefined) delete process.env['OPENCODE_API_KEY'];
    else process.env['OPENCODE_API_KEY'] = previousKey;
    if (previousRouterKey === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = previousRouterKey;
  }
}

test('live chat policy resolves an explicit opencode backend key without the DeepSeek gate', () => {
  withTestEnv(() => {
    const { policy } = resolveChatModelPolicy({ model: 'ox-alpha-free' });
    assert.equal(policy.provider, 'opencode');
    assert.equal(policy.providerModelId, 'x-preview-f-free');
    assert.equal(policy.resolvedBackendKey, 'ox-alpha-free');
  });
});

test('live ChatEngine routes an explicit opencode request to the OpenCode runner', () => {
  withTestEnv(() => {
    const engine = new ChatEngine({
      task: 't',
      projectRoot: process.cwd(),
      model: 'ox-alpha-free',
    });
    assert.equal(
      (engine as unknown as { modelPolicy: { provider: string } }).modelPolicy.provider,
      'opencode',
    );
    const runner = (
      engine as unknown as { resolveDeliberationRunner: () => unknown }
    ).resolveDeliberationRunner();
    assert.ok(runner instanceof OpenCodeApiRunner);
  });
});

test('live chat resolves the exact GLM campaign model through OpenRouter', () => {
  withTestEnv(() => {
    const { policy } = resolveChatModelPolicy({ model: 'glm-5.3-flash' });
    assert.equal(policy.provider, 'openrouter');
    assert.equal(policy.providerModelId, 'z-ai/glm-5.3-flash');
    assert.equal(policy.resolvedBackendKey, 'glm-5.3-flash');
    assert.ok(policy.stagePolicies.length > 0);
    assert.ok(
      policy.stagePolicies.every(
        (route) =>
          route.primaryBackendKey === 'glm-5.3-flash' &&
          route.primaryProvider === 'openrouter' &&
          route.primaryProviderModelId === 'z-ai/glm-5.3-flash',
      ),
    );

    const engine = new ChatEngine({
      task: 't',
      projectRoot: process.cwd(),
      model: 'glm-5.3-flash',
    });
    const runner = (
      engine as unknown as { resolveDeliberationRunner: () => unknown }
    ).resolveDeliberationRunner();
    assert.ok(runner instanceof OpenRouterApiRunner);
  });
});

test('exact GLM route overrides phase model settings instead of substituting providers', () => {
  const previousInvestigate = process.env['BABEL_CHAT_INVESTIGATE_MODEL'];
  const previousMutate = process.env['BABEL_CHAT_MUTATE_MODEL'];
  process.env['BABEL_CHAT_INVESTIGATE_MODEL'] = 'deepseek-v4-flash';
  process.env['BABEL_CHAT_MUTATE_MODEL'] = 'deepseek-v4-pro';
  try {
    withTestEnv(() => {
      const engine = new ChatEngine({
        task: 't',
        projectRoot: process.cwd(),
        model: 'glm-5.3-flash',
      });
      const routed = (
        engine as unknown as { resolveRoutedRunner: () => unknown }
      ).resolveRoutedRunner();
      assert.ok(routed instanceof OpenRouterApiRunner);
      const limits = (
        engine as unknown as {
          limits: { investigateModel?: string; mutateModel?: string };
        }
      ).limits;
      assert.equal(limits.investigateModel, 'z-ai/glm-5.3-flash');
      assert.equal(limits.mutateModel, 'z-ai/glm-5.3-flash');
    });
  } finally {
    if (previousInvestigate === undefined) delete process.env['BABEL_CHAT_INVESTIGATE_MODEL'];
    else process.env['BABEL_CHAT_INVESTIGATE_MODEL'] = previousInvestigate;
    if (previousMutate === undefined) delete process.env['BABEL_CHAT_MUTATE_MODEL'];
    else process.env['BABEL_CHAT_MUTATE_MODEL'] = previousMutate;
  }
});

test('exact GLM route refuses a generic DeepSeek failover decision', async () => {
  const previousOffline = process.env['BABEL_OFFLINE'];
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-glm-failover-'));
  process.env['BABEL_OFFLINE'] = '1';
  try {
    const engine = new ChatEngine({
      task: 't',
      projectRoot,
      model: 'glm-5.3-flash',
      runId: `glm-failover-${randomUUID()}`,
    });
    const internal = engine as unknown as {
      options: { model?: string };
      resolveFallbackOrFail: (
        error: Error,
        turn: number,
      ) => AsyncGenerator<{ type: string; error?: string }, unknown, undefined>;
    };
    // Exercise the generic Pro→Flash decision with an exact GLM policy. The
    // policy guard must terminate without constructing a DeepSeek runner.
    internal.options.model = 'deepseek-v4-pro';
    const iterator = internal.resolveFallbackOrFail(new Error('temporary timeout'), 0);
    const events: Array<{ type: string; error?: string }> = [];
    let step = await iterator.next();
    while (!step.done) {
      events.push(step.value);
      step = await iterator.next();
    }

    assert.equal(step.value, null);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'failed');
    assert.match(events[0]?.error ?? '', /exact GLM route refuses provider substitution/);
  } finally {
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('exact GLM synthesis dispatch stays on the locked OpenRouter model', async () => {
  const previousOffline = process.env['BABEL_OFFLINE'];
  const previousCompaction = process.env['BABEL_COMPACTION'];
  const previousRouterKey = process.env['OPENROUTER_API_KEY'];
  const originalFetch = globalThis.fetch;
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-glm-synthesis-'));
  const runId = `glm-synthesis-${randomUUID()}`;
  let requestBody: Record<string, unknown> | null = null;
  delete process.env['BABEL_OFFLINE'];
  process.env['BABEL_COMPACTION'] = 'off';
  process.env['OPENROUTER_API_KEY'] = 'fixture-router-key';
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: 'z-ai/glm-5.3-flash',
        choices: [{ message: { content: 'synthesis complete' } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const engine = new ChatEngine({
      task: 'Summarize the completed fixture work.',
      projectRoot,
      model: 'glm-5.3-flash',
      runId,
    });
    const answer = await (engine as any).synthesizeAnswer('fixture evidence', {});
    assert.equal(answer, 'synthesis complete');
    assert.equal((requestBody as Record<string, unknown> | null)?.model, 'z-ai/glm-5.3-flash');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    if (previousCompaction === undefined) delete process.env['BABEL_COMPACTION'];
    else process.env['BABEL_COMPACTION'] = previousCompaction;
    if (previousRouterKey === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = previousRouterKey;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(join(BABEL_RUNS_DIR, 'chat-sessions', runId), {
      recursive: true,
      force: true,
    });
  }
});

test('exact GLM ChatEngine path streams and persists matching provider receipts', async () => {
  const previousOffline = process.env['BABEL_OFFLINE'];
  const previousCompaction = process.env['BABEL_COMPACTION'];
  const previousRouterKey = process.env['OPENROUTER_API_KEY'];
  const originalFetch = globalThis.fetch;
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-glm-c1-'));
  const runId = `glm-c1-${randomUUID()}`;
  let requestCount = 0;
  let requestBody: Record<string, unknown> | null = null;
  delete process.env['BABEL_OFFLINE'];
  process.env['BABEL_COMPACTION'] = 'off';
  process.env['OPENROUTER_API_KEY'] = 'fixture-router-key';
  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      [
        'data: {"model":"z-ai/glm-5.3-flash","choices":[{"delta":{"content":"hello from glm"}}]}',
        'data: {"model":"z-ai/glm-5.3-flash","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const engine = new ChatEngine({
      task: 'Explain the fixture without changing files.',
      projectRoot,
      model: 'glm-5.3-flash',
      runId,
    });
    const events = [] as Array<{ type: string; answer?: string }>;
    for await (const event of engine.submitMessageStream('Say hello.', 'explain')) {
      events.push(event);
    }
    const sessionEvents = engine.getParityRuntime().sessionEvents.events;
    const input = sessionEvents.find((event) => event.kind === 'model_input_receipt');
    const result = sessionEvents.find((event) => event.kind === 'model_result_delivery');
    assert.equal(requestCount, 1);
    assert.equal((requestBody as Record<string, unknown> | null)?.model, 'z-ai/glm-5.3-flash');
    assert.equal(input?.kind, 'model_input_receipt');
    assert.equal(result?.kind, 'model_result_delivery');
    if (input?.kind === 'model_input_receipt') {
      assert.equal(input.provider, 'openrouter');
      assert.equal(input.requested_model_id, 'z-ai/glm-5.3-flash');
      assert.equal(input.normalized_model_id, 'z-ai/glm-5.3-flash');
      assert.equal(input.sent_model_id, 'z-ai/glm-5.3-flash');
    }
    if (result?.kind === 'model_result_delivery') {
      assert.equal(result.status, 'delivered');
      assert.equal(result.observed_model_id, 'z-ai/glm-5.3-flash');
      assert.match(result.output_digest ?? '', /^[a-f0-9]{64}$/);
    }
    assert.ok(sessionEvents.some((event) => event.kind === 'turn_ended'));
    assert.ok(
      events.some((event) => event.type === 'done' && event.answer?.includes('hello from glm')),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    if (previousCompaction === undefined) delete process.env['BABEL_COMPACTION'];
    else process.env['BABEL_COMPACTION'] = previousCompaction;
    if (previousRouterKey === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = previousRouterKey;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(join(BABEL_RUNS_DIR, 'chat-sessions', runId), {
      recursive: true,
      force: true,
    });
  }
});

test('exact GLM ChatEngine C2/C3 path executes one read-only tool and correlates its continuation', async () => {
  const previousOffline = process.env['BABEL_OFFLINE'];
  const previousCompaction = process.env['BABEL_COMPACTION'];
  const previousRouterKey = process.env['OPENROUTER_API_KEY'];
  const originalFetch = globalThis.fetch;
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-glm-c2-'));
  const runId = `glm-c2-${randomUUID()}`;
  const fixturePath = join(projectRoot, 'fixture.txt');
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestCount = 0;
  writeFileSync(fixturePath, 'fixture contents for glm c2\n', 'utf8');
  delete process.env['BABEL_OFFLINE'];
  process.env['BABEL_COMPACTION'] = 'off';
  process.env['OPENROUTER_API_KEY'] = 'fixture-router-key';
  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    if (requestCount === 1) {
      const toolFrame = {
        model: 'z-ai/glm-5.3-flash',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'tool-read',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: JSON.stringify({ path: fixturePath }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      return new Response([`data: ${JSON.stringify(toolFrame)}`, 'data: [DONE]', ''].join('\n'), {
        status: 200,
      });
    }
    if (requestCount === 2) {
      return new Response(
        [
          'data: {"model":"z-ai/glm-5.3-flash","choices":[{"delta":{"content":"fixture contents received"}}]}',
          'data: {"model":"z-ai/glm-5.3-flash","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200 },
      );
    }
    throw new Error(`unexpected mocked provider request ${requestCount}`);
  }) as typeof fetch;
  try {
    const engine = new ChatEngine({
      task: 'Read the fixture and report its contents without changing files.',
      projectRoot,
      model: 'glm-5.3-flash',
      runId,
    });
    const events = [] as Array<{
      type: string;
      tool?: string;
      answer?: string;
    }>;
    for await (const event of engine.submitMessageStream(
      `Read ${fixturePath} and report its contents.`,
      'explain',
    )) {
      events.push(event);
    }

    const sessionEvents = engine.getParityRuntime().sessionEvents.events;
    const inputs = sessionEvents.filter((event) => event.kind === 'model_input_receipt');
    const results = sessionEvents.filter((event) => event.kind === 'model_result_delivery');
    const proposed = sessionEvents.filter((event) => event.kind === 'tool_proposed');
    const started = sessionEvents.filter((event) => event.kind === 'tool_started');
    const terminals = sessionEvents.filter(
      (event) =>
        event.kind === 'tool_completed' ||
        event.kind === 'tool_failed' ||
        event.kind === 'tool_cancelled',
    );
    const readBinding = sessionEvents.find(
      (event) => event.kind === 'capability_binding_receipt' && event.capability === 'read_file',
    );
    const toolComplete = events.find((event) => event.type === 'tool_complete');
    assert.equal(requestCount, 2);
    assert.equal(requestBodies[0]?.model, 'z-ai/glm-5.3-flash');
    assert.equal(requestBodies[1]?.model, 'z-ai/glm-5.3-flash');
    assert.equal(inputs.length, 2);
    assert.equal(results.length, 2);
    assert.equal(proposed.length, 1);
    assert.equal(started.length, 1);
    assert.equal(terminals.length, 1);
    assert.equal(sessionEvents.filter((event) => event.kind === 'mutation_batch').length, 0);
    if (proposed[0]?.kind === 'tool_proposed') assert.equal(proposed[0].tool_call_id, 'tool-read');
    if (started[0]?.kind === 'tool_started') assert.equal(started[0].tool_call_id, 'tool-read');
    if (terminals[0]?.kind === 'tool_completed')
      assert.equal(terminals[0].tool_call_id, 'tool-read');
    assert.equal(readBinding?.kind, 'capability_binding_receipt');
    if (readBinding?.kind === 'capability_binding_receipt') {
      assert.equal(readBinding.advertised, true);
      // Provider-neutral receipts leave target authorization/effectiveness unknown;
      // successful tool settlement is the execution evidence for this fixture.
      assert.ok(readBinding.authorized === null || readBinding.authorized === true);
      assert.ok(readBinding.effective === null || readBinding.effective === true);
    }
    assert.ok(events.some((event) => event.type === 'tool_start' && event.tool === 'read_file'));
    assert.equal(toolComplete?.type, 'tool_complete');
    assert.equal(toolComplete?.tool, 'read_file');
    assert.ok(
      events.some(
        (event) => event.type === 'done' && event.answer?.includes('fixture contents received'),
      ),
    );
    assert.ok(sessionEvents.some((event) => event.kind === 'turn_ended'));
    const secondInput = inputs[1];
    if (secondInput?.kind === 'model_input_receipt') {
      assert.equal(secondInput.provider, 'openrouter');
      assert.equal(secondInput.sent_model_id, 'z-ai/glm-5.3-flash');
      assert.deepEqual(secondInput.delivered_tool_call_ids, ['tool-read']);
    }
    for (const result of results) {
      if (result.kind === 'model_result_delivery') {
        assert.equal(result.observed_model_id, 'z-ai/glm-5.3-flash');
        assert.equal(result.status, 'delivered');
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    if (previousCompaction === undefined) delete process.env['BABEL_COMPACTION'];
    else process.env['BABEL_COMPACTION'] = previousCompaction;
    if (previousRouterKey === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = previousRouterKey;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(join(BABEL_RUNS_DIR, 'chat-sessions', runId), {
      recursive: true,
      force: true,
    });
  }
});

test('exact GLM ChatEngine path performs a bounded mutation and authoritative verification', async () => {
  const previousOffline = process.env['BABEL_OFFLINE'];
  const previousCompaction = process.env['BABEL_COMPACTION'];
  const previousCritic = process.env['BABEL_DIFF_CRITIC'];
  const previousMaxMessages = process.env['BABEL_CHAT_MAX_MESSAGES'];
  const previousExecutionProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousHostFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
  const previousDockerDisable = process.env['BABEL_DOCKER_DISABLE'];
  const previousBenchmarkMode = process.env['BABEL_BENCHMARK_MODE'];
  const previousAutoApprove = process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
  const previousRouterKey = process.env['OPENROUTER_API_KEY'];
  const originalFetch = globalThis.fetch;
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-glm-c4-'));
  const runId = `glm-c4-${randomUUID()}`;
  const fixturePath = join(projectRoot, 'fixture.txt');
  writeFileSync(fixturePath, 'initial fixture\n', 'utf8');
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: { test: 'node verify.mjs' },
    }),
    'utf8',
  );
  writeFileSync(
    join(projectRoot, 'verify.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "if (readFileSync('fixture.txt', 'utf8') !== 'updated fixture\\n') process.exit(1);",
    ].join('\n'),
    'utf8',
  );
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestCount = 0;
  delete process.env['BABEL_OFFLINE'];
  process.env['BABEL_COMPACTION'] = 'off';
  process.env['BABEL_DIFF_CRITIC'] = '0';
  process.env['BABEL_CHAT_MAX_MESSAGES'] = '100';
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  process.env['BABEL_DOCKER_DISABLE'] = 'true';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['OPENROUTER_API_KEY'] = 'fixture-router-key';
  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
      model: 'z-ai/glm-5.3-flash',
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    if (requestCount === 1) {
      return new Response(
        [
          `data: ${JSON.stringify(
            toolCall('tool-write', 'write_file', {
              path: fixturePath,
              content: 'updated fixture\n',
            }),
          )}`,
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200 },
      );
    }
    if (requestCount === 2) {
      return new Response(
        [
          `data: ${JSON.stringify(
            toolCall('tool-verify', 'run_command', {
              command: 'npm test',
              cwd: projectRoot,
            }),
          )}`,
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200 },
      );
    }
    if (requestCount === 3) {
      return new Response(
        [
          'data: {"model":"z-ai/glm-5.3-flash","choices":[{"delta":{"content":"mutation verified"}}]}',
          'data: {"model":"z-ai/glm-5.3-flash","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":3,"total_tokens":23}}',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200 },
      );
    }
    throw new Error(`unexpected mocked provider request ${requestCount}`);
  }) as typeof fetch;
  try {
    const engine = new ChatEngine({
      task: 'Update the fixture, run npm test before completing, and report the result.',
      projectRoot,
      model: 'glm-5.3-flash',
      runId,
      maxConversationMessages: 100,
      maxEstimatedTokens: 200_000,
      requiredVerifierCommands: ['npm test'],
    });
    assert.equal((engine as any).limits.maxEstimatedTokens, 200_000);
    assert.equal((engine as any).limits.maxConversationMessages, 100);
    const events = [] as Array<{
      type: string;
      tool?: string;
      answer?: string;
    }>;
    try {
      for await (const event of engine.submitMessageStream(
        'Change fixture.txt to updated fixture, run npm test, then report success.',
        'execute',
      )) {
        events.push(event);
      }
    } catch (error) {
      assert.fail(
        `stream failed: ${error instanceof Error ? error.message : String(error)}; ` +
          `conversation=${(engine as any).conversation.length}; ` +
          `estimated=${estimateTokens((engine as any).conversation)}; ` +
          `limits=${JSON.stringify((engine as any).limits)}`,
      );
    }

    const sessionEvents = engine.getParityRuntime().sessionEvents.events;
    const inputs = sessionEvents.filter((event) => event.kind === 'model_input_receipt');
    const results = sessionEvents.filter((event) => event.kind === 'model_result_delivery');
    const verifier = sessionEvents.find((event) => event.kind === 'verifier_attempt');
    assert.equal(requestCount, 3);
    assert.ok(requestBodies.every((body) => body.model === 'z-ai/glm-5.3-flash'));
    assert.equal(readFileSync(fixturePath, 'utf8'), 'updated fixture\n');
    assert.ok(events.some((event) => event.type === 'tool_start' && event.tool === 'write_file'));
    assert.ok(events.some((event) => event.type === 'tool_start' && event.tool === 'run_command'));
    assert.ok(
      events.some((event) => event.type === 'tool_complete' && event.tool === 'write_file'),
    );
    assert.ok(
      events.some((event) => event.type === 'tool_complete' && event.tool === 'run_command'),
    );
    assert.equal(inputs.length, 3);
    assert.equal(results.length, 3);
    assert.equal(verifier?.kind, 'verifier_attempt');
    if (verifier?.kind === 'verifier_attempt') {
      assert.equal(verifier.command_preview, 'npm test');
      assert.equal(verifier.authoritative, true);
      assert.equal(verifier.exit_code, 0, JSON.stringify((engine as any).toolCallLog));
      assert.equal(verifier.tool_call_id, 'tool-verify');
    }
    const secondInput = inputs[1];
    if (secondInput?.kind === 'model_input_receipt') {
      assert.deepEqual(secondInput.delivered_tool_call_ids, ['tool-write']);
    }
    const thirdInput = inputs[2];
    if (thirdInput?.kind === 'model_input_receipt') {
      assert.equal(thirdInput.sent_model_id, 'z-ai/glm-5.3-flash');
      assert.deepEqual(thirdInput.delivered_tool_call_ids, ['tool-write', 'tool-verify']);
    }
    assert.ok(
      events.some((event) => event.type === 'done' && event.answer?.includes('mutation verified')),
    );
    assert.ok(sessionEvents.some((event) => event.kind === 'turn_ended'));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    if (previousCompaction === undefined) delete process.env['BABEL_COMPACTION'];
    else process.env['BABEL_COMPACTION'] = previousCompaction;
    if (previousCritic === undefined) delete process.env['BABEL_DIFF_CRITIC'];
    else process.env['BABEL_DIFF_CRITIC'] = previousCritic;
    if (previousMaxMessages === undefined) delete process.env['BABEL_CHAT_MAX_MESSAGES'];
    else process.env['BABEL_CHAT_MAX_MESSAGES'] = previousMaxMessages;
    if (previousExecutionProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previousExecutionProfile;
    if (previousHostFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousHostFallback;
    if (previousDockerDisable === undefined) delete process.env['BABEL_DOCKER_DISABLE'];
    else process.env['BABEL_DOCKER_DISABLE'] = previousDockerDisable;
    if (previousBenchmarkMode === undefined) delete process.env['BABEL_BENCHMARK_MODE'];
    else process.env['BABEL_BENCHMARK_MODE'] = previousBenchmarkMode;
    if (previousAutoApprove === undefined) delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
    else process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = previousAutoApprove;
    if (previousRouterKey === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = previousRouterKey;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(join(BABEL_RUNS_DIR, 'chat-sessions', runId), {
      recursive: true,
      force: true,
    });
  }
});

test('live chat still rejects legacy non-DeepSeek provider models', () => {
  withTestEnv(() => {
    assert.throws(
      () =>
        new ChatEngine({
          task: 't',
          projectRoot: process.cwd(),
          model: 'qwen3',
        }),
      /LIVE_MODEL_POLICY/,
    );
  });
});

test('ask lane resolves an explicit opencode request outside the DeepSeek-only gate', () => {
  withTestEnv(() => {
    const policy = resolveAskModelPolicyWithLiveGate({ model: 'ox-alpha-free' }, true);
    assert.ok(policy);
    assert.equal(policy.provider, 'opencode');
    assert.equal(policy.providerModelId, 'x-preview-f-free');
  });
});

test('ask lane keeps DeepSeek-only enforcement for other backends', () => {
  withTestEnv(() => {
    // resolveFamilyModelPolicy's fallback wraps policy denials, so accept both
    // the wrapped form and the raw LIVE_MODEL_POLICY denial — blocked is the
    // invariant.
    assert.throws(
      () => resolveAskModelPolicyWithLiveGate({ model: 'qwen3' }, true),
      /LIVE_MODEL_POLICY|is not configured/,
    );
    // No explicit model + non-live gate → no policy resolution at all.
    assert.equal(resolveAskModelPolicyWithLiveGate({}, false), undefined);
  });
});
