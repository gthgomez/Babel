import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatPlanReviewHuman, runPlanReviewLane } from './planReviewLane.js';

describe('planReviewLane', () => {
  it('writes a plan review artifact and human summary offline', async () => {
    const previous = process.env['BABEL_LITE_OFFLINE'];
    process.env['BABEL_LITE_OFFLINE'] = '1';
    const planRunDir = mkdtempSync(join(tmpdir(), 'babel-plan-review-'));
    writeFileSync(
      join(planRunDir, 'plan.md'),
      'Plan: edit src/math.js and run npm test.\n',
      'utf8',
    );
    writeFileSync(
      join(planRunDir, 'model_plan.json'),
      JSON.stringify({
        schema_version: 1,
        status: 'PLAN_READY',
        summary: 'Fix math helper',
        answer: 'Edit src/math.js and verify with npm test.',
        steps: ['Edit src/math.js', 'Run npm test'],
        likely_files: ['src/math.js'],
        risks: [],
        verification: ['npm test'],
        next: [],
      }),
      'utf8',
    );

    try {
      const result = await runPlanReviewLane({
        task: 'Fix the failing math test',
        planRunDir,
        projectRoot: planRunDir,
      });
      assert.equal(result.review.verdict, 'APPROVE');
      assert.match(result.humanText, /Plan review:/);
      assert.match(formatPlanReviewHuman(result.review), /Verdict: APPROVE/);
    } finally {
      if (previous === undefined) {
        delete process.env['BABEL_LITE_OFFLINE'];
      } else {
        process.env['BABEL_LITE_OFFLINE'] = previous;
      }
    }
  });
});
