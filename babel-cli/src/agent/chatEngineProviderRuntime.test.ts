import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LIVE_OPENROUTER_MODEL_ID,
  type ResolvedModelPolicy,
} from '../modelPolicy.js'
import {
  resolveChatFallbackOrFail,
  synthesizeChatAnswer,
  type ChatFallbackInput,
  type ChatProviderRunner,
} from './chatEngineProviderRuntime.js'
import type { ChatUsageScope } from './chatEngineProviderAccounting.js'

function fallbackInput(
  overrides: Partial<ChatFallbackInput> = {},
): ChatFallbackInput {
  return {
    err: new Error('temporary provider interruption'),
    turn: 0,
    ownerGeneration: 1,
    options: {},
    modelPolicy: undefined,
    isSubmissionCurrent: () => true,
    cancelled: () => null,
    failed: (error) => ({ type: 'failed', error }),
    tryFailover: () => null,
    resolveFallback: () => null,
    installFailover: () => {},
    ...overrides,
  }
}

test('stops obsolete provider work without emitting another task terminal', async () => {
  const stream = resolveChatFallbackOrFail(
    fallbackInput({
      isSubmissionCurrent: () => false,
      failed: () => {
        throw new Error('obsolete terminal emitted')
      },
      resolveFallback: () => {
        throw new Error('obsolete fallback resolved')
      },
    }),
  )
  assert.deepEqual(await stream.next(), { done: true, value: null })
})

test('preserves cancellation and rejects fallback on output truncation', async () => {
  const cancelled = resolveChatFallbackOrFail(
    fallbackInput({
      cancelled: () => ({ type: 'cancelled', outcome: 'CANCELLED' }),
    }),
  )
  assert.deepEqual((await cancelled.next()).value, {
    type: 'cancelled',
    outcome: 'CANCELLED',
  })
  assert.equal((await cancelled.next()).value, null)
  const truncated = resolveChatFallbackOrFail(
    fallbackInput({
      err: new Error('finish_reason: length'),
      resolveFallback: () => {
        throw new Error('truncated output must not be retried')
      },
    }),
  )
  const first = await truncated.next()
  assert.ok(!first.done)
  assert.equal(first.value?.type, 'failed')
  assert.equal((await truncated.next()).value, null)
})

test('retains the exact GLM provider route when a generic failover is proposed', async () => {
  const modelPolicy = {
    provider: 'openrouter',
    providerModelId: LIVE_OPENROUTER_MODEL_ID,
  } as ResolvedModelPolicy
  const stream = resolveChatFallbackOrFail(
    fallbackInput({
      modelPolicy,
      tryFailover: () => ({
        fromModel: 'deepseek-v4-pro',
        toModel: 'deepseek-v4-flash',
        reason: 'retry',
        countsAsVerification: false,
      }),
      resolveFallback: () => {
        throw new Error('exact route crossed')
      },
    }),
  )
  const first = await stream.next()
  assert.ok(!first.done)
  const event = first.value
  assert.equal(event?.type, 'failed')
  if (event?.type === 'failed')
    assert.match(event.error, /exact GLM route refuses provider substitution/)
})

test('settles a late synthesis against its captured owner after a successor arrives', async () => {
  let deliver!: (value: string) => void
  const response = new Promise<string>((resolve) => {
    deliver = resolve
  })
  const runner = { executeRaw: () => response } as unknown as ChatProviderRunner
  let currentOwner = 'owner-1'
  const scope: ChatUsageScope = {
    taskOwnerId: currentOwner,
    accountingEpoch: 'epoch-1',
    turnId: 'turn-1',
    chargeId: 'charge-1',
    isOwnerCurrent: () => currentOwner === 'owner-1',
  }
  const settled: string[] = []
  const answer = synthesizeChatAnswer(runner, 'question', {}, scope, {
    retryCallbacks: () => ({}),
    getAbortController: () => new AbortController(),
    settleUsage: (_runner, owner) => {
      settled.push(owner.taskOwnerId ?? '')
    },
  })
  currentOwner = 'owner-2'
  deliver('answer for original owner')
  assert.equal(await answer, 'answer for original owner')
  assert.deepEqual(settled, ['owner-1'])
  assert.equal(scope.isOwnerCurrent?.(), false)
})
