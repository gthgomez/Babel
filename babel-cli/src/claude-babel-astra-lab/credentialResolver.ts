import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  OpenCodeGoCredentialError as SharedOpenCodeGoCredentialError,
  resolveOpenCodeGoCredential as resolveSharedOpenCodeGoCredential,
  type OpenCodeGoCredentialSource,
} from '../runners/openCodeGoCredential.js';

export type { OpenCodeGoCredentialSource };

export interface OpenCodeGoCredentialResolution {
  credential: string;
  authStatus: 'PRESENT';
  credentialSource: OpenCodeGoCredentialSource;
}

export interface OpenCodeGoCredentialResolverOptions {
  source: OpenCodeGoCredentialSource;
  explicitCredential?: string;
  helperPath?: string;
  existsSyncImpl?: typeof existsSync;
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

/**
 * Compatibility wrapper over the shared Babel-native resolver. It preserves the
 * lab's legacy public shape (`authStatus`) and snake_case diagnostic fields for
 * existing consumers, while delegating all precedence and helper execution to
 * `../runners/openCodeGoCredential.js`: an explicit helper path, then
 * `BABEL_OPENCODE_GO_HELPER`, then the canonical Babel helper
 * `~/.config/babel/get-auth-token.js`, and finally the deprecated Claude-named
 * `~/.claude/get-auth-token.js`. The credential stays in process memory.
 */
export function resolveOpenCodeGoCredential(
  options: OpenCodeGoCredentialResolverOptions,
): OpenCodeGoCredentialResolution {
  try {
    const resolution = resolveSharedOpenCodeGoCredential(options);
    return {
      credential: resolution.credential,
      authStatus: 'PRESENT',
      credentialSource: resolution.credentialSource,
    };
  } catch (error) {
    if (error instanceof SharedOpenCodeGoCredentialError) {
      throw new OpenCodeGoCredentialError(error.source, {
        helper_present: error.diagnostic.helperPresent,
        exit_code: error.diagnostic.exitCode,
        stderr_present: error.diagnostic.stderrPresent,
        timed_out: error.diagnostic.timedOut,
      });
    }
    throw error;
  }
}
