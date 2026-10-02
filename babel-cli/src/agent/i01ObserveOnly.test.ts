/**
 * I01 observation-mode proof (deterministic, no model access).
 *
 * Baseline: `general_swe` investigate hard cap (12 tools without a write)
 * terminates the run through the policy arbiter with BLOCKED_POLICY.
 * Intervention (BABEL_POLICY_I01_OBSERVE_ONLY=1): the identical counter and
 * terminal candidate are computed, a durable would-fire receipt is recorded,
 * ONLY that terminal candidate is withheld from the arbiter, and the run
 * continues past that cap until another safety limit. Novel read targets keep
 * the independent no-progress terminal from preempting this proof. An unchanged
 * read control separately exercises that terminal. All provider traffic is fake;
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
  requestedPaths: string[];
  run(task: string): Promise<{ payload: Record<string, unknown>; engine: ChatEngine }>;
  dispose(): void;
}

function makeI01Harness(readMode: 'novel' | 'unchanged' = 'novel'): I01Harness {
  const root = mkdtempSync(join(tmpdir(), 'babel-i01-'));
  const source = join(root, 'source');
  mkdirSync(source);
  for (let i = 1; i <= 40; i++) {
    writeFileSync(join(source, `fixture-${i}.txt`), 'fixture line\n');
  }
  mkdirSync(join(root, 'runs'));
  const keys: Record<string, string> = {
    BABEL_EXECUTION_PROFILE: 'read_only_audit',
    BABEL_READ_ONLY: 'true',
    BABEL_PROJECT_ROOT: source,
    BABEL_RUNS_DIR: join(root, 'runs'),
    BABEL_COMPACTION: 'off',
    BABEL_MEMORY_WRITEBACK: '0',
    BABEL_CHAT_TASK_CLASS: 'general_swe',
    BABEL_CHAT_MAX_COST: 'unlimited',
    BABEL_CHAT_MAX_TURNS: '40',
  };
  const previous = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
  Object.assign(process.env, keys);
  delete process.env['BABEL_POLICY_I01_OBSERVE_ONLY'];

  const roundsServed = { value: 0 };
  const requestedPaths: string[] = [];
  let activeEngine: ChatEngine | undefined;
  const originalFetch = globalThis.fetch;
  // Novel targets yield real localization without relying on the age text in
  // deduplicated read_file observations. read_range repeats stable evidence for
  // the negative control, while retaining the real engine's progress policy.
  globalThis.fetch = async () => {
    roundsServed.value += 1;
    const path = join(source, `fixture-${readMode === 'novel' ? roundsServed.value : 1}.txt`);
    requestedPaths.push(path);
    const delta = {
      tool_calls: [{
        index: 0,
        id: `call-${roundsServed.value}`,
        type: 'function',
        function: readMode === 'novel'
          ? { name: 'read_file', arguments: JSON.stringify({ path }) }
          : { name: 'read_range', arguments: JSON.stringify({ file_path: path, start_line: 1, end_line: 1 }) },
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
      engineFactory: (engineOptions) => {
        const testEngineOptions = { ...engineOptions };
        delete testEngineOptions.maxCostUsd;
        return activeEngine = new ChatEngine({
          ...testEngineOptions,
          maxTurns: 40,
          // The provider fixture reports token usage without per-token prices.
          // Cost-completeness behavior is covered separately; these tests isolate I01.
          providerRunner: new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' }),
          providerPolicy: babelReviewModelPolicy('mimo-v2.5', source),
        });
      },
    });
    return { payload: result.payload as Record<string, unknown>, engine: activeEngine! };
  };

  return {
    root,
    source,
    roundsServed,
    requestedPaths,
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

test('baseline: general_swe hard cap terminates through the arbiter with a budget outcome', async () => {
  const harness = makeI01Harness();
  try {
    const { payload } = await harness.run('Fix the defect described in the fixture files by inspecting them first.');
    // The run must terminate early via investigate_hard_cap, not run to maxTurns.
    assert.ok(
      harness.roundsServed.value < 40,
      `expected early hard-cap termination, served ${harness.roundsServed.value} rounds`,
    );
    assert.match(answerText(payload), /hard cap 12/i);
    assert.equal(payload['terminal_outcome'], 'BUDGET_EXHAUSTED');
    assert.equal(new Set(harness.requestedPaths).size, harness.requestedPaths.length,
      'I01 fixture must supply novel read targets so cached observation age cannot decide progress');
  } finally {
    harness.dispose();
  }
});

test('I01 observe-only: terminal withheld, would-fire receipt recorded, run continues past cap', async () => {
  const harness = makeI01Harness();
  try {
    process.env['BABEL_POLICY_I01_OBSERVE_ONLY'] = '1';
    const { payload, engine } = await harness.run('Fix the defect described in the fixture files by inspecting them first.');
    assert.equal(new Set(harness.requestedPaths).size, harness.requestedPaths.length,
      'observe-only fixture must keep independent localization progress');
    // Without the withheld hard-cap terminal, the run continues past the hard
    // cap and can only end on a different (non-withheld) safety terminal.
    assert.ok(
      harness.roundsServed.value > HARD_CAP,
      `expected the run to continue past the hard cap (served ${harness.roundsServed.value})`,
    );
    // Precisely guard the I01 invariant: the terminal must NOT be the withheld
    // investigate hard cap. (A separate progress/recovery terminal is allowed
    // and may legitimately classify as BLOCKED_POLICY.)
    const blocked = payload['blocked_report'] as
      | { checked?: Array<{ action?: string }> }
      | undefined;
    assert.notEqual(
      blocked?.checked?.[0]?.action,
      'investigate_hard_cap',
      'observe-only must not terminal on the withheld investigate hard cap',
    );
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

test('I01 observe-only preserves the real unchanged-read no-progress terminal', async () => {
  const harness = makeI01Harness('unchanged');
  try {
    process.env['BABEL_POLICY_I01_OBSERVE_ONLY'] = '1';
    const { payload, engine } = await harness.run('Fix the defect described in the fixture files by inspecting them first.');
    assert.ok(harness.roundsServed.value < HARD_CAP,
      `unchanged reads must stop before I01, served ${harness.roundsServed.value} rounds`);
    assert.equal(payload['reason_code'], 'recovery_exhausted');
    assert.equal(payload['cause_class'], 'model');
    assert.match(answerText(payload), /Repeated no-progress after recovery/i);
    assert.doesNotMatch(answerText(payload), /hard cap 12/i);
    const events = (engine as unknown as {
      parity: { sessionEvents: { events: Array<{ kind: string; action?: string }> } };
    }).parity.sessionEvents.events;
    assert.equal(events.filter((event) =>
      event.kind === 'policy_intervened' && event.action === 'would_fire_observe_only').length, 0,
    'the distinct I01 threshold must not be fabricated before twelve tools');
  } finally {
    harness.dispose();
  }
});
