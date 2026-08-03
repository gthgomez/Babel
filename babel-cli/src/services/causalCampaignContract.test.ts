/**
 * Causal campaign contract — manifest immutability, conservation, reconcile.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildCampaignManifest,
  campaignCompleteFromStates,
  CAUSAL_SCORER_VERSION,
  CAUSAL_STAGE1_ARMS,
  loadCampaignManifest,
  listAttemptStates,
  reconcileCampaignEvidence,
  seedQueuedAttempts,
  transitionAttempt,
  validateConservation,
  writeCampaignManifest,
  writeGeneratedCausalSchemas,
  writeJsonAtomic,
  type CampaignManifest,
} from './causalCampaignContract.js';

function tmpEvidence(): string {
  return mkdtempSync(join(tmpdir(), 'causal-contract-'));
}

function baseManifest(
  evidenceTasks: string[] = ['task_a', 'task_b'],
  arms: ('babel_enforce' | 'babel_shadow' | 'babel_prompt_control')[] = ['babel_enforce'],
): CampaignManifest {
  return buildCampaignManifest({
    campaignId: 'test-campaign-001',
    createdAt: '2026-08-02T12:00:00.000Z',
    taskIds: evidenceTasks,
    arms,
    replicates: 1,
    identity: {
      babel_commit: 'abc123',
      babel_branch: 'codex/reliable-executor-acceptance',
      dirty_digest: 'clean',
      project_root: '/tmp/fixture-project-root',
      canonical_remote: 'https://github.com/gthgomez/Babel.git',
      dataset_path: '/tmp/ds.jsonl',
      dataset_sha256: 'deadbeef',
      model: null,
      provider: 'mock',
    },
  });
}

describe('causalCampaignContract manifest', () => {
  test('builds expected attempts as task × arm × replicate (not infra+live rows)', () => {
    const m = baseManifest(['t1'], ['babel_prompt_control', 'babel_shadow', 'babel_enforce']);
    assert.equal(m.expected_attempts.length, 3);
    assert.equal(m.causal_stage1_complete_design, true);
    assert.equal(m.identity.mode, 'chat-headless');
    assert.equal(m.identity.scorer_version, CAUSAL_SCORER_VERSION);
    assert.ok(m.manifest_digest.length >= 16);
    const arms = new Set(m.expected_attempts.map((a) => a.arm));
    assert.deepEqual([...arms].sort(), [...CAUSAL_STAGE1_ARMS].sort());
    // Single pair_id shared across arms for same task×replicate
    assert.equal(new Set(m.expected_attempts.map((a) => a.pair_id)).size, 1);
  });

  test('reliability-only single arm is incomplete causal design', () => {
    const m = baseManifest(['t1'], ['babel_enforce']);
    assert.equal(m.causal_stage1_complete_design, false);
    assert.equal(m.expected_attempts.length, 1);
  });

  test('manifest is immutable — second write with different content throws', () => {
    const dir = tmpEvidence();
    const m1 = baseManifest(['t1']);
    writeCampaignManifest(dir, m1);
    const m2 = baseManifest(['t1', 't2']);
    assert.throws(() => writeCampaignManifest(dir, m2), /immutable|different digest/i);
    // Identical digest re-write is ok
    writeCampaignManifest(dir, loadCampaignManifest(dir));
  });

  test('seedQueuedAttempts creates one state file per expected attempt', () => {
    const dir = tmpEvidence();
    const m = baseManifest(['a', 'b']);
    writeCampaignManifest(dir, m);
    const states = seedQueuedAttempts(dir, m);
    assert.equal(states.length, 2);
    assert.ok(states.every((s) => s.lifecycle === 'queued'));
    const cons = validateConservation(m, listAttemptStates(dir));
    assert.equal(cons.ok, true, cons.errors.join('; '));
  });
});

describe('causalCampaignContract lifecycle + conservation', () => {
  test('legal transitions and conservation after terminal', () => {
    const dir = tmpEvidence();
    const m = baseManifest(['t1']);
    writeCampaignManifest(dir, m);
    seedQueuedAttempts(dir, m);
    const id = m.expected_attempts[0]!.attempt_id;
    transitionAttempt(dir, id, { lifecycle: 'running', substage: 'infra' });
    transitionAttempt(dir, id, { lifecycle: 'running', substage: 'live' });
    transitionAttempt(dir, id, {
      lifecycle: 'terminal',
      substage: 'done',
      terminal_signature: 'agent:ok',
      cell_evidence_path: '/tmp/cell.json',
    });
    assert.throws(
      () => transitionAttempt(dir, id, { lifecycle: 'running' }),
      /illegal attempt lifecycle/,
    );
    const cons = validateConservation(m, listAttemptStates(dir));
    assert.equal(cons.ok, true);
    assert.equal(cons.by_lifecycle.terminal, 1);
    assert.equal(campaignCompleteFromStates(m, listAttemptStates(dir)), true);
  });

  test('missing attempt state fails conservation', () => {
    const m = baseManifest(['t1', 't2']);
    const partial = [
      {
        schema_version: 1 as const,
        kind: 'babel_causal_attempt_state' as const,
        attempt_id: m.expected_attempts[0]!.attempt_id,
        campaign_id: m.campaign_id,
        lifecycle: 'queued' as const,
        sequence: 0,
        updated_at: new Date().toISOString(),
        pair_id: m.expected_attempts[0]!.pair_id,
        task_id: 't1',
        arm: 'babel_enforce' as const,
        replicate_id: 0,
      },
    ];
    const cons = validateConservation(m, partial);
    assert.equal(cons.ok, false);
    assert.ok(cons.errors.some((e) => e.includes('missing')));
  });

  test('unexpected attempt fails conservation', () => {
    const dir = tmpEvidence();
    const m = baseManifest(['t1']);
    writeCampaignManifest(dir, m);
    seedQueuedAttempts(dir, m);
    const rogue = {
      schema_version: 1 as const,
      kind: 'babel_causal_attempt_state' as const,
      attempt_id: 'att_rogue_not_in_manifest',
      campaign_id: m.campaign_id,
      lifecycle: 'queued' as const,
      sequence: 0,
      updated_at: new Date().toISOString(),
      pair_id: 'pair_x',
      task_id: 'ghost',
      arm: 'babel_enforce' as const,
      replicate_id: 0,
    };
    writeJsonAtomic(join(dir, 'attempts', `${rogue.attempt_id}.json`), rogue);
    const cons = validateConservation(m, listAttemptStates(dir));
    assert.equal(cons.ok, false);
    assert.ok(cons.errors.some((e) => e.includes('unexpected')));
  });
});

describe('causalCampaignContract reconcile (external owner)', () => {
  test('does not orphan while process tree alive', () => {
    const dir = tmpEvidence();
    const m = baseManifest(['t1']);
    writeCampaignManifest(dir, m);
    seedQueuedAttempts(dir, m);
    const id = m.expected_attempts[0]!.attempt_id;
    transitionAttempt(dir, id, { lifecycle: 'running', substage: 'live' });

    writeFileSync(
      join(dir, 'process.json'),
      JSON.stringify({
        schema_version: 1,
        pid: 999001,
        started_at: '2026-08-02T12:00:00.000Z',
        launch_method: 'test',
        evidence_dir: dir,
      }),
      'utf8',
    );

    const report = reconcileCampaignEvidence({
      evidenceDir: dir,
      graceMs: 0,
      nowMs: Date.parse('2026-08-02T13:00:00.000Z'),
      processTreeAlive: true,
    });
    assert.equal(report.orphaned_attempt_ids.length, 0);
    assert.equal(listAttemptStates(dir).find((s) => s.attempt_id === id)?.lifecycle, 'running');
    assert.equal(report.campaign_complete, false);
  });

  test('orphans open attempts after process death + grace', () => {
    const dir = tmpEvidence();
    const m = baseManifest(['t1', 't2']);
    writeCampaignManifest(dir, m);
    seedQueuedAttempts(dir, m);
    const id1 = m.expected_attempts[0]!.attempt_id;
    transitionAttempt(dir, id1, { lifecycle: 'running', substage: 'live' });
    // t2 stays queued

    writeFileSync(
      join(dir, 'process.json'),
      JSON.stringify({
        schema_version: 1,
        pid: 999002,
        started_at: '2026-08-02T12:00:00.000Z',
        launch_method: 'test',
        evidence_dir: dir,
      }),
      'utf8',
    );

    const report = reconcileCampaignEvidence({
      evidenceDir: dir,
      graceMs: 1_000,
      nowMs: Date.parse('2026-08-02T12:00:00.000Z') + 60_000,
      processTreeAlive: false,
    });
    assert.equal(report.orphaned_attempt_ids.length, 2);
    assert.equal(report.conservation_ok, true);
    assert.equal(report.campaign_complete, true);
    assert.equal(report.by_lifecycle.orphaned, 2);
    // Idempotent second reconcile
    const report2 = reconcileCampaignEvidence({
      evidenceDir: dir,
      graceMs: 1_000,
      nowMs: Date.parse('2026-08-02T12:00:00.000Z') + 120_000,
      processTreeAlive: false,
    });
    assert.equal(report2.orphaned_attempt_ids.length, 0);
    assert.equal(report2.campaign_complete, true);
  });

  test('respects grace period — no orphan before grace elapses', () => {
    const dir = tmpEvidence();
    const m = baseManifest(['t1']);
    writeCampaignManifest(dir, m);
    seedQueuedAttempts(dir, m);
    writeFileSync(
      join(dir, 'process.json'),
      JSON.stringify({
        pid: 1,
        started_at: '2026-08-02T12:00:00.000Z',
        launch_method: 'test',
      }),
      'utf8',
    );
    const report = reconcileCampaignEvidence({
      evidenceDir: dir,
      graceMs: 60_000,
      nowMs: Date.parse('2026-08-02T12:00:00.000Z') + 5_000,
      processTreeAlive: false,
    });
    assert.ok(report.grace_remaining_ms > 0);
    assert.equal(report.orphaned_attempt_ids.length, 0);
    assert.equal(listAttemptStates(dir)[0]?.lifecycle, 'queued');
  });
});

describe('causalCampaignContract schema generation', () => {
  test('writes generated JSON Schema from Zod source of truth', () => {
    const dir = tmpEvidence();
    const paths = writeGeneratedCausalSchemas(dir);
    assert.ok(existsSync(paths.manifest));
    assert.ok(existsSync(paths.attempt));
    assert.ok(existsSync(paths.reconcile));
    const doc = JSON.parse(readFileSync(paths.manifest, 'utf8')) as { properties?: unknown };
    assert.ok(doc.properties);
  });
});
