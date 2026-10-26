import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { LLMSummarizeCompaction } from './chatCompaction.js'
import { CampaignBudgetStore } from '../eval/campaign-budget-store.js'
import { CampaignDispatchGate, CampaignRouteUnsupportedError } from '../runners/campaignDispatchGate.js'
import { CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID } from '../eval/campaign-qualified-routes.js'
import { PILOT_CAMPAIGN_LIMIT_MICRO_USD } from '../eval/campaign-budget.js'
import type { ProviderInvocationCompleted } from '../runners/base.js'

test('compaction openrouter delivery attaches normalized usage_metadata', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-compaction-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = randomUUID()
  const store = new CampaignBudgetStore({
    statePath: join(root, 'campaign-budget.json'),
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const gate = new CampaignDispatchGate({ campaignId: 'pilot', store, taskOwnerId: owner })
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    choices: [{ message: { content: 'Structured summary body.' } }],
    usage: { prompt_tokens: 12, completion_tokens: 6, cost: 0.00002 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  t.after(() => { globalThis.fetch = savedFetch })
  const priorKey = process.env['OPENROUTER_API_KEY']
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture'
  t.after(() => {
    if (priorKey === undefined) delete process.env['OPENROUTER_API_KEY']
    else process.env['OPENROUTER_API_KEY'] = priorKey
  })
  let delivered: ProviderInvocationCompleted | undefined
  const strategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 })
  const messages = [
    { role: 'user' as const, content: 'old message '.repeat(400) },
    { role: 'assistant' as const, content: 'old reply '.repeat(400) },
    { role: 'user' as const, content: 'recent question' },
  ]
  await strategy.compact(messages, {
    model: CAMPAIGN_QUALIFIED_OPENROUTER_MODEL_ID,
    maxTokens: 8000,
    callbacks: {
      campaignMeter: { executionStage: 'compaction', gate },
      onInvocationCompleted: (event) => { delivered = event },
    },
  })
  assert.equal(delivered?.status, 'delivered')
  assert.equal(delivered?.usage_metadata?.prompt_tokens, 12)
  assert.equal(delivered?.usage_metadata?.completion_tokens, 6)
  assert.equal(delivered?.usage_metadata?.cost_precision, 'exact')
})

test('compaction rejects anthropic wire when campaign meter is active', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-campaign-compaction-anthropic-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const gate = new CampaignDispatchGate({
    campaignId: 'pilot',
    taskOwnerId: randomUUID(),
    store: new CampaignBudgetStore({
      statePath: join(root, 'campaign-budget.json'),
      campaignId: 'pilot',
    }),
  })
  let physicalFetch = 0
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => {
    physicalFetch++
    return new Response('{}', { status: 200 })
  }
  t.after(() => { globalThis.fetch = savedFetch })
  const priorCompactionKey = process.env['BABEL_COMPACTION_API_KEY']
  const priorAnthropic = process.env['ANTHROPIC_API_KEY']
  process.env['BABEL_COMPACTION_API_KEY'] = 'synthetic-anthropic'
  process.env['ANTHROPIC_API_KEY'] = 'synthetic-anthropic'
  t.after(() => {
    if (priorCompactionKey === undefined) delete process.env['BABEL_COMPACTION_API_KEY']
    else process.env['BABEL_COMPACTION_API_KEY'] = priorCompactionKey
    if (priorAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY']
    else process.env['ANTHROPIC_API_KEY'] = priorAnthropic
  })
  const strategy = new LLMSummarizeCompaction({ keepRecentMessages: 2 })
  const messages = [
    { role: 'user' as const, content: 'x'.repeat(8000) },
    { role: 'assistant' as const, content: 'y'.repeat(8000) },
    { role: 'user' as const, content: 'recent' },
  ]
  await assert.rejects(
    () => strategy.compact(messages, {
      model: 'claude-3-5-haiku-20241022',
      maxTokens: 4000,
      callbacks: { campaignMeter: { executionStage: 'compaction', gate } },
    }),
    (error: unknown) => error instanceof CampaignRouteUnsupportedError,
  )
  assert.equal(physicalFetch, 0)
})
