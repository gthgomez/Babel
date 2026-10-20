import {
  evaluateClaudeCodeAdmission,
  type ClaudeCodeAdmissionInput,
  type ClaudeCodeAdmissionResult,
  type ClaudeCodeAdmittedSession,
} from './claudeCodeAdmission.js';
import { probeClaudeSdkIntegrity } from './claudeCodeIntegrity.js';
import { resolveClaudeCodePolicyEvidence } from './claudeCodePolicyEvidence.js';

export interface ClaudeCodeSessionAdmissionDeps {
  integrityProbe?: () => ReturnType<typeof probeClaudeSdkIntegrity>;
  resolveSettings?: (opts: {
    cwd: string;
    settingSources: [];
    managedSettings: Record<string, unknown>;
  }) => Promise<{ effective?: Record<string, unknown> }>;
}

export async function admitClaudeCodeSession(
  input: ClaudeCodeAdmissionInput,
  deps?: ClaudeCodeSessionAdmissionDeps,
): Promise<ClaudeCodeAdmissionResult> {
  return evaluateClaudeCodeAdmission(input, {
    integrityProbe: deps?.integrityProbe ?? (() => probeClaudeSdkIntegrity()),
    resolvePolicyEvidence: (evidenceInput) =>
      resolveClaudeCodePolicyEvidence({
        cwd: evidenceInput.cwd,
        config_root: evidenceInput.config_root,
        provider_profile: evidenceInput.provider_profile,
        ...(deps?.resolveSettings ? { resolveSettings: deps.resolveSettings } : {}),
      }),
  });
}

export type { ClaudeCodeAdmittedSession };
