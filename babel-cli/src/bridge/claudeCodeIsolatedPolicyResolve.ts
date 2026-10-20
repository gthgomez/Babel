import { createHash } from 'node:crypto';

import { filterEscalatingDefaultMode, resolveSettings } from '@anthropic-ai/claude-agent-sdk';

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
  /** Project policy tree (hooks/.claude); not config HOME. */
  projectPolicyRoot: string;
  configHome: string;
  launchSpec: ClaudeCodeLaunchPolicySpec;
  /** Non-secret child env baseline (suppressors/markers/endpoint); copied, not process.env. */
  childEnvBaseline: Record<string, string>;
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
  const childEnv = {
    ...input.childEnvBaseline,
    CLAUDE_CONFIG_DIR: input.configHome,
  };
  const launchOpts = {
    cwd: input.projectPolicyRoot,
    settingSources: input.launchSpec.settingSources,
    managedSettings: input.launchSpec.managedSettings,
    childEnvKeys: Object.keys(childEnv).sort(),
  };

  let resolved;
  try {
    resolved = await resolveSettings({
      cwd: input.projectPolicyRoot,
      settingSources: [],
      managedSettings:
        input.launchSpec.managedSettings as import('@anthropic-ai/claude-agent-sdk').Settings,
    });
  } catch (error) {
    return {
      ok: false,
      digest: sha256(stableJson({ launchOpts, phase: 'resolveSettings_error' })),
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const filtered = filterEscalatingDefaultMode(resolved) as Record<string, unknown>;
  const projection = projectSecurityProjection(filtered);
  const sourceHashes = hashSources(
    resolved.sources.map((s) => ({
      source: String(s.source),
      settings: s.settings as Record<string, unknown>,
      ...(s.path ? { path: s.path } : {}),
    })),
  );

  const connectors = filtered.disableClaudeAiConnectors;
  const strictMcp = filtered.strictMcpConfig;
  const sandbox = (filtered.sandbox as { enabled?: boolean } | undefined)?.enabled;
  if (connectors !== true || strictMcp !== true || sandbox !== true) {
    return {
      ok: false,
      digest: sha256(stableJson({ launchOpts, projection, sourceHashes })),
      detail: 'Baseline sandbox/deny/connectors restrictions not satisfied in effective settings',
      sourceHashes,
    };
  }

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
      sdkIdentity: 'resolveSettings+filterEscalatingDefaultMode',
    }),
  );

  return { ok: true, digest, sourceHashes };
}
