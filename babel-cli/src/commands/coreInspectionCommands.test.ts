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
import { readSessionSummary } from './coreInspectionCommands.js';

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
    submit(session, second, 'second task', root);
    rewriteSessionEventLog(runDir, session);
    await persistThreadEventLog(runDir, thread);
    writeFileSync(
      join(runDir, '06_runtime_telemetry.json'),
      `${JSON.stringify({ pipeline_mode: 'chat', final_outcome: 'COMPLETE' })}\n`,
    );

    const summary = readSessionSummary(runDir);
    assert.equal(summary.status, 'INTERRUPTED');
    assert.equal(summary.terminal_outcome, null);
    assert.equal(summary.exit_code, null);
    assert.notEqual(summary.user_status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
