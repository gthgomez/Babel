import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notifyProviderRetryOrFinalizeOnCallbackError } from '../runners/providerRetryCallback.js'
import {
  LIVE_OPENROUTER_MODEL_ID,
  type ResolvedModelPolicy,
} from '../modelPolicy.js'
import {
  resolveChatFallbackOrFail,
  resolveChatDeliberationRunner,
  resolveChatSynthesisRunner,
  synthesizeChatAnswer,
  type ChatFallbackInput,
  type ChatProviderRunner,
} from './chatEngineProviderRuntime.js'
import type { ChatUsageScope } from './chatEngineProviderAccounting.js'

test('both real Go chat factories use a saved provider key and preserve explicit helper choice',async(t)=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises')
  const {join}=await import('node:path')
  const {tmpdir}=await import('node:os')
  const {OpenCodeGoBudget}=await import('../runners/openCodeGoBudget.js')
  const dir=await mkdtemp(join(tmpdir(),'babel-go-chat-key-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const helper=join(dir,'reject.cjs');await writeFile(helper,'process.exit(17)\n')
  const prior=process.env['BABEL_OPENCODE_GO_HELPER'];process.env['BABEL_OPENCODE_GO_HELPER']=helper
  t.after(()=>{if(prior===undefined)delete process.env['BABEL_OPENCODE_GO_HELPER'];else process.env['BABEL_OPENCODE_GO_HELPER']=prior})
  const policy={provider:'opencode-go',providerModelId:'deepseek-v4.1-flash'} as ResolvedModelPolicy
  const options={budget:new OpenCodeGoBudget({statePath:join(dir,'budget.json'),jobId:'synthetic-chat',limitUsd:1}),env:{BABEL_OPENCODE_GO_API_KEY:'synthetic'}}
  for(const factory of [resolveChatDeliberationRunner,resolveChatSynthesisRunner]){
    assert.doesNotThrow(()=>factory(null,policy,options))
    assert.throws(()=>factory(null,policy,{...options,credentialSource:'opencode-auth-helper'}),/credential resolution failed/)
  }
})

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

test('Desktop initialization failures cannot substitute a synthesis provider or deliberation model', () => {
  const names=['BABEL_DESKTOP_PROVIDER','DEEPSEEK_API_KEY','DEEPINFRA_API_KEY']
  const prior=Object.fromEntries(names.map(name=>[name,process.env[name]]))
  process.env['BABEL_DESKTOP_PROVIDER']='deepseek'
  process.env['DEEPSEEK_API_KEY']='sk-synthetic'
  process.env['DEEPINFRA_API_KEY']='synthetic'
  try {
    const policy={provider:'deepseek',providerModelId:'unsupported-selected-model'} as ResolvedModelPolicy
    for(const factory of [resolveChatDeliberationRunner,resolveChatSynthesisRunner])assert.throws(()=>factory(null,policy))
    delete process.env['DEEPSEEK_API_KEY']
    assert.throws(()=>resolveChatSynthesisRunner(null,{provider:'deepseek',providerModelId:'deepseek-v4-pro'} as ResolvedModelPolicy),/DEEPSEEK_API_KEY.*not set/)
  } finally {for(const name of names){if(prior[name]===undefined)delete process.env[name];else process.env[name]=prior[name]}}
})

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

test('Desktop keeps every selected provider route after a retryable first-turn error', async () => {
  const previousProvider=process.env['BABEL_DESKTOP_PROVIDER']
  try {
    for(const provider of ['deepseek','openrouter','opencode-go','deepinfra','ollama']) {
      process.env['BABEL_DESKTOP_PROVIDER']=provider
      const stream=resolveChatFallbackOrFail(fallbackInput({
        err:new Error('provider HTTP 503'),
        options:{model:'deepseek-v4-pro'},
        modelPolicy:{provider,providerModelId:'deepseek-v4-pro'} as ResolvedModelPolicy,
        tryFailover:()=>{throw new Error('Automatic model substitution was considered')},
        resolveFallback:()=>{throw new Error('Another provider was considered')},
      }))
      const first=await stream.next()
      assert.ok(!first.done)
      assert.equal(first.value?.type,'failed')
      if(first.value?.type==='failed')assert.match(first.value.error,/selected Desktop route/)
      assert.deepEqual(await stream.next(),{done:true,value:null})
    }
  } finally {
    if(previousProvider===undefined)delete process.env['BABEL_DESKTOP_PROVIDER'];else process.env['BABEL_DESKTOP_PROVIDER']=previousProvider
  }
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

async function collectFallbackEvents(
  input: ChatFallbackInput,
): Promise<{ events: Array<{ type: string; error?: string }>; runner: unknown }> {
  const events: Array<{ type: string; error?: string }> = []
  const stream = resolveChatFallbackOrFail(input)
  let runner: unknown = null
  for (;;) {
    const step = await stream.next()
    if (step.done) {
      runner = step.value
      break
    }
    const event = step.value as { type: string; error?: string }
    events.push(event)
  }
  return { events, runner }
}

test('resolveChatFallbackOrFail blocks allowance stops without failover or fallback dispatch', async () => {
  const cases = [
    {
      label: 'bare accounting incomplete',
      err: new Error('COST_ACCOUNTING_INCOMPLETE: fixture unknown charge'),
    },
    {
      label: 'accounting incomplete wrapper',
      err: new Error(
        'Provider retry blocked by task allowance: COST_ACCOUNTING_INCOMPLETE: fixture',
      ),
    },
    {
      label: 'known-cost denial wrapper',
      err: new Error(
        'Provider retry blocked by task allowance: Cost budget exceeded ($2.00 of $2.00) [cost].',
      ),
    },
    {
      label: 'wall denial wrapper',
      err: new Error(
        'Provider retry blocked by task allowance: Time budget exceeded (720s of 720s) [wall].',
      ),
    },
    {
      label: 'unknown allowance wrapper',
      err: new Error(
        'Provider retry blocked by task allowance: Task turn allowance exhausted (120 of 120).',
      ),
    },
  ] as const
  for (const { label, err } of cases) {
    let failoverCalls = 0
    let fallbackCalls = 0
    const { events, runner } = await collectFallbackEvents(
      fallbackInput({
        err,
        tryFailover: () => {
          failoverCalls++
          return null
        },
        resolveFallback: () => {
          fallbackCalls++
          return null
        },
      }),
    )
    assert.equal(failoverCalls, 0, `${label}: tryFailover must not run`)
    assert.equal(fallbackCalls, 0, `${label}: resolveFallback must not run`)
    assert.equal(events.length, 1, `${label}: exactly one terminal event`)
    assert.equal(events[0]?.type, 'failed', `${label}: failed terminal`)
    assert.equal(events[0]?.error, err.message, `${label}: preserves error message`)
    assert.equal(runner, null, `${label}: no fallback runner`)
  }
})

test('allowance stop preserves the existing cancellation or prior-stop winner', async () => {
  for (const winner of [
    { type: 'cancelled', outcome: 'CANCELLED' } as const,
    { type: 'failed', error: 'Execution stopped: existing winner.' } as const,
  ]) {
    const { events, runner } = await collectFallbackEvents(fallbackInput({
      err: new Error('Provider retry blocked by task allowance: COST_ACCOUNTING_INCOMPLETE: fixture'),
      cancelled: () => winner,
      failed: () => { throw new Error('existing winner was replaced') },
      tryFailover: () => { throw new Error('failover considered after stop') },
      resolveFallback: () => { throw new Error('fallback considered after stop') },
    }))
    assert.equal(events.length, 1)
    assert.equal(events[0], winner)
    assert.equal(runner, null)
  }
})

test('allowance fallback owner forwards an explicit harness reason for an unmapped denial', async () => {
  let reason: unknown
  const { events, runner } = await collectFallbackEvents(fallbackInput({
    err: new Error('Provider retry blocked by task allowance: unavailable'),
    failed: (error, value) => { reason = value; return { type: 'failed', error } },
    tryFailover: () => { throw new Error('failover considered after stop') },
    resolveFallback: () => { throw new Error('fallback considered after stop') },
  }))
  assert.equal(events.length, 1)
  assert.equal(runner, null)
  assert.deepEqual(reason, { code: 'unknown', cause_class: 'harness', detail: 'provider_retry_blocked' })
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

// A secondary receipt-write failure must not turn the control stop into fallback input.
test('an allowance stop with retained finalization failures still blocks every fallback', async () => {
  const original = new Error('Provider retry blocked by task allowance: COST_ACCOUNTING_INCOMPLETE: fixture')
  const receiptFailure = new Error('session event persistence failed: fixture')
  let controlError: unknown
  try {
    await notifyProviderRetryOrFinalizeOnCallbackError({
      notifyRetry: () => { throw original },
      settleRetry: () => { throw receiptFailure },
      notifyPhase: () => {},
      notifyCompleted: () => {},
      actualAttempt: 1,
      outputBudget: 100,
      failure: { kind: 'transport', transportErrorMessage: 'ECONNRESET', transportPhase: 'transport' },
    })
  } catch (error) { controlError = error }
  assert.ok(controlError instanceof AggregateError)
  assert.equal(controlError.cause, original)
  const { events, runner } = await collectFallbackEvents(fallbackInput({
    err: controlError,
    tryFailover: () => { throw new Error('failover considered after authoritative stop') },
    resolveFallback: () => { throw new Error('fallback considered after authoritative stop') },
  }))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, 'failed')
  assert.equal(events[0]?.error, original.message)
  assert.equal(runner, null)
})
