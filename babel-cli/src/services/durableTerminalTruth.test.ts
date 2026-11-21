/** RT-10 / UX-09 — one durable terminal classification for recovery/inspect. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSessionEventLog,
  recordTurnEnded,
  recordUserSubmitted,
  rewriteSessionEventLog,
} from '../agent/sessionEvents.js';
import {
  createThreadEventLog,
  endTurn,
  persistThreadEventLog,
  startTurn,
} from '../agent/threadEventLog.js';
import { readDurableTerminalTruth } from './durableTerminalTruth.js';
import { buildRecoveryAssessment } from './recovery.js';
import {
  buildInspectManifestView,
  buildInspectOutcomeView,
  buildInspectRunView,
  loadInspectBundle,
} from '../inspect/loaders.js';

function startFixtureTurn(
  log: ReturnType<typeof createThreadEventLog>,
  task: string,
  root: string,
): string {
  return startTurn(log, {
    task,
    model: 'fixture-model',
    provider: 'fixture-provider',
    projectRoot: root,
    policyPreset: 'workspace_write',
  });
}

function submitSessionTurn(
  log: ReturnType<typeof createSessionEventLog>,
  turnId: string,
  task: string,
  root: string,
): void {
  recordUserSubmitted(log, {
    turn_id: turnId,
    task,
    model: 'fixture-model',
    provider: 'fixture-provider',
    projectRoot: root,
  });
}

function terminalRun(
  root: string,
  name: string,
  outcome: 'VERIFIED_COMPLETE' | 'UNVERIFIED_PATCH' | 'AGENT_FAILURE',
  status: string,
): string {
  const runDir = join(root, name);
  mkdirSync(runDir, { recursive: true });
  const log = createSessionEventLog(name);
  recordUserSubmitted(log, {
    turn_id: 'turn-1',
    task: 'frozen task',
    model: 'fixture-model',
    provider: 'fixture-provider',
    projectRoot: root,
  });
  recordTurnEnded(log, { turn_id: 'turn-1', outcome, status });
  rewriteSessionEventLog(runDir, log);
  return runDir;
}

test('RT-10: a stored verified terminal projects success across recovery and inspect', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-terminal-'));
  try {
    const runDir = terminalRun(root, 'verified-run', 'VERIFIED_COMPLETE', 'completed');
    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.source, 'session_events');
    assert.equal(truth.outcome, 'VERIFIED_COMPLETE');
    assert.equal(truth.user_status, 'success');
    assert.equal(truth.exit_code, 0);
    assert.equal(truth.success, true);

    const recovery = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.equal(recovery.classification, null);
    assert.equal(recovery.terminal_outcome, 'VERIFIED_COMPLETE');
    assert.equal(recovery.user_status, 'success');
    assert.equal(recovery.exit_code, 0);

    const inspect = buildInspectOutcomeView(loadInspectBundle(runDir));
    assert.equal(inspect.runOutcome.status, 'success');
    assert.equal(inspect.runOutcome.terminal_outcome, 'VERIFIED_COMPLETE');
    assert.equal(inspect.runOutcome.user_status, 'success');
    assert.equal(inspect.runOutcome.needs_human_review, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RT-10: UNVERIFIED_PATCH is not reported as a successful completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-unverified-'));
  try {
    const runDir = terminalRun(root, 'unverified-run', 'UNVERIFIED_PATCH', 'completed');
    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.user_status, 'not_verified');
    assert.equal(truth.exit_code, 6);
    assert.equal(truth.success, false);

    const recovery = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.equal(recovery.classification, null);
    assert.equal(recovery.retryable, false);
    assert.match(recovery.reason, /without authoritative verification/i);
    assert.equal(recovery.user_status, 'not_verified');
    assert.equal(recovery.terminal_outcome, 'UNVERIFIED_PATCH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RT-10: a failed durable terminal keeps its failure classification', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-failed-'));
  try {
    const runDir = terminalRun(root, 'failed-run', 'AGENT_FAILURE', 'failed');
    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.user_status, 'failed');
    assert.equal(truth.exit_code, 1);
    const recovery = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.notEqual(recovery.user_status, 'success');
    assert.equal(recovery.terminal_outcome, 'AGENT_FAILURE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale success summary loses to a later turn_ended failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-disagreement-'));
  try {
    const runDir = terminalRun(root, 'stale-success-summary', 'AGENT_FAILURE', 'failed');
    // The stale summary claims verified success; the durable event log's last
    // turn_ended records AGENT_FAILURE. The summary must not win wholesale.
    writeFileSync(
      join(runDir, 'terminal_status_summary.json'),
      `${JSON.stringify({
        schema_version: 1,
        artifact_type: 'babel_terminal_status_summary',
        status: 'COMPLETE',
        terminal_outcome: 'VERIFIED_COMPLETE',
        changed_files: ['src/example.ts'],
      })}\n`,
    );
    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.source, 'session_events');
    assert.equal(truth.outcome, 'AGENT_FAILURE');
    assert.equal(truth.status, 'failed');
    assert.equal(truth.user_status, 'failed');
    assert.equal(truth.success, false);
    assert.equal(truth.exit_code, 1);
    assert.equal(truth.disagreement, true);
    // An unbound summary from a different turn must not graft its paths onto
    // the current failure.
    assert.deepEqual(truth.changed_files, []);

    const recovery = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.equal(recovery.terminal_outcome, 'AGENT_FAILURE');
    assert.equal(recovery.user_status, 'failed');
    assert.equal(recovery.exit_code, 1);
    const inspect = buildInspectOutcomeView(loadInspectBundle(runDir));
    assert.equal(inspect.runOutcome.status, 'failed');
    assert.equal(inspect.runOutcome.terminal_outcome, 'AGENT_FAILURE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an agreeing success summary keeps the summary source without disagreement', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-agreeing-'));
  try {
    const runDir = terminalRun(root, 'agreeing-run', 'VERIFIED_COMPLETE', 'completed');
    writeFileSync(
      join(runDir, 'terminal_status_summary.json'),
      `${JSON.stringify({
        schema_version: 1,
        artifact_type: 'babel_terminal_status_summary',
        status: 'COMPLETE',
        terminal_outcome: 'VERIFIED_COMPLETE',
        changed_files: [],
      })}\n`,
    );
    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.source, 'terminal_status_summary');
    assert.equal(truth.outcome, 'VERIFIED_COMPLETE');
    assert.equal(truth.success, true);
    assert.equal(truth.exit_code, 0);
    assert.equal(truth.disagreement, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('UX-09: project-scoped recovery never falls back to another project run', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-scope-'));
  try {
    const other = terminalRun(root, 'other-project-run', 'VERIFIED_COMPLETE', 'completed');
    writeFileSync(
      join(root, '.latest.json'),
      `${JSON.stringify({ run_dir: other, project: 'other-project' })}\n`,
    );
    const scoped = buildRecoveryAssessment({ run: 'latest', project: 'my-project', runsDir: root });
    assert.equal(scoped.status, 'NO_LATEST_RUN');
    assert.equal(scoped.run_dir, null);

    const mine = terminalRun(root, 'my-project-run', 'VERIFIED_COMPLETE', 'completed');
    writeFileSync(
      join(root, '.latest.my-project.json'),
      `${JSON.stringify({ run_dir: mine, project: 'my-project' })}\n`,
    );
    const resolved = buildRecoveryAssessment({ run: 'latest', project: 'my-project', runsDir: root });
    assert.equal(resolved.run_dir, mine);
    assert.equal(resolved.user_status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('UX-09: recovery advice uses a supported inspect-only command pinned to the run', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-command-'));
  try {
    const runDir = join(root, 'verifier-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'terminal_status_summary.json'),
      `${JSON.stringify({
        schema_version: 1,
        artifact_type: 'babel_terminal_status_summary',
        status: 'VERIFIER_FAILED',
        reason_category: 'verifier_failure',
        failed_command: 'npm test',
        changed_files: ['src/example.ts'],
        failure_capsule_path: null,
        condition_summary: 'npm test failed',
      })}\n`,
    );
    const assessment = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.equal(assessment.classification, 'rerun_verifier');
    assert.ok(assessment.next_command);
    assert.match(assessment.next_command, /^babel continue ".*verifier-run" --inspect-only$/);
    assert.doesNotMatch(assessment.next_command, /\blatest\b/);
    assert.doesNotMatch(assessment.next_command, /^babel resume/);
    assert.ok(assessment.next_command.includes(runDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BL-14: an admitted unfinished turn outranks an earlier success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-unfinished-'));
  try {
    const runDir = join(root, 'two-turn-run');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-two-turn');
    const session = createSessionEventLog('session-two-turn');

    const first = startFixtureTurn(thread, 'first task', root);
    endTurn(thread, first, 'VERIFIED_COMPLETE', 'completed');
    submitSessionTurn(session, first, 'first task', root);
    recordTurnEnded(session, {
      turn_id: first,
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });

    const second = startFixtureTurn(thread, 'second task', root);
    submitSessionTurn(session, second, 'second task', root);

    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.turn_id, second);
    assert.equal(truth.turn_state, 'active');
    assert.equal(truth.finished, false);
    assert.equal(truth.outcome, null);
    assert.equal(truth.success, false);
    assert.notEqual(truth.user_status, 'success');

    const recovery = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.notEqual(recovery.user_status, 'success');
    assert.equal(recovery.terminal_outcome, null);
    assert.equal(recovery.exit_code, null);
    assert.equal(recovery.classification, 'requires_user_decision');
    assert.equal(recovery.retryable, false);

    const inspect = buildInspectOutcomeView(loadInspectBundle(runDir));
    assert.notEqual(inspect.runOutcome.status, 'success');
    assert.equal(inspect.runOutcome.terminal_outcome, undefined);
    assert.equal(inspect.runOutcome.needs_human_review, true);

    // Sibling inspection views must not keep advertising the older success.
    const bundle = loadInspectBundle(runDir);
    assert.equal(buildInspectRunView(bundle).finalStatus, 'INTERRUPTED');
    assert.equal(buildInspectManifestView(bundle).finalStatus, 'INTERRUPTED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BL-14: a stale success summary and telemetry cannot close a newer unfinished turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-stale-newer-'));
  try {
    const runDir = join(root, 'stale-newer-run');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-stale-newer');
    const session = createSessionEventLog('session-stale-newer');

    const first = startFixtureTurn(thread, 'first task', root);
    endTurn(thread, first, 'VERIFIED_COMPLETE', 'completed');
    submitSessionTurn(session, first, 'first task', root);
    recordTurnEnded(session, {
      turn_id: first,
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });
    const second = startFixtureTurn(thread, 'second task', root);
    submitSessionTurn(session, second, 'second task', root);
    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);

    writeFileSync(
      join(runDir, 'terminal_status_summary.json'),
      `${JSON.stringify({
        schema_version: 1,
        artifact_type: 'babel_terminal_status_summary',
        status: 'COMPLETE',
        terminal_outcome: 'VERIFIED_COMPLETE',
        changed_files: ['src/old.ts'],
      })}\n`,
    );
    writeFileSync(
      join(runDir, '06_runtime_telemetry.json'),
      `${JSON.stringify({ pipeline_mode: 'chat', final_outcome: 'COMPLETE' })}\n`,
    );

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.finished, false);
    assert.equal(truth.outcome, null);
    assert.equal(truth.success, false);
    assert.deepEqual(truth.changed_files, []);

    const recovery = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.notEqual(recovery.user_status, 'success');
    assert.equal(recovery.terminal_outcome, null);
    assert.equal(recovery.exit_code, null);

    const inspect = buildInspectOutcomeView(loadInspectBundle(runDir));
    assert.notEqual(inspect.runOutcome.status, 'success');
    assert.notEqual(inspect.runOutcome.terminal_outcome, 'VERIFIED_COMPLETE');
    assert.equal(inspect.runOutcome.needs_human_review, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BL-14: a newer thread-journal failure wins over an older session success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-divergent-'));
  try {
    const runDir = join(root, 'divergent-run');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-divergent');
    const session = createSessionEventLog('session-divergent');

    const first = startFixtureTurn(thread, 'first task', root);
    endTurn(thread, first, 'VERIFIED_COMPLETE', 'completed');
    submitSessionTurn(session, first, 'first task', root);
    recordTurnEnded(session, {
      turn_id: first,
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });
    const second = startFixtureTurn(thread, 'second task', root);
    endTurn(thread, second, 'AGENT_FAILURE', 'failed');
    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.turn_id, second);
    assert.equal(truth.outcome, 'AGENT_FAILURE');
    assert.equal(truth.user_status, 'failed');
    assert.equal(truth.success, false);
    assert.equal(truth.disagreement, false);

    const recovery = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.equal(recovery.terminal_outcome, 'AGENT_FAILURE');
    assert.equal(recovery.user_status, 'failed');

    const inspect = buildInspectOutcomeView(loadInspectBundle(runDir));
    assert.equal(inspect.runOutcome.terminal_outcome, 'AGENT_FAILURE');
    assert.notEqual(inspect.runOutcome.status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BL-14: a corrupt thread journal cannot leave a session success standing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-corrupt-'));
  try {
    const runDir = join(root, 'corrupt-run');
    mkdirSync(runDir, { recursive: true });
    const session = createSessionEventLog('session-corrupt');
    recordUserSubmitted(session, {
      turn_id: 'turn-1',
      task: 'task',
      model: 'fixture-model',
      provider: 'fixture-provider',
      projectRoot: root,
    });
    recordTurnEnded(session, {
      turn_id: 'turn-1',
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });
    rewriteSessionEventLog(runDir, session);
    writeFileSync(join(runDir, 'thread_events.json'), '{"schema_version":1');

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.corrupt, true);
    assert.deepEqual(truth.corrupt_sources, ['thread_events']);
    assert.equal(truth.success, false);
    assert.notEqual(truth.user_status, 'success');
    assert.equal(truth.finished, false);

    const recovery = buildRecoveryAssessment({ run: runDir, runsDir: root });
    assert.notEqual(recovery.user_status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BL-14: a newer submission that was never admitted is not a success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-submitted-'));
  try {
    const runDir = join(root, 'submitted-run');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-submitted');
    const session = createSessionEventLog('session-submitted');

    const first = startFixtureTurn(thread, 'first task', root);
    endTurn(thread, first, 'VERIFIED_COMPLETE', 'completed');
    submitSessionTurn(session, first, 'first task', root);
    recordTurnEnded(session, {
      turn_id: first,
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });
    submitSessionTurn(session, 'turn-never-admitted', 'second task', root);
    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.turn_id, 'turn-never-admitted');
    assert.equal(truth.turn_state, 'submitted');
    assert.equal(truth.finished, false);
    assert.equal(truth.success, false);
    assert.notEqual(truth.user_status, 'success');
    assert.equal(truth.disagreement, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unbound non-success summary still downgrades a journal success', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-summary-downgrade-'));
  try {
    const runDir = terminalRun(root, 'summary-downgrade', 'VERIFIED_COMPLETE', 'completed');
    writeFileSync(
      join(runDir, 'terminal_status_summary.json'),
      `${JSON.stringify({
        schema_version: 1,
        artifact_type: 'babel_terminal_status_summary',
        status: 'UNVERIFIED_PATCH',
        reason_category: 'verifier_failure',
        changed_files: ['src/old.ts'],
      })}\n`,
    );

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.success, false);
    assert.equal(truth.outcome, 'UNVERIFIED_PATCH');
    assert.equal(truth.user_status, 'not_verified');
    assert.notEqual(truth.exit_code, 0);
    assert.equal(truth.disagreement, true);
    assert.deepEqual(truth.changed_files, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a classifiable non-success wins over an unclassifiable terminal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-classifiable-'));
  try {
    const runDir = join(root, 'classifiable-non-success');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-classifiable');
    const turnId = startFixtureTurn(thread, 'frozen task', root);
    endTurn(thread, turnId, undefined, 'MADE_UP_TERMINAL');
    await persistThreadEventLog(runDir, thread);

    const session = createSessionEventLog('session-classifiable');
    submitSessionTurn(session, turnId, 'frozen task', root);
    recordTurnEnded(session, { turn_id: turnId, outcome: 'AGENT_FAILURE', status: 'failed' });
    rewriteSessionEventLog(runDir, session);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.disagreement, true);
    assert.equal(truth.outcome, 'AGENT_FAILURE');
    assert.equal(truth.success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a legacy summary-only success is preserved', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-legacy-'));
  try {
    const runDir = join(root, 'legacy-run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'terminal_status_summary.json'),
      `${JSON.stringify({
        schema_version: 1,
        artifact_type: 'babel_terminal_status_summary',
        status: 'COMPLETE',
        terminal_outcome: 'VERIFIED_COMPLETE',
        changed_files: [],
      })}\n`,
    );
    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.turn_state, 'none');
    assert.equal(truth.source, 'terminal_status_summary');
    assert.equal(truth.outcome, 'VERIFIED_COMPLETE');
    assert.equal(truth.success, true);
    assert.equal(truth.finished, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BL-14: the newest of two settled successes remains success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-settled-'));
  try {
    const runDir = join(root, 'settled-run');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-settled');
    const session = createSessionEventLog('session-settled');
    const first = startFixtureTurn(thread, 'first task', root);
    endTurn(thread, first, 'VERIFIED_COMPLETE', 'completed');
    submitSessionTurn(session, first, 'first task', root);
    recordTurnEnded(session, {
      turn_id: first,
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });
    const second = startFixtureTurn(thread, 'second task', root);
    endTurn(thread, second, 'NO_CHANGE_REQUIRED', 'completed_no_modification');
    submitSessionTurn(session, second, 'second task', root);
    recordTurnEnded(session, {
      turn_id: second,
      outcome: 'NO_CHANGE_REQUIRED',
      status: 'completed_no_modification',
    });
    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.turn_id, second);
    assert.equal(truth.turn_state, 'terminal');
    assert.equal(truth.outcome, 'NO_CHANGE_REQUIRED');
    assert.equal(truth.success, true);
    assert.equal(truth.finished, true);
    assert.equal(truth.disagreement, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BL-14: cancellation on the newest turn keeps its failure mapping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-cancelled-'));
  try {
    const runDir = join(root, 'cancelled-run');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-cancelled');
    const session = createSessionEventLog('session-cancelled');
    const first = startFixtureTurn(thread, 'first task', root);
    endTurn(thread, first, 'VERIFIED_COMPLETE', 'completed');
    submitSessionTurn(session, first, 'first task', root);
    recordTurnEnded(session, {
      turn_id: first,
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });
    const second = startFixtureTurn(thread, 'second task', root);
    endTurn(thread, second, 'CANCELLED', 'cancelled');
    submitSessionTurn(session, second, 'second task', root);
    recordTurnEnded(session, {
      turn_id: second,
      outcome: 'CANCELLED',
      status: 'cancelled',
    });
    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.turn_id, second);
    assert.equal(truth.outcome, 'CANCELLED');
    assert.equal(truth.user_status, 'failed');
    assert.equal(truth.success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a same-turn journal disagreement cannot yield success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-same-turn-'));
  try {
    const runDir = join(root, 'same-turn-disagreement');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-same-turn');
    const turnId = startFixtureTurn(thread, 'frozen task', root);
    endTurn(thread, turnId, 'VERIFIED_COMPLETE', 'completed');
    await persistThreadEventLog(runDir, thread);

    const session = createSessionEventLog('session-same-turn');
    submitSessionTurn(session, turnId, 'frozen task', root);
    recordTurnEnded(session, { turn_id: turnId, outcome: 'AGENT_FAILURE', status: 'failed' });
    rewriteSessionEventLog(runDir, session);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.disagreement, true);
    assert.equal(truth.outcome, 'AGENT_FAILURE');
    assert.equal(truth.success, false);
    assert.notEqual(truth.user_status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unclassifiable same-turn terminal cannot restore success from the other journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-unclassifiable-'));
  try {
    const runDir = join(root, 'unclassifiable-terminal');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-unclassifiable');
    const turnId = startFixtureTurn(thread, 'frozen task', root);
    endTurn(thread, turnId, 'VERIFIED_COMPLETE', 'completed');
    await persistThreadEventLog(runDir, thread);

    const session = createSessionEventLog('session-unclassifiable');
    submitSessionTurn(session, turnId, 'frozen task', root);
    recordTurnEnded(session, { turn_id: turnId, status: 'MADE_UP_TERMINAL' });
    rewriteSessionEventLog(runDir, session);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.disagreement, true);
    assert.equal(truth.finished, true);
    assert.equal(truth.outcome, null);
    assert.equal(truth.success, false);
    assert.equal(truth.user_status, 'not_verified');
    assert.notEqual(truth.exit_code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unclassifiable thread terminal wins over a session success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-durable-unclassifiable-thread-'));
  try {
    const runDir = join(root, 'unclassifiable-thread');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread-unclassifiable-thread');
    const turnId = startFixtureTurn(thread, 'frozen task', root);
    endTurn(thread, turnId, undefined, 'MADE_UP_TERMINAL');
    await persistThreadEventLog(runDir, thread);

    const session = createSessionEventLog('session-unclassifiable-thread');
    submitSessionTurn(session, turnId, 'frozen task', root);
    recordTurnEnded(session, { turn_id: turnId, outcome: 'VERIFIED_COMPLETE', status: 'completed' });
    rewriteSessionEventLog(runDir, session);

    const truth = readDurableTerminalTruth(runDir);
    assert.equal(truth.disagreement, true);
    assert.equal(truth.success, false);
    assert.notEqual(truth.user_status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery advice only uses execution and failure evidence for the latest turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-turn-recovery-'));
  try {
    const thread = createThreadEventLog('thread-recovery-evidence');
    const older = startFixtureTurn(thread, 'older task', root);
    endTurn(thread, older, 'BLOCKED_POLICY', 'failed');
    const current = startFixtureTurn(thread, 'current task', root);
    endTurn(thread, current, 'AGENT_FAILURE', 'failed');
    await persistThreadEventLog(root, thread);

    const writeEvidence = (turnId: string): void => {
      writeFileSync(join(root, 'terminal_status_summary.json'), JSON.stringify({
        turn_id: turnId, status: 'FAILED', failed_command: 'npm test',
      }));
      writeFileSync(join(root, '04_execution_report.json'), JSON.stringify({
        turn_id: turnId, status: 'EXECUTION_HALTED', reason: 'APPROVAL_REQUIRED',
      }));
      writeFileSync(join(root, '12_pre_execution_failure_capsule.json'), JSON.stringify({
        capsule: { turn_id: turnId, failure_code: 'APPROVAL_REQUIRED' },
      }));
    };

    writeEvidence(older);
    const stale = buildRecoveryAssessment({ run: root });
    assert.equal(stale.terminal_outcome, 'AGENT_FAILURE');
    assert.equal(stale.execution_report, null);
    assert.equal(stale.failed_command, null);
    assert.equal(stale.failure_capsule, null);
    assert.notEqual(stale.classification, 'requires_user_decision');

    writeEvidence(current);
    const bound = buildRecoveryAssessment({ run: root });
    assert.equal(bound.execution_report?.['turn_id'], current);
    assert.equal(bound.failed_command, 'npm test');
    assert.equal(bound.failure_code, 'APPROVAL_REQUIRED');
    assert.equal(bound.classification, 'requires_user_decision');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a newer failure in a disjoint session journal supersedes thread-only success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-turn-split-'));
  try {
    const thread = createThreadEventLog('thread-split');
    const older = startFixtureTurn(thread, 'older task', root);
    endTurn(thread, older, 'VERIFIED_COMPLETE', 'completed');
    for (const event of thread.events) event.ts = '2026-01-01T00:00:00Z';
    await persistThreadEventLog(root, thread);
    assert.equal(readDurableTerminalTruth(root).success, true);

    const session = createSessionEventLog('session-split');
    submitSessionTurn(session, 'newer-turn', 'newer task', root);
    recordTurnEnded(session, { turn_id: 'newer-turn', outcome: 'AGENT_FAILURE', status: 'failed' });
    for (const event of session.events) event.ts = '2026-01-01T00:00:01Z';
    rewriteSessionEventLog(root, session);
    const truth = readDurableTerminalTruth(root);
    assert.equal(truth.turn_id, 'newer-turn');
    assert.equal(truth.outcome, 'AGENT_FAILURE');
    assert.equal(truth.success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a summary bound to a different turn cannot replace current success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-turn-bound-summary-'));
  try {
    const thread = createThreadEventLog('thread-bound-summary');
    const older = startFixtureTurn(thread, 'older task', root);
    endTurn(thread, older, 'AGENT_FAILURE', 'failed');
    const current = startFixtureTurn(thread, 'current task', root);
    endTurn(thread, current, 'VERIFIED_COMPLETE', 'completed');
    await persistThreadEventLog(root, thread);
    writeFileSync(join(root, 'terminal_status_summary.json'), JSON.stringify({
      turn_id: older, terminal_outcome: 'AGENT_FAILURE', status: 'FAILED',
    }));
    const truth = readDurableTerminalTruth(root);
    assert.equal(truth.turn_id, current);
    assert.equal(truth.outcome, 'VERIFIED_COMPLETE');
    assert.equal(truth.success, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
