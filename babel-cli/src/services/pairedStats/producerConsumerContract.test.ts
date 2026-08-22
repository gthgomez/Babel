/**
 * producerConsumerContract.test.ts — End-to-end contract test bridging
 * campaign manifest execution (producer) with paired statistics (consumer).
 *
 * Tests the real path:
 * buildCampaignManifest()
 *   → ExpectedAttempt[]
 *   → synthetic terminal CampaignCellResult states
 *   → canonical normalizeCampaignCellOutcome() converter
 *   → buildPairOutcomeMatrix()
 *   → exact classifications and paired causal deltas.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildCampaignManifest,
  type ExpectedAttempt,
} from '../causalCampaignContract.js';
import {
  normalizeCampaignCellOutcome,
  type RawCampaignCellLike,
} from './contracts.js';
import {
  buildPairOutcomeMatrix,
  type PairOutcomeMatrixArtifact,
} from './pairOutcomeMatrix.js';

describe('Producer → Normalizer → PairedStats Contract (102-D)', () => {
  test('end-to-end flow: manifest → cells → normalizer → matrix with exact classifications', () => {
    // 1. Build real campaign manifest for 4 tasks × 3 replicates × 2 arms
    const manifest = buildCampaignManifest({
      campaignId: 'camp-causal-test-01',
      identity: {
        babel_commit: 'abcdef1',
        babel_branch: 'feat/exp-wave1-integration',
        dirty_digest: null,
        project_root: '/fake/root',
        canonical_remote: null,
        dataset_path: '/fake/dataset.jsonl',
        dataset_sha256: null,
        model: null,
        mode: 'chat-headless',
        provider: 'mock',
      },
      taskIds: ['task_both_pass', 'task_both_fail', 'task_uplift', 'task_suppression'],
      arms: ['raw_opencode', 'babel_enforce'],
      replicates: 3,
    });

    assert.equal(manifest.expected_attempts.length, 24); // 4 tasks * 3 replicates * 2 arms

    // 2. Generate synthetic CampaignCellResult for each expected attempt
    // Scenario definitions:
    // task_both_pass: raw pass, babel pass across all 3 replicates (3 both_pass)
    // task_both_fail: raw fail, babel fail across all 3 replicates (3 both_fail)
    // task_uplift: raw fail, babel pass across all 3 replicates (3 uplift_babel_only)
    // task_suppression: raw pass, babel fail across all 3 replicates (3 suppression_suspect_raw_only)
    const cells: Array<{ cell: RawCampaignCellLike; exp: ExpectedAttempt }> = [];

    for (const exp of manifest.expected_attempts) {
      let status: 'pass' | 'fail' | 'skipped' = 'fail';
      let goldDiagnostic = false;

      if (exp.task_id === 'task_both_pass') {
        status = 'pass';
        goldDiagnostic = true;
      } else if (exp.task_id === 'task_both_fail') {
        status = 'fail';
        goldDiagnostic = false;
      } else if (exp.task_id === 'task_uplift') {
        status = exp.arm === 'babel_enforce' ? 'pass' : 'fail';
        goldDiagnostic = exp.arm === 'babel_enforce';
      } else if (exp.task_id === 'task_suppression') {
        status = exp.arm === 'raw_opencode' ? 'pass' : 'fail';
        goldDiagnostic = exp.arm === 'raw_opencode';
      }

      const cell: RawCampaignCellLike = {
        instance_id: exp.task_id,
        status,
        duration_ms: 1200,
        arm: exp.arm,
        replicate_id: exp.replicate_id,
        arm_harness: {
          name: exp.arm === 'babel_enforce' ? 'babel' : 'opencode',
          adapter_id: exp.arm === 'babel_enforce' ? 'babel_cli_chat_headless' : 'opencode_cli_raw',
          version: null,
        },
        scoreboard: {
          host_fail_to_pass: status === 'pass',
          gold_diagnostic: goldDiagnostic,
        },
      };
      cells.push({ cell, exp });
    }

    // 3. Convert via canonical normalizer
    const normalizedAttempts = cells.map(({ cell, exp }) =>
      normalizeCampaignCellOutcome(cell, exp),
    );

    assert.equal(normalizedAttempts.length, 24);

    // 4. Build Pair Outcome Matrix
    const matrix: PairOutcomeMatrixArtifact = buildPairOutcomeMatrix(
      normalizedAttempts,
      { generatedAt: '2026-08-21T00:00:00.000Z' },
    );

    // 5. Assert exact classifications
    // Total pairs = 12 (4 tasks * 3 replicates)
    assert.equal(matrix.totals_by_classification['both_pass'], 3);
    assert.equal(matrix.totals_by_classification['both_fail'], 3);
    assert.equal(matrix.totals_by_classification['uplift_babel_only'], 3);
    assert.equal(matrix.totals_by_classification['suppression_suspect_raw_only'], 3);
    assert.equal(matrix.totals_by_classification['incomplete'], 0);
    assert.equal(matrix.totals_by_classification['ambiguous_tie'], 0);

    // Paired delta: (3 uplift - 3 suppression) / 12 pairs = 0.0
    const babelDelta = matrix.pairwise_deltas.find((d) => d.candidate_arm === 'babel_enforce');
    assert.ok(babelDelta);
    assert.equal(babelDelta.n_pairs, 12);
    assert.equal(babelDelta.cand_pass_rate, 0.5); // 6 passes out of 12
    assert.equal(babelDelta.ref_pass_rate, 0.5); // 6 passes out of 12
    assert.equal(babelDelta.success_delta, 0.0);

    // Arm summaries
    const babelSummary = matrix.arm_summaries.find((s) => s.arm === 'babel_enforce');
    assert.ok(babelSummary);
    assert.equal(babelSummary.n_pass, 6);
    assert.equal(babelSummary.n_fail, 6);
    assert.equal(babelSummary.n_null, 0);
    assert.equal(babelSummary.pass_rate, 0.5);
    assert.deepEqual(babelSummary.harness, {
      name: 'babel',
      adapter_id: 'babel_cli_chat_headless',
      version: null,
    });
  });

  test('handles unresolved attempts, missing arms, and replicate imbalance', () => {
    const manifest = buildCampaignManifest({
      campaignId: 'camp-causal-test-02',
      identity: {
        babel_commit: 'abcdef1',
        babel_branch: 'feat/exp-wave1-integration',
        dirty_digest: null,
        project_root: '/fake/root',
        canonical_remote: null,
        dataset_path: '/fake/dataset.jsonl',
        dataset_sha256: null,
        model: null,
        mode: 'chat-headless',
        provider: 'mock',
      },
      taskIds: ['task_unresolved', 'task_imbalance'],
      arms: ['raw_opencode', 'babel_enforce'],
      replicates: 2,
    });

    const cells: Array<{ cell: RawCampaignCellLike; exp: ExpectedAttempt }> = [];

    for (const exp of manifest.expected_attempts) {
      if (exp.task_id === 'task_unresolved') {
        // One arm is missing key / infrastructure fail -> unresolved
        const cell: RawCampaignCellLike = {
          instance_id: exp.task_id,
          status: exp.arm === 'babel_enforce' ? 'fail' : 'pass',
          signature: exp.arm === 'babel_enforce' ? 'infra:missing_api_key' : undefined,
          duration_ms: 100,
        };
        cells.push({ cell, exp });
      } else if (exp.task_id === 'task_imbalance') {
        // Replicate 0 resolves for both; replicate 1 only resolves for babel
        if (exp.replicate_id === 0) {
          cells.push({
            cell: {
              instance_id: exp.task_id,
              status: exp.arm === 'babel_enforce' ? 'pass' : 'fail',
              duration_ms: 500,
            },
            exp,
          });
        } else {
          // Replicate 1
          if (exp.arm === 'babel_enforce') {
            cells.push({
              cell: {
                instance_id: exp.task_id,
                status: 'pass',
                duration_ms: 500,
              },
              exp,
            });
          }
          // raw_opencode replicate 1 is omitted (missing arm observation)
        }
      }
    }

    const normalized = cells.map(({ cell, exp }) =>
      normalizeCampaignCellOutcome(cell, exp),
    );

    const matrix = buildPairOutcomeMatrix(normalized, {
      generatedAt: '2026-08-21T00:00:00.000Z',
    });

    // task_unresolved has 2 pairs, both incomplete
    assert.equal(matrix.totals_by_classification['incomplete'], 2);

    // task_imbalance: replicate 0 is uplift_babel_only, replicate 1 is missing reference (omitted from pair classification)
    assert.equal(matrix.totals_by_classification['uplift_babel_only'], 1);
    assert.equal(matrix.pairs_missing_reference_count, 1);
  });

  test('duplicate attempt protection fails closed naming the offending triple', () => {
    const rawOutcome = normalizeCampaignCellOutcome({
      instance_id: 'task_dup',
      status: 'pass',
      arm: 'babel_enforce',
      replicate_id: 0,
    });

    assert.throws(
      () => buildPairOutcomeMatrix([rawOutcome, rawOutcome]),
      /duplicate \(pair_id, arm, replicate_id\) triple/,
    );
  });
});
