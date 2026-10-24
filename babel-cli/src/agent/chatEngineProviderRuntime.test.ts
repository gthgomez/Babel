import assert from 'node:assert/strict'
import { test } from 'node:test'
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
    reservationBounds: { inputTokens: 0, outputTokens: 0 },
  })
  currentOwner = 'owner-2'
  deliver('answer for original owner')
  assert.equal(await answer, 'answer for original owner')
  assert.deepEqual(settled, ['owner-1'])
  assert.equal(scope.isOwnerCurrent?.(), false)
})
