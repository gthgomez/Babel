/**
 * Campaign reproduction probes (Babel terminal-truth lane).
 *
 * These drive the real ChatEngine loop, real tool reader, completion authority,
 * durable turn log and CLI payload, substituting only provider output. They
 * encode the demonstrated false-success path for empty/refused native output
 * and the controls that must keep working.
 *
 * Provider substitution only: no live inference, credential or network call.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from './chatEngine.js';
import { buildChatRunPayload, consumeChatStream } from '../interactive/execution/chatCore.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { loadThreadEventLogFromDir } from './threadEventLog.js';
import { exitCodeFromOutcome } from '../cli/userFacingStatus.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import type { ToolStreamEvent } from '../runners/base.js';

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_CHAT_MAX_COST',
  'BABEL_DIFF_CRITIC',
  'CI',
] as const;

const POLICY = {
  policyPath: 'campaign-fixture',
  family: 'test-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'test-fixture',
  provider: 'deepinfra',
  providerModelId: 'fixture-model',
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
} as const;

type ScriptTurn = ToolStreamEvent[];

class ScriptedRunner extends DeepInfraApiRunner {
  calls = 0;
  constructor(private readonly script: (call: number) => ScriptTurn) {
    super('fixture-model', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} });
  }
  override async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
    for (const event of this.script(this.calls++)) yield event;
  }
  override getLastInvocationMetadata() {
    return null;
  }
}

let previous: Record<string, string | undefined> = {};
let scratch = '';

before(() => {
  previous = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  scratch = mkdtempSync(join(tmpdir(), 'babel-campaign-probe-'));
  process.env['BABEL_RUNS_DIR'] = join(scratch, 'runs');
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'campaign-probe-lease',
    scope: { repository: 'fixture', objective: 'terminal truth campaign' },
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
  // These fixtures script only the primary provider stream; the asymmetric
  // diff critic would otherwise issue its own provider call under CI/headless.
  process.env['BABEL_DIFF_CRITIC'] = '0';
  delete process.env['CI'];
});

after(() => {
  for (const key of MANAGED_ENV) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

type Observation = {
  status: string;
  userStatus: string;
  outcome: string | undefined;
  answer: string | undefined;
  exitCode: number | null;
  durableOutcome: string | undefined;
  fileBytes: string | null;
};

async function run(input: {
  name: string;
  task: string;
  script: (call: number) => ScriptTurn;
  project: boolean;
}): Promise<Observation> {
  let projectRoot: string | null = null;
  if (input.project) {
    projectRoot = join(scratch, input.name);
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, 'source.js'), 'export const flag = false;\n');
  }
  const runner = new ScriptedRunner(input.script);
  const engine = new ChatEngine({
    task: input.task,
    projectRoot,
    ...(projectRoot ? {} : { executionScope: { kind: 'conversation' as const } }),
    model: 'deepinfra-fixture',
    providerRunner: runner,
    providerPolicy: POLICY as never,
    maxTurns: 5,
  });
  try {
    const result = await consumeChatStream(engine.submitMessageStream(input.task), null);
    const payload = buildChatRunPayload(result, {
      task: input.task,
      projectRoot,
      ...(projectRoot ? {} : { executionScope: { kind: 'conversation' as const } }),
    });
    const disk = loadThreadEventLogFromDir(chatSessionDir(engine.getEngineRunId()));
    const terminal = disk?.events.filter((event) => event.kind === 'turn_ended').at(-1) as
      | { outcome?: string }
      | undefined;
    return {
      status: result.status,
      userStatus: String(payload['user_status']),
      outcome: result.outcome,
      answer: result.answer,
      exitCode: result.outcome ? exitCodeFromOutcome(result.outcome) : null,
      durableOutcome: terminal?.outcome,
      fileBytes: projectRoot ? readFileSync(join(projectRoot, 'source.js'), 'utf8') : null,
    };
  } finally {
    engine.closeAdmissionStore();
  }
}

const READ_SOURCE: ScriptTurn = [
  { type: 'tool_use', id: 'read-source', name: 'read_file', input: { path: 'source.js' } },
  { type: 'done', finishReason: 'tool_calls' },
];
const CLAIM_ALREADY_DONE: ScriptTurn = [
  { type: 'text_delta', text: 'The requested behavior is already present. No change is required.' },
  { type: 'done', finishReason: 'stop' },
];

describe('campaign: native terminal truth', { concurrency: false }, () => {
  it('empty provider stream is not a successful OK answer', async () => {
    const observed = await run({ name: 'empty_eof', task: 'Hello', script: () => [], project: false });
    assert.notEqual(observed.outcome, 'NO_CHANGE_REQUIRED', JSON.stringify(observed));
    assert.notEqual(observed.userStatus, 'success', JSON.stringify(observed));
    assert.notEqual(observed.exitCode, 0, JSON.stringify(observed));
    assert.notEqual(observed.durableOutcome, 'completed', JSON.stringify(observed));
    assert.notEqual(observed.answer, 'OK', JSON.stringify(observed));
  });

  it('done-only stop stream is not a successful OK answer', async () => {
    const observed = await run({
      name: 'done_only_stop',
      task: 'Hello',
      script: () => [{ type: 'done', finishReason: 'stop' }],
      project: false,
    });
    assert.notEqual(observed.outcome, 'NO_CHANGE_REQUIRED', JSON.stringify(observed));
    assert.notEqual(observed.userStatus, 'success', JSON.stringify(observed));
    assert.notEqual(observed.exitCode, 0, JSON.stringify(observed));
  });

  it('done-only content_filter stream is not a successful OK answer', async () => {
    const observed = await run({
      name: 'content_filter',
      task: 'Hello',
      script: () => [{ type: 'done', finishReason: 'content_filter' }],
      project: false,
    });
    assert.notEqual(observed.outcome, 'NO_CHANGE_REQUIRED', JSON.stringify(observed));
    assert.notEqual(observed.userStatus, 'success', JSON.stringify(observed));
    assert.notEqual(observed.exitCode, 0, JSON.stringify(observed));
  });

  it('whitespace-only answer is not a successful OK answer', async () => {
    const observed = await run({
      name: 'whitespace',
      task: 'Hello',
      script: () => [{ type: 'text_delta', text: '   \n\t  ' }, { type: 'done', finishReason: 'stop' }],
      project: false,
    });
    assert.notEqual(observed.outcome, 'NO_CHANGE_REQUIRED', JSON.stringify(observed));
    assert.notEqual(observed.userStatus, 'success', JSON.stringify(observed));
  });

  it('positive control: a genuine non-empty answer still completes', async () => {
    const observed = await run({
      name: 'genuine_answer',
      task: 'Hello',
      script: () => [{ type: 'text_delta', text: 'Hello! How can I help?' }, { type: 'done', finishReason: 'stop' }],
      project: false,
    });
    assert.equal(observed.answer, 'Hello! How can I help?', JSON.stringify(observed));
    assert.notEqual(observed.outcome, 'AGENT_FAILURE', JSON.stringify(observed));
  });

  it('positive control: a real tool cycle still proposes tool calls', async () => {
    const observed = await run({
      name: 'tool_cycle',
      task: 'Inspect source.js and tell me the flag value.',
      script: (call) =>
        call === 0
          ? READ_SOURCE
          : [{ type: 'text_delta', text: 'The flag value is false.' }, { type: 'done', finishReason: 'stop' }],
      project: true,
    });
    assert.equal(observed.outcome, 'NO_CHANGE_REQUIRED', JSON.stringify(observed));
    assert.equal(observed.userStatus, 'success', JSON.stringify(observed));
    assert.equal(observed.exitCode, 0, JSON.stringify(observed));
  });
});
