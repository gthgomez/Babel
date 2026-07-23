/**
 * Index chat sessions under runs/chat-sessions + runs/threads for resume picker UI.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

import { chatSessionsDir, transcriptPath } from '../cli/runsLayout.js';
import { listThreads, threadStoreExists } from './threadStore/index.js';

export interface ChatSessionInfo {
  id: string;
  mtimeMs: number;
  turnCount: number;
  preview: string;
  transcriptPath: string;
  /** True when HistoryCells exist in runs/threads/{id}/ */
  hasThreadStore?: boolean;
}

function previewFromTranscript(txPath: string): { turnCount: number; preview: string } {
  try {
    const lines = readFileSync(txPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    let turnCount = 0;
    let lastUser = '';
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as { role?: string; content?: string };
        if (msg.role === 'user' || msg.role === 'assistant') {
          turnCount++;
        }
        if (msg.role === 'user' && typeof msg.content === 'string') {
          lastUser = msg.content;
        }
      } catch {
        /* skip malformed */
      }
    }
    const preview =
      lastUser.length > 72 ? `${lastUser.slice(0, 69)}…` : lastUser || '(no user messages)';
    return { turnCount, preview };
  } catch {
    return { turnCount: 0, preview: '(unreadable transcript)' };
  }
}

export function listChatSessions(options?: { limit?: number }): ChatSessionInfo[] {
  const sessionsDir = chatSessionsDir();
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const entries = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const id = e.name;
      const txPath = transcriptPath(id);
      if (!existsSync(txPath)) {
        return null;
      }
      const st = statSync(txPath);
      const { turnCount, preview } = previewFromTranscript(txPath);
      return {
        id,
        mtimeMs: st.mtimeMs,
        turnCount,
        preview,
        transcriptPath: txPath,
      } satisfies ChatSessionInfo;
    })
    .filter((s): s is ChatSessionInfo => s !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const limit = options?.limit ?? 50;
  return entries.slice(0, limit);
}

/** Merge transcript-indexed sessions with thread-store metadata (thread preview wins). */
export async function listResumableSessions(options?: { limit?: number }): Promise<ChatSessionInfo[]> {
  const limit = options?.limit ?? 50;
  const byId = new Map<string, ChatSessionInfo>();

  for (const thread of await listThreads({ limit })) {
    byId.set(thread.thread_id, {
      id: thread.thread_id,
      mtimeMs: thread.updated_at,
      turnCount: thread.turn_count,
      preview: thread.preview ?? '(thread store)',
      transcriptPath: transcriptPath(thread.thread_id),
      hasThreadStore: true,
    });
  }

  for (const session of listChatSessions({ limit })) {
    const existing = byId.get(session.id);
    if (existing) {
      existing.mtimeMs = Math.max(existing.mtimeMs, session.mtimeMs);
      existing.transcriptPath = session.transcriptPath;
      continue;
    }
    byId.set(session.id, {
      ...session,
      hasThreadStore: threadStoreExists(session.id),
    });
  }

  return [...byId.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}