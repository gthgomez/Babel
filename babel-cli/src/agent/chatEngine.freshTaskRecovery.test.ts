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
  recordFailure(sig: {
    tool: string;
    commandSnippet?: string;
    exitCode?: number;
    stderr?: string;
    capabilityFailure?: boolean;
  }): { capability: string; state: string; outcome: string };
  snapshot(): { capabilities?: Record<string, unknown> };
  restore(snapshot: unknown): void;
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

// Recovery candidates need a physically captured repository with a committed HEAD.
function commitFixture(root: string): void {
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], {
    cwd: root, windowsHide: true,
  });
}

function redRecoveryState(engine: ChatEngine, projectRoot = process.cwd()) {
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
    recoveryProjectRoot: projectRoot,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL tests failed: parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  }).state;
}

function recoveryInspectionFixture() {
  const storage = mkdtempSync(join(tmpdir(), 'babel-r1-inspection-'));
  const root = join(storage, 'project');
  const runDir = join(storage, 'runtime');
  const target = 'src/agent/codingLoop/workingState.ts';
  mkdirSync(join(root, 'src/agent/codingLoop'), { recursive: true });
  mkdirSync(runDir);
  writeFileSync(join(root, target), readFileSync(new URL('./codingLoop/workingState.ts', import.meta.url)));
  writeFileSync(join(root, 'package.json'), '{"name":"r1-inspection-fixture","private":true}\n');
  writeFileSync(join(root, 'src/agent/unrelated.ts'), 'export const unrelated = true;\n');
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['add', 'package.json', target, 'src/agent/unrelated.ts'], { cwd: root, windowsHide: true });
  commitFixture(root);
  const engine = new ChatEngine({ task: 'repair the parser failure', projectRoot: root });
  const binding = (engine as any).currentRecoveryBinding();
  assert.ok(binding?.workspaceRevision, 'fixture requires a physically captured committed candidate');
  (engine as any).workingState = redRecoveryState(engine, root);
  const context = { agentId: 'test', runId: 'test', runDir, babelRoot: root, projectRoot: root };
  return {
    root, target, engine, context,
    assertUnchanged() {
      assert.equal((engine as any).currentRecoveryBinding()?.workspaceRevision, binding.workspaceRevision,
        'effect-free inspections must retain the captured candidate identity');
    },
    cleanup() { rmSync(storage, { recursive: true, force: true }); },
  };
}

test('R1 production path blocks arbitrary shell mutation before execution', async () => {
  const fixture = recoveryInspectionFixture();
  const { root, engine, context } = fixture;
  const target = join(root, 'must-not-exist.txt');
  try {
    const result = await (engine as any).executeOneAction(
      {
        type: 'run_command',
        command: `node -e "require('fs').writeFileSync('${target.replaceAll('\\', '/')}', 'mutated')"`,
      },
      context,
      {},
      { index: 0, ownerGeneration: 0 },
    );
    assert.match(result.observation, /RECOVERY_EVIDENCE_REQUIRED|RECOVERY_CANDIDATE_DRIFT/);
    assert.equal(existsSync(target), false, 'the shell mutation must not reach the executor');
    fixture.assertUnchanged();
  } finally {
    fixture.cleanup();
  }
});

test('R1 production path retains authorized dependency reads and implicated-file evidence', async () => {
  const fixture = recoveryInspectionFixture();
  const { engine, context, root, target } = fixture;
  try {

    await (engine as any).executeOneAction(
      { type: 'read_file', path: 'package.json' },
      context,
      {},
      { index: 0, ownerGeneration: 0 },
    );
    assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
    assert.equal((engine as any).workingState.recoveryGate.readRecords[0].target, 'package.json');

    await (engine as any).executeOneAction(
      { type: 'read_file', path: target },
      context,
      {},
      { index: 1, ownerGeneration: 0 },
    );
    assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
    assert.match(readFileSync(join(root, target), 'utf8'), /recoveryGate/);
    fixture.assertUnchanged();
  } finally { fixture.cleanup(); }
});

test('R1 production path rejects content-free inspections as recovery evidence', async () => {
  const fixture = recoveryInspectionFixture();
  const { engine, context } = fixture;
  try {

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

    // Search snippets remain hints, even when scoped to an implicated file.
    await (engine as any).executeOneAction(
      { type: 'grep', pattern: 'recoveryGate', path: 'src/agent/codingLoop/workingState.ts' },
      context,
      {},
      { index: index++, ownerGeneration: 0 },
    );
    assert.equal((engine as any).workingState.recoveryGate.satisfied, false);
    fixture.assertUnchanged();
  } finally { fixture.cleanup(); }
});

test('R1 production path does not accept a repeated read as new evidence for the same failure', async () => {
  const fixture = recoveryInspectionFixture();
  const { engine, context, target } = fixture;
  try {

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
    assert.equal((engine as any).workingState.recoveryGate.satisfied, true);
    assert.deepEqual((engine as any).workingState.consumedRecoveryEvidence, state.consumedRecoveryEvidence);
    assert.equal((engine as any).workingState.recoveryGate.observedKeys.length, 1);
    fixture.assertUnchanged();
  } finally { fixture.cleanup(); }
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
    commitFixture(root);
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
    commitFixture(root);
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
      schemaVersion: 2, recoveryGateRef: gate.recoveryGateRef,
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

test('R1 resume restores bound evidence and refuses a newer unbound red verifier', (t) => {
  const fixture = recoveryInspectionFixture();
  t.after(() => fixture.cleanup());
  const { engine } = fixture;
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
      failureSignature: 'parser-red', binding, observationDigest: 'content', window: { startLine: 1, endLine: 1, totalLines: 1, completeFile: true, byteTruncated: false },
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

test('R1 cold resume respects fresh and continued task boundaries without an early snapshot flush', (t) => {
  const fixture = recoveryInspectionFixture();
  t.after(() => fixture.cleanup());
  const { engine } = fixture;
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
      failureSignature: 'red', binding, observationDigest: 'content', window: { startLine: 1, endLine: 1, totalLines: 1, completeFile: true, byteTruncated: false },
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

test('R1 arbitrary interpreter failure is not authoritative verifier evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-r1-unbound-red-'));
  const marker = join(root, 'interpreter-started.txt');
  const envKeys = ['BABEL_BENCHMARK_AUTO_APPROVE', 'BABEL_BENCHMARK_MODE', 'BABEL_AUTONOMY_LEASE', 'BABEL_EXECUTION_PROFILE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_DRY_RUN', 'BABEL_DRY_RUN_SOURCE'] as const;
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    writeFileSync(join(root, 'red.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); process.exit(1)\n`);
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
    process.env['BABEL_BENCHMARK_MODE'] = '1';
    process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
      version: 2, leaseId: 'recovery-non-verifier-red-test',
      scope: { repository: 'fixture', objective: 'ensure arbitrary code is not verifier evidence' },
      allowedCapabilities: ['inspect_repository', 'run_arbitrary_code'],
    });
    process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
    const engine = new ChatEngine({ task: 'repair parser', projectRoot: root });
    process.env['BABEL_DRY_RUN'] = 'false';
    process.env['BABEL_DRY_RUN_SOURCE'] = 'session';
    const state = applyWorkingStateEvent(createWorkingState('repair parser'), {
      type: 'mutation', path: 'src/parser.ts', fingerprint: 'first-edit',
    });
    (engine as any).workingState = state;
    const result = await (engine as any).executeOneAction(
      { type: 'run_command', command: 'node red.cjs' },
      { agentId: 'test', runId: 'test', runDir: root, babelRoot: root },
      {}, { index: 0, ownerGeneration: 0 },
    );
    assert.match(result.observation, /exit_code: 1/);
    assert.doesNotMatch(result.observation, /\[sandbox\] Command rejected/);
    assert.equal(readFileSync(marker, 'utf8'), 'started',
      'the arbitrary interpreter must actually execute before its exit can be classified');
    assert.equal((engine as any).workingState.recoveryGate, undefined,
      'a permitted arbitrary script is not a verifier and cannot create red-test recovery evidence');
    assert.equal((engine as any).workingState.settledFailedVerifier, undefined);
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
    commitFixture(root);
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
    assert.equal(state.recoveryGate.readRecords[0].target, 'src/parser.js');
    assert.equal(state.recoveryGate.satisfied, true);
    const repairPlan = {
      schemaVersion: 2, recoveryGateRef: state.recoveryGate.recoveryGateRef,
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

test('recovery evidence cannot authorize an edit after switching from the project tree to shadow content', async () => {
  const storage = mkdtempSync(join(tmpdir(), 'babel-recovery-shadow-switch-'));
  const root = join(storage, 'project');
  const firstShadow = join(storage, 'shadow-one');
  const secondShadow = join(storage, 'shadow-two');
  const file = 'src/parser.js';
  const baseBytes = 'export function parseToken() { return 1; }\n';
  const overlayBytes = '// overlay-only context changed after the project read\nexport function parseToken() { return 1; }\n';
  const priorShadow = process.env['BABEL_SHADOW_ROOT'];
  const priorDryRun = process.env['BABEL_DRY_RUN'];
  const priorLive = process.env['BABEL_LIVE'];
  const priorDryRunSource = process.env['BABEL_DRY_RUN_SOURCE'];
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(firstShadow, 'src'), { recursive: true });
  mkdirSync(join(secondShadow, 'src'), { recursive: true });
  writeFileSync(join(root, file), baseBytes);
  writeFileSync(join(firstShadow, file), overlayBytes);
  writeFileSync(join(secondShadow, file), overlayBytes);
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['add', file], { cwd: root, windowsHide: true });
  commitFixture(root);
  delete process.env['BABEL_SHADOW_ROOT'];
  process.env['BABEL_DRY_RUN'] = 'true';
  delete process.env['BABEL_LIVE'];
  delete process.env['BABEL_DRY_RUN_SOURCE'];
  try {
    const engine = new ChatEngine({ task: 'repair the parser failure', projectRoot: root });
    const context = { agentId: 'test', runId: 'test', runDir: storage, babelRoot: root, projectRoot: root };
    const binding = (engine as any).currentRecoveryBinding();
    assert.ok(binding, 'the ordinary project tree supports recovery binding');
    (engine as any).workingState = ingestVerifierResult({
      state: createWorkingState('repair the parser failure'),
      recoveryBinding: binding,
      recoveryProjectRoot: root,
      tool: 'test_run',
      target: 'npm test -- parser',
      exitCode: 1,
      stdout: 'FAIL tests failed: parser adds values',
      stderr: '',
      summary: 'same assertion remains red',
    }).state;
    const read = await (engine as any).executeOneAction(
      { type: 'read_file', path: file }, context, {}, { index: 0, ownerGeneration: 0 },
    );
    assert.match(read.observation, /return 1/);
    const gate = (engine as any).workingState.recoveryGate;
    assert.equal(gate.satisfied, true, 'a delivered project-tree read satisfies the bound candidate');
    const plan = {
      schemaVersion: 2, recoveryGateRef: gate.recoveryGateRef,
      workspaceRevision: gate.binding.workspaceRevision,
      hypothesisClass: 'logic', targetIdentities: [file], actionFamily: 'str_replace',
      criterionId: 'npm test -- parser',
      supportingObservationIds: gate.observedKeys.map(recoveryObservationId),
    };

    writeFileSync(join(firstShadow, file), overlayBytes);
    process.env['BABEL_SHADOW_ROOT'] = firstShadow;
    assert.equal((engine as any).currentRecoveryBinding(), null,
      'recovery binding fails closed when reads/writes select a shadow overlay');
    process.env['BABEL_SHADOW_ROOT'] = secondShadow;
    assert.equal((engine as any).currentRecoveryBinding(), null,
      'a second overlay root cannot reuse project-tree recovery evidence');
    const changed = await (engine as any).executeOneAction(
      { type: 'str_replace', file_path: file, old_str: 'return 1', new_str: 'return 2', repair_plan: plan },
      context, {}, { index: 1, ownerGeneration: 0 },
    );
    assert.match(changed.observation, /RECOVERY_SHADOW_CONTEXT_UNSUPPORTED/);
    assert.match(changed.observation, /reads and writes use the shadow overlay.*verifier commands execute against the project workspace/);
    assert.equal(readFileSync(join(secondShadow, file), 'utf8'), overlayBytes,
      'the stale plan cannot overwrite content in the newly selected shadow candidate');
    assert.equal(readFileSync(join(root, file), 'utf8'), baseBytes,
      'the configured shadow write does not escape into the project workspace');
    assert.equal(readFileSync(join(firstShadow, file), 'utf8'), overlayBytes,
      'the write does not escape into the previous overlay');
    const report = (engine as any).buildVerifierBlockedReport('verification remains incomplete');
    assert.match(report.missing, /shadow overlay.*verifier commands execute against the project workspace/,
      'terminal guidance explains why recovery stopped instead of asking for an impossible reread');
  } finally {
    if (priorShadow === undefined) delete process.env['BABEL_SHADOW_ROOT'];
    else process.env['BABEL_SHADOW_ROOT'] = priorShadow;
    if (priorDryRun === undefined) delete process.env['BABEL_DRY_RUN'];
    else process.env['BABEL_DRY_RUN'] = priorDryRun;
    if (priorLive === undefined) delete process.env['BABEL_LIVE'];
    else process.env['BABEL_LIVE'] = priorLive;
    if (priorDryRunSource === undefined) delete process.env['BABEL_DRY_RUN_SOURCE'];
    else process.env['BABEL_DRY_RUN_SOURCE'] = priorDryRunSource;
    rmSync(storage, { recursive: true, force: true });
  }
});

test('PR242: proven old_str mismatch permits one fresh corrected repair through the native executor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-pr242-no-effect-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    mkdirSync(join(root, 'src'));
    const file = join(root, 'src', 'parser.js');
    writeFileSync(file, 'export function parseToken() {\n  return 1\n}\n');
    execFileSync('git', ['add', 'src/parser.js'], { cwd: root, windowsHide: true });
    commitFixture(root);
    const engine = new ChatEngine({ task: 'repair parser', projectRoot: root });
    const context = { agentId: 'test', runId: 'test', runDir: root, babelRoot: root };
    (engine as any).workingState = ingestVerifierResult({
      state: createWorkingState('repair parser'), tool: 'test_run', target: 'npm test', exitCode: 1,
      stdout: '', stderr: 'TypeError: bad\n    at parseToken (src/parser.js:2:3)',
      summary: 'parser failed', recoveryProjectRoot: root,
      recoveryBinding: (engine as any).currentRecoveryBinding(),
    }).state;
    await (engine as any).executeOneAction(
      { type: 'read_file', path: 'src/parser.js' }, context, {}, { index: 0, ownerGeneration: 0 },
    );
    const plan = () => {
      const gate = (engine as any).workingState.recoveryGate;
      return {
        schemaVersion: 2, recoveryGateRef: gate.recoveryGateRef,
        workspaceRevision: gate.binding.workspaceRevision,
        hypothesisClass: 'logic', targetIdentities: ['src/parser.js'],
        actionFamily: 'str_replace', criterionId: 'npm test',
        supportingObservationIds: gate.observedKeys.map(recoveryObservationId),
      };
    };
    const mismatch = await (engine as any).executeOneAction(
      { type: 'str_replace', file_path: 'src/parser.js',
        old_str: 'return 42', new_str: 'return 2', repair_plan: plan() },
      context, {}, { index: 1, ownerGeneration: 0 },
    );
    assert.equal(readFileSync(file, 'utf8'), 'export function parseToken() {\n  return 1\n}\n');
    assert.match(mismatch.observation, /not found|No match|old_str/i);
    assert.equal((engine as any).workingState.recoveryGate.noEffectReplans, 1,
      `${mismatch.observation}\n${JSON.stringify((engine as any).workingState.recoveryGate)}`);
    assert.equal((engine as any).workingState.recoveryGate.permitConsumed, false);
    const corrected = await (engine as any).executeOneAction(
      { type: 'str_replace', file_path: 'src/parser.js',
        old_str: 'return 1', new_str: 'return 2', repair_plan: plan() },
      context, {}, { index: 2, ownerGeneration: 0 },
    );
    assert.doesNotMatch(corrected.observation, /RECOVERY_PLAN_REQUIRED|RECOVERY_EVIDENCE_REQUIRED/);
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
    commitFixture(root);
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

test('R1 legacy exhausted localization resumes governed inspection with counters retained', async () => {
  const fixture = recoveryInspectionFixture();
  const { engine, context } = fixture;
  const binding = (engine as any).currentRecoveryBinding();
  assert.ok(binding);
  (engine as any).workingState = applyWorkingStateEvent(createWorkingState('repair parser'), {
    type: 'localization_begin',
    localization: { ...startFailureLocalization('red', binding, []), calls: 4, phase: 'exhausted' },
  });
  try {
  const result = await (engine as any).executeOneAction(
    { type: 'glob', pattern: '**/*.ts' },
    context,
    {}, { index: 0, ownerGeneration: 0 },
  );
  assert.doesNotMatch(result.observation, /LOCALIZATION_EXHAUSTED/);
  assert.equal((engine as any).workingState.localization.calls, 5);
  const report = (engine as any).buildVerifierBlockedReport('not localized');
  assert.notEqual(report.reason_code, 'localization_exhausted');
  assert.ok(report.checked.length > 0);
  } finally {
    fixture.cleanup();
  }
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

test('#216 capability health survives a task boundary and is not blanked', () => {
  const engine = new ChatEngine({ task: 'Find all files in repo', projectRoot: '/tmp' });
  const controller = progress(engine);

  // Only a genuine capability failure degrades the family. An isolation or
  // permission denial is recorded but must NOT degrade it, so this fixture
  // drives the capability outcome directly rather than depending on a
  // sandbox-denied shell command.
  controller.recordFailure({ tool: 'run_command', commandSnippet: 'Get-ChildItem -Recurse', exitCode: 1, capabilityFailure: true });
  controller.recordFailure({ tool: 'run_command', commandSnippet: 'Get-ChildItem -Recurse', exitCode: 1, capabilityFailure: true });
  assert.equal(
    controller.getCapabilityState('shell.recursive_enumeration'),
    'DEGRADED',
    'fixture precondition: recursive enumeration degrades after two genuine failures',
  );

  engine.applyUserSubmission({ userInput: 'B: list the project tree' });

  assert.equal(
    controller.getCapabilityState('shell.recursive_enumeration'),
    'DEGRADED',
    'environment/provider capability health deliberately survives a task boundary and must not be blanked',
  );
});
