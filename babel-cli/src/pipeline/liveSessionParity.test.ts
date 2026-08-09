import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadLiveSessionAuthorityStrict,
  resumeEquivalenceFromDisk,
} from '../agent/liveSessionBridge.js';
import { initializeV9LiveSession, finalizeV9LiveSession } from './liveSessionParity.js';

function withRunDir(run: (dir: string, prompt: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'babel-v9-live-session-'));
  const prompt = join(dir, 'resolved-prompt.md');
  writeFileSync(prompt, '# Resolved V9 instruction\n', 'utf8');
  try {
    run(dir, prompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('V9 plan freezes a read-only contract before planning and persists a resumable projection', () => {
  withRunDir((runDir, prompt) => {
    const runtime = initializeV9LiveSession({
      runDir,
      sessionId: 'v9-plan-session',
      mode: 'plan',
      task: 'Inspect the repository and prepare a plan.',
      projectRoot: runDir,
      promptManifestPaths: [prompt],
      modelId: 'mock-model',
    });

    assert.deepEqual(runtime.authority.taskContract.allowed_effects, ['read_only']);
    assert.equal(runtime.authority.taskContract.frozen, true);
    assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.contract_id, runtime.authority.taskContract.contract_id);
    assert.equal(resumeEquivalenceFromDisk(runDir).ok, true);
  });
});

test('V9 deep finalization uses shared terminal vocabulary and stays resume-equivalent', () => {
  withRunDir((runDir, prompt) => {
    const runtime = initializeV9LiveSession({
      runDir,
      sessionId: 'v9-deep-session',
      mode: 'deep',
      task: 'Make the requested implementation and verify it.',
      projectRoot: runDir,
      promptManifestPaths: [prompt],
    });

    const outcome = finalizeV9LiveSession({
      runtime,
      status: 'COMPLETE',
      reason: 'Required verifier passed.',
      verifierSatisfied: true,
    });
    const resumed = resumeEquivalenceFromDisk(runDir);

    assert.equal(outcome, 'VERIFIED_COMPLETE');
    assert.equal(resumed.ok, true);
    assert.equal(resumed.live?.terminal?.outcome, 'VERIFIED_COMPLETE');
  });
});

test('V9 deep does not claim verified completion when no verifier satisfied the contract', () => {
  withRunDir((runDir, prompt) => {
    const runtime = initializeV9LiveSession({
      runDir,
      mode: 'deep',
      task: 'Make the requested implementation.',
      projectRoot: runDir,
      promptManifestPaths: [prompt],
    });

    assert.equal(
      finalizeV9LiveSession({
        runtime,
        status: 'COMPLETE',
        reason: 'No verifier was required.',
        verifierSatisfied: false,
      }),
      'UNVERIFIED_PATCH',
    );
  });
});
