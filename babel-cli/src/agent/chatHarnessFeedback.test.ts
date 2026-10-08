import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { ChatEngine, type ChatEvent } from './chatEngine.js'
import { rebuildProviderMessagesFromEvents, type ThreadEvent } from './threadEventLog.js'
import type { ProviderMessage } from '../runners/base.js'

const roots: string[] = []
const managedEnv = ['BABEL_CHAT_MAX_COST', 'BABEL_RUNS_DIR', 'BABEL_CONFIG_DIR', 'BABEL_STATE_DIR', 'BABEL_CACHE_DIR'] as const
let previousEnv: Record<string, string | undefined> = {}

before(() => {
  previousEnv = Object.fromEntries(managedEnv.map((key) => [key, process.env[key]]))
  const root = mkdtempSync(join(tmpdir(), 'babel-harness-feedback-state-'))
  roots.push(root)
  process.env['BABEL_CHAT_MAX_COST'] = 'unlimited'
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  process.env['BABEL_CONFIG_DIR'] = join(root, 'config')
  process.env['BABEL_STATE_DIR'] = join(root, 'state')
  process.env['BABEL_CACHE_DIR'] = join(root, 'cache')
})

after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-harness-feedback-project-'))
  roots.push(root)
  return root
}

function installFeedbackSensitiveScript(engine: ChatEngine) {
  let calls = 0
  let readIssued = false
  const requests: ProviderMessage[][] = []
  const runner = {
    async *executeWithToolsStream(
      messages?: ProviderMessage[],
      _tools?: Array<{ function?: { name?: string } }>,
    ) {
      const request = messages ?? []
      requests.push(request.map(message => ({ ...message })))
      const hasControllerFeedback = request.some(message => message.name === 'harness_feedback')
      calls += 1

      if (!hasControllerFeedback) {
        yield { type: 'text_delta', text: 'I changed the configuration and verified the requested fix.' }
        yield { type: 'done', finishReason: 'stop' }
        return
      }

      if (!readIssued) {
        readIssued = true
        yield {
          type: 'tool_use',
          id: 'inspect-existing-setting',
          name: 'read_file',
          input: { path: 'settings.txt' },
        }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }

      yield { type: 'text_delta', text: 'The requested setting is already present in settings.txt; no edit was needed.' }
      yield { type: 'done', finishReason: 'stop' }
    },
    async execute() { return { type: 'completion', answer: 'scripted harness feedback fixture' } },
    async executeRaw() { return 'scripted harness feedback fixture' },
    getLastInvocationMetadata() { return null },
  }
  const target = engine as unknown as Record<string, unknown>
  target['deliberationRunner'] = runner
  target['synthesisRunner'] = runner
  target['shouldUseNativeTools'] = () => true
  return { calls: () => calls, requests }
}

function installProductiveRangeScript(engine: ChatEngine, file: string, rangeCount: number) {
  let calls = 0
  const toolRequests: Array<string[]> = []
  const runner = {
    async *executeWithToolsStream(
      _messages?: ProviderMessage[],
      tools?: Array<{ function?: { name?: string } }>,
    ) {
      toolRequests.push((tools ?? []).map(tool => tool.function?.name ?? ''))
      const index = calls++
      if (index < rangeCount) {
        const start = 1 + index * 10
        yield {
          type: 'tool_use',
          id: `productive-range-${index}`,
          name: 'read_range',
          input: { file_path: file, start_line: start, end_line: start + 4 },
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: `Reviewed ${rangeCount} distinct, nonoverlapping ranges and summarized their contents.` }
        yield { type: 'done', finishReason: 'stop' }
      }
    },
    async execute() { return { type: 'completion', answer: 'scripted productive ranges' } },
    async executeRaw() { return 'scripted productive ranges' },
    getLastInvocationMetadata() { return null },
  }
  const target = engine as unknown as Record<string, unknown>
  target['deliberationRunner'] = runner
  target['synthesisRunner'] = runner
  target['shouldUseNativeTools'] = () => true
  return { calls: () => calls, toolRequests }
}

async function run(engine: ChatEngine, prompt: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of engine.submitMessageStream(prompt)) events.push(event)
  return events
}

function finalDone(events: ChatEvent[]): Extract<ChatEvent, { type: 'done' }> {
  const result = events.filter((event): event is Extract<ChatEvent, { type: 'done' }> => event.type === 'done').at(-1)
  assert.ok(result, `expected a natural terminal completion, got ${events.map(event => event.type).join(', ')}`)
  return result
}

test('rejected native completion feedback is controller-owned, durable, and changes the next provider action', async () => {
  const root = project()
  const existingBytes = 'mode=safe\n'
  writeFileSync(join(root, 'settings.txt'), existingBytes)
  const task = 'Fix settings.txt so mode is safe.'
  const engine = new ChatEngine({ task, projectRoot: root, maxTurns: 6 })
  const runner = installFeedbackSensitiveScript(engine)

  const events = await run(engine, task)
  const done = finalDone(events)

  const capturedMessages = runner.requests.map(messages => messages.map(message => ({
    role: message.role,
    name: message.name,
    content: message.content,
  })))
  assert.equal(runner.calls(), 3, JSON.stringify(capturedMessages))
  assert.equal(done.outcome, 'NO_CHANGE_REQUIRED')
  assert.equal(readFileSync(join(root, 'settings.txt'), 'utf8'), existingBytes)
  assert.equal(done.toolCalls?.filter(call => ['write_file', 'str_replace', 'apply_patch'].includes(call.tool)).length, 0)

  const visibleFeedback = runner.requests.flatMap(messages =>
    messages.filter(message => message.name === 'harness_feedback'))
  assert.equal(runner.requests[0]?.some(message => message.name === 'harness_feedback'), false,
    'the first request contains no synthetic controller rejection feedback')
  assert.equal(runner.requests[1]?.some(message => message.name === 'harness_feedback'), true,
    'the rejected completion causes feedback before the next tool decision')
  assert.equal(runner.requests[2]?.some(message => message.name === 'harness_feedback'), true,
    'feedback remains in context after the inspection result')
  assert.ok(visibleFeedback.length > 0, 'the subsequent native provider request sees gate feedback')
  for (const message of visibleFeedback) {
    assert.equal(message.role, 'assistant')
    assert.equal(message.provenance, 'controller')
    assert.equal(message.authoritative, false)
  }

  const parity = engine.getParityRuntime()
  const durableFeedback = parity.eventLog.events.filter(
    (event): event is Extract<ThreadEvent, { kind: 'assistant_message' }> =>
      event.kind === 'assistant_message' && event.name === 'harness_feedback',
  )
  assert.ok(durableFeedback.length > 0, 'gate feedback is recorded in the durable thread event log')
  for (const event of durableFeedback) {
    assert.equal(event.provenance, 'controller')
    assert.equal(event.authoritative, false)
  }

  const coldMessages = rebuildProviderMessagesFromEvents(parity.eventLog)
  const coldFeedback = coldMessages.filter(message => message.name === 'harness_feedback')
  assert.deepEqual(
    coldFeedback.map(message => ({ content: message.content, provenance: message.provenance, authoritative: message.authoritative })),
    durableFeedback.map(event => ({ content: event.content, provenance: event.provenance, authoritative: event.authoritative })),
    'cold reconstruction retains the same advisory provenance without granting authority',
  )
})

test('fresh nonoverlapping ranges on one file preserve inspection and reach natural completion', async () => {
  const root = project()
  const file = 'large.txt'
  const lineCount = 120
  writeFileSync(join(root, file), Array.from({ length: lineCount }, (_, index) =>
    `range-evidence-${index + 1}`).join('\n') + '\n')
  const rangeCount = 12
  const task = 'Inspect twelve distinct sections of large.txt and summarize their evidence. Do not edit.'
  const engine = new ChatEngine({ task, projectRoot: root, maxTurns: rangeCount + 3 })
  const runner = installProductiveRangeScript(engine, file, rangeCount)
  const events = await run(engine, task)
  const done = finalDone(events)

  assert.equal(done.outcome, 'NO_CHANGE_REQUIRED')
  assert.equal(runner.calls(), rangeCount + 1)
  assert.equal(done.toolCalls?.filter(call => call.tool === 'read_range').length, rangeCount)
  assert.ok(runner.toolRequests.every(names => names.includes('read_range')),
    'read_range remains available after each distinct receipt on the same file')
  assert.ok(!events.some(event => event.type === 'progress_recovery' &&
    (event.intervention === 'restricted_tools' || event.intervention === 'terminal_blocked')),
  'fresh content receipts are productive progress, not a target-only stall')
  assert.equal(readFileSync(join(root, file), 'utf8').split('\n').length, lineCount + 1)
})
