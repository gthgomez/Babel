import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OpenCodeGoCredentialError,
  resolveOpenCodeGoCredential,
} from './openCodeGoCredential.js'

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
    }),
    (error: unknown) => error instanceof OpenCodeGoCredentialError && error.code === 'AUTH_FAILURE',
  )
})
