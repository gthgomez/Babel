import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

import type { ClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import { assertClaudeStrictMcpQueryTransportAvailable } from './claudeCodeQueryTransportOptions.js';

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

/**
 * SDK 0.3.304 {@link resolveSettings} has `cwd` only (no `projectConfigRoot`).
 * With `settingSources: []`, project/local tiers are skipped; a split
 * `projectConfigRoot` on `query()` cannot be proven via resolveSettings.
 */
export function assertClaudeResolveSettingsRootParity(input: {
  launchCwd: string;
  projectPolicyRoot: string;
  settingSources: readonly unknown[];
}): { ok: true } | { ok: false; detail: string } {
  if (input.settingSources.length !== 0) {
    return {
      ok: false,
      detail: 'Non-empty settingSources are unsupported for Claude admission policy proof',
    };
  }
  let launch: string;
  let project: string;
  try {
    launch = realpathSync(input.launchCwd);
    project = realpathSync(input.projectPolicyRoot);
  } catch {
    return { ok: false, detail: 'launch cwd and project_policy_root must exist' };
  }
  if (launch !== project) {
    return {
      ok: false,
      detail:
        'project_policy_root differs from launch cwd while settingSources=[]; pinned SDK resolveSettings cannot observe projectConfigRoot — admission rejected (fail closed)',
    };
  }
  return { ok: true };
}

export function digestClaudePinnedManagedSettings(launchSpec: ClaudeCodeLaunchPolicySpec): string {
  return sha256(stableJson(launchSpec.managedSettings));
}

/** Binds live `query()` transport knobs including top-level strictMcpConfig. */
export function digestClaudeQueryTransportOptions(launchSpec: ClaudeCodeLaunchPolicySpec): string {
  return sha256(
    stableJson({
      strictMcpConfig: launchSpec.strictMcpConfig,
      settingSources: launchSpec.settingSources,
      permissionMode: launchSpec.permissionMode,
      permissionPrompts: launchSpec.permissionPrompts,
    }),
  );
}

export type PolicySourceRow = {
  source: string;
  settings: Record<string, unknown>;
  path?: string;
};

/**
 * Validates resolveSettings source identity for admission (SDK pin 0.3.304).
 *
 * strictMcpConfig enforcement is via `query()` {@link Options.strictMcpConfig}, not
 * managedSettings (resolveSettings drops that key from managed source rows on 0.3.304).
 */
export function verifyClaudeManagedPolicySources(input: {
  sources: PolicySourceRow[];
  filtered: Record<string, unknown>;
  launchSpec: ClaudeCodeLaunchPolicySpec;
}):
  | {
      ok: true;
      managedSourceIdentity: string;
      pinnedManagedDigest: string;
      queryTransportDigest: string;
    }
  | { ok: false; detail: string } {
  const strictMcpTransport = assertClaudeStrictMcpQueryTransportAvailable(input.launchSpec);
  if (!strictMcpTransport.ok) {
    return strictMcpTransport;
  }

  const managed = input.sources.filter((s) => s.source === 'managed');
  if (managed.length !== 1) {
    return { ok: false, detail: 'resolveSettings must expose exactly one managed policy source' };
  }
  const row = managed[0]!;
  const settings = row.settings;
  if (settings.disableClaudeAiConnectors !== true) {
    return { ok: false, detail: 'managed source disableClaudeAiConnectors !== true' };
  }
  const sandbox = settings.sandbox as { enabled?: boolean } | undefined;
  if (sandbox?.enabled !== true) {
    return { ok: false, detail: 'managed source sandbox.enabled !== true' };
  }
  if (settings.strictMcpConfig === false) {
    return { ok: false, detail: 'managed source reports strictMcpConfig false' };
  }

  if (input.filtered.disableClaudeAiConnectors !== true) {
    return { ok: false, detail: 'effective disableClaudeAiConnectors !== true' };
  }
  const effectiveSandbox = input.filtered.sandbox as { enabled?: boolean } | undefined;
  if (effectiveSandbox?.enabled !== true) {
    return { ok: false, detail: 'effective sandbox.enabled !== true' };
  }
  if (input.filtered.strictMcpConfig === false) {
    return { ok: false, detail: 'effective strictMcpConfig is false' };
  }

  const managedSourceIdentity = sha256(
    stableJson({
      source: row.source,
      path: row.path ?? null,
      settings,
    }),
  );
  return {
    ok: true,
    managedSourceIdentity,
    pinnedManagedDigest: digestClaudePinnedManagedSettings(input.launchSpec),
    queryTransportDigest: digestClaudeQueryTransportOptions(input.launchSpec),
  };
}
