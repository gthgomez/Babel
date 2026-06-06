/**
 * Local Mode session lifecycle + inspect session-id resolution (P0-5).
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildInspectOutcomeView,
  loadInspectBundle,
  resolveInspectRunDir,
} from '../src/inspect/loaders.js';

interface SessionStartRecord {
  SchemaVersion: number;
  StartedAtUtc: string;
  SessionId: string;
  SessionStartPath: string;
  Project: string;
  TaskCategory: string;
  Model: string;
}

interface SessionEndRecord {
  SchemaVersion: number;
  EndedAtUtc: string;
  SessionId: string;
  Result: string;
  SessionStartPath: string;
  SessionEndPath: string;
}

function writeSessionStart(root: string, sessionId: string): SessionStartRecord {
  const startedAtUtc = new Date().toISOString();
  const sessionDate = startedAtUtc.slice(0, 10);
  const sessionStartDir = join(root, 'session-starts', sessionDate);
  mkdirSync(sessionStartDir, { recursive: true });
  const sessionStartPath = join(sessionStartDir, `${sessionId}.json`);
  const record: SessionStartRecord = {
    SchemaVersion: 1,
    StartedAtUtc: startedAtUtc,
    SessionId: sessionId,
    SessionStartPath: sessionStartPath,
    Project: 'global',
    TaskCategory: 'backend',
    Model: 'codex',
  };
  writeFileSync(sessionStartPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

function writeSessionEnd(root: string, start: SessionStartRecord, result: string): SessionEndRecord {
  const endedAtUtc = new Date().toISOString();
  const sessionDate = endedAtUtc.slice(0, 10);
  const sessionEndDir = join(root, 'session-ends', sessionDate);
  mkdirSync(sessionEndDir, { recursive: true });
  const sessionEndPath = join(sessionEndDir, `${start.SessionId}.json`);
  const record: SessionEndRecord = {
    SchemaVersion: 1,
    EndedAtUtc: endedAtUtc,
    SessionId: start.SessionId,
    Result: result,
    SessionStartPath: start.SessionStartPath,
    SessionEndPath: sessionEndPath,
  };
  writeFileSync(sessionEndPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const logPath = join(root, 'session-log.jsonl');
  appendFileSync(
    logPath,
    `${JSON.stringify({
      event: 'session_end',
      session_id: start.SessionId,
      result,
      ended_at_utc: endedAtUtc,
    })}\n`,
    'utf8',
  );
  return record;
}

function seedRunBundleForSession(runsRoot: string, sessionId: string): string {
  const runDir = join(runsRoot, '20260521_120000_test-session');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, '01_manifest.json'),
    `${JSON.stringify({
      session_id: sessionId,
      target_project: 'global',
      analysis: { pipeline_mode: 'verified', task_summary: 'dry-run attach test' },
      instruction_stack: { domain_id: 'backend' },
      runtime_telemetry: { final_outcome: 'COMPLETE', qa_verdict: 'PASS' },
    }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(runDir, '06_runtime_telemetry.json'),
    `${JSON.stringify({
      pipeline_mode: 'verified',
      final_outcome: 'COMPLETE',
      qa_verdict: 'PASS',
      domain_id: 'backend',
    }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(runDir, '04_execution_report.json'),
    `${JSON.stringify({ status: 'EXECUTION_COMPLETE', steps_executed: 0, tool_call_log: [] }, null, 2)}\n`,
    'utf8',
  );
  return runDir;
}

function main(): void {
  const outputRoot = mkdtempSync(join(tmpdir(), 'babel-local-learning-'));
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-runs-'));
  const sessionId = 'dry-run-20260521-test';

  const start = writeSessionStart(outputRoot, sessionId);
  assert.ok(existsSync(start.SessionStartPath), 'session start JSON should exist');

  const end = writeSessionEnd(outputRoot, start, 'success');
  assert.ok(existsSync(end.SessionEndPath), 'session end JSON should exist');

  const logPath = join(outputRoot, 'session-log.jsonl');
  assert.ok(existsSync(logPath), 'session-log.jsonl should exist');
  const logLines = readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(logLines.length, 1);
  const logEntry = JSON.parse(logLines[0]!) as { session_id?: string };
  assert.equal(logEntry.session_id, sessionId);

  const runDir = seedRunBundleForSession(runsRoot, sessionId);
  const resolvedByFlag = resolveInspectRunDir({ sessionId, babelRunsDir: runsRoot });
  const resolvedByAlias = resolveInspectRunDir({ run: `session:${sessionId}`, babelRunsDir: runsRoot });
  assert.equal(resolvedByFlag, runDir);
  assert.equal(resolvedByAlias, runDir);

  const bundle = loadInspectBundle(runDir);
  const outcomeView = buildInspectOutcomeView(bundle);
  assert.equal(outcomeView.runOutcome.status, 'completed');
  assert.equal(outcomeView.runDir, runDir);

  console.log(`[test] local session attach + inspect session-id ok (${outputRoot})`);
}

main();
