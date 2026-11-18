import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PHYSICAL_DISPATCH_MIN_BUDGET_MS,
  assertInvocationBudgetRemaining,
  canDispatchPhysicalRequest,
  createInvocationDeadline,
  invocationNowMs,
  remainingInvocationBudgetMs,
  sleepInvocationRetryBackoff,
} from './providerResponsePolicy.js'

describe('invocation deadline helpers', { concurrency: 1 }, () => {
  it('sleepInvocationRetryBackoff caps wait then refuses further work past deadline', async () => {
    const started = invocationNowMs()
    const invocationDeadlineAt = createInvocationDeadline(25, started)
    await assert.rejects(
      () => sleepInvocationRetryBackoff(5_000, invocationDeadlineAt, 'fixture', 'model', 80),
      /request timeout after 80ms/,
    )
    const elapsed = invocationNowMs() - started
    assert.ok(elapsed < 200, `expected capped sleep, observed ${elapsed}ms`)
    assert.ok(elapsed >= 10, `expected non-zero capped wait, observed ${elapsed}ms`)
  })

  it('sleepInvocationRetryBackoff rejects when budget is already exhausted', async () => {
    const anchor = invocationNowMs()
    await assert.rejects(
      () => sleepInvocationRetryBackoff(1_000, anchor, 'fixture', 'model', 100),
      /request timeout after 100ms/,
    )
  })

  it('sleepInvocationRetryBackoff allows immediate retry when backoff is 0 and budget remains', async () => {
    const invocationDeadlineAt = createInvocationDeadline(5_000)
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

  it('a 1ms early timer wake cannot be accepted as usable retry budget', () => {
    // Regression: setTimeout may fire before the requested deadline. The old
    // helper accepted the leftover 1ms and dispatched another billable attempt.
    assert.throws(
      () => assertInvocationBudgetRemaining(invocationDeadlineAt, 'fixture', 'model', 80, invocationDeadlineAt - 1),
      /request timeout after 80ms/,
    )
    assert.doesNotThrow(
      () => assertInvocationBudgetRemaining(invocationDeadlineAt, 'fixture', 'model', 80, invocationDeadlineAt - 10),
    )
  })

  it('deadlines share the monotonic clock rather than wall time', () => {
    const started = invocationNowMs()
    const deadline = createInvocationDeadline(250, started)
    assert.ok(Math.abs(remainingInvocationBudgetMs(deadline, started) - 250) < 1e-6)
    assert.ok(deadline < Date.now(), 'monotonic deadlines must not be wall-clock epochs')
  })

  it('PHYSICAL_DISPATCH_MIN_BUDGET_MS is the documented 10ms margin', () => {
    assert.equal(PHYSICAL_DISPATCH_MIN_BUDGET_MS, 10)
  })
})
