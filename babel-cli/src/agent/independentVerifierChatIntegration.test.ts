/**
 * Integration: governed absolute mutation_batch paths → Chat completion proof →
 * IndependentVerifier → terminal outcome.
 *
 * Unit tests on independentVerifierProofErrors alone do not exercise SessionEventV1
 * recording or ChatEngine finalization. This drives the real write+verify loop with
 * a scripted provider (same seam as verifierReceiptLoop.test.ts).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine } from './chatEngine.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { inspectSessionEventLogFromDir, type SessionEvent } from './sessionEvents.js';
import {
  bindChatVerifierReceipt,
  evaluateChatCompletionProof,
  mutationPathsFromSessionEvents,
  type BoundChatVerifierReceipt,
} from '../evidence/chatRevisionBinding.js';
import {
  IndependentVerifier,
  INDEPENDENT_VERIFIER_ENV,
  isIndependentVerifierOptIn,
} from '../evidence/independentVerifier.js';
import { isAuthoritativeVerifierCommand } from './completionGatePolicy.js';
import { checkVerifierTamper, initializeVerifierDependencyHashes } from './chatEngineVerifierSession.js';

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_CHAT_MAX_COST',
  INDEPENDENT_VERIFIER_ENV,
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

const TASK = [
  'Investigate why parser_test fails and fix it.',
  'Requirements:',
  '- `npm test` must pass.',
].join('\n');

let snapshot: Record<string, string | undefined> = {};

/** Pre-fix independent proof path (no repository-relative normalization). */
function baselineIndependentProofErrors(input: {
  projectRoot: string;
  command: string;
  exitCode: number;
  mutationPaths: readonly string[];
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = input.env ?? process.env;
  if (!isIndependentVerifierOptIn(env)) return [];
  if (input.exitCode !== 0) {
    return ['independent clean-room verifier skipped: primary receipt not green'];
  }
  try {
    const independent = IndependentVerifier.runIsolatedVerificationSync(
      input.projectRoot,
      input.command,
      [...input.mutationPaths],
    );
    if (independent.exitCode !== 0) {
      return [`independent clean-room verifier failed (exit ${independent.exitCode})`];
    }
    return [];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return [`independent clean-room verifier unavailable: ${message}`];
  }
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-iv-chat-integration-'));
  writeFileSync(
    join(root, 'parser.ts'),
    "export function parseExpression(input: string): number {\n  const parts = input.split('+');\n  return Number(parts[0]) - Number(parts[1]);\n}\n",
    'utf8',
  );
  writeFileSync(
    join(root, 'verify.mjs'),
    "import { readFileSync } from 'node:fs';\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\nconst s = readFileSync(new URL('./parser.ts', import.meta.url), 'utf8');\ntest('the operator is repaired', () => assert.ok(s.includes('+ Number(parts[1])')));\n",
    'utf8',
  );
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test --test-reporter=tap verify.mjs' } })}\n`,
    'utf8',
  );
  return root;
}

function readSessionEvents(runId: string): SessionEvent[] {
  const loaded = inspectSessionEventLogFromDir(chatSessionDir(runId), runId);
  return loaded.kind === 'valid' ? loaded.log.events : [];
}

/** Durable session receipt used by completion proof (not a widened engine cast). */
function latestAuthoritativeVerifierReceipt(events: SessionEvent[]): BoundChatVerifierReceipt {
  const attempts = events.filter(
    (event): event is Extract<SessionEvent, { kind: 'verifier_attempt' }> =>
      event.kind === 'verifier_attempt' && event.authoritative === true,
  );
  assert.ok(attempts.length >= 1, 'expected authoritative verifier_attempt in session log');
  for (let index = attempts.length - 1; index >= 0; index--) {
    const receipt = attempts[index]?.receipt;
    if (receipt === undefined) continue;
    assert.equal(typeof receipt.command, 'string');
    assert.equal(typeof receipt.exit_code, 'number');
    assert.equal(typeof receipt.summary, 'string');
    return receipt;
  }
  throw new Error('no durable verifier receipt on authoritative attempts');
}

before(() => {
  snapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'iv-chat-integration-lease',
    scope: { repository: 'fixture', objective: 'independent verifier completion integration' },
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
  process.env[INDEPENDENT_VERIFIER_ENV] = '1';
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = snapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe('Chat finalization with IndependentVerifier and absolute mutation_batch paths', { concurrency: false }, () => {
  test('scripted write + npm test: baseline proof fails, production path verifies with structured test evidence', async () => {
    const root = makeFixture();
    const runId = 'iv-chat-integration-pass';
    const runtime = mkdtempSync(join(tmpdir(), 'babel-iv-chat-runtime-'));
    process.env['BABEL_RUNS_DIR'] = join(runtime, 'runs');
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
          ? { content: 'Fixed parser.ts and npm test passed.' }
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
        task: TASK,
        projectRoot: root,
        runId,
        model: 'mimo-v2.5',
        maxTurns: 8,
        providerRunner: runner,
        providerPolicy: FIXTURE_POLICY,
      });

      const streamEvents = [];
      for await (const event of engine.submitMessageStream(TASK)) streamEvents.push(event);
      const terminal = streamEvents.at(-1);
      assert.equal(terminal?.type, 'done', `expected completion stream: ${JSON.stringify(terminal)}`);
      assert.equal(terminal.type === 'done' ? terminal.outcome : null, 'VERIFIED_COMPLETE',
        `host terminal must carry verified completion authority, not a bare green command claim`);

      assert.equal(readFileSync(join(root, 'parser.ts'), 'utf8').includes('+ Number(parts[1])'), true);

      const sessionEvents = readSessionEvents(runId);
      const receipt = latestAuthoritativeVerifierReceipt(sessionEvents);
      assert.equal(receipt.stale, false);
      assert.equal(receipt.exit_code, 0);
      assert.ok((receipt.tests_total ?? 0) >= 1, 'receipt carries structured runner counts, not exit code alone');
      assert.equal(receipt.tests_failed ?? 0, 0);
      const batches = sessionEvents.filter((event) => event.kind === 'mutation_batch');
      assert.ok(batches.length >= 1, 'durable mutation_batch evidence exists');
      const mutationPaths = mutationPathsFromSessionEvents(sessionEvents);
      assert.ok(mutationPaths.length >= 1);
      assert.ok(
        mutationPaths.every((path) => isAbsolute(path) || path.includes('parser.ts')),
        `mutation_batch paths are governed absolute paths: ${JSON.stringify(mutationPaths)}`,
      );
      assert.ok(
        mutationPaths.some((path) => isAbsolute(path) && resolve(path) === resolve(root, 'parser.ts')),
        `at least one absolute path points at the repaired file: ${JSON.stringify(mutationPaths)}`,
      );

      const proofEnv = { ...process.env, [INDEPENDENT_VERIFIER_ENV]: '1' };
      const productionProof = evaluateChatCompletionProof({
        projectRoot: root,
        hasMutation: true,
        verifierTampered: false,
        receipt,
        events: sessionEvents,
        isAuthoritativeCommand: isAuthoritativeVerifierCommand,
        env: proofEnv,
      });
      assert.equal(productionProof.compliant, true, `production completion proof: ${productionProof.errors?.join('; ')}`);
      assert.ok(
        !productionProof.errors?.some((error) => /independent clean-room verifier unavailable/i.test(error)),
        'normalized path must reach clean-room verification, not fail before run',
      );
      assert.ok(
        !productionProof.errors?.some((error) => /independent clean-room verifier skipped/i.test(error)),
        'clean-room must run when primary receipt is green and IV is enabled',
      );

      const baselineErrors = baselineIndependentProofErrors({
        projectRoot: root,
        command: receipt.command,
        exitCode: receipt.exit_code,
        mutationPaths,
        env: proofEnv,
      });
      assert.ok(
        baselineErrors.some((error) => /repository-relative/i.test(error)),
        `pre-fix path must fail on absolute batches (baseline): ${baselineErrors.join('; ')}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  test('npm test oracle freeze is package.json + verify.mjs only (#506 core-owned Chat custody)', () => {
    const root = makeFixture();
    try {
      const hashes = new Map<string, string>();
      initializeVerifierDependencyHashes(TASK, root, hashes, ['npm test']);
      assert.equal(hashes.size, 2);
      assert.ok(hashes.has('package.json'));
      assert.ok(hashes.has('verify.mjs'));
      assert.equal(hashes.has('parser.ts'), false);
      const state = {
        verifierDependencyHashes: hashes,
        verifierTampered: false,
        tamperCount: 0,
        tamperedThisTurn: false,
      };
      assert.equal(
        checkVerifierTamper('parser.ts', root, state),
        null,
        'parser.ts is authorized task subject, not protected verifier oracle (behavioral repair is not tamper)',
      );
      writeFileSync(join(root, 'verify.mjs'), 'export {}\n');
      assert.ok(checkVerifierTamper('verify.mjs', root, state));
      assert.equal(state.verifierTampered, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('escape absolute mutation path fails closed under IndependentVerifier (negative control)', async () => {
    const root = makeFixture();
    const outside = mkdtempSync(join(tmpdir(), 'babel-iv-outside-'));
    writeFileSync(join(outside, 'leak.ts'), 'leak\n');
    try {
      const sessionEvents: SessionEvent[] = [
        {
          kind: 'mutation_batch',
          paths: [join(outside, 'leak.ts')],
        } as SessionEvent,
        {
          kind: 'verifier_attempt',
          authoritative: true,
          exit_code: 0,
        } as SessionEvent,
      ];
      const receipt = await bindChatVerifierReceipt({
        projectRoot: root,
        command: 'node --test --test-reporter=tap verify.mjs',
        exit_code: 0,
        summary: '1 test passed',
        mutationPaths: ['parser.ts'],
        structured: {
          verifierId: 'node-test',
          authoritySource: 'built_in_runner',
          executable: 'node',
          args: ['--test', '--test-reporter=tap', 'verify.mjs'],
        },
      });
      const proof = evaluateChatCompletionProof({
        projectRoot: root,
        hasMutation: true,
        verifierTampered: false,
        receipt,
        events: sessionEvents,
        isAuthoritativeCommand: isAuthoritativeVerifierCommand,
        env: { ...process.env, [INDEPENDENT_VERIFIER_ENV]: '1' },
      });
      assert.equal(proof.compliant, false);
      assert.ok(
        proof.errors?.some((error) => /escapes project root|independent clean-room verifier/i.test(error)),
        `escape path must not certify completion: ${proof.errors?.join('; ')}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
