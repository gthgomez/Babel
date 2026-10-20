import type { ClaudeCodeAdmittedSession } from './claudeCodeAdmission.js';
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
 * Resolve an approved credential reference using only the admitted config root manifest
 * and already-configured host environment variables (no helper scripts or global routes).
 */
export function resolveClaudeCodeHarnessCredentialEnv(
  ref: string,
  admitted: ClaudeCodeAdmittedSession,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new ClaudeCodeCredentialResolutionError('harness_credential_ref is empty');
  }
  const manifest = loadClaudeHarnessManifest(admitted.harness_config_root);
  const spec = resolveRefSpec(manifest, trimmed);
  const hostVar = spec.host_env.trim();
  const childVar = (spec.child_env ?? spec.host_env).trim();
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
