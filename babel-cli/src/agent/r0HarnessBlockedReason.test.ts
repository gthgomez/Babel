/**
 * R0/W7 — harness-origin blocked reports must carry a typed reason.
 *
 * Adversarial audit finding (R0 bypass): the per-round token ceiling, the
 * text-only-loop hard stop, and the verifier-tamper auto-block all originate in
 * the HARNESS, yet two of them built a `BlockedReport` with no
 * `reason_code`/`cause_class`, and the tamper path depended on the model's
 * synthesized prose to even produce a report. With no typed reason,
 * `computeTerminalOutcome` fell through to the legacy prose regex and could
 * fabricate `BLOCKED_EXTERNAL` (external blame) — or, for tamper, a false
 * `completed` terminal.
 *
 * These tests drive the real production engine (streaming path) with a
 * deterministic scripted provider and assert the EXACT terminal outcome and
 * typed reason. No disjunctions.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import { initializeVerifierDependencyHashes } from './chatEngineVerifierSession.js';
import type { RunnerInvocationMetadata, ToolStreamEvent } from '../runners/base.js';

const MODEL = 'deepseek-v4-flash';

// ── Environment fixture (mirrors s07OrdinaryLoop: real loop, no network) ─────

interface EnvSnapshot {
  [key: string]: string | undefined;
}

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
] as const;

let envSnapshot: EnvSnapshot = {};
let runsRoot = '';

before(() => {
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  runsRoot = mkdtempSync(join(tmpdir(), 'babel-r0-harness-reason-runs-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'r0-harness-reason-lease',
    scope: { repository: 'r0-fixture', objective: 'deterministic harness-origin terminal reason' },
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
    const previous = envSnapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(runsRoot, { recursive: true, force: true });
});

// ── Fixture repository ───────────────────────────────────────────────────────

const PARSER_BUGGY = [
  'export function parseExpression(input: string): number {',
  "  const parts = input.split('+');",
  '  // Defect: subtracts instead of adding the operands.',
  '  return Number(parts[0]) - Number(parts[1]);',
  '}',
  '',
].join('\n');

const PARSER_FIXED = PARSER_BUGGY.replace(
  'return Number(parts[0]) - Number(parts[1]);',
  'return Number(parts[0]) + Number(parts[1]);',
);

interface Fixture {
  root: string;
  cleanup(): void;
}

function makeFixture(withVerifier: boolean): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'babel-r0-harness-reason-'));
  writeFileSync(join(root, 'parser.ts'), PARSER_BUGGY, 'utf8');
  if (withVerifier) {
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'r0-fixture', private: true, scripts: { test: 'node verify.mjs' } }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(root, 'verify.mjs'), '// verifier — independent check\n', 'utf8');
  }
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ── Scripted provider ────────────────────────────────────────────────────────

type Script = Array<ToolStreamEvent[]>;
type MetadataForCall = (call: number) => RunnerInvocationMetadata | null;
type OnYield = (event: ToolStreamEvent, call: number, engine: ChatEngine) => void;

interface ScriptedRunner {
  executeWithToolsStream: () => AsyncGenerator<ToolStreamEvent, void, undefined>;
  execute: () => Promise<{ type: string; answer: string }>;
  executeRaw: () => Promise<string>;
  getLastInvocationMetadata: () => RunnerInvocationMetadata | null;
  calls: () => number;
}

function metadata(promptTokens: number, completionTokens: number): RunnerInvocationMetadata {
  return {
    provider: 'scripted',
    provider_model_id: MODEL,
    latency_ms: 1,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated_cost_usd: 0,
  };
}

let activeEngine: ChatEngine | undefined;

function makeRunner(
  script: Script,
  metadataForCall?: MetadataForCall,
  onYield?: OnYield,
): ScriptedRunner {
  let call = 0;
  let lastMetadata: RunnerInvocationMetadata | null = null;
  const synthesisText = 'Synthesis complete. No further action is required.';
  return {
    calls: () => call,
    async *executeWithToolsStream() {
      const index = call;
      call += 1;
      lastMetadata = metadataForCall ? metadataForCall(index) : null;
      const events = script[index] ?? [
        { type: 'text_delta', text: 'No further action; concluding.' },
        { type: 'done', finishReason: 'stop' },
      ];
      for (const event of events) {
        yield event;
        if (activeEngine) onYield?.(event, index, activeEngine);
      }
    },
    async execute() {
      return { type: 'completion', answer: synthesisText };
    },
    async executeRaw() {
      return synthesisText;
    },
    getLastInvocationMetadata() {
      return lastMetadata;
    },
  };
}

function installRunner(engine: ChatEngine, runner: ScriptedRunner): void {
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  anyEngine.deliberationRunner = runner;
  anyEngine.synthesisRunner = runner;
  anyEngine.shouldUseNativeTools = () => true;
}

interface TerminalObservation {
  status: string;
  outcome: string | undefined;
  reasonCode: string | undefined;
  causeClass: string | null | undefined;
  blockedReasonCode: string | undefined;
  blockedCauseClass: string | null | undefined;
  blockedReason: string | undefined;
  answer: string;
  providerCalls: number;
}

async function drive(
  fixture: Fixture,
  task: string,
  script: Script,
  options: {
    taskIntent?: 'execute' | 'explain';
    maxTurns?: number;
    maxTokensPerRound?: number;
    metadataForCall?: MetadataForCall;
    onYield?: OnYield;
    configureEngine?: (engine: ChatEngine) => void;
  } = {},
): Promise<TerminalObservation> {
  const runId = `r0-harness-reason-${Math.random().toString(36).slice(2, 10)}`;
  const engine = new ChatEngine({
    task,
    projectRoot: fixture.root,
    runId,
    model: MODEL,
    maxTurns: options.maxTurns ?? 8,
    ...(options.maxTokensPerRound !== undefined
      ? { maxTokensPerRound: options.maxTokensPerRound }
      : {}),
  });
  const runner = makeRunner(script, options.metadataForCall, options.onYield);
  installRunner(engine, runner);
  activeEngine = engine;
  options.configureEngine?.(engine);

  const events: ChatEvent[] = [];
  try {
    for await (const event of engine.submitMessageStream(task, options.taskIntent ?? 'execute')) {
      events.push(event);
    }
  } finally {
    activeEngine = undefined;
  }
  const terminal = events[events.length - 1];
  assert.ok(terminal, 'engine yielded a terminal event');
  assert.ok(
    terminal.type === 'done' || terminal.type === 'failed' || terminal.type === 'cancelled',
    `terminal event is done/failed/cancelled, got ${terminal.type}`,
  );

  const done = terminal.type === 'done' ? terminal : undefined;
  return {
    status: terminal.status ?? terminal.type,
    outcome: 'outcome' in terminal ? terminal.outcome : undefined,
    reasonCode: 'reason_code' in terminal ? terminal.reason_code : undefined,
    causeClass: 'cause_class' in terminal ? terminal.cause_class : undefined,
    blockedReasonCode: done?.blockedReport?.reason_code,
    blockedCauseClass: done?.blockedReport?.cause_class,
    blockedReason: done?.blockedReport?.reason,
    answer: terminal.type === 'done' ? terminal.answer : terminal.type === 'failed' ? terminal.error : '',
    providerCalls: runner.calls(),
  };
}

// ── Reproductions ────────────────────────────────────────────────────────────

describe('R0/W7: harness-origin blocked reports carry a typed reason', () => {
  test('text-only-loop hard stop is recovery_exhausted/harness → BLOCKED_POLICY (never BLOCKED_EXTERNAL)', async () => {
    const fixture = makeFixture(false);
    try {
      // Every provider round is pure text with zero tool calls. After
      // TEXT_ONLY_FORCE_BLOCKED_THRESHOLD (5) turns the harness force-blocks.
      const o = await drive(fixture, 'Fix the bug in parser.ts', [], {
        taskIntent: 'execute',
        maxTurns: 8,
      });

      assert.equal(o.status, 'blocked');
      assert.equal(o.outcome, 'BLOCKED_POLICY');
      assert.equal(o.reasonCode, 'recovery_exhausted');
      assert.equal(o.causeClass, 'harness');
      assert.equal(o.blockedReasonCode, 'recovery_exhausted');
      assert.equal(o.blockedCauseClass, 'harness');
      assert.match(o.blockedReason ?? '', /text responses without tool calls/i);
      // The harness-origin block must never fabricate external blame.
      assert.notEqual(o.outcome, 'BLOCKED_EXTERNAL');
    } finally {
      fixture.cleanup();
    }
  });

  test('per-round token ceiling is budget_exhausted/harness → BUDGET_EXHAUSTED (never BLOCKED_EXTERNAL)', async () => {
    const fixture = makeFixture(false);
    try {
      // Turn 1: a real write so the session has writes (the end-of-turn token
      // explosion guard only fires with zero writes; with a prior write the R11
      // per-round ceiling is the terminal authority). Turn 2: a runaway
      // text-only round whose reported usage exceeds the ceiling.
      const o = await drive(
        fixture,
        'Fix the bug in parser.ts',
        [
          [
            {
              type: 'tool_use',
              id: 'w1',
              name: 'write_file',
              input: { path: 'parser.ts', content: PARSER_FIXED },
            },
            { type: 'done', finishReason: 'tool_calls' },
          ],
          [{ type: 'text_delta', text: 'Thinking about the fix…' }, { type: 'done', finishReason: 'stop' }],
        ],
        {
          taskIntent: 'execute',
          maxTurns: 6,
          maxTokensPerRound: 10_000,
          metadataForCall: (call) => (call === 0 ? metadata(10, 10) : metadata(30_000, 30_000)),
        },
      );

      assert.equal(o.outcome, 'BUDGET_EXHAUSTED');
      assert.equal(o.status, 'budget_exhausted');
      assert.equal(o.reasonCode, 'budget_exhausted');
      assert.equal(o.causeClass, 'harness');
      assert.equal(o.blockedReasonCode, 'budget_exhausted');
      assert.equal(o.blockedCauseClass, 'harness');
      assert.match(o.blockedReason ?? '', /Per-round token ceiling exceeded/i);
      assert.notEqual(o.outcome, 'BLOCKED_EXTERNAL');
    } finally {
      fixture.cleanup();
    }
  });

  test('verifier-tamper auto-block is a harness-origin block, not a prose-dependent completion', async () => {
    const fixture = makeFixture(true);
    try {
      // Three distinct writes to a verifier dependency (package.json) escalate
      // to __TAMPER_AUTO_BLOCKED__. The scripted synthesis runner returns prose
      // that does NOT declare BLOCKED, so a prose-dependent path would emit a
      // false `completed` terminal.
      const tampered = (n: number) =>
        `${JSON.stringify(
          { name: 'r0-fixture', private: true, scripts: { test: `node verify.mjs # ${n}` } },
          null,
          2,
        )}\n`;
      const writeTurn = (id: string, n: number): ToolStreamEvent[] => [
        { type: 'tool_use', id, name: 'write_file', input: { path: 'package.json', content: tampered(n) } },
        { type: 'done', finishReason: 'tool_calls' },
      ];

      const task = 'Fix the bug in parser.ts and run npm test to verify.';
      const o = await drive(
        fixture,
        task,
        [writeTurn('t1', 1), writeTurn('t2', 2), writeTurn('t3', 3)],
        {
          taskIntent: 'execute',
          maxTurns: 6,
          // The guard hashes are seeded in the constructor but a fresh
          // submission clears verifier evidence state; re-seed through the
          // production seeder just before the first tool executes so the
          // tamper path is actually exercised.
          onYield: (event, call, engine) => {
            if (call === 0 && event.type === 'tool_use') {
              const internals = engine as unknown as {
                verifierDependencyHashes: Map<string, string>;
              };
              initializeVerifierDependencyHashes(task, fixture.root, internals.verifierDependencyHashes);
            }
          },
        },
      );

      assert.equal(o.status, 'blocked');
      assert.equal(o.outcome, 'BLOCKED_POLICY');
      assert.equal(o.reasonCode, 'recovery_exhausted');
      assert.equal(o.causeClass, 'harness');
      assert.equal(o.blockedReasonCode, 'recovery_exhausted');
      assert.equal(o.blockedCauseClass, 'harness');
      assert.match(o.blockedReason ?? '', /Verifier integrity compromised/i);
      assert.notEqual(o.outcome, 'BLOCKED_EXTERNAL');
      assert.notEqual(o.outcome, 'UNVERIFIED_PATCH');
      assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED');
    } finally {
      fixture.cleanup();
    }
  });
});
