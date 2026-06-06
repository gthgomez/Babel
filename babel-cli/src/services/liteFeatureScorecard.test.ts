import assert from 'node:assert/strict';
import test from 'node:test';

import { runLiteFeatureScorecard } from './liteFeatureScorecard.js';

test('lite feature scorecard covers Cursor-pattern dimensions', async () => {
  const report = await runLiteFeatureScorecard();
  const dimensions = report.dimensions.map(score => score.dimension);
  assert.deepEqual(dimensions, [
    'plan_mode',
    'parallel_review',
    'checkpoint_ux',
    'verifier_discipline',
  ]);
  assert.equal(report.fixture_type, 'babel_lite_feature_scorecard');
  assert.equal(report.status, 'pass');
  for (const score of report.dimensions) {
    assert.equal(score.status, 'pass');
    assert.equal(score.score, 1);
  }
});
