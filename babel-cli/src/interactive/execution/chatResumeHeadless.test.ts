import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { chatSessionDir, transcriptPath } from '../../cli/runsLayout.js';
import { isSafeChatSessionId, openResumedChatEngine } from './chatResumeHeadless.js';

const previousRuns = process.env['BABEL_RUNS_DIR'];
const root = await mkdtemp(join(tmpdir(), 'babel-resume-'));

after(async () => {
  if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
  else process.env['BABEL_RUNS_DIR'] = previousRuns;
  await rm(root, { recursive: true, force: true });
});

test('chat session ids reject path segments', () => {
  assert.equal(isSafeChatSessionId('chat-abc123'), true);
  assert.equal(isSafeChatSessionId('../chat-abc'), false);
  assert.equal(isSafeChatSessionId('chat/abc'), false);
  assert.equal(isSafeChatSessionId(''), false);
});

test('resume refuses a transcript whose repository identity is unproven', async () => {
  process.env['BABEL_RUNS_DIR'] = root;
  const sessionId = 'chat-unproven';
  await mkdir(chatSessionDir(sessionId), { recursive: true });
  await writeFile(transcriptPath(sessionId), `${JSON.stringify({ role: 'user', content: 'hi' })}\n`);
  await assert.rejects(
    () => openResumedChatEngine(sessionId, { task: 'next', projectRoot: root }),
    /Cannot resume chat session chat-unproven/,
  );
});
