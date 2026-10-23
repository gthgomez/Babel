import { createHash } from 'node:crypto';

import { auditClaudeConfigHomePolicyNeutral } from './claudeCodeConfigHomePolicy.js';
import { resolveSettingsInIsolatedChildEnv } from './claudeCodeIsolatedResolveSubprocess.js';
import {
  assertClaudeResolveSettingsRootParity,
  verifyClaudeManagedPolicySources,
} from './claudeCodePolicyLaunchGates.js';
import { assertClaudeStrictMcpQueryTransportAvailable } from './claudeCodeQueryTransportOptions.js';
import type { ClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';

const ALLOWED_EFFECTIVE_SECURITY_KEYS = new Set([
  'disableClaudeAiConnectors',
  'strictMcpConfig',
  'permissions',
  'sandbox',
]);

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

function projectSecurityProjection(effective: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(effective)) {
    if (!ALLOWED_EFFECTIVE_SECURITY_KEYS.has(key)) continue;
    out[key] = effective[key];
  }
  return out;
}

function hashSources(
  sources: Array<{ source: string; settings: Record<string, unknown>; path?: string }>,
): string {
  return sha256(stableJson(sources.map((s) => ({ source: s.source, path: s.path ?? null, settings: s.settings }))));
}

export interface ClaudeIsolatedPolicyResolveInput {
  /** query() options.cwd (session project root). */
  launchCwd: string;
  /** query() options.projectConfigRoot (hooks/.claude policy tree). */
  projectPolicyRoot: string;
  configHome: string;
  launchSpec: ClaudeCodeLaunchPolicySpec;
  /** Live-shaped proof env (allowlisted PATH/HOME/… + suppressors + CLAUDE_CONFIG_DIR). */
  proofChildEnv: Record<string, string>;
}

export interface ClaudeIsolatedPolicyResolveResult {
  ok: boolean;
  digest: string;
  detail?: string;
  sourceHashes?: string;
}

/**
 * Non-inference policy proof: resolveSettings only, no query(), no auth fetch,
 * no provider probes, no parent process.env mutation.
 */
export async function resolveClaudeCodePolicyIsolated(
  input: ClaudeIsolatedPolicyResolveInput,
): Promise<ClaudeIsolatedPolicyResolveResult> {
  const strictMcpTransport = assertClaudeStrictMcpQueryTransportAvailable(input.launchSpec);
  if (!strictMcpTransport.ok) {
    return {
      ok: false,
      digest: sha256(
        stableJson({ phase: 'strict_mcp_transport', detail: strictMcpTransport.detail }),
      ),
      detail: strictMcpTransport.detail,
    };
  }

  const rootParity = assertClaudeResolveSettingsRootParity({
    launchCwd: input.launchCwd,
    projectPolicyRoot: input.projectPolicyRoot,
    settingSources: input.launchSpec.settingSources,
  });
  if (!rootParity.ok) {
    return {
      ok: false,
      digest: sha256(
        stableJson({
          phase: 'root_parity',
          launchCwd: input.launchCwd,
          projectPolicyRoot: input.projectPolicyRoot,
          detail: rootParity.detail,
        }),
      ),
      detail: rootParity.detail,
    };
  }

  const configAudit = auditClaudeConfigHomePolicyNeutral(input.configHome);
  if (!configAudit.ok) {
    return {
      ok: false,
      digest: sha256(
        stableJson({
          phase: 'config_home_audit',
          configHome: input.configHome,
          projectPolicyRoot: input.projectPolicyRoot,
          detail: configAudit.detail,
        }),
      ),
      detail: configAudit.detail,
    };
  }

  const childEnv = { ...input.proofChildEnv };
  const rootsBinding = {
    launchCwd: input.launchCwd,
    projectConfigRoot: input.projectPolicyRoot,
    configHome: input.configHome,
    claudeConfigDir: childEnv.CLAUDE_CONFIG_DIR,
  };
  const launchOpts = {
    ...rootsBinding,
    settingSources: input.launchSpec.settingSources,
    managedSettings: input.launchSpec.managedSettings,
    serverManagedSettings: null,
    childEnvKeys: Object.keys(childEnv).sort(),
  };

  let filtered: Record<string, unknown>;
  let sourceList: Array<{ source: string; settings: Record<string, unknown>; path?: string }>;
  try {
    const resolved = await resolveSettingsInIsolatedChildEnv({
      cwd: input.launchCwd,
      projectConfigRoot: input.projectPolicyRoot,
      childEnv,
      launchSpec: input.launchSpec,
    });
    filtered = resolved.filtered;
    sourceList = resolved.sources;
  } catch (error) {
    return {
      ok: false,
      digest: sha256(stableJson({ launchOpts, phase: 'resolveSettings_error' })),
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const managedCheck = verifyClaudeManagedPolicySources({
    sources: sourceList,
    filtered,
    launchSpec: input.launchSpec,
  });
  if (!managedCheck.ok) {
    return {
      ok: false,
      digest: sha256(stableJson({ launchOpts, detail: managedCheck.detail })),
      detail: managedCheck.detail,
    };
  }

  const projection = projectSecurityProjection(filtered);
  const sourceHashes = hashSources(sourceList);

  const mode = (filtered.permissions as { defaultMode?: string } | undefined)?.defaultMode;
  if (mode && mode !== 'default' && mode !== 'plan') {
    return {
      ok: false,
      digest: sha256(stableJson({ launchOpts, projection, sourceHashes })),
      detail: `Escalating permissions.defaultMode ${mode} rejected`,
      sourceHashes,
    };
  }

  const digest = sha256(
    stableJson({
      projection,
      sourceHashes,
      launchOpts,
      rootsBinding,
      managedSourceIdentity: managedCheck.managedSourceIdentity,
      pinnedManagedDigest: managedCheck.pinnedManagedDigest,
      queryTransportDigest: managedCheck.queryTransportDigest,
      sdkIdentity: 'isolatedChildEnvResolveSettings+queryStrictMcpTransport+managedSourceIdentity',
    }),
  );

  return { ok: true, digest, sourceHashes };
}
