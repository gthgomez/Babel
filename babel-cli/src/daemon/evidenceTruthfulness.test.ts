/**
 * Daemon evidence truthfulness (H-daemon).
 *
 * A recommendation must never masquerade as observed execution truth, and a
 * checkpoint ID must never exist without an authoritative creation receipt.
 * The daemon result artifact is the contract under test: it must record the
 * model fields honestly (requested / recommended / observed) and state
 * explicitly when no checkpoint exists instead of inventing an identifier.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeDaemonJobResult,
  writeDaemonJobTelemetry,
  type DaemonJobResult,
} from './evidence.js';

function readResult(runDir: string): DaemonJobResult {
  return JSON.parse(readFileSync(join(runDir, '09_daemon_result.json'), 'utf8')) as DaemonJobResult;
}

test('result artifact separates requested, recommended, and observed model identities', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-daemon-evidence-'));
  try {
    writeDaemonJobResult(runDir, 'job-1', {
      status: 'complete',
      pipelineStatus: 'COMPLETE',
      durationMs: 1234,
      error: null,
      modelRequested: null,
      modelRecommended: 'qwen3-32b',
    });
    const result = readResult(runDir);
    assert.equal(result.schema_version, 2);
    // The heuristic recommendation is recorded under its honest name only.
    assert.equal(result.model_recommended, 'qwen3-32b');
    // Observed truth stays explicitly unknown — never copied from the recommendation.
    assert.equal(result.model_used, null);
    // The requested model is preserved separately when the job carried one.
    writeDaemonJobResult(runDir, 'job-1', {
      status: 'complete',
      pipelineStatus: 'COMPLETE',
      durationMs: 1234,
      error: null,
      modelRequested: 'longcat-2.0',
      modelRecommended: 'qwen3-32b',
    });
    const updated = readResult(runDir);
    assert.equal(updated.model_requested, 'longcat-2.0');
    assert.equal(updated.model_recommended, 'qwen3-32b');
    assert.equal(updated.model_used, null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('no checkpoint is claimed when checkpoint creation is not wired', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-daemon-evidence-'));
  try {
    writeDaemonJobResult(runDir, 'job-2', {
      status: 'failed',
      pipelineStatus: 'FAILED',
      durationMs: 42,
      error: 'Pipeline ended with status: FAILED',
      checkpointId: null,
      checkpointStatus: 'not_wired',
      checkpointNote: 'no recoverability claim is made',
    });
    const result = readResult(runDir);
    assert.equal(result.checkpoint_id, null);
    assert.equal(result.checkpoint_status, 'not_wired');
    assert.equal(result.rollback_performed, false);
    assert.match(String(result.checkpoint_note), /recoverability/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('a rollback claim requires a created checkpoint record', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-daemon-evidence-'));
  try {
    writeDaemonJobResult(runDir, 'job-3', {
      status: 'failed',
      pipelineStatus: 'FAILED',
      durationMs: 42,
      error: 'Pipeline failed. Rollback performed.',
      rollbackPerformed: true,
      checkpointId: 'cp_20260912_abcd1234',
      checkpointStatus: 'created',
    });
    const result = readResult(runDir);
    assert.equal(result.rollback_performed, true);
    assert.equal(result.checkpoint_status, 'created');
    assert.match(String(result.checkpoint_id), /^cp_/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('telemetry records the real queue wait rather than a placeholder', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-daemon-evidence-'));
  try {
    writeDaemonJobTelemetry(runDir, 'job-4', {
      queueWaitMs: 8721,
      executionDurationMs: 1500,
      retryCount: 0,
      rateLimitDelayMs: 0,
    });
    const tel = JSON.parse(readFileSync(join(runDir, '10_daemon_telemetry.json'), 'utf8')) as { queue_wait_ms: number };
    assert.equal(tel.queue_wait_ms, 8721);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
