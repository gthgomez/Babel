import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  W0_TTF_WRITE_BASELINE_MEDIAN,
  W1_MIN_SAMPLES,
  buildDefaultInteractiveLedger,
  defaultInteractiveTtfSamples,
  evaluateW1MetricGate,
  formatW1MetricGateReport,
  loadSampleLedger,
  median,
  sampleFromHarnessPayload,
  sampleFromToolLog,
} from './implementorMetricGate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'implementor-interactive-ttf-samples.json');

describe('W1 metric gate', () => {
  test('median handles odd and even', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 3, 2, 4]), 2.5);
    assert.equal(median([]), null);
  });

  test('default interactive set has n≥5 single-file samples with writes', () => {
    const samples = defaultInteractiveTtfSamples();
    assert.ok(samples.length >= W1_MIN_SAMPLES);
    assert.ok(samples.every((s) => s.should_mutate));
    assert.ok(samples.every((s) => s.write_count > 0));
  });

  test('Wave 1 gate PASSes on default interactive ledger (write-rate + TTF)', () => {
    const samples = defaultInteractiveTtfSamples();
    const gate = evaluateW1MetricGate(samples);
    assert.equal(gate.n_should_mutate, 5);
    assert.equal(gate.write_rate, 1);
    assert.equal(gate.write_rate_pass, true);
    assert.equal(gate.ttf_write_median, 2); // 1,1,2,3,3
    assert.equal(gate.ttf_write_pass, true);
    assert.equal(gate.pass, true);
    assert.ok(gate.ttf_write_median! <= 8);
    // Relative to W0 baseline 3: median 2 is also ≥20% improvement (target ≤2.4)
    assert.ok(gate.ttf_write_median! <= W0_TTF_WRITE_BASELINE_MEDIAN * 0.8);
  });

  test('checked-in ledger: live multi_file samples pass write-rate gate', () => {
    const ledger = loadSampleLedger(FIXTURE);
    assert.equal(ledger.schema_version, 1);
    assert.ok(ledger.samples.length >= W1_MIN_SAMPLES);
    assert.equal(ledger.w0_ttf_write_baseline_median, W0_TTF_WRITE_BASELINE_MEDIAN);
    assert.equal(ledger.task_scale, 'multi_file');
    assert.ok(ledger.samples.every((s) => s.source === 'harness_import'));
    const liveGate = evaluateW1MetricGate(ledger.samples, { taskScale: 'multi_file' });
    assert.equal(liveGate.pass, true, liveGate.fail_reasons.join('; '));
    assert.equal(liveGate.write_rate_pass, true);
    assert.ok((liveGate.ttf_write_median ?? 0) > 0);
    // Single-file reference cohort still enforces absolute TTF≤8
    const ref = ledger.single_file_reference_samples ?? [];
    assert.ok(ref.length >= W1_MIN_SAMPLES);
    const singleGate = evaluateW1MetricGate(ref, { taskScale: 'single_file' });
    assert.equal(singleGate.pass, true, singleGate.fail_reasons.join('; '));
    assert.ok((singleGate.ttf_write_median ?? 99) <= 8);
  });

  test('buildDefaultInteractiveLedger matches fixture shape', () => {
    const built = buildDefaultInteractiveLedger();
    assert.equal(built.samples.length, 5);
    assert.equal(built.schema_version, 1);
  });

  test('write_rate fails when fewer than 4/5 mutate', () => {
    const samples = defaultInteractiveTtfSamples().map((s, i) =>
      i < 2 ? { ...s, write_count: 0, empty_patch: true, tools_before_first_write: 5 } : s,
    );
    const gate = evaluateW1MetricGate(samples);
    assert.equal(gate.write_rate, 0.6);
    assert.equal(gate.write_rate_pass, false);
    assert.equal(gate.pass, false);
  });

  test('gate fails when n < 5', () => {
    const gate = evaluateW1MetricGate(defaultInteractiveTtfSamples().slice(0, 3));
    assert.equal(gate.pass, false);
    assert.ok(gate.fail_reasons.some((r) => r.includes('≥5')));
  });

  test('env_blocked empty patch does not count as empty_patch failure', () => {
    const samples = defaultInteractiveTtfSamples();
    samples[0] = {
      ...samples[0]!,
      write_count: 0,
      empty_patch: true,
      env_blocked: true,
      tools_before_first_write: 4,
    };
    // 4/5 wrote → write_rate 0.8 still passes; env quarantine for empty
    const gate = evaluateW1MetricGate(samples);
    assert.equal(gate.write_rate, 0.8);
    assert.equal(gate.empty_patch_failures, 0);
    assert.equal(gate.env_blocked_count, 1);
  });

  test('sampleFromHarnessPayload reads write_count and tools_before_first_write', () => {
    const s = sampleFromHarnessPayload(
      {
        write_count: 2,
        tools_before_first_write: 4,
        env_blocked: false,
        patch_reality: { empty_patch: false },
        toolCalls: [],
      },
      { id: 'h1', source: 'harness_import' },
    );
    assert.equal(s.write_count, 2);
    assert.equal(s.tools_before_first_write, 4);
    assert.equal(s.empty_patch, false);
  });

  test('sampleFromToolLog detects env_blocked from pytest missing', () => {
    const s = sampleFromToolLog({
      id: 'env',
      source: 'manual',
      toolCalls: [
        { tool: 'str_replace', target: 'a.ts' },
        { tool: 'test_run', error: 'pytest: command not found' },
      ],
    });
    assert.equal(s.write_count, 1);
    assert.equal(s.env_blocked, true);
  });

  test('formatW1MetricGateReport includes PASS/FAIL', () => {
    const report = formatW1MetricGateReport(evaluateW1MetricGate(defaultInteractiveTtfSamples()));
    assert.ok(report.includes('PASS'));
    assert.ok(report.includes('write_rate'));
    assert.ok(report.includes('TTF-Write median'));
  });
});
