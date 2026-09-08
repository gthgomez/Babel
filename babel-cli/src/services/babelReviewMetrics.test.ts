import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBabelReviews } from './babelReviewMetrics.js';
test('metrics retain failures and unknown usage without equating approvals to accuracy', () => {
  const result = summarizeBabelReviews([
    { harness: 'babel', mode: 'chat', model: 'mimo-v2.5', status: 'review_completed', verdict: { verdict: 'BLOCK' }, attempts: [{}, {}], calls: [{ elapsed_ms: 9, metadata: { prompt_tokens: 20, completion_tokens: 3 } }] },
    { harness: 'babel', mode: 'chat', model: 'mimo-v2.5', status: 'review_failed', failure_code: 'INVALID_VERDICT_JSON', calls: [{ elapsed_ms: 7, metadata: null }] },
    { status: 'unrelated' },
  ]);
  assert.equal(result.run_count, 2); assert.equal(result.models['mimo-v2.5']?.blocks, 1);
  assert.equal(result.models['mimo-v2.5']?.calls_with_unknown_usage, 1);
  assert.equal(result.models['mimo-v2.5']?.input_tokens_observed, 20);
  assert.equal(result.models['mimo-v2.5']?.format_repairs, 1);
  assert.equal(result.failures['INVALID_VERDICT_JSON'], 1);
});
