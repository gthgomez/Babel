/**
 * Canonical runs-directory layout — all chat/thread path resolution at call time.
 * D modules must use these helpers instead of import-time BABEL_RUNS_DIR snapshots.
 */

import { join } from 'node:path';

import { openAdmissionStore, type AdmissionOpenResult } from '../runtime/admission.js';
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

/**
 * Open (or take a shared reference to) the durable P05 admission store bound
 * to one chat session directory. The authorized root is the runs root —
 * `chatSessionDir` always resolves inside it — and concurrent opens of the
 * same session share a single SQLite handle (refcounted; see
 * `openAdmissionStore`). On failure the result is `ok:false` and callers must
 * degrade fail-closed (no store → no owner → checkpoints stay inert).
 *
 * Open/close sites (host owns the lifetime): interactive fresh sessions
 * (chatTransport), headless runs (chatCore), resume (chatSessionResume),
 * protocol host materialization (protocol/client/host), one-shot chat
 * (agent/session), workflow node attempts (interactive/commands/workflow).
 */
export function openSessionAdmissionStore(sessionId: string): AdmissionOpenResult {
  return openAdmissionStore({
    authorizedRoot: resolveBabelRunsDir(),
    runDir: chatSessionDir(sessionId),
  });
}

export function threadsDir(): string {
  return join(resolveBabelRunsDir(), THREADS);
}

export function threadDir(threadId: string): string {
  return join(threadsDir(), threadId);
}