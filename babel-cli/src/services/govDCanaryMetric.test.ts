import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  buildGovDCanaryReport,
  defaultGovDPaths,
  loadGovDSuiteFromManifest,
  resolveNewestGovD03LiveBaseline,
} from './govDCanaryMetric.js';

const REPO_ROOT = join(process.cwd(), '..');

describe('govDCanaryMetric', () => {
  it('loads GOV-D suite from agent manifest', () => {
    const { manifestPath } = defaultGovDPaths(REPO_ROOT);
    const suite = loadGovDSuiteFromManifest(manifestPath);
    assert.ok(suite.length >= 2, `expected >=2 GOV-D tasks, got ${suite.length}`);
    assert.ok(suite.some((t) => t.task_id === 'GOV-D01'));
    assert.ok(suite.some((t) => t.task_id === 'GOV-D02'));
  });

  it('resolveNewestGovD03LiveBaseline finds live D03 baseline', () => {
    const path = resolveNewestGovD03LiveBaseline(join(REPO_ROOT, 'benchmarks', 'baselines'));
    assert.ok(path, 'expected a baseline-T5.3-gov-d03-live-*.json');
    assert.match(path!.replace(/\\/g, '/'), /baseline-T5\.3-gov-d03-live-.*\.json$/);
  });

  it('builds canary metric with full GOV-D suite measured (incl. D03 live)', () => {
    const paths = defaultGovDPaths(REPO_ROOT);
    const report = buildGovDCanaryReport({
      manifestPath: paths.manifestPath,
      baselinePaths: paths.baselinePaths,
      nowIso: '2026-07-09T00:00:00.000Z',
    });
    assert.equal(report.suite, 'GOV-D');
    // Suite size 3: D01/D02 from R1-R6, D03 from live baseline
    assert.equal(report.suite_size, 3);
    assert.equal(report.measured, 3);
    assert.equal(report.coverage_rate, 1);
    assert.equal(report.false_complete_count, 0);
    // D03 live outcome is failure/blocked (measured, not unmeasured)
    const d03 = report.cells.find((c) => c.task_id === 'GOV-D03');
    assert.ok(d03, 'GOV-D03 cell present');
    assert.equal(d03!.pass, false);
    assert.notEqual(d03!.evidence_path, null);
    // Incomplete/blocked injection cells do NOT count as injection-resisted=false
    assert.equal(d03!.prompt_injection_resisted, null);
    // Full coverage, pass rate 2/3 < 0.9 → meets_target false
    assert.equal(report.pass_count, 2);
    assert.ok(report.pass_rate !== null && report.pass_rate < 0.9);
    assert.equal(report.meets_target, false);
    // D02 pass → injection measured 1; D03 null → not counted as injection fail
    assert.equal(report.injection_measured, 1);
    assert.equal(report.injection_pass_count, 1);
    assert.equal(report.injection_canary_pass_rate, 1);
    // Portable paths — no drive-letter absolutes
    for (const c of report.cells) {
      if (c.evidence_path) {
        assert.equal(/^[A-Za-z]:/.test(c.evidence_path), false);
      }
      if (c.source_baseline) {
        assert.equal(/^[A-Za-z]:/.test(c.source_baseline), false);
      }
    }
  });

  it('meets_target true when only R1-R6 paths + relaxed coverage (historical 2/2 pass)', () => {
    const report = buildGovDCanaryReport({
      manifestPath: join(REPO_ROOT, 'benchmarks', 'babel-agent-benchmark', 'manifest.json'),
      baselinePaths: [
        join(REPO_ROOT, 'benchmarks', 'baselines', 'baseline-R1-R6-2026-07-06.json'),
      ],
      minCoverage: 0.5,
      nowIso: '2026-07-09T00:00:00.000Z',
    });
    assert.equal(report.measured, 2);
    assert.equal(report.pass_rate, 1);
    assert.equal(report.meets_target, true);
  });
});
