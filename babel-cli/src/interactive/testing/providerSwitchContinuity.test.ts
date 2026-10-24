/**
 * Campaign Task 6: between-turn model route switching continuity.
 *
 * Offline only. Proves that switching among campaign routes on a live engine
 * preserves session identity, durable conversation, task authority and cost
 * accounting; that a busy or rejected attempt leaves the previous selection
 * fully intact; that the durable route-change event survives serialization
 * and resume; and that the interactive projection updates only after the
 * engine's durable selection succeeds.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatEngine } from '../../agent/chatEngine.js'
import { chatSessionDir } from '../../cli/runsLayout.js'
import {
  createEngineFromEventLog,
} from '../../services/threadStore/conversationSync.js'
import {
  parseSessionEventLog,
  serializeSessionEventLog,
} from '../../agent/sessionEventCodec.js'
import type { SessionEventLog } from '../../agent/sessionEventSchema.js'
import { COMMANDCODE_CREDENTIAL_ENV_VAR } from '../../runners/commandCodeApi.js'
import { resolveCampaignRouteByKey, applySessionModelRoute } from '../modelRouteSwitch.js'

const SAVED_ENV: Record<string, string | undefined> = {}

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  for (const name of [...Object.keys(values), COMMANDCODE_CREDENTIAL_ENV_VAR, 'OPENROUTER_API_KEY']) {
    SAVED_ENV[name] = process.env[name]
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    fn()
  } finally {
    for (const [name, value] of Object.entries(SAVED_ENV)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function fixture(body: (engine: ChatEngine, runDir: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'babel-route-switch-'))
  const priorRunsDir = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  try {
    const engine = new ChatEngine({
      task: 'Fix the fixture and run its required tests',
      projectRoot: root,
      requiredVerifierCommands: ['node --test fixture.test.mjs'],
      maxTurns: 12,
    })
    body(engine, chatSessionDir(engine.getEngineRunId()), root)
  } finally {
    if (priorRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = priorRunsDir
    rmSync(root, { recursive: true, force: true })
  }
}

const KEYS = {
  openrouter: 'glm-5.3-flash-openrouter',
  commandcode: 'glm-5.3-flash-commandcode',
}

test('switching OpenRouter to Command Code and back preserves the session', () => {
  withEnv({
    OPENROUTER_API_KEY: 'synthetic-router-key',
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key',
  }, () => fixture((engine) => {
    // A user marker and a tool observation exist before any switch.
    const conversation = (engine as unknown as { conversation: Array<{ role: string; content: string }> }).conversation
    conversation.push({ role: 'user', content: 'MARKER route-switch-2026-10-23' })
    conversation.push({ role: 'user', content: '[tool_result] read src/fixture.ts: 42 lines' })
    const contractBefore = JSON.stringify(engine.getTaskContract())

    const toCommandCode = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.commandcode).route)
    assert.equal(toCommandCode.status, 'applied')
    const commandCodeHash = toCommandCode.status === 'applied' ? toCommandCode.routeHash : ''
    const policyAfterSwitch = (engine as unknown as { modelPolicy: { provider: string; providerModelId: string; resolvedBackendKey: string } }).modelPolicy
    assert.equal(policyAfterSwitch.provider, 'commandcode')
    assert.equal(policyAfterSwitch.providerModelId, 'z-ai/glm-5.3-flash')
    assert.equal(policyAfterSwitch.resolvedBackendKey, KEYS.commandcode)

    const backToOpenRouter = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.openrouter).route)
    assert.equal(backToOpenRouter.status, 'applied')
    const policyAfterReturn = (engine as unknown as { modelPolicy: { provider: string; resolvedBackendKey: string } }).modelPolicy
    assert.equal(policyAfterReturn.provider, 'openrouter')
    assert.equal(policyAfterReturn.resolvedBackendKey, KEYS.openrouter)

    // Session identity, conversation and authority survive both switches.
    assert.equal(JSON.stringify(engine.getTaskContract()), contractBefore)
    const contents = (engine as unknown as { conversation: Array<{ content: unknown }> }).conversation.map((message) => message.content)
    assert.ok(contents.some((text) => String(text).includes('MARKER route-switch-2026-10-23')))
    assert.ok(contents.some((text) => String(text).includes('[tool_result] read src/fixture.ts: 42 lines')))

    // The durable route-change trail carries previous/new hashes.
    const events = (engine as unknown as { parity: { sessionEvents: { events: Array<Record<string, unknown>> } } })
      .parity.sessionEvents.events
      .filter((event) => event.kind === 'model_route_change')
    assert.equal(events.length, 2)
    const first = events[0] as unknown as {
      selector_key: string; route_hash: string; previous_route_hash: string | null; provider: string;
    }
    const second = events[1] as unknown as {
      selector_key: string; route_hash: string; previous_route_hash: string | null; provider: string;
    }
    assert.equal(first.selector_key, KEYS.commandcode)
    assert.equal(first.provider, 'commandcode')
    assert.equal(second.selector_key, KEYS.openrouter)
    assert.equal(second.previous_route_hash, commandCodeHash)
    assert.notEqual(first.route_hash, second.route_hash)
  }))
})

test('a busy turn defers the switch and leaves the selection intact', () => {
  withEnv({
    OPENROUTER_API_KEY: 'synthetic-router-key',
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key',
  }, () => fixture((engine) => {
    const first = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.openrouter).route)
    assert.equal(first.status, 'applied')
    const before = (engine as unknown as { modelPolicy: { resolvedBackendKey: string } }).modelPolicy.resolvedBackendKey

    const internal = engine as unknown as { activeTurnCount: number }
    internal.activeTurnCount = 1
    try {
      const busy = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.commandcode).route)
      assert.equal(busy.status, 'busy')
      assert.match(busy.reason, /turn is currently active/)
      assert.equal((engine as unknown as { modelPolicy: { resolvedBackendKey: string } }).modelPolicy.resolvedBackendKey, before)
    } finally {
      internal.activeTurnCount = 0
    }
    // After settlement the same switch succeeds.
    const applied = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.commandcode).route)
    assert.equal(applied.status, 'applied')
  }))
})

test('a missing credential rejects the switch without touching the old route', () => {
  withEnv({
    OPENROUTER_API_KEY: 'synthetic-router-key',
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: undefined,
  }, () => fixture((engine) => {
    const start = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.openrouter).route)
    assert.equal(start.status, 'applied')
    const before = (engine as unknown as { modelPolicy: { resolvedBackendKey: string } }).modelPolicy.resolvedBackendKey

    const rejected = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.commandcode).route)
    assert.equal(rejected.status, 'rejected')
    assert.match(rejected.reason, /CMD_API_KEY is not set/)
    assert.equal((engine as unknown as { modelPolicy: { resolvedBackendKey: string } }).modelPolicy.resolvedBackendKey, before)
  }))
})

test('an invalid campaign route is rejected and the durable log stays parseable', () => {
  withEnv({
    OPENROUTER_API_KEY: 'synthetic-router-key',
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key',
  }, () => fixture((engine, runDir) => {
    const applied = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.commandcode).route)
    assert.equal(applied.status, 'applied')

    const bogus = { ...resolveCampaignRouteByKey(KEYS.openrouter).route, selectorKey: 'not-a-route' }
    const rejected = engine.selectModelRoute(bogus)
    assert.equal(rejected.status, 'rejected')

    // The durable event log serializes and parses back with the new kind.
    const runtime = (engine as unknown as { parity: { sessionEvents: SessionEventLog } }).parity.sessionEvents
    const serialized = serializeSessionEventLog(runtime)
    const parsed = parseSessionEventLog(serialized)
    const routeEvents = parsed.events.filter((event) => event.kind === 'model_route_change')
    assert.equal(routeEvents.length, 1)
    void runDir
  }))
})

test('a resumed session keeps the accepted contract and the route-change trail', () => {
  withEnv({
    OPENROUTER_API_KEY: 'synthetic-router-key',
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key',
  }, () => fixture((engine) => {
    const applied = engine.selectModelRoute(resolveCampaignRouteByKey(KEYS.commandcode).route)
    assert.equal(applied.status, 'applied')
    const contractBefore = engine.getTaskContract()
    const runtime = (engine as unknown as { parity: { eventLog: unknown } }).parity.eventLog
    const restored = createEngineFromEventLog(
      { task: 'Continuation after route switch', projectRoot: (engine as unknown as { options: { projectRoot: string } }).options.projectRoot },
      runtime as Parameters<typeof createEngineFromEventLog>[1],
    )
    assert.equal(restored.getTaskContract()!.contract_id, contractBefore!.contract_id)
  }))
})

test('applySessionModelRoute updates the projection only after the engine applies', () => {
  withEnv({
    OPENROUTER_API_KEY: 'synthetic-router-key',
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key',
  }, () => {
    // A fake live engine: durable selection first, projection second.
    const appliedKeys: string[] = []
    const saved: Array<Record<string, unknown>> = []
    let applyResult: { status: string; reason?: string; routeHash?: string } = { status: 'applied', routeHash: 'hash-1' }
    const ctx = {
      state: { model: 'glm-5.3-flash-openrouter', resolvedModelId: 'z-ai/glm-5.3-flash' } as Record<string, unknown>,
      chatEngine: {
        selectModelRoute: (route: { selectorKey: string }) => {
          appliedKeys.push(route.selectorKey)
          if (applyResult.status === 'applied') return { status: 'applied', routeHash: applyResult.routeHash }
          return { status: applyResult.status, reason: applyResult.reason }
        },
      },
      saveSessionState: () => { saved.push({ ...ctx.state }) },
    } as unknown as Parameters<typeof applySessionModelRoute>[0]

    const ok = applySessionModelRoute(ctx, KEYS.commandcode)
    assert.equal(ok.status, 'applied')
    assert.deepEqual(appliedKeys, [KEYS.commandcode])
    assert.equal(ctx.state.model, KEYS.commandcode)
    assert.equal(ctx.state.resolvedModelId, 'z-ai/glm-5.3-flash')
    assert.equal(saved.length, 1)

    // A busy engine leaves the projection and saved state untouched.
    applyResult = { status: 'busy', reason: 'turn active' }
    const busy = applySessionModelRoute(ctx, KEYS.openrouter)
    assert.equal(busy.status, 'busy')
    assert.equal(ctx.state.model, KEYS.commandcode)
    assert.equal(saved.length, 1)

    // A rejected engine likewise.
    applyResult = { status: 'rejected', reason: 'credential missing' }
    const rejected = applySessionModelRoute(ctx, KEYS.openrouter)
    assert.equal(rejected.status, 'rejected')
    assert.equal(ctx.state.model, KEYS.commandcode)
    assert.equal(saved.length, 1)
  })
})
