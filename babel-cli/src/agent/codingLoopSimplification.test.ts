/** Deterministic ChatEngine behavior slice for coding-loop simplification. */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import type { ToolStreamEvent } from '../runners/base.js';
import {
  executeActionWithPolicy,
  resetCircuitBreaker,
  resetCircuitBreakerForRun,
  type ToolExecutor,
} from './toolExecutor.js';
import type { AgentAction } from './actions.js';
import type { ToolContext } from '../localTools.js';
import { isInvocationLive, refreshDryRunState } from '../localTools.js';

const roots: string[] = [];
const TEST_ENV = ['BABEL_CHAT_MAX_COST', 'BABEL_RUNS_DIR', 'BABEL_CONFIG_DIR', 'BABEL_STATE_DIR', 'BABEL_CACHE_DIR'] as const;
let priorEnv: Record<string, string | undefined> = {};
before(() => {
  priorEnv = Object.fromEntries(TEST_ENV.map((key) => [key, process.env[key]]));
  const state = mkdtempSync(join(tmpdir(), 'babel-coding-loop-state-'));
  roots.push(state);
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited';
  process.env['BABEL_RUNS_DIR'] = join(state, 'runs');
  process.env['BABEL_CONFIG_DIR'] = join(state, 'config');
  process.env['BABEL_STATE_DIR'] = join(state, 'state');
  process.env['BABEL_CACHE_DIR'] = join(state, 'cache');
});
after(() => {
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-coding-loop-simplification-'));
  roots.push(root);
  return root;
}

function initializeGitFixture(root: string): void {
  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.email', 'fixture@example.test'],
    ['config', 'user.name', 'fixture'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

type Step = ToolStreamEvent[];
function installScript(engine: ChatEngine, steps: Step[]) {
  let calls = 0;
  const requests: Array<{ toolNames: string[]; toolChoice: string | undefined }> = [];
  const runner = {
    async *executeWithToolsStream(
      _messages?: unknown,
      tools?: Array<{ function?: { name?: string } }>,
      _systemPrompt?: string,
      _signal?: AbortSignal,
      toolChoice?: string,
    ) {
      requests.push({ toolNames: (tools ?? []).map((tool) => tool.function?.name ?? ''), toolChoice });
      const step = steps[calls++] ?? [
        { type: 'text_delta' as const, text: 'The task is complete.' },
        { type: 'done' as const, finishReason: 'stop' },
      ];
      for (const event of step) yield event;
    },
    async execute() { return { type: 'completion', answer: 'The task is complete.' }; },
    async executeRaw() { return 'The task is complete.'; },
    getLastInvocationMetadata() { return null; },
  };
  const target = engine as unknown as Record<string, unknown>;
  target['deliberationRunner'] = runner;
  target['synthesisRunner'] = runner;
  target['shouldUseNativeTools'] = () => true;
  return { calls: () => calls, requests };
}

async function withLiveHostAuthority<T>(runWithAuthority: () => Promise<T>): Promise<T> {
  const keys = [
    'BABEL_LIVE', 'BABEL_DRY_RUN', 'BABEL_DRY_RUN_SOURCE', 'BABEL_SHADOW_ROOT',
    'BABEL_BENCHMARK_AUTO_APPROVE', 'BABEL_BENCHMARK_MODE', 'BABEL_AUTONOMY_LEASE',
    'BABEL_EXECUTION_PROFILE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_READ_ONLY',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_LIVE'] = '1';
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'coding-loop-simplification-test',
    scope: { repository: 'temporary-fixture', objective: 'deterministic behavior test' },
    allowedCapabilities: [
      'inspect_repository', 'search_repository', 'run_arbitrary_code',
      'run_local_command', 'run_tests', 'edit_task_files',
    ],
  });
  refreshDryRunState();
  try {
    return await runWithAuthority();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    refreshDryRunState();
  }
}

async function withUnavailableHostProcessAuthority<T>(runWithAuthority: () => Promise<T>): Promise<T> {
  const keys = [
    'BABEL_LIVE', 'BABEL_DRY_RUN', 'BABEL_DRY_RUN_SOURCE', 'BABEL_SHADOW_ROOT',
    'BABEL_BENCHMARK_AUTO_APPROVE', 'BABEL_BENCHMARK_MODE', 'BABEL_AUTONOMY_LEASE',
    'BABEL_EXECUTION_PROFILE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_BENCHMARK_DOCKER_IMAGE',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env['BABEL_LIVE'] = '1';
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'coding-loop-unavailable-verifier-test',
    scope: { repository: 'temporary-fixture', objective: 'verify only through governed process authority' },
    allowedCapabilities: ['run_arbitrary_code', 'run_local_command', 'run_tests'],
  });
  refreshDryRunState();
  try {
    return await runWithAuthority();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    refreshDryRunState();
  }
}

async function run(engine: ChatEngine, prompt: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of engine.submitMessageStream(prompt)) events.push(event);
  return events;
}

function terminal(events: ChatEvent[]): Extract<ChatEvent, { type: 'done' }> {
  const done = events.filter((event): event is Extract<ChatEvent, { type: 'done' }> =>
    event.type === 'done').at(-1);
  assert.ok(done, `expected done, got ${events.map((event) => event.type).join(', ')}`);
  return done;
}

describe('ordinary coding-loop behaviors', () => {
  test('live verifier certification follows engine continuation and fresh-task lifecycle', async () => {
    const root = project();
    const configDir = mkdtempSync(join(tmpdir(), 'babel-coding-loop-config-'));
    roots.push(configDir);
    const envKeys = ['BABEL_DRY_RUN', 'BABEL_LIVE', 'BABEL_DRY_RUN_SOURCE', 'BABEL_SHADOW_ROOT', 'BABEL_CONFIG_DIR'];
    const env = new Map(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    process.env['BABEL_CONFIG_DIR'] = configDir;
    refreshDryRunState();
    resetCircuitBreaker();
    const runId = `coding-loop-cert-${Date.now()}`;
    const engine = new ChatEngine({ task: 'fix fixture', projectRoot: root, runId });
    const internals = engine as unknown as { engineRunId: string };
    assert.equal(internals.engineRunId, runId);
    engine.applyUserSubmission({ userInput: 'Fix the fixture.' });
    const file = join(root, 'certified.txt');
    writeFileSync(file, 'before');
    const observations: boolean[] = [];
    const write: AgentAction = { type: 'write_file', path: file, content: 'after' };
    const verifier: AgentAction = { type: 'test_run', command: 'npm test' };
    const executor = (action: AgentAction): ToolExecutor => ({
      mapAction() { return []; },
      async execute() {
        observations.push(isInvocationLive());
        if (action.type === 'write_file') writeFileSync(file, action.content, 'utf8');
        return { action, terminal: false, results: [{ exit_code: 0, stdout: 'ok', stderr: '' }] };
      },
    } as unknown as ToolExecutor);
    const context = {
      runId,
      agentId: 'coding-loop-test',
      projectRoot: root,
      cwd: root,
      babelRoot: root,
    } as unknown as ToolContext;
    try {
      const writeResult = await executeActionWithPolicy(write, 'workspace_write', context, {
        executor: executor(write), mode: 'chat',
      });
      assert.equal(writeResult.policyBlocked, false);
      assert.equal(observations.at(-1), true);

      engine.applyUserSubmission({ userInput: 'Continue: verify the same fix.', continueTask: true });
      await executeActionWithPolicy(verifier, 'workspace_write', context, {
        executor: executor(verifier), mode: 'chat', isolationAvailable: true, hostFallbackAllowed: true,
      });
      assert.equal(observations.at(-1), true, 'explicit continuation preserves same-task verifier authority');

      engine.applyUserSubmission({ userInput: 'Explain the repository license.' });
      await executeActionWithPolicy(verifier, 'workspace_write', context, {
        executor: executor(verifier), mode: 'chat', isolationAvailable: true, hostFallbackAllowed: true,
      });
      assert.equal(observations.at(-1), false, 'fresh engine submission retires previous task certification');
      assert.deepEqual(observations, [true, true, false]);
    } finally {
      resetCircuitBreakerForRun(runId);
      resetCircuitBreaker();
      for (const [key, value] of env) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      refreshDryRunState();
    }
  });

  test('a requested change already present is inspected and reported without writing', async () => {
    const root = project();
    writeFileSync(join(root, 'parser.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    const task = 'Fix add so it returns the sum of its arguments.';
    const engine = new ChatEngine({ task, projectRoot: root, maxTurns: 5 });
    const runner = installScript(engine, [
      [
        { type: 'tool_use', id: 'read-existing-change', name: 'read_file', input: { path: 'parser.ts' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'The requested addition is already implemented in parser.ts; no edit was needed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const events = await run(engine, task);
    assert.equal(runner.calls(), 2, JSON.stringify(events.map((event) => event.type === 'thought' ? event.text : event.type)));
    assert.equal(events.some((event) => event.type === 'failed'), false);
    assert.equal(terminal(events).outcome, 'NO_CHANGE_REQUIRED');
    assert.equal(engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'MUTATING');
    assert.equal(readFileSync(join(root, 'parser.ts'), 'utf8'),
      'export const add = (a: number, b: number) => a + b;\n');
  });

  test('an already-correct change with an explicit green verifier completes as no-change', async () => {
    await withLiveHostAuthority(async () => {
      const root = project();
      writeFileSync(join(root, 'parser.ts'), 'export const add = (a: number, b: number) => a + b;\n');
      writeFileSync(join(root, 'verify.mjs'), [
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        "assert.match(readFileSync('parser.ts', 'utf8'), /a \\+ b/);",
      ].join('\n') + '\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'coding-loop-green-nochange-fixture', private: true,
        scripts: { test: 'node verify.mjs' },
      }));
      initializeGitFixture(root);
      const task = 'Fix add so it returns the sum of its arguments; run `npm test` before finishing.';
      const engine = new ChatEngine({ task, projectRoot: root, maxTurns: 5 });
      const runner = installScript(engine, [
        [{ type: 'tool_use', id: 'inspect-already-correct', name: 'read_file', input: { path: 'parser.ts' } },
          { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'tool_use', id: 'verify-already-correct', name: 'run_command', input: { command: 'npm test' } },
          { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'The requested implementation was already correct; npm test passed.' },
          { type: 'done', finishReason: 'stop' }],
      ]);

      const events = await run(engine, task);
      const done = terminal(events);
      const calls = (engine as unknown as { toolCallLog: Array<{
        tool: string; target: string; exit_code?: number;
      }> }).toolCallLog;
      const verifier = calls.find((entry) => entry.tool === 'run_command' && entry.target === 'npm test');
      const receipt = (engine as unknown as { lastVerifierReceipt: {
        command: string; exit_code: number; stale?: boolean;
        boundRevision?: { scope?: { kind: string }; gitCommitHash?: string | null };
      } | null }).lastVerifierReceipt;

      assert.equal(verifier?.exit_code, 0, 'the requested verifier really executed and passed');
      assert.equal(done.outcome, 'NO_CHANGE_REQUIRED', 'successful no-change is reported without patch certification');
      assert.equal(receipt?.command, 'npm test');
      assert.equal(receipt?.exit_code, 0);
      assert.equal(receipt?.stale, false);
      assert.deepEqual(receipt?.boundRevision?.scope, { kind: 'repository' });
      assert.ok(receipt?.boundRevision?.gitCommitHash, 'the no-change receipt has a Git-backed revision');
      assert.equal(readFileSync(join(root, 'parser.ts'), 'utf8'),
        'export const add = (a: number, b: number) => a + b;\n');
      assert.equal(runner.calls(), 3);
    });
  });

  test('many distinct productive reads can reach a natural answer without a write-count stop', async () => {
    const root = project();
    const readSteps: Step[] = [];
    const numberOfFiles = 18;
    for (let index = 0; index < numberOfFiles; index += 1) {
      const file = `module-${index}.ts`;
      writeFileSync(join(root, file), `export const evidence_${index} = ${index};\n`);
      readSteps.push([
        { type: 'tool_use', id: `distinct-read-${index}`, name: 'read_file', input: { path: file } },
        { type: 'done', finishReason: 'tool_calls' },
      ]);
    }
    readSteps.push([
      { type: 'text_delta', text: 'The modules define 18 distinct evidence constants, numbered 0 through 17.' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const task = 'Investigate all module files and summarize the distinct exported constants. Do not edit.';
    const engine = new ChatEngine({ task, projectRoot: root, maxTurns: numberOfFiles + 3 });
    const runner = installScript(engine, readSteps);

    const events = await run(engine, task);
    assert.equal(runner.calls(), numberOfFiles + 1);
    assert.equal(engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'READ_ONLY');
    assert.equal(terminal(events).outcome, 'NO_CHANGE_REQUIRED');
    assert.equal(events.some((event) => event.type === 'failed'), false);
    assert.equal(events.some((event) => event.type === 'progress_recovery' &&
      (event.intervention === 'restricted_tools' || event.intervention === 'terminal_blocked')), false);
  });

  test('tiny two-file repair uses local tools without mandatory delegation or external calls', async () => {
    await withLiveHostAuthority(async () => {
      const root = project();
      writeFileSync(join(root, 'left.ts'), 'export const left = 0;\n');
      writeFileSync(join(root, 'right.ts'), 'export const right = 0;\n');
      writeFileSync(join(root, 'verify.mjs'), [
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        "assert.equal(readFileSync('left.ts', 'utf8'), 'export const left = 1;\\n');",
        "assert.equal(readFileSync('right.ts', 'utf8'), 'export const right = 1;\\n');",
      ].join('\n') + '\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'coding-loop-two-file-fixture', private: true,
        scripts: { test: 'node verify.mjs' },
      }));
      const task = 'Fix left.ts and right.ts so both exported constants equal 1.';
      const engine = new ChatEngine({ task, projectRoot: root, maxTurns: 6 });
      const runner = installScript(engine, [
        [{ type: 'tool_use', id: 'left-edit', name: 'str_replace', input: {
          file_path: 'left.ts', old_str: 'export const left = 0;', new_str: 'export const left = 1;',
        } }, { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'tool_use', id: 'right-edit', name: 'str_replace', input: {
          file_path: 'right.ts', old_str: 'export const right = 0;', new_str: 'export const right = 1;',
        } }, { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'tool_use', id: 'verify', name: 'run_command', input: { command: 'npm test' } },
          { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'Updated both requested constants in their existing files.' },
          { type: 'done', finishReason: 'stop' }],
      ]);

      const events = await run(engine, task);
      assert.equal(readFileSync(join(root, 'left.ts'), 'utf8'), 'export const left = 1;\n');
      assert.equal(readFileSync(join(root, 'right.ts'), 'utf8'), 'export const right = 1;\n');
      assert.ok(runner.calls() >= 4 && runner.calls() <= 6, 'the local task stays inside its explicit turn ceiling');
      assert.equal(terminal(events).outcome, 'VERIFIED_COMPLETE');
      for (const optionalTool of ['sub_agent', 'web_search', 'web_fetch']) {
        assert.ok(runner.requests[0]?.toolNames.includes(optionalTool), `${optionalTool} is available for this task`);
      }
      assert.equal(runner.requests[0]?.toolChoice, 'auto', 'provider may answer or call tools; no tool is mandatory');
      assert.ok(events.every((event) => event.type !== 'tool_start' ||
        !['todo_write', 'sub_agent', 'web_search', 'web_fetch', 'mcp_tool_search', 'mcp_request'].includes(event.tool)),
      'the scripted local repair needs no plan, delegation, or external tool');
    });
  });

  test('a current-information repair can use a scripted web result and verify the local change', async () => {
    await withLiveHostAuthority(async () => {
      const root = project();
      writeFileSync(join(root, 'version.txt'), 'version=0.0.0\n');
      writeFileSync(join(root, 'verify.mjs'), [
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        "assert.equal(readFileSync('version.txt', 'utf8'), 'version=9.9.9\\n');",
      ].join('\n') + '\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'coding-loop-current-information-fixture', private: true,
        scripts: { test: 'node verify.mjs' },
      }));
      const task = 'Use current external release information to update version.txt. Run `npm test`.';
      const engine = new ChatEngine({ task, projectRoot: root, operation: 'CHANGE', maxTurns: 6 });
      const runner = installScript(engine, [
        [{ type: 'tool_use', id: 'current-search', name: 'web_search', input: {
          query: 'Fixture library current stable release', max_results: 1,
        } }, { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'tool_use', id: 'version-edit', name: 'str_replace', input: {
          file_path: 'version.txt', old_str: 'version=0.0.0', new_str: 'version=9.9.9',
        } }, { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'tool_use', id: 'verify-current-update', name: 'run_command', input: { command: 'npm test' } },
          { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'Updated version.txt from the current search result and verified it with npm test.' },
          { type: 'done', finishReason: 'stop' }],
      ]);
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        assert.match(String(input), /^https:\/\/duckduckgo\.com\/html\//);
        return new Response(
          '<a class="result__a" href="https://example.invalid/releases">Fixture library current stable release is 9.9.9</a>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      };
      try {
        const events = await run(engine, task);
        assert.ok(runner.requests[0]?.toolNames.includes('web_search'));
        assert.equal(runner.requests[0]?.toolChoice, 'auto');
        assert.equal(readFileSync(join(root, 'version.txt'), 'utf8'), 'version=9.9.9\n');
        assert.ok(events.some((event) => event.type === 'tool_start' && event.tool === 'web_search'));
        assert.equal(terminal(events).outcome, 'VERIFIED_COMPLETE');
      } finally {
        globalThis.fetch = nativeFetch;
      }
    });
  });

  test('a demonstrated baseline-red verifier remains honest on a read-only investigation', async () => {
    await withLiveHostAuthority(async () => {
      const root = project();
      writeFileSync(join(root, 'fixture.ts'), 'export const stable = true;\n');
      writeFileSync(join(root, 'verify.mjs'), "console.error('pre-existing baseline failure'); process.exitCode = 1;\n");
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'coding-loop-baseline-red-fixture', private: true,
        scripts: { test: 'node verify.mjs' },
      }));
      const beforeBytes = readFileSync(join(root, 'fixture.ts'), 'utf8');
      const baseline = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
      assert.equal(baseline.status, 1, 'the real fixture verifier is red before the Chat task begins');
      assert.match(baseline.stderr, /pre-existing baseline failure/);

      const task = 'Investigate the existing failure. Do not edit files. Run `npm test` and report its result.';
      const engine = new ChatEngine({ task, projectRoot: root, maxTurns: 4 });
      const runner = installScript(engine, [
        [{ type: 'tool_use', id: 'baseline-test', name: 'run_command', input: { command: 'npm test' } },
          { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'npm test is already failing on the unchanged baseline; no edit was made.' },
          { type: 'done', finishReason: 'stop' }],
      ]);
      const events = await run(engine, task);
      const calls = (engine as unknown as { toolCallLog: Array<{ tool: string; exit_code?: number }> }).toolCallLog;
      const runEntry = calls.find((entry) => entry.tool === 'run_command');
      assert.equal(runEntry?.exit_code, 1, 'the task records the actual red verifier result');
      assert.equal(readFileSync(join(root, 'fixture.ts'), 'utf8'), beforeBytes, 'the investigation performs no mutation');
      const after = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
      assert.equal(after.status, baseline.status, 'the real verifier remains at the same baseline result afterward');
      assert.match(after.stderr, /pre-existing baseline failure/);
      assert.equal(engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'READ_ONLY');
      assert.equal(terminal(events).outcome, 'NO_CHANGE_REQUIRED');
      assert.notEqual(terminal(events).outcome, 'VERIFIED_COMPLETE', 'baseline-red evidence cannot certify the read-only report');
      assert.ok(runner.calls() <= 4, 'baseline reporting remains within the explicit turn ceiling');
    });
  });

  test('a verifier receipt cannot certify a later parent mutation on the same file', async () => {
    await withLiveHostAuthority(async () => {
      const root = project();
      writeFileSync(join(root, 'value.txt'), 'value=0\n');
      writeFileSync(join(root, 'verify.mjs'), [
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        "assert.equal(readFileSync('value.txt', 'utf8'), 'value=1\\n');",
        "console.log('VERIFIED_REVISION_ONE');",
      ].join('\n') + '\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'coding-loop-stale-verifier-fixture', private: true,
        scripts: { test: 'node verify.mjs' },
      }));
      const task = 'Change value.txt from 0 to 1, run `npm test`, then change the value to 2.';
      const engine = new ChatEngine({ task, projectRoot: root, maxTurns: 8 });
      const runner = installScript(engine, [
        [{ type: 'tool_use', id: 'first-revision', name: 'str_replace', input: {
          file_path: 'value.txt', old_str: 'value=0', new_str: 'value=1',
        } }, { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'tool_use', id: 'first-revision-verifier', name: 'run_command', input: { command: 'npm test' } },
          { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'tool_use', id: 'later-revision', name: 'str_replace', input: {
          file_path: 'value.txt', old_str: 'value=1', new_str: 'value=2',
        } }, { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'Both requested value changes are complete; npm test passed.' },
          { type: 'done', finishReason: 'stop' }],
      ]);

      const events = await run(engine, task);
      const terminalEvent = events.filter((event): event is Extract<ChatEvent, { type: 'done' | 'failed' }> =>
        event.type === 'done' || event.type === 'failed').at(-1);
      const calls = (engine as unknown as { toolCallLog: Array<{
        tool: string; target: string; exit_code?: number; stdout?: string; detail?: string;
      }> }).toolCallLog;
      const passingVerifierIndex = calls.findIndex((entry) =>
        entry.tool === 'run_command' && entry.target === 'npm test' && entry.exit_code === 0)
      const laterMutationIndex = calls.findIndex((entry, index) =>
        index > passingVerifierIndex && entry.tool === 'str_replace' && entry.target.includes('value.txt'))

      assert.ok(passingVerifierIndex >= 0, 'the actual verifier passed on the first revision')
      assert.match(calls[passingVerifierIndex]?.stdout ?? '', /VERIFIED_REVISION_ONE/,
        'the successful result came from the real temporary npm test script')
      assert.ok(laterMutationIndex > passingVerifierIndex, 'the same parent changed the file after that verifier')
      assert.equal(readFileSync(join(root, 'value.txt'), 'utf8'), 'value=2\n')
      assert.ok(runner.calls() >= 4 && runner.calls() <= 8)
      assert.ok(terminalEvent, 'the engine emits a concrete terminal decision after the false final claim')
      assert.ok(['UNVERIFIED_PATCH', 'BLOCKED_POLICY', 'BLOCKED_EXTERNAL'].includes(terminalEvent.outcome ?? ''),
        `the terminal decision explicitly rejects stale verification evidence (got ${terminalEvent.outcome ?? 'no outcome'})`)
      if (terminalEvent.type === 'done') {
        const receipt = terminalEvent.verifierReceipt
        assert.ok(receipt, 'the completion retains the verifier receipt it rejected')
        const staleReceipt = receipt as typeof receipt & { stale?: unknown; staleReason?: unknown }
        assert.equal(staleReceipt.stale, true,
          'the prior verifier receipt is explicitly marked stale after the later mutation')
        assert.match(typeof staleReceipt.staleReason === 'string' ? staleReceipt.staleReason : '',
          /workspace mutated after verifier receipt/i)
      }
    })
  })

  test('an unavailable governed verifier preserves denial evidence and cannot certify completion', async () => {
    await withUnavailableHostProcessAuthority(async () => {
      const root = project();
      const marker = join(root, 'verifier-ran.txt');
      writeFileSync(join(root, 'verify.mjs'), [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(marker)}, 'ran');`,
      ].join('\n') + '\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'coding-loop-unavailable-verifier-fixture', private: true,
        scripts: { test: 'node verify.mjs' },
      }));
      const task = 'Fix the fixture and verify it with `npm test`.';
      const engine = new ChatEngine({ task, projectRoot: root, maxTurns: 4 });
      const runner = installScript(engine, [
        [{ type: 'tool_use', id: 'unavailable-test', name: 'test_run', input: { command: 'npm test' } },
          { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'The verifier could not run under the available process authority; completion is unverified.' },
          { type: 'done', finishReason: 'stop' }],
      ]);
      const events = await run(engine, task);
      const log = (engine as unknown as { toolCallLog: Array<{
        tool: string; detail?: string; error?: string; stderr?: string; exit_code?: number;
      }> }).toolCallLog;
      const verifier = log.find((entry) => entry.tool === 'test_run');
      assert.ok(verifier, 'the attempted verifier is retained in the task tool evidence');
      assert.equal(verifier.exit_code, 1);
      assert.match(`${verifier.detail ?? ''} ${verifier.error ?? ''} ${verifier.stderr ?? ''}`,
        /DENY_CAPABILITY_CONSTRAINT|CAPABILITY_DENIED|isolation|host fallback/i);
      assert.equal(existsSync(marker), false, 'the denied verifier command never reaches the host');
      const done = events.find((event): event is Extract<ChatEvent, { type: 'done' }> => event.type === 'done');
      assert.equal(done, undefined, 'no completion event is emitted without verifier evidence');
      const failed = events.find((event): event is Extract<ChatEvent, { type: 'failed' }> => event.type === 'failed');
      assert.ok(failed, 'a denied required verifier remains a visible incomplete task');
      assert.ok(failed.reason_code, 'the incomplete terminal carries a typed failure reason');
      assert.ok(runner.calls() <= 4);
    });
  });
});
