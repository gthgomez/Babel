import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runProductBenchmark } from './productBenchmark.js';

test('product benchmark scorecard preserves market evidence fields', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-product-benchmark-'));
  const report = runProductBenchmark({
    outputDir,
    now: new Date('2026-04-24T00:00:00.000Z'),
    readinessGate: 'off',
    scenarios: [
      {
        id: 'fixture_scenario',
        title: 'Fixture scenario',
        phase: 0,
        category: 'baseline',
        matrixDimension: 'install_path',
        userScenario: 'A user needs a fixture scenario.',
        benchmarkQuestion: 'Does the fixture preserve benchmark evidence metadata?',
        marketBar: 'Market tools make benchmark claims traceable.',
        marketSources: [
          {
            vendor: 'gemini_cli',
            title: 'Gemini CLI overview',
            url: 'https://docs.cloud.google.com/gemini/docs/codeassist/gemini-cli',
          },
        ],
        targetOutcome: 'The benchmark report keeps scenario and source context.',
        command: [process.execPath, '-e', 'console.log(JSON.stringify({ ok: true }))'],
        expectation: {
          exitCodes: [0],
          jsonStdout: true,
        },
        capabilityStatus: 'implemented',
      },
    ],
  });

  const scenario = report.scenarios[0];
  assert.equal(scenario?.user_scenario, 'A user needs a fixture scenario.');
  assert.equal(scenario?.benchmark_question, 'Does the fixture preserve benchmark evidence metadata?');
  assert.equal(scenario?.market_sources[0]?.vendor, 'gemini_cli');

  const scorecard = report.capability_scorecard[0];
  assert.equal(scorecard?.user_scenario, scenario?.user_scenario);
  assert.equal(scorecard?.benchmark_question, scenario?.benchmark_question);
  assert.deepEqual(scorecard?.market_sources, scenario?.market_sources);
});

test('product benchmark can include release readiness as a first-class scenario', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-product-benchmark-'));
  const report = runProductBenchmark({
    outputDir,
    now: new Date('2026-04-24T00:00:00.000Z'),
    scenarios: [],
  });

  const readiness = report.scenarios[0];
  assert.equal(readiness?.id, 'release_readiness_gate');
  assert.ok(readiness.checks.some((check) => check.id === 'release_readiness.doctor_all'));
});
