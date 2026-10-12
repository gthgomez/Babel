import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  HISTORY_MESSAGE_WINDOW,
  listSavedChats,
  messagesFromTranscript,
  readSavedChat,
} from '../native/sessions.mjs';

test('messagesFromTranscript keeps the latest window and exposes older navigation', () => {
  const lines = [];
  for (let i = 0; i < 160; i += 1) {
    lines.push(JSON.stringify({role: i % 2 === 0 ? 'user' : 'assistant', content: `turn-${i}`}));
  }
  const tail = messagesFromTranscript(lines.join('\n'), {limit: HISTORY_MESSAGE_WINDOW, olderOffset: 0});
  assert.equal(tail.total, 160);
  assert.equal(tail.messages.length, HISTORY_MESSAGE_WINDOW);
  assert.equal(tail.messages.at(-1).text, 'turn-159');
  assert.equal(tail.hasOlder, true);
  const older = messagesFromTranscript(lines.join('\n'), {limit: HISTORY_MESSAGE_WINDOW, olderOffset: 150});
  assert.equal(older.messages[0].text, 'turn-0');
});

test('listSavedChats paginates sessions and keeps oversize transcripts discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-sessions-page-'));
  const desktop = join(root, 'babel-desktop');
  const runs = join(root, 'runs', 'chat-sessions');
  await mkdir(desktop, {recursive: true});
  for (let i = 0; i < 35; i += 1) {
    const session = join(runs, `chat-${String(i).padStart(2, '0')}`);
    await mkdir(session, {recursive: true});
    await writeFile(join(session, 'transcript.jsonl'), `${JSON.stringify({role: 'user', content: `Session ${i}`})}\n`);
  }
  const page1 = await listSavedChats(desktop, {limit: 30, offset: 0, runsDir: join(root, 'runs')});
  assert.equal(page1.sessions.length, 30);
  assert.equal(page1.total, 35);
  const page2 = await listSavedChats(desktop, {limit: 30, offset: 30, runsDir: join(root, 'runs')});
  assert.equal(page2.sessions.length, 5);
  await rm(root, {recursive: true, force: true});
});

test('readSavedChat can load a distinctive final turn from a long transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-sessions-long-'));
  const desktop = join(root, 'babel-desktop');
  const session = join(root, 'runs', 'chat-sessions', 'chat-long');
  await mkdir(desktop, {recursive: true});
  await mkdir(session, {recursive: true});
  const lines = [];
  for (let i = 0; i < 155; i += 1) {
    lines.push(JSON.stringify({role: 'user', content: `msg-${i}`}));
  }
  lines.push(JSON.stringify({role: 'user', content: 'DISTINCTIVE-FINAL-TURN'}));
  await writeFile(join(session, 'transcript.jsonl'), lines.join('\n') + '\n');
  const opened = await readSavedChat(desktop, 'chat-long', {runsDir: join(root, 'runs')});
  assert.ok(opened.messages.some(message => message.text === 'DISTINCTIVE-FINAL-TURN'));
  assert.equal(opened.history.hasOlder, true);
  await rm(root, {recursive: true, force: true});
});
