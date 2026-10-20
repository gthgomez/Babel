import { createHash } from 'node:crypto';

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

export async function resolveClaudeCodePolicyEvidence(input: {
  cwd: string;
  config_root: string;
  provider_profile: ClaudeHarnessProviderProfile;
  resolveSettings?: (opts: {
    cwd: string;
    settingSources: [];
    managedSettings: Record<string, unknown>;
  }) => Promise<{ effective?: Record<string, unknown> }>;
}): Promise<{ ok: boolean; digest: string; detail?: string }> {
  const spec = buildClaudeCodeLaunchPolicySpec(input.provider_profile);
  const digest = digestClaudeCodeLaunchPolicy(spec);
  if (!input.resolveSettings) {
    return { ok: true, digest };
  }
  try {
    const resolved = await input.resolveSettings({
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
