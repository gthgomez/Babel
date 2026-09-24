/**
 * Chat mode adapter — the existing ChatEngine controller behind the shared
 * runtime facade.
 *
 * This adapter routes; it does not add authority. The chat kernel, completion
 * gate, tool capability policy, verifier authority and Prompt OS boundaries are
 * unchanged. The only job here is to bind a Chat turn to its subject so the
 * coordinator can guarantee one controller per turn.
 */

import { resolveModeCapability } from '../../executor/modeAdapters.js';
import {
  RuntimeSubjectUnavailableError,
  type RuntimeModeAdapter,
  type RuntimeTurnRequest,
} from '../contracts.js';

export function requireRuntimeSubject(request: RuntimeTurnRequest) {
  if (!request.subject) {
    throw new RuntimeSubjectUnavailableError(request.prepared.mode);
  }
  return request.subject;
}

/** Chat controller: normal mutation policy, executor completion. */
export function createChatRuntimeAdapter(): RuntimeModeAdapter {
  return {
    mode: 'chat',
    controller: 'chat_engine',
    capability: resolveModeCapability('chat'),
    async *submit(request) {
      const subject = requireRuntimeSubject(request);
      yield* subject.submitMessageStream(request.task, request.intent);
    },
    async cancel(request) {
      requireRuntimeSubject(request).cancel?.();
    },
  };
}
