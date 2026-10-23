import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeReadinessCommand, runProductBenchmark } from './productBenchmark.js';

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
  assert.equal(
    scenario?.benchmark_question,
    'Does the fixture preserve benchmark evidence metadata?',
  );
  assert.equal(scenario?.market_sources[0]?.vendor, 'gemini_cli');

  const scorecard = report.capability_scorecard[0];
  assert.equal(scorecard?.user_scenario, scenario?.user_scenario);
  assert.equal(scorecard?.benchmark_question, scenario?.benchmark_question);
  assert.deepEqual(scorecard?.market_sources, scenario?.market_sources);
});

test('product benchmark can include release readiness as a first-class scenario', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-product-benchmark-'));
  const commands: string[][] = [];
  const report = runProductBenchmark({
    outputDir,
    now: new Date('2026-04-24T00:00:00.000Z'),
    scenarios: [],
  }, { runReadinessCommand: command => { commands.push(command); return { status: 0 }; } });

  const readiness = report.scenarios[0];
  assert.equal(readiness?.id, 'release_readiness_gate');
  assert.ok(readiness.checks.some((check) => check.id === 'release_readiness.doctor_all'));
  assert.equal(readiness.status, 'pass');
  assert.deepEqual(commands[0]?.slice(1), ['run', 'typecheck']);
  assert.ok(commands[1]?.includes('doctor'));
  rmSync(outputDir, { recursive: true, force: true });
});

test('readiness never treats a spawn error, signal, absent exit status, or nonzero exit as success', () => {
  for (const outcome of [{ status: null }, { status: 1 }, { status: 0, signal: 'SIGTERM' },
    { status: null, error: { name: 'Error', code: 'ETIMEDOUT' } },
    { status: null, error: { name: 'Error', code: 'ENOENT' } }]) {
    const outputDir = mkdtempSync(join(tmpdir(), 'babel-readiness-failure-'));
    try {
      const report = runProductBenchmark({ outputDir, scenarios: [] }, { runReadinessCommand: () => outcome });
      assert.equal(report.scenarios[0]?.status, 'fail');
      assert.equal(report.scenarios[0]?.checks.every(check => check.status === 'fail'), true);
    } finally { rmSync(outputDir, { recursive: true, force: true }); }
  }
});

test('production readiness runner observes real subprocess success and failure', () => {
  const options = { cliRoot: process.cwd(), maxOutputBytes: 4096, id: 'synthetic-process' };
  assert.equal(executeReadinessCommand([process.execPath, '-e', 'process.exitCode=0'], options).status, 0);
  assert.equal(executeReadinessCommand([process.execPath, '-e', 'process.exitCode=7'], options).status, 7);
});
