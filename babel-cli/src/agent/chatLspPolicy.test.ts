import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { ChatEngine } from './chatEngine.js'
import { canUseChatLsp } from './chatLspPolicy.js'
import { resolveIsolationBrokerFlags } from './chatEngineIsolationFlags.js'

const managedEnv = [
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_DOCKER_DISABLE',
  'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_READ_ONLY',
] as const
const previousEnv = new Map(managedEnv.map(key => [key, process.env[key]]))
const temporaryRoots: string[] = []

afterEach(() => {
  for (const key of managedEnv) {
    const value = previousEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('LSP host process requires host-profile or explicit host-fallback authority', () => {
  assert.equal(canUseChatLsp({ hostFallbackAllowed: false }), false)
  assert.equal(canUseChatLsp({ hostFallbackAllowed: true }), true)
})

test('governed isolation grants LSP in dev_local but not safe_repo without escalation', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lsp-profile-'))
  temporaryRoots.push(root)
  delete process.env['BABEL_ALLOW_HOST_FALLBACK']
  delete process.env['BABEL_DOCKER_DISABLE']
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']

  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  assert.equal(canUseChatLsp({
    hostFallbackAllowed: resolveIsolationBrokerFlags(root).hostFallbackAllowed,
  }), true)

  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  assert.equal(canUseChatLsp({
    hostFallbackAllowed: resolveIsolationBrokerFlags(root).hostFallbackAllowed,
  }), false)

  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  assert.equal(canUseChatLsp({
    hostFallbackAllowed: resolveIsolationBrokerFlags(root).hostFallbackAllowed,
  }), true)
})

test('task and profile read-only scopes narrow otherwise granted LSP host authority', () => {
  assert.equal(canUseChatLsp({ hostFallbackAllowed: true, operation: 'READ_ONLY' }), false)
  assert.equal(canUseChatLsp({
    hostFallbackAllowed: true,
    env: { BABEL_EXECUTION_PROFILE: 'read_only_audit' },
  }), false)
  assert.equal(canUseChatLsp({
    hostFallbackAllowed: true,
    env: { BABEL_READ_ONLY: 'true' },
  }), false)
})

test('safe_repo without explicit fallback is denied before LSP executor dispatch', async () => {
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  delete process.env['BABEL_ALLOW_HOST_FALLBACK']
  delete process.env['BABEL_DOCKER_DISABLE']
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']
  delete process.env['BABEL_READ_ONLY']

  const root = mkdtempSync(join(tmpdir(), 'babel-lsp-policy-'))
  temporaryRoots.push(root)
  const engine = new ChatEngine({ task: 'Inspect project symbols', projectRoot: root })
  const result = await (engine as any).executeOneAction(
    { type: 'lsp', operation: 'workspaceSymbol', filePath: 'src/index.ts', query: 'entry' },
    { agentId: 'test', runId: 'test', runDir: root, babelRoot: root },
    {},
    { index: 0, ownerGeneration: 0 },
  )
  assert.match(result.observation, /LSP denied: host-process authority is unavailable/)
  assert.equal((engine as any).toolCallLog.at(-1)?.detail, result.observation)
})
