import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSessionEventLog,
  inspectSessionEventLogFromDir,
  recordTurnEnded,
  recordUserSubmitted,
  rewriteSessionEventLog,
} from '../agent/sessionEvents.js';
import {
  createThreadEventLog,
  endTurn,
  loadThreadEventLogFromDir,
  persistThreadEventLog,
  startTurn,
} from '../agent/threadEventLog.js';
import { readSessionSummary } from './coreInspectionCommands.js';
import { buildRecoveryAssessment, buildRunFailureRecoveryPayload, resolveRecoveryRunDir } from '../services/recovery.js';
import { resolveInspectRunDir } from '../inspect/loaders.js';

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

function submit(
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

test('BL-14: session latest reports the newest turn status and outcome consistently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-latest-'));
  try {
    const runDir = join(root, 'run');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('thread');
    const session = createSessionEventLog('session');

    const first = startFixtureTurn(thread, 'first task', root);
    endTurn(thread, first, 'VERIFIED_COMPLETE', 'completed');
    submit(session, first, 'first task', root);
    recordTurnEnded(session, {
      turn_id: first,
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });

    const second = startFixtureTurn(thread, 'second task', root);
    endTurn(thread, second, 'AGENT_FAILURE', 'failed');
    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);

    // Telemetry from the earlier success must not describe the newer turn.
    writeFileSync(
      join(runDir, '06_runtime_telemetry.json'),
      `${JSON.stringify({ pipeline_mode: 'chat', final_outcome: 'COMPLETE' })}\n`,
    );

    const summary = readSessionSummary(runDir);
    assert.equal(summary.terminal_outcome, 'AGENT_FAILURE');
    assert.equal(summary.status, 'failed');
    assert.equal(summary.user_status, 'failed');
    assert.notEqual(summary.status, 'COMPLETE');
    assert.notEqual(summary.status, 'VERIFIED_COMPLETE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BL-14: session latest surfaces an unfinished turn as INTERRUPTED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-unfinished-'));
  try {
    const runDir = join(root, 'chat-sessions', 'chat-interrupted');
    mkdirSync(runDir, { recursive: true });
    const thread = createThreadEventLog('chat-interrupted');
    const session = createSessionEventLog('chat-interrupted');

    const first = startFixtureTurn(thread, 'first task', root);
    endTurn(thread, first, 'VERIFIED_COMPLETE', 'completed');
    submit(session, first, 'first task', root);
    recordTurnEnded(session, {
      turn_id: first,
      outcome: 'VERIFIED_COMPLETE',
      status: 'completed',
    });
    const second = startFixtureTurn(thread, 'second task', root);
    submit(session, second, 'second task', root);
    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);
    writeFileSync(
      join(runDir, '06_runtime_telemetry.json'),
      `${JSON.stringify({ pipeline_mode: 'chat', final_outcome: 'COMPLETE' })}\n`,
    );

    assert.equal(resolveRecoveryRunDir('latest', { runsDir: root }), runDir);
    assert.equal(resolveInspectRunDir({ run: 'latest', babelRunsDir: root }), runDir);
    const assessment = buildRecoveryAssessment({ run: 'latest', runsDir: root });
    assert.equal(assessment.run_dir, runDir);
    assert.equal(assessment.user_status, 'not_verified');
    assert.equal(assessment.terminal_outcome, null);

    // An older finalized pipeline run and a newer directory with no journal
    // cannot displace the latest durable Chat turn.
    const pipelineRun = join(root, 'pipeline-run');
    mkdirSync(pipelineRun);
    const emptyChat = join(root, 'chat-sessions', 'chat-without-turn');
    mkdirSync(emptyChat);
    await persistThreadEventLog(emptyChat, createThreadEventLog('chat-without-turn'));
    const pointer = join(root, '.latest.json');
    const writePointer = (createdAt: string): void => {
      writeFileSync(pointer, JSON.stringify({ run_dir: pipelineRun, project: 'pipeline', created_at: createdAt }));
    };
    const older = new Date('2026-01-01T00:00:00.000Z');
    const journalActivity = new Date('2026-01-01T00:00:01.000Z');
    const newer = new Date('2026-01-01T00:00:02.000Z');
    for (const name of ['session-events.jsonl', 'thread_events.json']) {
      utimesSync(join(runDir, name), journalActivity, journalActivity);
    }
    writePointer(older.toISOString());
    assert.equal(resolveRecoveryRunDir('latest', { runsDir: root }), runDir);
    assert.equal(buildRunFailureRecoveryPayload({ runsDir: root }).assessment.run_dir, pipelineRun);
    assert.equal(resolveRecoveryRunDir('latest', { runsDir: root, project: 'pipeline' }), pipelineRun);
    assert.equal(resolveRecoveryRunDir('latest', { runsDir: root, project: 'elsewhere' }), null);
    writePointer(journalActivity.toISOString());
    assert.equal(resolveRecoveryRunDir('latest', { runsDir: root }), runDir);
    writePointer(newer.toISOString());
    assert.equal(resolveRecoveryRunDir('latest', { runsDir: root }), pipelineRun);

    const summary = readSessionSummary(runDir);
    assert.equal(summary.status, 'INTERRUPTED');
    assert.equal(summary.terminal_outcome, null);
    assert.equal(summary.exit_code, null);
    assert.notEqual(summary.user_status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy latest lookup agrees across surfaces and ignores structural directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-legacy-'));
  try {
    mkdirSync(join(root, 'chat-sessions'));
    mkdirSync(join(root, 'threads'));
    assert.equal(resolveRecoveryRunDir('latest', { runsDir: root }), null);
    assert.equal(buildRecoveryAssessment({ run: 'latest', runsDir: root }).status, 'NO_LATEST_RUN');
    const legacy = join(root, 'legacy');
    mkdirSync(legacy);
    writeFileSync(join(legacy, '01_manifest.json'), JSON.stringify({ target_project: 'fixture' }));
    assert.equal(resolveRecoveryRunDir('latest', { runsDir: root }), legacy);
    assert.equal(buildRecoveryAssessment({ run: 'latest', runsDir: root }).run_dir, legacy);
    assert.equal(resolveInspectRunDir({ run: 'latest', babelRunsDir: root }), legacy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const linked of ['thread', 'both'] as const) {
  test(`latest refuses ${linked === 'both' ? 'both linked journals' : 'a linked journal beside a valid journal'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-session-linked-'));
    try {
      const runDir = join(root, 'chat-sessions', 'chat-linked');
      const foreign = join(root, 'other-session');
      mkdirSync(runDir, { recursive: true });
      mkdirSync(foreign);
      const thread = createThreadEventLog('chat-linked');
      const turn = startFixtureTurn(thread, 'first task', root);
      endTurn(thread, turn, 'VERIFIED_COMPLETE', 'completed');
      const session = createSessionEventLog('chat-linked');
      submit(session, turn, 'first task', root);
      recordTurnEnded(session, { turn_id: turn, outcome: 'VERIFIED_COMPLETE', status: 'completed' });
      await persistThreadEventLog(foreign, thread);
      rewriteSessionEventLog(foreign, session);
      const linkJournal = (name: string): void => {
        if (process.platform === 'win32') symlinkSync(foreign, join(runDir, name), 'junction');
        else symlinkSync(join(foreign, name), join(runDir, name));
      };
      linkJournal('thread_events.json');
      if (linked === 'both') linkJournal('session-events.jsonl');
      else rewriteSessionEventLog(runDir, session);
      writeFileSync(join(root, '.latest.json'), JSON.stringify({
        run_dir: foreign, project: 'pipeline', created_at: '2026-01-01T00:00:00.000Z',
      }));

      assert.equal(resolveInspectRunDir({ run: 'latest', babelRunsDir: root }), runDir);
      const assessment = buildRecoveryAssessment({ run: 'latest', runsDir: root });
      assert.equal(assessment.run_dir, runDir);
      assert.equal(assessment.user_status, 'not_verified');
      assert.equal(assessment.terminal_outcome, null);
      assert.equal(readSessionSummary(runDir).status, 'UNREADABLE_STATE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('journal loaders refuse a linked run directory or Chat parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-linked-parent-'));
  try {
    const realParent = join(root, 'other-journals');
    const realRun = join(realParent, 'chat-linked');
    mkdirSync(realRun, { recursive: true });
    const session = createSessionEventLog('chat-linked');
    const thread = createThreadEventLog('chat-linked');
    submit(session, startFixtureTurn(thread, 'fixture task', root), 'fixture task', root);
    rewriteSessionEventLog(realRun, session);
    await persistThreadEventLog(realRun, thread);
    const runLink = join(root, 'chat-run-link');
    const parentLink = join(root, 'chat-sessions');
    symlinkSync(realRun, runLink, 'junction');
    symlinkSync(realParent, parentLink, 'junction');
    for (const runDir of [runLink, join(parentLink, 'chat-linked')]) {
      assert.equal(inspectSessionEventLogFromDir(runDir).kind, 'invalid');
      assert.throws(() => loadThreadEventLogFromDir(runDir), { code: 'THREAD_EVENT_LOG_INVALID' });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
