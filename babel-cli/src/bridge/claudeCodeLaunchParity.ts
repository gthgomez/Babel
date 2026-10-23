import { createHash } from 'node:crypto';

import type { ClaudeCodeAdmittedSession } from './claudeCodeAdmission.js';
import type { ClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import { buildClaudeCodeChildEnv } from './claudeCodeChildEnv.js';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Fields that must match between admission policy proof and live `query()` launch. */
export interface ClaudeLaunchParityBinding {
  cwd: string;
  projectConfigRoot: string;
  claudeConfigDir: string;
  settingSources: readonly [];
  permissionMode: 'default';
  permissionPrompts: 'host';
  strictMcpConfig: true;
  managedSettings: Record<string, unknown>;
  childEnvPolicyKeys: string[];
}

export function collectClaudeLaunchParityBinding(input: {
  admitted: ClaudeCodeAdmittedSession;
  policy: ClaudeCodeLaunchPolicySpec;
  credentialEnv: Record<string, string>;
}): ClaudeLaunchParityBinding {
  const childEnv = buildClaudeCodeChildEnv({
    admitted: input.admitted,
    policy: input.policy,
    credentialEnv: input.credentialEnv,
  });
  return {
    cwd: input.admitted.cwd,
    projectConfigRoot: input.admitted.project_policy_root,
    claudeConfigDir: childEnv.CLAUDE_CONFIG_DIR ?? input.admitted.harness_config_root,
    settingSources: input.policy.settingSources,
    permissionMode: input.policy.permissionMode,
    permissionPrompts: input.policy.permissionPrompts,
    strictMcpConfig: input.policy.strictMcpConfig,
    managedSettings: input.policy.managedSettings,
    childEnvPolicyKeys: Object.keys(childEnv).sort(),
  };
}

export function digestClaudeLaunchParityBinding(binding: ClaudeLaunchParityBinding): string {
  return sha256(stableJson(binding));
}

export function assertClaudeLaunchParity(input: {
  admitted: ClaudeCodeAdmittedSession;
  policy: ClaudeCodeLaunchPolicySpec;
  credentialEnv: Record<string, string>;
}): { ok: true; binding: ClaudeLaunchParityBinding; digest: string } | { ok: false; detail: string } {
  const binding = collectClaudeLaunchParityBinding(input);
  if (binding.claudeConfigDir !== input.admitted.harness_config_root) {
    return {
      ok: false,
      detail: 'child CLAUDE_CONFIG_DIR must equal admitted harness_config_root',
    };
  }
  if (binding.projectConfigRoot !== input.admitted.project_policy_root) {
    return {
      ok: false,
      detail: 'projectConfigRoot must equal admitted project_policy_root',
    };
  }
  if (binding.cwd !== input.admitted.cwd) {
    return { ok: false, detail: 'query cwd must equal admitted cwd' };
  }
  return { ok: true, binding, digest: digestClaudeLaunchParityBinding(binding) };
}
