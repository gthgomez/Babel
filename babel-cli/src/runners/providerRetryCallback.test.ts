import assert from 'node:assert/strict'
import test from 'node:test'
import { notifyProviderRetryOrFinalizeOnCallbackError } from './providerRetryCallback.js'

type Input = Parameters<typeof notifyProviderRetryOrFinalizeOnCallbackError>[0]
type FailureStep = 'settleRetry' | 'notifyPhase' | 'notifyCompleted'
const steps: FailureStep[] = ['settleRetry', 'notifyPhase', 'notifyCompleted']
const message = 'Provider retry blocked by task allowance: COST_ACCOUNTING_INCOMPLETE: fixture'

function fixture(failure: Input['failure'], failures: FailureStep[] = []) {
  const original = Object.freeze(new Error(message))
  const calls: string[] = []
  const faults = new Map(failures.map(step => [step, new Error(`fixture ${step} failure`)]))
  let completed: Parameters<Input['notifyCompleted']> | undefined
  const attempt = (step: FailureStep) => {
    calls.push(step)
    if (faults.has(step)) throw faults.get(step)
  }
  const input: Input = {
    notifyRetry: () => { throw original },
    settleRetry: outcome => { assert.equal(outcome, 'failed'); attempt('settleRetry') },
    notifyPhase: () => attempt('notifyPhase'),
    notifyCompleted: (...args) => { completed = args; attempt('notifyCompleted') },
    actualAttempt: 1,
    outputBudget: 100,
    failure,
  }
  return { input, original, calls, faults, completed: () => completed }
}

const transport: Input['failure'] = {
  kind: 'transport', transportErrorMessage: 'Network error: ECONNRESET', transportPhase: 'transport',
}

test('successful retry notification does not finalize an active invocation', async () => {
  const f = fixture(transport)
  f.input.notifyRetry = () => {}
  await notifyProviderRetryOrFinalizeOnCallbackError(f.input)
  assert.deepEqual(f.calls, [])
})

test('ordinary callback stop preserves original identity and primary transport receipt', async () => {
  const f = fixture(transport)
  await assert.rejects(notifyProviderRetryOrFinalizeOnCallbackError(f.input), error => error === f.original)
  assert.deepEqual(f.calls, steps)
  assert.equal(f.completed()?.[0], 'failed')
  assert.equal(f.completed()?.[7]?.failureStage, 'request')
  assert.equal(f.completed()?.[7]?.actualAttempt, 1)
  assert.equal(f.completed()?.[7]?.details?.message, 'Network error: ECONNRESET')
})

for (const failures of [...steps.map(step => [step]), steps]) {
  test(`callback stop survives finalization faults: ${failures.join(', ')}`, async () => {
    const f = fixture(transport, failures)
    await assert.rejects(notifyProviderRetryOrFinalizeOnCallbackError(f.input), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.message, message, 'keep the authoritative stop recognizable')
      assert.equal(error.cause, f.original, 'retain the original control error unchanged')
      const retained = (error as AggregateError & {
        finalizationFailures: ReadonlyArray<{ step: FailureStep; error: unknown }>
      }).finalizationFailures
      assert.deepEqual(retained.map(fault => fault.step), failures)
      assert.deepEqual(retained.map(fault => fault.error), failures.map(step => f.faults.get(step)))
      assert.deepEqual(error.errors, failures.map(step => f.faults.get(step)))
      assert.ok(Object.isFrozen(retained))
      return true
    })
    assert.deepEqual(f.calls, steps, 'one failing finalizer must not skip subsequent finalizers')
    assert.equal(f.completed()?.[7]?.details?.message, 'Network error: ECONNRESET')
  })
}

test('HTTP stop does not consume or await a stalled diagnostic body', async () => {
  let close!: () => void
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { close = () => controller.close() },
  }), { status: 429, headers: { 'x-request-id': 'fixture-request' } })
  const f = fixture({ kind: 'http', response })
  const pending = notifyProviderRetryOrFinalizeOnCallbackError(f.input).then(
    () => ({ outcome: 'returned' as const }),
    error => ({ outcome: 'threw' as const, error }),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      pending,
      new Promise<{ outcome: 'pending' }>(resolve => {
        timer = setTimeout(() => resolve({ outcome: 'pending' }), 200)
      }),
    ])
    assert.equal(result.outcome, 'threw', 'diagnostic body must not delay the stop')
    if (result.outcome === 'threw') assert.equal(result.error, f.original)
    assert.equal(response.bodyUsed, false)
    assert.deepEqual(f.calls, steps)
    assert.equal(f.completed()?.[7]?.details?.status, 429)
    assert.equal(f.completed()?.[7]?.details?.providerRequestId, 'fixture-request')
    assert.match(f.completed()?.[7]?.details?.message ?? '', /body unavailable/)
    assert.equal(f.completed()?.[7]?.failureStage, 'response')
  } finally {
    if (timer) clearTimeout(timer)
    close()
    await pending
  }
})
