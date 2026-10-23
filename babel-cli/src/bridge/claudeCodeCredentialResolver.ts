import type { ClaudeCodeAdmittedSession } from './claudeCodeAdmission.js';
import type { ClaudeCodeHostProfileBindingV1 } from './claudeCodeHostLaunchRegistry.js';
import {
  loadClaudeHarnessManifest,
  type ClaudeHarnessCredentialRefSpec,
} from './claudeCodeHarnessManifest.js';

export class ClaudeCodeCredentialResolutionError extends Error {
  readonly code = 'CLAUDE_CODE_CREDENTIAL_UNRESOLVED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCodeCredentialResolutionError';
  }
}

function resolveRefSpec(
  manifest: ReturnType<typeof loadClaudeHarnessManifest>,
  ref: string,
): ClaudeHarnessCredentialRefSpec {
  if (!manifest) {
    throw new ClaudeCodeCredentialResolutionError(
      'harness credential manifest is missing under harness_config_root',
    );
  }
  const spec = manifest.credential_refs[ref];
  if (!spec?.host_env?.trim()) {
    throw new ClaudeCodeCredentialResolutionError(
      `credential ref "${ref}" is not declared in harness manifest`,
    );
  }
  return spec;
}

/**
 * Resolve credential using host-frozen auth variable names (not manifest-selected host_env).
 */
export function resolveClaudeCodeHarnessCredentialEnv(
  ref: string,
  admitted: ClaudeCodeAdmittedSession,
  hostEnv: NodeJS.ProcessEnv = process.env,
  trustedAuth?: Pick<ClaudeCodeHostProfileBindingV1, 'auth_host_env' | 'auth_child_env' | 'credential_ref'>,
): Record<string, string> {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new ClaudeCodeCredentialResolutionError('harness_credential_ref is empty');
  }
  if (trustedAuth && trimmed !== trustedAuth.credential_ref) {
    throw new ClaudeCodeCredentialResolutionError('credential ref does not match host binding');
  }
  const manifest = loadClaudeHarnessManifest(admitted.harness_config_root);
  const spec = resolveRefSpec(manifest, trimmed);
  const hostVar = (trustedAuth?.auth_host_env ?? spec.host_env).trim();
  if (trustedAuth && spec.host_env.trim() !== trustedAuth.auth_host_env) {
    throw new ClaudeCodeCredentialResolutionError('manifest host_env does not match host binding');
  }
  const childVar = (trustedAuth?.auth_child_env ?? spec.child_env ?? spec.host_env).trim();
  const value = hostEnv[hostVar]?.trim();
  if (!value) {
    throw new ClaudeCodeCredentialResolutionError(
      `host environment variable ${hostVar} is not configured for credential ref "${trimmed}"`,
    );
  }
  return { [childVar]: value };
}

export async function createProductionClaudeCodeCredentialResolver(): Promise<
  (ref: string, admitted: ClaudeCodeAdmittedSession) => Promise<Record<string, string> | null>
> {
  return async (ref, admitted) => {
    try {
      return resolveClaudeCodeHarnessCredentialEnv(ref, admitted);
    } catch {
      return null;
    }
  };
}
