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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine } from './chatEngine.js';
import { ingestVerifierResult } from './codingLoop/chatBindings.js';
import { applyWorkingStateEvent, createWorkingState } from './codingLoop/workingState.js';
import { actualRecoveryEdit, recoveryObservationId } from './codingLoop/recoveryPlan.js';
import { startFailureLocalization } from './codingLoop/failureLocalization.js';
import { createSessionEventLog, recordUserSubmitted, recordVerifierAttempt, recordWorkingStateSnapshot } from './sessionEvents.js';

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

function redRecoveryState(engine: ChatEngine) {
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
    recoveryBinding: (engine as any).currentRecoveryBinding(),
    recoveryProjectRoot: process.cwd(),
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
    (engine as any).workingState = redRecoveryState(engine);
    const result = await (engine as any).executeOneAction(
      {
        type: 'run_command',
        command: `node -e "require('fs').writeFileSync('${target.replaceAll('\\', '/')}', 'mutated')"`,
      },
      { agentId: 'test', runId: 'test', runDir: root, babelRoot: root },
      {},
      { index: 0, ownerGeneration: 0 },
    );
    assert.match(result.observation, /RECOVERY_EVIDENCE_REQUIRED|RECOVERY_CANDIDATE_DRIFT/);
    assert.equal(existsSync(target), false, 'the shell mutation must not reach the executor');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1 production path rejects unrelated reads and accepts implicated-file evidence', async () => {
  const engine = new ChatEngine({ task: 'repair the parser failure', projectRoot: process.cwd() });
  (engine as any).workingState = redRecoveryState(engine);
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

test('R1 production path rejects content-free inspections as recovery evidence', async () => {
  const engine = new ChatEngine({ task: 'repair the parser failure', projectRoot: process.cwd() });
  (engine as any).workingState = redRecoveryState(engine);
  const context = { agentId: 'test', runId: 'test', runDir: process.cwd(), babelRoot: process.cwd() };

  const denied: Array<Record<string, unknown>> = [
    { type: 'list_dir', path: '.' },
    { type: 'glob', pattern: '**/*.ts' },
    { type: 'grep', pattern: '.' },
    // An ancestor directory is a repository-wide search, not a localization.
    { type: 'grep', pattern: 'recoveryGate', path: 'src/agent' },
  ];
  let index = 0;
  for (const action of denied) {
    await (engine as any).executeOneAction(action, context, {}, { index: index++, ownerGeneration: 0 });
    assert.equal(
      (engine as any).workingState.recoveryGate.satisfied,
      false,
      `${String(action.type)} must not clear the recovery gate`,
    );
  }

  // A search scoped to the implicated file is content-bearing and localizes the failure.
  await (engine as any).executeOneAction(
    { type: 'grep', pattern: 'recoveryGate', path: 'src/agent/codingLoop/workingState.ts' },
    context,
    {},
    { index: index++, ownerGeneration: 0 },
  );
  assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
});

test('R1 production path does not accept a repeated read as new evidence for the same failure', async () => {
  const engine = new ChatEngine({ task: 'repair the parser failure', projectRoot: process.cwd() });
  (engine as any).workingState = redRecoveryState(engine);
  const context = { agentId: 'test', runId: 'test', runDir: process.cwd(), babelRoot: process.cwd() };
  const target = 'src/agent/codingLoop/workingState.ts';

  await (engine as any).executeOneAction(
    { type: 'read_file', path: target },
    context,
    {},
    { index: 0, ownerGeneration: 0 },
  );
  assert.equal((engine as any).workingState.recoveryGate.satisfied, true);

  // Arm a fresh gate for the *same* failure signature, as happens after another
  // equivalent red. The target was already consumed, so re-reading it is not new
  // discriminating evidence.
  const state = (engine as any).workingState;
  const signature = state.recoveryGate.failureSignature;
  (engine as any).workingState = applyWorkingStateEvent(state, {
    type: 'recovery_gate',
    failureSignature: signature,
    requiredEvidence: 'reread the failing assertion',
    failingTargets: state.recoveryGate.failingTargets,
    binding: state.recoveryGate.binding,
  });

  await (engine as any).executeOneAction(
    { type: 'read_file', path: target },
    context,
    {},
    { index: 1, ownerGeneration: 0 },
  );
  assert.equal((engine as any).workingState.recoveryGate.satisfied, false);
});

test('R1 recovery permit is invalidated by external workspace drift before mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-r1-drift-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    mkdirSync(join(root, 'src'));
    const file = join(root, 'src', 'parser.ts');
    const marker = join(root, 'executed.txt');
    writeFileSync(file, 'export const value = 1\n');
    execFileSync('git', ['add', 'src/parser.ts'], { cwd: root, windowsHide: true });
    const engine = new ChatEngine({ task: 'repair parser', projectRoot: root });
    let state = applyWorkingStateEvent(createWorkingState('repair parser'), {
      type: 'mutation', path: 'src/parser.ts', fingerprint: 'failed-patch',
    });
    state = ingestVerifierResult({
      state, tool: 'test_run', target: 'npm test', exitCode: 1,
      stdout: 'FAIL parser', stderr: '', summary: 'parser remains red',
      recoveryProjectRoot: root,
      recoveryBinding: (engine as any).currentRecoveryBinding(),
    }).state;
    (engine as any).workingState = state;
    const context = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root };
    await (engine as any).executeOneAction(
      { type: 'read_file', path: 'src/parser.ts' }, context, {},
      { index: 0, ownerGeneration: 0 },
    );
    assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
    writeFileSync(file, 'export const value = 2\n');
    const result = await (engine as any).executeOneAction(
      { type: 'run_command', command: `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'executed')"` },
      context, {}, { index: 1, ownerGeneration: 0 },
    );
    assert.match(result.observation, /RECOVERY_CANDIDATE_DRIFT/);
    assert.equal((engine as any).workingState.recoveryGate.satisfied, false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1 repair plan rejects a repeated edit and admits one changed scoped edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-r1-plan-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    mkdirSync(join(root, 'src'));
    const file = join(root, 'src', 'parser.ts');
    writeFileSync(file, 'export const value = 2\n');
    execFileSync('git', ['add', 'src/parser.ts'], { cwd: root, windowsHide: true });
    const engine = new ChatEngine({ task: 'repair parser', projectRoot: root });
    const failedAction = { type: 'str_replace' as const, file_path: 'src/parser.ts', old_str: 'value = 1', new_str: 'value = 2' };
    const failedEdit = actualRecoveryEdit(failedAction, root)!;
    let state = applyWorkingStateEvent(createWorkingState('repair parser'), {
      type: 'mutation', path: 'src/parser.ts', fingerprint: failedEdit.exactFingerprint,
      canonicalFingerprint: failedEdit.editFingerprint,
    });
    state = ingestVerifierResult({
      state, tool: 'test_run', target: 'npm test', exitCode: 1,
      stdout: 'FAIL parser', stderr: '', summary: 'parser remains red',
      recoveryProjectRoot: root, recoveryBinding: (engine as any).currentRecoveryBinding(),
    }).state;
    (engine as any).workingState = state;
    const context = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root };
    await (engine as any).executeOneAction(
      { type: 'read_file', path: 'src/parser.ts' }, context, {}, { index: 0, ownerGeneration: 0 },
    );
    assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
    const gate = (engine as any).workingState.recoveryGate;
    const repairPlan = {
      schemaVersion: 1, failureSignature: gate.failureSignature,
      workspaceRevision: gate.binding.workspaceRevision,
      hypothesisClass: 'logic', targetIdentities: ['src/parser.ts'],
      actionFamily: 'str_replace', criterionId: 'npm test',
      supportingObservationIds: gate.observedKeys.map(recoveryObservationId),
    };
    const noPlan = await (engine as any).executeOneAction(
      { type: 'str_replace', file_path: 'src/parser.ts', old_str: 'value = 2', new_str: 'value = 3' },
      context, {}, { index: 1, ownerGeneration: 0 },
    );
    assert.match(noPlan.observation, /RECOVERY_PLAN_REQUIRED/);
    assert.match(readFileSync(file, 'utf8'), /value = 2/);

    const repeated = await (engine as any).executeOneAction(
      { ...failedAction, repair_plan: repairPlan }, context, {}, { index: 2, ownerGeneration: 0 },
    );
    assert.match(repeated.observation, /RECOVERY_STRATEGY_CHANGE_REQUIRED|RECOVERY_PLAN_REQUIRED/);
    assert.match(readFileSync(file, 'utf8'), /value = 2/);

    const changed = await (engine as any).executeOneAction(
      { type: 'str_replace', file_path: 'src/parser.ts', old_str: 'value = 2', new_str: 'value = 3', repair_plan: repairPlan },
      context, {}, { index: 3, ownerGeneration: 0 },
    );
    assert.doesNotMatch(changed.observation, /RECOVERY_PLAN_REQUIRED|RECOVERY_EVIDENCE_REQUIRED/);
    assert.match(readFileSync(file, 'utf8'), /value = 3/);
    assert.equal((engine as any).workingState.recoveryGate.permitConsumed, true);
    const replay = await (engine as any).executeOneAction(
      { type: 'str_replace', file_path: 'src/parser.ts', old_str: 'value = 3', new_str: 'value = 4', repair_plan: repairPlan },
      context, {}, { index: 4, ownerGeneration: 0 },
    );
    assert.match(replay.observation, /RECOVERY_EVIDENCE_REQUIRED|RECOVERY_CANDIDATE_DRIFT/);
    assert.match(readFileSync(file, 'utf8'), /value = 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1 resume restores bound evidence and refuses a newer unbound red verifier', () => {
  const engine = new ChatEngine({ task: 'repair parser', projectRoot: process.cwd() });
  const binding = (engine as any).currentRecoveryBinding();
  assert.ok(binding);
  let state = applyWorkingStateEvent(createWorkingState('repair parser'), {
    type: 'verifier', identity: 'npm test', exitCode: 1, summary: 'parser red',
  });
  state = applyWorkingStateEvent(state, {
    type: 'recovery_gate', failureSignature: 'parser-red', requiredEvidence: 'inspect',
    failingTargets: ['src/agent/codingLoop/workingState.ts'], binding,
  });
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence', evidence: 'read_file:workingState.ts', discriminating: true,
    provenance: {
      tool: 'read_file', target: 'src/agent/codingLoop/workingState.ts',
      failureSignature: 'parser-red', binding, observationDigest: 'content',
    },
  });
  assert.equal(state.recoveryGate?.satisfied, true);
  const log = createSessionEventLog('recovery-resume-test');
  recordVerifierAttempt(log, { turn_id: 'turn-1', command_preview: 'npm test', authoritative: true, exit_code: 1 });
  recordWorkingStateSnapshot(log, state, 'turn-1');
  (engine as any).restoreRecoveryWorkingState(log);
  assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
  assert.deepEqual((engine as any).workingState.consumedRecoveryEvidence, state.consumedRecoveryEvidence);

  recordVerifierAttempt(log, { turn_id: 'turn-2', command_preview: 'npm test', authoritative: true, exit_code: 1 });
  (engine as any).restoreRecoveryWorkingState(log);
  assert.equal((engine as any).workingState.recoveryGate.satisfied, false);
  assert.equal((engine as any).workingState.recoveryGate.binding, undefined);
});

test('R1 cold resume respects fresh and continued task boundaries without an early snapshot flush', () => {
  const engine = new ChatEngine({ task: 'repair parser', projectRoot: process.cwd() });
  const binding = (engine as any).currentRecoveryBinding();
  assert.ok(binding);
  let state = applyWorkingStateEvent(createWorkingState('repair parser'), {
    type: 'recovery_gate', failureSignature: 'red', requiredEvidence: 'inspect',
    failingTargets: ['src/agent/codingLoop/workingState.ts'], binding,
  });
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence', evidence: 'inspection', discriminating: true,
    provenance: {
      tool: 'read_file', target: 'src/agent/codingLoop/workingState.ts',
      failureSignature: 'red', binding, observationDigest: 'content',
    },
  });
  const continued = createSessionEventLog('continued-boundary');
  recordWorkingStateSnapshot(continued, state, 'turn-a');
  recordUserSubmitted(continued, { turn_id: 'turn-b', task: 'continue parser', continuedTask: true });
  (engine as any).restoreRecoveryWorkingState(continued);
  assert.equal((engine as any).workingState.recoveryGate?.satisfied, true);

  const fresh = createSessionEventLog('fresh-boundary');
  recordWorkingStateSnapshot(fresh, state, 'turn-a');
  recordUserSubmitted(fresh, { turn_id: 'turn-b', task: 'new task', continuedTask: false });
  (engine as any).restoreRecoveryWorkingState(fresh);
  assert.equal((engine as any).workingState.goal, 'new task');
  assert.equal((engine as any).workingState.recoveryGate, undefined);
});

test('R1 snapshot persistence failure blocks mutation without running the shell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-r1-persistence-'));
  const marker = join(root, 'executed.txt');
  try {
    const engine = new ChatEngine({ task: 'repair parser', projectRoot: process.cwd() });
    (engine as any).recoveryStatePersistenceUnavailable = true;
    const result = await (engine as any).executeOneAction(
      { type: 'run_command', command: `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'executed')"` },
      { agentId: 'test', runId: 'test', runDir: root, babelRoot: root },
      {}, { index: 0, ownerGeneration: 0 },
    );
    assert.match(result.observation, /RECOVERY_STATE_PERSISTENCE_UNAVAILABLE/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1 red command without verifier receipt closes recovery until a bound rerun', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-r1-unbound-red-'));
  const marker = join(root, 'blocked.txt');
  const envKeys = ['BABEL_BENCHMARK_AUTO_APPROVE', 'BABEL_BENCHMARK_MODE', 'BABEL_AUTONOMY_LEASE', 'BABEL_EXECUTION_PROFILE', 'BABEL_ALLOW_HOST_FALLBACK'] as const;
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
    process.env['BABEL_BENCHMARK_MODE'] = '1';
    process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
      version: 2, leaseId: 'recovery-unbound-red-test',
      scope: { repository: 'fixture', objective: 'verify fail-closed recovery' },
      allowedCapabilities: ['inspect_repository', 'run_arbitrary_code', 'run_local_command', 'run_tests', 'edit_task_files'],
    });
    process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
    const engine = new ChatEngine({ task: 'repair parser', projectRoot: process.cwd() });
    (engine as any).workingState = applyWorkingStateEvent(createWorkingState('repair parser'), {
      type: 'mutation', path: 'src/parser.ts', fingerprint: 'first-edit',
    });
    const context = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root };
    const red = await (engine as any).executeOneAction(
      { type: 'run_command', command: 'node -e "process.exit(1)"' },
      context, {}, { index: 0, ownerGeneration: 0 },
    );
    assert.equal((engine as any).workingState.recoveryGate?.satisfied, false, red.observation);
    assert.equal((engine as any).workingState.recoveryGate?.binding, undefined);
    const blocked = await (engine as any).executeOneAction(
      { type: 'run_command', command: `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'executed')"` },
      context, {}, { index: 1, ownerGeneration: 0 },
    );
    assert.match(blocked.observation, /RECOVERY_CANDIDATE_DRIFT|RECOVERY_EVIDENCE_REQUIRED/);
    assert.equal(existsSync(marker), false);
  } finally {
    for (const key of envKeys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('R1 no-target red localizes through a related read before admitting a plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-r1-localize-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    mkdirSync(join(root, 'src'));
    const file = join(root, 'src', 'parser.js');
    writeFileSync(file, 'export function parseToken() {\n  return 1\n}\n');
    execFileSync('git', ['add', 'src/parser.js'], { cwd: root, windowsHide: true });
    const engine = new ChatEngine({ task: 'repair parser', projectRoot: root });
    const context = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root };
    (engine as any).workingState = ingestVerifierResult({
      state: createWorkingState('repair parser'), tool: 'test_run', target: 'npm test', exitCode: 1,
      stdout: '', stderr: 'TypeError: bad\n    at parseToken (src/parser.js:2:3)',
      summary: 'parser failed', recoveryProjectRoot: root,
      recoveryBinding: (engine as any).currentRecoveryBinding(),
    }).state;
    assert.equal((engine as any).workingState.localization.phase, 'LOCALIZE_FAILURE');
    assert.equal((engine as any).workingState.recoveryGate.failingTargets, undefined);
    const denied = await (engine as any).executeOneAction(
      { type: 'str_replace', file_path: 'src/parser.js', old_str: 'return 1', new_str: 'return 2' },
      context, {}, { index: 0, ownerGeneration: 0 },
    );
    assert.match(denied.observation, /RECOVERY_EVIDENCE_REQUIRED/);
    await (engine as any).executeOneAction(
      { type: 'read_file', path: 'src/parser.js' }, context, {}, { index: 1, ownerGeneration: 0 },
    );
    const state = (engine as any).workingState;
    assert.equal(state.localization.phase, 'localized');
    assert.deepEqual(state.recoveryGate.failingTargets, ['src/parser.js']);
    assert.equal(state.recoveryGate.satisfied, true);
    const repairPlan = {
      schemaVersion: 1, failureSignature: state.recoveryGate.failureSignature,
      workspaceRevision: state.recoveryGate.binding.workspaceRevision,
      hypothesisClass: 'logic', targetIdentities: ['src/parser.js'], actionFamily: 'str_replace',
      criterionId: 'npm test', supportingObservationIds: state.recoveryGate.observedKeys.map(recoveryObservationId),
    };
    const changed = await (engine as any).executeOneAction(
      { type: 'str_replace', file_path: 'src/parser.js', old_str: 'return 1', new_str: 'return 2', repair_plan: repairPlan },
      context, {}, { index: 2, ownerGeneration: 0 },
    );
    assert.doesNotMatch(changed.observation, /RECOVERY_PLAN_REQUIRED|RECOVERY_EVIDENCE_REQUIRED/);
    assert.match(readFileSync(file, 'utf8'), /return 2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1 no-target test name needs a bounded glob followed by a corroborating read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-r1-localize-testname-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests', 'parser.test.ts'), 'test("parser handles tokens", () => {})\n');
    execFileSync('git', ['add', 'tests/parser.test.ts'], { cwd: root, windowsHide: true });
    const engine = new ChatEngine({ task: 'repair parser test', projectRoot: root });
    (engine as any).workingState = ingestVerifierResult({
      state: createWorkingState('repair parser test'), tool: 'test_run',
      target: 'npm test -- parser.test.ts', exitCode: 1,
      stdout: 'Tests: 1 failed', stderr: '', summary: 'parser test failed',
      recoveryProjectRoot: root, recoveryBinding: (engine as any).currentRecoveryBinding(),
    }).state;
    const context = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root };
    await (engine as any).executeOneAction(
      { type: 'glob', pattern: '**/*parser*.test.ts' }, context, {}, { index: 0, ownerGeneration: 0 },
    );
    assert.equal((engine as any).workingState.recoveryGate.satisfied, false);
    assert.deepEqual((engine as any).workingState.localization.candidates.map((candidate: { path: string }) => candidate.path), ['tests/parser.test.ts']);
    await (engine as any).executeOneAction(
      { type: 'read_file', path: 'tests/parser.test.ts' }, context, {}, { index: 1, ownerGeneration: 0 },
    );
    assert.equal((engine as any).workingState.localization.phase, 'localized');
    assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R1 exhausted localization blocks another search and reports a typed reason', async () => {
  const engine = new ChatEngine({ task: 'repair parser', projectRoot: process.cwd() });
  const binding = (engine as any).currentRecoveryBinding();
  assert.ok(binding);
  (engine as any).workingState = applyWorkingStateEvent(createWorkingState('repair parser'), {
    type: 'localization_begin',
    localization: { ...startFailureLocalization('red', binding, []), calls: 4, phase: 'exhausted' },
  });
  const result = await (engine as any).executeOneAction(
    { type: 'glob', pattern: '**/*.ts' },
    { agentId: 'test', runId: 'test', runDir: process.cwd(), babelRoot: process.cwd() },
    {}, { index: 0, ownerGeneration: 0 },
  );
  assert.match(result.observation, /LOCALIZATION_EXHAUSTED/);
  const report = (engine as any).buildVerifierBlockedReport('not localized');
  assert.equal(report.reason_code, 'localization_exhausted');
  assert.match(report.checked[0].finding, /4 inspection call/);
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
