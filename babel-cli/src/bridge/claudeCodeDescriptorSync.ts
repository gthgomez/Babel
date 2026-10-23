import type { SessionDescriptor } from '../executor/contracts.js';
import {
  claudeAdmittedWithNativeSession,
  type ClaudeCodeAdmittedSession,
} from './claudeCodeAdmission.js';
import type { ClaudeCodeAgentRuntimeRegistry } from './claudeCodeAgentRuntime.js';

/**
 * Atomically sync native session id + recomputed admission digest to registry and descriptor.
 */
export function syncClaudeNativeSessionToDescriptor(input: {
  registry: ClaudeCodeAgentRuntimeRegistry;
  descriptor: SessionDescriptor;
  nativeSessionId: string;
}): ClaudeCodeAdmittedSession | undefined {
  const prior = input.registry.getAdmitted(input.descriptor.threadId);
  if (!prior) return undefined;
  const admitted = claudeAdmittedWithNativeSession(prior, input.nativeSessionId);
  input.registry.bindAdmitted(input.descriptor.threadId, admitted);
  if (admitted.harness_native_session_id) {
    input.descriptor.harness_native_session_id = admitted.harness_native_session_id;
  }
  input.descriptor.harness_admission_digest = admitted.admission_digest;
  return admitted;
}
