import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  buildLongitudinalReport,
  computeDeltas,
  HISTORICAL_GENERATIONS,
} from './longitudinalDeltas.js';

const REPO_ROOT = join(process.cwd(), '..');
const BASELINES = join(REPO_ROOT, 'benchmarks', 'baselines');

describe('longitudinalDeltas (T5.2)', () => {
  it('historical series has v6→v8 seeds', () => {
    assert.ok(HISTORICAL_GENERATIONS.length >= 3);
    assert.equal(HISTORICAL_GENERATIONS[0]!.id, 'v6-era');
  });

  it('computeDeltas links consecutive generations', () => {
    const deltas = computeDeltas(HISTORICAL_GENERATIONS);
    assert.ok(deltas.length > 0);
    assert.ok(deltas.some((d) => d.from_id === 'v7-era' && d.to_id === 'v8-parity'));
  });

  it('buildLongitudinalReport includes disk baselines when present', () => {
    const report = buildLongitudinalReport(BASELINES, '2026-07-09T00:00:00.000Z');
    assert.equal(report.artifact_type, 'babel_longitudinal_deltas');
    assert.ok(report.generations.length >= 3);
    assert.ok(report.narrative.length >= 1);
    // Prefer finding R1-R6 or T1.3 when files exist
    const ids = report.generations.map((g) => g.id);
    assert.ok(ids.includes('v8-parity'));
  });
});
