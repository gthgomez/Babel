import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PHYSICAL_DISPATCH_MIN_BUDGET_MS,
  canDispatchPhysicalRequest,
  remainingInvocationBudgetMs,
  sleepInvocationRetryBackoff,
} from './providerResponsePolicy.js'

describe('invocation deadline helpers', { concurrency: 1 }, () => {
  it('sleepInvocationRetryBackoff caps wait then refuses further work past deadline', async () => {
    const started = Date.now()
    const invocationDeadlineAt = started + 25
    await assert.rejects(
      () => sleepInvocationRetryBackoff(5_000, invocationDeadlineAt, 'fixture', 'model', 80),
      /request timeout after 80ms/,
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 200, `expected capped sleep, observed ${elapsed}ms`)
    assert.ok(elapsed >= 10, `expected non-zero capped wait, observed ${elapsed}ms`)
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
