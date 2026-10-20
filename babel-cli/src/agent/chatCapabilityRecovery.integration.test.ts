/**
 * Finding 6 / 6B — trusted failure classification and real-dispatcher bounded
 * capability recovery.
 *
 * These tests drive the actual ChatEngine action dispatcher. A deterministic
 * tool executor is injected per instance with `setToolExecutorForTesting`, so
 * execution is admitted, controlled and observable: the fake never launches a
 * real subprocess and never touches a provider or the network. Policy and
 * admission still run, because the executor is only reached through
 * `executeActionWithPolicy`.
 *
 * Host execution is admitted by selecting the documented no-isolation profile
 * (`dev_local`) under a narrow synthetic autonomy lease. The isolation-denial
 * case keeps a Docker-requiring profile with no image, which fails closed
 * before the executor.
 *
 * `ls -R` is used as the recursive command: it is admitted by the lease and
 * `classifyShellCapability` classifies it as `shell.recursive_enumeration`.
 * The executor is a fake, so nothing is actually enumerated.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from './chatEngine.js';
import { classifyShellCapability } from './progressController.js';
import { createToolExecutor } from './toolExecutor.js';
import type { ToolCallRequest, ToolContext } from '../localTools.js';
import type { ToolResult } from '../sandbox.js';

const CAPABILITY = 'shell.recursive_enumeration';
const RECURSIVE = { type: 'run_command' as const, command: 'ls -R' };
const SUPPRESSED = /Recursive shell command suppressed/;

/**
 * Narrow synthetic autonomy lease: it grants only in-repo inspection and local
 * command execution, and keeps every gated capability (merge, release, admin,
 * credentials) out. It admits the fake executor; it grants no real capability.
 */
const SYNTHETIC_LEASE = JSON.stringify({
  version: 2,
  leaseId: 'synthetic-fixture-lease',
  scope: { repository: 'gthgomez/Babel', remote: 'origin', worktree: 'current' },
  allowedCapabilities: [
    'inspect_repository',
    'search_repository',
    'run_local_command',
    'run_tests',
    'run_build',
    'run_lint',
    'run_typecheck',
    'edit_task_files',
    'create_task_branch',
  ],
  branchPrefixes: ['feat/', 'fix/', 'test/'],
  constraints: {
    protectedBranches: ['main'],
    forcePush: false,
    remoteRefDelete: false,
    releasePublish: false,
    productionDeploy: false,
    repositoryAdmin: false,
    secretsAccess: false,
    billing: false,
    destructiveDb: false,
    scopeExpansion: false,
  },
  budgets: { ciProductRepairRounds: 3, ciTransientReruns: 1, prRecreateRounds: 1, parallelAgents: 8 },
  gates: [
    'merge',
    'pr_mark_ready',
    'release',
    'production_deploy',
    'repo_admin',
    'security_policy_change',
    'credential_access',
    'destructive_data_delete',
    'shared_history_rewrite',
    'force_push',
    'scope_expansion',
    'run_arbitrary_code',
  ],
  forbidden: ['expose_credentials'],
});

const ok = (stdout = 'files'): ToolResult => ({ exit_code: 0, stdout, stderr: '' });
const hostLaunchFailure = (): ToolResult => ({
  exit_code: 1,
  stdout: '',
  stderr: '[sandbox] Spawn error: fake',
  launch_failure: { code: 'spawn_error' },
});
const spoofedMarker = (): ToolResult => ({
  exit_code: 1,
  stdout: '',
  stderr: '[sandbox] Spawn error: spawn fake.exe ENOENT',
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ProgressProbe {
  readonly TrustedEnvironmentIdentity: string | null;
  getCapabilityState(capability: string): string;
  getDegradedCapabilities(): { capability: string }[];
  recordFailure(sig: {
    tool: string;
    commandSnippet?: string;
    exitCode?: number;
    stderr?: string;
    policyBlocked?: boolean;
    capabilityFailure?: boolean;
  }): { outcome: string; state: string };
  admitCapabilityRecoveryProbe(request: {
    capability: string;
    taskId: string;
    environmentIdentity: string;
  }): boolean;
  hasConsumedCapabilityRecoveryProbe(request: {
    capability: string;
    taskId: string;
    environmentIdentity: string;
  }): boolean;
  getConsumedCapabilityRecoveryProbes(): string[];
}

interface Harness {
  engine: ChatEngine;
  calls: ToolCallRequest[];
  pc: ProgressProbe;
  dispatch(index: number): Promise<{ index: number; observation: string; stop?: boolean }>;
}

const ENV_KEYS = [
  'BABEL_EXECUTION_PROFILE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_DOCKER_DISABLE',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

/**
 * Isolated fixture: temp project root, synthetic environment, synthetic lease
 * and a deterministic fake executor. `admitted` selects the documented
 * no-isolation profile; otherwise a Docker-requiring profile with no image
 * fails closed before the executor.
 */
function withFixture(
  name: string,
  handler: (req: ToolCallRequest) => Promise<ToolResult>,
  options: { admitted?: boolean } = {},
): { h: Harness; cleanup: () => void } {
  const { admitted = true } = options;
  const root = mkdtempSync(join(tmpdir(), name));
  const previous = new Map<EnvKey, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

  for (const key of ENV_KEYS) delete process.env[key];
  process.env['BABEL_EXECUTION_PROFILE'] = admitted ? 'dev_local' : 'benchmark_container';
  process.env['BABEL_AUTONOMY_LEASE'] = SYNTHETIC_LEASE;

  const calls: ToolCallRequest[] = [];
  const engine = new ChatEngine({ task: 'List the project tree', projectRoot: root });
  engine.setToolExecutorForTesting(
    createToolExecutor({
      executeTool: async (req: ToolCallRequest, _context: ToolContext): Promise<ToolResult> => {
        calls.push(req);
        return await handler(req);
      },
    }),
  );
  const pc = (engine as unknown as { progressController: ProgressProbe }).progressController;
  const ctx = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root, projectRoot: root };

  return {
    h: {
      engine,
      calls,
      pc,
      dispatch: (index: number) =>
        (engine as unknown as {
          executeOneAction: (
            a: unknown,
            c: unknown,
            cb: unknown,
            m: unknown,
          ) => Promise<{ index: number; observation: string; stop?: boolean }>;
        }).executeOneAction({ ...RECURSIVE }, ctx, {}, { index }),
    },
    cleanup: () => {
      for (const key of ENV_KEYS) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Seed the DEGRADED precondition with genuine (structured) capability failures. */
function degrade(pc: ProgressProbe, times = 2): void {
  for (let i = 0; i < times; i += 1) {
    pc.recordFailure({ tool: 'run_command', commandSnippet: RECURSIVE.command, exitCode: 1, capabilityFailure: true });
  }
  assert.equal(pc.getCapabilityState(CAPABILITY), 'DEGRADED', 'fixture precondition');
}

/** Flush pending microtasks/macrotasks until `predicate` holds (no sleeps). */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('a child that prints a lookalike launch marker cannot degrade the family', async () => {
  const { h, cleanup } = withFixture('babel-cap-spoof-', async () => spoofedMarker());
  try {
    assert.equal(classifyShellCapability(RECURSIVE.type, RECURSIVE.command).capability, CAPABILITY);

    for (let index = 0; index < 3; index += 1) await h.dispatch(index);

    assert.equal(h.pc.getCapabilityState(CAPABILITY), 'AVAILABLE', 'child text is not trusted capability evidence');
    assert.equal(h.calls.length, 3, 'no probe/suppression engaged: every attempt reached the executor');
  } finally {
    cleanup();
  }
});

test('a host-origin launch failure is trusted evidence: degrades, then one probe, then suppression', async () => {
  const { h, cleanup } = withFixture('babel-cap-launch-', async () => hostLaunchFailure());
  try {
    await h.dispatch(0);
    assert.equal(h.pc.getCapabilityState(CAPABILITY), 'SUSPECT');
    await h.dispatch(1);
    assert.equal(h.pc.getCapabilityState(CAPABILITY), 'DEGRADED');

    const probe = await h.dispatch(2);
    assert.doesNotMatch(probe.observation, SUPPRESSED, 'the one bounded probe must reach dispatch');
    const suppressed = await h.dispatch(3);
    assert.match(suppressed.observation, SUPPRESSED);
    assert.equal(h.calls.length, 3, 'the suppressed attempt must not reach the executor');
  } finally {
    cleanup();
  }
});

test('two competing dispatched requests share one probe and exactly one executor invocation', async () => {
  const { h, cleanup } = withFixture('babel-cap-race-', async () => hostLaunchFailure());
  try {
    degrade(h.pc);

    const [first, second] = await Promise.all([h.dispatch(0), h.dispatch(1)]);
    assert.equal([first.observation, second.observation].filter((o) => SUPPRESSED.test(o)).length, 1);
    assert.equal(h.calls.length, 1, 'exactly one executor invocation for the shared probe');
    assert.equal(
      h.pc.getConsumedCapabilityRecoveryProbes().filter((k) => k.startsWith(`${CAPABILITY}\u0000`)).length,
      1,
    );
  } finally {
    cleanup();
  }
});

test('a real successful execution restores availability', async () => {
  const { h, cleanup } = withFixture('babel-cap-restore-', async () => ok());
  try {
    degrade(h.pc);

    const probe = await h.dispatch(0);
    assert.doesNotMatch(probe.observation, SUPPRESSED);
    assert.equal(h.calls.length, 1);
    assert.equal(h.pc.getCapabilityState(CAPABILITY), 'AVAILABLE', 'a successful execution restores the family');
    assert.equal(h.pc.getDegradedCapabilities().length, 0);
  } finally {
    cleanup();
  }
});

test('a failing probe consumes the reservation and does not re-arm it', async () => {
  const { h, cleanup } = withFixture('babel-cap-norearm-', async () => hostLaunchFailure());
  try {
    degrade(h.pc);

    await h.dispatch(0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.pc.getCapabilityState(CAPABILITY), 'DEGRADED', 'failure keeps the family degraded');

    const after = await h.dispatch(1);
    assert.match(after.observation, SUPPRESSED, 'the consumed reservation cannot re-arm');
    assert.equal(h.calls.length, 1);
  } finally {
    cleanup();
  }
});

test('a throwing probe consumes the reservation and does not re-arm it', async () => {
  const { h, cleanup } = withFixture('babel-cap-throw-', async () => {
    throw new Error('synthetic executor fault');
  });
  try {
    degrade(h.pc);

    const thrown = await h.dispatch(0);
    assert.equal(h.calls.length, 1, 'the probe reached the executor before throwing');
    assert.doesNotMatch(thrown.observation, SUPPRESSED, 'the throw is an error surface, not suppression');

    const after = await h.dispatch(1);
    assert.match(after.observation, SUPPRESSED, 'a thrown probe still consumes the reservation');
    assert.equal(h.calls.length, 1);
  } finally {
    cleanup();
  }
});

test('owner replacement while execution is pending: late success and failure cannot mutate the new owner', async () => {
  for (const late of ['success', 'failure'] as const) {
    const gate = deferred<ToolResult>();
    const { h, cleanup } = withFixture(`babel-cap-owner-${late}-`, async () => await gate.promise);
    try {
      degrade(h.pc);

      const pending = h.dispatch(0);
      await waitFor(() => h.calls.length === 1, 'the pending execution to reach the executor');

      const engine = h.engine as unknown as { activeSubmissionGeneration: number };
      engine.activeSubmissionGeneration = Number(engine.activeSubmissionGeneration ?? 0) + 1;
      const before = h.pc.getCapabilityState(CAPABILITY);
      const consumedBefore = h.pc.getConsumedCapabilityRecoveryProbes().length;

      gate.resolve(late === 'success' ? ok() : hostLaunchFailure());
      await pending;

      assert.equal(h.pc.getCapabilityState(CAPABILITY), before, `late ${late} must not change the new owner's health`);
      assert.equal(
        h.pc.getConsumedCapabilityRecoveryProbes().length,
        consumedBefore,
        `late ${late} must not consume or re-arm the new owner's probe state`,
      );
    } finally {
      cleanup();
    }
  }
});

test('a new task may probe once and a model label cannot forge a trusted environment', async () => {
  const { h, cleanup } = withFixture('babel-cap-scope-', async () => hostLaunchFailure());
  try {
    degrade(h.pc);
    await h.dispatch(0);
    assert.equal(h.calls.length, 1, 'the one probe for this task reached dispatch');

    const trusted = h.pc.TrustedEnvironmentIdentity;
    assert.ok(trusted && trusted.length > 0, 'the dispatcher binds a host-derived environment identity');

    assert.equal(
      h.pc.admitCapabilityRecoveryProbe({ capability: CAPABILITY, taskId: 'attacker-task', environmentIdentity: 'model-supplied' }),
      false,
      'a model-supplied environment label cannot mint a fresh probe budget',
    );
    assert.equal(
      h.pc.hasConsumedCapabilityRecoveryProbe({ capability: CAPABILITY, taskId: 'attacker-task', environmentIdentity: 'model-supplied' }),
      false,
    );

    const engine = h.engine as unknown as { activeSubmissionGeneration: number };
    engine.activeSubmissionGeneration = Number(engine.activeSubmissionGeneration ?? 0) + 1;
    const reprobe = await h.dispatch(1);
    assert.doesNotMatch(reprobe.observation, SUPPRESSED, 'a new task re-arms exactly one probe');
    assert.equal(h.calls.length, 2);
  } finally {
    cleanup();
  }
});

test('a real isolation denial occurs before the executor and never invokes it', async () => {
  const { h, cleanup } = withFixture('babel-cap-isolation-', async () => ok(), { admitted: false });
  try {
    degrade(h.pc);

    const denied = await h.dispatch(0);
    assert.ok(/isolation_unavailable|Policy denied/.test(denied.observation), 'the real gate denies the action');
    assert.doesNotMatch(denied.observation, SUPPRESSED);
    assert.equal(h.calls.length, 0, 'a denied action must never invoke the executor');
    assert.equal(h.pc.getCapabilityState(CAPABILITY), 'DEGRADED', 'a permission/isolation denial is not capability evidence');
  } finally {
    cleanup();
  }
});
