import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  sleepInvocationRetryBackoff,
} from './providerResponsePolicy.js'

describe('invocation deadline helpers', () => {
  it('sleepInvocationRetryBackoff caps wait then refuses further work past deadline', async () => {
    const invocationDeadlineAt = Date.now() + 80
    const started = Date.now()
    await assert.rejects(
      () => sleepInvocationRetryBackoff(5_000, invocationDeadlineAt, 'fixture', 'model', 80),
      /request timeout after 80ms/,
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 200, `expected capped sleep, observed ${elapsed}ms`)
    assert.ok(elapsed >= 40, `expected non-zero capped wait, observed ${elapsed}ms`)
  })

  it('sleepInvocationRetryBackoff rejects when budget is already exhausted', async () => {
    const anchor = Date.now()
    await assert.rejects(
      () => sleepInvocationRetryBackoff(1_000, anchor, 'fixture', 'model', 100),
      /request timeout after 100ms/,
    )
  })
})
