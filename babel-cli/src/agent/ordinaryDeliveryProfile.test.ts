/**
 * Opt-in ordinary_delivery profile — real ChatEngine loop, transport-only provider stub.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine } from './chatEngine.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { inspectSessionEventLogFromDir, type SessionEvent } from './sessionEvents.js';
import {
  evaluateCompletionGateForEngine,
  type GateToolLogEntry,
} from './completionGatePolicy.js';
import { createExecutorKernel } from '../executor/kernel.js';
import { unsupportedTestClaim } from './chatResponseEvidence.js';
import { getChatTaskTune, resolveChatTaskClass } from '../config/chatTaskClass.js';

const LOG_ROOT = join(tmpdir(), 'babel-ordinary-delivery-evidence');

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_CHAT_MAX_COST',
  'BABEL_CHAT_TASK_CLASS',
  'BABEL_CHAT_SWE_PROFILE',
] as const;

const FIXTURE_POLICY: ResolvedModelPolicy = {
  policyPath: 'test-fixture',
  family: 'test-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'test-fixture',
  provider: 'opencode-go',
  providerModelId: 'mimo-v2.5',
  expensive: false,
  enabled: true,
  experimental: true,
  blockedWithoutExplicitOptIn: false,
  approximateInputTokens: 0,
  approximateOutputTokens: 0,
  warnings: [],
  waterfall: [],
  stagePolicies: [],
  contextWindow: 128_000,
  contextLimit: 128_000,
  maxOutputTokens: 4_096,
  nativeToolUse: true,
};

let snapshot: Record<string, string | undefined> = {};

before(() => {
  snapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'ordinary-delivery-profile-lease',
    scope: { repository: 'fixture', objective: 'ordinary delivery profile qualification' },
    allowedCapabilities: [
      'inspect_repository',
      'search_repository',
      'run_arbitrary_code',
      'run_local_command',
      'run_tests',
      'edit_task_files',
    ],
  });
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited';
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

function stubFetchSequence(
  steps: Array<{ name: string | null; args: Record<string, unknown> | null; text?: string }>,
): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const index = call++;
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
        model: 'mimo-v2.5',
        choices: [{ delta, finish_reason: args === null ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

describe('ordinary_delivery profile', { concurrency: false }, () => {
  test('write + answer completes UNVERIFIED_PATCH without verifier loop', async () => {
    const root = makeDeliveryFixture();
    const runId = 'ordinary-delivery-profile';
    const runtime = mkdtempSync(join(tmpdir(), 'babel-ordinary-delivery-runtime-'));
    process.env['BABEL_RUNS_DIR'] = join(runtime, 'runs');
    delete process.env['BABEL_CHAT_TASK_CLASS'];
    delete process.env['BABEL_CHAT_SWE_PROFILE'];

    const restoreFetch = stubFetchSequence([
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
      const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
        credentialSource: 'explicit-test',
        explicitCredential: 'fixture-only',
      });
      const engine = new ChatEngine({
        task: 'Create summary.csv from data.csv with net totals.',
        projectRoot: root,
        runId,
        model: 'mimo-v2.5',
        maxTurns: 8,
        providerRunner: runner,
        providerPolicy: FIXTURE_POLICY,
        taskClass: 'ordinary_delivery',
      });
      assert.equal(getChatTaskTune('ordinary_delivery').verificationPolicy, 'none');

      const events = [];
      for await (const event of engine.submitMessageStream(
        'Create summary.csv from data.csv with net totals.',
      )) {
        events.push(event);
      }
      const terminal = events.at(-1);
      assert.equal(terminal?.type, 'done');
      if (terminal?.type === 'done') {
        assert.equal(terminal.outcome, 'UNVERIFIED_PATCH');
      }
      assert.equal((engine as unknown as { gatePolicy: string }).gatePolicy, 'none');
      assert.equal(existsSync(join(root, 'summary.csv')), true);
      assert.match(readFileSync(join(root, 'summary.csv'), 'utf8'), /net/);

      const sessionEvents = readSessionEvents(runId);
      const verifierAttempts = sessionEvents.filter((event) => event.kind === 'verifier_attempt');
      assert.equal(verifierAttempts.length, 0, 'no verifier loop on ordinary_delivery');

      const host = engine as unknown as { gateStrikes: number };
      assert.equal(host.gateStrikes, 0, 'completion gate did not enter recovery');
    } finally {
      restoreFetch();
      rmSync(root, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  test('default profile rejects the same delivery without a verifier', () => {
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

  test('host requiredVerifierCommands override ordinary_delivery none', () => {
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

  test('explicit verify language escalates policy on ordinary_delivery', () => {
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

  test('unsupported test claims are still guarded', () => {
    assert.equal(unsupportedTestClaim('All tests passed.', null), true);
  });

  test('VERIFIED_COMPLETE is not promoted without proof on ordinary_delivery', () => {
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

  test('host taskClass option selects ordinary_delivery without env', () => {
    const env = {} as NodeJS.ProcessEnv;
    assert.equal(
      resolveChatTaskClass({
        env,
        taskText: 'Create summary.csv from data.csv.',
        autoClassify: true,
        explicitClass: 'ordinary_delivery',
      }),
      'ordinary_delivery',
    );
  });
});
