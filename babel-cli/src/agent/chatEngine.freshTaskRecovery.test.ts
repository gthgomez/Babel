/**
 * #216 — native two-submission fresh-task recovery conformance.
 *
 * The TUI creates one ChatEngine and reuses it across unrelated user
 * submissions. `ProgressController` is constructed once per engine, so a
 * task-local recovery leak would punish an unrelated later task. These tests
 * drive the real `applyUserSubmission` seam (no live provider, no network) to
 * determine whether that leak exists.
 *
 * A.1 fresh-task leak  -> REPRODUCTION (fails at campaign head 10117072).
 * A.2 continueTask      -> positive control: explicit continuation must not be
 *                          blanket-reset by a fresh-task repair.
 * A.3 capability health -> deliberately environment-scoped: it may survive a
 *                          task boundary and must not be blanked.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine } from './chatEngine.js';
import { ingestVerifierResult } from './codingLoop/chatBindings.js';
import { applyWorkingStateEvent, createWorkingState } from './codingLoop/workingState.js';

interface ProgressControllerProbe {
  readonly InterventionLevel: string;
  scoreTurn(
    signals: string[],
    textOnlyTurn: boolean,
    gateStrikes: number,
  ): { intervention: string; transitioned: boolean; score: number };
  getCapabilityState(capability: string): string;
}

function progress(engine: ChatEngine): ProgressControllerProbe {
  return (engine as unknown as { progressController: ProgressControllerProbe }).progressController;
}

function driveToTerminalBlocked(engine: ChatEngine, turns = 12): void {
  const controller = progress(engine);
  for (let i = 0; i < turns; i += 1) controller.scoreTurn([], false, 0);
  assert.equal(
    controller.InterventionLevel,
    'terminal_blocked',
    'fixture precondition: task A must reach terminal_blocked',
  );
  // ProgressController exposes both `InterventionLevel` and `TotalScore`; the
  // level is the task-local punishment state this fixture needs to assert.
}

function redRecoveryState() {
  let state = createWorkingState('repair the parser failure');
  state = applyWorkingStateEvent(state, {
    type: 'set_hypothesis',
    hypothesis: 'the parser is the cause',
  });
  state = applyWorkingStateEvent(state, {
    type: 'mutation',
    path: 'src/agent/codingLoop/workingState.ts',
    fingerprint: 'first-repair',
  });
  return ingestVerifierResult({
    state,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL tests failed: parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  }).state;
}

test('R1 production path blocks arbitrary shell mutation before execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-r1-shell-'));
  const target = join(root, 'must-not-exist.txt');
  try {
    const engine = new ChatEngine({ task: 'repair the parser failure', projectRoot: process.cwd() });
    (engine as any).workingState = redRecoveryState();
    const result = await (engine as any).executeOneAction(
      {
        type: 'run_command',
        command: `node -e "require('fs').writeFileSync('${target.replaceAll('\\', '/')}', 'mutated')"`,
      },
      { agentId: 'test', runId: 'test', runDir: root, babelRoot: root },
      {},
      { index: 0, ownerGeneration: 0 },
    );
    assert.match(result.observation, /RECOVERY_EVIDENCE_REQUIRED/);
    assert.equal(existsSync(target), false, 'the shell mutation must not reach the executor');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1 production path rejects unrelated reads and accepts implicated-file evidence', async () => {
  const engine = new ChatEngine({ task: 'repair the parser failure', projectRoot: process.cwd() });
  (engine as any).workingState = redRecoveryState();
  const context = { agentId: 'test', runId: 'test', runDir: process.cwd(), babelRoot: process.cwd() };

  await (engine as any).executeOneAction(
    { type: 'read_file', path: 'package.json' },
    context,
    {},
    { index: 0, ownerGeneration: 0 },
  );
  assert.equal((engine as any).workingState.recoveryGate.satisfied, false);

  const target = 'src/agent/codingLoop/workingState.ts';
  await (engine as any).executeOneAction(
    { type: 'read_file', path: target },
    context,
    {},
    { index: 1, ownerGeneration: 0 },
  );
  assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
  assert.match(readFileSync(target, 'utf8'), /recoveryGate/);
});

test('#216 [REPRODUCTION] fresh submission must not inherit task-local recovery punishment', () => {
  const engine = new ChatEngine({ task: 'A: investigate stall', projectRoot: process.cwd() });
  engine.applyUserSubmission({ userInput: 'A: investigate stall' });
  driveToTerminalBlocked(engine);

  const next = engine.applyUserSubmission({
    userInput: 'B: unrelated read-only inventory of the repository',
  });
  assert.equal(next.continuedTask, false, 'B must be admitted as a fresh task');

  const controller = progress(engine);
  assert.equal(
    controller.InterventionLevel,
    'none',
    'fresh task B must not start carrying task A terminal strikes',
  );
  const firstProductiveTurn = controller.scoreTurn(['new_localization'], false, 0);
  assert.equal(
    firstProductiveTurn.intervention,
    'none',
    "B's first productive turn must not report last_chance_repair from A's strikes",
  );
});

test('#216 continueTask preserves task-local recovery state (positive control)', () => {
  const engine = new ChatEngine({ task: 'A: investigate stall', projectRoot: process.cwd() });
  engine.applyUserSubmission({ userInput: 'A: investigate stall' });
  driveToTerminalBlocked(engine);

  const continued = engine.applyUserSubmission({
    userInput: 'continue investigating the same stall',
    continueTask: true,
  });
  assert.equal(continued.continuedTask, true, 'explicit continuation must link to the prior task');

  assert.equal(
    progress(engine).InterventionLevel,
    'terminal_blocked',
    'explicit continuation must preserve task-local punishment (no blanket reset)',
  );
});

test('#216 capability health survives a task boundary and is not blanked', async () => {
  const engine = new ChatEngine({ task: 'Find all files in repo', projectRoot: '/tmp' });
  const action = {
    type: 'run_command' as const,
    command: 'Get-ChildItem -Path /non_existent_path_xyz_123 -Recurse',
  };
  const ctx = { agentId: 'test', runId: 'test', runDir: '/tmp', babelRoot: '/tmp' };

  await (engine as any).executeOneAction(action, ctx, {}, { index: 0, subAgentCounter: 0 });
  await (engine as any).executeOneAction(action, ctx, {}, { index: 1, subAgentCounter: 0 });
  assert.equal(
    progress(engine).getCapabilityState('shell.recursive_enumeration'),
    'DEGRADED',
    'fixture precondition: recursive enumeration degrades after two failures',
  );

  engine.applyUserSubmission({ userInput: 'B: list the project tree' });

  assert.equal(
    progress(engine).getCapabilityState('shell.recursive_enumeration'),
    'DEGRADED',
    'environment/provider capability health deliberately survives a task boundary and must not be blanked',
  );
});
