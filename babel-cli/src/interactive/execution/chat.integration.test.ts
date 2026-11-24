import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEngineOptions, type ChatEvent, type ChatResult } from '../../agent/chatEngine.js';
import { BabelRepl } from '../BabelRepl.js';
import type { ReplContext } from '../context.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { executeChatTask } from './chat.js';
import { ShellRuntimeBinding } from '../../ui/shell/shellRuntimeBinding.js';
import { resolveEffectiveExecutionBoundary } from '../../config/effectiveExecutionBoundary.js';
import { OpenCodeGoApiRunner } from '../../runners/openCodeGoApi.js';
import { babelReviewModelPolicy } from '../../services/babelChatReview.js';
import { initMinimalGitProject, mkExternalRunsDir } from '../../testUtils/chatAdmissionFixture.js';

const EMPTY_USAGE = globalCostTracker.getSessionSummary();

function makeTarget(root = process.cwd()): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

function createMockEngine(
  result: ChatResult,
  hooks?: {
    onSubmit?: () => void;
    onCreate?: () => void;
  },
): ChatEngine {
  return {
    submitMessage: async () => {
      hooks?.onSubmit?.();
      return result;
    },
    submitMessageStream: async function* () {
      hooks?.onSubmit?.();
      if (result.status === 'failed') {
        yield { type: 'failed', error: result.answer, ...(result.outcome ? { outcome: result.outcome } : {}),
          ...(result.reason_code ? { reason_code: result.reason_code } : {}),
          ...(result.reason_detail ? { reason_detail: result.reason_detail } : {}) } as ChatEvent;
        return;
      }
      yield { type: 'done', answer: result.answer, usage: result.usage } as ChatEvent;
    },
    cancel: () => undefined,
    abortTurn: () => undefined,
    getTaskAllowanceSnapshot: () => null,
  } as unknown as ChatEngine;
}

function makeReplContext(): ReplContext {
  const ctx = Object.create(BabelRepl.prototype) as ReplContext;
  ctx.state = {
    mode: 'chat',
    router: 'v9',
    costTotals: {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    },
    turnCount: 0,
  };
  ctx.isRunning = false;
  ctx.verboseMode = false;
  ctx.rl = {
    pause: () => undefined,
    resume: () => undefined,
  } as unknown as ReplContext['rl'];
  ctx.turns = [];
  ctx.turnCounter = 0;
  ctx.chatEngine = undefined;
  ctx.lastAssistantAnswer = null;
  ctx.lastAssistantStatus = null;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.lastTargetRoot = null;
  ctx.lastWorkspaceRoot = null;
  ctx.appendTurn = (turn) => {
    const record = {
      schema_version: 1 as const,
      turn_id: ++ctx.turnCounter,
      ts: new Date().toISOString(),
      ...turn,
    };
    ctx.turns.push(record);
    return record;
  };
  return ctx;
}

function withStdoutIsTTY<T>(value: boolean, fn: () => Promise<T> | T): Promise<T> {
  const stdout = process.stdout as { isTTY?: boolean };
  const orig = stdout.isTTY;
  stdout.isTTY = value;
  return Promise.resolve(fn()).finally(() => {
    if (orig === undefined) {
      delete stdout.isTTY;
    } else {
      stdout.isTTY = orig;
    }
  });
}

function withEnvUnset<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[key];
  delete process.env[key];
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  });
}

const noGitPreflight = async () => undefined;

function sseCompletion(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      model: 'mimo-v2.5',
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\ndata: [DONE]\n\n`,
    { status: 200 },
  );
}

const testDeps = {
  gatherPreflight: noGitPreflight,
};

describe('executeChatTask integration', { concurrency: 1 }, () => {
test('a current route rejected by authentication blocks a second send', async () => {
  const { executeTask } = await import('./dispatch.js');
  const root = mkdtempSync(join(tmpdir(), 'babel-route-rejected-'));
  const previous = { state: process.env['BABEL_STATE_DIR'], project: process.env['BABEL_PROJECT_ROOT'], key: process.env['ROUTE_FIXTURE_KEY'] };
  const previousLog = console.log;
  const state = join(root, 'state'); const project = join(root, 'project');
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, 'README.md'), 'fixture');
  writeFileSync(join(state, 'preferences.json'), JSON.stringify({ schemaVersion: 1, connections: {
    a: { id: 'a', provider: 'openrouter', model: 'vendor/model', apiKeyEnvVar: 'ROUTE_FIXTURE_KEY' },
  }, defaults: { connection: 'a', model: 'vendor/model' } }));
  process.env['BABEL_STATE_DIR'] = state; process.env['BABEL_PROJECT_ROOT'] = project; process.env['ROUTE_FIXTURE_KEY'] = 'synthetic-only';
  console.log = () => {};
  let submitted = 0;
  try {
    const ctx = makeReplContext();
    ctx.state.connectionId = 'a'; ctx.state.model = 'connection/a/vendor/model'; ctx.state.readinessState = 'configured_unverified';
    ctx.resolveCurrentTarget = () => makeTarget(project); ctx.scheduleIndexWarmup = () => {}; ctx.saveSessionState = () => {};
    const events: unknown[] = [];
    const engine = createMockEngine({ status: 'failed', outcome: 'INFRA_FAILURE', reason_code: 'provider_failure', reason_detail: 'authentication',
      answer: 'Provider authentication rejected', usage: EMPTY_USAGE, conversation: [] }, { onSubmit: () => {
        submitted++;
        events.push({ kind: 'model_input_receipt', turn_id: 'turn-a', inference_id: 'inference-a', provider: 'openrouter', sent_model_id: 'vendor/model',
          route_receipt: { execution_stage: 'chat', provider: 'openrouter', exact_model_id_sent: 'vendor/model', substitution_or_fallback: false } });
        events.push({ kind: 'provider_failure_receipt', turn_id: 'turn-a', inference_id: 'inference-a', provider: 'openrouter', model: 'vendor/model', receipt: { http_status: 401 } });
      } });
    engine.getParityRuntime = () => ({ turnId: 'turn-a', sessionEvents: { events } }) as never;
    engine.getProviderRouteIdentity = () => ({ connection: 'a', provider: 'openrouter', requestedModel: 'vendor/model',
      endpoint: null, credentialReference: 'ROUTE_FIXTURE_KEY', authentication: null }) as never;
    const deps = { loadSessionIdentity: async () => '', executeChatTask: (c: ReplContext, i: string, task: string, target: AgentTargetContext, system?: string) =>
      executeChatTask(c, i, task, target, system, { ...testDeps, engineFactory: () => engine }) };
    await executeTask(ctx, 'original request', deps);
    assert.equal(submitted, 1);
    assert.equal(ctx.state.readinessState, 'action_required');
    ctx.state.readinessState = 'configured_unverified'; // Merely reselecting the same route is not recovery.
    await executeTask(ctx, 'second request', deps);
    assert.equal(submitted, 1, 'no second inference before explicit recovery');
    assert.ok(ctx.turns.some(turn => turn.input === 'original request'));
  } finally {
    console.log = previousLog;
    for (const [name, value] of Object.entries({ BABEL_STATE_DIR: previous.state, BABEL_PROJECT_ROOT: previous.project, ROUTE_FIXTURE_KEY: previous.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test('a real engine 401 or 403 blocks a second request for the selected route', async () => {
  const { executeTask } = await import('./dispatch.js');
  const { connectionModelSelector, resolveConnectionModelPolicy } = await import('../../config/connectionModelPolicy.js');
  const { OpenRouterApiRunner } = await import('../../runners/openRouterApi.js');
  const root = mkdtempSync(join(tmpdir(), 'babel-real-auth-'));
  const previous = { state: process.env['BABEL_STATE_DIR'], project: process.env['BABEL_PROJECT_ROOT'], key: process.env['ROUTE_FIXTURE_KEY'], fetch: globalThis.fetch, log: console.log };
  const state = join(root, 'state'); const project = join(root, 'project');
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, 'README.md'), 'fixture');
  writeFileSync(join(state, 'preferences.json'), JSON.stringify({ schemaVersion: 1, connections: {
    a: { id: 'a', provider: 'openrouter', model: 'vendor/model', apiKeyEnvVar: 'ROUTE_FIXTURE_KEY' },
  }, defaults: { connection: 'a', model: 'vendor/model' } }));
  process.env['BABEL_STATE_DIR'] = state; process.env['BABEL_PROJECT_ROOT'] = project; process.env['ROUTE_FIXTURE_KEY'] = 'synthetic-only';
  let requests = 0; let selectedModel = ''; let responseStatus = 401; const output: string[] = [];
  globalThis.fetch = async (_url, init) => {
    requests++; selectedModel = JSON.parse(String(init?.body)).model as string;
    return new Response('{}', { status: responseStatus });
  };
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(' ')); };
  let engine: ChatEngine | undefined;
  try {
    for (const status of [401, 403]) {
    responseStatus = status; requests = 0; selectedModel = ''; output.length = 0;
    const ctx = makeReplContext();
    ctx.state.connectionId = 'a'; ctx.state.model = connectionModelSelector('a', 'vendor/model'); ctx.state.readinessState = 'configured_unverified';
    ctx.resolveCurrentTarget = () => makeTarget(project); ctx.scheduleIndexWarmup = () => {}; ctx.saveSessionState = () => {};
    const policy = resolveConnectionModelPolicy(ctx.state.model);
    assert.ok(policy);
    const runner = new OpenRouterApiRunner('vendor/model', {}, { env: { ROUTE_FIXTURE_KEY: 'synthetic-only' }, explicitCredential: 'synthetic-only' });
    const deps = { loadSessionIdentity: async () => '', executeChatTask: (c: ReplContext, i: string, task: string, target: AgentTargetContext, system?: string) =>
      executeChatTask(c, i, task, target, system, { ...testDeps, engineFactory: options => (engine = new ChatEngine({ ...options, providerPolicy: policy, providerRunner: runner })) }) };
    await executeTask(ctx, 'Inspect the fixture', deps);
    assert.equal(requests, 1); assert.equal(selectedModel, 'vendor/model');
    const observations = engine?.getParityRuntime().sessionEvents.events
      .filter(event => event.kind === 'provider_failure_receipt' || event.kind === 'model_result_delivery')
      .map(event => event.kind === 'provider_failure_receipt'
        ? { kind: event.kind, provider: event.provider, model: event.model, status: event.receipt.http_status }
        : { kind: event.kind, provider: event.provider, model: event.model, status: event.http_status, receiptStatus: event.failure_receipt?.http_status });
    const terminals = engine?.getParityRuntime().sessionEvents.events.filter(event => event.kind === 'turn_ended')
      .map(event => ({ reason: event.reason_code, detail: event.reason_detail, status: event.status }));
    assert.equal(ctx.state.readinessState, 'action_required', JSON.stringify({ observations, terminals, selection: engine?.getProviderSelectionStatus() }));
    assert.equal(/openrouter.*connection a/i.test(output.join('\n')), true, 'provider and account must be visible');
    assert.equal(/\/setup/.test(output.join('\n')), true, 'reconnection must be actionable');
    assert.equal(/synthetic-only/.test(output.join('\n')), false, 'fixture credential must not be displayed');
    await executeTask(ctx, 'Do not send this automatically', deps);
    assert.equal(requests, 1);
    engine?.closeAdmissionStore(); engine = undefined;
    }
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = previous.fetch; console.log = previous.log;
    for (const [name, value] of Object.entries({ BABEL_STATE_DIR: previous.state, BABEL_PROJECT_ROOT: previous.project, ROUTE_FIXTURE_KEY: previous.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test('a late authentication receipt cannot reject a replacement route', async () => {
  const { executeTask } = await import('./dispatch.js');
  const root = mkdtempSync(join(tmpdir(), 'babel-route-stale-'));
  const previous = { state: process.env['BABEL_STATE_DIR'], project: process.env['BABEL_PROJECT_ROOT'], key: process.env['ROUTE_FIXTURE_KEY'], log: console.log };
  const state = join(root, 'state'); const project = join(root, 'project');
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, 'README.md'), 'fixture');
  writeFileSync(join(state, 'preferences.json'), JSON.stringify({ schemaVersion: 1, connections: {
    a: { id: 'a', provider: 'openrouter', model: 'vendor/model', apiKeyEnvVar: 'ROUTE_FIXTURE_KEY' },
    b: { id: 'b', provider: 'openrouter', model: 'vendor/other', apiKeyEnvVar: 'ROUTE_FIXTURE_KEY' },
  }, defaults: { connection: 'a', model: 'vendor/model' } }));
  process.env['BABEL_STATE_DIR'] = state; process.env['BABEL_PROJECT_ROOT'] = project; process.env['ROUTE_FIXTURE_KEY'] = 'synthetic-only'; console.log = () => {};
  let release!: () => void; let started!: () => void; let replacementSubmits = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  try {
    const ctx = makeReplContext();
    ctx.state.connectionId = 'a'; ctx.state.model = 'connection/a/vendor/model'; ctx.state.readinessState = 'configured_unverified';
    ctx.resolveCurrentTarget = () => makeTarget(project); ctx.scheduleIndexWarmup = () => {}; ctx.saveSessionState = () => {};
    const events: unknown[] = [];
    const first = createMockEngine({ status: 'failed', answer: 'rejected', usage: EMPTY_USAGE, conversation: [] });
    first.getParityRuntime = () => ({ turnId: 'turn-a', sessionEvents: { events } }) as never;
    first.getProviderRouteIdentity = () => ({ connection: 'a', provider: 'openrouter', requestedModel: 'vendor/model',
      endpoint: null, credentialReference: 'ROUTE_FIXTURE_KEY', authentication: null }) as never;
    first.submitMessageStream = async function* () {
      started(); await pending;
      events.push({ kind: 'model_input_receipt', turn_id: 'turn-a', inference_id: 'inference-a', provider: 'openrouter', sent_model_id: 'vendor/model',
        route_receipt: { execution_stage: 'chat', provider: 'openrouter', exact_model_id_sent: 'vendor/model', substitution_or_fallback: false } });
      events.push({ kind: 'provider_failure_receipt', turn_id: 'turn-a', inference_id: 'inference-a', provider: 'openrouter', model: 'vendor/model', receipt: { http_status: 401 } });
      yield { type: 'failed', error: 'rejected', outcome: 'INFRA_FAILURE', reason_code: 'provider_failure', reason_detail: 'authentication' } as ChatEvent;
    };
    const replacement = createMockEngine({ status: 'completed', answer: 'done', usage: EMPTY_USAGE, conversation: [] }, { onSubmit: () => { replacementSubmits++; } });
    replacement.getProviderRouteIdentity = () => ({ connection: 'b', provider: 'openrouter', requestedModel: 'vendor/other',
      endpoint: null, credentialReference: 'ROUTE_FIXTURE_KEY', authentication: null }) as never;
    const deps = { loadSessionIdentity: async () => '', executeChatTask: (c: ReplContext, i: string, task: string, target: AgentTargetContext, system?: string) =>
      executeChatTask(c, i, task, target, system, { ...testDeps, engineFactory: () => first }) };
    const prior = executeTask(ctx, 'first request', deps);
    await entered;
    ctx.state.connectionId = 'b'; ctx.state.model = 'connection/b/vendor/other'; ctx.state.readinessState = 'configured_unverified'; ctx.chatEngine = replacement;
    release(); await prior;
    assert.equal(ctx.state.readinessState, 'configured_unverified');
    await executeTask(ctx, 'replacement request', deps);
    assert.equal(replacementSubmits, 1);
  } finally {
    console.log = previous.log;
    for (const [name, value] of Object.entries({ BABEL_STATE_DIR: previous.state, BABEL_PROJECT_ROOT: previous.project, ROUTE_FIXTURE_KEY: previous.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test('a failure from a different inference stage does not reject the selected chat route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-other-stage-'));
  const previous = { state: process.env['BABEL_STATE_DIR'], project: process.env['BABEL_PROJECT_ROOT'], log: console.log };
  const state = join(root, 'state'); const project = join(root, 'project');
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, 'README.md'), 'fixture');
  writeFileSync(join(state, 'preferences.json'), JSON.stringify({ schemaVersion: 1, connections: {
    a: { id: 'a', provider: 'openrouter', model: 'vendor/model' },
  }, defaults: { connection: 'a', model: 'vendor/model' } }));
  process.env['BABEL_STATE_DIR'] = state; process.env['BABEL_PROJECT_ROOT'] = project; console.log = () => {};
  try {
    const ctx = makeReplContext();
    ctx.state.connectionId = 'a'; ctx.state.model = 'connection/a/vendor/model'; ctx.state.readinessState = 'configured_unverified';
    const events: unknown[] = [];
    const engine = createMockEngine({ status: 'failed', outcome: 'INFRA_FAILURE', reason_code: 'provider_failure', reason_detail: 'authentication',
      answer: 'rejected', usage: EMPTY_USAGE, conversation: [] }, { onSubmit: () => {
        events.push({ kind: 'model_input_receipt', turn_id: 'turn-a', inference_id: 'critic-a', provider: 'openrouter', sent_model_id: 'vendor/model',
          route_receipt: { execution_stage: 'critic', provider: 'openrouter', exact_model_id_sent: 'vendor/model', substitution_or_fallback: false } });
        events.push({ kind: 'provider_failure_receipt', turn_id: 'turn-a', inference_id: 'critic-a', provider: 'openrouter', model: 'vendor/model', receipt: { http_status: 401 } });
      } });
    engine.getParityRuntime = () => ({ turnId: 'turn-a', sessionEvents: { events } }) as never;
    engine.getProviderRouteIdentity = () => ({ connection: 'a', provider: 'openrouter', requestedModel: 'vendor/model',
      endpoint: null, credentialReference: null, authentication: null }) as never;
    await executeChatTask(ctx, 'task', 'task', makeTarget(project), undefined, { ...testDeps, engineFactory: () => engine });
    assert.equal(ctx.state.readinessState, 'configured_unverified');
  } finally {
    console.log = previous.log;
    for (const [name, value] of Object.entries({ BABEL_STATE_DIR: previous.state, BABEL_PROJECT_ROOT: previous.project })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test('hosted exceptions stay in the shell and retain the original task', async () => {
  const ctx = makeReplContext();
  const task = 'Preserve this exact request';
  const binding = new ShellRuntimeBinding({ width: 80 });
  binding.beginTurn(1, task);
  ctx.shellRuntime = binding;
  ctx.shellHost = {} as never;
  const originalLog = console.log;
  const raw: string[] = [];
  console.log = (...args: unknown[]) => { raw.push(args.map(String).join(' ')); };
  try {
    await executeChatTask(ctx, task, task, makeTarget(), undefined, {
      ...testDeps,
      engineFactory: () => { throw new Error('[provider:fixture] HTTP 401'); },
    });
  } finally {
    console.log = originalLog;
  }
  const records = binding.store.getRecords();
  assert.ok(records.some(record => JSON.stringify(record).includes('authentication')));
  assert.ok(records.some(record => JSON.stringify(record).includes(task)));
  assert.equal(raw.some(line => /HTTP 401|authentication/i.test(line)), false);
});
test('hosted chat retains the full execution boundary before starting the engine', async () => {
  const ctx = makeReplContext();
  const binding = new ShellRuntimeBinding({ width: 40 });
  binding.beginTurn(1, 'hello');
  binding.getVisibleRows(40, 8);
  ctx.shellRuntime = binding;
  ctx.shellHost = {} as never;
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousLog = console.log;
  const raw: string[] = [];
  let recordedBeforeEngine = false;
  process.env['BABEL_EXECUTION_PROFILE'] = 'host_native';
  console.log = (...args: unknown[]) => { raw.push(args.map(String).join(' ')); };
  const expected = resolveEffectiveExecutionBoundary({ profile: 'host_native' }).disclosure;
  try {
    const engine = createMockEngine({ status: 'completed', answer: 'done', usage: EMPTY_USAGE, conversation: [] });
    await executeChatTask(ctx, 'hello', 'hello', makeTarget(), undefined, {
      ...testDeps,
      engineFactory: () => {
        recordedBeforeEngine = binding.store.getRecords().some(record =>
          record.kind === 'plain' && 'lines' in record.payload && record.payload.lines.join('\n').includes(expected));
        return engine;
      },
    });
  } finally {
    console.log = previousLog;
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
  }
  assert.equal(recordedBeforeEngine, true, 'the complete disclosure must be retained before engine creation');
  assert.equal(raw.some(line => line.includes('Execution boundary:')), false, 'hosted output must not bypass the frame');
});
test('ordinary Chat does not consume retained legacy Plan text', async () => {
  await withStdoutIsTTY(false, async () => {
    const ctx = makeReplContext(); ctx.state.pendingPlanBody = 'LEGACY_PLAN_CANARY'
    const observed: unknown[] = []
    const engine = createMockEngine({ status: 'completed', answer: 'done', usage: EMPTY_USAGE, conversation: [] })
    engine.submitMessage = async (...args) => { observed.push(args); return { status: 'completed', answer: 'done', usage: EMPTY_USAGE, conversation: [] } }
    engine.submitMessageStream = async function* (...args) { observed.push(args); yield { type: 'done', answer: 'done', usage: EMPTY_USAGE } as ChatEvent }
    await executeChatTask(ctx, 'hello', 'hello', makeTarget(), undefined, {
      ...testDeps, engineFactory: options => { observed.push(options); return engine },
    })
    assert.ok(observed.length >= 2)
    assert.equal(JSON.stringify(observed).includes('LEGACY_PLAN_CANARY'), false)
    assert.equal(ctx.state.pendingPlanBody, 'LEGACY_PLAN_CANARY')
  })
})
test('executeChatTask sets ctx.isRunning true during run and false after', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      let runningDuringSubmit = false;

      const engineFactory = () =>
        createMockEngine(
          {
            status: 'completed',
            answer: 'done',
            usage: EMPTY_USAGE,
            conversation: [],
          },
          {
            onSubmit: () => {
              runningDuringSubmit = ctx.isRunning;
            },
          },
        );

      await executeChatTask(ctx, 'hello', 'hello', target, undefined, {
        ...testDeps,
        engineFactory,
      });

      assert.equal(runningDuringSubmit, true);
      assert.equal(ctx.isRunning, false);
    });
  });
});

test('executeChatTask reuses ctx.chatEngine on second call', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      const sharedEngine = createMockEngine({
        status: 'completed',
        answer: 'first',
        usage: EMPTY_USAGE,
        conversation: [],
      });

      let factoryCallCount = 0;
      const engineFactory = (_options: ChatEngineOptions) => {
        factoryCallCount += 1;
        return sharedEngine;
      };

      await executeChatTask(ctx, 'first', 'first', target, undefined, {
        ...testDeps,
        engineFactory,
      });
      assert.equal(factoryCallCount, 1);
      assert.equal(ctx.chatEngine, sharedEngine);

      await executeChatTask(ctx, 'second', 'second', target, undefined, {
        ...testDeps,
        engineFactory,
      });
      assert.equal(factoryCallCount, 1, 'factory should not run when engine already on ctx');
      assert.equal(ctx.chatEngine, sharedEngine);
    });
  });
});

test('executeChatTask creates new engine when ctx.chatEngine is undefined', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      const created: ChatEngine[] = [];

      const engineFactory = (_options: ChatEngineOptions) => {
        const engine = createMockEngine({
          status: 'completed',
          answer: 'created',
          usage: EMPTY_USAGE,
          conversation: [],
        });
        created.push(engine);
        return engine;
      };

      assert.equal(ctx.chatEngine, undefined);
      await executeChatTask(ctx, 'task', 'task', target, undefined, {
        ...testDeps,
        engineFactory,
      });

      assert.equal(created.length, 1);
      assert.equal(ctx.chatEngine, created[0]);
    });
  });
});

test('executeChatTask forwards the truthful runtime mode into provider-bound prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-entry-mode-'));
  initMinimalGitProject(root);
  const runsDir = mkExternalRunsDir('babel-chat-entry-mode-runs-');
  const originalFetch = globalThis.fetch;
  const originalCi = process.env['CI'];
  const originalNoColor = process.env['NO_COLOR'];
  const originalProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const originalReadOnly = process.env['BABEL_READ_ONLY'];
  const originalRunsDir = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = runsDir;
  const stdout = process.stdout as { isTTY?: boolean };
  const originalIsTTY = stdout.isTTY;
  const prompts: string[] = [];
  const factoryModes: string[] = [];
  const ctx = makeReplContext();
  const target = makeTarget(root);

  delete process.env['CI'];
  delete process.env['NO_COLOR'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'read_only_audit';
  process.env['BABEL_READ_ONLY'] = 'true';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    prompts.push(body.messages.find((message) => message.role === 'system')?.content ?? '');
    return sseCompletion('entry mode fixture');
  };

  const run = async (isTTY: boolean) => {
    stdout.isTTY = isTTY;
    await executeChatTask(ctx, 'inspect runtime mode', 'inspect runtime mode', target, undefined, {
      ...testDeps,
      engineFactory: (options) => {
        factoryModes.push(options.runtimeMode ?? 'missing');
        return new ChatEngine({
          ...options,
          providerRunner: new OpenCodeGoApiRunner(
            'mimo-v2.5',
            {},
            { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' },
          ),
          providerPolicy: babelReviewModelPolicy('mimo-v2.5', root),
        });
      },
    });
  };

  try {
    await run(false);
    await run(true);
    assert.deepEqual(factoryModes, ['headless'], 'the second TUI turn must reuse the engine');
    assert.equal(prompts.length, 2);
    assert.match(prompts[0] ?? '', /Runtime mode: headless\./);
    assert.match(prompts[1] ?? '', /Runtime mode: tui\./);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalIsTTY === undefined) delete stdout.isTTY;
    else stdout.isTTY = originalIsTTY;
    ctx.chatEngine?.closeAdmissionStore?.();
    for (const [key, value] of [
      ['CI', originalCi],
      ['NO_COLOR', originalNoColor],
      ['BABEL_EXECUTION_PROFILE', originalProfile],
      ['BABEL_READ_ONLY', originalReadOnly],
      ['BABEL_RUNS_DIR', originalRunsDir],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(runsDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('executeChatTask prints answer to stdout in non-TTY mode', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      const writes: string[] = [];
      const originalLog = console.log;
      console.log = ((line?: unknown) => {
        writes.push(String(line ?? ''));
      }) as typeof console.log;

      try {
        await executeChatTask(ctx, 'ask', 'ask', target, undefined, {
          ...testDeps,
          engineFactory: () =>
            createMockEngine({
              status: 'completed',
              answer: 'visible answer',
              usage: EMPTY_USAGE,
              conversation: [],
            }),
        });
      } finally {
        console.log = originalLog;
      }

      assert.ok(writes.some((line) => line.includes('visible answer')));
    });
  });
});

test('executeChatTask calls appendTurn and updates conversation memory on success', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      let appendTurnCalls = 0;
      const originalAppendTurn = ctx.appendTurn;
      ctx.appendTurn = (turn) => {
        appendTurnCalls += 1;
        return originalAppendTurn.call(ctx, turn);
      };

      await executeChatTask(ctx, 'summarize', 'summarize', target, undefined, {
        ...testDeps,
        engineFactory: () =>
          createMockEngine({
            status: 'completed',
            answer: 'summary text',
            usage: EMPTY_USAGE,
            conversation: [],
          }),
      });

      assert.equal(appendTurnCalls, 1);
      assert.equal(ctx.lastAssistantAnswer, 'summary text');
      assert.equal(ctx.lastAssistantStatus, 'ANSWER_READY');
      // Legacy done events without an engine outcome recompute as
      // UNVERIFIED_PATCH, whose user status is not_verified (TF-08).
      assert.equal(ctx.state.lastRunUserStatus, 'not_verified');
      assert.equal(ctx.turns.length, 1);
      assert.equal(ctx.turns[0]?.answer, 'summary text');
    });
  });
});

test('executeChatTask sets lastRunUserStatus to failed on engine failure', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();

      await executeChatTask(ctx, 'fail task', 'fail task', target, undefined, {
        ...testDeps,
        engineFactory: () =>
          createMockEngine({
            status: 'failed',
            answer: 'model unavailable',
            usage: EMPTY_USAGE,
            conversation: [],
          }),
      });

      assert.equal(ctx.state.lastRunUserStatus, 'failed');
      assert.equal(ctx.lastAssistantStatus, 'NEEDS_MORE_CONTEXT');
      assert.equal(ctx.lastAssistantAnswer, 'model unavailable');
    });
  });
});

// D03 (C1): the production TUI card renderer must receive the structured reason
// from the ChatResult, not just the durable-session projection. Regression for
// the original defect where recovery exhaustion printed
// "Review the blocked capability".
test('executeChatTask renders recovery-exhaustion guidance in the TUI card', async () => {
  await withStdoutIsTTY(false, async () => {
    await withEnvUnset('CI', async () => {
      const ctx = makeReplContext();
      const target = makeTarget();
      const writes: string[] = [];
      const originalLog = console.log;
      console.log = ((line?: unknown) => {
        writes.push(String(line ?? ''));
      }) as typeof console.log;

      const terminalResult: ChatResult = {
        status: 'blocked',
        outcome: 'BLOCKED_POLICY',
        reason_code: 'recovery_exhausted',
        cause_class: 'model',
        answer: 'Repeated no-progress after recovery (8 cycles)',
        usage: EMPTY_USAGE,
        conversation: [],
        blockedReport: {
          schema_version: 1,
          status: 'BLOCKED',
          reason: 'Repeated no-progress after recovery',
          missing: 'Semantic progress',
          reason_code: 'recovery_exhausted',
          cause_class: 'model',
          checked: [{ action: 'progress_terminal', target: 'progress', finding: '8 cycles' }],
        },
      };

      const mockEngine = {
        submitMessage: async () => terminalResult,
        submitMessageStream: async function* () {
          yield {
            type: 'done',
            answer: terminalResult.answer,
            usage: EMPTY_USAGE,
            status: 'blocked',
            outcome: 'BLOCKED_POLICY',
            reason_code: 'recovery_exhausted',
            cause_class: 'model',
            blockedReport: terminalResult.blockedReport,
          } as ChatEvent;
        },
        cancel: () => undefined,
        abortTurn: () => undefined,
        getTaskAllowanceSnapshot: () => null,
      } as unknown as ChatEngine;

      try {
        await executeChatTask(
          ctx,
          'investigate the repo',
          'investigate the repo',
          target,
          undefined,
          { ...testDeps, engineFactory: () => mockEngine },
        );
      } finally {
        console.log = originalLog;
      }

      const rendered = writes.join('\n');
      assert.match(rendered, /No progress after recovery/);
      assert.match(rendered, /Inspect diagnostics/);
      assert.match(rendered, /Narrow scope/);
      assert.doesNotMatch(rendered, /Review the blocked capability/);
      assert.doesNotMatch(rendered, /Review permission/);
    });
  });
});
});
