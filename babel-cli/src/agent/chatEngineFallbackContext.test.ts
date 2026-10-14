import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js'
import { compileChatStack } from './chatStackCompile.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import type { ToolStreamEvent } from '../runners/base.js'

// Capture the serialized production receiver body, not the request-builder arguments.
class CapturingRunner extends DeepInfraApiRunner {
  readonly bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  failRaw = false
  nativeFailures = 0
  announceNativeCall = false
  denyNativeWrite = false
  invalidNativeInput: 'arguments' | 'id' | 'duplicate' | null = null

  constructor() {
    super('fixture-model', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} })
  }

  protected override getRequestMaxRetries(): number { return 1 }
  protected override getStreamMaxRetries(): number { return 0 }
  protected override async dispatchFetch(_url: string, init: RequestInit): Promise<Response> {
    this.bodies.push(JSON.parse(String(init.body)))
    if (this.failRaw) {
      this.failRaw = false
      throw new Error('fixture transport failure')
    }
    const answer = JSON.stringify({ type: 'completion', answer: 'Inspection complete.' })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  override async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
    this.nativeFailures++
    if (this.invalidNativeInput) {
      if (this.nativeFailures === 1) {
        const call = { type: 'tool_use' as const, id: this.invalidNativeInput === 'id' ? '' : 'invalid-call', name: 'read_file', input: this.invalidNativeInput === 'arguments' ? {} : { path: 'src/main.ts' } }
        yield call
        if (this.invalidNativeInput === 'duplicate') yield call
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'Inspection finished.' }
        yield { type: 'done', finishReason: 'stop' }
      }
      return
    }
    if (this.denyNativeWrite) {
      if (this.nativeFailures === 1) {
        yield { type: 'tool_use', id: 'denied-write', name: 'write_file', input: { path: 'src/main.ts', content: 'forbidden change' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: 'The write was denied; no change was applied.' }
        yield { type: 'done', finishReason: 'stop' }
      }
      return
    }
    if (this.announceNativeCall) yield { type: 'tool_use', id: 'announced-call', name: 'read_file', input: { path: 'src/main.ts' } }
    throw new Error('fixture native transport failure')
  }
}

for (const route of ['ordinary_raw', 'legacy_fallback', 'native_downgrade', 'go_refusal', 'announced_native_failure', 'denied_native_write', 'invalid_arguments', 'missing_id', 'duplicate_id'] as const) {
  test(`${route}: final HTTP body preserves policy and destination protocol`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'babel-fallback-context-'))
    const keys = ['BABEL_NATIVE_TOOLS', 'BABEL_TOOL_PROFILE', 'BABEL_COMPACTION']
    const prior = keys.map(key => process.env[key])
    process.env.BABEL_NATIVE_TOOLS = ['ordinary_raw', 'legacy_fallback', 'go_refusal'].includes(route) ? 'disabled' : 'enabled'
    process.env.BABEL_TOOL_PROFILE = 'legacy'
    process.env.BABEL_COMPACTION = 'off'
    t.after(() => {
      keys.forEach((key, index) => {
        if (prior[index] === undefined) delete process.env[key]
        else process.env[key] = prior[index]
      })
      rmSync(root, { recursive: true, force: true })
    })
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/main.ts'), 'export const example = 1\n')
    writeFileSync(join(root, 'AGENTS.md'), 'Preserve POLICY_AGENT_SENTINEL in this task.\n')
    const runner = new CapturingRunner()
    runner.failRaw = route === 'legacy_fallback' || route === 'go_refusal'
    runner.announceNativeCall = route === 'announced_native_failure'
    runner.denyNativeWrite = route === 'denied_native_write'
    runner.invalidNativeInput = route === 'invalid_arguments' ? 'arguments' : route === 'missing_id' ? 'id' : route === 'duplicate_id' ? 'duplicate' : null
    const policy = route === 'go_refusal'
      ? { provider: 'opencode-go', providerModelId: 'deepseek-v4-flash', nativeToolUse: false } as ResolvedModelPolicy
      : undefined
    const engine = new ChatEngine({
      task: 'Inspect GOAL_SENTINEL without changing files', projectRoot: root,
      model: 'deepseek-v4-flash', providerRunner: runner,
      ...(policy ? { providerPolicy: policy } : {}),
      systemContext: 'POLICY_COMPILED_SENTINEL', runtimeMode: 'direct',
      compiledChatStack: compileChatStack({ projectRoot: root, babelRoot: root }),
      maxTurns: 4,
    })
    ;(engine as any).repoMapCache = '## Project map\nPOLICY_MAP_SENTINEL\n'
    const events = []
    const announced: string[] = []
    const settled: string[] = []
    for await (const event of engine.submitMessageStream('Inspect GOAL_SENTINEL; preserve USER_SENTINEL', 'explain')) {
      events.push(event.type)
      if (event.type === 'tool_start') {
        assert.ok(event.toolCallId)
        announced.push(event.toolCallId)
      }
      if (event.type === 'tool_failed') {
        assert.ok(event.toolCallId)
        settled.push(event.toolCallId)
      }
    }
    if (route === 'announced_native_failure') {
      assert.equal(runner.bodies.length, 0, 'a failed announced native batch cannot downgrade into another actionable response')
      assert.deepEqual(settled, announced)
      assert.ok(events.includes('failed'))
      return
    }
    if (route === 'denied_native_write') {
      assert.deepEqual(announced, ['denied-write'])
      assert.deepEqual(settled, announced)
      assert.equal(readFileSync(join(root, 'src/main.ts'), 'utf8'), 'export const example = 1\n')
      return
    }
    if (runner.invalidNativeInput) {
      assert.ok(events.includes('failed'), 'invalid native calls fail before any executor dispatch or protocol retry')
      assert.equal(events.includes('tool_complete'), false)
      assert.equal(runner.nativeFailures, 1)
      assert.equal(runner.bodies.length, 0)
      assert.deepEqual(settled, announced)
      return
    }
    if (route === 'go_refusal') {
      assert.equal(runner.bodies.length, 1)
      assert.ok(events.includes('failed'))
      return
    }
    if (route === 'native_downgrade') assert.equal(runner.nativeFailures, 2)
    const body = runner.bodies.at(-1)!
    const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    const user = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
    assert.equal(system.split('POLICY_COMPILED_SENTINEL').length - 1, 1)
    assert.equal(system.split('POLICY_AGENT_SENTINEL').length - 1, 1)
    assert.equal(system.split('POLICY_MAP_SENTINEL').length - 1, 1)
    assert.match(user, /GOAL_SENTINEL/)
    assert.match(user, /USER_SENTINEL/)
    assert.match(system, /Return one JSON object/)
    assert.match(user, /Respond with the JSON for your next action/)
    assert.doesNotMatch(user, /Use tools as needed, then answer the user/)
  })
}
