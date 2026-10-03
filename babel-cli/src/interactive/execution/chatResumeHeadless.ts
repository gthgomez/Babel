import { existsSync } from 'node:fs';

import { ChatEngine, type ChatEngineOptions } from '../../agent/chatEngine.js';
import { loadThreadEventLogFromDir, validateRepoIdentityOnResume } from '../../agent/threadEventLog.js';
import { chatSessionDir, transcriptPath } from '../../cli/runsLayout.js';

const SESSION_ID = /^[\w-]{1,80}$/;

/** Session ids are a single path segment. They never include separators. */
export function isSafeChatSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

/**
 * Restore one persisted chat engine for a later `babel run`.
 * Refuses an id that is not a safe segment, a missing transcript, or a
 * repository identity Babel cannot verify.
 */
export async function openResumedChatEngine(
  sessionId: string,
  options: ChatEngineOptions,
): Promise<ChatEngine> {
  if (!isSafeChatSessionId(sessionId)) {
    throw new Error('Chat session id is not valid.');
  }
  if (!existsSync(transcriptPath(sessionId))) {
    throw new Error(`Chat session ${sessionId} has no transcript to resume. Start a new session.`);
  }
  const identity = validateRepoIdentityOnResume(
    loadThreadEventLogFromDir(chatSessionDir(sessionId)),
    options.projectRoot,
  );
  if (!identity.ok) {
    throw new Error(`Cannot resume chat session ${sessionId}: ${identity.reason}`);
  }
  return ChatEngine.restore(sessionId, options);
}
