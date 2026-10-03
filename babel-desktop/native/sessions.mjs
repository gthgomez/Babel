import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SESSION_ID = /^[\w-]{1,80}$/;

/** Babel's own chat-session directory. This reader does not create a second store. */
export function runsSessionsDir(packageRoot) {
  return join(packageRoot, '..', 'runs', 'chat-sessions');
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
    messages.push({ role: value.role, text: content });
  }
  return messages;
}

export async function listSavedChats(packageRoot, { limit = 30 } = {}) {
  let names = [];
  try { names = await readdir(runsSessionsDir(packageRoot)); } catch { return []; }
  const sessions = [];
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue;
    const transcript = join(runsSessionsDir(packageRoot), name, 'transcript.jsonl');
    try {
      const info = await stat(transcript);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) continue;
      const messages = messagesFromTranscript(await readFile(transcript, 'utf8'));
      const lastUser = [...messages].reverse().find(message => message.role === 'user');
      const title = (lastUser?.text || 'Saved chat').replace(/\s+/g, ' ').trim().slice(0, 80);
      sessions.push({ id: name, title: title || 'Saved chat', mtimeMs: info.mtimeMs, messages: messages.length });
    } catch { /* A damaged session stays out of the list. */ }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions.slice(0, limit);
}

export async function readSavedChat(packageRoot, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('Invalid chat session id');
  const transcript = join(runsSessionsDir(packageRoot), sessionId, 'transcript.jsonl');
  const info = await stat(transcript);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Saved chat is unavailable');
  return { id: sessionId, messages: messagesFromTranscript(await readFile(transcript, 'utf8')) };
}
