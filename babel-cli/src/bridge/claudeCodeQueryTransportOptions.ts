import type { Settings } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeCodeAdmittedSession } from './claudeCodeAdmission.js';
import type { ClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import { loadClaudeAgentSdkPin } from './claudeCodeSdkPin.js';

/** Pinned SDK {@link Options.strictMcpConfig} — maps to CLI `--strict-mcp-config`. */
export type ClaudeQueryTransportOptions = {
  cwd: string;
  projectConfigRoot: string;
  model: string;
  pathToClaudeCodeExecutable: string;
  settingSources: [];
  permissionMode: 'default';
  permissionPrompts: 'host';
  managedSettings: Settings;
  strictMcpConfig: true;
};

/**
 * SDK 0.3.304 exposes `strictMcpConfig` on `query()` options (not on resolveSettings).
 * Admission fails closed when the pinned SDK or launch spec cannot set it.
 */
export function assertClaudeStrictMcpQueryTransportAvailable(
  launchSpec: ClaudeCodeLaunchPolicySpec,
): { ok: true } | { ok: false; detail: string } {
  if (launchSpec.strictMcpConfig !== true) {
    return {
      ok: false,
      detail: 'strictMcpConfig query transport option is required but not true on launch spec',
    };
  }
  const pin = loadClaudeAgentSdkPin();
  if (pin.sdkVersion !== '0.3.304') {
    return {
      ok: false,
      detail: `strictMcpConfig query option not certified for SDK pin ${pin.sdkVersion}`,
    };
  }
  return { ok: true };
}

export function buildClaudeCodeQueryTransportOptions(input: {
  admitted: ClaudeCodeAdmittedSession;
  policy: ClaudeCodeLaunchPolicySpec;
}): ClaudeQueryTransportOptions {
  const gate = assertClaudeStrictMcpQueryTransportAvailable(input.policy);
  if (!gate.ok) {
    throw new Error(gate.detail);
  }
  return {
    cwd: input.admitted.cwd,
    projectConfigRoot: input.admitted.project_policy_root,
    model: input.admitted.harness_model_profile,
    pathToClaudeCodeExecutable: input.admitted.cli_executable_path,
    settingSources: input.policy.settingSources,
    permissionMode: input.policy.permissionMode,
    permissionPrompts: input.policy.permissionPrompts,
    managedSettings: input.policy.managedSettings as Settings,
    strictMcpConfig: true,
  };
}
