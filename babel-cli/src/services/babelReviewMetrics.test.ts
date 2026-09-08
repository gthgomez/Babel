import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBabelReviews } from './babelReviewMetrics.js';
import { parseBabelReviewAdjudication } from './babelReviewAdjudication.js';
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

test('separates pending and unknown status from failures and leaves unknown cost null', () => {
  const result = summarizeBabelReviews(['started', 'running', 'cli_completed', 'strange', 'review_failed'].map(status => ({ harness: 'babel', mode: 'chat', model: 'mimo-v2.5', status, calls: [] })));
  assert.equal(result.models['mimo-v2.5']?.pending, 3);
  assert.equal(result.models['mimo-v2.5']?.unknown_status, 1);
  assert.equal(result.models['mimo-v2.5']?.failed, 1);
  assert.equal(result.models['mimo-v2.5']?.estimated_cost_usd_total, null);
});

test('estimates are not billed costs and unknown retry usage is retained', () => {
  const result = summarizeBabelReviews([{ harness: 'babel', mode: 'chat', model: 'longcat-2.0', status: 'review_completed', calls: [
    { status: 'failed', retry_reason: 'transient_before_output', metadata: { prompt_tokens: -1, completion_tokens: null, estimated_cost_usd: null } },
    { status: 'completed', elapsed_ms: 20, metadata: { prompt_tokens: 100, completion_tokens: 10, estimated_cost_usd: 0.001 } },
  ] }]);
  const model = result.models['longcat-2.0']!;
  assert.equal(model.transient_retries, 1);
  assert.equal(model.calls_with_unknown_usage, 1);
  assert.equal(model.estimated_cost_usd_observed, 0.001);
  assert.equal(model.estimated_cost_usd_total, null);
  assert.equal(model.calls_with_unknown_latency, 1);
  const incomplete = summarizeBabelReviews([{ harness: 'babel', mode: 'chat', model: 'mimo-v2.5', status: 'review_failed', payload: { usage: { totalCostUSD: 1.59 }, tool_call_count: 0 }, calls: [{ metadata: { estimated_cost_usd: null } }] }]);
  assert.equal(incomplete.models['mimo-v2.5']?.estimated_cost_usd_total, null);
  assert.match(incomplete.missing_observations.tool_outcome_counts, /unknown/);
});

function label(id: string, outcome: 'confirmed' | 'false_positive' | 'inconclusive' | 'missed_defect', execution = 'review-1', head = 'b'.repeat(40), time = '2026-09-08T00:00:00.000Z') {
  return parseBabelReviewAdjudication({ schema_version: 1, kind: 'babel_review_adjudication', authority: 'operator_recorded_not_independently_verified', id, recorded_at: time, execution_id: execution,
    candidate: { repository: 'example/repo', pr_number: 1, base_sha: 'a'.repeat(40), head_sha: head },
    subject: { kind: outcome === 'missed_defect' ? 'missed_defect' : 'finding', id: 'c'.repeat(64) }, outcome,
    evidence: [{ kind: 'test', ref: 'artifact:tests/receipt.json' }],
  });
}

test('precision includes only adjudicated findings and corrections bind exact execution and candidate', () => {
  const result = summarizeBabelReviews([{ harness: 'babel', mode: 'chat', model: 'mimo-v2.5', execution_id: 'review-1', status: 'review_completed' }], [
    label('11111111-1111-4111-8111-111111111111', 'false_positive'),
    label('22222222-2222-4222-8222-222222222222', 'confirmed', 'review-1', 'b'.repeat(40), '2026-09-08T00:01:00.000Z'),
    label('33333333-3333-4333-8333-333333333333', 'false_positive', 'review-2'),
    label('44444444-4444-4444-8444-444444444444', 'inconclusive', 'review-1', 'd'.repeat(40)),
    label('55555555-5555-4555-8555-555555555555', 'missed_defect'),
    { invalid: true },
  ]);
  assert.equal(result.quality.records, 5);
  assert.equal(result.quality.unique_subjects, 4);
  assert.equal(result.quality.invalid_records, 1);
  assert.equal(result.quality.precision_denominator, 2);
  assert.equal(result.quality.labeled_finding_precision, 0.5);
  assert.equal(result.quality.outcomes.missed_defect, 1);
  assert.equal(result.quality.labels_without_observed_execution, 1);
  assert.equal(result.quality.recall, null);
  assert.equal(result.quality.ground_truth_coverage, 'unknown');
});

test('links repair, tests, rereview and merge as recorded rather than independently verified outcomes', () => {
  const record = label('11111111-1111-4111-8111-111111111111', 'confirmed');
  record.links = { repair_execution_id: 'repair-1', repair_head_sha: 'd'.repeat(40), test_runs: ['artifact:tests/receipt.json'], rereview_execution_ids: ['review-2'], merge_commit_sha: 'e'.repeat(40), merge_ref: 'https://github.com/example/repo/commit/' + 'e'.repeat(40) };
  const result = summarizeBabelReviews([], [record]);
  assert.equal(result.quality.lifecycle_links_recorded.with_full_recorded_chain, 1);
  assert.equal(result.quality.authority, 'operator_recorded_not_independently_verified');
  assert.equal(result.quality.time_to_verified_merge_ms, null);
  assert.equal(summarizeBabelReviews([]).quality.labeled_finding_precision, null);
});
