/**
 * R0/W4 — settlement truth identity (positional `settleCallIds` adversarial audit).
 *
 * The repaired #221 class assigns UI terminal ids with
 * `tc.toolCallId = settleCallIds[settlementIndex]` where `settlementIndex` is the
 * position in the sorted turn slice (chatEngine.ts ~3483-3501). That is only
 * sound while executed action indices are exactly the prefix {0..m-1} and every
 * executed action logs exactly one row.
 *
 * These tests drive the REAL ChatEngine native tool loop (stubbed provider
 * transport) to test that hypothesis instead of trusting it:
 *   - reverse-completion parallel reads keep every terminal on its own start id
 *   - a mid-batch operator abort settles exactly one terminal per EXECUTED id
 *     and none for unattempted ids
 *   - a multi-action turn emits exactly one durable terminal per provider id
 *
 * No production behavior is modified; teardown awaits the sandbox termination
 * latch so a cancelled foreground child cannot hold the fixture directory on
 * Windows after the settlement assertions have already passed. Private fields
 * are only read.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { inspectSessionEventLogFromDir, type SessionEvent } from './sessionEvents.js';
import { awaitPendingProcessTerminations } from '../sandbox.js';

/**
 * Windows can keep a directory locked for a moment after a forced tree kill
 * while the OS releases handles. Retry the fixture delete a bounded number of
 * times; the settlement assertions never sleep or retry.
 */
async function removeFixtureDir(root: string): Promise<void> {
  const retryDelaysMs = [20, 40, 80, 160, 320];
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code ?? '');
      if (!retryable || attempt >= retryDelaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]!));
    }
  }
}

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
    leaseId: 'settlement-identity-lease',
    scope: { repository: 'fixture', objective: 'settle tool identity truthfully' },
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

interface ToolCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type TurnSpec =
  | { kind: 'tools'; toolCalls: ToolCallSpec[]; text?: string }
  | { kind: 'text'; text: string };

function makeFixture(opts?: { bigBytes?: number; slowVerifyMs?: number }): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-settlement-identity-'));
  writeFileSync(join(root, 'a.txt'), 'alpha\n', 'utf8');
  writeFileSync(join(root, 'b.txt'), 'bravo\n', 'utf8');
  writeFileSync(join(root, 'c.txt'), 'charlie\n', 'utf8');
  if (opts?.bigBytes) {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(opts.bigBytes), 'utf8');
  }
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node verify.mjs' } })}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, 'verify.mjs'),
    opts?.slowVerifyMs
      ? `await new Promise((resolve) => setTimeout(resolve, ${opts.slowVerifyMs}));\nprocess.exit(0);\n`
      : 'process.exit(0);\n',
    'utf8',
  );
  return root;
}

/** Install a provider stub that returns the given turns in order. */
function installTurns(turns: TurnSpec[]): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const turn = turns[call++];
    if (!turn) {
      return new Response(
        `data: ${JSON.stringify({
          model: 'mimo-v2.5',
          choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })}\n\ndata: [DONE]\n\n`,
        { status: 200 },
      );
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
          {
            delta,
            finish_reason: turn.kind === 'text' ? 'stop' : 'tool_calls',
          },
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

function readSessionEvents(runId: string): SessionEvent[] {
  const loaded = inspectSessionEventLogFromDir(chatSessionDir(runId), runId);
  return loaded.kind === 'valid' ? loaded.log.events : [];
}

function terminalEvents(events: readonly ChatEvent[]): Array<Extract<ChatEvent, { type: 'tool_complete' | 'tool_failed' }>> {
  return events.filter(
    (event): event is Extract<ChatEvent, { type: 'tool_complete' | 'tool_failed' }> =>
      event.type === 'tool_complete' || event.type === 'tool_failed',
  );
}

function startEvents(events: readonly ChatEvent[]): Array<Extract<ChatEvent, { type: 'tool_start' }>> {
  return events.filter(
    (event): event is Extract<ChatEvent, { type: 'tool_start' }> => event.type === 'tool_start',
  );
}

describe('settlement identity — positional settleCallIds invariant', { concurrency: false }, () => {
  test('multi-action native turn: every terminal keeps its own tool_start id', async () => {
    const root = makeFixture();
    const runId = 'settle-identity-multi';
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    const restore = installTurns([
      {
        kind: 'tools',
        toolCalls: [
          { id: 'call-0', name: 'read_file', args: { path: 'a.txt' } },
          { id: 'call-1', name: 'read_file', args: { path: 'b.txt' } },
          { id: 'call-2', name: 'read_file', args: { path: 'c.txt' } },
        ],
      },
      { kind: 'text', text: 'Read all three files.' },
    ]);
    try {
      const engine = makeEngine(root, runId, 'Read a.txt, b.txt and c.txt and summarize.');
      const events: ChatEvent[] = [];
      for await (const event of engine.submitMessageStream('Read a.txt, b.txt and c.txt and summarize.')) {
        events.push(event);
      }

      const starts = startEvents(events);
      const terminals = terminalEvents(events);
      assert.equal(starts.length, 3, 'three tool_start events');
      assert.equal(terminals.length, 3, 'three tool terminals');

      // Identity: terminal id must equal the start id for the same target.
      const startIdByTarget = new Map(starts.map((s) => [s.target, s.toolCallId]));
      for (const terminal of terminals) {
        assert.equal(
          terminal.toolCallId,
          startIdByTarget.get(terminal.target),
          `terminal for ${terminal.target} must reuse its start id`,
        );
      }
      assert.deepEqual(
        starts.map((s) => s.toolCallId),
        ['call-0', 'call-1', 'call-2'],
      );

      // Durable session events: exactly one terminal per provider id.
      const sessionEvents = readSessionEvents(runId);
      for (const id of ['call-0', 'call-1', 'call-2']) {
        const durableTerminals = sessionEvents.filter(
          (event) =>
            (event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled') &&
            event.tool_call_id === id,
        );
        assert.equal(durableTerminals.length, 1, `exactly one durable terminal for ${id}`);
      }
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reverse-completion parallel reads still map ids by original action index', async () => {
    const root = makeFixture({ bigBytes: 64 });
    const runId = 'settle-identity-reverse';
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    const restore = installTurns([
      {
        kind: 'tools',
        toolCalls: [
          { id: 'call-slow', name: 'read_file', args: { path: 'big.txt' } },
          { id: 'call-fast', name: 'read_file', args: { path: 'a.txt' } },
        ],
      },
      { kind: 'text', text: 'Read both files.' },
    ]);
    try {
      const engine = makeEngine(root, runId, 'Read big.txt then a.txt.');
      // Deterministic reverse-completion seam (same injection used by the
      // session-event lifecycle live test): delay action index 0 so the
      // parallel read at index 1 finishes first and is logged first.
      const anyEngine = engine as unknown as {
        executeOneAction: (...args: unknown[]) => Promise<unknown>;
      };
      const original = anyEngine.executeOneAction.bind(engine);
      anyEngine.executeOneAction = async (...args: unknown[]) => {
        const meta = args[3] as { index: number };
        if (meta.index === 0) await new Promise((resolve) => setTimeout(resolve, 60));
        return original(...args);
      };

      const events: ChatEvent[] = [];
      for await (const event of engine.submitMessageStream('Read big.txt then a.txt.')) {
        events.push(event);
      }

      const starts = startEvents(events);
      const terminals = terminalEvents(events);
      assert.equal(terminals.length, 2);
      const startIdByTarget = new Map(starts.map((s) => [s.target, s.toolCallId]));
      for (const terminal of terminals) {
        assert.equal(
          terminal.toolCallId,
          startIdByTarget.get(terminal.target),
          `terminal for ${terminal.target} must reuse its start id`,
        );
      }
      // Emitted terminals are sorted by original action index even though the
      // underlying reads completed [1, 0].
      assert.deepEqual(terminals.map((t) => t.toolCallId), ['call-slow', 'call-fast']);

      // Prove the raw log actually completed out of order.
      const rawLog = (engine as unknown as { toolCallLog: Array<{ index: number; target: string }> }).toolCallLog;
      const readRows = rawLog.filter((row) => row.target === 'big.txt' || row.target === 'a.txt');
      const order = readRows.map((row) => row.index);
      assert.deepEqual(order, [1, 0], 'parallel reads completed in reverse action order');
      let reorders = 0;
      for (let i = 0; i < order.length; i += 1) {
        for (let j = i + 1; j < order.length; j += 1) {
          if (order[i]! > order[j]!) reorders += 1;
        }
      }
      assert.equal(reorders, 1, 'reverse-completion topology exercised');
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('forced mid-batch abort settles one terminal per executed id, none for unattempted', async () => {
    const root = makeFixture({ slowVerifyMs: 3_000 });
    const runId = 'settle-identity-cancel';
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    const restore = installTurns([
      {
        kind: 'tools',
        toolCalls: [
          {
            id: 'call-slow',
            name: 'run_command',
            args: { command: 'npm test' },
          },
          { id: 'call-a', name: 'read_file', args: { path: 'a.txt' } },
          { id: 'call-b', name: 'read_file', args: { path: 'b.txt' } },
        ],
      },
      { kind: 'text', text: 'never reached' },
    ]);
    try {
      const engine = makeEngine(root, runId, 'Run the slow command then read a.txt and b.txt.');
      const abortTimer = setTimeout(() => engine.abortTurn(), 600);
      const events: ChatEvent[] = [];
      try {
        for await (const event of engine.submitMessageStream('Run the slow command then read a.txt and b.txt.')) {
          events.push(event);
        }
      } finally {
        clearTimeout(abortTimer);
      }

      const starts = startEvents(events);
      const terminals = terminalEvents(events);
      assert.equal(starts.length, 3, 'all starts are announced before execution');

      const settledIds = terminals.map((t) => t.toolCallId);
      // Exactly one terminal per settled id.
      assert.equal(new Set(settledIds).size, settledIds.length, 'no duplicate terminal ids');

      // Settled ids must be a prefix of the announced order (executed actions
      // are always the leading batch set; unattempted trailing ids must not
      // receive a terminal).
      const announced = starts.map((s) => s.toolCallId ?? '');
      const prefixLen = settledIds.length;
      assert.deepEqual(
        settledIds,
        announced.slice(0, prefixLen),
        'settled ids are the executed prefix of the announced ids',
      );
      assert.ok(prefixLen >= 1, 'the first action was executed');
      assert.ok(prefixLen < 3, 'the abort prevented at least one trailing action');

      // Identity: each settled terminal maps to the start id for its target.
      const startIdByTarget = new Map(starts.map((s) => [s.target, s.toolCallId]));
      for (const terminal of terminals) {
        assert.equal(terminal.toolCallId, startIdByTarget.get(terminal.target));
      }

      // Durable: exactly one terminal for executed ids, none for unattempted.
      const sessionEvents = readSessionEvents(runId);
      const durableTerminalIds = sessionEvents
        .filter(
          (event) =>
            event.kind === 'tool_completed' ||
            event.kind === 'tool_failed' ||
            event.kind === 'tool_cancelled',
        )
        .map((event) => event.tool_call_id);
      for (const id of settledIds) {
        assert.equal(
          durableTerminalIds.filter((candidate) => candidate === id).length,
          1,
          `exactly one durable terminal for executed ${id}`,
        );
      }
      for (const id of announced.slice(prefixLen)) {
        assert.equal(
          durableTerminalIds.includes(id),
          false,
          `unattempted ${id} must have no terminal`,
        );
      }
    } finally {
      restore();
      await awaitPendingProcessTerminations();
      await removeFixtureDir(root);
    }
  });
});
