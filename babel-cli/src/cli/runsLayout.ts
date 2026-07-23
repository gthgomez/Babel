/**
 * Canonical runs-directory layout — all chat/thread path resolution at call time.
 * D modules must use these helpers instead of import-time BABEL_RUNS_DIR snapshots.
 */

import { join } from 'node:path';

import { BABEL_ROOT } from './constants.js';

const CHAT_SESSIONS = 'chat-sessions';
const THREADS = 'threads';
const TRANSCRIPT_FILE = 'transcript.jsonl';

/** Resolve runs directory at call time (honours per-test BABEL_RUNS_DIR overrides). */
export function resolveBabelRunsDir(): string {
  return process.env['BABEL_RUNS_DIR'] ?? join(BABEL_ROOT, 'runs');
}

export function chatSessionsDir(): string {
  return join(resolveBabelRunsDir(), CHAT_SESSIONS);
}

export function chatSessionDir(sessionId: string): string {
  return join(chatSessionsDir(), sessionId);
}

export function transcriptPath(sessionId: string): string {
  return join(chatSessionDir(sessionId), TRANSCRIPT_FILE);
}

export function threadsDir(): string {
  return join(resolveBabelRunsDir(), THREADS);
}

export function threadDir(threadId: string): string {
  return join(threadsDir(), threadId);
}