import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createResearchMission } from './missionPlanner.js';
import { buildQueryPlan, extractProblemTerms } from './queryPlanner.js';

const FIXED_NOW = new Date('2026-10-03T12:00:00.000Z');

function missionFor(statement: string) {
  return createResearchMission({
    problem: statement,
    projectRoot: '/tmp/nonexistent-project',
    budgetPreset: 'normal',
    now: FIXED_NOW,
    missionId: 'mission_qp_test',
  });
}

test('extractProblemTerms drops stop words and dedupes', () => {
  const terms = extractProblemTerms('How can we make long-running agent work crash-resilient and crash-resilient?');
  assert.ok(!terms.includes('how'));
  assert.ok(!terms.includes('can'));
  assert.ok(terms.includes('long-running'));
  assert.ok(terms.includes('crash-resilient'));
  assert.equal(new Set(terms).size, terms.length);
});

test('query plan produces 5-8 hypotheses across mandated categories', () => {
  const plan = buildQueryPlan(missionFor('How can we make long-running agent work crash-resilient?'));
  assert.ok(plan.hypotheses.length >= 5 && plan.hypotheses.length <= 8);
  const categories = new Set(plan.hypotheses.map((h) => h.category));
  for (const required of ['direct_terminology', 'mechanism', 'failure_symptom', 'architectural_analogue', 'source_signature']) {
    assert.ok(categories.has(required as never), `missing category ${required}`);
  }
  const queries = new Set(plan.hypotheses.map((h) => h.query.toLowerCase()));
  assert.equal(queries.size, plan.hypotheses.length, 'hypothesis queries must be non-overlapping');
  for (const h of plan.hypotheses) {
    assert.ok(h.rationale.length > 0);
    assert.ok(h.expected_signal.length > 0);
  }
  assert.equal(plan.mission_id, 'mission_qp_test');
});

test('query plan respects the mission search budget', () => {
  const mission = createResearchMission({
    problem: 'reduce token cost of repository exploration',
    projectRoot: '/tmp/nonexistent-project',
    budgetPreset: 'low',
    now: FIXED_NOW,
  });
  const plan = buildQueryPlan(mission);
  assert.ok(plan.hypotheses.length <= mission.budget.max_search_queries);
});
