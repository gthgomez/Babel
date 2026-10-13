import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  HISTORY_MESSAGE_WINDOW,
  MAX_TRANSCRIPT_BYTES,
  listSavedChats,
  messagesFromTranscript,
  readSavedChat,
  scanTranscriptHead,
} from '../native/sessions.mjs';

function messageTexts(messages) {
  return messages.map(message => message.text);
}

function assertNoOverlap(a, b) {
  const setB = new Set(messageTexts(b));
  const overlap = messageTexts(a).filter(text => setB.has(text));
  assert.equal(overlap.length, 0, `overlap: ${overlap.join(', ')}`);
}

test('160-message transcript: tail is 10–159 and olderOffset 150 is 0–9 without overlap', () => {
  const lines = [];
  for (let i = 0; i < 160; i += 1) {
    lines.push(JSON.stringify({role: i % 2 === 0 ? 'user' : 'assistant', content: `turn-${i}`}));
  }
  const text = lines.join('\n');
  const tail = messagesFromTranscript(text, {limit: HISTORY_MESSAGE_WINDOW, olderOffset: 0});
  assert.equal(tail.windowStart, 10);
  assert.equal(tail.windowEnd, 160);
  assert.equal(messageTexts(tail.messages).at(-1), 'turn-159');
  assert.equal(messageTexts(tail.messages)[0], 'turn-10');
  const older = messagesFromTranscript(text, {limit: HISTORY_MESSAGE_WINDOW, olderOffset: 150});
  assert.equal(older.windowStart, 0);
  assert.equal(older.windowEnd, 10);
  assert.equal(older.messages.length, 10);
  assert.equal(messageTexts(older.messages)[0], 'turn-0');
  assert.equal(messageTexts(older.messages).at(-1), 'turn-9');
  assertNoOverlap(tail.messages, older.messages);
});

test('scanTranscriptHead uses the first user message for title, not the tail window', () => {
  const lines = [];
  lines.push(JSON.stringify({role: 'user', content: 'TRUE-FIRST-TITLE'}));
  for (let i = 1; i < 160; i += 1) {
    lines.push(JSON.stringify({role: i % 2 === 0 ? 'user' : 'assistant', content: `turn-${i}`}));
  }
  const head = scanTranscriptHead(lines.join('\n'));
  assert.equal(head.title, 'TRUE-FIRST-TITLE');
  const tail = messagesFromTranscript(lines.join('\n'));
  assert.notEqual(tail.messages.find(message => message.role === 'user')?.text, 'TRUE-FIRST-TITLE');
});

test('ordinal session outcomes map event turn_id without transcript turn_id in the latest tail window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-sessions-ordinal-'));
  const desktop = join(root, 'babel-desktop');
  const session = join(root, 'runs', 'chat-sessions', 'chat-ordinal');
  await mkdir(desktop, {recursive: true});
  await mkdir(session, {recursive: true});
  const lines = [];
  let assistantTurn = 0;
  for (let i = 0; i < 160; i += 1) {
    if (i % 2 === 0) {
      lines.push(JSON.stringify({role: 'user', content: `user-${i}`}));
    } else {
      assistantTurn += 1;
      lines.push(JSON.stringify({role: 'assistant', content: `assistant-${assistantTurn}`}));
    }
  }
  await writeFile(join(session, 'transcript.jsonl'), lines.join('\n') + '\n');
  const events = [];
  for (let turn = 1; turn <= 80; turn += 1) {
    const outcome = turn === 6 ? 'VERIFIED_COMPLETE' : turn === 1 ? 'AGENT_FAILURE' : 'UNVERIFIED_PATCH';
    events.push(JSON.stringify({kind: 'turn_ended', turn_id: turn, outcome}));
  }
  await writeFile(join(session, 'session-events.jsonl'), events.join('\n') + '\n');
  const tail = await readSavedChat(desktop, 'chat-ordinal', {runsDir: join(root, 'runs'), olderOffset: 0});
  assert.equal(tail.history.windowStart, 10);
  assert.equal(tail.messages.length, 150);
  assert.equal(tail.history.windowStart + 1, 11);
  const globalMessage11 = tail.messages[1];
  assert.equal(globalMessage11?.role, 'assistant');
  assert.equal(globalMessage11?.text, 'assistant-6');
  assert.equal(globalMessage11?.status, 'complete');
  const visibleIndex11 = tail.messages[11];
  assert.equal(visibleIndex11?.text, 'assistant-11');
  assert.equal(visibleIndex11?.status, 'unverified');
  const older = await readSavedChat(desktop, 'chat-ordinal', {runsDir: join(root, 'runs'), olderOffset: 150});
  const turnOneAssistant = older.messages.find(message => message.text === 'assistant-1');
  assert.equal(turnOneAssistant?.status, 'failed');
  assertNoOverlap(tail.messages, older.messages);
  await rm(root, {recursive: true, force: true});
});

test('ordinal session outcomes fall back to ordered events when turn_id is absent from events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-sessions-ordinal-ordered-'));
  const desktop = join(root, 'babel-desktop');
  const session = join(root, 'runs', 'chat-sessions', 'chat-ordered');
  await mkdir(desktop, {recursive: true});
  await mkdir(session, {recursive: true});
  const lines = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    lines.push(JSON.stringify({role: 'user', content: `user-${turn}`}));
    lines.push(JSON.stringify({role: 'assistant', content: `assistant-${turn}`}));
  }
  await writeFile(join(session, 'transcript.jsonl'), lines.join('\n') + '\n');
  await writeFile(join(session, 'session-events.jsonl'), [
    JSON.stringify({kind: 'turn_ended', outcome: 'AGENT_FAILURE'}),
    JSON.stringify({kind: 'turn_ended', outcome: 'AGENT_FAILURE'}),
    JSON.stringify({kind: 'turn_ended', outcome: 'AGENT_FAILURE'}),
    JSON.stringify({kind: 'turn_ended', outcome: 'AGENT_FAILURE'}),
    JSON.stringify({kind: 'turn_ended', outcome: 'AGENT_FAILURE'}),
    JSON.stringify({kind: 'turn_ended', outcome: 'VERIFIED_COMPLETE'}),
  ].join('\n') + '\n');
  const opened = await readSavedChat(desktop, 'chat-ordered', {runsDir: join(root, 'runs')});
  const lastAssistant = opened.messages.filter(message => message.role === 'assistant').at(-1);
  assert.equal(lastAssistant?.status, 'complete');
  await rm(root, {recursive: true, force: true});
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

test('oversize malformed unicode and partial-line transcripts remain discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-sessions-oversize-'));
  const desktop = join(root, 'babel-desktop');
  const session = join(root, 'runs', 'chat-sessions', 'chat-big');
  await mkdir(desktop, {recursive: true});
  await mkdir(session, {recursive: true});
  const tailMarker = JSON.stringify({role: 'assistant', content: 'TAIL-MARKER-OVERSIZE-FINAL-LINE'});
  const prefix = `${JSON.stringify({role: 'user', content: 'Оversize-unicode-title-🙂'})}\n{broken json\n`;
  const padding = 'x'.repeat(MAX_TRANSCRIPT_BYTES - Buffer.byteLength(prefix + tailMarker + '\n', 'utf8') + 1024);
  await writeFile(join(session, 'transcript.jsonl'), prefix + padding + '\n' + tailMarker + '\n', 'utf8');
  const listed = await listSavedChats(desktop, {runsDir: join(root, 'runs')});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].oversize, true);
  assert.match(listed.sessions[0].title, /Оversize-unicode-title/);
  const opened = await readSavedChat(desktop, 'chat-big', {runsDir: join(root, 'runs')});
  assert.equal(opened.history.tailOnly, true);
  assert.ok(opened.messages.some(message => message.text === 'TAIL-MARKER-OVERSIZE-FINAL-LINE'));
  await rm(root, {recursive: true, force: true});
});

test('readSavedChat pages earlier windows without duplicating the tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-sessions-dup-'));
  const desktop = join(root, 'babel-desktop');
  const session = join(root, 'runs', 'chat-sessions', 'chat-dup');
  await mkdir(desktop, {recursive: true});
  await mkdir(session, {recursive: true});
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(JSON.stringify({role: 'user', content: `msg-${i}`}));
  }
  await writeFile(join(session, 'transcript.jsonl'), lines.join('\n') + '\n');
  const tail = await readSavedChat(desktop, 'chat-dup', {runsDir: join(root, 'runs'), olderOffset: 0});
  const older = await readSavedChat(desktop, 'chat-dup', {runsDir: join(root, 'runs'), olderOffset: 150});
  assertNoOverlap(tail.messages, older.messages);
  assert.ok(older.messages.some(message => message.text === 'msg-0'));
  await rm(root, {recursive: true, force: true});
});
