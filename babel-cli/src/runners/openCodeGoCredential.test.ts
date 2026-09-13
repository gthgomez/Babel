import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BABEL_OPENCODE_GO_HELPER_ENV,
  OpenCodeGoCredentialError,
  resolveOpenCodeGoCredential,
} from './openCodeGoCredential.js'

// Hermeticity: the helper override must not leak between tests, and no test may
// probe a real helper on the host. Every resolver call below either injects an
// explicit helperPath with existsSyncImpl or asserts the fail-closed path.
test.beforeEach(() => {
  delete process.env[BABEL_OPENCODE_GO_HELPER_ENV]
})

test.afterEach(() => {
  delete process.env[BABEL_OPENCODE_GO_HELPER_ENV]
})

test('OpenCode Go credential resolver keeps helper credentials in memory', () => {
  const resolution = resolveOpenCodeGoCredential({
    source: 'opencode-auth-helper',
    helperPath: 'C:\\synthetic\\get-auth-token.js',
    existsSyncImpl: () => true,
    execFileSyncImpl: (() => 'synthetic-helper-credential\n') as never,
  })

  assert.deepEqual(resolution, {
    credential: 'synthetic-helper-credential',
    credentialSource: 'opencode-auth-helper',
  })
})

test('OpenCode Go credential resolver redacts helper failures', () => {
  assert.throws(
    () => resolveOpenCodeGoCredential({
      source: 'opencode-auth-helper',
      helperPath: 'C:\\synthetic\\get-auth-token.js',
      existsSyncImpl: () => true,
      execFileSyncImpl: (() => {
        throw Object.assign(new Error('helper failed: secret-value'), {
          status: 7,
          stderr: 'secret-value',
        })
      }) as never,
    }),
    (error: unknown) => {
      assert.equal(error instanceof OpenCodeGoCredentialError, true)
      assert.equal((error as Error).message.includes('secret-value'), false)
      assert.deepEqual((error as OpenCodeGoCredentialError).diagnostic, {
        helperPresent: true,
        exitCode: 7,
        stderrPresent: true,
        timedOut: false,
      })
      return true
    },
  )
})

test('OpenCode Go credential resolver does not fall back to environment keys', () => {
  assert.throws(
    () => resolveOpenCodeGoCredential({
      source: 'opencode-auth-helper',
      helperPath: 'C:\\missing\\get-auth-token.js',
      existsSyncImpl: () => false,
    }),
    (error: unknown) => error instanceof OpenCodeGoCredentialError && error.code === 'AUTH_FAILURE',
  )
})
