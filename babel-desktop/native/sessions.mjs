import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { statusFromTerminalOutcome } from '../src/core.mjs';

const SESSION_ID = /^[\w-]{1,80}$/;
export const HISTORY_MESSAGE_WINDOW = 150;
export const HISTORY_SESSION_PAGE = 30;
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPT_TITLE_SCAN_BYTES = 65536;
const TAIL_READ_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_EVENTS_BYTES = 4 * 1024 * 1024;

/** Babel's own chat-session directory. This reader does not create a second store. */
export function runsSessionsDir(packageRoot, runsDir = process.env.BABEL_RUNS_DIR) {
  return runsDir ? join(runsDir, 'chat-sessions') : join(packageRoot, '..', 'runs', 'chat-sessions');
}

function parseTranscriptLine(line) {
  if (!line.trim()) return null;
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') return null;
  const content = value.content.slice(0, 250000);
  if (!content.trim()) return null;
  const outcome = typeof value.terminal_outcome === 'string'
    ? value.terminal_outcome
    : typeof value.outcome === 'string'
      ? value.outcome
      : null;
  return {
    role: value.role,
    text: content,
    ...(value.turn_id !== undefined && value.turn_id !== null ? {turn_id: value.turn_id} : {}),
    ...(value.role === 'assistant'
      ? {status: outcome ? statusFromTerminalOutcome(outcome) : 'unverified'}
      : {}),
  };
}

export function parseTranscriptMessages(text) {
  const messages = [];
  for (const line of String(text ?? '').split('\n')) {
    const message = parseTranscriptLine(line);
    if (message) messages.push(message);
  }
  return messages;
}

/** Head scan for titles and counts without tail biasing. */
export function scanTranscriptHead(text) {
  const messages = parseTranscriptMessages(text);
  const firstUser = messages.find(message => message.role === 'user');
  const title = (firstUser?.text || 'Saved chat').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Saved chat';
  return {title, total: messages.length, firstUserText: firstUser?.text ?? null};
}

/**
 * Slice a parsed transcript: newest page at olderOffset=0; olderOffset skips that many messages from the end.
 * @returns {{messages:object[], total:number, windowStart:number, windowEnd:number, hasOlder:boolean, assistantsBefore:number, totalAssistants:number}}
 */
export function sliceTranscriptWindow(all, {limit = HISTORY_MESSAGE_WINDOW, olderOffset = 0} = {}) {
  const total = all.length;
  const end = Math.max(0, total - olderOffset);
  const start = Math.max(0, end - limit);
  const messages = all.slice(start, end);
  const assistantsBefore = all.slice(0, start).filter(message => message.role === 'assistant').length;
  const totalAssistants = all.filter(message => message.role === 'assistant').length;
  return {
    messages,
    total,
    windowStart: start,
    windowEnd: end,
    hasOlder: start > 0,
    assistantsBefore,
    totalAssistants,
    partialTail: false,
  };
}

export function messagesFromTranscript(text, options = {}) {
  return sliceTranscriptWindow(parseTranscriptMessages(text), options);
}

async function readTranscriptText(transcriptPath, fileSize) {
  if (fileSize <= MAX_TRANSCRIPT_BYTES) {
    return {text: await readFile(transcriptPath, 'utf8'), partialTail: false};
  }
  const start = Math.max(0, fileSize - TAIL_READ_BYTES);
  const handle = await open(transcriptPath, 'r');
  const length = fileSize - start;
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, start);
  await handle.close();
  let text = buffer.toString('utf8');
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
  }
  return {text, partialTail: true};
}

async function titleFromTranscript(transcriptPath, fileSize) {
  const scanBytes = Math.min(fileSize, TRANSCRIPT_TITLE_SCAN_BYTES);
  const handle = await open(transcriptPath, 'r');
  const buffer = Buffer.alloc(scanBytes);
  await handle.read(buffer, 0, scanBytes, 0);
  await handle.close();
  return scanTranscriptHead(buffer.toString('utf8')).title;
}

/** Ordered terminal outcomes from durable session-events.jsonl when present. */
export async function terminalOutcomesFromSessionEvents(sessionDir) {
  const path = join(sessionDir, 'session-events.jsonl');
  let info;
  try {
    info = await stat(path);
  } catch {
    return {ordered: [], byTurnId: new Map()};
  }
  if (!info.isFile() || info.size > MAX_SESSION_EVENTS_BYTES) {
    return {ordered: [], byTurnId: new Map(), bounded: true};
  }
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {ordered: [], byTurnId: new Map()};
  }
  const ordered = [];
  const byTurnId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.kind === 'turn_ended' && typeof event.outcome === 'string') {
      ordered.push(event.outcome);
      if (event.turn_id !== undefined && event.turn_id !== null) {
        byTurnId.set(String(event.turn_id), event.outcome);
      }
    }
  }
  return {ordered, byTurnId};
}

function applySessionEventOutcomes(messages, {ordered, byTurnId}, {assistantIndexOffset = 0, totalAssistantsInTranscript = null} = {}) {
  const assistantCount = messages.filter(message => message.role === 'assistant').length;
  if (assistantCount === 0) return messages;
  if (byTurnId.size > 0) {
    let assistantOrdinal = 0;
    return messages.map(message => {
      if (message.role !== 'assistant') return message;
      assistantOrdinal += 1;
      if (message.turn_id !== undefined && message.turn_id !== null) {
        const outcome = byTurnId.get(String(message.turn_id));
        if (typeof outcome === 'string') {
          return {...message, status: statusFromTerminalOutcome(outcome)};
        }
        return message;
      }
      const globalOrdinal = assistantIndexOffset + assistantOrdinal;
      const outcome = byTurnId.get(String(globalOrdinal));
      if (typeof outcome === 'string') {
        return {...message, status: statusFromTerminalOutcome(outcome)};
      }
      return message;
    });
  }
  if (!ordered.length) return messages;
  if (totalAssistantsInTranscript !== null && ordered.length !== totalAssistantsInTranscript) {
    return messages;
  }
  let assistantOrdinal = 0;
  return messages.map(message => {
    if (message.role !== 'assistant') return message;
    assistantOrdinal += 1;
    const globalIndex = assistantIndexOffset + assistantOrdinal - 1;
    const outcome = ordered[globalIndex];
    if (typeof outcome !== 'string') return message;
    return {...message, status: statusFromTerminalOutcome(outcome)};
  });
}

export async function listSavedChats(packageRoot, { limit = HISTORY_SESSION_PAGE, offset = 0, runsDir } = {}) {
  let names = [];
  try { names = await readdir(runsSessionsDir(packageRoot, runsDir)); } catch { return {sessions: [], total: 0, offset, limit}; }
  const sessions = [];
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue;
    const transcript = join(runsSessionsDir(packageRoot, runsDir), name, 'transcript.jsonl');
    try {
      const info = await stat(transcript);
      if (!info.isFile()) continue;
      const oversize = info.size > MAX_TRANSCRIPT_BYTES;
      let messageCount = null;
      let title = 'Saved chat';
      if (!oversize) {
        const head = scanTranscriptHead(await readFile(transcript, 'utf8'));
        messageCount = head.total;
        title = head.title;
      } else {
        title = await titleFromTranscript(transcript, info.size);
      }
      sessions.push({
        id: name,
        title,
        mtimeMs: info.mtimeMs,
        messages: messageCount,
        transcriptBytes: info.size,
        oversize,
      });
    } catch { /* A damaged session stays out of the list. */ }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const total = sessions.length;
  return {sessions: sessions.slice(offset, offset + limit), total, offset, limit};
}

export async function readSavedChat(packageRoot, sessionId, {runsDir, olderOffset = 0, messageLimit = HISTORY_MESSAGE_WINDOW} = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('Invalid chat session id');
  const transcript = join(runsSessionsDir(packageRoot, runsDir), sessionId, 'transcript.jsonl');
  const info = await stat(transcript);
  if (!info.isFile()) throw new Error('Saved chat is unavailable');
  const {text, partialTail} = await readTranscriptText(transcript, info.size);
  const all = parseTranscriptMessages(text);
  const window = partialTail
    ? {
      ...sliceTranscriptWindow(all, {limit: messageLimit, olderOffset: 0}),
      hasOlder: false,
      assistantsBefore: 0,
      totalAssistants: all.filter(message => message.role === 'assistant').length,
      partialTail: true,
      total: null,
    }
    : sliceTranscriptWindow(all, {limit: messageLimit, olderOffset});
  const sessionDir = join(runsSessionsDir(packageRoot, runsDir), sessionId);
  const outcomeIndex = await terminalOutcomesFromSessionEvents(sessionDir);
  const messages = partialTail
    ? window.messages
    : applySessionEventOutcomes(window.messages, outcomeIndex, {
      assistantIndexOffset: window.assistantsBefore,
      totalAssistantsInTranscript: window.totalAssistants,
    });
  return {
    id: sessionId,
    messages,
    history: {
      totalMessages: partialTail ? null : window.total,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      hasOlder: window.hasOlder && !partialTail,
      tailOnly: partialTail,
      olderOffset,
      messageLimit,
      transcriptBytes: info.size,
      oversize: info.size > MAX_TRANSCRIPT_BYTES,
      outcomesBounded: Boolean(outcomeIndex.bounded),
    },
  };
}
