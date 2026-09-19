import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';

import { ChatEngine } from './chatEngine.js';
import type { ChatEvent } from './chatEngine.js';
import { persistTranscriptToDisk } from './chatEngineObservability.js';
import type { ChatMessage } from './chatToolDefinitions.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { buildProviderFailureReceipt } from '../runners/providerFailureReceipt.js';
import type { RunnerCallbacks } from '../runners/base.js';
import {
  PreparedRequestAdmissionError,
  prepareProviderRequest,
} from '../runners/preparedProviderRequest.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import {
  inspectSessionEventLogFromDir,
  type SessionEvent,
} from './sessionEvents.js';

type TestRunner = {
  executeWithToolsStream: (...args: unknown[]) => AsyncGenerator<any, void, undefined>;
  execute: () => Promise<{ type: 'completion'; answer: string }>;
  executeRaw: () => Promise<string>;
  getLastInvocationMetadata: () => null;
};

const FIXTURE_PROVIDER_POLICY: ResolvedModelPolicy = {
  policyPath: 'test-fixture',
  family: 'test-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'test-fixture',
  provider: 'deepinfra',
  providerModelId: 'test-fixture-model',
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

const require = createRequire(import.meta.url);

function shellArg(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeRunner(
  firstTurn: (call: number) => Array<Record<string, unknown>>,
  afterYield?: (event: Record<string, unknown>) => void,
): TestRunner {
  let call = 0;
  return {
    async *executeWithToolsStream(..._args: unknown[]) {
      const events = firstTurn(call++);
      for (const event of events) {
        yield event;
        afterYield?.(event);
      }
    },
    async execute() {
      return { type: 'completion', answer: 'fixture complete' };
    },
    async executeRaw() {
      return 'fixture complete';
    },
    getLastInvocationMetadata() {
      return null;
    },
  };
}

function makeEngine(
  projectRoot: string,
  runId: string,
  runner: TestRunner,
  options: Record<string, unknown> = {},
): ChatEngine {
  const engine = new ChatEngine({
    task: 'repair the deterministic lifecycle fixture',
    projectRoot,
    runId,
    model: 'deepseek-v4-flash',
    maxTurns: 8,
    providerRunner: runner as never,
    providerPolicy: FIXTURE_PROVIDER_POLICY,
    ...options,
  });
  return engine;
}

function readEvents(runId: string): SessionEvent[] {
  const loaded = inspectSessionEventLogFromDir(chatSessionDir(runId), runId);
  assert.equal(loaded.kind, 'valid', loaded.kind === 'invalid' ? loaded.error.message : 'session event log missing');
  return loaded.kind === 'valid' ? loaded.log.events : [];
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-lifecycle-'));
  const runs = join(root, 'runs');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const previousRuns = process.env['BABEL_RUNS_DIR'];
  const previousApproval = process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
  const previousBenchmarkMode = process.env['BABEL_BENCHMARK_MODE'];
  const previousLease = process.env['BABEL_AUTONOMY_LEASE'];
  const previousExecutionProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousHostFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
  const previousCompaction = process.env['BABEL_COMPACTION'];
  process.env['BABEL_RUNS_DIR'] = runs;
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'lifecycle-fixture-lease',
    scope: { repository: 'lifecycle-fixture', objective: 'deterministic lifecycle qualification' },
    allowedCapabilities: ['run_arbitrary_code', 'run_local_command', 'run_tests', 'edit_task_files'],
  });
  // This is an explicit test-only host boundary for real child-process fixtures;
  // production defaults and safety policy remain unchanged.
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  return {
    root,
    runs,
    project,
    cleanup() {
      if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = previousRuns;
      if (previousApproval === undefined) delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
      else process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = previousApproval;
      if (previousBenchmarkMode === undefined) delete process.env['BABEL_BENCHMARK_MODE'];
      else process.env['BABEL_BENCHMARK_MODE'] = previousBenchmarkMode;
      if (previousLease === undefined) delete process.env['BABEL_AUTONOMY_LEASE'];
      else process.env['BABEL_AUTONOMY_LEASE'] = previousLease;
      if (previousExecutionProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
      else process.env['BABEL_EXECUTION_PROFILE'] = previousExecutionProfile;
      if (previousHostFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
      else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousHostFallback;
      if (previousCompaction === undefined) delete process.env['BABEL_COMPACTION'];
      else process.env['BABEL_COMPACTION'] = previousCompaction;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeNodeFixture(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

function writeThenFailCommand(root: string, marker: string): string {
  const script = writeNodeFixture(
    root,
    'write-then-fail.mjs',
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'written-before-failure\\n', 'utf8');\nprocess.exit(7);\n`,
  );
  return `node ${shellArg(script)} ${shellArg(marker)}`;
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function runChildProcess(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`lifecycle child timed out: ${stderr}`));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}

function makeCrashDriver(
  driverPath: string,
  command: string,
): string {
  const chatEngine = pathToFileURL(join(process.cwd(), 'src', 'agent', 'chatEngine.ts')).href;
  const observability = pathToFileURL(join(process.cwd(), 'src', 'agent', 'chatEngineObservability.ts')).href;
  const runsLayout = pathToFileURL(join(process.cwd(), 'src', 'cli', 'runsLayout.ts')).href;
  const source = `
const { ChatEngine } = await import(${JSON.stringify(chatEngine)});
const { persistTranscriptToDisk } = await import(${JSON.stringify(observability)});
const { chatSessionDir } = await import(${JSON.stringify(runsLayout)});
const runId = process.env.BABEL_LIFECYCLE_RUN_ID;
const projectRoot = process.env.BABEL_LIFECYCLE_PROJECT_ROOT;
const command = ${JSON.stringify(command)}.replace('__BABEL_LIFECYCLE_PARENT_PID__', String(process.pid));
if (!runId || !projectRoot) throw new Error('lifecycle driver environment is incomplete');
const runner = {
  async *executeWithToolsStream() {
    yield { type: 'tool_use', id: 'crash-tool', name: 'run_command', input: { command } };
    yield { type: 'done', finishReason: 'tool_calls' };
  },
  async execute() { return { type: 'completion', answer: 'unreachable' }; },
  async executeRaw() { return 'unreachable'; },
  getLastInvocationMetadata() { return null; },
};
const engine = new ChatEngine({
  task: 'perform the crash-after-effect lifecycle fixture',
  projectRoot,
  runId,
  model: 'deepseek-v4-flash',
  maxTurns: 4,
  providerRunner: runner,
  providerPolicy: {
    policyPath: 'test-fixture', family: 'test-fixture', selectedTier: 'cheap',
    resolvedBackendKey: 'test-fixture', provider: 'deepinfra', providerModelId: 'test-fixture-model',
    expensive: false, enabled: true, experimental: true, blockedWithoutExplicitOptIn: false,
    approximateInputTokens: 0, approximateOutputTokens: 0, warnings: [], waterfall: [], stagePolicies: [],
    contextWindow: 128000, contextLimit: 128000, maxOutputTokens: 4096, nativeToolUse: true,
  },
});
await persistTranscriptToDisk(chatSessionDir(runId), [
  { role: 'system', content: 'deterministic lifecycle fixture' },
  { role: 'user', content: 'perform the crash-after-effect lifecycle fixture' },
]);
await engine.submitMessage('perform the crash-after-effect lifecycle fixture', {});
`;
  writeFileSync(driverPath, source, 'utf8');
  return driverPath;
}

describe('ChatEngine lifecycle and crash qualification', { concurrency: false }, () => {
  test('write-then-fail records process failure while preserving the real filesystem effect', async () => {
    const fixture = makeFixture();
    try {
      const runId = 'write-then-fail';
      const marker = join(fixture.project, 'marker.txt');
      const command = writeThenFailCommand(fixture.root, marker);
      const runner = makeRunner((call) =>
        call === 0
          ? [
              { type: 'tool_use', id: 'write-fail', name: 'run_command', input: { command } },
              { type: 'done', finishReason: 'tool_calls' },
            ]
          : [
              { type: 'text_delta', text: 'observed failed verifier' },
              { type: 'done', finishReason: 'stop' },
            ],
      );
      const result = await makeEngine(fixture.project, runId, runner).submitMessage('run the write-then-fail fixture', {});

      assert.ok(
        existsSync(marker),
        `the real child process must have written the marker; status=${result.status}; runDir=${result.runDir}; events=${JSON.stringify(readEvents(runId))}`,
      );
      assert.equal(readFileSync(marker, 'utf8'), 'written-before-failure\n');
      const events = readEvents(runId);
      const failed = events.find((event) => event.kind === 'tool_failed' && event.tool_call_id === 'write-fail');
      assert.ok(failed, 'the durable lifecycle must retain the failed process outcome');
      assert.equal(failed?.kind, 'tool_failed');
      assert.equal(failed?.exit_code, 7);
      assert.notEqual(result.status, 'failed', 'a failed command may still be followed by a model completion');
    } finally {
      fixture.cleanup();
    }
  });

  test('crash after a real effect before terminal settlement is reconciled on restart without duplicate execution', async () => {
    const fixture = makeFixture();
    try {
      const runId = 'crash-after-effect';
      const marker = join(fixture.project, 'crash-marker.txt');
      const killScript = writeNodeFixture(
        fixture.root,
        'kill-parent-after-write.mjs',
        `import { appendFileSync } from 'node:fs';\nimport { spawn } from 'node:child_process';\nappendFileSync(process.argv[2], 'effect\\n', 'utf8');\nconst targetPid = Number(process.argv[3]);\nif (!Number.isInteger(targetPid) || targetPid <= 0) throw new Error('missing lifecycle parent pid');\nif (process.platform === 'win32') {\n  const killer = spawn('taskkill', ['/PID', String(targetPid), '/T', '/F'], { detached: true, stdio: 'ignore', windowsHide: true });\n  killer.unref();\n} else {\n  process.kill(targetPid, 'SIGKILL');\n}\nsetTimeout(() => process.exit(137), 1000);\n`,
      );
      const command = `node ${shellArg(killScript)} ${shellArg(marker)} __BABEL_LIFECYCLE_PARENT_PID__`;
      const driver = makeCrashDriver(join(fixture.root, 'crash-driver.mjs'), command);
      const child = await runChildProcess(driver, {
        ...process.env,
        BABEL_RUNS_DIR: fixture.runs,
        BABEL_LIFECYCLE_RUN_ID: runId,
        BABEL_LIFECYCLE_PROJECT_ROOT: fixture.project,
      });

      assert.equal(existsSync(marker), true, `crash fixture must leave a real effect; stderr=${child.stderr}`);
      assert.equal(readFileSync(marker, 'utf8'), 'effect\n');
      const before = readEvents(runId);
      assert.equal(before.filter((event) => event.kind === 'tool_started').length, 1);
      assert.equal(
        before.filter((event) => event.kind === 'tool_completed' || event.kind === 'tool_failed').length,
        0,
        `crash boundary must precede terminal tool settlement: ${JSON.stringify(before)}`,
      );

      const resumeRunner = makeRunner((call) =>
        call === 0
          ? [
              { type: 'tool_use', id: 'crash-tool', name: 'run_command', input: { command } },
              { type: 'done', finishReason: 'tool_calls' },
            ]
          : [
              { type: 'text_delta', text: 'recovery requires reconciliation' },
              { type: 'done', finishReason: 'stop' },
            ],
      );
      const restored = await ChatEngine.restore(runId, {
        task: 'perform the crash-after-effect lifecycle fixture',
        projectRoot: fixture.project,
        model: 'deepseek-v4-flash',
        maxTurns: 4,
        providerRunner: resumeRunner as never,
        providerPolicy: FIXTURE_PROVIDER_POLICY,
      });
      const recovery = restored
        .getParityRuntime()
        .sessionEvents.events.find((event) => event.kind === 'tool_cancelled' && event.recovery_state === 'TOOL_OUTCOME_UNKNOWN');
      assert.ok(recovery, 'restart must settle the open tool as unknown, not successful');
      await restored.submitMessage('resume and inspect the prior effect', {});

      assert.equal(readFileSync(marker, 'utf8'), 'effect\n', 'resume must not blindly execute the same effect');
      const after = readEvents(runId);
      assert.equal(after.filter((event) => event.kind === 'tool_started').length, 1);
      assert.equal(after.filter((event) => event.kind === 'tool_completed' || event.kind === 'tool_failed').length, 0);
      assert.ok(after.some((event) => event.kind === 'tool_cancelled' && event.recovery_state === 'TOOL_OUTCOME_UNKNOWN'));
    } finally {
      fixture.cleanup();
    }
  });

  test('persistence failure cannot become a fabricated successful completion', async () => {
    const fixture = makeFixture();
    try {
      const runId = 'persistence-failure';
      let sabotaged = false;
      const runner = makeRunner(
        (call) => call === 0
          ? [
              { type: 'tool_use', id: 'persist-fail-tool', name: 'read_file', input: { path: 'missing.txt' } },
              { type: 'done', finishReason: 'tool_calls' },
            ]
          : [{ type: 'done', finishReason: 'stop' }],
        (event) => {
          if (!sabotaged && event.type === 'tool_use') {
            sabotaged = true;
            const eventPath = join(chatSessionDir(runId), 'session-events.jsonl');
            unlinkSync(eventPath);
            mkdirSync(eventPath);
          }
        },
      );
      const engine = makeEngine(fixture.project, runId, runner);
      // Mutation-intent fixture: the subject under test is the persistence
      // boundary, not operation classification. A READ_ONLY-shaped prompt would
      // (correctly) complete without patch pressure and never reach the
      // persistence-failure terminal this test qualifies.
      const events = await collectStream(engine.submitMessageStream('write the persistence boundary fixture'));
      assert.equal(sabotaged, true, 'the fixture must replace the opened event log at the real filesystem boundary');
      assert.ok(events.some((event) => event.type === 'tool_start'), `the injected runner must reach tool dispatch: ${JSON.stringify(events)}`);
      const terminal = events.find((event) => event.type === 'failed' || event.type === 'done');
      assert.ok(terminal, `persistence failure must reach a terminal outcome: ${JSON.stringify(events)}`);
      if (terminal?.type === 'done') {
        assert.notEqual(terminal.outcome, 'VERIFIED_COMPLETE', `persistence failure fabricated success: ${JSON.stringify(events)}`);
        assert.notEqual(terminal.outcome, 'NO_CHANGE_REQUIRED', `persistence failure fabricated success: ${JSON.stringify(events)}`);
        assert.ok(terminal.blockedReport, `blocked terminal must retain a diagnostic report: ${JSON.stringify(events)}`);
      }
      assert.equal(engine.getParityRuntime().sessionEvents.events.some((event) => event.kind === 'tool_completed'), false);
    } finally {
      fixture.cleanup();
    }
  });

  test('provider partial output remains failed and is not promoted to completion', async () => {
    const fixture = makeFixture();
    try {
      const runId = 'partial-provider-output';
      const runner: TestRunner = {
        async *executeWithToolsStream(...args: unknown[]) {
          const callbacks = args[5] as RunnerCallbacks;
          const inferenceId = 'partial-provider-inference';
          callbacks.onInvocationStarted?.({
            inference_id: inferenceId,
            provider: 'deepinfra',
            requested_model_id: 'test-fixture-model',
            normalized_model_id: 'test-fixture-model',
            sent_model_id: 'test-fixture-model',
            input_digest: 'a'.repeat(64),
          });
          yield { type: 'text_delta', text: 'partial provider output' };
          const failureReceipt = buildProviderFailureReceipt({
            inferenceId,
            provider: 'deepinfra',
            model: 'test-fixture-model',
            details: { message: 'provider disconnected after partial output' },
            actualAttempt: 1,
            maxAttempts: 1,
            stream: true,
            failureStage: 'stream',
            inferenceStarted: true,
            partialModelOutput: true,
            toolCallCount: 0,
            outputMaterial: 'partial provider output',
          });
          callbacks.onInvocationCompleted?.({
            inference_id: inferenceId,
            provider: 'deepinfra',
            model: 'test-fixture-model',
            status: 'failed',
            failure_receipt: failureReceipt,
            failure_class: failureReceipt.failure_class,
            failure_stage: 'stream',
            actual_attempt: 1,
            max_attempts: 1,
            stream: true,
            inference_started: true,
            partial_model_output: true,
            retryable: false,
            tool_call_count: 0,
          });
          yield { type: 'error', message: 'provider disconnected after partial output' };
        },
        async execute() {
          return { type: 'completion', answer: 'unreachable' };
        },
        async executeRaw() {
          return 'unreachable';
        },
        getLastInvocationMetadata() {
          return null;
        },
      };
      const engine = makeEngine(fixture.project, runId, runner);
      const events = await collectStream(engine.submitMessageStream('exercise provider interruption'));
      const failed = events.find((event) => event.type === 'failed');
      assert.ok(failed, 'provider interruption must produce a failed event');
      assert.equal(events.some((event) => event.type === 'done'), false);
      assert.ok(events.some((event) => event.type === 'answer_chunk' && event.text.includes('partial provider output')));
      const durable = readEvents(runId);
      const modelResult = durable.find((event) => event.kind === 'model_result_delivery');
      assert.ok(modelResult, 'partial provider failure must persist a model result delivery');
      assert.equal(modelResult?.kind, 'model_result_delivery');
      if (modelResult?.kind === 'model_result_delivery') {
        assert.equal(modelResult.status, 'failed');
        assert.equal(modelResult.failure_stage, 'stream');
        assert.equal(modelResult.partial_model_output, true);
        assert.equal(modelResult.failure_receipt?.partial_model_output, true);
      }
      const ended = durable.find((event) => event.kind === 'turn_ended');
      assert.ok(ended, 'partial provider failure must persist turn termination');
      if (ended?.kind === 'turn_ended') {
        assert.equal(ended.status, 'failed');
        assert.equal(ended.outcome, undefined, 'unclassified provider failure must remain unknown');
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('final prepared-request admission compacts once and retries the rebuilt request', async () => {
    const fixture = makeFixture();
    try {
      process.env['BABEL_COMPACTION'] = 'off';
      const overLimit = prepareProviderRequest({
        body: JSON.stringify({ messages: [{ role: 'user', content: 'over-limit fixture' }] }),
        mode: 'native',
        provider: 'deepinfra',
        requestedModelId: 'test-fixture-model',
        contextLimitTokens: 1,
        reservedCompletionTokens: 1,
        requestId: 'request-over-limit',
        attemptId: 'attempt-over-limit',
      });
      assert.equal(overLimit.admission, 'over_limit');

      let calls = 0;
      const runner: TestRunner = {
        async *executeWithToolsStream() {
          calls += 1;
          if (calls === 1) throw new PreparedRequestAdmissionError(overLimit);
          yield { type: 'text_delta', text: 'rebuilt request admitted' };
          yield { type: 'done', finishReason: 'stop' };
        },
        async execute() { return { type: 'completion', answer: 'fixture complete' }; },
        async executeRaw() { return 'fixture complete'; },
        getLastInvocationMetadata() { return null; },
      };
      const engine = makeEngine(fixture.project, 'prepared-admission', runner, {
        maxConversationMessages: 6,
        maxEstimatedTokens: 80,
      });
      engine.replaceConversation([
        { role: 'system', content: 'fixture system' },
        ...Array.from({ length: 8 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `retained fact ${index}`,
        })),
      ]);

      const events = await collectStream(engine.submitMessageStream('explain the retained facts', 'explain'));
      assert.equal(calls, 2, `admission recovery must issue one rebuilt attempt: ${JSON.stringify(events)}`);
      assert.ok(events.some((event) => event.type === 'context_compacted'));
      assert.ok(events.some((event) => event.type === 'done' && event.answer.includes('rebuilt request admitted')));
    } finally {
      fixture.cleanup();
    }
  });

  test('two live engines keep concurrent roots and durable session events isolated', async () => {
    const fixture = makeFixture();
    try {
      process.env['BABEL_COMPACTION'] = 'off';
      const rootA = join(fixture.root, 'root-a');
      const rootB = join(fixture.root, 'root-b');
      mkdirSync(rootA, { recursive: true });
      mkdirSync(rootB, { recursive: true });
      const targetA = join(rootA, 'a.txt');
      const targetB = join(rootB, 'b.txt');
      const runner = (target: string, id: string) => makeRunner((call) =>
        call === 0
          ? [
              { type: 'tool_use', id, name: 'write_file', input: { path: target, content: `${id}\n` } },
              { type: 'done', finishReason: 'tool_calls' },
            ]
          : [
              { type: 'text_delta', text: id },
              { type: 'done', finishReason: 'stop' },
            ],
      );
      const engineA = makeEngine(rootA, 'concurrent-a', runner(targetA, 'a-effect'));
      const engineB = makeEngine(rootB, 'concurrent-b', runner(targetB, 'b-effect'));
      await Promise.all([
        engineA.submitMessage('write the root A fixture', {}),
        engineB.submitMessage('write the root B fixture', {}),
      ]);
      assert.equal(readFileSync(targetA, 'utf8'), 'a-effect\n');
      assert.equal(readFileSync(targetB, 'utf8'), 'b-effect\n');
      assert.equal(existsSync(join(rootA, 'b.txt')), false);
      assert.equal(existsSync(join(rootB, 'a.txt')), false);
      assert.ok(readEvents('concurrent-a').some((event) => event.kind === 'mutation_batch'));
      assert.ok(readEvents('concurrent-b').some((event) => event.kind === 'mutation_batch'));
    } finally {
      fixture.cleanup();
    }
  });

  test('repeated real-engine compaction persists a resumable boundary', async () => {
    const fixture = makeFixture();
    const previousCompactionBase = process.env['BABEL_COMPACTION_API_BASE'];
    const previousCompactionModel = process.env['BABEL_COMPACTION_MODEL'];
    try {
      process.env['BABEL_COMPACTION'] = 'on';
      // Force the compaction manager's provider/model coherence guard to use
      // its deterministic heuristic strategy; no live inference is allowed.
      process.env['BABEL_COMPACTION_API_BASE'] = 'https://api.anthropic.com';
      process.env['BABEL_COMPACTION_MODEL'] = 'test-fixture-model';
      const runId = 'repeated-compaction';
      const runner = makeRunner((_call) => [
        { type: 'text_delta', text: 'durable fact: lifecycle nonce retained' },
        { type: 'done', finishReason: 'stop' },
      ]);
      const engine = makeEngine(fixture.project, runId, runner, {
        maxConversationMessages: 6,
        maxEstimatedTokens: 50,
        maxTurns: 16,
      });
      let compactions = 0;
      for (let i = 0; i < 10; i += 1) {
        // Mutation-intent fixture: the subject under test is repeated
        // compaction, and a READ_ONLY-shaped prompt would (correctly) complete
        // on turn one without growing the conversation to the compaction
        // threshold.
        const events = await collectStream(engine.submitMessageStream(`update the lifecycle fixture turn ${i}`));
        compactions += events.filter((event) => event.type === 'context_compacted').length;
      }
      assert.ok(compactions >= 2, `expected repeated real-engine compaction, observed ${compactions}`);
      await persistTranscriptToDisk(chatSessionDir(runId), engine.getConversation() as ChatMessage[]);
      let restored: ChatEngine;
      try {
        restored = await ChatEngine.restore(runId, {
          task: 'repair the deterministic lifecycle fixture',
          projectRoot: fixture.project,
          model: 'deepseek-v4-flash',
          maxTurns: 4,
          providerRunner: makeRunner(() => [
            { type: 'text_delta', text: 'resumed after compaction' },
            { type: 'done', finishReason: 'stop' },
          ]) as never,
          providerPolicy: FIXTURE_PROVIDER_POLICY,
        });
      } catch (error) {
        const eventPath = join(chatSessionDir(runId), 'session-events.jsonl');
        const lines = readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean);
        throw new Error(
          `supported restore rejected the durable compaction session: ${error instanceof Error ? error.message : String(error)}; ` +
          `event_path=${eventPath}; line_23=${lines[22] ?? '(missing)'}`,
        );
      }
      assert.ok(
        restored.getParityRuntime().sessionEvents.events.some((event) => event.kind === 'compaction_committed'),
        `restored durable kinds=${restored.getParityRuntime().sessionEvents.events.map((event) => event.kind).join(',')}`,
      );
      assert.ok(restored.getConversation().some((message) => message.content.includes('lifecycle nonce retained')));
    } finally {
      if (previousCompactionBase === undefined) delete process.env['BABEL_COMPACTION_API_BASE'];
      else process.env['BABEL_COMPACTION_API_BASE'] = previousCompactionBase;
      if (previousCompactionModel === undefined) delete process.env['BABEL_COMPACTION_MODEL'];
      else process.env['BABEL_COMPACTION_MODEL'] = previousCompactionModel;
      fixture.cleanup();
    }
  });
});
