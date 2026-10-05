/**
 * Regression: a PROVEN no-op write must not invalidate a current verifier
 * receipt (chat-reliability-20261004 / G01 root cause).
 *
 * Captured live twice (chat-a3e9f0b63ef8 seq 655-663 and the G01 rerun
 * chat-73eb540c6c5a): the model runs an authoritative verifier (green), then
 * rewrites a file with its byte-identical content. The committed mutation
 * receipt proves an identical post-state (equal pre/post image hashes,
 * changed_bytes 0), so the workspace revision the receipt bound is still
 * exactly current — yet the executor's catch-all "direct mutation effect not
 * confirmed" invalidation marked the receipt stale. The next in-turn P11
 * context install then found no non-stale receipt
 * (population_incomplete → prepare_blocked), provider dispatch was refused,
 * and the run collapsed to NEEDS_MORE_CONTEXT with the workspace untouched.
 *
 * Contract under test: only a real change or an indeterminate effect
 * invalidates verifier evidence; a proven no-op write keeps the receipt
 * authoritative and the turn completes honestly.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { assessMutationEffect } from './mutationTools.js';

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_CHAT_MAX_COST',
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
    leaseId: 'noop-write-verifier-lease',
    scope: { repository: 'fixture', objective: 'no-op writes keep verifier receipts current' },
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
  // The fixture model has no published pricing; a finite cost cap refuses the
  // second dispatch on 'unknown pricing' before the scenario can play out.
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = snapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

function makeFixture(): { root: string; fixedContent: string } {
  const root = mkdtempSync(join(tmpdir(), 'babel-noop-write-'));
  const fixedContent = 'export function add(a, b) {\n  return a + b;\n}\n';
  writeFileSync(join(root, 'src.add.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node verify.mjs' } })}\n`,
    'utf8',
  );
  writeFileSync(join(root, 'verify.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync('verify.out', 'run\\n');\nprocess.exit(0);\n", 'utf8');
  // The verifier receipt binds to a Git revision; seed the fixture repo.
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '--quiet']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'fixture']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'fixture baseline']);
  return { root, fixedContent };
}

interface ToolCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type TurnSpec =
  | { kind: 'tools'; toolCalls: ToolCallSpec[]; text?: string }
  | { kind: 'text'; text: string };

function installTurns(turns: TurnSpec[]): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const turn = turns[call++];
    if (!turn) {
      return new Response('no more turns', { status: 500 });
    }
    const delta =
      turn.kind === 'text'
        ? { content: turn.text }
        : {
            ...(turn.text ? { content: turn.text } : {}),
            tool_calls: turn.toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          };
    return new Response(
      `data: ${JSON.stringify({
        model: 'mimo-v2.5',
        choices: [
          { delta, finish_reason: turn.kind === 'text' ? 'stop' : 'tool_calls' },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeEngine(root: string, runId: string, task: string): ChatEngine {
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'fixture-only',
  });
  return new ChatEngine({
    task,
    projectRoot: root,
    runId,
    model: 'mimo-v2.5',
    maxTurns: 8,
    providerRunner: runner,
    providerPolicy: FIXTURE_POLICY,
  });
}


async function drain(engine: ChatEngine, message: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of engine.submitMessageStream(message)) {
    events.push(event);
  }
  return events;
}

describe('proven no-op writes keep verifier receipts current', { concurrency: false }, () => {
  test('assessMutationEffect classifies a committed byte-identical receipt as confirmed_no_change', () => {
    const effect = assessMutationEffect({
      tool: 'write_file',
      exitCode: 0,
      mutationPaths: ['src.add.js'],
      mutationReceipt: {
        status: 'committed',
        changedBytes: 0,
        preImageHashes: { 'src.add.js': 'hash-a' },
        postImageHashes: { 'src.add.js': 'hash-a' },
      },
    });
    assert.equal(effect.status, 'confirmed_no_change');
    assert.match(effect.reason, /identical post-state/);
  });

  test('a byte-identical write_file after a green verifier keeps the receipt authoritative', async () => {
    const { root, fixedContent } = makeFixture();
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    // Submission 1: fix the file (a real change ends the submission in this profile).
    // Submission 2 (continued task): verify green, then the G01 wedge — rewrite
    // the file with its EXACT current content. The verifier's bound scope
    // includes src.add.js from submission 1's mutation batch.
    const restore = installTurns([
      { kind: 'tools', toolCalls: [{ id: 'call-fix', name: 'write_file', args: { path: 'src.add.js', content: fixedContent } }] },
      { kind: 'tools', toolCalls: [{ id: 'call-verify', name: 'run_command', args: { command: 'npm test' } }] },
      { kind: 'tools', toolCalls: [{ id: 'call-noop-write', name: 'write_file', args: { path: 'src.add.js', content: fixedContent } }] },
      { kind: 'text', text: 'Verified and confirmed unchanged.' },
    ]);
    try {
      const engine = makeEngine(root, 'noop-write-verifier', 'Fix add, verify, confirm, and report.');
      const events: ChatEvent[] = await drain(engine, 'Fix add, verify, confirm, and report.');
      const receipt = (
        engine as unknown as { lastVerifierReceipt: { stale?: boolean; staleReason?: string } | null }
      ).lastVerifierReceipt;
      assert.ok(receipt, 'an authoritative green verifier binds a receipt');
      assert.equal(
        receipt.stale,
        false,
        'a proven no-op write must not invalidate a receipt that is still revision-current',
      );
      const failed = events.filter(
        (event) =>
          event.type === 'failed' ||
          (event as { error?: string }).error?.toString().includes('P11 context installation was blocked'),
      );
      assert.equal(failed.length, 0, 'the turn must not collapse into an install refusal');
      const done = events.some((event) => event.type === 'done');
      assert.equal(done, true, 'the turn completes honestly');
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
