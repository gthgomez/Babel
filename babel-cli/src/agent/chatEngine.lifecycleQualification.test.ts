import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';

import { ChatEngine } from './chatEngine.js';
import { createToolExecutor } from './toolExecutor.js';
import { executeTool } from '../localTools.js';
import { loadEffectLedger } from '../executor/effectLedger.js';
import type { ChatEvent } from './chatEngine.js';
import { persistTranscriptToDisk } from './chatEngineObservability.js';
import { getBackgroundShellJob, killAllBackgroundShells, startBackgroundShell } from './backgroundShell.js';
import { executeAwaitCommandAction } from './chatBackgroundShell.js';
import type { ChatMessage } from './chatToolDefinitions.js';
import { CompactionManager } from './chatCompaction.js';
import { recordUserMessage } from './threadEventLog.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { buildProviderFailureReceipt } from '../runners/providerFailureReceipt.js';
import type { RunnerCallbacks } from '../runners/base.js';
import {
  PreparedRequestAdmissionError,
  prepareProviderRequest,
} from '../runners/preparedProviderRequest.js';
import { chatSessionDir, openSessionAdmissionStore } from '../cli/runsLayout.js';
import type { AdmissionStore } from '../runtime/admission.js';
import {
  inspectSessionEventLogFromDir,
  recordBudgetSnapshot,
  type SessionEvent,
} from './sessionEvents.js';

type TestRunner = {
  executeWithToolsStream: (...args: unknown[]) => AsyncGenerator<any, void, undefined>;
  execute: () => Promise<{ type: 'completion'; answer: string }>;
  executeRaw: () => Promise<string>;
  getLastInvocationMetadata: () => null;
  executeRawStream?: (...args: unknown[]) => AsyncGenerator<string, void, undefined>;
  /** Fixture-only: satisfies compaction admission without implying production wire parity. */
  buildNativeToolsWireBody: (
    messages: Array<{ role: string; content?: unknown }>,
    tools: unknown[],
    systemPrompt?: string,
    options?: { stream?: boolean },
  ) => string;
  getNativeRequestReservedCompletionTokens: () => number;
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

/** Fixture-only compaction admission wire (not production transport parity). */
const fixtureNativeWireHooks = {
  buildNativeToolsWireBody(
    messages: Array<{ role: string; content?: unknown }>,
    tools: unknown[],
    _systemPrompt?: string,
    options: { stream?: boolean } = {},
  ): string {
    return JSON.stringify({
      model: FIXTURE_PROVIDER_POLICY.providerModelId,
      stream: options.stream ?? true,
      max_tokens: FIXTURE_PROVIDER_POLICY.maxOutputTokens ?? 4_096,
      temperature: 0,
      tools,
      tool_choice: 'auto',
      messages,
    });
  },
  getNativeRequestReservedCompletionTokens(): number {
    return FIXTURE_PROVIDER_POLICY.maxOutputTokens ?? 4_096;
  },
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
    ...fixtureNativeWireHooks,
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

/** Selected fixtures also exercise the independent repository-evidence path. */
function commitCapturedProject(project: string): void {
  writeFileSync(join(project, 'fixture.txt'), 'lifecycle fixture\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'Fixture'],
    ['add', 'fixture.txt'],
    ['commit', '-q', '-m', 'fixture'],
  ]) {
    const git = spawnSync('git', args, {
      cwd: project,
      windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(project, 'absent-global-git-config') },
    });
    assert.equal(git.status, 0, git.stderr?.toString());
  }
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
  const previousDryRun = process.env['BABEL_DRY_RUN'];
  const previousDryRunSource = process.env['BABEL_DRY_RUN_SOURCE'];
  process.env['BABEL_RUNS_DIR'] = runs;
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    // Each independent fixture owns its authority. A prior background job's
    // fail-closed drift revocation must not revoke a later fixture's lease.
    leaseId: `lifecycle-fixture-${randomUUID()}`,
    scope: { repository: 'lifecycle-fixture', objective: 'deterministic lifecycle qualification' },
    allowedCapabilities: ['run_arbitrary_code', 'run_local_command', 'run_tests', 'edit_task_files', 'inspect_repository'],
  });
  // This is an explicit test-only host boundary for real child-process fixtures;
  // production defaults and safety policy remain unchanged.
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  // Real-effect mechanics must not depend on the operator's persisted flags.
  process.env['BABEL_DRY_RUN'] = '0';
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session';
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
      if (previousDryRun === undefined) delete process.env['BABEL_DRY_RUN'];
      else process.env['BABEL_DRY_RUN'] = previousDryRun;
      if (previousDryRunSource === undefined) delete process.env['BABEL_DRY_RUN_SOURCE'];
      else process.env['BABEL_DRY_RUN_SOURCE'] = previousDryRunSource;
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
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else child.kill('SIGKILL');
    }, 45_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) { reject(new Error(`lifecycle child timed out: ${stderr}`)); return; }
      resolve({ code, signal, stderr });
    });
  });
}

function makeCrashDriver(
  driverPath: string,
  command: string,
): string {
  const chatEngine = new URL('./chatEngine.ts', import.meta.url).href;
  const observability = new URL('./chatEngineObservability.ts', import.meta.url).href;
  const runsLayout = new URL('../cli/runsLayout.ts', import.meta.url).href;
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
  task: 'Create the marker with the crash-after-effect lifecycle fixture',
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
  { role: 'user', content: 'Create the marker with the crash-after-effect lifecycle fixture' },
]);
await engine.submitMessage('Create the marker with the crash-after-effect lifecycle fixture', {});
`;
  writeFileSync(driverPath, source, 'utf8');
  return driverPath;
}

describe('ChatEngine lifecycle and crash qualification', { concurrency: false }, () => {
  test('Chat repeats a byte-capped long-line read and reports incomplete source', async () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.project, 'long-lines.txt'),
      `${'A'.repeat(60_000)}\n${'B'.repeat(60_000)}\n`,
      'utf8',
    );
    let calls = 0;
    const runner: TestRunner = {
      ...makeRunner(() => []),
      async *executeWithToolsStream(..._args: unknown[]) {
        if (calls++ === 0) {
          yield {
            type: 'tool_use', id: 'read-long-1', name: 'read_file',
            input: { path: 'long-lines.txt' },
          };
        } else if (calls === 2) {
          yield {
            type: 'tool_use', id: 'read-long-2', name: 'read_file',
            input: { path: 'long-lines.txt' },
          };
        } else {
          yield { type: 'text_delta', text: 'The capped source was reported accurately.' };
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        yield { type: 'done', finishReason: 'tool_calls' };
      },
    };
    const engine = makeEngine(fixture.project, 'long-line-read-cap', runner, {
      maxTurns: 5,
      toolExecutorForTesting: createToolExecutor({
        executeTool: (request, context) =>
          executeTool(
            request.tool === 'file_read' ? { ...request, raw: true } : request,
            context,
          ),
      }),
    });
    try {
      await collectStream(
        engine.submitMessageStream('Read long-lines.txt twice and report its contents.'),
      );
      assert.equal(calls, 3, 'both repeated read actions reached the Chat executor');
      const readObservations = engine.getConversation()
        .filter(message =>
          message.role === 'tool' &&
          message.content.startsWith('### read_file long-lines.txt'))
        .map(message => message.content);
      assert.equal(readObservations.length, 2, 'both tool calls produced a Chat observation');
      assert.equal(
        readObservations.filter(observation => observation.includes('source byte-capped')).length,
        2,
        'each real Chat observation identifies the byte-capped source');
      assert.equal(
        readObservations.some(observation => observation.includes('complete file')),
        false,
        'a byte-capped result is never described as a complete file');
      assert.equal(
        engine['fullReadCounts'].size,
        0,
        'an incomplete source read does not consume the full-read allowance');
    } finally { fixture.cleanup(); }
  });

  test('await_command enrolls large output for owner-bound artifact retrieval', async () => {
    const fixture = makeFixture();
    const sentinel = 'BACKGROUND_MIDDLE_ONLY_91ac';
    const script = writeNodeFixture(
      fixture.root,
      'background-output.mjs',
      `console.log(Array.from({ length: 1200 }, (_, i) => i === 600 ? '${sentinel}' : 'diagnostic row ' + i + ' ' + 'x'.repeat(40)).join('\\n'));`,
    );
    let engine!: ChatEngine;
    let turn = 0;
    let artifactId = '';
    let retrieved = false;
    const runner: TestRunner = {
      ...makeRunner(() => []),
      async *executeWithToolsStream(...args: unknown[]) {
        const request = JSON.stringify(args);
        if (turn++ === 0) {
          yield {
            type: 'tool_use', id: 'background-large-output', name: 'run_command',
            input: { command: `node ${shellArg(script)}`, background: true },
          };
        } else if (turn === 2) {
          const started = (engine as any).toolCallLog.find(
            (entry: { detail?: string }) => entry.detail?.startsWith('background started '),
          );
          const taskId = started?.detail?.match(/bg-\d+/)?.[0];
          assert.ok(taskId, 'background job started before await');
          yield {
            type: 'tool_use', id: 'await-large-output', name: 'await_command',
            input: { task_id: taskId },
          };
        } else if (turn === 3) {
          assert.equal(
            request.includes(sentinel), false,
            'middle output is omitted from the bounded preview',
          );
          const id = request.match(/artifact_id:\s*([a-f0-9-]{36})/)?.[1];
          assert.ok(id, 'await observation includes its enrolled artifact handle');
          artifactId = id;
          yield {
            type: 'tool_use', id: 'read-background-artifact', name: 'read_artifact',
            input: { artifact_id: artifactId, query: sentinel },
          };
        } else {
          assert.equal(
            request.includes(sentinel), true,
            'read_artifact retrieves the omitted background diagnostic',
          );
          retrieved = true;
          yield { type: 'text_delta', text: 'The background diagnostic was retrieved.' };
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        yield { type: 'done', finishReason: 'tool_calls' };
      },
    };
    engine = makeEngine(
      fixture.project,
      'background-artifact-retrieval',
      runner,
      { maxTurns: 8, operatorMode: 'default', hardPlanMode: false },
    );
    try {
      await collectStream(
        engine.submitMessageStream(
          'Implement the background output feature by running the diagnostic and retrieving its middle output.',
          'execute',
        ),
      );
      assert.equal(retrieved, true);
      assert.match(artifactId, /^[a-f0-9-]{36}$/);
    } finally {
      const killed = killAllBackgroundShells({
        ownerId: (engine as any).engineRunId,
        includeDetached: true,
      });
      engine.cancel();
      await Promise.all(killed.killed.map(id => getBackgroundShellJob(id)?.done));
      fixture.cleanup();
    }
  });

  test('await_command drops results when submission ownership changes during wait', async () => {
    const fixture = makeFixture();
    const spillWrites: string[] = [];
    try {
      for (const output of ['small output', 'spill-sized output '.repeat(400)]) {
        const script = writeNodeFixture(
          fixture.root,
          `stale-await-${output.length}.mjs`,
          `console.log(${JSON.stringify(output)}); await new Promise(resolve => setTimeout(resolve, 50));`,
        );
        const job = startBackgroundShell({
          command: `node ${shellArg(script)}`,
          cwd: fixture.project,
          timeoutMs: 10_000,
          ownerId: 'stale-await-fixture',
        });
        let current = true;
        let logged = false;
        let completed = false;
        let settledStale = false;
        const result = await executeAwaitCommandAction(
          { task_id: job.id },
          {
            projectRoot: fixture.project,
            tool: 'await_command',
            target: job.id,
            toolId: 1,
            index: 1,
            pushLog: () => { logged = true; },
            onToolComplete: () => { completed = true; },
            onBeforeAwait: () => { setImmediate(() => { current = false; }); },
            isSubmissionCurrent: () => current,
            settleStale: () => {
              settledStale = true;
              return { index: 1, observation: 'stale action settled' };
            },
            artifactAccess: {
              read: () => '',
              writeSpill: (name, content) => {
                spillWrites.push(name);
                return content;
              },
            },
          },
        );
        assert.deepEqual(result, { index: 1, observation: 'stale action settled' });
        assert.equal(settledStale, true);
        assert.equal(logged, false, 'stale output is not added to the tool log');
        assert.equal(completed, false, 'stale output does not complete the old tool call');
      }
      assert.deepEqual(spillWrites, [], 'stale output is never enrolled as an artifact');
    } finally {
      const killed = killAllBackgroundShells({ ownerId: 'stale-await-fixture', includeDetached: true });
      await Promise.all(killed.killed.map(id => getBackgroundShellJob(id)?.done));
      fixture.cleanup();
    }
  });

  test('overlapping engines retain command cwd, fallback reads, evidence roots and ambient restoration', { timeout: 30_000 }, async () => {
    const fixture = makeFixture();
    const previousRoot = process.env['BABEL_PROJECT_ROOT'];
    process.env['BABEL_PROJECT_ROOT'] = fixture.root;
    const barrier = () => {
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      return { promise, release };
    };
    const entered = [barrier(), barrier()];
    const releases = [barrier(), barrier()];
    const projects = ['a', 'b'].map(name => join(fixture.project, name));
    const results: Array<{ cwd: string; fallback: string }> = [];
    const engines = projects.map((project, index) => {
      mkdirSync(project);
      writeFileSync(join(project, 'cwd.mjs'), 'console.log(process.cwd())');
      const runner = makeRunner(call => call < 2 ? [{ type: 'tool_use', id: `root-${index}-${call}`,
        name: call === 0 ? 'write_file' : 'run_command',
        input: call === 0 ? { path: 'result.txt', content: `engine-${index}` } : { command: 'node cwd.mjs' },
      }, { type: 'done', finishReason: 'tool_calls' }] : [
        { type: 'text_delta', text: 'Root inspection complete.' }, { type: 'done', finishReason: 'stop' },
      ]);
      return makeEngine(project, `root-engine-${index}`, runner, {
        task: 'Write result.txt then inspect command cwd with node cwd.mjs',
        toolExecutorForTesting: createToolExecutor({ executeTool: async (request, context) => {
          if (request.tool === 'file_write') {
            entered[index]!.release();
            await releases[index]!.promise;
          }
          assert.equal(context.projectRoot, project);
          const result = await executeTool(request, context);
          if (request.tool === 'shell_exec') {
            const { projectRoot: _explicitRoot, ...fallbackContext } = context;
            const fallback = await executeTool({ tool: 'file_read', path: 'result.txt' }, fallbackContext);
            assert.equal(fallback.exit_code, 0);
            results[index] = { cwd: result.stdout.trim(), fallback: fallback.stdout };
          }
          return result;
        } }),
      });
    });
    const pending: Array<Promise<ChatEvent[]>> = [];
    try {
      pending.push(collectStream(engines[0]!.submitMessageStream('Write result.txt then inspect command cwd with node cwd.mjs')));
      await entered[0]!.promise;
      pending.push(collectStream(engines[1]!.submitMessageStream('Write result.txt then inspect command cwd with node cwd.mjs')));
      await entered[1]!.promise;
      releases[0]!.release(); await pending[0];
      assert.equal(process.env['BABEL_PROJECT_ROOT'], projects[1]);
      releases[1]!.release(); await pending[1];
      for (const [index, project] of projects.entries()) {
        assert.equal(readFileSync(join(project, 'result.txt'), 'utf8'), `engine-${index}`);
        assert.equal(results[index]?.cwd.toLowerCase(), project.toLowerCase());
        assert.equal(results[index]?.fallback.includes(`engine-${index}`), true);
        const effects = loadEffectLedger(chatSessionDir(`root-engine-${index}`));
        assert.equal(effects.some(record => record.status === 'completed' && record.targetPaths.includes(join(project, 'result.txt'))), true);
        assert.equal(effects.some(record => record.targetPaths.some(path => path.startsWith(projects[1 - index]!))), false);
      }
      assert.equal(process.env['BABEL_PROJECT_ROOT'], fixture.root);
    } finally {
      releases.forEach(release => release.release());
      await Promise.allSettled(pending);
      if (previousRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = previousRoot;
      fixture.cleanup();
    }
  });
  test('scripted provider retrieves an omitted middle diagnostic through governed artifact dispatch', async () => {
    const fixture = makeFixture();
    let request = 0;
    let observedDiagnostic = false;
    let artifactId = '';
    let readNext = false;
    let expectDenied = false;
    let observedDenial = false;
    const sentinel = 'MIDDLE_ONLY_DIAGNOSTIC_7f31';
    const output = Array.from({ length: 1200 }, (_, index) => index === 600
      ? sentinel : `ordinary log row ${index} ${'x'.repeat(30)}`).join('\n');
    const runner: TestRunner = {
      ...makeRunner(() => []),
      async *executeWithToolsStream(...args: unknown[]) {
        const input = JSON.stringify(args);
        if (request++ === 0) {
          yield { type: 'tool_use', id: 'long-output', name: 'run_command', input: { command: 'node diagnostic.mjs' } };
        } else if (request === 2) {
          assert.equal(input.includes(sentinel), false, 'sentinel must be absent from head/tail');
          const id = input.match(/artifact_id:\s*([a-f0-9-]{36})/)?.[1];
          assert.ok(id, 'provider must receive a discoverable artifact handle');
          artifactId = id;
          assert.equal(input.includes('read_artifact'), true);
          yield { type: 'tool_use', id: 'middle-read', name: 'read_artifact', input: { artifact_id: id, query: sentinel } };
        } else {
          if (readNext) {
            readNext = false;
            yield { type: 'tool_use', id: `continued-read-${request}`, name: 'read_artifact', input: { artifact_id: artifactId, query: sentinel } };
            yield { type: 'done', finishReason: 'tool_calls' };
            return;
          }
          if (expectDenied) {
            const messages = args[0] as Array<{ role: string; content?: unknown }>;
            const toolResult = messages.filter(message => message.role === 'tool').at(-1)?.content;
            assert.equal(typeof toolResult === 'string' && !toolResult.includes(sentinel) && toolResult.includes('ARTIFACT_DENIED'), true);
            observedDenial = true;
            yield { type: 'text_delta', text: 'Prior task artifact was denied.' };
            yield { type: 'done', finishReason: 'stop' };
            return;
          }
          // The raw record adds command, exit and stdout header lines.
          assert.equal(input.includes(`604: ${sentinel}`), true, 'next provider request contains middle diagnostic');
          assert.equal(input.includes('sha256:'), true, 'next provider request contains content provenance');
          assert.equal(input.includes('source: run_command call=long-output'), true);
          observedDiagnostic = true;
          yield { type: 'text_delta', text: 'The diagnostic is now visible.' };
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        yield { type: 'done', finishReason: 'tool_calls' };
      },
    };
    const engine = makeEngine(fixture.project, 'middle-diagnostic', runner, {
      task: 'Repair diagnostic.mjs and verify with node diagnostic.mjs',
      maxTurns: 32,
      toolExecutorForTesting: createToolExecutor({ executeTool: async () => ({ exit_code: 0, stdout: output, stderr: '' }) }),
    });
    try {
      const events = await collectStream(engine.submitMessageStream('Repair diagnostic.mjs and verify with node diagnostic.mjs. First run it and inspect the complete diagnostic output.'));
      assert.equal(observedDiagnostic, true, JSON.stringify({ request, events: events.map(event => ({ type: event.type,
        ...('message' in event ? { message: event.message } : {}), ...('error' in event ? { error: event.error } : {}),
        ...('text' in event ? { text: event.text } : {}),
      })) }));
      const ownerBefore = engine['taskAllowance']?.taskOwnerId;
      const runRead = async (target: ChatEngine, continueTask: boolean) => {
        readNext = true;
        const nextEvents = await collectStream(target.submitMessageStream(continueTask ? 'Continue repairing diagnostic.mjs' : 'Implement an unrelated new feature', 'execute', { continueTask }));
        assert.equal(readNext, false, JSON.stringify({ request, terminal: nextEvents.filter(event => event.type === 'failed').map(event => ({type:event.type, error:event.error})) }));
      };
      await runRead(engine, true);
      assert.equal(engine['taskAllowance']?.taskOwnerId, ownerBefore, 'same-task continuation retains ownership');
      const restored = await ChatEngine.restore('middle-diagnostic', {
        task: 'Repair diagnostic.mjs and verify with node diagnostic.mjs', projectRoot: fixture.project,
        maxTurns: 32,
        model: 'deepseek-v4-flash', providerRunner: runner as never, providerPolicy: FIXTURE_PROVIDER_POLICY,
      });
      assert.equal(restored['taskAllowance']?.taskOwnerId, ownerBefore, 'cold restore uses durable task ownership');
      await runRead(restored, true);
      expectDenied = true;
      await runRead(restored, false);
      assert.equal(observedDenial, true, 'replacement task cannot retrieve prior evidence');
    } finally { fixture.cleanup(); }
  });
  test('cancellation with prior real proof preserves a detached late effect and requires fresh resumed verification', async () => {
    const fixture = makeFixture();
    const runId = 'late-effect-cancel';
    const release = join(fixture.project, 'release.txt');
    const target = join(fixture.project, 'result.txt');
    const script = writeNodeFixture(fixture.root, 'detached-late-writer.mjs',
      `import { existsSync, writeFileSync } from 'node:fs'; const timer = setInterval(() => { if (existsSync(process.argv[2])) { writeFileSync(process.argv[3], 'late'); clearInterval(timer); } }, 20); setTimeout(() => process.exit(0), 10000);`);
    writeFileSync(target, 'red');
    writeFileSync(join(fixture.project, 'fixture.test.mjs'), `import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(readFileSync('result.txt', 'utf8'), 'green');`);
    let engine: ChatEngine;
    let sawRealProof = false;
    let observedProof: any;
    const runner = makeRunner(call => {
      if (call === 2) {
        const receipt = (engine as any).lastVerifierReceipt;
        const proofCall = (engine as any).toolCallLog.find((entry: { toolCallId?: string }) => entry.toolCallId === 'parent-proof');
        observedProof = receipt ? { command: receipt.command, exit_code: receipt.exit_code, stale: receipt.stale, tests_total: receipt.tests_total } : null;
        sawRealProof = receipt?.exit_code === 0 && !receipt?.stale && receipt?.tests_total > 0 && /# pass 1\b/.test(proofCall?.stdout ?? '');
      }
      if (call === 3) engine.cancel();
      const actions = [
        { id: 'parent-repair', name: 'write_file', input: { path: 'result.txt', content: 'green' } },
        { id: 'parent-proof', name: 'run_command', input: { command: 'node --test --test-reporter=tap fixture.test.mjs' } },
        { id: 'late-writer', name: 'run_command', input: { command: `node ${shellArg(script)} ${shellArg(release)} ${shellArg(target)}`, background: true, detached: true } },
        { id: 'cancelled-finish', name: 'finish', input: { summary: 'complete', verification: [] } },
      ];
      return [{ type: 'tool_use', ...actions[Math.min(call, 3)] }, { type: 'done', finishReason: 'tool_calls' }];
    });
    engine = makeEngine(fixture.project, runId, runner);
    let job: ReturnType<typeof getBackgroundShellJob>;
    try {
      await persistTranscriptToDisk(chatSessionDir(runId), [{ role: 'user', content: 'Repair result.txt and run node --test fixture.test.mjs' }]);
      const events: ChatEvent[] = [];
      for await (const event of engine.submitMessageStream('Repair result.txt and run node --test fixture.test.mjs')) events.push(event);
      assert.equal(sawRealProof, true, `the cancellation scenario must first execute a current passing parent test: ${JSON.stringify(observedProof)}`);
      assert.equal(events.filter(event => ['done', 'failed', 'cancelled'].includes(event.type)).length, 1);
      assert.ok(events.every(event => !('outcome' in event) || event.outcome !== 'VERIFIED_COMPLETE'));
      const call = (engine as any).toolCallLog.find((entry: { detail?: string }) => entry.detail?.startsWith('background started '));
      assert.ok(call, 'the actual owned writer was launched');
      job = getBackgroundShellJob(call.detail.match(/bg-\d+/)[0]);
      assert.equal(job?.status, 'running', 'cancellation alone does not settle an explicitly detached process');
      assert.equal(readFileSync(target, 'utf8'), 'green');
      writeFileSync(release, 'release');
      await job!.done;
      assert.equal(getBackgroundShellJob(job!.id)?.status, 'completed', 'quiescence is checked only after actual process exit');
      assert.equal(readFileSync(target, 'utf8'), 'late', 'the real late effect is retained');
      const resumed = await ChatEngine.restore(runId, {
        task: 'Repair result.txt and run node --test fixture.test.mjs', projectRoot: fixture.project,
        model: 'deepseek-v4-flash', maxTurns: 4, providerPolicy: FIXTURE_PROVIDER_POLICY,
        providerRunner: makeRunner(call => call === 0
          ? [{ type: 'tool_use', id: 'fresh-red-proof', name: 'run_command', input: { command: 'node --test --test-reporter=tap fixture.test.mjs' } }, { type: 'done', finishReason: 'tool_calls' }]
          : [{ type: 'text_delta', text: 'The current test fails after the late effect.' }, { type: 'done', finishReason: 'stop' }]) as never,
      });
      const result = await resumed.submitMessage('Inspect and test the actual resumed parent result', {});
      assert.notEqual(result.outcome, 'VERIFIED_COMPLETE');
      assert.notEqual((resumed as any).lastVerifierReceipt?.exit_code, 0, 'resume cannot reuse the earlier green receipt across the unresolved late effect');
      assert.equal(readFileSync(target, 'utf8'), 'late');
      // Run the assertion module directly: inherited node:test selection must
      // not turn a fixture oracle into an empty filtered test run.
      const independent = spawnSync(process.execPath, ['fixture.test.mjs'], { cwd: fixture.project, env: process.env, windowsHide: true, timeout: 10_000 });
      assert.equal(independent.status, 1, `the independent current-byte oracle must observe the late effect as red: ${independent.stderr?.toString()}`);
      assert.equal(readEvents(runId).filter(event => event.kind === 'tool_started' && event.tool_call_id === 'late-writer').length, 1, 'resume must not replay the writer');
    } finally {
      const killed = killAllBackgroundShells({ ownerId: (engine as any).engineRunId, includeDetached: true });
      engine.cancel();
      await Promise.all(killed.killed.map(id => getBackgroundShellJob(id)?.done));
      fixture.cleanup();
    }
  });
  test('an outstanding background writer cannot certify a completed parent deliverable', async () => {
    const fixture = makeFixture();
    const release = join(fixture.project, 'release.txt');
    const marker = join(fixture.project, 'late.txt');
    const script = writeNodeFixture(fixture.root, 'pending-writer.mjs',
      `import { existsSync, writeFileSync } from 'node:fs'; const timer = setInterval(() => { if (existsSync(process.argv[2])) { writeFileSync(process.argv[3], 'late effect'); clearInterval(timer); } }, 20); setTimeout(() => process.exit(0), 5000);`);
    const runner = makeRunner(call => call === 0
      ? [{ type: 'tool_use', id: 'pending-writer', name: 'run_command', input: { command: `node ${shellArg(script)} ${shellArg(release)} ${shellArg(marker)}`, background: true } }, { type: 'done', finishReason: 'tool_calls' }]
      : [{ type: 'text_delta', text: 'The requested background result is complete.' }, { type: 'done', finishReason: 'stop' }]);
    const engine = makeEngine(fixture.project, 'pending-writer', runner);
    try {
      const result = await engine.submitMessage('Write the late.txt deliverable and verify it before completing', {});
      assert.notEqual(result.outcome, 'VERIFIED_COMPLETE');
      assert.ok(result.toolCalls?.some(call => call.tool === 'run_command'));
      assert.equal(existsSync(marker), false, 'the blocked writer has not applied the deliverable');
    } finally {
      const killed = killAllBackgroundShells({ ownerId: (engine as any).engineRunId });
      engine.cancel();
      await Promise.all(killed.killed.map(id => getBackgroundShellJob(id)?.done));
      fixture.cleanup();
    }
  });
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
      const crashEvents = readEvents(runId);
      const crashSummary = crashEvents.map(event => ({
        kind: event.kind,
        exit_code: 'exit_code' in event ? event.exit_code : null,
        reason: 'reason' in event ? event.reason : null,
      }));
      assert.equal(existsSync(marker), true,
        `crash fixture must leave a real effect; child_code=${child.code}; signal=${child.signal}; events=${JSON.stringify(crashSummary)}; stderr=${child.stderr}`);

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
        task: 'Create the marker with the crash-after-effect lifecycle fixture',
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
      assert.equal(terminal.type, 'failed', 'an unavailable primary log must explicitly fail the stream');
      assert.ok(!events.some(event => event.type === 'tool_complete'), 'no tool effect crosses the failed durable boundary');
      assert.match(terminal.error, /session event persistence failed/, 'the failed event retains the primary-log error');
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
        ...fixtureNativeWireHooks,
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

  for (const capture of ['clean', 'empty-env', 'oversized', 'non-git', 'linked', 'runtime-overlap'] as const) {
    test(`final prepared-request admission compacts once and retries the rebuilt request with ${capture}`, async () => {
      const fixture = makeFixture();
      if (capture !== 'non-git') commitCapturedProject(fixture.project);
      if (capture === 'empty-env') writeFileSync(join(fixture.project, '.env'), '');
      if (capture === 'oversized') {
        writeFileSync(join(fixture.project, 'unrelated.apk'), '');
        truncateSync(join(fixture.project, 'unrelated.apk'), 1_000_001);
      }
      let selectedProject = fixture.project;
      if (capture === 'linked') {
        selectedProject = join(fixture.root, 'linked');
        const worktree = spawnSync('git', ['worktree', 'add', '--detach', selectedProject, 'HEAD'], {
          cwd: fixture.project, windowsHide: true,
        });
        assert.equal(worktree.status, 0, worktree.stderr?.toString());
      }
      if (capture === 'runtime-overlap') {
        process.env['BABEL_RUNS_DIR'] = join(fixture.project, 'runtime-runs');
        mkdirSync(process.env['BABEL_RUNS_DIR'], { recursive: true });
      }
      const runId = `prepared-admission-${capture}`;
      let admissionStore: AdmissionStore | undefined;
      try {
        process.env['BABEL_COMPACTION'] = 'off';
        let recoveryPhase = false;
        let failedCeiling: number | undefined;
        let calls = 0;
        const runner: TestRunner = {
          async *executeWithToolsStream() {
            if (!recoveryPhase) {
              yield { type: 'text_delta', text: 'retained fact: ' + 'synthetic lifecycle evidence. '.repeat(600) };
              yield { type: 'done', finishReason: 'stop' };
              return;
            }
            calls += 1;
            const body = engine.buildNativeCompactionAdmissionWireBody();
            const input = {
              body, mode: 'native' as const, provider: 'deepinfra',
              requestedModelId: FIXTURE_PROVIDER_POLICY.providerModelId!,
              reservedCompletionTokens: fixtureNativeWireHooks.getNativeRequestReservedCompletionTokens(),
            };
            if (calls === 1) {
              const unbounded = prepareProviderRequest({ ...input, contextLimitTokens: null });
              assert.ok(unbounded.accounting.estimated_total_tokens !== null);
              failedCeiling = unbounded.accounting.estimated_total_tokens - 2000;
              const overLimit = prepareProviderRequest({ ...input, contextLimitTokens: failedCeiling,
                requestId: 'request-over-limit', attemptId: 'attempt-over-limit' });
              assert.equal(overLimit.admission, 'over_limit');
              throw new PreparedRequestAdmissionError(overLimit);
            }
            assert.ok(failedCeiling !== undefined);
            const rebuilt = prepareProviderRequest({ ...input, contextLimitTokens: failedCeiling });
            assert.equal(rebuilt.admission, 'qualified', 'the retry must fit the same ceiling that rejected the first request');
            yield { type: 'text_delta', text: 'rebuilt request admitted' };
            yield { type: 'done', finishReason: 'stop' };
          },
          async execute() { return { type: 'completion', answer: 'fixture complete' }; },
          async executeRaw() { return 'fixture complete'; },
          getLastInvocationMetadata() { return null; },
          ...fixtureNativeWireHooks,
        };
        mkdirSync(fixture.runs, { recursive: true });
        const opened = openSessionAdmissionStore(runId);
        if (!opened.ok) throw new Error(opened.detail);
        admissionStore = opened.store;
        const engine = makeEngine(selectedProject, runId, runner, {
          admissionStore,
          maxConversationMessages: 80,
          maxEstimatedTokens: 128_000,
          maxTurns: 16,
          operation: 'READ_ONLY',
        });
        // Accumulate real durable messages: replacing only the live array would
        // leave the native wire history empty and would not prove request recovery.
        for (let index = 0; index < 4; index += 1) {
          const warmup = await collectStream(engine.submitMessageStream(`explain retained facts turn ${index}`, 'explain'));
          assert.equal(warmup.at(-1)?.type, 'done');
          assert.equal(warmup.some(event => event.type === 'context_compacted'), false);
        }
        recoveryPhase = true;

        const events = await collectStream(engine.submitMessageStream('explain the retained facts', 'explain'));
        assert.equal(calls, 2, `admission recovery must issue one rebuilt attempt: ${JSON.stringify(events)}`);
        assert.ok(events.some((event) => event.type === 'context_compacted'));
        assert.equal(events.filter(event => event.type === 'context_compacted').length, 1);
        assert.ok(events.some((event) => event.type === 'done' && event.answer.includes('rebuilt request admitted')));
        const checkpoint = engine.getParityRuntime().contextCheckpoint;
        assert.equal(checkpoint?.schema_version, 2);
        assert.equal(checkpoint?.workspace, null);
        assert.equal(checkpoint?.population.workspace_revision_current, false);
        assert.ok(checkpoint?.installed_lineage?.compaction_commit_event_id);
      } finally {
        admissionStore?.close();
        fixture.cleanup();
      }
    });
  }

  for (const change of ['replacement', 'in-place edit', 'durable append', 'budget append'] as const) {
    test(`compaction source continuity handles ${change} during asynchronous summarization`, async () => {
      const fixture = makeFixture();
      let admissionStore: AdmissionStore | undefined;
      try {
        process.env['BABEL_COMPACTION'] = 'off';
        mkdirSync(fixture.runs, { recursive: true });
        const opened = openSessionAdmissionStore(`source-${change.replaceAll(' ', '-')}`);
        if (!opened.ok) throw new Error(opened.detail);
        admissionStore = opened.store;
        let probe = false;
        let outcome: unknown = 'not-run';
        let sourceRetained = false;
        let capsulesAfterProbe = -1;
        let probes = 0;
        const replacement: ChatMessage[] = [{ role: 'user', content: 'replacement conversation sentinel' }];
        const runner: TestRunner = {
          async *executeWithToolsStream() {
            if (probe && probes++ === 0) {
              const internal = engine as unknown as {
                activeSubmissionGeneration: number;
                compactIfNeeded: (callbacks: undefined, force: boolean, generation: number) => Promise<unknown>;
              };
              outcome = await internal.compactIfNeeded(undefined, true, internal.activeSubmissionGeneration);
              const live = (engine as unknown as { conversation: ChatMessage[] }).conversation;
              sourceRetained = change === 'replacement' ? live === replacement
                : change === 'in-place edit' ? live.some(message => message.content.includes('in-place sentinel'))
                : engine.getParityEventLog().events.some(event => event.kind === 'user_message' && event.content === 'durable sentinel');
              capsulesAfterProbe = engine.getParityEventLog().events.filter(event => event.kind === 'compaction_capsule').length;
            }
            yield { type: 'text_delta', text: probe ? 'The continuity probe finished.' : 'retained facts '.repeat(700) };
            yield { type: 'done', finishReason: 'stop' };
          },
          async execute() { return { type: 'completion', answer: 'fixture complete' }; },
          async executeRaw() { return 'fixture complete'; },
          getLastInvocationMetadata() { return null; },
          ...fixtureNativeWireHooks,
        };
        const engine = makeEngine(fixture.project, `source-${change.replaceAll(' ', '-')}`, runner, {
          admissionStore, operation: 'READ_ONLY', maxConversationMessages: 80,
          maxEstimatedTokens: 128_000, maxTurns: 16,
        });
        for (let index = 0; index < 4; index++) {
          const warmup = await collectStream(engine.submitMessageStream(`explain retained facts ${index}`, 'explain'));
          assert.equal(warmup.at(-1)?.type, 'done');
        }
        Object.assign(engine, { compactionManager: new CompactionManager([{
          name: 'llm-summarize', canApply: () => true,
          compact: async messages => {
            await new Promise<void>(resolve => setImmediate(resolve));
            const parity = engine.getParityRuntime();
            if (change === 'replacement') engine.replaceConversation(replacement);
            if (change === 'in-place edit') engine.getConversation()[0]!.content += ' in-place sentinel';
            if (change === 'durable append') recordUserMessage(parity.eventLog, parity.turnId!, 'durable sentinel');
            if (change === 'budget append') recordBudgetSnapshot(parity.sessionEvents, parity.turnId, { tokens_used: 10 });
            return [{ role: 'system', name: 'compaction_summary', content: 'Earlier retained facts.' }, ...messages.slice(-2)];
          },
        }]) });
        probe = true;
        await collectStream(engine.submitMessageStream('explain the retained facts', 'explain'));
        assert.ok(probes > 0);
        if (change === 'budget append') {
          assert.notEqual(outcome, null, 'ordinary accounting must not block conversation compaction');
          assert.notEqual(outcome, 'not-run');
          assert.equal(capsulesAfterProbe, 1);
        } else {
          assert.equal(outcome, null, 'foreign conversation changes must invalidate compaction');
          assert.equal(sourceRetained, true, 'rejecting compaction must preserve the newer source');
          assert.equal(capsulesAfterProbe, 0, 'a rejected candidate must not leave a capsule');
        }
      } finally {
        admissionStore?.close();
        fixture.cleanup();
      }
    });
  }

  for (const change of ['persistence failure', 'durable append', 'durable append with persistence failure', 'replacement', 'in-place edit'] as const) test(`inline heuristic rollback preserves the actual engine conversation after ${change}`, async () => {
    const fixture = makeFixture();
    let admissionStore: AdmissionStore | undefined;
    try {
      process.env['BABEL_COMPACTION'] = 'off';
      mkdirSync(fixture.runs, { recursive: true });
      const runId = 'heuristic-persistence-rollback';
      const opened = openSessionAdmissionStore(runId);
      if (!opened.ok) throw new Error(opened.detail);
      admissionStore = opened.store;
      let probe = false;
      let probed = false;
      let pruned = false;
      let rejected = false;
      let sourceRestored = false;
      let newerWindow = '';
      const runner: TestRunner = {
        async *executeWithToolsStream() {
          if (probe && !probed) {
            probed = true;
            const internal = engine as unknown as {
              conversation: ChatMessage[];
              limits: { maxConversationMessages: number };
              activeSubmissionGeneration: number;
              compactConversation: () => void;
              compactIfNeeded: (callbacks: undefined, force: boolean, generation: number) => Promise<unknown>;
            };
            const prior = JSON.stringify(internal.conversation);
            const compact = internal.compactConversation.bind(engine);
            internal.compactConversation = () => {
              compact();
              pruned = JSON.stringify(internal.conversation) !== prior;
              if (change !== 'persistence failure') queueMicrotask(() => {
                if (change.startsWith('durable append')) {
                  const parity = engine.getParityRuntime();
                  recordUserMessage(parity.eventLog, parity.turnId!, 'late durable sentinel');
                } else if (change === 'replacement') {
                  internal.conversation = [{ role: 'user', content: 'newer replacement sentinel' }];
                  newerWindow = JSON.stringify(internal.conversation);
                } else {
                  internal.conversation.push({ role: 'user', content: 'newer in-place sentinel' });
                  newerWindow = JSON.stringify(internal.conversation);
                }
              });
            };
            internal.limits.maxConversationMessages = 4;
            const eventPath = join(chatSessionDir(runId), 'session-events.jsonl');
            const priorBytes = readFileSync(eventPath);
            const failPersistence = change.includes('persistence failure');
            if (failPersistence) {
              unlinkSync(eventPath);
              mkdirSync(eventPath);
            }
            try {
              await internal.compactIfNeeded(undefined, true, internal.activeSubmissionGeneration);
            } catch {
              rejected = true;
            } finally {
              sourceRestored = JSON.stringify(internal.conversation) === (newerWindow || prior);
              if (failPersistence) {
                rmdirSync(eventPath);
                writeFileSync(eventPath, priorBytes);
              }
            }
          }
          yield { type: 'text_delta', text: probe ? 'The rollback probe finished.' : 'retained facts '.repeat(700) };
          yield { type: 'done', finishReason: 'stop' };
        },
        async execute() { return { type: 'completion', answer: 'fixture complete' }; },
        async executeRaw() { return 'fixture complete'; },
        getLastInvocationMetadata() { return null; },
        ...fixtureNativeWireHooks,
      };
      const engine = makeEngine(fixture.project, runId, runner, {
        admissionStore, operation: 'READ_ONLY', maxConversationMessages: 80,
        maxEstimatedTokens: 128_000, maxTurns: 16,
      });
      for (let index = 0; index < 4; index++) await collectStream(engine.submitMessageStream(`explain retained facts ${index}`, 'explain'));
      probe = true;
      await collectStream(engine.submitMessageStream('explain the retained facts', 'explain'));
      assert.equal(probed, true);
      assert.equal(pruned, true, 'the real inline heuristic must change the live window before the injected failure');
      assert.equal(rejected, change.includes('persistence failure'), 'actual persistence failures must remain visible');
      assert.equal(sourceRestored, true, 'restore only the owned window, preserving any newer replacement or in-place edit');
      assert.equal(engine.getParityEventLog().events.some(event => event.kind === 'compaction_capsule'), false);
      if (change.startsWith('durable append')) {
        assert.ok(engine.getParityEventLog().events.some(event => event.kind === 'user_message' && event.content === 'late durable sentinel'));
      }
    } finally {
      admissionStore?.close();
      fixture.cleanup();
    }
  });

  for (const mode of ['native', 'text', 'legacy'] as const) test(`unrecoverable ${mode} prepared-request capacity stops without protocol fallback`, async () => {
    const fixture = makeFixture();
    commitCapturedProject(fixture.project);
    let admissionStore: AdmissionStore | undefined;
    try {
      process.env['BABEL_COMPACTION'] = 'off';
      const overLimit = prepareProviderRequest({
        body: JSON.stringify({ model: 'test-fixture-model', max_tokens: 4096,
          messages: [{ role: 'system', content: 'mandatory policy' }, { role: 'user', content: 'explain the fixture' }] }),
        mode, provider: 'deepinfra', requestedModelId: 'test-fixture-model',
        contextLimitTokens: 1, reservedCompletionTokens: 4096,
      });
      let calls = 0;
      let protocolFallbacks = 0;
      const runner: TestRunner = {
        async *executeWithToolsStream() { calls++; throw new PreparedRequestAdmissionError(overLimit); },
        async *executeRawStream() { calls++; throw new PreparedRequestAdmissionError(overLimit); },
        async execute() { protocolFallbacks++; throw new PreparedRequestAdmissionError(overLimit); },
        async executeRaw() { protocolFallbacks++; throw new PreparedRequestAdmissionError(overLimit); },
        getLastInvocationMetadata: () => null,
        ...fixtureNativeWireHooks,
      };
      mkdirSync(fixture.runs, { recursive: true });
      const opened = openSessionAdmissionStore('prepared-capacity');
      if (!opened.ok) throw new Error(opened.detail);
      admissionStore = opened.store;
      const engine = makeEngine(fixture.project, 'prepared-capacity', runner, { admissionStore });
      Object.assign(engine, { shouldUseNativeTools: () => mode === 'native', shouldUseTextTools: () => mode === 'text' });
      const events = await collectStream(engine.submitMessageStream('explain the fixture', 'explain'));
      assert.equal(calls, 1);
      assert.equal(protocolFallbacks, 0);
      assert.equal(events.some(event => event.type === 'context_compacted'), false);
      const error = events.find(event => event.type === 'failed');
      assert.equal(error?.cause_class, 'harness');
      assert.equal(error?.reason_code, 'context_preparation_failed');
      assert.match(error?.error ?? '', /Reduce optional context or output reserve/);
    } finally {
      admissionStore?.close();
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
    commitCapturedProject(fixture.project);
    let engine: ChatEngine | undefined;
    let restored: ChatEngine | undefined;
    let admissionStore: AdmissionStore | undefined;
    const previousCompactionBase = process.env['BABEL_COMPACTION_API_BASE'];
    const previousCompactionModel = process.env['BABEL_COMPACTION_MODEL'];
    try {
      process.env['BABEL_COMPACTION'] = 'on';
      // Force the compaction manager's provider/model coherence guard to use
      // its deterministic heuristic strategy; no live inference is allowed.
      process.env['BABEL_COMPACTION_API_BASE'] = 'https://api.anthropic.com';
      process.env['BABEL_COMPACTION_MODEL'] = 'test-fixture-model';
      const runId = 'repeated-compaction';
      mkdirSync(fixture.runs, { recursive: true });
      const opened = openSessionAdmissionStore(runId);
      if (!opened.ok) throw new Error(opened.detail);
      admissionStore = opened.store;
      const runner = makeRunner((_call) => [
        { type: 'text_delta', text: 'durable fact: lifecycle nonce retained\n' + 'synthetic conversation evidence. '.repeat(600) },
        { type: 'done', finishReason: 'stop' },
      ]);
      engine = makeEngine(fixture.project, runId, runner, {
        admissionStore,
        maxConversationMessages: 6,
        maxEstimatedTokens: 50,
        maxTurns: 16,
        operation: 'READ_ONLY',
      });
      let compactions = 0;
      for (let i = 0; i < 10; i += 1) {
        // Explicit synthetic history exceeds the runtime's 4,000-token floor.
        // Compaction must not rely on a bloated system prompt or artificial
        // mutation retries to accumulate enough context.
        const events = await collectStream(engine.submitMessageStream(`explain the lifecycle fixture turn ${i}`));
        assert.equal(events.at(-1)?.type, 'done', `compaction submission ${i} must finish`);
        compactions += events.filter((event) => event.type === 'context_compacted').length;
      }
      assert.ok(compactions >= 2, `expected repeated real-engine compaction, observed ${compactions}`);
      await persistTranscriptToDisk(chatSessionDir(runId), engine.getConversation() as ChatMessage[]);
      engine.closeAdmissionStore();
      const reopened = openSessionAdmissionStore(runId);
      if (!reopened.ok) throw new Error(reopened.detail);
      admissionStore = reopened.store;
      try {
        restored = await ChatEngine.restore(runId, {
          admissionStore,
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
      restored?.closeAdmissionStore();
      engine?.closeAdmissionStore();
      admissionStore?.close();
      if (previousCompactionBase === undefined) delete process.env['BABEL_COMPACTION_API_BASE'];
      else process.env['BABEL_COMPACTION_API_BASE'] = previousCompactionBase;
      if (previousCompactionModel === undefined) delete process.env['BABEL_COMPACTION_MODEL'];
      else process.env['BABEL_COMPACTION_MODEL'] = previousCompactionModel;
      fixture.cleanup();
    }
  });
});
