import { chatVerifierOwner } from './chatVerifierContext.js';
/**
 * Independent qualification of Chat dispatch wiring for background output and
 * read_file contracts (#411). Exercises ChatEngineActionExecutor.executeOneAction
 * (executeChatAwaitCommandAction path), not direct await helpers alone.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { OBSERVATION_OUTPUT_CAP_CHARS } from './backgroundShell.js';
import { ChatEngineActionExecutor } from './chatEngineActionExecutor.js';
import type {
  ChatEngineActionExecutorHost,
  ChatCallbacks,
  ChatTaskAllowanceSnapshot,
} from './chatEngineContracts.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { createWorkingState } from './codingLoop/workingState.js';
import { recordMutationBatch } from './sessionEvents.js';
import { evaluateExecuteCompletionHonesty } from './completionGatePolicy.js';
import {
  killAllBackgroundShells,
  startBackgroundShell,
  getBackgroundShellJob,
} from './backgroundShell.js';
import { MAX_RUN_OUTPUT_BYTES } from './codingLoop/runOutputArtifacts.js';
import type { ToolContext } from '../localTools.js';
import { registerRunOutput, readRunOutput } from './codingLoop/runOutputArtifacts.js';
import { establishAuthoritySession, AUTHORITY_SESSION_FILENAME } from '../authority/sessionContext.js';
import { loadLeaseFromEnv } from '../authority/lease.js';
import { createParityRuntime, parityOnUserTurn, parityRecordToolBatch, parityArbitrateCycle } from './chatEngineParityBridge.js';
import { projectDurableToolBatch } from './toolExecutionIdentity.js';
import { resolveLiveSessionAuthority } from './liveSessionBridge.js';
import { openAdmissionStore, type AdmissionStore } from '../runtime/admission.js';
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from '../config/benchmarkContainer.js';
import { unsupportedTestClaim } from './chatResponseEvidence.js';
import { normalizeReadCacheKey } from './readThrashPolicy.js';
import { ProgressController } from './progressController.js';
import { resetSessionGate } from '../services/searchDepthGate.js';

function shellArg(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeNodeFixture(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

function artifactEnrollmentCount(runDir: string): number {
  const root = join(runDir, 'tool-output-artifacts');
  if (!existsSync(root)) return 0;
  return readdirSync(root).filter((name) => name.endsWith('.json')).length;
}

/** Parsed top-level compiled observation fields (authoritative model contract). */
function parseCompiledObservation(observation: string): { topExit: string | undefined; summary: string | undefined } {
  const lines = observation.split('\n');
  return {
    topExit: lines.find((line) => line.startsWith('exit_code: '))?.slice('exit_code: '.length),
    summary: lines.find((line) => line.startsWith('summary: '))?.slice('summary: '.length),
  };
}

function allowance(
  taskOwnerId: string,
  acceptedTaskId: string,
): ChatTaskAllowanceSnapshot {
  return {
    schemaVersion: 2,
    taskOwnerId,
    acceptedTaskId,
    accountingEpoch: 'contract-test',
    grant: {
      grantId: 'grant',
      provenance: 'fixture',
      costCap: { kind: 'unlimited' },
      wallCapMs: 120_000,
      turnCap: 20,
    },
    consumed: { costUsd: 0, activeWallMs: 0, turns: 0 },
    repair: {
      criticRepairCostCapUsd: null,
      postWriteRepairWallCapMs: null,
      postWriteRepairRestrict: false,
    },
    accountedChargeIds: [],
    activeExecution: true,
    taskCostBaselineUsd: 0,
  };
}

type HostControls = {
  ownerGeneration: number;
  taskAllowance: ChatTaskAllowanceSnapshot | null;
};

function makeHost(
  authorizedRoot: string,
  projectRoot: string,
  runDir: string,
  controls: HostControls,
  trustedGitCommonDir?: string,
): { host: ChatEngineActionExecutorHost; close: () => void } {
  const engineRunId = `contract-${randomUUID()}`;
  writeFileSync(join(projectRoot, '.gitignore'), 'node_modules\n');
  const parity = createParityRuntime(engineRunId);
  const opened = openAdmissionStore({ authorizedRoot, runDir });
  if (!opened.ok) throw new Error(`admission store unavailable: ${opened.reasonCode}`);
  parity.admissionStore = opened.store;
  parity.liveAuthority = resolveLiveSessionAuthority({
    mode: 'chat',
    projectRoot,
    task: 'coding output contract fixture',
  });
  parity.authoritySession = establishAuthoritySession({
    repoRoot: projectRoot,
    ...(trustedGitCommonDir ? { trustedGitCommonDir } : {}),
    lease: loadLeaseFromEnv(),
    persistPath: join(runDir, AUTHORITY_SESSION_FILENAME),
  });
  const progressController = new ProgressController();
  const host = {
    _lastPhase: null,
    _turnIndex: 0,
    _streamNativeToolCallIds: [],
    activeSubmissionGeneration: controls.ownerGeneration,
    dedupeHitCount: 0,
    engineRunDir: runDir,
    engineRunId,
    executionProfile: 'chat',
    hardPlanMode: false,
    requireTodoBeforeMutate: false,
    isolationBrokerFlags: () => ({ hostFallbackAllowed: true }),
    readContextEpoch: 0,
    recoveryStatePersistenceUnavailable: false,
    taskClass: 'general_swe',
    todos: new Map(),
    toolCallLog: [],
    fullReadCounts: new Map(),
    readCache: new Map(),
    readCacheKey: (filePath: string) => filePath,
    options: { projectRoot, task: 'coding output contract fixture' },
    parity,
    policyEventLog: { record: () => {}, events: [] } as never,
    progressController,
    workingState: createWorkingState('coding output contract fixture'),
    writeCount: 0,
    consecutiveReadOnlyTools: 0,
    lastVerifierReceipt: null,
    executedVerifierLedger: [],
    platformUnusableVerifiers: new Set(),
    patchRecoveryPath: null,
    verifierReceiptCache: new Map(),
    get taskAllowance() {
      return controls.taskAllowance;
    },
    beginRecoveryLocalizationInspection: () => true,
    checkVerifierTamper: () => null,
    consumeFailureBudget: () => true,
    currentVerifierOwner: () => chatVerifierOwner({ projectRoot, sessionId: parity.sessionEvents.session_id,
      taskId: parity.liveAuthority!.taskContract.task_id, contractHash: parity.liveAuthority!.taskContract.contract_hash }),
    currentRecoveryBinding: () => null,
    finishRecoveryLocalizationInspection: () => {},
    getResolvedRequiredVerifiers: () => [],
    getTurnRuntimeSnapshot: () => null,
    getLiveSession: () => ({
      tools: { completed_idempotency_keys: [] },
      authorized_observation_ids: [],
      verifier: { attempts: 0 },
    }),
    hashContent: (content: string) => content,
    hashFilePath: async (filePath: string) =>
      createHash('sha256')
        .update(readFileSync(join(projectRoot, filePath)))
        .digest('hex'),
    isSubmissionCurrent: (generation: number) =>
      generation === controls.ownerGeneration,
    recoveredOperationDispatchAuthorization: () => ({ allowed: true }),
    noteToolForReadThrash: () => {},
    persistRecoveryWorkingState: () => {},
    persistToolStartedAtExecutorDispatch: () => {},
    settleStaleActionResult: (tool: string, target: string, index: number, reason: string) => ({
      index,
      observation: `stale ${tool} ${target}: ${reason}`,
    }),
    runPostEditStaticCheck: async () => null,
    invalidateRepositoryContext: () => {},
  } as unknown as ChatEngineActionExecutorHost;
  return {
    host,
    close: () => {
      (opened.store as AdmissionStore).close();
    },
  };
}

function toolContext(projectRoot: string, runDir: string): ToolContext {
  return {
    agentId: 'contract-test',
    runId: 'contract-test',
    runDir,
    babelRoot: projectRoot,
    projectRoot,
  };
}

function trackCallbacks(): ChatCallbacks & {
  completes: Array<{ detail?: string; error?: string; exitCode?: number }>;
} {
  const completes: Array<{ detail?: string; error?: string; exitCode?: number }> = [];
  return {
    completes,
    onToolStart: () => 1,
    onToolComplete: (id, detail, error, exitCode) => {
      const entry: { detail?: string; error?: string; exitCode?: number } = {};
      if (detail !== undefined) entry.detail = detail;
      if (error !== undefined) entry.error = error;
      if (exitCode !== undefined) entry.exitCode = exitCode;
      completes.push(entry);
    },
  };
}

async function dispatch(
  executor: ChatEngineActionExecutor,
  projectRoot: string,
  runDir: string,
  action: ChatToolAction,
  ownerGeneration: number,
  idempotencyKey: string = randomUUID(),
  signal?: AbortSignal,
): Promise<{ observation: string; callbacks: ReturnType<typeof trackCallbacks> }> {
  const callbacks = trackCallbacks();
  const result = await executor.executeOneAction(
    action,
    { ...toolContext(projectRoot, runDir), ...(signal ? { signal } : {}) },
    callbacks,
    { index: 0, ownerGeneration, idempotencyKey },
  );
  return { observation: result.observation, callbacks };
}

describe('Chat coding output contracts (executor dispatch)', { concurrency: false }, () => {
  const cleanup: string[] = [];
  const envBackup: Record<string, string | undefined> = {};

  before(() => {
    for (const key of [
      'BABEL_EXECUTION_PROFILE',
      'BABEL_BENCHMARK_AUTO_APPROVE',
      'BABEL_BENCHMARK_MODE',
      'BABEL_ALLOW_HOST_FALLBACK',
      'BABEL_DRY_RUN',
      'BABEL_DRY_RUN_SOURCE',
      'BABEL_PROJECT_ROOT',
      'BABEL_AUTONOMY_LEASE',
    ]) {
      envBackup[key] = process.env[key];
    }
    process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
    process.env['BABEL_BENCHMARK_MODE'] = '1';
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
    process.env['BABEL_DRY_RUN'] = '0';
    process.env['BABEL_DRY_RUN_SOURCE'] = 'session';
    process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
      version: 2,
      leaseId: 'coding-output-contract-lease',
      scope: { repository: 'contract-fixture', objective: 'coding output contract tests' },
      allowedCapabilities: [
        'run_arbitrary_code',
        'run_local_command',
        'run_tests',
        'edit_task_files',
        'inspect_repository',
        'search_repository',
      ],
    });
  });

  after(() => {
    killAllBackgroundShells({ includeDetached: true });
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  function verifierFixture(expected = '1', delayMs = 0, extraFiles = 0) {
    const storage = mkdtempSync(join(tmpdir(), 'babel-background-verifier-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('owner', 'task') };
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test verify.test.mjs' } }));
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules\n');
    writeFileSync(join(projectRoot, 'source.txt'), '0');
    for (let i = 0; i < extraFiles; i += 1) writeFileSync(join(projectRoot, `input-${i}.txt`), 'fixture input');
    writeFileSync(join(projectRoot, 'verify.test.mjs'),
      `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';\n` +
      `test('source value', async () => { await new Promise(r => setTimeout(r, ${delayMs})); assert.equal(readFileSync('source.txt', 'utf8'), ${JSON.stringify(expected)}); });`);
    // Disposable fixture only; every native failure throws immediately.
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe', windowsHide: true });
    }
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    writeFileSync(join(projectRoot, 'source.txt'), '1');
    host.writeCount = 1;
    host.workingState.lastMutation = { path: 'source.txt', at: Date.now() };
    recordMutationBatch(host.parity.sessionEvents, '0', { paths: ['source.txt'] });
    const executor = new ChatEngineActionExecutor(host);
    const run = (action: ChatToolAction, signal?: AbortSignal) => dispatch(executor, projectRoot, runDir, action, controls.ownerGeneration, randomUUID(), signal);
    const start = async (detached = false, signal?: AbortSignal) => {
      const result = await run({ type: 'run_command', command: 'npm test', background: true, detached }, signal);
      const taskId = result.observation.match(/task_id="(bg-\d+)"/)?.[1];
      assert.ok(taskId, result.observation);
      return taskId;
    };
    return { host, close, controls, projectRoot, run, start };
  }

  test('foreground verifier provenance excludes search-depth denial and records real red/green execution', async () => {
    const f = verifierFixture('2');
    const prior = process.env['BABEL_ENFORCE_SEARCH_GATE'];
    try {
      process.env['BABEL_ENFORCE_SEARCH_GATE'] = 'true'; resetSessionGate();
      const denied = await f.run({ type: 'test_run', command: 'node --test verify.test.mjs' });
      assert.match(denied.observation, /SEARCH_DEPTH_GATE/);
      assert.equal(f.host.toolCallLog.at(-1)?.verifierExecuted, false);
      assert.equal(f.host.executedVerifierLedger.length, 0);
      if (prior === undefined) delete process.env['BABEL_ENFORCE_SEARCH_GATE'];
      else process.env['BABEL_ENFORCE_SEARCH_GATE'] = prior;
      resetSessionGate();
      const red = await f.run({ type: 'test_run', command: 'node --test verify.test.mjs' });
      assert.match(red.observation, /exit_code: 1/);
      assert.equal(f.host.toolCallLog.at(-1)?.verifierExecuted, true);
      const greenFixture = verifierFixture('1');
      try {
        const green = await greenFixture.run({ type: 'run_command', command: 'node --test verify.test.mjs' });
        assert.match(green.observation, /exit_code: 0/);
        assert.equal(greenFixture.host.toolCallLog.at(-1)?.verifierExecuted, true);
        assert.equal(greenFixture.host.lastVerifierReceipt?.environment_policy, 'host-process');
      } finally { greenFixture.close(); }
    } finally {
      if (prior === undefined) delete process.env['BABEL_ENFORCE_SEARCH_GATE'];
      else process.env['BABEL_ENFORCE_SEARCH_GATE'] = prior;
      resetSessionGate(); f.close();
    }
  });

  test('executed version or option probes are not recorded as verifier failures', async () => {
    const f = verifierFixture();
    try {
      const probe = await f.run({ type: 'test_run', command: 'node --not-a-real-version-option' });
      assert.match(probe.observation, /exit_code: [1-9]\d*/);
      assert.equal(f.host.toolCallLog.at(-1)?.verifierExecuted, false);
      assert.equal(f.host.toolCallLog.at(-1)?.verifierSemanticSignature, undefined);
      assert.equal(f.host.workingState.settledFailedVerifier, undefined);
      assert.notEqual(f.host.workingState.recoveryGate?.failureSignature, 'unbound-red-verifier');
      assert.notEqual(f.host.lastVerifierFailed, true);
    } finally { f.close(); }
  });

  test('linked worktree supports governed Chat edit and native verification', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-chat-worktree-'));
    cleanup.push(storage);
    const main = join(storage, 'main');
    const projectRoot = join(storage, 'linked');
    const runDir = join(storage, 'run');
    mkdirSync(main);
    mkdirSync(runDir);
    for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], ['worktree', 'add', '--detach', projectRoot]]) {
      execFileSync('git', args, { cwd: main, stdio: 'pipe', windowsHide: true });
    }
    const { host, close } = makeHost(storage, projectRoot, runDir, { ownerGeneration: 1, taskAllowance: allowance('owner', 'task') }, join(main, '.git'));
    try {
      const executor = new ChatEngineActionExecutor(host);
      const edited = await dispatch(executor, projectRoot, runDir, { type: 'write_file', path: 'proof.cjs', content: "require('node:test').test('proof', () => { require('node:assert/strict').equal(2 + 2, 4); console.log('worktree-test-executed'); });\n" }, 1);
      assert.equal(readFileSync(join(projectRoot, 'proof.cjs'), 'utf8').includes('worktree-test-executed'), true, edited.observation);
      const verified = await dispatch(executor, projectRoot, runDir, { type: 'test_run', command: 'node --test proof.cjs' }, 1);
      assert.match(verified.observation, /worktree-test-executed/);
      assert.doesNotMatch(verified.observation, /DENY_|ENOTDIR/);
      assert.equal(host.parity.authoritySession?.invalidated, false);
      assert.equal(host.lastVerifierReceipt?.tests_passed, 1);
      assert.equal(host.lastVerifierReceipt?.tests_failed, 0);
      const answer = 'I ran node --test proof.cjs: 1 test passed.';
      assert.equal(unsupportedTestClaim(answer, host.lastVerifierReceipt), false);
      assert.equal(unsupportedTestClaim(answer.replace('1 test', '2 tests'), host.lastVerifierReceipt), true);
    } finally { close(); }
  });

  test('real cached file observations never turn elapsed time into discovery progress', async () => {
    const f = verifierFixture();
    const progress = createParityRuntime(`cached-progress-${randomUUID()}`);
    parityOnUserTurn(progress, { task: 'Inspect source.txt', model: 'mock', provider: 'mock', projectRoot: f.projectRoot });
    const action = { type: 'read_file' as const, path: 'source.txt' };
    try {
      for (let turn = 1; turn <= 9; turn += 1) {
        if (turn > 1) {
          for (const cached of f.host.readCache.values()) cached.timestamp = Date.now() - turn * 5000;
        }
        const startIndex = f.host.toolCallLog.length;
        const result = await f.run(action);
        if (turn > 1) assert.match(result.observation, /Skipping re-injection/);
        const batch = projectDurableToolBatch({
          turn, actions: [action], turnSlice: f.host.toolCallLog.slice(startIndex),
          observationsByActionIndex: [result.observation],
        });
        const receipt = parityRecordToolBatch(progress, { at_turn: turn, toolCalls: batch.toolCalls, results: batch.results });
        assert.equal(receipt.hasDelta, turn === 1, result.observation);
        parityArbitrateCycle({ rt: progress, fuseLabels: [] });
      }
      assert.equal(parityArbitrateCycle({ rt: progress, fuseLabels: [] }).policySource, 'progress_terminal');
    } finally { f.close(); }
  });

  test('background verifier completion supplies the canonical ledger exactly once', async () => {
    const f = verifierFixture();
    try {
      const taskId = await f.start();
      assert.equal(f.host.executedVerifierLedger.length, 0, 'starting a job is not verification');
      const completed = await f.run({ type: 'await_command', task_id: taskId });
      assert.equal(f.host.executedVerifierLedger.length, 1, completed.observation);
      assert.equal(f.host.lastVerifierReceipt?.command, 'npm test');
      assert.equal(f.host.lastVerifierReceipt?.exit_code, 0);
      assert.equal(f.host.lastVerifierReceipt?.working_directory, '.');
      assert.equal(f.host.lastVerifierReceipt?.environment_policy, 'host-process');
      assert.equal(f.host.lastVerifierFailed, false);
      assert.equal(evaluateExecuteCompletionHonesty({
        hasWrite: f.host.writeCount > 0, policy: 'strict',
        lastVerifierReceipt: f.host.lastVerifierReceipt,
        executedVerifierLedger: f.host.executedVerifierLedger, toolCallLog: f.host.toolCallLog,
      }).allow, true);
      const attempts = f.host.parity.sessionEvents.events.filter(e => e.kind === 'verifier_attempt').length;
      await f.run({ type: 'await_command', task_id: taskId });
      assert.equal(f.host.parity.sessionEvents.events.filter(e => e.kind === 'verifier_attempt').length, attempts);
    } finally { f.close(); }
  });

  test('background verifier obeys the same lease denial as foreground execution', async () => {
    const prior = process.env['BABEL_AUTONOMY_LEASE'];
    const lease = JSON.parse(prior!);
    lease.leaseId = randomUUID();
    lease.allowedCapabilities = ['inspect_repository'];
    process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify(lease);
    const f = verifierFixture();
    try {
      for (const background of [false, true]) {
        const denied = await f.run({ type: 'run_command', command: 'npm test', background });
        assert.match(denied.observation, /DENY_|denied/i);
        assert.doesNotMatch(denied.observation, /Started background job/);
      }
      assert.equal(f.host.executedVerifierLedger.length, 0);
    } finally { process.env['BABEL_AUTONOMY_LEASE'] = prior; f.close(); }
  });

  test('background verifier requires the governed isolation boundary', async () => {
    const f = verifierFixture();
    f.host.isolationBrokerFlags = () => ({ dirtyTree: false, isolationRequired: true, isolationAvailable: false, hostFallbackAllowed: false });
    try {
      const denied = await f.run({ type: 'run_command', command: 'npm test', background: true });
      assert.match(denied.observation, /DENY_|isolation/i);
      assert.doesNotMatch(denied.observation, /Started background job/);
      assert.equal(f.host.executedVerifierLedger.length, 0);
    } finally { f.close(); }
  });

  test('background dispatch preserves explicit dry-run and rejects retired owners before spawn', async () => {
    const f = verifierFixture();
    const prior = process.env['BABEL_DRY_RUN'];
    try {
      process.env['BABEL_DRY_RUN'] = '1';
      const simulated = await f.run({ type: 'run_command', command: 'npm test', background: true });
      assert.doesNotMatch(simulated.observation, /Started background job/);
      assert.match(simulated.observation, /DRY.?RUN|simulat/i);
      process.env['BABEL_DRY_RUN'] = '0';
      f.host.persistToolStartedAtExecutorDispatch = () => { f.controls.ownerGeneration += 1; };
      const stale = await f.run({ type: 'run_command', command: 'npm test', background: true });
      assert.doesNotMatch(stale.observation, /Started background job/);
      assert.match(stale.observation, /stale|cancelled/i);
      assert.equal(f.host.executedVerifierLedger.length, 0);
    } finally { process.env['BABEL_DRY_RUN'] = prior; f.close(); }
  });

  test('background cancellation at dispatch cannot manufacture a failed verifier', async () => {
    const f = verifierFixture();
    const controller = new AbortController();
    f.host.persistToolStartedAtExecutorDispatch = () => controller.abort();
    try {
      const cancelled = await f.run({ type: 'run_command', command: 'npm test', background: true }, controller.signal);
      assert.doesNotMatch(cancelled.observation, /Started background job/);
      assert.match(cancelled.observation, /cancelled/i);
      assert.equal(f.host.executedVerifierLedger.length, 0, cancelled.observation);
      assert.equal(f.host.lastVerifierReceipt, null);
      assert.notEqual(f.host.lastVerifierFailed, true);
      assert.equal(f.host.workingState.failureSurface, undefined);
    } finally { f.close(); }
  });

  test('background-only Docker denial cannot manufacture a failed verifier', async () => {
    const f = verifierFixture();
    const priorProfile = process.env['BABEL_EXECUTION_PROFILE'];
    const priorImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    const priorDisable = process.env['BABEL_DOCKER_DISABLE'];
    try {
      process.env['BABEL_EXECUTION_PROFILE'] = 'benchmark_container';
      process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'fixture-unused-image';
      delete process.env['BABEL_DOCKER_DISABLE'];
      setDockerAvailableForTest(true);
      const denied = await f.run({ type: 'run_command', command: 'npm test', background: true });
      assert.match(denied.observation, /Background shell is not available under Docker sandbox profiles/);
      assert.doesNotMatch(denied.observation, /Started background job/);
      assert.equal(f.host.executedVerifierLedger.length, 0, denied.observation);
      assert.equal(f.host.lastVerifierReceipt, null);
      assert.notEqual(f.host.lastVerifierFailed, true);
      assert.equal(f.host.workingState.failureSurface, undefined);
    } finally {
      for (const [key, value] of Object.entries({ BABEL_EXECUTION_PROFILE: priorProfile, BABEL_BENCHMARK_DOCKER_IMAGE: priorImage, BABEL_DOCKER_DISABLE: priorDisable })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetDockerAvailabilityCache();
      f.close();
    }
  });

  test('background child receives the governed unprivileged Git environment', async () => {
    const f = verifierFixture();
    try {
      writeFileSync(join(f.projectRoot, 'verify.test.mjs'),
        "import assert from 'node:assert/strict'; assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(process.env.GH_PROMPT_DISABLED, '1');");
      const taskId = await f.start();
      const completed = await f.run({ type: 'await_command', task_id: taskId });
      assert.equal(f.host.lastVerifierReceipt?.exit_code, 0, completed.observation);
    } finally { f.close(); }
  });

  test('background completion waits for governance reconciliation before certifying', async () => {
    const prior = process.env['BABEL_AUTONOMY_LEASE'];
    const lease = JSON.parse(prior!);
    lease.leaseId = randomUUID();
    process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify(lease);
    const f = verifierFixture();
    try {
      writeFileSync(join(f.projectRoot, 'verify.test.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('AGENTS.md', 'changed by child');");
      const taskId = await f.start();
      const result = await f.run({ type: 'await_command', task_id: taskId });
      assert.match(result.observation, /DENY_POLICY_SELF_MUTATION/);
      assert.equal(parseCompiledObservation(result.observation).topExit, '1');
      const repeated = await f.run({ type: 'await_command', task_id: taskId });
      assert.equal(parseCompiledObservation(repeated.observation).topExit, '1');
      assert.equal(existsSync(join(f.projectRoot, 'AGENTS.md')), false);
      assert.equal(f.host.executedVerifierLedger.length, 0);
      assert.equal(f.host.lastVerifierReceipt, null);
    } finally { process.env['BABEL_AUTONOMY_LEASE'] = prior; f.close(); }
  });

  test('failed background verifier enters repair and phase-gated search executes', async () => {
    const f = verifierFixture('2');
    const previous = process.env['BABEL_PHASE_GATED_TOOLS'];
    try {
      f.host._lastPhase = 'verify';
      process.env['BABEL_PHASE_GATED_TOOLS'] = '1';
      const before = await f.run({ type: 'grep', pattern: '1', path: 'source.txt' });
      assert.match(before.observation, /phase-gated tools/);
      const taskId = await f.start();
      const failed = await f.run({ type: 'await_command', task_id: taskId });
      assert.equal(f.host.lastVerifierReceipt?.exit_code, 1, failed.observation);
      assert.equal(f.host.lastVerifierFailed, true);
      assert.ok(f.host.workingState.failureSurface);
      const afterFailure = await f.run({ type: 'grep', pattern: '1', path: 'source.txt' });
      assert.doesNotMatch(afterFailure.observation, /phase-gated tools/);
      assert.match(afterFailure.observation, /exit_code: 0/);
      assert.match(afterFailure.observation, /1/);
    } finally {
      if (previous === undefined) delete process.env['BABEL_PHASE_GATED_TOOLS'];
      else process.env['BABEL_PHASE_GATED_TOOLS'] = previous;
      f.close();
    }
  });

  test('background verification uses fresh proof beyond the small reusable-closure limit', async () => {
    const f = verifierFixture('1', 0, 45);
    try {
      const taskId = await f.start();
      const completed = await f.run({ type: 'await_command', task_id: taskId });
      assert.equal(f.host.executedVerifierLedger.length, 1, completed.observation);
      assert.equal(f.host.lastVerifierReceipt?.exit_code, 0);
      assert.equal(f.host.lastVerifierReceipt?.inputClosure?.mode, 'bound');
    } finally { f.close(); }
  });

  for (const changed of ['candidate', 'owner', 'generation', 'session', 'environment', 'cancelled'] as const) {
    test(`background result cannot certify after ${changed} changes`, async () => {
      const f = verifierFixture('1', 100);
      const priorNodeEnv = process.env['NODE_ENV'];
      try {
        const taskId = await f.start();
        if (changed === 'candidate') writeFileSync(join(f.projectRoot, 'added.txt'), 'new candidate');
        if (changed === 'owner') f.controls.taskAllowance = allowance('new-owner', 'new-task');
        if (changed === 'generation') f.controls.ownerGeneration = 2;
        if (changed === 'session') f.host.engineRunId = 'other-session';
        if (changed === 'environment') process.env['NODE_ENV'] = 'changed-fixture-environment';
        if (changed === 'cancelled') killAllBackgroundShells({ ownerId: f.host.engineRunId, includeDetached: true });
        const settled = await f.run({ type: 'await_command', task_id: taskId });
        if (changed === 'owner' || changed === 'generation' || changed === 'session') {
          assert.match(settled.observation, /stale await_command/);
          assert.doesNotMatch(settled.observation, /source value/);
        }
        assert.equal(f.host.executedVerifierLedger.length, 0);
        assert.equal(f.host.lastVerifierReceipt, null);
        assert.equal(f.host.verifierReceiptCache.size, 0);
      } finally {
        if (priorNodeEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = priorNodeEnv;
        f.close();
      }
    });
  }

  test('timed-out await stays receipt-free until the process really finishes', async () => {
    const f = verifierFixture('1', 1500);
    try {
      const taskId = await f.start();
      const waiting = await f.run({ type: 'await_command', task_id: taskId, timeout_seconds: 1 });
      assert.match(waiting.observation, /exit_code: null/);
      assert.equal(f.host.executedVerifierLedger.length, 0);
      await f.run({ type: 'await_command', task_id: taskId });
      assert.equal(f.host.executedVerifierLedger.length, 1);
    } finally { f.close(); }
  });

  test('cancellation while awaiting a detached verifier permanently retires certification', async () => {
    const f = verifierFixture('1', 200);
    const controller = new AbortController();
    try {
      const taskId = await f.start(true, controller.signal);
      const waiting = f.run({ type: 'await_command', task_id: taskId }, controller.signal);
      controller.abort();
      const result = await waiting;
      assert.match(result.observation, /stale await_command/);
      assert.equal(getBackgroundShellJob(taskId)?.exitCode, 0, 'detached child may finish normally');
      assert.equal(f.host.executedVerifierLedger.length, 0);
      assert.equal(f.host.lastVerifierReceipt, null);
      assert.equal(f.host.verifierReceiptCache.size, 0);
      const later = await f.run({ type: 'await_command', task_id: taskId });
      assert.match(later.observation, /stale await_command/);
      assert.equal(f.host.executedVerifierLedger.length, 0);
    } finally { f.close(); }
  });

  test('unknown background job is a tool failure, never a running verifier', async () => {
    const f = verifierFixture();
    try {
      const missing = await f.run({ type: 'await_command', task_id: 'missing-background-job' });
      assert.match(missing.observation, /Unknown background task_id/);
      assert.doesNotMatch(missing.observation, /still running/);
      assert.equal(parseCompiledObservation(missing.observation).topExit, '1');
      assert.equal(f.host.executedVerifierLedger.length, 0);
    } finally { f.close(); }
  });

  test('await_command via Chat executor drops stale logs, callbacks, and spill enrollment', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-await-stale-chat-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    const script = writeNodeFixture(
      storage,
      'stale-spill-await.mjs',
      `console.log(Array.from({ length: 3000 }, (_, i) => 'spill-row ' + i).join('\\n'));\n` +
        `await new Promise(resolve => setTimeout(resolve, 400));`,
    );
    const job = startBackgroundShell({
      command: `node ${shellArg(script)}`,
      cwd: projectRoot,
      timeoutMs: 10_000,
      ownerId: 'stale-chat-fixture',
    });
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('owner-1', 'task-1') };
    const enrollmentBefore = artifactEnrollmentCount(runDir);
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    try {
    const originalPersist = host.persistToolStartedAtExecutorDispatch.bind(host);
    host.persistToolStartedAtExecutorDispatch = (...args) => {
      originalPersist(...args);
      controls.ownerGeneration = 2;
    };
    const executor = new ChatEngineActionExecutor(host);
    const { observation, callbacks } = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'await_command', task_id: job.id, timeout_seconds: 30 },
      1,
      'await-stale',
    );
    assert.match(observation, /stale await_command/);
    assert.equal(host.toolCallLog.length, 0, 'toolCallLog: superseded await must not append rows');
    assert.equal(callbacks.completes.length, 0, 'onToolComplete: superseded await must not fire');
    assert.equal(
      artifactEnrollmentCount(runDir),
      enrollmentBefore,
      'tool-output-artifacts: stale await must not enroll spill output',
    );
    await job.done;
    } finally { close(); }
  });

  test('spill-sized await_command enrolls artifact when submission stays current', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-await-spill-control-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    const script = writeNodeFixture(
      storage,
      'spill-complete.mjs',
      `console.log(Array.from({ length: 3000 }, (_, i) => 'spill-row ' + i).join('\\n'));`,
    );
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('owner-1', 'task-1') };
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    try {
    const executor = new ChatEngineActionExecutor(host);
    const bg = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'run_command', command: `node ${shellArg(script)}`, background: true },
      1,
      'spill-bg',
    );
    const taskId = bg.observation.match(/task_id="(bg-\d+)"/)?.[1];
    assert.ok(taskId);
    const before = artifactEnrollmentCount(runDir);
    const settled = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'await_command', task_id: taskId, timeout_seconds: 30 },
      1,
      'spill-await',
    );
    assert.ok(settled.observation.includes('artifact_id:'));
    assert.ok(artifactEnrollmentCount(runDir) > before);
    } finally { close(); }
  });

  test('repeated await_command: timed_out preserves null exit status, completion settles truthfully', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-await-repeat-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    const script = writeNodeFixture(
      storage,
      'slow-complete.mjs',
      `await new Promise(resolve => setTimeout(resolve, 2500)); console.log('finished');`,
    );
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('owner-1', 'task-1') };
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    try {
    host.engineRunId = 'repeat-await-owner';
    const executor = new ChatEngineActionExecutor(host);
    const bg = await dispatch(
      executor,
      projectRoot,
      runDir,
      {
        type: 'run_command',
        command: `node ${shellArg(script)}`,
        background: true,
      },
      1,
      'bg-start',
    );
    const taskId = bg.observation.match(/task_id="(bg-\d+)"/)?.[1];
    assert.ok(taskId, bg.observation);
    const first = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'await_command', task_id: taskId, timeout_seconds: 1 },
      1,
      'await-running',
    );
    const firstParsed = parseCompiledObservation(first.observation);
    assert.equal(firstParsed.topExit, 'null', 'authoritative top-level exit must be null while running');
    assert.match(firstParsed.summary ?? '', /timed_out \(still running/);
    assert.doesNotMatch(first.observation, /^### await_command[^\n]*\nexit_code: -1/m);
    assert.match(first.observation, /timed_out: true/);
    assert.match(first.observation, /\nexit_code: null\n/);
    assert.equal(first.callbacks.completes.length, 1);
    assert.equal(
      first.callbacks.completes[0]?.exitCode,
      1,
      'onToolComplete uses exit code 1 when timed_out (UI/log operational semantics)',
    );
    const logAfterFirst = host.toolCallLog.find((entry) => entry.tool === 'await_command');
    assert.equal(logAfterFirst?.exit_code, 1, 'toolCallLog exit_code uses 1 when process exit is unknown');
    assert.match(logAfterFirst?.detail ?? '', /timed_out \(still running\)/);
    const second = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'await_command', task_id: taskId, timeout_seconds: 30 },
      1,
      'await-complete',
    );
    const secondParsed = parseCompiledObservation(second.observation);
    assert.equal(secondParsed.topExit, '0');
    assert.match(secondParsed.summary ?? '', /^ok /);
    assert.match(second.observation, /timed_out: false/);
    assert.match(second.observation, /finished/);
    assert.equal(second.callbacks.completes[0]?.exitCode, 0);
    } finally { close(); }
  });

  test('failed command with >32k stderr enrolls artifact; read_artifact recovers without rerunning', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-huge-error-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    const sentinel = 'HUGE_ERROR_SENTINEL_4c2a';
    const script = writeNodeFixture(
      storage,
      'huge-stderr.mjs',
      `const pad = ${JSON.stringify('x'.repeat(OBSERVATION_OUTPUT_CAP_CHARS))};\n` +
        `console.error(pad + ${JSON.stringify(sentinel)} + ${JSON.stringify('y'.repeat(4000))});\nprocess.exit(9);`,
    );
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('owner-1', 'task-1') };
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    try {
    const executor = new ChatEngineActionExecutor(host);
    const ran = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'run_command', command: `node ${shellArg(script)}` },
      1,
      'huge-error-cmd',
    );
    assert.equal(
      ran.observation.includes(sentinel),
      false,
      'bounded preview must not expose the middle diagnostic',
    );
    const artifactId = ran.observation.match(/artifact_id:\s*([a-f0-9-]{36})/)?.[1];
    assert.ok(artifactId, ran.observation);
    const read = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'read_artifact', artifact_id: artifactId, query: sentinel },
      1,
      'huge-error-read',
    );
    assert.match(read.observation, new RegExp(sentinel));
    assert.match(read.observation, /sha256:/);
    } finally { close(); }
  });

  test('cross-owner read_artifact is denied after accepted-task replacement', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-artifact-owner-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('owner-a', 'task-a') };
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    try {
    const executor = new ChatEngineActionExecutor(host);
    const rowScript = writeNodeFixture(
      storage,
      'secret-row.mjs',
      `console.log(Array.from({ length: 3000 }, (_, i) => i === 1500 ? 'secret-row' : 'row ' + i).join('\\n'));`,
    );
    const enroll = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'run_command', command: `node ${shellArg(rowScript)}` },
      1,
      'owner-a-cmd',
    );
    const artifactId = enroll.observation.match(/artifact_id:\s*([a-f0-9-]{36})/)?.[1];
    assert.ok(artifactId);
    controls.taskAllowance = allowance('owner-b', 'task-b');
    const denied = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'read_artifact', artifact_id: artifactId!, query: 'secret-row' },
      1,
      'owner-b-read',
    );
    assert.match(denied.observation, /ARTIFACT_DENIED|denied/i);
    } finally { close(); }
  });

  test('workspace file read observations respect platform path identity', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-case-read-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'workspace', 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(runDir);
    writeFileSync(join(projectRoot, 'Foo.ts'), 'export const value = 1;');
    writeFileSync(join(projectRoot, 'foo.ts'), 'export const value = 1;');
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('owner', 'task') };
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    host.readCacheKey = (path: string) => normalizeReadCacheKey(path, projectRoot);
    try {
      const executor = new ChatEngineActionExecutor(host);
      const caseAliases = process.platform === 'win32';
      assert.equal(host.readCacheKey('Foo.ts') === host.readCacheKey('foo.ts'), caseAliases);
      for (const path of ['Foo.ts', 'foo.ts']) {
        const result = await dispatch(executor, projectRoot, runDir, { type: 'read_file', path }, 1, path);
        if (caseAliases && path === 'foo.ts') {
          assert.match(result.observation, /Skipping re-injection/, 'Windows case aliases reuse unchanged content');
        } else {
          assert.match(result.observation, /export const value = 1/);
          assert.doesNotMatch(result.observation, /Skipping re-injection|READ_LIMIT/);
        }
      }
      const repeated = await dispatch(executor, projectRoot, runDir, { type: 'read_file', path: 'foo.ts' }, 1, 'repeat');
      assert.match(repeated.observation, /Skipping re-injection/, 'same-path unchanged bytes still deduplicate');
    } finally { close(); }
  });

  test('read_file uses production Chat wrapper: byte cap and full-read accounting on repeat (no readCache claim)', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-read-wrapper-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    writeFileSync(
      join(projectRoot, 'long-lines.txt'),
      `${'A'.repeat(60_000)}\n${'B'.repeat(60_000)}\n`,
      'utf8',
    );
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('owner-1', 'task-1') };
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    try {
    const executor = new ChatEngineActionExecutor(host);
    const first = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'read_file', path: 'long-lines.txt' },
      1,
      'read-1',
    );
    assert.match(first.observation, /source byte-capped/);
    assert.equal(first.observation.includes('complete file'), false);
    assert.equal(host.fullReadCounts.size, 0);
    const second = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'read_file', path: 'long-lines.txt' },
      1,
      'read-2',
    );
    assert.match(second.observation, /source byte-capped/);
    assert.equal(host.fullReadCounts.size, 0, 'incomplete reads never consume full-read allowance');
    assert.equal(
      second.observation.includes('complete file'),
      false,
      'repeated reads stay explicitly incomplete',
    );
    } finally { close(); }
  });

  test('missing task allowance surfaces explicit artifact loss instead of silent spill', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-no-artifact-access-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    const script = writeNodeFixture(
      storage,
      'spill.mjs',
      `console.log(${JSON.stringify('y'.repeat(5000))});`,
    );
    const { host, close } = makeHost(storage, projectRoot, runDir, { ownerGeneration: 1, taskAllowance: null });
    try {
    const executor = new ChatEngineActionExecutor(host);
    const result = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'run_command', command: `node ${shellArg(script)}` },
      1,
      'no-access',
    );
    assert.match(result.observation, /raw_output_unavailable: artifact registration failed/);
    assert.equal(result.observation.match(/artifact_id:\s*[a-f0-9-]{36}/g)?.length ?? 0, 0);
    } finally { close(); }
  });

  test('retention cap reports explicit resource-bound loss (registerRunOutput contract)', () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-retention-cap-'));
    cleanup.push(storage);
    const runDir = join(storage, 'run');
    mkdirSync(runDir);
    const owner = { sessionId: 's', taskOwnerId: 'o', acceptedTaskId: 't' };
    assert.throws(
      () =>
        registerRunOutput({
          runDir,
          owner,
          content: 'x'.repeat(MAX_RUN_OUTPUT_BYTES + 1),
          tool: 'run_command',
          callId: 'oversize',
        }),
      /ARTIFACT_RESOURCE_BOUND_EXCEEDED/,
    );
    const artifact = registerRunOutput({
      runDir,
      owner,
      content: 'immutable-body',
      tool: 'run_command',
      callId: 'immutable',
    });
    writeFileSync(join(runDir, 'tool-output-artifacts', `${artifact.id}.log`), 'mutated', 'utf8');
    assert.throws(
      () => readRunOutput({ runDir, owner, artifactId: artifact.id }),
      /ARTIFACT_CONTENT_IDENTITY_CHANGED/,
    );
  });

  test('second engine session cannot read the first engine enrolled artifact (cross-session)', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'babel-cross-session-'));
    cleanup.push(storage);
    const projectRoot = join(storage, 'project');
    const runDir = join(storage, 'run');
    mkdirSync(projectRoot);
    mkdirSync(runDir);
    const controls: HostControls = { ownerGeneration: 1, taskAllowance: allowance('shared-owner', 'task-1') };
    const { host, close } = makeHost(storage, projectRoot, runDir, controls);
    try {
    const executor = new ChatEngineActionExecutor(host);
    const rowsScript = writeNodeFixture(
      storage,
      'many-rows.mjs',
      `console.log(Array.from({ length: 3000 }, (_, i) => 'row ' + i).join('\\n'));`,
    );
    const spill = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'run_command', command: `node ${shellArg(rowsScript)}` },
      1,
      'session-a',
    );
    const artifactId = spill.observation.match(/artifact_id:\s*([a-f0-9-]{36})/)?.[1];
    assert.ok(artifactId);
    host.engineRunId = 'other-session-id';
    const denied = await dispatch(
      executor,
      projectRoot,
      runDir,
      { type: 'read_artifact', artifact_id: artifactId!, query: 'row' },
      1,
      'session-b',
    );
    assert.match(denied.observation, /ARTIFACT_DENIED|denied/i);
    } finally { close(); }
  });
});
