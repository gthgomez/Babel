import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAuthoritativeTaskAllowanceStopError,
  taskAllowanceStopReasonFromError,
  terminalReasonForAuthoritativeTaskAllowanceStop,
} from './chatEngineProviderAccounting.js'

test('isAuthoritativeTaskAllowanceStopError matches every task-allowance retry wrapper', () => {
  assert.equal(
    isAuthoritativeTaskAllowanceStopError(
      new Error(
        'Provider retry blocked by task allowance: COST_ACCOUNTING_INCOMPLETE: unknown pricing',
      ),
    ),
    true,
  )
  assert.equal(
    isAuthoritativeTaskAllowanceStopError(
      new Error(
        'Provider retry blocked by task allowance: Cost budget exceeded ($2.00 of $2.00) [cost].',
      ),
    ),
    true,
  )
  assert.equal(
    isAuthoritativeTaskAllowanceStopError(
      new Error('Provider retry blocked by retired task owner'),
    ),
    true,
  )
})

test('isAuthoritativeTaskAllowanceStopError ignores ordinary retryable provider errors', () => {
  assert.equal(
    isAuthoritativeTaskAllowanceStopError(new Error('[deepInfraApi] HTTP 429 — rate limited')),
    false,
  )
  assert.equal(isAuthoritativeTaskAllowanceStopError(new Error('fetch failed: ECONNRESET')), false)
})

test('reason mapping: accounting vs known-cost denial stay distinct from transport errors', () => {
  const accounting = new Error(
    'Provider retry blocked by task allowance: COST_ACCOUNTING_INCOMPLETE: fixture',
  )
  assert.deepEqual(taskAllowanceStopReasonFromError(accounting), {
    code: 'cost_accounting_incomplete',
    cause_class: 'harness',
    detail: 'provider_retry_blocked',
  })

  const costCap = new Error(
    'Provider retry blocked by task allowance: Cost budget exceeded ($2.00 of $2.00) [cost].',
  )
  assert.equal(taskAllowanceStopReasonFromError(costCap), undefined)
  assert.equal(isAuthoritativeTaskAllowanceStopError(costCap), true)
  assert.deepEqual(terminalReasonForAuthoritativeTaskAllowanceStop(costCap), {
    code: 'budget_exhausted',
    cause_class: 'harness',
  })

  const wallCap = new Error(
    'Provider retry blocked by task allowance: Time budget exceeded (720s of 720s) [wall].',
  )
  assert.equal(taskAllowanceStopReasonFromError(wallCap), undefined)
  assert.deepEqual(terminalReasonForAuthoritativeTaskAllowanceStop(wallCap)?.code, 'budget_exhausted')

  assert.equal(
    terminalReasonForAuthoritativeTaskAllowanceStop(new Error('[openRouterApi] HTTP 503')),
    undefined,
  )
})
