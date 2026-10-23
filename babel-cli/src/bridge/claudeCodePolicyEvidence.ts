import { createHash } from 'node:crypto';

import type { ClaudeHarnessProviderProfile } from './claudeCodeAdmission.js';
import {
  resolveClaudeCodePolicyIsolated,
  type ClaudeIsolatedPolicyResolveInput,
} from './claudeCodeIsolatedPolicyResolve.js';
import { profileChildEnvMarkers } from './claudeCodeProfileCatalog.js';

export interface ClaudeCodeLaunchPolicySpec {
  settingSources: [];
  permissionMode: 'default';
  permissionPrompts: 'host';
  envSuppressors: Record<string, string>;
  managedSettings: Record<string, unknown>;
}

export function buildClaudeCodeLaunchPolicySpec(
  providerProfile: ClaudeHarnessProviderProfile,
): ClaudeCodeLaunchPolicySpec {
  return {
    settingSources: [],
    permissionMode: 'default',
    permissionPrompts: 'host',
    envSuppressors: {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    },
    managedSettings: {
      disableClaudeAiConnectors: true,
      strictMcpConfig: true,
      permissions: {
        deny: [],
        ask: [],
      },
      sandbox: {
        enabled: true,
      },
    },
  };
}

export function digestClaudeCodeLaunchPolicy(spec: ClaudeCodeLaunchPolicySpec): string {
  const payload = JSON.stringify(spec);
  return createHash('sha256').update(payload).digest('hex');
}

export type ClaudeResolveSettingsFn = (
  input: ClaudeIsolatedPolicyResolveInput,
) => Promise<{ ok: boolean; digest: string; detail?: string }>;

export async function defaultClaudeResolveSettings(
  input: ClaudeIsolatedPolicyResolveInput,
): Promise<{ ok: boolean; digest: string; detail?: string }> {
  const result = await resolveClaudeCodePolicyIsolated(input);
  return {
    ok: result.ok,
    digest: result.digest,
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

export async function resolveClaudeCodePolicyEvidence(input: {
  cwd: string;
  config_root: string;
  project_policy_root: string;
  provider_profile: ClaudeHarnessProviderProfile;
  endpoint_env?: Record<string, string>;
  resolveSettings?: ClaudeResolveSettingsFn;
}): Promise<{ ok: boolean; digest: string; detail?: string }> {
  const spec = buildClaudeCodeLaunchPolicySpec(input.provider_profile);
  const childEnvBaseline = {
    ...spec.envSuppressors,
    ...profileChildEnvMarkers(input.provider_profile),
    ...(input.endpoint_env ?? {}),
  };
  const resolveFn = input.resolveSettings ?? defaultClaudeResolveSettings;
  try {
    const resolved = await resolveFn({
      launchCwd: input.cwd,
      projectPolicyRoot: input.project_policy_root,
      configHome: input.config_root,
      launchSpec: spec,
      childEnvBaseline,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        digest: resolved.digest,
        ...(resolved.detail ? { detail: resolved.detail } : {}),
      };
    }
    return { ok: true, digest: resolved.digest };
  } catch (error) {
    return {
      ok: false,
      digest: digestClaudeCodeLaunchPolicy(spec),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
