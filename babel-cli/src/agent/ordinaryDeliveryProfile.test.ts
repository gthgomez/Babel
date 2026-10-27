/**
 * Opt-in ordinary_delivery profile — protocol/policy tests and transport-offline loops.
 * No benchmark lease, unlimited cost cap, or invented production pricing.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine, type ChatEvent, type ChatResult } from './chatEngine.js';
import { OpenCodeGoApiRunner, OPENCODE_GO_MODELS } from '../runners/openCodeGoApi.js';
import { OPENCODE_GO_BASE_URL } from '../runners/openCodeGoApi.js';
import { OpenCodeGoBudget } from '../runners/openCodeGoBudget.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { inspectSessionEventLogFromDir, type SessionEvent } from './sessionEvents.js';
import {
  evaluateCompletionGateForEngine,
  planCompletionGateReject,
  resolveCompletionVerificationContext,
  type GateToolLogEntry,
} from './completionGatePolicy.js';
import { createExecutorKernel } from '../executor/kernel.js';
import { unsupportedTestClaim } from './chatResponseEvidence.js';
import { getChatTaskTune, resolveChatTaskClass } from '../config/chatTaskClass.js';
import { presentChatReview } from '../ui/reviewCard.js';
import { projectTurnViewState, renderProjectedReviewCard } from '../interactive/projection/turnViewProjector.js';
import { consumeChatStream } from '../interactive/execution/chatCore.js';
import { getModelPricing } from '../services/modelPricingRegistry.js';
import { parseLeaseJson } from '../authority/lease.js';
import { DIFF_CRITIC_SYSTEM_PROMPT } from './diffCritic.js';
import { isBabelHeadlessEnv } from '../utils/envFlags.js';

/** Product route id — not registered under opencode-go in baseline registry metadata. */
const UNREGISTERED_GO_MODEL =
  OPENCODE_GO_MODELS.find((id) => id === 'deepseek-v4-flash') ?? OPENCODE_GO_MODELS[0];
/** Baseline-registered Go model (offline source metadata; not live billing proof). */
const REGISTERED_GO_MODEL_ID = 'deepseek-v4.1-flash';
const REGISTERED_GO_BACKEND_KEY = 'opencode-go/deepseek-v4.1-flash';
const GO_CHAT_COMPLETIONS = `${OPENCODE_GO_BASE_URL}/chat/completions`;

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_CHAT_TASK_CLASS',
  'BABEL_CHAT_SWE_PROFILE',
  'BABEL_AUTONOMY_CLASS',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
] as const;

let snapshot: Record<string, string | undefined> = {};

before(() => {
  snapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = snapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

function makeDeliveryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-ordinary-delivery-fixture-'));
  writeFileSync(join(root, 'data.csv'), 'product,gross,refunds\nA,100,20\nB,80,10\n', 'utf8');
  return root;
}

function readSessionEvents(runId: string): SessionEvent[] {
  const loaded = inspectSessionEventLogFromDir(chatSessionDir(runId), runId);
  return loaded.kind === 'valid' ? loaded.log.events : [];
}

function withOrdinaryDeliveryEnv(): void {
  process.env['BABEL_CHAT_TASK_CLASS'] = 'ordinary_delivery';
  delete process.env['BABEL_CHAT_SWE_PROFILE'];
}

function installNarrowFixtureLease(): void {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'ordinary-delivery-narrow-fixture',
      scope: { repository: 'fixture', objective: 'ordinary delivery profile offline protocol' },
      allowedCapabilities: ['inspect_repository', 'edit_task_files'],
    }),
  );
  assert.ok(parsed.ok);
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify(parsed.lease);
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
}

function clearNarrowFixtureLease(): void {
  delete process.env['BABEL_CHAT_TASK_CLASS'];
  delete process.env['BABEL_AUTONOMY_LEASE'];
  delete process.env['BABEL_EXECUTION_PROFILE'];
  delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
}

type FetchStep = {
  name: string | null;
  args: Record<string, unknown> | null;
  text?: string;
};

type GoChatWireBody = {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: unknown }>;
};

function wireBodyUsesDiffCriticSystem(body: GoChatWireBody): boolean {
  return (body.messages ?? []).some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes(DIFF_CRITIC_SYSTEM_PROMPT),
  );
}

function buildDiffCriticFixtureResponse(modelId: string): Response {
  return new Response(
    JSON.stringify({
      model: modelId,
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              verdict: 'pass',
              confidence: 1,
              reasons: ['Fixture transport: independent critic pass for ordinary_delivery offline loop.'],
            }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function stubGlobalFetchForGoChat(
  modelId: string,
  steps: FetchStep[],
): { restore: () => void; criticObserved: () => boolean } {
  const originalFetch = globalThis.fetch;
  let streamCall = 0;
  let criticObserved = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    assert.equal(url, GO_CHAT_COMPLETIONS, `unexpected fetch url: ${url}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as GoChatWireBody;
    assert.equal(body.model, modelId, `model normalization mismatch: sent=${body.model}`);
    if (wireBodyUsesDiffCriticSystem(body)) {
      criticObserved = true;
      return buildDiffCriticFixtureResponse(modelId);
    }
    if (body.stream !== true) {
      throw new Error(
        `unexpected Go chat wire shape (expected stream=true or diff critic system): stream=${String(body.stream)}`,
      );
    }
    const index = streamCall++;
    const step = steps[index] ?? { name: null, args: null, text: 'Done.' };
    const args = step.args;
    const delta =
      args === null
        ? { content: step.text ?? 'Done.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: `call-${index}`,
                type: 'function',
                function: { name: step.name, arguments: JSON.stringify(args) },
              },
            ],
          };
    return new Response(
      `data: ${JSON.stringify({
        model: modelId,
        choices: [{ delta, finish_reason: args === null ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    criticObserved: () => criticObserved,
  };
}

function assertHeadlessDiffCriticObserved(criticObserved: () => boolean): void {
  if (!isBabelHeadlessEnv()) return;
  assert.equal(
    criticObserved(),
    true,
    'headless CI must observe a non-stream diff critic provider call via DIFF_CRITIC_SYSTEM_PROMPT',
  );
}

/** Production OpenCodeGoApiRunner + durable budget ledger (required for v4.1-flash). */
function createRegisteredGoProductionRunner(budgetPath: string, runId: string): OpenCodeGoApiRunner {
  return new OpenCodeGoApiRunner(REGISTERED_GO_MODEL_ID, {}, {
    budget: new OpenCodeGoBudget({ statePath: budgetPath, jobId: runId, limitUsd: 2 }),
    credentialSource: 'explicit-test',
    explicitCredential: 'fixture-only',
    benchmarkRunId: runId,
  });
}

function assertFixtureTaskAllowanceComplete(engine: ChatEngine): void {
  const allowance = engine.getTaskAllowanceSnapshot();
  assert.ok(allowance, 'task allowance snapshot must exist for offline transport fixtures');
  assert.equal(allowance.consumed.unknownChargeCount ?? 0, 0, 'fixture runs must not leave unknown charges');
  assert.equal(Number.isFinite(allowance.consumed.costUsd), true, 'consumed costUsd must be finite');
  assert.ok(allowance.consumed.costUsd >= 0, 'consumed costUsd must be non-negative');
}

function fixtureFailureMessage(label: string, result: ChatResult, engine: ChatEngine): string {
  const allowance = engine.getTaskAllowanceSnapshot();
  const host = engine as unknown as {
    terminalLimiterReason?: string;
    gatePolicy?: string;
  };
  return [
    label,
    `outcome=${String(result.outcome)}`,
    `status=${String(result.status)}`,
    `answer=${String(result.answer ?? '').slice(0, 500)}`,
    `gatePolicy=${String(host.gatePolicy)}`,
    `terminalLimiterReason=${String(host.terminalLimiterReason ?? '')}`,
    `unknownChargeCount=${String(allowance?.consumed.unknownChargeCount ?? 'n/a')}`,
    `costUsd=${String(allowance?.consumed.costUsd ?? 'n/a')}`,
  ].join('\n');
}

describe('ordinary_delivery profile', { concurrency: false }, () => {
  test('[unit] registry metadata: opencode-go deepseek-v4.1-flash registered; deepseek-v4-flash not', () => {
    assert.ok(
      getModelPricing('opencode-go', REGISTERED_GO_MODEL_ID),
      'baseline registry must expose opencode-go:deepseek-v4.1-flash metadata',
    );
    assert.equal(
      getModelPricing('opencode-go', UNREGISTERED_GO_MODEL),
      null,
      'opencode-go:deepseek-v4-flash must not be invented in production registry',
    );
  });

  test('[unit] configuration gap: finite cap refuses paid dispatch when Go v4-flash pricing unknown', async () => {
    const root = makeDeliveryFixture();
    const runId = 'ordinary-delivery-pricing-gap';
    const runtime = mkdtempSync(join(tmpdir(), 'babel-ordinary-delivery-runtime-'));
    process.env['BABEL_RUNS_DIR'] = join(runtime, 'runs');
    withOrdinaryDeliveryEnv();
    installNarrowFixtureLease();

    const { restore: restoreFetch } = stubGlobalFetchForGoChat(UNREGISTERED_GO_MODEL, [
      { name: null, args: null, text: 'noop' },
    ]);

    try {
      const runner = new OpenCodeGoApiRunner(UNREGISTERED_GO_MODEL, {}, {
        credentialSource: 'explicit-test',
        explicitCredential: 'fixture-only',
      });
      const engine = new ChatEngine({
        task: 'Create summary.csv from data.csv with net totals.',
        projectRoot: root,
        runId,
        model: UNREGISTERED_GO_MODEL,
        providerRunner: runner,
        maxCostUsd: 2,
      });

      const result = await consumeChatStream(
        engine.submitMessageStream('Create summary.csv from data.csv with net totals.'),
        null,
      );
      assert.equal(result.outcome, 'INFRA_FAILURE', fixtureFailureMessage('pricing-gap', result, engine));
      assert.match(String(result.answer ?? ''), /COST_ACCOUNTING_INCOMPLETE:/);
    } finally {
      restoreFetch();
      rmSync(root, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
      clearNarrowFixtureLease();
    }
  });

  test('transport-offline: registered Go v4.1 production runner + fetch only completes UNVERIFIED_PATCH', async () => {
    const root = makeDeliveryFixture();
    const runId = 'ordinary-delivery-go-transport';
    const runtime = mkdtempSync(join(tmpdir(), 'babel-ordinary-delivery-runtime-'));
    process.env['BABEL_RUNS_DIR'] = join(runtime, 'runs');
    withOrdinaryDeliveryEnv();
    installNarrowFixtureLease();

    const { restore: restoreFetch, criticObserved } = stubGlobalFetchForGoChat(REGISTERED_GO_MODEL_ID, [
      {
        name: 'write_file',
        args: {
          path: 'summary.csv',
          content: 'product,gross,refunds,net\nA,100,20,80\nB,80,10,70\n',
        },
      },
      { name: null, args: null, text: 'Wrote summary.csv with net totals (150).' },
    ]);

    try {
      const budgetPath = join(runtime, 'go-budget.json');
      const runner = createRegisteredGoProductionRunner(budgetPath, runId);
      const engine = new ChatEngine({
        task: 'Create summary.csv from data.csv with net totals.',
        projectRoot: root,
        runId,
        model: REGISTERED_GO_BACKEND_KEY,
        providerRunner: runner,
      });

      assert.equal(getChatTaskTune('ordinary_delivery').verificationPolicy, 'none');
      const events: ChatEvent[] = [];
      const result = await consumeChatStream(
        (async function* () {
          for await (const event of engine.submitMessageStream(
            'Create summary.csv from data.csv with net totals.',
          )) {
            events.push(event);
            yield event;
          }
        })(),
        null,
      );
      if (result.outcome !== 'UNVERIFIED_PATCH') {
        assert.fail(fixtureFailureMessage('transport-offline UNVERIFIED_PATCH', result, engine));
      }
      assertFixtureTaskAllowanceComplete(engine);
      assert.equal((engine as unknown as { gatePolicy: string }).gatePolicy, 'none');
      assert.equal(existsSync(join(root, 'summary.csv')), true);
      assert.match(readFileSync(join(root, 'summary.csv'), 'utf8'), /net/);

      const sessionEvents = readSessionEvents(runId);
      assert.equal(
        sessionEvents.filter((event) => event.kind === 'verifier_attempt').length,
        0,
      );
      assert.equal((engine as unknown as { gateStrikes: number }).gateStrikes, 0);

      assert.equal(result.gatePolicy, 'none');
      const review = presentChatReview({
        outcome: result.outcome,
        changedFiles: ['summary.csv'],
        mutated: true,
        verification: { ran: false },
        verificationPolicy: result.gatePolicy,
      });
      assert.match(review.title, /unverified/i);
      assert.match(review.body, /Not run/);
      assertHeadlessDiffCriticObserved(criticObserved);
    } finally {
      restoreFetch();
      rmSync(root, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
      clearNarrowFixtureLease();
    }
  });

  test('[unit] projected review card uses actual gatePolicy none with unverified delivery label', () => {
    const view = projectTurnViewState([
      {
        type: 'mutation_batch_recorded',
        timestamp: 1,
        paths: ['summary.csv'],
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 2,
        outcome: 'UNVERIFIED_PATCH',
        status: 'completed',
        finalAnswer: 'Wrote summary.csv.',
      },
    ]);
    const card = renderProjectedReviewCard(view, { verificationPolicy: 'none' });
    assert.match(card.title, /unverified/i);
    assert.doesNotMatch(card.title, /Response complete/i);
  });

  test('transport-offline: host requiredVerifierCommands block after recovery (Go v4.1 + fetch only)', async () => {
    const root = makeDeliveryFixture();
    const runId = 'ordinary-delivery-required-host';
    const runtime = mkdtempSync(join(tmpdir(), 'babel-ordinary-delivery-runtime-'));
    process.env['BABEL_RUNS_DIR'] = join(runtime, 'runs');
    withOrdinaryDeliveryEnv();
    installNarrowFixtureLease();

    const steps: FetchStep[] = [];
    for (let i = 0; i < 12; i += 1) {
      steps.push(
        i % 2 === 0
          ? {
              name: 'write_file',
              args: { path: 'summary.csv', content: 'product,net\nA,80\n' },
            }
          : { name: null, args: null, text: 'Done without running tests.' },
      );
    }
    const { restore: restoreFetch } = stubGlobalFetchForGoChat(REGISTERED_GO_MODEL_ID, steps);

    try {
      const budgetPath = join(runtime, 'go-budget.json');
      const runner = createRegisteredGoProductionRunner(budgetPath, runId);
      const engine = new ChatEngine({
        task: 'Create summary.csv from data.csv.',
        projectRoot: root,
        runId,
        model: REGISTERED_GO_BACKEND_KEY,
        providerRunner: runner,
        requiredVerifierCommands: ['npm test'],
      });

      const result = await consumeChatStream(
        engine.submitMessageStream('Create summary.csv from data.csv.'),
        null,
      );
      assert.equal(existsSync(join(root, 'summary.csv')), true, 'fixture must record a real artifact mutation');
      assert.equal((engine as unknown as { gatePolicy: string }).gatePolicy, 'required');
      const answer = String(result.answer ?? '');
      assert.match(answer, /BLOCKED:/);
      assert.match(answer, /verifier|npm test|authoritative/i, 'blocked reason must cite verification policy, not generic BLOCKED only');
      assert.notEqual(result.outcome, 'UNVERIFIED_PATCH');
      const report = result.blockedReport;
      assert.ok(report);
      assert.equal(report.reason_code, 'recovery_exhausted');
      assert.equal(report.cause_class, 'harness');
      assert.match(String(report.reason), /verifier/i);
      assert.equal(
        report.checked.some((c) => c.target === 'verifier_honesty'),
        true,
        'blocked report must cite verifier honesty gate evidence',
      );
      assertFixtureTaskAllowanceComplete(engine);
      const ctx = resolveCompletionVerificationContext({
        taskClass: 'ordinary_delivery',
        task: 'Create summary.csv from data.csv.',
        requiredVerifierCommands: ['npm test'],
      });
      assert.equal(ctx.mandatoryVerifierContract, true);
      assert.equal(ctx.effectiveGatePolicy, 'required');
    } finally {
      restoreFetch();
      rmSync(root, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
      clearNarrowFixtureLease();
    }
  });

  test('[unit] effective policy matches across gate helper and recovery planner', () => {
    const write: GateToolLogEntry = {
      tool: 'write_file',
      target: 'summary.csv',
      detail: 'wrote',
      effect_status: 'confirmed_change',
      mutation_paths: ['summary.csv'],
    };
    const task = 'Create summary.csv from data.csv.';
    const required = ['npm test'];
    const ctx = resolveCompletionVerificationContext({
      taskClass: 'ordinary_delivery',
      task,
      requiredVerifierCommands: required,
      toolCallLog: [write],
    });
    const gate = evaluateCompletionGateForEngine({
      turnType: 'completion',
      taskIntent: 'execute',
      task,
      taskClass: 'ordinary_delivery',
      toolCallLog: [write],
      lastVerifierReceipt: null,
      executedVerifierLedger: [],
      requiredVerifierCommands: required,
    });
    assert.equal(gate, 'reject');
    const recovery = planCompletionGateReject({
      hasWrites: true,
      policy: ctx.effectiveGatePolicy,
      hardGate: false,
      hadToolCallsThisTurn: true,
      gateStrikes: 5,
      maxGateStrikes: 3,
      mandatoryVerifierContract: ctx.mandatoryVerifierContract,
    });
    assert.equal(recovery.kind, 'blocked');
  });

  test('[unit] default profile rejects the same delivery without a verifier', () => {
    const write: GateToolLogEntry = {
      tool: 'write_file',
      target: 'summary.csv',
      detail: 'wrote',
      effect_status: 'confirmed_change',
      mutation_paths: ['summary.csv'],
    };
    const task = 'Create summary.csv from data.csv with net totals.';
    const gate = evaluateCompletionGateForEngine({
      turnType: 'completion',
      taskIntent: 'execute',
      task,
      taskClass: 'default',
      toolCallLog: [write],
      lastVerifierReceipt: null,
      executedVerifierLedger: [],
    });
    assert.equal(gate, 'reject');
    assert.equal(getChatTaskTune('default').verificationPolicy, 'required');
  });

  test('[unit] host requiredVerifierCommands override ordinary_delivery none', () => {
    const write: GateToolLogEntry = {
      tool: 'write_file',
      target: 'summary.csv',
      detail: 'wrote',
      effect_status: 'confirmed_change',
      mutation_paths: ['summary.csv'],
    };
    const gate = evaluateCompletionGateForEngine({
      turnType: 'completion',
      taskIntent: 'execute',
      task: 'Create summary.csv from data.csv.',
      taskClass: 'ordinary_delivery',
      toolCallLog: [write],
      lastVerifierReceipt: null,
      executedVerifierLedger: [],
      requiredVerifierCommands: ['npm test'],
    });
    assert.equal(gate, 'reject');
  });

  test('[unit] explicit verify language escalates policy on ordinary_delivery', () => {
    const write: GateToolLogEntry = {
      tool: 'write_file',
      target: 'summary.csv',
      detail: 'wrote',
      effect_status: 'confirmed_change',
      mutation_paths: ['summary.csv'],
    };
    const gate = evaluateCompletionGateForEngine({
      turnType: 'completion',
      taskIntent: 'execute',
      task: 'Create summary.csv and run npm test before completing.',
      taskClass: 'ordinary_delivery',
      toolCallLog: [write],
      lastVerifierReceipt: null,
      executedVerifierLedger: [],
    });
    assert.equal(gate, 'reject');
  });

  test('transport-offline: unsupported test claims guarded (Go v4.1 + fetch only)', async () => {
    const root = makeDeliveryFixture();
    const runId = 'ordinary-delivery-unsupported-claim';
    const runtime = mkdtempSync(join(tmpdir(), 'babel-ordinary-delivery-runtime-'));
    process.env['BABEL_RUNS_DIR'] = join(runtime, 'runs');
    withOrdinaryDeliveryEnv();
    installNarrowFixtureLease();

    const { restore: restoreFetch, criticObserved } = stubGlobalFetchForGoChat(REGISTERED_GO_MODEL_ID, [
      { name: 'write_file', args: { path: 'summary.csv', content: 'x\n' } },
      { name: null, args: null, text: 'All tests passed. Summary ready.' },
      { name: null, args: null, text: 'Summary ready without claiming tests.' },
    ]);

    try {
      const budgetPath = join(runtime, 'go-budget.json');
      const runner = createRegisteredGoProductionRunner(budgetPath, runId);
      const engine = new ChatEngine({
        task: 'Create summary.csv from data.csv.',
        projectRoot: root,
        runId,
        model: REGISTERED_GO_BACKEND_KEY,
        providerRunner: runner,
      });
      const events: ChatEvent[] = [];
      const result = await consumeChatStream(
        (async function* () {
          for await (const event of engine.submitMessageStream('Create summary.csv from data.csv.')) {
            events.push(event);
            yield event;
          }
        })(),
        null,
      );
      assert.equal(unsupportedTestClaim('All tests passed.', null), true);
      assert.notEqual(result.outcome, 'VERIFIED_COMPLETE');
      const delivered = String(result.answer ?? '');
      assert.doesNotMatch(delivered, /All tests passed/i, 'delivered answer must not retain false test-success claim');
      assert.equal(
        events.some(
          (event) =>
            event.type === 'thought' &&
            /Correcting an unsupported test-result claim/.test(event.text ?? ''),
        ),
        true,
        'harness must observe evidence correction for unsupported test claim',
      );
      assertFixtureTaskAllowanceComplete(engine);
      assertHeadlessDiffCriticObserved(criticObserved);
    } finally {
      restoreFetch();
      rmSync(root, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
      clearNarrowFixtureLease();
    }
  });

  test('[unit] VERIFIED_COMPLETE is not promoted without proof on ordinary_delivery', () => {
    const write: GateToolLogEntry = {
      tool: 'write_file',
      target: 'summary.csv',
      detail: 'wrote',
    };
    const kernel = createExecutorKernel('chat');
    const decision = kernel.completion.decide({
      mode: 'chat',
      requestedOutcome: 'VERIFIED_COMPLETE',
      hasWrite: true,
      verificationPolicy: 'none',
      toolCallLog: [write],
      proof: { compliant: true, errors: [] },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.finalOutcome, 'UNVERIFIED_PATCH');
  });

  test('[unit] autonomy C/D with env ordinary_delivery resolves governance', () => {
    process.env['BABEL_AUTONOMY_CLASS'] = 'C';
    withOrdinaryDeliveryEnv();
    assert.equal(
      resolveChatTaskClass({
        env: process.env,
        autoClassify: false,
      }),
      'governance',
    );
    assert.equal(getChatTaskTune('governance').verificationPolicy, 'strict');
    delete process.env['BABEL_AUTONOMY_CLASS'];
    delete process.env['BABEL_CHAT_TASK_CLASS'];
  });
});
