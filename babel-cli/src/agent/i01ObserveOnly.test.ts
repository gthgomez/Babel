/**
 * I01 observation-mode proof (deterministic, no model access).
 *
 * Baseline: `general_swe` investigate hard cap (12 tools without a write)
 * terminates the run through the policy arbiter with BLOCKED_POLICY.
 * Intervention (BABEL_POLICY_I01_OBSERVE_ONLY=1): the identical counter and
 * terminal candidate are computed, a durable would-fire receipt is recorded,
 * ONLY that terminal candidate is withheld from the arbiter, and the run
 * continues to its natural completion. All scripted provider traffic is fake;
 * fetch is replaced for the whole run.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine } from './chatEngine.js';
import { runCliChatTask } from '../interactive/execution/chatCore.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import { babelReviewModelPolicy } from '../services/babelChatReview.js';
import { resolveInvestigateHardCapObserveOnly } from './chatZeroWritePolicy.js';

const HARD_CAP = 12;

interface I01Harness {
  root: string;
  source: string;
  roundsServed: { value: number };
  run(task: string): Promise<{ payload: Record<string, unknown>; engine: ChatEngine }>;
  dispose(): void;
}

function makeI01Harness(): I01Harness {
  const root = mkdtempSync(join(tmpdir(), 'babel-i01-'));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'fixture.txt'), 'fixture line\n');
  mkdirSync(join(root, 'runs'));
  const keys: Record<string, string> = {
    BABEL_EXECUTION_PROFILE: 'read_only_audit',
    BABEL_READ_ONLY: 'true',
    BABEL_PROJECT_ROOT: source,
    BABEL_RUNS_DIR: join(root, 'runs'),
    BABEL_COMPACTION: 'off',
    BABEL_MEMORY_WRITEBACK: '0',
    BABEL_CHAT_TASK_CLASS: 'general_swe',
    BABEL_CHAT_MAX_TURNS: '40',
  };
  const previous = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
  Object.assign(process.env, keys);
  delete process.env['BABEL_POLICY_I01_OBSERVE_ONLY'];

  const roundsServed = { value: 0 };
  let activeEngine: ChatEngine | undefined;
  const originalFetch = globalThis.fetch;
  // Every provider round demands one more read: zero writes, counter climbs.
  globalThis.fetch = async () => {
    roundsServed.value += 1;
    const delta = {
      tool_calls: [{
        index: 0,
        id: `call-${roundsServed.value}`,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: join(source, 'fixture.txt') }) },
      }],
    };
    return new Response(
      `data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    );
  };

  const run = async (task: string) => {
    const result = await runCliChatTask({
      task,
      projectRoot: source,
      outputFormat: 'json',
      engineFactory: (engineOptions) =>
        activeEngine = new ChatEngine({
          ...engineOptions,
          maxTurns: 40,
          providerRunner: new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' }),
          providerPolicy: babelReviewModelPolicy('mimo-v2.5', source),
        }),
    });
    return { payload: result.payload as Record<string, unknown>, engine: activeEngine! };
  };

  return {
    root,
    source,
    roundsServed,
    run,
    dispose() {
      globalThis.fetch = originalFetch;
      delete process.env['BABEL_POLICY_I01_OBSERVE_ONLY'];
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('observe-only resolver defaults off and accepts only explicit truthy values', () => {
  assert.equal(resolveInvestigateHardCapObserveOnly({}), false);
  assert.equal(resolveInvestigateHardCapObserveOnly({ BABEL_POLICY_I01_OBSERVE_ONLY: '0' }), false);
  assert.equal(resolveInvestigateHardCapObserveOnly({ BABEL_POLICY_I01_OBSERVE_ONLY: 'false' }), false);
  assert.equal(resolveInvestigateHardCapObserveOnly({ BABEL_POLICY_I01_OBSERVE_ONLY: '1' }), true);
  assert.equal(resolveInvestigateHardCapObserveOnly({ BABEL_POLICY_I01_OBSERVE_ONLY: 'true' }), true);
});

function answerText(payload: Record<string, unknown>): string {
  const answer = payload['answer'];
  if (typeof answer === 'string') return answer;
  if (answer && typeof answer === 'object') {
    const record = answer as Record<string, unknown>;
    return `${String(record['summary'] ?? '')}\n${String(record['answer'] ?? '')}`;
  }
  return String(answer ?? '');
}

test('baseline: general_swe hard cap terminates through the arbiter with a policy block', async () => {
  const harness = makeI01Harness();
  try {
    const { payload } = await harness.run('Fix the defect described in fixture.txt by inspecting it first.');
    // The run must terminate early via investigate_hard_cap, not run to maxTurns.
    assert.ok(
      harness.roundsServed.value < 40,
      `expected early hard-cap termination, served ${harness.roundsServed.value} rounds`,
    );
    assert.match(answerText(payload), /hard cap 12/i);
    assert.equal(payload['terminal_outcome'], 'BLOCKED_POLICY');
  } finally {
    harness.dispose();
  }
});

test('I01 observe-only: terminal withheld, would-fire receipt recorded, run completes naturally', async () => {
  const harness = makeI01Harness();
  try {
    process.env['BABEL_POLICY_I01_OBSERVE_ONLY'] = '1';
    const { payload, engine } = await harness.run('Fix the defect described in fixture.txt by inspecting it first.');
    // Without the terminal, the run only ends at the turn budget — well past
    // the hard cap, proving the arbiter never received the candidate.
    assert.ok(
      harness.roundsServed.value > HARD_CAP,
      `expected the run to continue past the hard cap (served ${harness.roundsServed.value})`,
    );
    assert.notEqual(payload['terminal_outcome'], 'BLOCKED_POLICY');
    assert.doesNotMatch(answerText(payload), /hard cap 12/i);
    // Durable would-fire receipt: the identical threshold was reached and logged.
    const sessionEvents = (engine as unknown as {
      parity: { sessionEvents: { events: Array<{ kind: string; source?: string; action?: string; detail?: string }> } };
    }).parity.sessionEvents.events;
    const receipts = sessionEvents.filter(
      (event) => event.kind === 'policy_intervened' && event.action === 'would_fire_observe_only',
    );
    assert.ok(receipts.length >= 1, 'expected at least one durable would-fire receipt');
    assert.match(String(receipts[0]!.detail), /tools_without_write=12/);
  } finally {
    harness.dispose();
  }
});
