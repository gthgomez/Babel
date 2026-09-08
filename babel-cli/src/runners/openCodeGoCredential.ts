import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Explicit credential sources accepted by the OpenCode Go transport. */
export type OpenCodeGoCredentialSource = 'opencode-auth-helper' | 'explicit-test'

export interface OpenCodeGoCredentialResolution {
  credential: string
  credentialSource: OpenCodeGoCredentialSource
}

export interface OpenCodeGoCredentialResolverOptions {
  source: OpenCodeGoCredentialSource
  explicitCredential?: string
  helperPath?: string
  existsSyncImpl?: typeof existsSync
  execFileSyncImpl?: typeof execFileSync
}

/** Content-free diagnostic emitted when the approved helper cannot resolve a key. */
export class OpenCodeGoCredentialError extends Error {
  readonly code = 'AUTH_FAILURE' as const
  readonly source: OpenCodeGoCredentialSource
  readonly diagnostic: {
    helperPresent: boolean
    exitCode: number | 'UNKNOWN'
    stderrPresent: boolean
    timedOut: boolean
  }

  constructor(
    source: OpenCodeGoCredentialSource,
    diagnostic: OpenCodeGoCredentialError['diagnostic'],
  ) {
    super('OpenCode Go credential resolution failed.')
    this.name = 'OpenCodeGoCredentialError'
    this.source = source
    this.diagnostic = diagnostic
  }
}

const DEFAULT_HELPER_PATH = join(homedir(), '.claude', 'get-auth-token.js')

/**
 * Resolve an OpenCode Go credential through the approved helper. The key stays
 * only in process memory and is never included in diagnostics or receipts.
 */
export function resolveOpenCodeGoCredential(
  options: OpenCodeGoCredentialResolverOptions,
): OpenCodeGoCredentialResolution {
  if (options.source === 'explicit-test') {
    const credential = options.explicitCredential?.trim()
    if (!credential) {
      throw new OpenCodeGoCredentialError('explicit-test', {
        helperPresent: false,
        exitCode: 'UNKNOWN',
        stderrPresent: false,
        timedOut: false,
      })
    }
    return { credential, credentialSource: 'explicit-test' }
  }

  const helperPath = options.helperPath ?? DEFAULT_HELPER_PATH
  const helperPresent = (options.existsSyncImpl ?? existsSync)(helperPath)
  if (!helperPresent) {
    throw new OpenCodeGoCredentialError('opencode-auth-helper', {
      helperPresent: false,
      exitCode: 'UNKNOWN',
      stderrPresent: false,
      timedOut: false,
    })
  }

  const runHelper = options.execFileSyncImpl ?? execFileSync
  try {
    const stdout = runHelper(process.execPath, [helperPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      windowsHide: true,
    }) as string | Buffer
    const credential = String(stdout).trim()
    if (!credential) {
      throw new OpenCodeGoCredentialError('opencode-auth-helper', {
        helperPresent: true,
        exitCode: 0,
        stderrPresent: false,
        timedOut: false,
      })
    }
    return { credential, credentialSource: 'opencode-auth-helper' }
  } catch (error) {
    if (error instanceof OpenCodeGoCredentialError) throw error
    const candidate = error as { status?: number | null; stderr?: unknown; code?: string }
    throw new OpenCodeGoCredentialError('opencode-auth-helper', {
      helperPresent: true,
      exitCode: typeof candidate.status === 'number' ? candidate.status : 'UNKNOWN',
      stderrPresent: Boolean(candidate.stderr),
      timedOut: candidate.code === 'ETIMEDOUT',
    })
  }
}
