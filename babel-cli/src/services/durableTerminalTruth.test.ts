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
import { readDurableTerminalTruth } from './durableTerminalTruth.js';
import { buildRecoveryAssessment } from './recovery.js';
import { buildInspectOutcomeView, loadInspectBundle } from '../inspect/loaders.js';

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
    // The summary's changed-files record is retained for recovery display.
    assert.deepEqual(truth.changed_files, ['src/example.ts']);

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
