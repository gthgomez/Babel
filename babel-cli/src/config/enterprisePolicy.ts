import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const TrustLevelSchema = z.enum(['metadata', 'read_only', 'local_mutating', 'external_network']);
export type EnterprisePluginTrustLevel = z.infer<typeof TrustLevelSchema>;

const TRUST_LEVEL_RANK: Record<EnterprisePluginTrustLevel, number> = {
  metadata: 0,
  read_only: 1,
  local_mutating: 2,
  external_network: 3,
};

export interface EnterpriseModelBackendDescriptor {
  backendKey: string;
  provider: string;
  providerModelId: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getDefaultBabelRoot(): string {
  return process.env['BABEL_ROOT'] ?? resolve(__dirname, '../../..');
}

export const EnterprisePolicyFileSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    policy_name: z.string().min(1).optional(),
    allowed_tools: z.array(z.string().min(1)).optional(),
    disallowed_tools: z.array(z.string().min(1)).optional(),
    allowed_mcp_servers: z.array(z.string().min(1)).optional(),
    disallowed_mcp_servers: z.array(z.string().min(1)).optional(),
    network_allowlist: z.array(z.string().min(1)).optional(),
    model_policy: z
      .object({
        allowed_backends: z.array(z.string().min(1)).optional(),
        disallowed_backends: z.array(z.string().min(1)).optional(),
        require_explicit_opt_in: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    plugin_policy: z
      .object({
        allowed_plugins: z.array(z.string().min(1)).optional(),
        disallowed_plugins: z.array(z.string().min(1)).optional(),
        max_trust_level: TrustLevelSchema.optional(),
      })
      .optional(),
    redaction: z
      .object({
        enabled: z.boolean().default(true),
        extra_patterns: z.array(z.string().min(1)).optional(),
      })
      .default({ enabled: true }),
    telemetry: z
      .object({
        opt_in: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

export type EnterprisePolicyFile = z.infer<typeof EnterprisePolicyFileSchema>;

export interface EnterprisePolicyLoadSource {
  label: 'repo' | 'workspace' | 'user' | 'admin' | 'explicit';
  path: string;
  exists: boolean;
  loaded: boolean;
  error?: string;
}

export interface EnterprisePolicy {
  schema_version: 1;
  policy_name?: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  allowed_mcp_servers: string[];
  disallowed_mcp_servers: string[];
  network_allowlist: string[];
  model_policy: {
    allowed_backends: string[];
    disallowed_backends: string[];
    require_explicit_opt_in: string[];
  };
  plugin_policy: {
    allowed_plugins: string[];
    disallowed_plugins: string[];
    max_trust_level?: EnterprisePluginTrustLevel;
  };
  redaction: {
    enabled: boolean;
    extra_patterns: string[];
  };
  telemetry: {
    opt_in?: boolean;
  };
}

export interface EnterprisePolicyLoadResult {
  policy: EnterprisePolicy;
  sources: EnterprisePolicyLoadSource[];
  errors: string[];
  loaded: boolean;
}

export interface EnterprisePolicyDecision {
  allowed: boolean;
  reason: string;
  policy_source?: string;
  fix_hint?: string;
}

const DEFAULT_POLICY: EnterprisePolicy = {
  schema_version: 1,
  allowed_tools: [],
  disallowed_tools: [],
  allowed_mcp_servers: [],
  disallowed_mcp_servers: [],
  network_allowlist: [],
  model_policy: {
    allowed_backends: [],
    disallowed_backends: [],
    require_explicit_opt_in: [],
  },
  plugin_policy: {
    allowed_plugins: [],
    disallowed_plugins: [],
  },
  redaction: {
    enabled: true,
    extra_patterns: [],
  },
  telemetry: {},
};

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function mergeArrays(base: string[], next: string[] | undefined): string[] {
  return unique([...base, ...(next ?? [])]);
}

function cloneDefaultPolicy(): EnterprisePolicy {
  return {
    ...DEFAULT_POLICY,
    allowed_tools: [...DEFAULT_POLICY.allowed_tools],
    disallowed_tools: [...DEFAULT_POLICY.disallowed_tools],
    allowed_mcp_servers: [...DEFAULT_POLICY.allowed_mcp_servers],
    disallowed_mcp_servers: [...DEFAULT_POLICY.disallowed_mcp_servers],
    network_allowlist: [...DEFAULT_POLICY.network_allowlist],
    model_policy: {
      allowed_backends: [...DEFAULT_POLICY.model_policy.allowed_backends],
      disallowed_backends: [...DEFAULT_POLICY.model_policy.disallowed_backends],
      require_explicit_opt_in: [...DEFAULT_POLICY.model_policy.require_explicit_opt_in],
    },
    plugin_policy: {
      allowed_plugins: [...DEFAULT_POLICY.plugin_policy.allowed_plugins],
      disallowed_plugins: [...DEFAULT_POLICY.plugin_policy.disallowed_plugins],
    },
    redaction: {
      enabled: true,
      extra_patterns: [],
    },
    telemetry: {},
  };
}

function mergePolicy(base: EnterprisePolicy, next: EnterprisePolicyFile): EnterprisePolicy {
  const merged: EnterprisePolicy = {
    ...base,
    ...(next.policy_name ? { policy_name: next.policy_name } : {}),
    allowed_tools: mergeArrays(base.allowed_tools, next.allowed_tools),
    disallowed_tools: mergeArrays(base.disallowed_tools, next.disallowed_tools),
    allowed_mcp_servers: mergeArrays(base.allowed_mcp_servers, next.allowed_mcp_servers),
    disallowed_mcp_servers: mergeArrays(base.disallowed_mcp_servers, next.disallowed_mcp_servers),
    network_allowlist: mergeArrays(base.network_allowlist, next.network_allowlist),
    model_policy: {
      allowed_backends: mergeArrays(
        base.model_policy.allowed_backends,
        next.model_policy?.allowed_backends,
      ),
      disallowed_backends: mergeArrays(
        base.model_policy.disallowed_backends,
        next.model_policy?.disallowed_backends,
      ),
      require_explicit_opt_in: mergeArrays(
        base.model_policy.require_explicit_opt_in,
        next.model_policy?.require_explicit_opt_in,
      ),
    },
    plugin_policy: {
      allowed_plugins: mergeArrays(
        base.plugin_policy.allowed_plugins,
        next.plugin_policy?.allowed_plugins,
      ),
      disallowed_plugins: mergeArrays(
        base.plugin_policy.disallowed_plugins,
        next.plugin_policy?.disallowed_plugins,
      ),
      ...((next.plugin_policy?.max_trust_level ?? base.plugin_policy.max_trust_level)
        ? {
            max_trust_level:
              next.plugin_policy?.max_trust_level ?? base.plugin_policy.max_trust_level,
          }
        : {}),
    },
    redaction: {
      enabled: next.redaction.enabled,
      extra_patterns: mergeArrays(base.redaction.extra_patterns, next.redaction.extra_patterns),
    },
    telemetry: {
      ...(typeof (next.telemetry?.opt_in ?? base.telemetry.opt_in) === 'boolean'
        ? { opt_in: next.telemetry?.opt_in ?? base.telemetry.opt_in }
        : {}),
    },
  };
  return merged;
}

function normalizePolicyToken(value: string): string {
  return value.trim().toLowerCase();
}

function splitEnvList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => normalizePolicyToken(value))
    .filter((value) => value.length > 0);
}

export function getEnterprisePolicyPaths(
  babelRoot = getDefaultBabelRoot(),
): Array<{ label: EnterprisePolicyLoadSource['label']; path: string }> {
  const workspaceRoot = dirname(resolve(babelRoot));
  const userProfile = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const paths: Array<{ label: EnterprisePolicyLoadSource['label']; path: string | undefined }> = [
    { label: 'repo', path: join(resolve(babelRoot), 'config', 'enterprise-policy.json') },
    { label: 'workspace', path: join(workspaceRoot, 'config', 'babel-enterprise-policy.json') },
    {
      label: 'user',
      path:
        process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] ??
        (userProfile ? join(userProfile, '.babel', 'enterprise-policy.json') : undefined),
    },
    { label: 'admin', path: process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] },
    { label: 'explicit', path: process.env['BABEL_ENTERPRISE_POLICY_PATH'] },
  ];

  return paths
    .filter(
      (entry): entry is { label: EnterprisePolicyLoadSource['label']; path: string } =>
        typeof entry.path === 'string' && entry.path.trim().length > 0,
    )
    .map((entry) => ({ label: entry.label, path: resolve(entry.path) }));
}

export function loadEnterprisePolicy(
  babelRoot = getDefaultBabelRoot(),
): EnterprisePolicyLoadResult {
  let policy = cloneDefaultPolicy();
  const sources: EnterprisePolicyLoadSource[] = [];
  const errors: string[] = [];
  let loaded = false;

  for (const candidate of getEnterprisePolicyPaths(babelRoot)) {
    const source: EnterprisePolicyLoadSource = {
      label: candidate.label,
      path: candidate.path,
      exists: existsSync(candidate.path),
      loaded: false,
    };

    if (!source.exists) {
      sources.push(source);
      continue;
    }

    try {
      const raw = readFileSync(candidate.path, 'utf8');
      const parsed = EnterprisePolicyFileSchema.parse(JSON.parse(raw));
      policy = mergePolicy(policy, parsed);
      source.loaded = true;
      loaded = true;
    } catch (error: unknown) {
      source.error = error instanceof Error ? error.message : String(error);
      errors.push(`${candidate.label}:${candidate.path}: ${source.error}`);
    }
    sources.push(source);
  }

  return { policy, sources, errors, loaded };
}

export function describeEnterprisePolicySource(
  result: EnterprisePolicyLoadResult | null | undefined,
): string {
  if (!result) {
    return 'provided policy object';
  }

  const loadedSources = result.sources
    .filter((source) => source.loaded)
    .map((source) => `${source.label}:${source.path}`);
  if (loadedSources.length > 0) {
    return loadedSources.join('; ');
  }

  const errorSources = result.sources
    .filter((source) => source.error)
    .map((source) => `${source.label}:${source.path}`);
  if (errorSources.length > 0) {
    return errorSources.join('; ');
  }

  return 'enterprise policy defaults';
}

function denyEnterprisePolicy(
  reason: string,
  result: EnterprisePolicyLoadResult | null | undefined,
  fix_hint: string,
): EnterprisePolicyDecision {
  return {
    allowed: false,
    reason,
    policy_source: describeEnterprisePolicySource(result),
    fix_hint,
  };
}

export function formatEnterprisePolicyDecision(decision: EnterprisePolicyDecision): string {
  if (decision.allowed) {
    return decision.reason;
  }

  const details: string[] = [];
  if (decision.policy_source) {
    details.push(`source: ${decision.policy_source}`);
  }
  if (decision.fix_hint) {
    details.push(`fix: ${decision.fix_hint}`);
  }
  return details.length > 0 ? `${decision.reason} (${details.join('; ')})` : decision.reason;
}

export function evaluateToolPolicy(
  toolName: string,
  policy?: EnterprisePolicy,
): EnterprisePolicyDecision {
  const loaded = policy ? null : loadEnterprisePolicy();
  if (loaded && loaded.errors.length > 0) {
    return denyEnterprisePolicy(
      `enterprise policy failed to load: ${loaded.errors[0]}`,
      loaded,
      'Fix or remove the malformed enterprise policy source before retrying.',
    );
  }
  policy ??= loaded!.policy;

  if (policy.disallowed_tools.includes(toolName)) {
    return denyEnterprisePolicy(
      `tool "${toolName}" is disallowed by enterprise policy`,
      loaded,
      `Remove "${toolName}" from disallowed_tools or choose an approved tool.`,
    );
  }
  if (policy.allowed_tools.length > 0 && !policy.allowed_tools.includes(toolName)) {
    return denyEnterprisePolicy(
      `tool "${toolName}" is not in enterprise allowed_tools`,
      loaded,
      `Add "${toolName}" to allowed_tools in the managed enterprise policy or use an allowed tool.`,
    );
  }
  return { allowed: true, reason: `tool "${toolName}" allowed` };
}

export function evaluateMcpServerPolicy(
  serverName: string,
  policy?: EnterprisePolicy,
): EnterprisePolicyDecision {
  const loaded = policy ? null : loadEnterprisePolicy();
  if (loaded && loaded.errors.length > 0) {
    return denyEnterprisePolicy(
      `enterprise policy failed to load: ${loaded.errors[0]}`,
      loaded,
      'Fix or remove the malformed enterprise policy source before retrying.',
    );
  }
  policy ??= loaded!.policy;

  if (policy.disallowed_mcp_servers.includes(serverName)) {
    return denyEnterprisePolicy(
      `MCP server "${serverName}" is disallowed by enterprise policy`,
      loaded,
      `Remove "${serverName}" from disallowed_mcp_servers or choose an approved MCP server.`,
    );
  }
  if (policy.allowed_mcp_servers.length > 0 && !policy.allowed_mcp_servers.includes(serverName)) {
    return denyEnterprisePolicy(
      `MCP server "${serverName}" is not in enterprise allowed_mcp_servers`,
      loaded,
      `Add "${serverName}" to allowed_mcp_servers in the managed enterprise policy or choose an approved server.`,
    );
  }
  return { allowed: true, reason: `MCP server "${serverName}" allowed` };
}

function normalizeHost(value: string): string {
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
}

function hostMatchesRule(hostname: string, rule: string): boolean {
  const host = normalizeHost(hostname);
  const normalizedRule = normalizeHost(rule);
  if (normalizedRule.startsWith('*.')) {
    const suffix = normalizedRule.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === normalizedRule;
}

export function evaluateNetworkHostPolicy(
  hostname: string,
  policy?: EnterprisePolicy,
): EnterprisePolicyDecision {
  const loaded = policy ? null : loadEnterprisePolicy();
  if (loaded && loaded.errors.length > 0) {
    return denyEnterprisePolicy(
      `enterprise policy failed to load: ${loaded.errors[0]}`,
      loaded,
      'Fix or remove the malformed enterprise policy source before retrying.',
    );
  }
  policy ??= loaded!.policy;

  if (policy.network_allowlist.length === 0) {
    return { allowed: true, reason: `network host "${hostname}" allowed by default policy` };
  }
  if (policy.network_allowlist.some((rule) => hostMatchesRule(hostname, rule))) {
    return { allowed: true, reason: `network host "${hostname}" allowed` };
  }
  return denyEnterprisePolicy(
    `network host "${hostname}" is not in enterprise network_allowlist`,
    loaded,
    `Add "${hostname}" or an approved wildcard rule to network_allowlist.`,
  );
}

function modelBackendCandidates(backend: EnterpriseModelBackendDescriptor): string[] {
  return [
    backend.backendKey,
    backend.provider,
    backend.providerModelId,
    `${backend.provider}:${backend.providerModelId}`,
  ].map(normalizePolicyToken);
}

function policyListMatches(values: string[], candidates: string[]): boolean {
  const normalized = values.map(normalizePolicyToken);
  return normalized.includes('*') || candidates.some((candidate) => normalized.includes(candidate));
}

export function evaluateModelBackendPolicy(
  backend: EnterpriseModelBackendDescriptor,
  options: { explicitOptIn?: boolean; policy?: EnterprisePolicy } = {},
): EnterprisePolicyDecision {
  const loaded = options.policy ? null : loadEnterprisePolicy();
  if (loaded && loaded.errors.length > 0) {
    return denyEnterprisePolicy(
      `enterprise policy failed to load: ${loaded.errors[0]}`,
      loaded,
      'Fix or remove the malformed enterprise policy source before retrying.',
    );
  }
  const policy = options.policy ?? loaded!.policy;
  const candidates = modelBackendCandidates(backend);

  if (policyListMatches(policy.model_policy.disallowed_backends, candidates)) {
    return denyEnterprisePolicy(
      `model backend "${backend.backendKey}" is disallowed by enterprise policy`,
      loaded,
      `Remove "${backend.backendKey}" from model_policy.disallowed_backends or choose an approved backend.`,
    );
  }
  if (
    policy.model_policy.allowed_backends.length > 0 &&
    !policyListMatches(policy.model_policy.allowed_backends, candidates)
  ) {
    return denyEnterprisePolicy(
      `model backend "${backend.backendKey}" is not in enterprise allowed_backends`,
      loaded,
      `Add "${backend.backendKey}", its provider, or its provider model id to model_policy.allowed_backends.`,
    );
  }
  if (policyListMatches(policy.model_policy.require_explicit_opt_in, candidates)) {
    const envOptIns = splitEnvList('BABEL_ENTERPRISE_MODEL_OPT_IN');
    const envAllows =
      envOptIns.includes('*') || candidates.some((candidate) => envOptIns.includes(candidate));
    if (options.explicitOptIn !== true && !envAllows) {
      return {
        allowed: false,
        reason: `model backend "${backend.backendKey}" requires enterprise explicit opt-in`,
        policy_source: describeEnterprisePolicySource(loaded),
        fix_hint: `Set BABEL_ENTERPRISE_MODEL_OPT_IN=${backend.backendKey} or pass an explicit enterprise model opt-in where supported.`,
      };
    }
  }

  return { allowed: true, reason: `model backend "${backend.backendKey}" allowed` };
}

export function evaluatePluginPolicy(
  pluginId: string,
  trustLevel: EnterprisePluginTrustLevel,
  policy?: EnterprisePolicy,
): EnterprisePolicyDecision {
  const loaded = policy ? null : loadEnterprisePolicy();
  if (loaded && loaded.errors.length > 0) {
    return denyEnterprisePolicy(
      `enterprise policy failed to load: ${loaded.errors[0]}`,
      loaded,
      'Fix or remove the malformed enterprise policy source before retrying.',
    );
  }
  policy ??= loaded!.policy;

  if (policy.plugin_policy.disallowed_plugins.includes(pluginId)) {
    return denyEnterprisePolicy(
      `plugin "${pluginId}" is disallowed by enterprise policy`,
      loaded,
      `Remove "${pluginId}" from plugin_policy.disallowed_plugins or choose an approved plugin.`,
    );
  }
  if (
    policy.plugin_policy.allowed_plugins.length > 0 &&
    !policy.plugin_policy.allowed_plugins.includes(pluginId)
  ) {
    return denyEnterprisePolicy(
      `plugin "${pluginId}" is not in enterprise allowed_plugins`,
      loaded,
      `Add "${pluginId}" to plugin_policy.allowed_plugins or choose an approved plugin.`,
    );
  }
  const maxTrust = policy.plugin_policy.max_trust_level;
  if (maxTrust && TRUST_LEVEL_RANK[trustLevel] > TRUST_LEVEL_RANK[maxTrust]) {
    return {
      allowed: false,
      reason: `plugin "${pluginId}" trust_level "${trustLevel}" exceeds enterprise max_trust_level "${maxTrust}"`,
      policy_source: describeEnterprisePolicySource(loaded),
      fix_hint: `Raise plugin_policy.max_trust_level to "${trustLevel}" only after approving that trust level, or choose a lower-trust plugin.`,
    };
  }

  return { allowed: true, reason: `plugin "${pluginId}" allowed` };
}

export function evaluateTelemetryPolicy(policy?: EnterprisePolicy): EnterprisePolicyDecision {
  const loaded = policy ? null : loadEnterprisePolicy();
  if (loaded && loaded.errors.length > 0) {
    return denyEnterprisePolicy(
      `enterprise policy failed to load: ${loaded.errors[0]}`,
      loaded,
      'Fix or remove the malformed enterprise policy source before retrying.',
    );
  }
  policy ??= loaded!.policy;

  if (loaded && !loaded.loaded) {
    return {
      allowed: true,
      reason: 'no enterprise policy loaded; telemetry follows local env configuration',
    };
  }
  if (policy.telemetry.opt_in !== true) {
    return denyEnterprisePolicy(
      'enterprise policy telemetry.opt_in is not true',
      loaded,
      'Set telemetry.opt_in to true in the managed enterprise policy to enable OTel export.',
    );
  }

  return { allowed: true, reason: 'telemetry explicitly opted in by enterprise policy' };
}
