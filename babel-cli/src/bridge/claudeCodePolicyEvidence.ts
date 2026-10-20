import { createHash } from 'node:crypto';

import { filterEscalatingDefaultMode, resolveSettings } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeHarnessProviderProfile } from './claudeCodeAdmission.js';

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
      env: {
        BABEL_CLAUDE_PROFILE: providerProfile,
      },
    },
  };
}

export function digestClaudeCodeLaunchPolicy(spec: ClaudeCodeLaunchPolicySpec): string {
  const payload = JSON.stringify(spec);
  return createHash('sha256').update(payload).digest('hex');
}

export type ClaudeResolveSettingsFn = (opts: {
  cwd: string;
  settingSources: [];
  managedSettings: Record<string, unknown>;
}) => Promise<{ effective?: Record<string, unknown> }>;

export async function defaultClaudeResolveSettings(opts: {
  cwd: string;
  settingSources: [];
  managedSettings: Record<string, unknown>;
}): Promise<{ effective: Record<string, unknown> }> {
  const resolved = await resolveSettings({
    cwd: opts.cwd,
    settingSources: [],
    managedSettings: opts.managedSettings as import('@anthropic-ai/claude-agent-sdk').Settings,
  });
  const filtered = filterEscalatingDefaultMode(resolved);
  return { effective: filtered as Record<string, unknown> };
}

export async function resolveClaudeCodePolicyEvidence(input: {
  cwd: string;
  config_root: string;
  provider_profile: ClaudeHarnessProviderProfile;
  resolveSettings?: ClaudeResolveSettingsFn;
}): Promise<{ ok: boolean; digest: string; detail?: string }> {
  const spec = buildClaudeCodeLaunchPolicySpec(input.provider_profile);
  const digest = digestClaudeCodeLaunchPolicy(spec);
  const resolveFn = input.resolveSettings ?? defaultClaudeResolveSettings;
  try {
    const resolved = await resolveFn({
      cwd: input.cwd,
      settingSources: [],
      managedSettings: spec.managedSettings,
    });
    if (!resolved.effective || typeof resolved.effective !== 'object') {
      return { ok: false, digest, detail: 'resolveSettings returned no effective object' };
    }
    const mode = (resolved.effective as { permissions?: { defaultMode?: string } }).permissions
      ?.defaultMode;
    if (mode && mode !== 'default' && mode !== 'plan') {
      return {
        ok: false,
        digest,
        detail: `Escalating permissions.defaultMode ${mode} rejected`,
      };
    }
    return { ok: true, digest };
  } catch (error) {
    return {
      ok: false,
      digest,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
