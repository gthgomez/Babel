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

test('LSP is withheld until its process adapter supports governed admission', () => {
  assert.equal(canUseChatLsp({ hostFallbackAllowed: false }), false)
  assert.equal(canUseChatLsp({ hostFallbackAllowed: true }), false)
})

test('host isolation and fallback settings never substitute for LSP action authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lsp-profile-'))
  temporaryRoots.push(root)
  delete process.env['BABEL_ALLOW_HOST_FALLBACK']
  delete process.env['BABEL_DOCKER_DISABLE']
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']

  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  assert.equal(canUseChatLsp({
    hostFallbackAllowed: resolveIsolationBrokerFlags(root).hostFallbackAllowed,
  }), false)

  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  assert.equal(canUseChatLsp({
    hostFallbackAllowed: resolveIsolationBrokerFlags(root).hostFallbackAllowed,
  }), false)

  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  assert.equal(canUseChatLsp({
    hostFallbackAllowed: resolveIsolationBrokerFlags(root).hostFallbackAllowed,
  }), false)
})

test('read-only tasks and profiles do not expose LSP', () => {
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

for (const profile of ['safe_repo', 'dev_local']) test(`${profile} LSP is denied before executor dispatch even with host fallback`, async () => {
  process.env['BABEL_EXECUTION_PROFILE'] = profile
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  delete process.env['BABEL_DOCKER_DISABLE']
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE']
  delete process.env['BABEL_READ_ONLY']

  const root = mkdtempSync(join(tmpdir(), 'babel-lsp-policy-'))
  temporaryRoots.push(root)
  const engine = new ChatEngine({ task: 'Fix project symbols', operation: 'CHANGE', projectRoot: root })
  let dispatched = false
  ;(engine as any).persistToolStartedAtExecutorDispatch = () => { dispatched = true }
  const result = await (engine as any).executeOneAction(
    { type: 'lsp', operation: 'workspaceSymbol', filePath: 'src/index.ts', query: 'entry' },
    { agentId: 'test', runId: 'test', runDir: root, babelRoot: root },
    {},
    { index: 0, ownerGeneration: 0 },
  )
  assert.match(result.observation, /LSP denied: Chat has no lease-governed language-server process adapter/)
  assert.equal(dispatched, false)
  assert.equal((engine as any).toolCallLog.at(-1)?.detail, result.observation)
})
