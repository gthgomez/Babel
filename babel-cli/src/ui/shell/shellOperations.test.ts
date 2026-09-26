import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReplContext } from '../../interactive/context.js'
import type { ChatEngine } from '../../agent/chatEngine.js'
import {
  createShellCommandOperations,
  resetHostedConversation,
  runShellCommand,
} from './shellOperations.js'

test('production resume wiring calls resumeChatSession and rebinds the active thread', async () => {
  const engine = { getEngineRunId: () => 'resumed-engine' } as unknown as ChatEngine
  const ctx = { chatEngine: undefined } as unknown as ReplContext
  const changed: Array<string | undefined> = []
  let receivedId: string | undefined

  const operations = createShellCommandOperations(
    ctx,
    { invalidate: () => {}, onSessionChanged: (id) => changed.push(id) },
    {
      resumeChatSession: async (targetCtx, sessionId) => {
        receivedId = sessionId
        targetCtx.chatEngine = engine
        return { ok: true, sessionId, turnCount: 3, exchangeCount: 2, source: 'transcript' }
      },
    },
  )

  const outcome = await runShellCommand({ kind: 'session.resume', id: 'sess-9' }, operations)
  assert.equal(outcome.handled, true)
  assert.equal(receivedId, 'sess-9')
  assert.deepEqual(changed, ['resumed-engine'])
})

test('resume failure is surfaced and does not rebind the active thread', async () => {
  const ctx = {} as unknown as ReplContext
  const changed: Array<string | undefined> = []
  const operations = createShellCommandOperations(
    ctx,
    { invalidate: () => {}, onSessionChanged: (id) => changed.push(id) },
    {
      resumeChatSession: async (_targetCtx, sessionId) => ({
        ok: false,
        sessionId,
        reason: 'missing',
        message: `Session "${sessionId}" not found`,
      }),
    },
  )

  const outcome = await runShellCommand({ kind: 'session.resume', id: 'gone' }, operations)
  assert.equal(outcome.handled, false)
  assert.equal(outcome.message, 'Session "gone" not found')
  assert.deepEqual(changed, [])
})

test('New conversation clears the hosted transcript and rebinds to no session', () => {
  const ctx = {
    chatEngine: { getEngineRunId: () => 'old' },
    lastRoutingLabel: 'x',
    turns: [{ turn_id: 1 }, { turn_id: 2 }],
    lastAssistantAnswer: 'answer',
    lastAssistantNext: 'next',
    lastAssistantStatus: 'OK',
    lastResolvedTask: 'task',
    lastSessionRunDir: '/runs/x',
  } as unknown as ReplContext
  const changed: Array<string | undefined> = []
  const operations = createShellCommandOperations(ctx, {
    invalidate: () => {},
    onSessionChanged: (id) => changed.push(id),
  })

  operations.newSession()
  assert.deepEqual(ctx.turns, [])
  assert.equal(ctx.chatEngine, undefined)
  assert.equal(ctx.lastAssistantAnswer, null)
  assert.equal(ctx.lastResolvedTask, null)
  assert.equal(ctx.lastSessionRunDir, null)
  assert.deepEqual(changed, [undefined])
})

test('resetHostedConversation clears hosted fields idempotently', () => {
  const ctx = {
    turns: [{ turn_id: 1 }],
    lastAssistantAnswer: 'a',
    lastAssistantNext: 'b',
    lastAssistantStatus: 'c',
    lastResolvedTask: 'd',
    lastSessionRunDir: 'e',
  } as unknown as ReplContext
  resetHostedConversation(ctx)
  resetHostedConversation(ctx)
  assert.deepEqual(ctx.turns, [])
  assert.equal(ctx.lastAssistantNext, null)
})
