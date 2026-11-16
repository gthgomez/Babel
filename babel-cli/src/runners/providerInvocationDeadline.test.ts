import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import {
  PHYSICAL_DISPATCH_MIN_BUDGET_MS,
  canDispatchPhysicalRequest,
  remainingInvocationBudgetMs,
  sleepInvocationRetryBackoff,
} from './providerResponsePolicy.js'

describe('invocation deadline helpers', { concurrency: 1 }, () => {
  it('sleepInvocationRetryBackoff caps wait then refuses further work past deadline', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 })
    try {
      let settled = false
      const pending = sleepInvocationRetryBackoff(5_000, 10_025, 'fixture', 'model', 80)
      const observed = pending.then(() => { settled = true }, () => { settled = true })
      mock.timers.tick(24)
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(settled, false)
      mock.timers.tick(1)
      await assert.rejects(pending, /request timeout after 80ms/)
      await observed
    } finally {
      mock.timers.reset()
    }
  })

  it('sleepInvocationRetryBackoff rejects when budget is already exhausted', async () => {
    const anchor = Date.now()
    await assert.rejects(
      () => sleepInvocationRetryBackoff(1_000, anchor, 'fixture', 'model', 100),
      /request timeout after 100ms/,
    )
  })

  it('does not retry a delay that exceeds the budget when a timer fires early', async () => {
    const clock = mock.method(Date, 'now', () => 10_000)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      let settled = false
      const pending = sleepInvocationRetryBackoff(5_000, 10_025, 'fixture', 'model', 80)
      const observed = pending.then(() => { settled = true }, () => { settled = true })
      mock.timers.tick(24)
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(settled, false)
      mock.timers.tick(1)
      await assert.rejects(pending, /request timeout after 80ms/)
      await observed
    } finally {
      mock.timers.reset()
      clock.mock.restore()
    }
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
