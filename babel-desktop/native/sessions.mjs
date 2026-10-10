import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { statusFromTerminalOutcome } from '../src/core.mjs';

const SESSION_ID = /^[\w-]{1,80}$/;

/** Babel's own chat-session directory. This reader does not create a second store. */
export function runsSessionsDir(packageRoot, runsDir = process.env.BABEL_RUNS_DIR) {
  return runsDir ? join(runsDir, 'chat-sessions') : join(packageRoot, '..', 'runs', 'chat-sessions');
}

export function messagesFromTranscript(text) {
  const messages = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim() || messages.length >= 150) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') continue;
    const content = value.content.slice(0, 250000);
    if (!content.trim()) continue;
    const outcome = typeof value.terminal_outcome === 'string'
      ? value.terminal_outcome
      : typeof value.outcome === 'string'
        ? value.outcome
        : null;
    messages.push({
      role: value.role,
      text: content,
      ...(value.turn_id !== undefined && value.turn_id !== null ? {turn_id: value.turn_id} : {}),
      ...(value.role === 'assistant'
        ? {status: outcome ? statusFromTerminalOutcome(outcome) : 'unverified'}
        : {}),
    });
  }
  return messages;
}

/** Ordered terminal outcomes from durable session-events.jsonl when present. */
export async function terminalOutcomesFromSessionEvents(sessionDir) {
  const path = join(sessionDir, 'session-events.jsonl');
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

function applySessionEventOutcomes(messages, {ordered, byTurnId}) {
  const assistantCount = messages.filter(message => message.role === 'assistant').length;
  if (assistantCount === 0) return messages;
  if (byTurnId.size > 0) {
    let assistantOrdinal = 0;
    return messages.map(message => {
      if (message.role !== 'assistant') return message;
      assistantOrdinal += 1;
      const turnKey = message.turn_id !== undefined && message.turn_id !== null
        ? String(message.turn_id)
        : String(assistantOrdinal);
      const outcome = byTurnId.get(turnKey);
      if (typeof outcome !== 'string') return message;
      return {...message, status: statusFromTerminalOutcome(outcome)};
    });
  }
  if (!ordered.length || ordered.length !== assistantCount) return messages;
  let index = 0;
  return messages.map(message => {
    if (message.role !== 'assistant') return message;
    const outcome = ordered[index];
    index += 1;
    if (typeof outcome !== 'string') return message;
    return {...message, status: statusFromTerminalOutcome(outcome)};
  });
}

export async function listSavedChats(packageRoot, { limit = 30, runsDir } = {}) {
  let names = [];
  try { names = await readdir(runsSessionsDir(packageRoot, runsDir)); } catch { return []; }
  const sessions = [];
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue;
    const transcript = join(runsSessionsDir(packageRoot, runsDir), name, 'transcript.jsonl');
    try {
      const info = await stat(transcript);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) continue;
      const messages = messagesFromTranscript(await readFile(transcript, 'utf8'));
      const firstUser = messages.find(message => message.role === 'user');
      const title = (firstUser?.text || 'Saved chat').replace(/\s+/g, ' ').trim().slice(0, 80);
      sessions.push({ id: name, title: title || 'Saved chat', mtimeMs: info.mtimeMs, messages: messages.length });
    } catch { /* A damaged session stays out of the list. */ }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions.slice(0, limit);
}

export async function readSavedChat(packageRoot, sessionId, {runsDir} = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('Invalid chat session id');
  const transcript = join(runsSessionsDir(packageRoot, runsDir), sessionId, 'transcript.jsonl');
  const info = await stat(transcript);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Saved chat is unavailable');
  const sessionDir = join(runsSessionsDir(packageRoot, runsDir), sessionId);
  const transcriptMessages = messagesFromTranscript(await readFile(transcript, 'utf8'));
  const outcomeIndex = await terminalOutcomesFromSessionEvents(sessionDir);
  return {
    id: sessionId,
    messages: applySessionEventOutcomes(transcriptMessages, outcomeIndex),
  };
}
