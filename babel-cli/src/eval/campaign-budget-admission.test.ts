import assert from 'node:assert/strict'
import test from 'node:test'
import { CampaignBudget, PILOT_CAMPAIGN_LIMIT_MICRO_USD } from './campaign-budget.js'
import { runCampaignBudgetAdmitted } from './campaign-budget-admission.js'

test('rejected reservation never runs dispatch', async () => {
  const budget = new CampaignBudget({ campaignId: 'pilot', limitMicroUsd: 10 })
  budget.reserve('prior', 9)
  let dispatches = 0
  const outcome = await runCampaignBudgetAdmitted({
    budget,
    operationId: 'blocked',
    upperBoundMicroUsd: 5,
    dispatch: async () => {
      dispatches++
      return 'unused'
    },
    measureUsage: () => 1,
  })
  assert.equal(outcome.admitted, false)
  assert.equal(dispatches, 0)
  assert.equal(budget.remainingMicroUsd(), 1)
})

test('auxiliary and retry operations meter through the same campaign owner', async () => {
  const budget = new CampaignBudget({
    campaignId: 'pilot',
    limitMicroUsd: PILOT_CAMPAIGN_LIMIT_MICRO_USD,
  })
  const main = await runCampaignBudgetAdmitted({
    budget,
    operationId: 'main-turn',
    upperBoundMicroUsd: 100,
    dispatch: async () => 'ok',
    measureUsage: () => 40,
  })
  assert.equal(main.admitted, true)
  const critic = await runCampaignBudgetAdmitted({
    budget,
    operationId: 'critic-pass',
    upperBoundMicroUsd: 50,
    dispatch: async () => 'ok',
    measureUsage: () => 'unknown',
  })
  assert.equal(critic.admitted, true)
  assert.equal(budget.remainingMicroUsd(), PILOT_CAMPAIGN_LIMIT_MICRO_USD - 40 - 50)
})
