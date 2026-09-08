import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BENCHMARK_PROFILES,
  CLAUDE_DAILY_MODEL_MAPPING,
  MAX_ACTIVE_WORKER_HARNESSES,
  buildAstraComparisonPacket,
  buildNeutralReceipt,
  createFixture,
  fixturePrompt,
  normalizeTrajectory,
  parseNormalizedTrajectory,
  resetFixture,
  runHiddenVerifier,
  sampleTelemetry,
  validateNeutralReceipt,
  validateControlledPair,
  buildCertificationMatrix,
  buildPilotMatrix,
} from './index.js';
import type { ControlledRun, NeutralLabReceipt, ResourceMetrics } from './index.js';

function receipt(harness: 'claude-code' | 'babel-live', runId: string, sha: string): NeutralLabReceipt {
  return buildNeutralReceipt({
    EXPERIMENT_ID: 'exp-1', PAIR_ID: 'pair-1', RUN_ID: runId, SUPERVISOR: 'astra',
    HARNESS: harness, HARNESS_VERSION: 'test', HARNESS_ADAPTER: harness, HARNESS_ADAPTER_VERSION: '1',
    PROVIDER: 'opencode-go', PROVIDER_ROUTE: 'https://opencode.ai/zen/go/v1/chat/completions',
    REQUESTED_MODEL: 'mimo-v2.5', OBSERVED_MODEL: 'mimo-v2.5', TASK_ID: 'T1', REPOSITORY: 'fixture',
    BASE_SHA: sha, HEAD_SHA: 'UNKNOWN', START_TIME: '2026-01-01T00:00:00.000Z', END_TIME: '2026-01-01T00:00:01.000Z',
    WALL_TIME: 1000, PROCESS_IDS: [1], PROCESS_COUNT: 1, PEAK_WORKING_SET: 2, CPU_TIME: 3,
    DISK_READ_BYTES: 'UNKNOWN', DISK_WRITE_BYTES: 'UNKNOWN', MODEL_CALLS: 1, INPUT_TOKENS: 10,
    OUTPUT_TOKENS: 20, CACHED_TOKENS: 'UNKNOWN', TOOL_CALLS: 2, FILES_READ: [], FILES_CHANGED: ['answer.txt'],
    TEST_COMMANDS: [], TEST_RESULTS: { result: 'PASS' }, REPAIR_LOOPS: 0, CONTEXT_COMPACTIONS: 0,
    TERMINAL_CLAIM: 'complete', VERIFIER_RESULT: 'PASS', FALSE_COMPLETION: false, POLICY_VIOLATION: false,
    HUMAN_INTERVENTIONS: 0, RAW_TRAJECTORY_PATH: 'raw.jsonl', NORMALIZED_TRAJECTORY_PATH: 'normalized.jsonl',
    FALLBACK_USED: false,
  });
}

function run(harness: 'claude-code' | 'babel-live', sha: string): ControlledRun {
  return {
    receipt: receipt(harness, `${harness}-1`, sha), profile: 'benchmark-mimo', exactModel: 'mimo-v2.5', fixtureSha: sha,
    verifier: { result: 'PASS', deterministic: true }, rawTrajectory: '{"event":"task_started"}\n',
    normalizedTrajectory: normalizeTrajectory('{"event":"task_started"}\n'),
    resourceMetrics: {} as ResourceMetrics,
  };
}

test('profiles and daily mapping are exact and GLM is absent', () => {
  assert.deepEqual(BENCHMARK_PROFILES, { 'benchmark-mimo': 'mimo-v2.5', 'benchmark-longcat': 'longcat-2.0', 'benchmark-deepseek': 'deepseek-v4-flash' });
  assert.deepEqual(CLAUDE_DAILY_MODEL_MAPPING, { opus: 'deepseek-v4-flash', sonnet: 'longcat-2.0', haiku: 'mimo-v2.5' });
  assert.equal(MAX_ACTIVE_WORKER_HARNESSES, 1);
})

test('receipt hashing and validation reject tampering', () => {
  const built = receipt('babel-live', 'babel-1', 'sha');
  validateNeutralReceipt(built);
  assert.equal(built.RECEIPT_HASH.length, 64);
  assert.throws(() => validateNeutralReceipt({ ...built, HEAD_SHA: 'changed' }), /hash does not match/);
})

test('trajectory normalization preserves raw data and unknown event provenance', () => {
  const normalized = normalizeTrajectory('{"type":"search","path":"src"}\n{"type":"future_event","answer":"do not infer"}\nplain\n');
  const events = parseNormalizedTrajectory(normalized);
  assert.equal(events[0]?.event, 'repository_search');
  assert.equal(events[0]?.data.path, 'src');
  assert.equal(events[1]?.event, 'unknown');
  assert.equal(events[1]?.sourceType, 'future_event');
  assert.equal(events[2]?.data.raw, 'plain');
})

test('fixtures have deterministic equal base SHAs, reset, and hidden verification', () => {
  const left = createFixture('T1');
  const right = createFixture('T1');
  assert.equal(left.baseSha, right.baseSha);
  assert.match(fixturePrompt('T1'), /answer\.txt/);
  assert.equal(runHiddenVerifier(left).result, 'FAIL');
  resetFixture(left);
  assert.equal(left.baseSha, left.baseSha);
  assert.notEqual(left.hiddenVerifierRoot, left.root);
})

test('legacy packet deltas never establish v2 comparison validity', () => {
  const claude = run('claude-code', 'sha');
  const babel = run('babel-live', 'sha');
  assert.deepEqual(validateControlledPair(claude, babel), { valid: false, code: 'PAIR_INVALID', reasons: ['missing_v2_capability_and_verifier_contract'] });
  const packet = buildAstraComparisonPacket('T1', 'mimo-v2.5', claude, babel);
  assert.equal(packet.pairValidity.valid, false);
  assert.equal(packet.pairedMetricDeltas.outputTokens, 0);
  const invalid = run('babel-live', 'other-sha');
  assert.equal(validateControlledPair(claude, invalid).code, 'INVALID_CONTROLLED_PAIR');
})

test('telemetry sampler returns bounded content-free metrics', () => {
  const sample = sampleTelemetry();
  assert.equal(sample.pid, process.pid);
  assert.equal(typeof sample.cpuTimeMs, 'number');
  assert.notEqual(typeof sample.workingSet, 'string');
})

test('pilot matrices are exact and sequential policy is explicit', () => {
  assert.equal(buildPilotMatrix().length, 3);
  assert.equal(buildCertificationMatrix().length, 9);
  assert.deepEqual(buildPilotMatrix().map((item) => item.taskId), ['T1', 'T2', 'T4']);
  assert.equal(new Set(buildCertificationMatrix().map((item) => item.model)).size, 3);
})
