import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ReplContext } from '../context.js'
import { selectedProviderRoute } from './replReadiness.js'
import { setupReplConnection } from './replProviderSetup.js'

test('only completed setup clears the selected route rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-route-recovery-'))
  const state = join(root, 'state'); const project = join(root, 'project')
  const previous = { state: process.env['BABEL_STATE_DIR'], project: process.env['BABEL_PROJECT_ROOT'], key: process.env['ROUTE_FIXTURE_KEY'] }
  mkdirSync(state); mkdirSync(project); writeFileSync(join(project, 'README.md'), 'fixture')
  writeFileSync(join(state, 'preferences.json'), JSON.stringify({ schemaVersion: 1, connections: {
    a: { id: 'a', provider: 'openrouter', model: 'vendor/model', apiKeyEnvVar: 'ROUTE_FIXTURE_KEY' },
  }, defaults: { connection: 'a', model: 'vendor/model' } }))
  process.env['BABEL_STATE_DIR'] = state; process.env['BABEL_PROJECT_ROOT'] = project; process.env['ROUTE_FIXTURE_KEY'] = 'synthetic-only'
  try {
    const ctx = Object.create(null) as ReplContext
    ctx.state = { mode: 'chat', router: 'v9', connectionId: 'a', model: 'connection/a/vendor/model', readinessState: 'action_required',
      costTotals: { totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 }, turnCount: 0 }
    ctx.resolveCurrentTarget = () => ({ targetRoot: project, workspaceRoot: null, project: null, source: 'cwd', cwd: project })
    ctx.resolveSessionModel = () => {}; ctx.saveSessionState = () => {}
    const route = selectedProviderRoute(ctx.state)
    assert.ok(route)
    ctx.rejectedProviderRoutes = new Set([route.key, 'different-route'])
    let closed = 0
    ctx.chatEngine = { closeAdmissionStore: () => { closed++ } } as never
    ctx.withExclusiveTerminal = (async () => ({ state: 'configured_unverified', saved: { connection: 'a', model: 'vendor/model' } })) as never
    await setupReplConnection(ctx)
    assert.equal(ctx.rejectedProviderRoutes.has(route.key), false)
    assert.equal(ctx.rejectedProviderRoutes.has('different-route'), true)
    assert.equal(ctx.state.readinessState, 'configured_unverified')
    assert.equal(ctx.chatEngine, undefined); assert.equal(closed, 1)

    ctx.rejectedProviderRoutes.add(route.key); ctx.state.readinessState = 'action_required'
    ctx.withExclusiveTerminal = (async () => ({ state: 'action_required' })) as never
    await setupReplConnection(ctx)
    assert.equal(ctx.rejectedProviderRoutes.has(route.key), true)
    assert.equal(ctx.state.readinessState, 'action_required')
  } finally {
    for (const [name, value] of Object.entries({ BABEL_STATE_DIR: previous.state, BABEL_PROJECT_ROOT: previous.project, ROUTE_FIXTURE_KEY: previous.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
