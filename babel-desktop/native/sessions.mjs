import { opendir, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { statusFromTerminalOutcome } from '../src/core.mjs';
import { readTranscriptPage, scanTranscript } from './transcript-reader.mjs';
import { openSessionFile, readSnapshot } from './session-files.mjs';
import {parseArchiveRecord,projectArchiveMessage} from './archive-messages.mjs';

const SESSION_ID = /^[\w-]{1,80}$/;
export const HISTORY_MESSAGE_WINDOW = 150;
export const HISTORY_SESSION_PAGE = 30;
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPT_TITLE_SCAN_BYTES = 65536;
const MAX_SESSION_EVENTS_BYTES = 4 * 1024 * 1024;

/** Babel's own chat-session directory. This reader does not create a second store. */
export function runsSessionsDir(packageRoot, runsDir = process.env.BABEL_RUNS_DIR) {
  return runsDir ? join(runsDir, 'chat-sessions') : join(packageRoot, '..', 'runs', 'chat-sessions');
}

function parseTranscriptRecord(line) {
  return parseArchiveRecord(line);
}

function parseTranscriptLine(line) {
  const value = parseTranscriptRecord(line);
  if (!value) return null;
  return projectArchiveMessage(value);
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

async function titleFromTranscript(handle, fileSize) {
  const scanBytes = Math.min(fileSize, TRANSCRIPT_TITLE_SCAN_BYTES);
  const buffer = Buffer.alloc(scanBytes);
  await handle.read(buffer, 0, scanBytes, 0);
  return scanTranscriptHead(buffer.toString('utf8')).title;
}

/** Ordered terminal outcomes from durable session-events.jsonl when present. */
export async function terminalOutcomesFromSessionEvents(sessionDir) {
  let handle,raw;
  try {
    handle = await openSessionFile(dirname(sessionDir),basename(sessionDir),'session-events.jsonl');
    const info=await handle.stat();
    if(info.size>MAX_SESSION_EVENTS_BYTES)return {ordered: [], byTurnId: new Map(), bounded: true};
    raw=await readSnapshot(handle,info.size);
  } catch {
    return {ordered: [], byTurnId: new Map()};
  } finally {await handle?.close();}
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

function applySessionEventOutcomes(messages, {byTurnId}) {
  return messages.map(message => {
    if (message.activity || message.role !== 'assistant' || message.turn_id === undefined || message.turn_id === null) return message;
    const outcome = byTurnId.get(String(message.turn_id));
    if (typeof outcome !== 'string') return message;
    if(message.terminalOutcome&&message.terminalOutcome!==outcome)return {...message,status:'unverified',terminalConflict:true};
    return {...message, status: statusFromTerminalOutcome(outcome)};
  });
}

export async function listSavedChats(packageRoot, { limit = HISTORY_SESSION_PAGE, offset = 0, runsDir } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid session page limit');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid session page offset');
  let names = [];
  try { names = await readdir(runsSessionsDir(packageRoot, runsDir)); } catch { return {sessions: [], total: 0, offset, limit}; }
  const sessions = [];
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue;
    let handle;
    try {
      handle=await openSessionFile(runsSessionsDir(packageRoot,runsDir),name,'transcript.jsonl');
      const info = await handle.stat();
      const oversize = info.size > MAX_TRANSCRIPT_BYTES;
      let messageCount = null;
      let title = 'Saved chat';
      if (!oversize) {
        const head = scanTranscriptHead(await readSnapshot(handle,info.size));
        messageCount = head.total;
        title = head.title;
      } else {
        title = await titleFromTranscript(handle, info.size);
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
    finally {await handle?.close();}
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const total = sessions.length;
  return {sessions: sessions.slice(offset, offset + limit), total, offset, limit};
}

export async function readSavedChat(packageRoot, sessionId, {runsDir, olderOffset = 0, messageLimit = HISTORY_MESSAGE_WINDOW} = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('Invalid chat session id');
  if (!Number.isSafeInteger(olderOffset) || olderOffset < 0) throw new Error('Invalid history offset');
  if (!Number.isSafeInteger(messageLimit) || messageLimit < 1 || messageLimit > HISTORY_MESSAGE_WINDOW) throw new Error('Invalid history message limit');
  const handle = await openSessionFile(runsSessionsDir(packageRoot,runsDir),sessionId,'transcript.jsonl');
  let info, window, snapshotChanged;
  try {
    info = await handle.stat();
    if (!info.isFile()) throw new Error('Saved chat is unavailable');
    window = await readTranscriptPage(handle, info.size, parseTranscriptLine, {limit: messageLimit, olderOffset});
    const after = await handle.stat();
    snapshotChanged = after.size !== info.size || after.mtimeMs !== info.mtimeMs;
  } finally { await handle.close(); }
  const sessionDir = join(runsSessionsDir(packageRoot, runsDir), sessionId);
  const outcomeIndex = await terminalOutcomesFromSessionEvents(sessionDir);
  const messages = snapshotChanged ? window.messages : applySessionEventOutcomes(window.messages, outcomeIndex);
  return {
    id: sessionId,
    messages,
    history: {
      totalMessages: window.total,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      hasOlder: window.hasOlder,
      tailOnly: false,
      skippedOversizedLines: window.skippedOversizedLines,
      snapshotChanged,
      olderOffset,
      messageLimit,
      transcriptBytes: info.size,
      oversize: info.size > MAX_TRANSCRIPT_BYTES,
      outcomesBounded: Boolean(outcomeIndex.bounded),
    },
  };
}

/** Search canonical retained text, independently of the UI's session/message pages. No secondary store. */
export async function searchSavedChats(packageRoot, query, {runsDir, limit = 50} = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500 || query.includes('\0')) throw new Error('Invalid history search query');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid history search limit');
  // Match original UTF-16 offsets: lowercasing a copy can expand Unicode characters.
  const needle = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu');
  const results = [];
  let totalMatches = 0, unavailableSessions = 0, skippedOversizedLines = 0, changedSessions = 0;
  let directory;
  try { directory = await opendir(runsSessionsDir(packageRoot, runsDir)); }
  catch (error) { if (error.code === 'ENOENT') return {results, totalMatches, hasMore: false}; throw error; }
  for await (const entry of directory) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    let handle;
    try {
      handle = await openSessionFile(runsSessionsDir(packageRoot,runsDir),entry.name,'transcript.jsonl');
      const info = await handle.stat();
      if (!info.isFile()) { unavailableSessions++; continue; }
      let index = 0, title = 'Saved chat', titled = false;
      const matches = [];
      const diagnostics = await scanTranscript(handle, info.size, parseTranscriptRecord, record => {
        if (record.role === 'user' && !titled) { title = record.content.replace(/\s+/g, ' ').trim().slice(0, 80); titled = true; }
        const match = needle.exec(record.content);
        const at = match?.index ?? -1;
        if (at >= 0) {
          totalMatches++;
          if (results.length + matches.length < limit) matches.push({sessionId: entry.name, messageIndex: index, matchOffset:at, role: record.role, ...(record.archive_source==='thread_events'&&typeof record.source_event_id==='string'?{sourceEventId:record.source_event_id}:{}), excerpt: record.content.slice(Math.max(0, at - 60), at + match[0].length + 120)});
        }
        index++;
      });
      skippedOversizedLines += diagnostics.skippedOversizedLines;
      const after = await handle.stat();
      const snapshotChanged = after.size !== info.size || after.mtimeMs !== info.mtimeMs;
      if (snapshotChanged) changedSessions++;
      for (const match of matches) results.push({...match, title, snapshotChanged, olderOffset: Math.floor((index - 1 - match.messageIndex) / HISTORY_MESSAGE_WINDOW) * HISTORY_MESSAGE_WINDOW});
    } catch { unavailableSessions++; }
    finally { await handle?.close(); }
  }
  return {results, totalMatches, hasMore: totalMatches > results.length, unavailableSessions, skippedOversizedLines, changedSessions};
}

export async function readSavedMessage(packageRoot, sessionId, messageIndex, {runsDir, charOffset = 0,sourceEventId} = {}) {
  if(typeof sessionId!=='string'||!SESSION_ID.test(sessionId))throw new Error('Invalid chat session id');
  if(!Number.isSafeInteger(messageIndex)||messageIndex<0)throw new Error('Invalid archive message index');
  if(!Number.isSafeInteger(charOffset)||charOffset<0)throw new Error('Invalid archive character offset');
  if(sourceEventId!==undefined&&(typeof sourceEventId!=='string'||! /^[\w.:-]{1,200}$/.test(sourceEventId)))throw new Error('Invalid archive message identity');
  const handle=await openSessionFile(runsSessionsDir(packageRoot,runsDir),sessionId,'transcript.jsonl');
  try{
    const before=await handle.stat();let index=0,result=null;
    await scanTranscript(handle,before.size,parseTranscriptRecord,record=>{
      const currentIndex=index++;
      if(sourceEventId?record.archive_source!=='thread_events'||record.source_event_id!==sourceEventId:currentIndex!==messageIndex)return;
      if(result)throw new Error('Archive message identity is ambiguous; refresh the conversation');
      if(charOffset>=record.content.length)throw new Error('Archive character offset is outside the message');
      const text=record.content.slice(charOffset,charOffset+250000);
      result={text,charOffset,totalCharacters:record.content.length,hasPrevious:charOffset>0,hasNext:charOffset+text.length<record.content.length,messageIndex:currentIndex,...(sourceEventId?{sourceEventId}:{})};
    });
    if(!result)throw new Error('Archived message is unavailable; refresh the conversation');
    const after=await handle.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Archive changed while loading; refresh the conversation');
    return result;
  }finally{await handle.close();}
}
