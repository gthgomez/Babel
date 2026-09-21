/**
 * R0-1 — fresh-task WorkingState + failure-budget isolation.
 *
 * The W0.3 fresh-submission boundary already cleared tool-call/mutation/cancel
 * state, but it did not reset the controller-owned `WorkingState`. Because the
 * per-turn injection only set a goal when `workingState.goal` was empty, a
 * fresh Task B inherited Task A's goal, hypothesis, evidence, files of
 * interest, mutation attribution, verifier receipt, failure surface, repair
 * diagnosis and next experiment. `failureBudgetTracker` was likewise not
 * recreated at the boundary.
 *
 * This suite drives the real ChatEngine loop:
 *   1. Task A runs read -> mutate -> red verifier, establishing nontrivial
 *      WorkingState and consuming an implementation-repair failure budget.
 *   2. Task B is submitted as an unrelated fresh task and is forced onto the
 *      text-tools provider path so the ACTUAL provider-bound prompt is captured.
 *
 * The oracle inspects the working-state block embedded in Task B's real
 * provider input — not a private field alone — and requires that it contains
 * Task B's own goal and none of Task A's task-local state. Explicit
 * continuation must preserve the state, so a negative control is included.
 */

import assert from 'node:assert/strict';
import { describe, test, before, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import type { ToolStreamEvent } from '../runners/base.js';
import { renderParserVerifierScript } from './codingLoop/parserOracle.js';
import {
  DEFAULT_FAILURE_CLASS_BUDGETS,
  type FailureClassBudgets,
} from './taskContract.js';

const MODEL = 'deepseek-v4-flash';
const WORKING_STATE_MARKER = '<!-- BABEL_WORKING_STATE -->';

// ── Environment ──────────────────────────────────────────────────────────────

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_NATIVE_TOOLS',
  'BABEL_TOOL_PROFILE',
] as const;

let envSnapshot: Record<string, string | undefined> = {};
let runsRoot = '';

before(() => {
  envSnapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  runsRoot = mkdtempSync(join(tmpdir(), 'babel-r0-ws-runs-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'r0-fresh-task-lease',
    scope: { repository: 'r0-ws-fixture', objective: 'fresh-task working-state isolation' },
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
  delete process.env['BABEL_NATIVE_TOOLS'];
  delete process.env['BABEL_TOOL_PROFILE'];
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = envSnapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(runsRoot, { recursive: true, force: true });
});

// ── Fixture ──────────────────────────────────────────────────────────────────

const PARSER_BUGGY = [
  'export function parseExpression(input: string): number {',
  "  const parts = input.split('+');",
  '  // Defect: subtracts instead of adding the operands.',
  '  return Number(parts[0]) - Number(parts[1]);',
  '}',
  '',
].join('\n');

function makeFixture(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-r0-ws-project-'));
  writeFileSync(join(root, 'parser.ts'), PARSER_BUGGY, 'utf8');
  writeFileSync(join(root, 'verify.mjs'), renderParserVerifierScript(), 'utf8');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'r0-ws-fixture', private: true, scripts: { test: 'node verify.mjs' } }, null, 2)}\n`,
    'utf8',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ── Dual-mode scripted runner ────────────────────────────────────────────────

type Script = Array<ToolStreamEvent[]>;

interface NativeRequestRecord {
  messages: Array<{ role: string; content: unknown; name?: string }>;
  systemPrompt?: string | undefined;
}

interface TextRequestRecord {
  prompt: string;
  systemPrompt?: string | undefined;
}

interface DualRunner {
  calls(): number;
  nativeRequests(): NativeRequestRecord[];
  textRequests(): TextRequestRecord[];
  setNativeScript(script: Script): void;
  setTextAnswer(answer: string): void;
  executeWithToolsStream: (
    messages?: Array<{ role: string; content: unknown; name?: string }>,
    tools?: Array<{ function?: { name?: string } }>,
    systemPrompt?: string,
    signal?: AbortSignal,
    toolChoice?: string,
    callbacks?: unknown,
  ) => AsyncGenerator<ToolStreamEvent, void, undefined>;
  executeRawStream: (
    prompt: string,
    systemPrompt?: string,
    signal?: AbortSignal,
    callbacks?: unknown,
  ) => AsyncGenerator<string, void, undefined>;
  execute: () => Promise<{ type: string; answer: string }>;
  executeRaw: () => Promise<string>;
  getLastInvocationMetadata: () => null;
}

function makeDualRunner(): DualRunner {
  let script: Script = [];
  let nativeBase = 0;
  let call = 0;
  let textAnswer = 'Repository inventory complete.';
  const nativeReqs: NativeRequestRecord[] = [];
  const textReqs: TextRequestRecord[] = [];
  return {
    calls: () => call,
    nativeRequests: () => nativeReqs,
    textRequests: () => textReqs,
    setNativeScript(next: Script) {
      script = next;
      nativeBase = call;
    },
    setTextAnswer(answer: string) {
      textAnswer = answer;
    },
    async *executeWithToolsStream(messages, _tools, systemPrompt) {
      const index = call - nativeBase;
      call += 1;
      nativeReqs.push({
        messages: (messages ?? []).map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.name !== undefined ? { name: m.name } : {}),
        })),
        systemPrompt,
      });
      const events =
        script[index] ??
        ([
          { type: 'text_delta', text: 'No further action; concluding.' },
          { type: 'done', finishReason: 'stop' },
        ] as ToolStreamEvent[]);
      for (const event of events) yield event;
    },
    async *executeRawStream(prompt, systemPrompt) {
      call += 1;
      textReqs.push({ prompt, systemPrompt });
      yield textAnswer;
    },
    async execute() {
      return { type: 'completion', answer: 'scripted completion' };
    },
    async executeRaw() {
      return 'scripted completion';
    },
    getLastInvocationMetadata() {
      return null;
    },
  };
}

/** Install a runner and control native-vs-text routing deterministically. */
function installRunner(engine: ChatEngine, runner: DualRunner, isTextMode: () => boolean): void {
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
    shouldUseTextTools: () => boolean;
  };
  anyEngine.deliberationRunner = runner;
  anyEngine.synthesisRunner = runner;
  anyEngine.shouldUseNativeTools = () => !isTextMode();
  anyEngine.shouldUseTextTools = () => isTextMode();
}

/** Extract the working-state block embedded in a provider prompt, if present. */
function extractWorkingStateBlock(prompt: string): string {
  // Advisory context is escaped before it is placed inside the provider
  // container. Decode only for this assertion so the oracle inspects the
  // logical WorkingState payload while the hostile-delimiter protection stays
  // exercised by the prompt-serialization tests.
  const escapedMarker = WORKING_STATE_MARKER
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const start = prompt.indexOf(escapedMarker);
  assert.ok(start >= 0, 'provider prompt contains a working-state block');
  const rest = prompt.slice(start);
  const end = rest.search(/\n#{2,3} /);
  return (end >= 0 ? rest.slice(0, end) : rest)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

interface EngineInternals {
  workingState: {
    goal: string;
    currentHypothesis: string;
    filesOfInterest: string[];
    lastMutation?: { path: string };
    lastVerifier?: { identity: string; exitCode: number; fresh: boolean };
    failureSurface?: { errorSignature: string };
    nextExperiment: string;
    invalidatedAssumptions: string[];
  };
  failureBudgetTracker: {
    remainingBudgets(): FailureClassBudgets;
    consume(failure: unknown): boolean;
  };
}

const TASK_A = 'Investigate why parser_test fails and fix it.';
const TASK_B = 'Inventory the repository structure. Do not edit files.';

const TASK_A_SCRIPT: Script = [
  [
    { type: 'tool_use', id: 'a-read', name: 'read_file', input: { path: 'parser.ts' } },
    { type: 'done', finishReason: 'tool_calls' },
  ],
  [
    {
      type: 'tool_use',
      id: 'a-write',
      name: 'str_replace',
      input: {
        file_path: 'parser.ts',
        old_str: '// Defect: subtracts instead of adding the operands.',
        new_str: '// investigated by task A',
      },
    },
    { type: 'done', finishReason: 'tool_calls' },
  ],
  [
    { type: 'tool_use', id: 'a-verify', name: 'run_command', input: { command: 'npm test' } },
    { type: 'done', finishReason: 'tool_calls' },
  ],
  [
    { type: 'text_delta', text: 'I changed parser.ts but the verifier is still red.' },
    { type: 'done', finishReason: 'stop' },
  ],
];

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('R0-1 fresh-task WorkingState isolation', () => {
  test('Task B provider prompt carries B state only; explicit continuation preserves A', async () => {
    const fixture = makeFixture();
    try {
      const engine = new ChatEngine({
        task: TASK_A,
        projectRoot: fixture.root,
        runId: `r0-ws-${Math.random().toString(36).slice(2, 10)}`,
        model: MODEL,
        maxTurns: 8,
      });
      const runner = makeDualRunner();
      let textMode = false;
      installRunner(engine, runner, () => textMode);

      // ── Task A: establish nontrivial WorkingState. ──
      runner.setNativeScript(TASK_A_SCRIPT);
      const aEvents = await collect(engine.submitMessageStream(TASK_A));
      const aTerminal = aEvents.at(-1);
      assert.ok(aTerminal, 'task A produced a terminal event');

      const internals = engine as unknown as EngineInternals;
      const wsA = internals.workingState;
      assert.equal(wsA.goal, TASK_A, 'task A goal recorded');
      assert.ok(wsA.lastMutation, 'task A recorded mutation attribution');
      assert.ok(wsA.lastVerifier, 'task A recorded a verifier receipt');
      assert.equal(wsA.lastVerifier?.exitCode, 1, 'task A verifier is red');
      assert.equal(wsA.lastVerifier?.fresh, true, 'task A verifier is fresh');

      // The fixture's red verifier is not a *classified* implementation
      // failure (its runner output is not parseable), so it must NOT spend the
      // implementation-repair budget. Only a classified failure may. Consume
      // one explicitly so the fresh-task boundary has a visibly non-default
      // tracker to recreate.
      const trackerA = internals.failureBudgetTracker;
      const beforeConsume = trackerA.remainingBudgets();
      assert.equal(
        beforeConsume.implementation_repair,
        DEFAULT_FAILURE_CLASS_BUDGETS.implementation_repair,
        'an unclassified red verifier does not spend implementation-repair budget',
      );
      trackerA.consume({ budget_key: 'implementation_repair' } as never);
      assert.equal(
        internals.failureBudgetTracker.remainingBudgets().implementation_repair,
        DEFAULT_FAILURE_CLASS_BUDGETS.implementation_repair - 1,
        'task A consumed an implementation-repair budget',
      );

      // ── Negative control: explicit continuation preserves WorkingState and
      // consumed budgets; it must not be reset by the fresh-task boundary. ──
      engine.applyUserSubmission({ userInput: 'Continue: try another repair.', continueTask: true });
      assert.equal(
        internals.workingState.lastVerifier?.exitCode,
        1,
        'explicit continuation preserves the working state',
      );
      assert.equal(internals.workingState.goal, TASK_A, 'explicit continuation preserves the goal');
      assert.equal(
        internals.failureBudgetTracker.remainingBudgets().implementation_repair,
        DEFAULT_FAILURE_CLASS_BUDGETS.implementation_repair - 1,
        'explicit continuation preserves consumed failure budgets',
      );

      // ── Task B: unrelated fresh task, forced onto the text-tools provider
      // path so the real provider-bound prompt is captured. ──
      textMode = true;
      runner.setTextAnswer('Repository inventory complete.');
      const bEvents = await collect(engine.submitMessageStream(TASK_B));
      const bTerminal = bEvents.at(-1);
      assert.equal(bTerminal?.type, 'done', 'task B completes');

      const bRequests = runner.textRequests();
      assert.ok(bRequests.length >= 1, 'task B issued a provider request on the text path');
      const bPrompt = bRequests.at(-1)!.prompt;
      const block = extractWorkingStateBlock(bPrompt);

      // Task B must carry its OWN goal.
      assert.match(
        block,
        new RegExp(`goal:\\s*${TASK_B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        'Task B provider input states Task B as the goal',
      );
      // None of Task A's task-local WorkingState may survive into B.
      assert.ok(!block.includes('Investigate why parser_test'), 'no task A goal');
      assert.ok(!block.includes('parser.ts'), 'no task A files-of-interest / mutation path');
      assert.ok(!block.includes('exit=1'), 'no task A red verifier');
      assert.ok(!block.includes('investigated by task A'), 'no task A hypothesis/mutation prose');
      // Positive: the block is the fresh, empty state seeded with B's goal.
      assert.match(block, /last_verifier: none/, 'task B starts with no verifier');
      assert.match(block, /last_mutation: none/, 'task B starts with no mutation');
      assert.match(block, /failure_surface: none/, 'task B starts with no failure surface');
      assert.match(block, /repair_diagnosis: none/, 'task B starts with no repair diagnosis');
      assert.match(block, /current_hypothesis: ""/, 'task B starts with no hypothesis');
      assert.match(block, /files_of_interest: \[\]/, 'task B starts with no files of interest');
      assert.match(block, /evidence: \[\]/, 'task B starts with no inherited evidence');
      assert.match(block, /invalidated_assumptions: \[\]/, 'task B starts with no inherited invalidations');
      assert.match(block, /next_experiment: ""/, 'task B starts with no next experiment');

      // Failure budgets are task-scoped: B starts from the contract budget.
      assert.deepEqual(
        internals.failureBudgetTracker.remainingBudgets(),
        DEFAULT_FAILURE_CLASS_BUDGETS,
        'fresh task B does not inherit task A consumed failure budgets',
      );

    } finally {
      fixture.cleanup();
    }
  });
});
