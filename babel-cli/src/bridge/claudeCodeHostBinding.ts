import type { SessionDescriptor } from '../executor/contracts.js';
import type { ProtocolHostState } from '../protocol/client/host.js';
import {
  type ClaudeCodeAdmissionInput,
  type ClaudeCodeAdmittedSession,
} from './claudeCodeAdmission.js';
import { resolveClaudeCodeTrustedLaunchFields } from './claudeCodeHostLaunchRegistry.js';
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
    project_policy_root: descriptor.harness_project_policy_root ?? descriptor.projectRoot,
    project_root: descriptor.projectRoot,
    ...(descriptor.harness_native_session_id
      ? { harness_native_session_id: descriptor.harness_native_session_id }
      : {}),
    ...(descriptor.harness_admission_digest
      ? { resume_expected_digest: descriptor.harness_admission_digest }
      : {}),
  };
}

function enrichClaudeAdmissionFromHostRegistry(
  input: ClaudeCodeAdmissionInput,
  state: ProtocolHostState,
): ClaudeCodeAdmissionInput | { error: string } {
  const registry = state.claudeCodeHostLaunchRegistry;
  if (!registry) return input;
  const trusted = resolveClaudeCodeTrustedLaunchFields({
    registry,
    harness_provider_profile: input.harness_provider_profile,
    project_root: input.project_root,
  });
  if (!trusted.ok) {
    return { error: trusted.detail };
  }
  return {
    ...input,
    harness_model_profile: trusted.harness_model_profile,
    harness_credential_ref: trusted.harness_credential_ref,
    harness_config_root: trusted.harness_config_root,
    project_policy_root: trusted.project_policy_root,
    trusted_auth_host_env: trusted.binding.auth_host_env,
    trusted_auth_child_env: trusted.binding.auth_child_env,
    ...(trusted.binding.endpoint_env ? { endpoint_env: trusted.binding.endpoint_env } : {}),
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
  const existing = state.claudeCodeRegistry.getAdmitted(descriptor.threadId);
  if (existing) {
    if (
      descriptor.harness_admission_digest &&
      descriptor.harness_admission_digest !== existing.admission_digest
    ) {
      return { error: 'resume_digest_mismatch: descriptor admission digest drift' };
    }
    return existing;
  }
  const baseInput = claudeAdmissionInputFromDescriptor(descriptor);
  if (!baseInput) {
    return { error: 'Claude Code descriptor is incomplete' };
  }
  const enriched = enrichClaudeAdmissionFromHostRegistry(baseInput, state);
  if ('error' in enriched) {
    return enriched;
  }
  const admission = await admitClaudeCodeSession(enriched, state.claudeCodeAdmissionDeps);
  if (admission.status === 'rejected') {
    return { error: `${admission.reason}: ${admission.detail}` };
  }
  state.claudeCodeRegistry.bindAdmitted(descriptor.threadId, admission.admitted);
  return admission.admitted;
}
