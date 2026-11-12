import { existsSync } from 'node:fs';

import { ChatEngine, type ChatEngineOptions } from '../../agent/chatEngine.js';
import { loadThreadEventLogFromDir, validateRepoIdentityOnResume } from '../../agent/threadEventLog.js';
import { chatSessionDir, openSessionAdmissionStore, transcriptPath } from '../../cli/runsLayout.js';
import {assertConversationRestoreScope,normalizeChatExecutionScope,requireProjectRoot} from '../../agent/chatExecutionScope.js';
import {recoverCheckpointArtifacts} from '../../agent/liveSessionBridge.js';
import { acquireSessionPolicyLease, type SessionPolicyLease } from '../../config/sessionPolicyLease.js';
import { constrainNewSessionPolicy, recordResumedSessionMigration, resolveResumedSessionPolicy } from '../../config/sessionExecutionPolicy.js';
import { resolveExecutionPolicyChoice, withExecutionPolicyChoice } from '../../config/executionPolicySelection.js';

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
  ownership: { lease?: SessionPolicyLease; onAdopted?: () => void } = {},
): Promise<ChatEngine> {
  if (!isSafeChatSessionId(sessionId)) {
    throw new Error('Chat session id is not valid.');
  }
  if (!existsSync(transcriptPath(sessionId))) {
    throw new Error(`Chat session ${sessionId} has no transcript to resume. Start a new session.`);
  }
  const lease=ownership.lease ?? acquireSessionPolicyLease(sessionId);
  if (lease.sessionId!==sessionId) throw new Error('Session ownership does not match the requested session.');
  let engine:ChatEngine | undefined;
  let openedAdmission:ReturnType<typeof openSessionAdmissionStore> | undefined;
  try {
    recoverCheckpointArtifacts(chatSessionDir(sessionId));
    const log=loadThreadEventLogFromDir(chatSessionDir(sessionId));
    assertConversationRestoreScope(log,options);
    if(normalizeChatExecutionScope(options).kind==='project'){
      const identity = validateRepoIdentityOnResume(log,requireProjectRoot(options));
      if (!identity.ok)throw new Error(`Cannot resume chat session ${sessionId}: ${identity.reason}`);
    }
    const requested=options.executionPolicy?.source==='migration'||options.executionPolicy?.source==='explicit'
      ? options.executionPolicy.profile : undefined;
    const conversationScope=normalizeChatExecutionScope(options).kind==='conversation';
    let policy;
    try { policy=resolveResumedSessionPolicy(sessionId,requested); }
    catch (error) {
      // Conversation scope admits no project execution, so an unrecorded
      // legacy boundary cannot broaden authority. Pin the ordinary implicit
      // policy instead of inventing a prior project boundary.
      if (!conversationScope || !/no proven execution policy/i.test(error instanceof Error?error.message:'')) throw error;
      policy=constrainNewSessionPolicy(resolveExecutionPolicyChoice({
        ...(requested!==undefined?{explicitProfile:requested}:{}),
        ...(process.env['BABEL_EXECUTION_PROFILE']!==undefined?{environmentProfile:process.env['BABEL_EXECUTION_PROFILE']}:{}),
        defaultProfile:'host_native',
      }));
    }
    if(options.executionPolicy && (policy.profile!==options.executionPolicy.profile || policy.expectedBoundary!==options.executionPolicy.expectedBoundary)){
      throw new Error('Session execution policy changed while opening; retry after reviewing the selection.');
    }
    if (!options.admissionStore) {
      openedAdmission=openSessionAdmissionStore(sessionId);
      if (!openedAdmission.ok) throw new Error('Session admission evidence is unavailable; inspect the session before continuing.');
    }
    engine=await withExecutionPolicyChoice(policy,()=>ChatEngine.restore(sessionId,{
      ...options,executionPolicy:policy,
      ...(openedAdmission?.ok ? {admissionStore:openedAdmission.store} : {}),
    }));
    // Conversation scope admits no project execution, so it has no project
    // boundary to migrate or prove. Never persist a Docker migration for it.
    if (!conversationScope) recordResumedSessionMigration(sessionId,policy);
    engine.attachSessionPolicyLease(lease);
    ownership.onAdopted?.();
    return engine;
  } catch(error) {
    engine?.closeAdmissionStore();
    if (!engine && openedAdmission?.ok) openedAdmission.store.close();
    lease.release();
    throw error;
  }
}
