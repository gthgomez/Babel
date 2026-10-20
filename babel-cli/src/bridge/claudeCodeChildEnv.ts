import type { ClaudeCodeAdmittedSession } from './claudeCodeAdmission.js';
import type { ClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import { profileChildEnvMarkers } from './claudeCodeProfileCatalog.js';

const CHILD_PATH_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMP',
  'TEMP',
  'TMPDIR',
] as const;

const INHERITED_AUTH_STRIP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
] as const;

function allowlistedHostPathEnv(hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_PATH_ALLOWLIST) {
    const value = hostEnv[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  return env;
}

/**
 * Build the SDK child `env` object (full replace). Never spreads raw process.env.
 */
export function buildClaudeCodeChildEnv(input: {
  admitted: ClaudeCodeAdmittedSession;
  policy: ClaudeCodeLaunchPolicySpec;
  credentialEnv: Record<string, string>;
  hostEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const base = allowlistedHostPathEnv(input.hostEnv);
  for (const name of INHERITED_AUTH_STRIP) {
    delete base[name];
  }
  const managedEnv =
    typeof input.policy.managedSettings.env === 'object' && input.policy.managedSettings.env !== null
      ? (input.policy.managedSettings.env as Record<string, string>)
      : {};
  return {
    ...base,
    ...input.policy.envSuppressors,
    ...profileChildEnvMarkers(input.admitted.harness_provider_profile),
    ...managedEnv,
    CLAUDE_CONFIG_DIR: input.admitted.harness_config_root,
    ...input.credentialEnv,
  };
}
