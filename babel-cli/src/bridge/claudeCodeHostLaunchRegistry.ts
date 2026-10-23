import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import type { ClaudeHarnessProviderProfile } from './claudeCodeAdmission.js';

const KNOWN_PROFILES = new Set<string>([
  EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
  EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo,
]);

export interface ClaudeCodeHostProfileBindingV1 {
  profile_id: ClaudeHarnessProviderProfile;
  model: string;
  /** Manifest credential_refs key (opaque); not a secret. */
  credential_ref: string;
  /** Host env var name that holds the secret; never read at registry load. */
  auth_host_env: string;
  /** Child env key for auth injection (e.g. ANTHROPIC_API_KEY). */
  auth_child_env: string;
  /** Isolated Claude config HOME (transcripts/settings); not project policy tree. */
  config_home: string;
  /**
   * Project policy root for hooks/.claude/.mcp.json (SDK projectConfigRoot).
   * When omitted, defaults to each session's admitted cwd.
   */
  project_policy_root?: string;
  /** Extra non-secret child env entries (endpoint routing). Omit or {} when disabled. */
  endpoint_env?: Record<string, string>;
}

export interface ClaudeCodeHostLaunchRegistry {
  get(profileId: string): ClaudeCodeHostProfileBindingV1 | undefined;
  listProfileIds(): string[];
}

function normalizeBinding(raw: ClaudeCodeHostProfileBindingV1): ClaudeCodeHostProfileBindingV1 | null {
  const profile_id = raw.profile_id?.trim();
  if (!profile_id || !KNOWN_PROFILES.has(profile_id)) return null;
  const model = raw.model?.trim();
  const credential_ref = raw.credential_ref?.trim();
  const auth_host_env = raw.auth_host_env?.trim();
  const auth_child_env = raw.auth_child_env?.trim();
  const config_home = raw.config_home?.trim();
  if (!model || !credential_ref || !auth_host_env || !auth_child_env || !config_home) return null;
  let configHomeResolved: string;
  try {
    configHomeResolved = realpathSync(resolve(config_home));
  } catch {
    return null;
  }
  if (!statSync(configHomeResolved).isDirectory()) return null;
  let projectPolicyRoot: string | undefined;
  if (raw.project_policy_root?.trim()) {
    try {
      projectPolicyRoot = realpathSync(resolve(raw.project_policy_root.trim()));
      if (!statSync(projectPolicyRoot).isDirectory()) return null;
    } catch {
      return null;
    }
  }
  const endpoint_env =
    raw.endpoint_env && typeof raw.endpoint_env === 'object' ? { ...raw.endpoint_env } : undefined;
  return {
    profile_id: profile_id as ClaudeHarnessProviderProfile,
    model,
    credential_ref,
    auth_host_env,
    auth_child_env,
    config_home: configHomeResolved,
    ...(projectPolicyRoot ? { project_policy_root: projectPolicyRoot } : {}),
    ...(endpoint_env && Object.keys(endpoint_env).length > 0 ? { endpoint_env } : {}),
  };
}

export function createClaudeCodeHostLaunchRegistryFromBindings(
  bindings: ClaudeCodeHostProfileBindingV1[],
): ClaudeCodeHostLaunchRegistry {
  const byId = new Map<string, ClaudeCodeHostProfileBindingV1>();
  for (const raw of bindings) {
    const normalized = normalizeBinding(raw);
    if (normalized) byId.set(normalized.profile_id, normalized);
  }
  return {
    get: (id) => byId.get(id),
    listProfileIds: () => [...byId.keys()],
  };
}

/**
 * Production host binding: `BABEL_CLAUDE_HOST_BINDINGS_PATH` points at a version-1 JSON file.
 * Missing or invalid path yields an empty registry (thread.create rejects unknown profiles).
 */
export function resolveClaudeCodeHostLaunchRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCodeHostLaunchRegistry | undefined {
  const configured = env['BABEL_CLAUDE_HOST_BINDINGS_PATH']?.trim();
  if (!configured) return undefined;
  return loadClaudeCodeHostLaunchRegistryFromFile(resolve(configured));
}

export function loadClaudeCodeHostLaunchRegistryFromFile(path: string): ClaudeCodeHostLaunchRegistry {
  if (!existsSync(path)) {
    return createClaudeCodeHostLaunchRegistryFromBindings([]);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: number;
    profiles?: ClaudeCodeHostProfileBindingV1[];
  };
  if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
    return createClaudeCodeHostLaunchRegistryFromBindings([]);
  }
  return createClaudeCodeHostLaunchRegistryFromBindings(parsed.profiles);
}

export function resolveClaudeCodeTrustedLaunchFields(input: {
  registry: ClaudeCodeHostLaunchRegistry;
  harness_provider_profile: string;
  project_root: string;
}):
  | {
      ok: true;
      binding: ClaudeCodeHostProfileBindingV1;
      harness_model_profile: string;
      harness_credential_ref: string;
      harness_config_root: string;
      project_policy_root: string;
      cwd: string;
    }
  | { ok: false; detail: string } {
  const binding = input.registry.get(input.harness_provider_profile.trim());
  if (!binding) {
    return { ok: false, detail: `Unknown or undeclared host profile: ${input.harness_provider_profile}` };
  }
  let cwd: string;
  try {
    cwd = realpathSync(resolve(input.project_root));
  } catch {
    return { ok: false, detail: 'project_root does not exist' };
  }
  if (!existsSync(cwd)) {
    return { ok: false, detail: 'project_root does not exist' };
  }
  const project_policy_root = binding.project_policy_root ?? cwd;
  return {
    ok: true,
    binding,
    harness_model_profile: binding.model,
    harness_credential_ref: binding.credential_ref,
    harness_config_root: binding.config_home,
    project_policy_root,
    cwd,
  };
}
