/**
 * Causal Stage 2 diagnostic ablation scaffolding — structure only.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildCampaignManifest,
  loadCampaignManifest,
  writeCampaignManifest,
  type CampaignManifest,
} from './causalCampaignContract.js';
import {
  assertStage2DoesNotMutateStage1,
  buildStage2ManifestFromStage1,
  CAUSAL_STAGE2_ABLATION_ARMS,
  loadStage2Manifest,
  STAGE2_MANIFEST_KIND,
  stage2ManifestPath,
  writeGeneratedStage2Schemas,
  writeStage2Manifest,
} from './causalCampaignStage2.js';

function tmpEvidence(): string {
  return mkdtempSync(join(tmpdir(), 'causal-stage2-'));
}

function baseStage1(
  taskIds: string[] = ['task_a', 'task_b'],
  arms: ('babel_enforce' | 'babel_shadow' | 'babel_prompt_control')[] = [
    'babel_enforce',
    'babel_shadow',
    'babel_prompt_control',
  ],
): CampaignManifest {
  return buildCampaignManifest({
    campaignId: 'test-campaign-stage1',
    createdAt: '2026-08-02T12:00:00.000Z',
    taskIds,
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

describe('causalCampaignStage2 build + immutability', () => {
  test('builds Stage 2 from Stage 1 pair_id; write leaves Stage 1 digest unchanged', () => {
    const dir = tmpEvidence();
    const stage1 = baseStage1(['t1']);
    writeCampaignManifest(dir, stage1);
    const digestBefore = loadCampaignManifest(dir).manifest_digest;

    const pairId = stage1.expected_attempts[0]!.pair_id;
    const stage2 = buildStage2ManifestFromStage1({
      stage1Manifest: stage1,
      triggeringPairIds: [pairId],
      ablationArms: ['babel_ablation_policy_off', 'babel_ablation_progress_off'],
      createdAt: '2026-08-02T13:00:00.000Z',
      notes: ['diagnostic scaffolding'],
    });

    assert.equal(stage2.kind, STAGE2_MANIFEST_KIND);
    assert.equal(stage2.stage, 2);
    assert.equal(stage2.exploratory, true);
    assert.equal(stage2.parent_stage1_manifest_digest, stage1.manifest_digest);
    assert.equal(stage2.parent_campaign_id, stage1.campaign_id);
    assert.equal(stage2.expected_attempts.length, 2);
    for (const att of stage2.expected_attempts) {
      assert.equal(att.pair_id, pairId);
      assert.equal(att.task_id, 't1');
      assert.ok(att.arm_config_hash.length >= 8);
      assert.ok(att.triggering_stage1_attempt_ids.length >= 1);
      assert.ok(att.attempt_id.startsWith('s2att_'));
    }

    writeStage2Manifest(dir, stage2);
    assert.ok(existsSync(stage2ManifestPath(dir)));
    assertStage2DoesNotMutateStage1(dir, digestBefore);
    assert.equal(loadCampaignManifest(dir).manifest_digest, digestBefore);

    const loaded = loadStage2Manifest(dir);
    assert.equal(loaded.manifest_digest, stage2.manifest_digest);
    assert.equal(loaded.exploratory, true);
  });

  test('second write with different content throws immutability error', () => {
    const dir = tmpEvidence();
    const stage1 = baseStage1(['t1']);
    writeCampaignManifest(dir, stage1);
    const pairId = stage1.expected_attempts[0]!.pair_id;

    const s2a = buildStage2ManifestFromStage1({
      stage1Manifest: stage1,
      triggeringPairIds: [pairId],
      ablationArms: ['babel_ablation_policy_off'],
      createdAt: '2026-08-02T13:00:00.000Z',
    });
    writeStage2Manifest(dir, s2a);

    const s2b = buildStage2ManifestFromStage1({
      stage1Manifest: stage1,
      triggeringPairIds: [pairId],
      ablationArms: ['babel_ablation_budget_relaxed'],
      createdAt: '2026-08-02T13:00:00.000Z',
    });
    assert.notEqual(s2a.manifest_digest, s2b.manifest_digest);
    assert.throws(() => writeStage2Manifest(dir, s2b), /immutable|different digest/i);

    // Identical digest re-write is ok
    writeStage2Manifest(dir, loadStage2Manifest(dir));
  });

  test('invalid pair_id rejected', () => {
    const stage1 = baseStage1(['t1']);
    assert.throws(
      () =>
        buildStage2ManifestFromStage1({
          stage1Manifest: stage1,
          triggeringPairIds: ['pair_does_not_exist'],
          ablationArms: ['babel_ablation_policy_off'],
        }),
      /not present in Stage 1/,
    );
  });

  test('empty ablation set rejected', () => {
    const stage1 = baseStage1(['t1']);
    const pairId = stage1.expected_attempts[0]!.pair_id;
    assert.throws(
      () =>
        buildStage2ManifestFromStage1({
          stage1Manifest: stage1,
          triggeringPairIds: [pairId],
          ablationArms: [],
        }),
      /non-empty ablation/,
    );
  });

  test('known exploratory ablation arms are documented', () => {
    assert.ok(CAUSAL_STAGE2_ABLATION_ARMS.includes('babel_ablation_policy_off'));
    assert.ok(CAUSAL_STAGE2_ABLATION_ARMS.includes('babel_ablation_progress_off'));
    assert.ok(CAUSAL_STAGE2_ABLATION_ARMS.includes('babel_ablation_budget_relaxed'));
    for (const arm of CAUSAL_STAGE2_ABLATION_ARMS) {
      assert.match(arm, /^babel_ablation_/);
    }
  });
});

describe('causalCampaignStage2 schema generation', () => {
  test('writeGeneratedStage2Schemas writes causal-stage2-manifest.schema.json', () => {
    const dir = tmpEvidence();
    const { stage2Manifest } = writeGeneratedStage2Schemas(dir);
    assert.ok(existsSync(stage2Manifest));
    const raw = JSON.parse(readFileSync(stage2Manifest, 'utf8')) as {
      type?: string;
      properties?: { kind?: { const?: string }; stage?: { const?: number }; exploratory?: { const?: boolean } };
    };
    assert.equal(raw.type, 'object');
    assert.equal(raw.properties?.kind?.const, STAGE2_MANIFEST_KIND);
    assert.equal(raw.properties?.stage?.const, 2);
    assert.equal(raw.properties?.exploratory?.const, true);
  });
});
