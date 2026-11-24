import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { updateUserSettings } from '../config/userSettings.js'
import type { ReplContext } from '../interactive/context.js'
import { selectedProviderRoute } from '../interactive/repl/replReadiness.js'
import { handleConnectionCommand } from './connectionCommands.js'

function parseStatus(text: string): { state: string; reason: string; connectivity: string; nextCommand: string } {
  assert.equal(text.includes('synthetic-status-fixture'), false, 'status must not contain the synthetic key')
  try { return JSON.parse(text) as { state: string; reason: string; connectivity: string; nextCommand: string } }
  catch { throw new Error('Provider status was not valid JSON.') }
}

test('hosted provider status reports the current rejection without raw terminal output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-provider-status-'))
  const priorState = process.env['BABEL_STATE_DIR']
  const priorKey = process.env['BABEL_SYNTHETIC_STATUS_KEY']
  process.env['BABEL_STATE_DIR'] = join(root, 'state')
  process.env['BABEL_SYNTHETIC_STATUS_KEY'] = 'synthetic-status-fixture'
  mkdirSync(join(root, 'project'))
  const oldLog = console.log
  const oldError = console.error
  const raw: string[] = []
  const notices: string[] = []
  try {
    updateUserSettings({ connections: { named: { id: 'named', provider: 'openrouter', model: 'vendor/model', apiKeyEnvVar: 'BABEL_SYNTHETIC_STATUS_KEY' } }, defaults: { connection: 'named' } })
    const state = { model: 'connection/named/vendor/model', connectionId: 'named', modelSource: 'session' as const }
    const route = selectedProviderRoute(state)
    assert.ok(route)
    const ctx = { state, isRunning: false, rejectedProviderRoutes: new Set([route.key]),
      resolveCurrentTarget: () => ({ targetRoot: join(root, 'project') }),
      shellRuntime: { appendNotice: (text: string) => notices.push(text) },
    } as unknown as ReplContext
    console.log = (...args: unknown[]) => { raw.push(args.map(String).join(' ')) }
    console.error = (...args: unknown[]) => { raw.push(args.map(String).join(' ')) }
    await handleConnectionCommand(ctx, 'provider', ['status'])
    assert.equal(raw.length, 0, 'hosted status must not write to the raw console')
    assert.equal(notices.length, 1)
    const status = parseStatus(notices[0]!)
    assert.equal(status.state, 'action_required')
    assert.equal(status.reason, 'credential_rejected')
    assert.equal(status.connectivity, 'rejected')
    assert.equal(status.nextCommand, '/setup')
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      notices.length = 0
      await handleConnectionCommand(ctx, 'provider', [])
      assert.equal(parseStatus(notices[0]!).reason, 'credential_rejected')
    }

    ctx.rejectedProviderRoutes = new Set(['an-old-route'])
    notices.length = 0
    await handleConnectionCommand(ctx, 'provider', ['status'])
    assert.equal(parseStatus(notices[0]!).state, 'configured_unverified')
    notices.length = 0
    await handleConnectionCommand(ctx, 'provider', ['use', 'unknown-fixture-connection'])
    assert.equal(/unknown connection/i.test(notices[0]!), true)
    assert.equal(raw.length, 0, 'hosted command errors must not write to the raw console')

    delete ctx.shellRuntime
    await handleConnectionCommand(ctx, 'provider', ['status'])
    assert.equal(raw.length, 1, 'linear mode retains its console output')
  } finally {
    console.log = oldLog
    console.error = oldError
    if (priorState === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = priorState
    if (priorKey === undefined) delete process.env['BABEL_SYNTHETIC_STATUS_KEY']; else process.env['BABEL_SYNTHETIC_STATUS_KEY'] = priorKey
    rmSync(root, { recursive: true, force: true })
  }
})
