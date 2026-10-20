import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import type { HarnessAdapterId } from './harnessAdapterContract.js';
import { loadClaudeAgentSdkPin } from './claudeCodeSdkPin.js';
import type { ClaudeSdkIntegrityProbe } from './claudeCodeIntegrity.js';

export const CLAUDE_HARNESS_PROVIDER_PROFILES = [
  EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
  EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo,
] as const;

export type ClaudeHarnessProviderProfile = (typeof CLAUDE_HARNESS_PROVIDER_PROFILES)[number];

export interface ClaudeCodeAdmissionInput {
  harness_adapter_id: HarnessAdapterId;
  harness_provider_profile: string;
  harness_model_profile: string;
  harness_credential_ref: string;
  harness_config_root: string;
  project_policy_root?: string;
  trusted_auth_host_env?: string;
  trusted_auth_child_env?: string;
  endpoint_env?: Record<string, string>;
  project_root: string;
  harness_native_session_id?: string;
  resume_expected_digest?: string;
}

export interface ClaudeCodeAdmittedSession {
  harness_adapter_id: 'claude-code';
  harness_provider_profile: ClaudeHarnessProviderProfile;
  harness_model_profile: string;
  harness_credential_ref: string;
  harness_config_root: string;
  /** SDK projectConfigRoot / project policy tree (distinct from config HOME). */
  project_policy_root: string;
  trusted_auth_host_env: string;
  trusted_auth_child_env: string;
  cwd: string;
  sdk_version: string;
  cli_version: string;
  cli_executable_path: string;
  policy_digest: string;
  admission_digest: string;
  harness_native_session_id?: string;
}

export type ClaudeCodeAdmissionRejectReason =
  | 'harness_mismatch'
  | 'profile_unsupported'
  | 'model_missing'
  | 'credential_ref_missing'
  | 'config_root_missing'
  | 'config_root_not_directory'
  | 'cwd_missing'
  | 'sdk_integrity_failed'
  | 'policy_unresolved'
  | 'policy_drift'
  | 'resume_digest_mismatch'
  | 'resume_native_session_missing';

export type ClaudeCodeAdmissionResult =
  | { status: 'qualified'; admitted: ClaudeCodeAdmittedSession }
  | { status: 'rejected'; reason: ClaudeCodeAdmissionRejectReason; detail: string };

export interface ClaudeCodePolicyResolverEvidence {
  ok: boolean;
  digest: string;
  detail?: string;
}

export interface ClaudeCodeAdmissionDeps {
  integrityProbe: () => Promise<ClaudeSdkIntegrityProbe>;
  resolvePolicyEvidence: (input: {
    cwd: string;
    config_root: string;
    project_policy_root: string;
    provider_profile: ClaudeHarnessProviderProfile;
    endpoint_env?: Record<string, string>;
  }) => Promise<ClaudeCodePolicyResolverEvidence>;
}

function stableDigest(parts: Record<string, string>): string {
  const payload = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash('sha256').update(payload).digest('hex');
}

function isProviderProfile(value: string): value is ClaudeHarnessProviderProfile {
  return (CLAUDE_HARNESS_PROVIDER_PROFILES as readonly string[]).includes(value);
}

export function computeAdmissionDigest(admitted: Omit<ClaudeCodeAdmittedSession, 'admission_digest'>): string {
  return stableDigest({
    harness_adapter_id: admitted.harness_adapter_id,
    harness_provider_profile: admitted.harness_provider_profile,
    harness_model_profile: admitted.harness_model_profile,
    harness_credential_ref: admitted.harness_credential_ref,
    harness_config_root: admitted.harness_config_root,
    project_policy_root: admitted.project_policy_root,
    trusted_auth_host_env: admitted.trusted_auth_host_env,
    trusted_auth_child_env: admitted.trusted_auth_child_env,
    cwd: admitted.cwd,
    sdk_version: admitted.sdk_version,
    cli_version: admitted.cli_version,
    cli_executable_path: admitted.cli_executable_path,
    policy_digest: admitted.policy_digest,
    ...(admitted.harness_native_session_id
      ? { harness_native_session_id: admitted.harness_native_session_id }
      : {}),
  });
}

export async function evaluateClaudeCodeAdmission(
  input: ClaudeCodeAdmissionInput,
  deps: ClaudeCodeAdmissionDeps,
): Promise<ClaudeCodeAdmissionResult> {
  if (input.harness_adapter_id !== 'claude-code') {
    return {
      status: 'rejected',
      reason: 'harness_mismatch',
      detail: 'harness_adapter_id must be claude-code',
    };
  }
  if (!isProviderProfile(input.harness_provider_profile)) {
    return {
      status: 'rejected',
      reason: 'profile_unsupported',
      detail: `Unsupported harness_provider_profile: ${input.harness_provider_profile}`,
    };
  }
  const model = input.harness_model_profile?.trim();
  if (!model) {
    return { status: 'rejected', reason: 'model_missing', detail: 'harness_model_profile is required' };
  }
  const credentialRef = input.harness_credential_ref?.trim();
  if (!credentialRef) {
    return {
      status: 'rejected',
      reason: 'credential_ref_missing',
      detail: 'harness_credential_ref is required',
    };
  }
  const configRootRaw = input.harness_config_root?.trim();
  if (!configRootRaw) {
    return {
      status: 'rejected',
      reason: 'config_root_missing',
      detail: 'harness_config_root is required',
    };
  }
  let configRoot: string;
  try {
    configRoot = realpathSync(resolve(configRootRaw));
  } catch {
    return {
      status: 'rejected',
      reason: 'config_root_missing',
      detail: 'harness_config_root does not exist',
    };
  }
  if (!statSync(configRoot).isDirectory()) {
    return {
      status: 'rejected',
      reason: 'config_root_not_directory',
      detail: 'harness_config_root must be a directory',
    };
  }
  let cwd: string;
  try {
    cwd = realpathSync(resolve(input.project_root));
  } catch {
    return { status: 'rejected', reason: 'cwd_missing', detail: 'project_root does not exist' };
  }
  if (!existsSync(cwd)) {
    return { status: 'rejected', reason: 'cwd_missing', detail: 'project_root does not exist' };
  }
  let projectPolicyRoot: string;
  const policyRootRaw = input.project_policy_root?.trim();
  if (policyRootRaw) {
    try {
      projectPolicyRoot = realpathSync(resolve(policyRootRaw));
    } catch {
      return {
        status: 'rejected',
        reason: 'config_root_missing',
        detail: 'project_policy_root does not exist',
      };
    }
    if (!statSync(projectPolicyRoot).isDirectory()) {
      return {
        status: 'rejected',
        reason: 'config_root_not_directory',
        detail: 'project_policy_root must be a directory',
      };
    }
  } else {
    projectPolicyRoot = cwd;
  }

  const integrity = await deps.integrityProbe();
  const pin = loadClaudeAgentSdkPin();
  if (
    integrity.state !== 'verified' ||
    integrity.sdkVersion !== pin.sdkVersion ||
    integrity.cliVersion !== pin.cliVersion ||
    !integrity.executablePath
  ) {
    return {
      status: 'rejected',
      reason: 'sdk_integrity_failed',
      detail: integrity.detail ?? 'SDK/CLI pin integrity check failed',
    };
  }

  const authHost = input.trusted_auth_host_env?.trim();
  const authChild = input.trusted_auth_child_env?.trim();
  if (!authHost || !authChild) {
    return {
      status: 'rejected',
      reason: 'credential_ref_missing',
      detail: 'trusted auth env binding is required',
    };
  }

  const policy = await deps.resolvePolicyEvidence({
    cwd,
    config_root: configRoot,
    project_policy_root: projectPolicyRoot,
    provider_profile: input.harness_provider_profile,
    ...(input.endpoint_env ? { endpoint_env: input.endpoint_env } : {}),
  });
  if (!policy.ok) {
    return {
      status: 'rejected',
      reason: 'policy_unresolved',
      detail: policy.detail ?? 'Effective policy composition could not be resolved',
    };
  }

  if (input.resume_expected_digest) {
    const native = input.harness_native_session_id?.trim();
    if (!native) {
      return {
        status: 'rejected',
        reason: 'resume_native_session_missing',
        detail: 'harness_native_session_id required for resume admission',
      };
    }
  }

  const base: Omit<ClaudeCodeAdmittedSession, 'admission_digest'> = {
    harness_adapter_id: 'claude-code',
    harness_provider_profile: input.harness_provider_profile,
    harness_model_profile: model,
    harness_credential_ref: credentialRef,
    harness_config_root: configRoot,
    project_policy_root: projectPolicyRoot,
    trusted_auth_host_env: authHost,
    trusted_auth_child_env: authChild,
    cwd,
    sdk_version: pin.sdkVersion,
    cli_version: pin.cliVersion,
    cli_executable_path: integrity.executablePath,
    policy_digest: policy.digest,
    ...(input.harness_native_session_id
      ? { harness_native_session_id: input.harness_native_session_id.trim() }
      : {}),
  };
  const admission_digest = computeAdmissionDigest(base);
  if (input.resume_expected_digest && input.resume_expected_digest !== admission_digest) {
    return {
      status: 'rejected',
      reason: 'resume_digest_mismatch',
      detail: 'Resume tuple does not match frozen admission digest',
    };
  }

  return { status: 'qualified', admitted: { ...base, admission_digest } };
}

export function assertResumeClaudeAdmissionCompatible(
  persisted: ClaudeCodeAdmittedSession,
  candidate: ClaudeCodeAdmittedSession,
): ClaudeCodeAdmissionResult {
  if (persisted.admission_digest !== candidate.admission_digest) {
    return {
      status: 'rejected',
      reason: 'resume_digest_mismatch',
      detail: 'Admission digest mismatch on resume',
    };
  }
  if (
    persisted.harness_native_session_id &&
    candidate.harness_native_session_id &&
    persisted.harness_native_session_id !== candidate.harness_native_session_id
  ) {
    return {
      status: 'rejected',
      reason: 'resume_digest_mismatch',
      detail: 'Native session id mismatch on resume',
    };
  }
  if (persisted.policy_digest !== candidate.policy_digest) {
    return {
      status: 'rejected',
      reason: 'policy_drift',
      detail: 'Policy digest drift on resume',
    };
  }
  return { status: 'qualified', admitted: candidate };
}
