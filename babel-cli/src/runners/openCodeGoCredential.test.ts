import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

test('OpenCode Go reads opaque network secret only with explicit source', () => {
  const env = { BABEL_OPENCODE_GO_API_KEY: '  synthetic-proxy-placeholder  ', OPENCODE_API_KEY: 'ignored-synthetic' }
  const resolution = resolveOpenCodeGoCredential({ source: 'network-secret', env, existsSyncImpl: () => { throw new Error('must not inspect helpers') } })
  assert.equal(resolution.credential, 'synthetic-proxy-placeholder')
  assert.equal(resolution.credentialSource, 'network-secret')
  assert.throws(() => resolveOpenCodeGoCredential({ source: 'network-secret', env: { OPENCODE_API_KEY: 'ignored-synthetic' }, execFileSyncImpl: (() => { throw new Error('must not invoke helper') }) as never }), OpenCodeGoCredentialError)
})

test('native-resolved Go credentials cannot fall back to a helper after removal',()=>{
  let helperProbes=0
  const options={source:'opencode-auth-helper' as const,env:{BABEL_DESKTOP_IPC:'1',BABEL_DESKTOP_CREDENTIALS_RESOLVED:'1'},helperPath:'C:\\synthetic\\retained-helper.js',existsSyncImpl:()=>{helperProbes++;return true},execFileSyncImpl:(()=>'synthetic-retained-helper') as never}
  assert.throws(()=>resolveOpenCodeGoCredential(options),OpenCodeGoCredentialError,'DESKTOP_REMOVED_GO_HELPER_FALLBACK')
  assert.equal(helperProbes,0,'removed key must not probe another credential source')
  const selected=resolveOpenCodeGoCredential({...options,env:{...options.env,BABEL_OPENCODE_GO_API_KEY:'synthetic-native-go'}})
  assert.equal(selected.credential==='synthetic-native-go',true)
  assert.equal(selected.credentialSource,'network-secret')
  assert.equal(helperProbes,0)
})

test('a local resolver environment cannot mask native process credential ownership',()=>{
  const names=['BABEL_DESKTOP_IPC','BABEL_DESKTOP_CREDENTIALS_RESOLVED']
  const previous=names.map(name=>process.env[name])
  let helperProbes=0
  try{
    for(const name of names)process.env[name]='1'
    assert.throws(()=>resolveOpenCodeGoCredential({source:'opencode-auth-helper',env:{},helperPath:'C:\\synthetic\\retained-helper.js',existsSyncImpl:()=>{helperProbes++;return true},execFileSyncImpl:(()=>'synthetic-retained-helper') as never}),OpenCodeGoCredentialError,'DESKTOP_REMOVED_GO_HELPER_FALLBACK')
    assert.equal(helperProbes,0)
  }finally{for(const [index,name] of names.entries()){if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index]}}
})

const networkSecretHelper = fileURLToPath(new URL('../../../tools/opencode-go-network-secret-helper.cjs', import.meta.url))
const helperFailure = 'OpenCode Go network-secret placeholder unavailable or invalid.\n'

test('checked-in helper passes only the requested dummy placeholder to the resolver', () => {
  const placeholder = 'dummy-personal-vault-placeholder_Abc-123'
  const resolution = resolveOpenCodeGoCredential({
    source: 'opencode-auth-helper',
    helperPath: networkSecretHelper,
    existsSyncImpl: (candidate) => candidate === networkSecretHelper && existsSync(candidate),
    execFileSyncImpl: ((executable: string, args: string[], options: object) => execFileSync(executable, args, {
      ...options,
      env: { BABEL_OPENCODE_GO_API_KEY: placeholder, OPENCODE_API_KEY: 'ignored-dummy-value' },
    })) as never,
  })
  assert.equal(resolution.credential, placeholder)
  assert.equal(resolution.credentialSource, 'opencode-auth-helper')
})

test('checked-in helper emits a dummy placeholder without diagnostics', () => {
  const placeholder = 'dummy-proxy-placeholder:opaque/value=1'
  const result = spawnSync(process.execPath, [networkSecretHelper], {
    encoding: 'utf8', env: { BABEL_OPENCODE_GO_API_KEY: placeholder }, timeout: 5_000,
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, placeholder)
  assert.equal(result.stderr, '')
})

test('checked-in helper fails closed without the requested network-secret key', () => {
  const result = spawnSync(process.execPath, [networkSecretHelper], {
    encoding: 'utf8', env: { OPENCODE_API_KEY: 'ignored-dummy-value' }, timeout: 5_000,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, helperFailure)
})

test('checked-in helper rejects unsafe or oversized header values without echoing them', () => {
  for (const value of ['', 'dummy\rvalue', 'dummy\nvalue', 'dummy\u0001value', 'dummy value', 'dummy-é', 'x'.repeat(8193)]) {
    const result = spawnSync(process.execPath, [networkSecretHelper], {
      encoding: 'utf8', env: { BABEL_OPENCODE_GO_API_KEY: value }, timeout: 5_000,
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, helperFailure)
  }
})
