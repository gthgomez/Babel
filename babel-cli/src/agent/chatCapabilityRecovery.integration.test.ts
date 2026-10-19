/**
 * Finding 6 — real-dispatcher bounded capability recovery.
 *
 * Drives the actual ChatEngine action dispatcher (not a helper) to prove that a
 * degraded shell family is probed at most once per capability × task × trusted
 * environment, that a failed probe remains degraded while later attempts stay
 * suppressed, and that a fresh submission re-arms exactly one probe without
 * leaking stale consumption.
 *
 * The sandbox is unavailable in this environment, so a dispatched shell command
 * is refused with a permission/isolation denial. That is deliberately a
 * non-capability outcome: it must not itself degrade a family, so the fixture
 * establishes the DEGRADED precondition with genuine capability failures and
 * then asserts the dispatch-level probe/suppression behaviour.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from './chatEngine.js';
import { classifyShellCapability } from './progressController.js';

const RECURSIVE = { type: 'run_command' as const, command: 'Get-ChildItem -Path . -Recurse' };

interface ProgressProbe {
  readonly TrustedEnvironmentIdentity: string | null;
  getCapabilityState(capability: string): string;
  recordFailure(sig: {
    tool: string;
    commandSnippet?: string;
    exitCode?: number;
    stderr?: string;
    policyBlocked?: boolean;
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

function progress(engine: ChatEngine): ProgressProbe {
  return (engine as unknown as { progressController: ProgressProbe }).progressController;
}

const SUPPRESSED = /Recursive shell command suppressed/;

test('a degraded capability is probed once, suppressed, and re-armed for a new task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cap-recovery-'));
  try {
    const engine = new ChatEngine({ task: 'List the project tree', projectRoot: root });
    const pc = progress(engine);
    assert.equal(
      classifyShellCapability(RECURSIVE.type, RECURSIVE.command).capability,
      'shell.recursive_enumeration',
    );

    // Genuine capability failures degrade the family; an isolation/permission
    // denial deliberately would not.
    pc.recordFailure({ tool: 'run_command', commandSnippet: RECURSIVE.command, exitCode: 1 });
    pc.recordFailure({ tool: 'run_command', commandSnippet: RECURSIVE.command, exitCode: 1 });
    assert.equal(pc.getCapabilityState('shell.recursive_enumeration'), 'DEGRADED');

    const ctx = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root, projectRoot: root };

    const probe = await (engine as any).executeOneAction(RECURSIVE, ctx, {}, { index: 0 });
    assert.doesNotMatch(probe.observation, SUPPRESSED, 'the one bounded probe must reach dispatch');
    // The probe ran and failed here (sandbox unavailable), so the family stays degraded.
    assert.equal(pc.getCapabilityState('shell.recursive_enumeration'), 'DEGRADED');

    const suppressed = await (engine as any).executeOneAction({ ...RECURSIVE }, ctx, {}, { index: 1 });
    assert.match(suppressed.observation, SUPPRESSED, 'the consumed probe must suppress the next attempt');

    // Owner replacement: a new submission generation re-arms exactly one probe.
    // The dispatcher derives the probe task id from host.activeSubmissionGeneration,
    // so advancing it is the precise seam an owner replacement moves.
    const generation = Number((engine as any).activeSubmissionGeneration ?? 0);
    (engine as any).activeSubmissionGeneration = generation + 1;
    const reprobe = await (engine as any).executeOneAction({ ...RECURSIVE }, ctx, {}, { index: 2 });
    assert.doesNotMatch(reprobe.observation, SUPPRESSED, 'a new submission re-arms one probe');

    const consumed = pc
      .getConsumedCapabilityRecoveryProbes()
      .filter((key) => key.startsWith('shell.recursive_enumeration\u0000'));
    assert.equal(consumed.length, 2, 'exactly one probe consumed per capability/task/environment');
    const taskIds = new Set(consumed.map((key) => key.split('\u0000')[1]));
    assert.equal(taskIds.size, 2, 'each task re-armed its own single probe');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe scope is host-derived and refuses a model-supplied environment label', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cap-scope-'));
  try {
    const engine = new ChatEngine({ task: 'List the tree', projectRoot: root });
    const pc = progress(engine);
    pc.recordFailure({ tool: 'run_command', commandSnippet: RECURSIVE.command, exitCode: 1 });
    pc.recordFailure({ tool: 'run_command', commandSnippet: RECURSIVE.command, exitCode: 1 });

    const ctx = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root, projectRoot: root };
    await (engine as any).executeOneAction({ ...RECURSIVE }, ctx, {}, { index: 0 });

    const trusted = pc.TrustedEnvironmentIdentity;
    assert.ok(trusted && trusted.length > 0, 'the dispatcher binds a host-derived environment identity');
    assert.equal(
      pc.admitCapabilityRecoveryProbe({
        capability: 'shell.recursive_enumeration',
        taskId: 'attacker-task',
        environmentIdentity: 'model-supplied',
      }),
      false,
      'a model-supplied environment label cannot mint a fresh probe budget',
    );
    assert.equal(
      pc.hasConsumedCapabilityRecoveryProbe({
        capability: 'shell.recursive_enumeration',
        taskId: 'attacker-task',
        environmentIdentity: 'model-supplied',
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an isolation permission denial does not by itself degrade a family', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-cap-denial-'));
  try {
    const engine = new ChatEngine({ task: 'List the tree', projectRoot: root });
    const pc = progress(engine);
    const ctx = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root, projectRoot: root };

    for (let index = 0; index < 3; index += 1) {
      await (engine as any).executeOneAction({ ...RECURSIVE }, ctx, {}, { index });
    }

    assert.equal(
      pc.getCapabilityState('shell.recursive_enumeration'),
      'AVAILABLE',
      'repeated permission/isolation denials must not disable the shell family',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
