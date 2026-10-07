import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatEngine } from './chatEngine.js'
import type { ChatEvent } from './chatEngineContracts.js'
import type { ToolDefinition } from '../runners/base.js'

test('change tasks retain productive investigation and may find no required change', async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-productive-change-'))
  const env = { BABEL_RUNS_DIR: join(root, 'runs'), BABEL_CONFIG_DIR: join(root, 'config'),
    BABEL_STATE_DIR: join(root, 'state'), BABEL_CACHE_DIR: join(root, 'cache'),
    BABEL_COMPACTION: 'off', BABEL_MEMORY_WRITEBACK: '0', BABEL_CHAT_MAX_COST: 'unlimited' }
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  const count = 18
  for (let i = 0; i < count; i++) writeFileSync(join(root, `module-${i}.ts`), `export const value = ${i}\n`)
  let calls = 0
  let mutationPressure = 0
  let missingReadCapability = 0
  const runner = {
    async *executeWithToolsStream(messages: unknown, tools: ToolDefinition[], system: string) {
      const context = JSON.stringify(messages) + system
      if (/Do not read more files|Apply the fix .* NOW|You have gathered enough context/.test(context)) mutationPressure++
      if (!tools.some(tool => tool.function.name === 'read_file')) missingReadCapability++
      const index = calls++
      if (index < count) {
        yield { type: 'tool_use', id: `read-${index}`, name: 'read_file', input: { path: `module-${index}.ts` } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'All 18 constants agree with their filenames; no change is needed.' }
        yield { type: 'done', finishReason: 'stop' }
      }
    },
    async executeRaw() { return 'All constants agree; no change is needed.' },
    getLastInvocationMetadata() { return null },
  }
  const task = 'Investigate each module and fix any constant that disagrees with its filename.'
  const engine = new ChatEngine({ task, projectRoot: root, maxTurns: 24 })
  const host = engine as unknown as { deliberationRunner: unknown; synthesisRunner: unknown; shouldUseNativeTools: () => boolean }
  host.deliberationRunner = runner
  host.synthesisRunner = runner
  host.shouldUseNativeTools = () => true
  const events: ChatEvent[] = []
  for await (const event of engine.submitMessageStream(task)) events.push(event)
  const terminal = events.at(-1)
  const unchanged = Array.from({ length: count }, (_, i) =>
    readFileSync(join(root, `module-${i}.ts`), 'utf8') === `export const value = ${i}\n`).every(Boolean)
  t.diagnostic(JSON.stringify({ providerCalls: calls, mutationPressureRequests: mutationPressure,
    missingReadCapabilityRequests: missingReadCapability, unchanged,
    terminal: terminal?.type, outcome: terminal && 'outcome' in terminal ? terminal.outcome : null }))
  assert.equal(engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'HYBRID')
  assert.equal(calls, count + 1)
  assert.equal(mutationPressure, 0)
  assert.equal(missingReadCapability, 0)
  assert.equal(unchanged, true)
  assert.ok(terminal?.type === 'done')
  assert.equal(terminal.outcome, 'NO_CHANGE_REQUIRED')
})
