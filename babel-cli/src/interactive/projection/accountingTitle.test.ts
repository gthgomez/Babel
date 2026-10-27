import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectTurnViewState, renderProjectedReviewCard } from './turnViewProjector.js'
import { presentChatReview } from '../../ui/reviewCard.js'
import type { CanonicalTurnEvent } from './canonicalEvents.js'

test('incomplete accounting never projects budget exhaustion or policy refusal', () => {
  for (const outcome of ['INFRA_FAILURE', 'BLOCKED_POLICY', 'BUDGET_EXHAUSTED'] as const) {
    const direct = presentChatReview({ outcome, reasonCode: 'cost_accounting_incomplete', summary: 'Unresolved provider cost' })
    assert.equal(direct.title, 'Cost accounting incomplete')
    assert.match(direct.body, /Cost accounting incomplete/)
    const events: CanonicalTurnEvent[] = [{
      type: 'turn_terminal_resolved', timestamp: 1000, outcome, status: 'blocked',
      reason_code: 'cost_accounting_incomplete', finalAnswer: 'Unresolved provider cost',
    }]
    const view = projectTurnViewState(events)
    assert.equal(view.reviewCard.title, 'Cost accounting incomplete')
    assert.notEqual(view.statusBar.statusLabel, 'ready')
    const rendered = renderProjectedReviewCard(view).body
    assert.match(rendered, /Cost accounting incomplete/)
    assert.doesNotMatch(rendered, /Budget exhausted|Budget limit reached|Blocked by policy/)
  }
})

test('genuine budget exhaustion retains its distinct title', () => {
  const view = projectTurnViewState([{
    type: 'turn_terminal_resolved', timestamp: 1000, outcome: 'BUDGET_EXHAUSTED',
    status: 'budget_exhausted', reason_code: 'budget_exhausted', finalAnswer: 'Cost cap reached',
  }])
  assert.equal(view.reviewCard.title, 'Budget exhausted')
  assert.equal(view.statusBar.statusLabel, 'budget_exhausted')
})
