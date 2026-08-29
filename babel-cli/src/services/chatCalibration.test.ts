import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertBroaderCampaignAllowed,
  buildChatCalibrationManifest,
  buildChatCalibrationSchedule,
  CHAT_CALIBRATION_CELL_COUNT,
  evaluateChatCalibrationReadiness,
  validateChatCalibrationManifest,
  validateCampaignProvenance,
  type ChatCalibrationCellEvidence,
} from './chatCalibration.js';

test('chat calibration schedule is exactly 24 interleaved cells', () => {
  const schedule = buildChatCalibrationSchedule(7);
  assert.equal(schedule.length, CHAT_CALIBRATION_CELL_COUNT);
  assert.equal(new Set(schedule.map((cell) => cell.cell_id)).size, CHAT_CALIBRATION_CELL_COUNT);
  assert.deepEqual(new Set(schedule.map((cell) => cell.model.provider)), new Set(['openrouter']));
  assert.deepEqual(new Set(schedule.map((cell) => cell.task_id)), new Set(['C01', 'C02', 'C04', 'C08']));
});

test('calibration manifest validates exact routes and tamper detection', () => {
  const manifest = buildChatCalibrationManifest({
    babelSha: 'a'.repeat(40),
    taskVersions: { C01: 'v1', C02: 'v1', C04: 'v1', C08: 'v1' },
    verifierVersions: { canary: 'v1' },
    inferenceSettings: { temperature: 0, fallback: false },
    isolationMode: 'container_isolated',
    hostFallbackPolicy: 'explicit_only',
    seed: 7,
    now: '2026-08-28T00:00:00.000Z',
  });
  assert.equal(manifest.schedule_seed, 7);
  assert.deepEqual(
    manifest.schedule.map((cell) => cell.cell_id),
    buildChatCalibrationSchedule(7).map((cell) => cell.cell_id),
  );
  validateChatCalibrationManifest(manifest);
  assert.throws(
    () => validateChatCalibrationManifest({ ...manifest, schedule_hash: 'bad' }),
    /tampered/,
  );
});

test('broader campaign remains blocked before complete interpretable evidence', () => {
  const readiness = evaluateChatCalibrationReadiness([]);
  assert.equal(readiness.status, 'blocked');
  assert.throws(() => assertBroaderCampaignAllowed(readiness), /blocked/);
});

test('successful cells without a failure signal do not count as unknown failures', () => {
  const cells: ChatCalibrationCellEvidence[] = buildChatCalibrationSchedule().map((cell) => ({
    cell,
    completed: true,
    outcome: 'success' as const,
    causal_attribution: {
      schema_version: 1 as const,
      kind: 'babel_causal_attribution_report' as const,
      status: 'ok' as const,
      terminal_outcome: 'ANSWER_READY',
      event_count: 1,
      lifecycle: {
        inference_count: 1,
        delivered_result_count: 1,
        failed_result_count: 0,
        tool_proposal_count: 0,
        tool_terminal_count: 0,
        mutation_count: 0,
        verifier_count: 1,
        compaction_count: 0,
      },
      attribution: {
        family: 'unknown' as const,
        code: 'no_failure_signal',
        confidence: 'low' as const,
        model_blame_permitted: false,
        evidence: [],
        counterevidence: [],
        unknowns: [],
      },
    },
    task_feasible: true,
    capability_authorization_known: true,
    tool_terminal_known: true,
    result_delivery_known: true,
    verification_revision_known: true,
    context_preservation_known: true,
    upstream_provider: 'openrouter',
    silent_model_substitution: false,
    unclassified_runtime_crash: false,
  }));
  const readiness = evaluateChatCalibrationReadiness(cells);
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.unknown_attribution_cells, 0);
});

test('canonical provenance rejects dirty trees while development runs require a diff hash', () => {
  const base = {
    git_sha: 'a'.repeat(40),
    git_tree_sha: 'b'.repeat(40),
    package_lock_sha256: 'c'.repeat(64),
    build_artifact_sha256: null,
    runner_source_sha256: 'd'.repeat(64),
    analyzer_source_sha256: 'e'.repeat(64),
    source_composite_sha256: 'f'.repeat(64),
    dirty: false,
    classification: 'CANONICAL_CALIBRATION' as const,
    diff_sha256: null,
  };
  validateCampaignProvenance(base, base.git_sha);
  assert.throws(() => validateCampaignProvenance({ ...base, dirty: true }, base.git_sha), /canonical/);
  assert.throws(() => validateCampaignProvenance({ ...base, classification: 'DEVELOPMENT_EXPERIMENT', dirty: true }, base.git_sha), /diff_sha256/);
  validateCampaignProvenance({ ...base, classification: 'DEVELOPMENT_EXPERIMENT', dirty: true, diff_sha256: '1'.repeat(64) }, base.git_sha);
});
