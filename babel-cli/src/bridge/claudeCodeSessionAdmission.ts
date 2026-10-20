import {
  evaluateClaudeCodeAdmission,
  type ClaudeCodeAdmissionInput,
  type ClaudeCodeAdmissionResult,
  type ClaudeCodeAdmittedSession,
} from './claudeCodeAdmission.js';
import { probeClaudeSdkIntegrity } from './claudeCodeIntegrity.js';
import {
  defaultClaudeResolveSettings,
  resolveClaudeCodePolicyEvidence,
  type ClaudeResolveSettingsFn,
} from './claudeCodePolicyEvidence.js';

export interface ClaudeCodeSessionAdmissionDeps {
  integrityProbe?: () => ReturnType<typeof probeClaudeSdkIntegrity>;
  resolveSettings?: ClaudeResolveSettingsFn;
}

export async function admitClaudeCodeSession(
  input: ClaudeCodeAdmissionInput,
  deps?: ClaudeCodeSessionAdmissionDeps,
): Promise<ClaudeCodeAdmissionResult> {
  const resolveSettings = deps?.resolveSettings ?? defaultClaudeResolveSettings;
  return evaluateClaudeCodeAdmission(input, {
    integrityProbe: deps?.integrityProbe ?? (() => probeClaudeSdkIntegrity()),
    resolvePolicyEvidence: (evidenceInput) =>
      resolveClaudeCodePolicyEvidence({
        cwd: evidenceInput.cwd,
        config_root: evidenceInput.config_root,
        project_policy_root: evidenceInput.project_policy_root,
        provider_profile: evidenceInput.provider_profile,
        ...(evidenceInput.endpoint_env ? { endpoint_env: evidenceInput.endpoint_env } : {}),
        resolveSettings,
      }),
  });
}

export type { ClaudeCodeAdmittedSession };
