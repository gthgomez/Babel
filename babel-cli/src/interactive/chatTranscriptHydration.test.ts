import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  chatMessagesToInteractiveTurns,
  hydrateReplTurnsFromChatTranscript,
  parseChatTranscriptFile,
} from './chatTranscriptHydration.js';
import { BabelRepl } from './BabelRepl.js';
import { renderChatTranscript } from '../ui/chatPanel.js';
import { stripAnsi } from '../ui/theme.js';

const sampleTranscript = [
  { role: 'system', content: 'You are a helpful coding assistant.' },
  { role: 'user', content: 'What is in this repository?' },
  {
    role: 'assistant',
    content: 'Let me explore the repository structure.',
    name: 'tool_calls',
  },
  { role: 'tool', content: 'src/\npackage.json\nREADME.md' },
  {
    role: 'assistant',
    content: 'This repository contains source code in src/, a package.json, and a README.',
  },
  { role: 'user', content: 'Show me the main entry point.' },
  { role: 'assistant', content: 'The main entry point is src/index.ts.' },
];

test('chatMessagesToInteractiveTurns maps user/assistant exchanges and skips tool rows', () => {
  const turns = chatMessagesToInteractiveTurns(sampleTranscript as any, {
    targetRoot: '/tmp/project',
    workspaceRoot: '/tmp',
  });

  assert.equal(turns.length, 4);
  assert.equal(turns[0]?.role, 'user');
  assert.equal(turns[0]?.input, 'What is in this repository?');
  assert.equal(
    turns[1]?.answer,
    'This repository contains source code in src/, a package.json, and a README.',
  );
  assert.equal(turns[2]?.role, 'user');
  assert.equal(turns[2]?.input, 'Show me the main entry point.');
  assert.equal(turns[3]?.answer, 'The main entry point is src/index.ts.');
});

test('parseChatTranscriptFile reads JSONL transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-transcript-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, sampleTranscript.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
  try {
    const messages = parseChatTranscriptFile(path);
    assert.equal(messages.length, sampleTranscript.length);
    assert.equal(messages[1]?.role, 'user');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hydrateReplTurnsFromChatTranscript populates ctx.turns for /chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-hydrate-'));
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(
    transcriptPath,
    sampleTranscript.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf-8',
  );

  const ctx = Object.create(BabelRepl.prototype) as {
    turns: unknown[];
    turnCounter: number;
    lastAssistantAnswer: string | null;
    lastAssistantNext: string | null;
    lastAssistantStatus: string | null;
    lastResolvedTask: string | null;
    lastRunDir: string | null;
    state: { lastRunUserStatus: string };
    saveSessionState: () => void;
  };
  ctx.turns = [];
  ctx.turnCounter = 0;
  ctx.lastAssistantAnswer = null;
  ctx.lastAssistantNext = null;
  ctx.lastAssistantStatus = null;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.state = { lastRunUserStatus: 'ready' };
  ctx.saveSessionState = () => undefined;

  try {
    const { turnCount, exchangeCount } = hydrateReplTurnsFromChatTranscript(ctx as any, {
      sessionId: 'demo-session',
      transcriptPath,
      targetRoot: '/tmp/project',
      workspaceRoot: '/tmp',
    });

    assert.equal(turnCount, 4);
    assert.equal(exchangeCount, 2);
    assert.equal(ctx.turnCounter, 4);
    assert.equal(ctx.lastAssistantAnswer, 'The main entry point is src/index.ts.');

    const rendered = stripAnsi(renderChatTranscript(ctx.turns as any));
    assert.match(rendered, /What is in this repository/);
    assert.match(rendered, /main entry point is src\/index\.ts/);
    assert.doesNotMatch(rendered, /No chat turns recorded yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});