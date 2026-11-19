/** UX-10 — recovered TUI conversation keeps terminal failure and answer. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendThreadEvent,
  createThreadEventLog,
  endTurn,
  startTurn,
} from '../agent/threadEventLog.js';
import { projectChatArchive } from '../agent/chatArchiveProjection.js';
import {
  chatMessagesToInteractiveTurns,
  hydrateReplTurnsFromChatTranscript,
} from './chatTranscriptHydration.js';
import type { ReplContext } from './context.js';

function failedLog() {
  const log = createThreadEventLog('ux10');
  const turnId = startTurn(log, {
    task: 'fix the parser',
    model: 'fixture-model',
    provider: 'fixture-provider',
    projectRoot: '/tmp/project',
    policyPreset: 'default',
  });
  appendThreadEvent(log, {
    kind: 'assistant_message',
    turn_id: turnId,
    content: 'I started to explain the parser fix.',
    provenance: 'model',
  });
  endTurn(log, turnId, 'AGENT_FAILURE', 'failed', {
    code: 'provider_failure',
    cause_class: 'provider',
  });
  return { log, turnId };
}

test('UX-10: a terminal failure without a response still survives archive projection', () => {
  const { log } = failedLog();
  const archive = projectChatArchive(log);
  const terminal = archive.find((message) => message['archive_kind'] === 'terminal_status');
  assert.ok(terminal, 'terminal status row must not be dropped');
  assert.match(String(terminal['content']), /failed/i);
  assert.equal(terminal['terminal_outcome'], 'AGENT_FAILURE');
  assert.equal(terminal['reason_code'], 'provider_failure');

  const turns = chatMessagesToInteractiveTurns(archive as never);
  const assistant = turns.find((turn) => turn.role === 'assistant');
  assert.ok(assistant?.answer?.includes('I started to explain the parser fix.'));
  assert.match(assistant?.answer ?? '', /run ended: failed/i);
});

test('UX-10: recovery hydrates the durable failure status, not complete', () => {
  const { log } = failedLog();
  const dir = mkdtempSync(join(tmpdir(), 'babel-ux10-'));
  try {
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      projectChatArchive(log).map((message) => JSON.stringify(message)).join('\n') + '\n',
    );
    const ctx = {
      turns: [],
      turnCounter: 0,
      lastAssistantAnswer: null,
      lastAssistantNext: null,
      lastAssistantStatus: null,
      lastResolvedTask: null,
      lastRunDir: null,
      state: { lastRunUserStatus: 'ready' },
      saveSessionState: () => undefined,
    };
    hydrateReplTurnsFromChatTranscript(ctx as unknown as ReplContext, {
      sessionId: 'ux10',
      transcriptPath,
      targetRoot: '/tmp/project',
      workspaceRoot: null,
      terminal: { outcome: 'AGENT_FAILURE', status: 'failed' },
    });
    assert.equal(ctx.state.lastRunUserStatus, 'failed');
    assert.equal(ctx.lastAssistantStatus, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UX-10 positive control: verified terminal hydrates success and keeps the answer', () => {
  const log = createThreadEventLog('ux10-ok');
  const turnId = startTurn(log, {
    task: 'explain the parser',
    model: 'fixture-model',
    provider: 'fixture-provider',
    projectRoot: '/tmp/project',
    policyPreset: 'default',
  });
  appendThreadEvent(log, {
    kind: 'assistant_message',
    turn_id: turnId,
    content: 'The parser splits tokens.',
    provenance: 'model',
  });
  endTurn(log, turnId, 'VERIFIED_COMPLETE', 'completed', undefined, {
    kind: 'answer',
    content: 'The parser splits tokens.',
  });
  const dir = mkdtempSync(join(tmpdir(), 'babel-ux10-ok-'));
  try {
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      projectChatArchive(log).map((message) => JSON.stringify(message)).join('\n') + '\n',
    );
    const ctx = {
      turns: [],
      turnCounter: 0,
      lastAssistantAnswer: null,
      lastAssistantNext: null,
      lastAssistantStatus: null,
      lastResolvedTask: null,
      lastRunDir: null,
      state: { lastRunUserStatus: 'ready' },
      saveSessionState: () => undefined,
    };
    hydrateReplTurnsFromChatTranscript(ctx as unknown as ReplContext, {
      sessionId: 'ux10-ok',
      transcriptPath,
      targetRoot: '/tmp/project',
      workspaceRoot: null,
      terminal: { outcome: 'VERIFIED_COMPLETE', status: 'completed' },
    });
    assert.equal(ctx.state.lastRunUserStatus, 'complete');
    assert.equal(ctx.lastAssistantStatus, 'complete');
    assert.match(String(ctx.lastAssistantAnswer), /parser splits tokens/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
