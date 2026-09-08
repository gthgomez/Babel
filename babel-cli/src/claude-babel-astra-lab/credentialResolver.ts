import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type OpenCodeGoCredentialSource = 'opencode-auth-helper' | 'explicit-test';

export interface OpenCodeGoCredentialResolution {
  credential: string;
  authStatus: 'PRESENT';
  credentialSource: OpenCodeGoCredentialSource;
}

export interface OpenCodeGoCredentialResolverOptions {
  source: OpenCodeGoCredentialSource;
  explicitCredential?: string;
  helperPath?: string;
  execFileSyncImpl?: typeof execFileSync;
}

export class OpenCodeGoCredentialError extends Error {
  readonly code = 'AUTH_FAILURE' as const;
  readonly source: OpenCodeGoCredentialSource;
  readonly diagnostic: {
    helper_present: boolean;
    exit_code: number | 'UNKNOWN';
    stderr_present: boolean;
    timed_out: boolean;
  };

  constructor(source: OpenCodeGoCredentialSource, diagnostic: OpenCodeGoCredentialError['diagnostic']) {
    super('OpenCode Go credential resolution failed.');
    this.name = 'OpenCodeGoCredentialError';
    this.source = source;
    this.diagnostic = diagnostic;
  }
}

const DEFAULT_HELPER_PATH = join(homedir(), '.claude', 'get-auth-token.js');

/** Resolve the Go credential through the approved helper without parsing auth.json. */
export function resolveOpenCodeGoCredential(
  options: OpenCodeGoCredentialResolverOptions,
): OpenCodeGoCredentialResolution {
  if (options.source === 'explicit-test') {
    const credential = options.explicitCredential?.trim();
    if (!credential) {
      throw new OpenCodeGoCredentialError('explicit-test', {
        helper_present: false,
        exit_code: 'UNKNOWN',
        stderr_present: false,
        timed_out: false,
      });
    }
    return { credential, authStatus: 'PRESENT', credentialSource: options.source };
  }

  const helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
  const helperPresent = existsSync(helperPath);
  if (!helperPresent) {
    throw new OpenCodeGoCredentialError('opencode-auth-helper', {
      helper_present: false,
      exit_code: 'UNKNOWN',
      stderr_present: false,
      timed_out: false,
    });
  }

  const runHelper = options.execFileSyncImpl ?? execFileSync;
  try {
    // stdout is captured only in process memory. It is never logged, persisted,
    // returned from a receipt, or placed in an error message.
    const stdout = runHelper(process.execPath, [helperPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      windowsHide: true,
    }) as string | Buffer;
    const credential = String(stdout).trim();
    if (!credential) {
      throw new OpenCodeGoCredentialError('opencode-auth-helper', {
        helper_present: true,
        exit_code: 0,
        stderr_present: false,
        timed_out: false,
      });
    }
    return { credential, authStatus: 'PRESENT', credentialSource: 'opencode-auth-helper' };
  } catch (error) {
    if (error instanceof OpenCodeGoCredentialError) throw error;
    const candidate = error as { status?: number | null; stderr?: unknown; code?: string };
    throw new OpenCodeGoCredentialError('opencode-auth-helper', {
      helper_present: true,
      exit_code: typeof candidate.status === 'number' ? candidate.status : 'UNKNOWN',
      stderr_present: Boolean(candidate.stderr),
      timed_out: candidate.code === 'ETIMEDOUT',
    });
  }
}
