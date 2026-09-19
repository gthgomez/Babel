/**
 * Regression: a successful authoritative verifier after a write must bind its
 * revision and settle the tool call exactly once.
 *
 * Before the fix, `captureChatVerifierReceipt` passed the governed mutation
 * path (absolute) into the revision binding, which requires repository-relative
 * scope paths. It threw; `executeOneAction`'s catch then recorded a *second*
 * terminal for the already-settled tool call, and the next provider request
 * aborted with `provider_protocol_valid: duplicate_tool_call_id`.
 *
 * This drives the real ChatEngine loop over the native tool_calls transport
 * (stubbed fetch), so it exercises the exact production seam rather than the
 * deliberation/synthesis injection used by the S07 scenario suite.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine } from './chatEngine.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { inspectSessionEventLogFromDir, type SessionEvent } from './sessionEvents.js';

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
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
    leaseId: 'verifier-loop-regression-lease',
    scope: { repository: 'fixture', objective: 'pin the write+verify loop' },
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
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = snapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-loop-'));
  writeFileSync(
    join(root, 'parser.ts'),
    "export function parseExpression(input: string): number {\n  const parts = input.split('+');\n  return Number(parts[0]) - Number(parts[1]);\n}\n",
    'utf8',
  );
  writeFileSync(
    join(root, 'verify.mjs'),
    "import { readFileSync } from 'node:fs';\nconst s = readFileSync(new URL('./parser.ts', import.meta.url), 'utf8');\nprocess.exit(s.includes('+ Number(parts[1])') ? 0 : 1);\n",
    'utf8',
  );
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node verify.mjs' } })}\n`,
    'utf8',
  );
  return root;
}

function readSessionEvents(runId: string): SessionEvent[] {
  const loaded = inspectSessionEventLogFromDir(chatSessionDir(runId), runId);
  return loaded.kind === 'valid' ? loaded.log.events : [];
}

describe('write + authoritative verifier settles exactly once', { concurrency: false }, () => {
  test('a successful npm test after str_replace binds a receipt and completes without protocol corruption', async () => {
    const root = makeFixture();
    const runId = 'verifier-loop-regression';
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    const originalFetch = globalThis.fetch;

    const toolNames: Array<string | null> = ['read_file', 'str_replace', 'run_command', null];
    const toolArgs: Array<Record<string, unknown> | null> = [
      { path: 'parser.ts' },
      {
        file_path: 'parser.ts',
        old_str: 'return Number(parts[0]) - Number(parts[1]);',
        new_str: 'return Number(parts[0]) + Number(parts[1]);',
      },
      { command: 'npm test' },
      null,
    ];
    let call = 0;
    globalThis.fetch = (async () => {
      const index = call++;
      const name = toolNames[index] ?? null;
      const args = toolArgs[index] ?? null;
      const delta =
        args === null
          ? { content: 'Fixed the operator and npm test passed.' }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${index}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
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

    try {
      const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
        credentialSource: 'explicit-test',
        explicitCredential: 'fixture-only',
      });
      const engine = new ChatEngine({
        task: 'Investigate why parser_test fails and fix it.',
        projectRoot: root,
        runId,
        model: 'mimo-v2.5',
        maxTurns: 8,
        providerRunner: runner,
        providerPolicy: FIXTURE_POLICY,
      });
      const events = [];
      for await (const event of engine.submitMessageStream('Investigate why parser_test fails and fix it.')) {
        events.push(event);
      }
      const terminal = events.at(-1);
      assert.equal(terminal?.type, 'done', 'the write+verify loop terminates instead of aborting');
      assert.equal(readFileSync(join(root, 'parser.ts'), 'utf8').includes('+ Number(parts[1])'), true);

      const sessionEvents = readSessionEvents(runId);
      const verifierTerminals = sessionEvents.filter(
        (event) =>
          (event.kind === 'tool_completed' || event.kind === 'tool_failed') &&
          event.tool_call_id === 'call-2',
      );
      assert.equal(verifierTerminals.length, 1, 'the verifier tool call has exactly one durable terminal');
      const verifierAttempts = sessionEvents.filter((event) => event.kind === 'verifier_attempt');
      assert.ok(verifierAttempts.length >= 1, 'the authoritative verifier receipt was recorded');
      assert.equal(
        verifierAttempts.some((event) => (event as { authoritative?: boolean }).authoritative === true),
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
