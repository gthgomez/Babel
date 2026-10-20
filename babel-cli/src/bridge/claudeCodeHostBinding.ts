import type { SessionDescriptor } from '../executor/contracts.js';
import type { ProtocolHostState } from '../protocol/client/host.js';
import {
  assertResumeClaudeAdmissionCompatible,
  type ClaudeCodeAdmittedSession,
} from './claudeCodeAdmission.js';
import { admitClaudeCodeSession } from './claudeCodeSessionAdmission.js';

export function claudeAdmissionInputFromDescriptor(
  descriptor: SessionDescriptor,
): import('./claudeCodeAdmission.js').ClaudeCodeAdmissionInput | null {
  if (descriptor.harness_adapter_id !== 'claude-code') return null;
  return {
    harness_adapter_id: 'claude-code',
    harness_provider_profile: descriptor.harness_provider_profile ?? '',
    harness_model_profile: descriptor.harness_model_profile ?? descriptor.model ?? '',
    harness_credential_ref: descriptor.harness_credential_ref ?? '',
    harness_config_root: descriptor.harness_config_root ?? '',
    project_root: descriptor.projectRoot,
    ...(descriptor.harness_native_session_id
      ? { harness_native_session_id: descriptor.harness_native_session_id }
      : {}),
    ...(descriptor.harness_admission_digest
      ? { resume_expected_digest: descriptor.harness_admission_digest }
      : {}),
  };
}

export async function ensureClaudeCodeThreadAdmissionBound(
  state: ProtocolHostState,
  descriptor: SessionDescriptor,
): Promise<ClaudeCodeAdmittedSession | { error: string }> {
  if (descriptor.harness_adapter_id !== 'claude-code') {
    return { error: 'not_claude_code' };
  }
  if (!state.claudeCodeRegistry) {
    return { error: 'Claude Code registry is not available on this host' };
  }
  const input = claudeAdmissionInputFromDescriptor(descriptor);
  if (!input) {
    return { error: 'Claude Code descriptor is incomplete' };
  }
  const admission = await admitClaudeCodeSession(input, state.claudeCodeAdmissionDeps);
  if (admission.status === 'rejected') {
    return { error: `${admission.reason}: ${admission.detail}` };
  }
  const existing = state.claudeCodeRegistry.getAdmitted(descriptor.threadId);
  if (existing) {
    const compat = assertResumeClaudeAdmissionCompatible(existing, admission.admitted);
    if (compat.status === 'rejected') {
      return { error: `${compat.reason}: ${compat.detail}` };
    }
  }
  state.claudeCodeRegistry.bindAdmitted(descriptor.threadId, admission.admitted);
  return admission.admitted;
}
