/**
 * daemon/recovery.test.ts — Crash recovery tests (Phase 6)
 *
 * Tests runCrashRecovery: stale PID cleanup, abandoned job recovery,
 * orphan socket detection.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCrashRecovery } from './recovery.js';
import { createAgentJob, updateAgentJob } from '../services/agentJobs.js';
import { DAEMON_PID_FILE, DAEMON_DIR, DAEMON_IPC_PATH } from './constants.js';

const originalEnv = process.env['BABEL_RUNS_DIR'];
const originalRegistry = process.env['BABEL_JOBS_REGISTRY_PATH'];
const testRoot = mkdtempSync(join(tmpdir(), 'babel-daemon-recovery-test-'));

test.before(() => {
  process.env['BABEL_RUNS_DIR'] = testRoot;
  process.env['BABEL_JOBS_REGISTRY_PATH'] = join(testRoot, 'jobs', 'registry.json');
  mkdirSync(DAEMON_DIR, { recursive: true });
});

test.after(() => {
  if (originalEnv) process.env['BABEL_RUNS_DIR'] = originalEnv;
  else delete process.env['BABEL_RUNS_DIR'];

  if (originalRegistry) process.env['BABEL_JOBS_REGISTRY_PATH'] = originalRegistry;
  else delete process.env['BABEL_JOBS_REGISTRY_PATH'];

  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

test('runCrashRecovery cleans stale PID file', () => {
  // Write a PID file with a non-existent PID
  mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(DAEMON_PID_FILE, '99999999\n', 'utf-8');

  const report = runCrashRecovery();
  assert.equal(report.stalePidCleaned, true);
  assert.equal(existsSync(DAEMON_PID_FILE), false);
});

test('runCrashRecovery does not clean valid PID file', () => {
  // Write current process PID
  mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(DAEMON_PID_FILE, String(process.pid) + '\n', 'utf-8');

  const report = runCrashRecovery();
  assert.equal(report.stalePidCleaned, false);
  // Clean up after test
  if (existsSync(DAEMON_PID_FILE)) {
    try {
      rmSync(DAEMON_PID_FILE);
    } catch {
      /* ok */
    }
  }
});

test('runCrashRecovery handles fresh running job (not abandoned)', () => {
  // Create a job in our test root and mark it running
  const job = createAgentJob({
    id: `recovery-fresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    task: 'fresh running job',
  });
  updateAgentJob(job.id, { status: 'running' });

  // Recovery should NOT mark it as abandoned (updated_at is fresh)
  const report = runCrashRecovery();
  assert.equal(report.abandonedJobsReturned, 0);

  // Clean up
  try {
    updateAgentJob(job.id, { status: 'complete' });
  } catch {
    /* ok */
  }
});

test('runCrashRecovery handles empty daemon directory', () => {
  const report = runCrashRecovery();
  assert.equal(typeof report.stalePidCleaned, 'boolean');
  assert.equal(typeof report.orphanSocketCleaned, 'boolean');
  assert.equal(typeof report.abandonedJobsReturned, 'number');
  assert.equal(typeof report.tmpFilesCleaned, 'number');
});
