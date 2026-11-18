import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PHYSICAL_DISPATCH_MIN_BUDGET_MS,
  canDispatchPhysicalRequest,
  remainingInvocationBudgetMs,
  sleepInvocationRetryBackoff,
} from './providerResponsePolicy.js'

describe('invocation deadline helpers', { concurrency: 1 }, () => {
  it('sleepInvocationRetryBackoff caps wait then refuses further work past deadline', async (t) => {
    // Deterministic clock: a real 25ms timer can wake 1ms early, which left
    // 1ms of budget and made this assertion order-dependent on CI load.
    const started = 1_000_000
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(started)
    const pending = sleepInvocationRetryBackoff(5_000, started + 25, 'fixture', 'model', 80)
    t.mock.timers.tick(25)
    await assert.rejects(pending, /request timeout after 80ms/)
    assert.equal(Date.now() - started, 25, 'the backoff must be capped to the remaining budget')
  })

  it('sleepInvocationRetryBackoff refuses a retry below the physical dispatch floor', async (t) => {
    const started = 2_000_000
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(started)
    const pending = sleepInvocationRetryBackoff(10, started + 15, 'fixture', 'model', 80)
    t.mock.timers.tick(10)
    // 5ms remains: not expired, but below PHYSICAL_DISPATCH_MIN_BUDGET_MS, so
    // no physical dispatch could be admitted after this backoff.
    await assert.rejects(pending, /request timeout after 80ms/)
  })

  it('sleepInvocationRetryBackoff returns when usable dispatch budget remains', async (t) => {
    const started = 3_000_000
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(started)
    const pending = sleepInvocationRetryBackoff(10, started + 5_000, 'fixture', 'model', 80)
    t.mock.timers.tick(10)
    await pending
    assert.equal(Date.now() - started, 10)
  })

  it('sleepInvocationRetryBackoff rejects when budget is already exhausted', async () => {
    const anchor = Date.now()
    await assert.rejects(
      () => sleepInvocationRetryBackoff(1_000, anchor, 'fixture', 'model', 100),
      /request timeout after 100ms/,
    )
  })

  it('sleepInvocationRetryBackoff allows immediate retry when backoff is 0 and budget remains', async () => {
    const invocationDeadlineAt = Date.now() + 5_000
    await sleepInvocationRetryBackoff(0, invocationDeadlineAt, 'fixture', 'model', 5_000)
  })
})

describe('physical dispatch budget floor (deterministic clock)', { concurrency: 1 }, () => {
  const invocationDeadlineAt = 10_000

  const boundaryCases: Array<{ remainingMs: number; dispatchAllowed: boolean }> = [
    { remainingMs: 0, dispatchAllowed: false },
    { remainingMs: 1, dispatchAllowed: false },
    { remainingMs: 9, dispatchAllowed: false },
    { remainingMs: 10, dispatchAllowed: true },
    { remainingMs: 11, dispatchAllowed: true },
  ]

  for (const { remainingMs, dispatchAllowed } of boundaryCases) {
    it(`remaining ${remainingMs}ms → dispatch ${dispatchAllowed ? 'allowed' : 'blocked'}`, () => {
      const now = invocationDeadlineAt - remainingMs
      assert.equal(remainingInvocationBudgetMs(invocationDeadlineAt, now), remainingMs)
      assert.equal(canDispatchPhysicalRequest(invocationDeadlineAt, now), dispatchAllowed)
    })
  }

  it('PHYSICAL_DISPATCH_MIN_BUDGET_MS is the documented 10ms margin', () => {
    assert.equal(PHYSICAL_DISPATCH_MIN_BUDGET_MS, 10)
  })
})
