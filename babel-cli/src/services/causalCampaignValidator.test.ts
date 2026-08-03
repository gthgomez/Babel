/**
 * Slice 3: multi-axis validator + eligibility derivation.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildCampaignManifest,
  seedQueuedAttempts,
  transitionAttempt,
  writeCampaignManifest,
} from './causalCampaignContract.js';
import {
  capabilityVerifiedPass,
  classifyCapabilityExclusion,
  hostFailToPassAxis,
  validateAndDeriveCampaign,
  writeDerivedCampaignState,
  writeGeneratedValidatorSchemas,
  type ScoringAxes,
} from './causalCampaignValidator.js';

function setupEvidence(taskIds: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'causal-val-'));
  const m = buildCampaignManifest({
    campaignId: 'val-camp-1',
    createdAt: '2026-08-02T12:00:00.000Z',
    taskIds,
    arms: ['babel_enforce'],
    replicates: 1,
    identity: {
      babel_commit: 'abc',
      babel_branch: 'test',
      dirty_digest: 'clean',
      project_root: '/tmp/fixture-project-root',
      canonical_remote: 'https://github.com/gthgomez/Babel.git',
      dataset_path: '/tmp/ds.jsonl',
      dataset_sha256: 'deadbeef',
      model: null,
      provider: 'mock',
    },
  });
  writeCampaignManifest(dir, m);
  seedQueuedAttempts(dir, m);
  return dir;
}

describe('hostFailToPassAxis', () => {
  test('collect_error is error not fail', () => {
    assert.equal(hostFailToPassAxis(false, 'collect_error'), 'error');
    assert.equal(hostFailToPassAxis(true, 'pass'), 'pass');
    assert.equal(hostFailToPassAxis(false, 'assert_fail'), 'fail');
    assert.equal(hostFailToPassAxis(null, 'skipped'), 'not_run');
  });
});

describe('classifyCapabilityExclusion', () => {
  const baseAxes = (ftp: ScoringAxes['host_fail_to_pass']): ScoringAxes => ({
    execution_terminal: 'fail',
    babel_authoritative_verifier: 'not_run',
    host_fail_to_pass: ftp,
    official_evaluator: 'not_run',
    gold_patch_similarity: 'diagnostic_only',
  });

  test('does not exclude blocked_external when host FTP is pass', () => {
    assert.equal(
      classifyCapabilityExclusion({
        lifecycle: 'terminal',
        arm: 'babel_enforce',
        signature: 'agent:blocked_external',
        axes: baseAxes('pass'),
        artifact_valid: true,
        identity_mismatch: false,
      }),
      null,
    );
  });

  test('excludes blocked_external when FTP did not pass', () => {
    assert.equal(
      classifyCapabilityExclusion({
        lifecycle: 'terminal',
        arm: 'babel_enforce',
        signature: 'agent:blocked_external',
        axes: baseAxes('fail'),
        artifact_valid: true,
        identity_mismatch: false,
      }),
      'blocked_external',
    );
  });
});

describe('capabilityVerifiedPass oracle hierarchy', () => {
  test('official evaluator wins; gold alone never passes', () => {
    const base: ScoringAxes = {
      execution_terminal: 'fail',
      babel_authoritative_verifier: 'pass',
      host_fail_to_pass: 'fail',
      official_evaluator: 'pass',
      gold_patch_similarity: 'diagnostic_only',
    };
    assert.equal(capabilityVerifiedPass(base), true);
    assert.equal(
      capabilityVerifiedPass({
        ...base,
        official_evaluator: 'not_run',
        host_fail_to_pass: 'fail',
        babel_authoritative_verifier: 'pass',
      }),
      false,
      'in-session babel verifier alone is not enough',
    );
    assert.equal(
      capabilityVerifiedPass({
        ...base,
        official_evaluator: 'not_run',
        host_fail_to_pass: 'pass',
      }),
      true,
      'provisional host FTP pass allowed when official absent',
    );
  });
});

describe('validateAndDeriveCampaign', () => {
  test('incomplete campaign is not reliability or promotion eligible', () => {
    const dir = setupEvidence(['t1', 't2']);
    const m = JSON.parse(readFileSync(join(dir, 'campaign-manifest.json'), 'utf8'));
    // Leave both queued
    const derived = validateAndDeriveCampaign({
      evidenceDir: dir,
      now: new Date('2026-08-02T13:00:00.000Z'),
      writerCells: [],
    });
    assert.equal(derived.eligibility.artifact_valid, true);
    assert.equal(derived.eligibility.campaign_complete, false);
    assert.equal(derived.eligibility.reliability_eligible, false);
    assert.equal(derived.eligibility.promotion_eligible, false);
    assert.equal(derived.intent_to_treat_capability.denominator, 2);
    assert.equal(derived.intent_to_treat_capability.numerator, 0);
    assert.equal(derived.exclusion_counts['not_terminal'], 2);
    assert.ok(m.expected_attempts.length === 2);
  });

  test('terminal with host FTP pass counts as capability pass in rates', () => {
    const dir = setupEvidence(['t1']);
    const m = JSON.parse(readFileSync(join(dir, 'campaign-manifest.json'), 'utf8')) as {
      expected_attempts: Array<{ attempt_id: string }>;
    };
    const id = m.expected_attempts[0]!.attempt_id;
    transitionAttempt(dir, id, {
      lifecycle: 'running',
      substage: 'live',
    });
    transitionAttempt(dir, id, {
      lifecycle: 'terminal',
      substage: 'done',
      terminal_signature: 'agent:task_pass',
      cell_evidence_path: join(dir, 'live', 't1.json'),
    });

    const derived = writeDerivedCampaignState({
      evidenceDir: dir,
      now: new Date('2026-08-02T14:00:00.000Z'),
      writerCells: [
        {
          instance_id: 't1',
          phase: 'live',
          status: 'pass',
          signature: 'agent:task_pass',
          patch_bytes: 120,
          gold_diff_ok: false,
          fail_to_pass_ok: true,
          fail_to_pass_class: 'pass',
        },
      ],
      legacyPassMode: 'gold',
    });

    assert.equal(existsSync(join(dir, 'campaign-derived.json')), true);
    assert.equal(derived.eligibility.campaign_complete, true);
    assert.equal(derived.eligibility.reliability_eligible, true);
    assert.equal(derived.eligibility.promotion_eligible, true);
    assert.equal(derived.eligibility.capability_score_valid, true);
    assert.equal(derived.intent_to_treat_capability.numerator, 1);
    assert.equal(derived.intent_to_treat_capability.denominator, 1);
    assert.equal(derived.conditional_capability.numerator, 1);
    assert.equal(derived.attempts[0]!.axes.host_fail_to_pass, 'pass');
    assert.equal(derived.attempts[0]!.axes.gold_patch_similarity, 'diagnostic_only');
    assert.ok(derived.notes.some((n) => n.includes('legacy_pass_mode_display=gold')));
  });

  test('wires babel_authoritative_verifier true into axes.pass', () => {
    const dir = setupEvidence(['t1']);
    const m = JSON.parse(readFileSync(join(dir, 'campaign-manifest.json'), 'utf8')) as {
      expected_attempts: Array<{ attempt_id: string }>;
    };
    transitionAttempt(dir, m.expected_attempts[0]!.attempt_id, { lifecycle: 'running' });
    transitionAttempt(dir, m.expected_attempts[0]!.attempt_id, {
      lifecycle: 'terminal',
      terminal_signature: 'agent:task_pass',
    });
    const derived = validateAndDeriveCampaign({
      evidenceDir: dir,
      writerCells: [
        {
          instance_id: 't1',
          phase: 'live',
          signature: 'agent:task_pass',
          fail_to_pass_ok: true,
          fail_to_pass_class: 'pass',
          babel_authoritative_verifier: true,
          babel_authoritative_verifier_command: 'pytest openlibrary/tests/core/test_wikidata.py',
          gold_diff_ok: false,
        },
      ],
    });
    assert.equal(derived.attempts[0]!.axes.babel_authoritative_verifier, 'pass');
    assert.equal(derived.attempts[0]!.axes.gold_patch_similarity, 'diagnostic_only');
    assert.ok(derived.attempts[0]!.notes.some((n) => n.includes('gold_ftp_gap=true')));
  });

  test('FTP pass + blocked_external signature still ITT capability pass', () => {
    const dir = setupEvidence(['t1']);
    const m = JSON.parse(readFileSync(join(dir, 'campaign-manifest.json'), 'utf8')) as {
      expected_attempts: Array<{ attempt_id: string }>;
    };
    transitionAttempt(dir, m.expected_attempts[0]!.attempt_id, { lifecycle: 'running' });
    transitionAttempt(dir, m.expected_attempts[0]!.attempt_id, {
      lifecycle: 'terminal',
      terminal_signature: 'agent:blocked_external',
    });
    const derived = validateAndDeriveCampaign({
      evidenceDir: dir,
      writerCells: [
        {
          instance_id: 't1',
          phase: 'live',
          signature: 'agent:blocked_external',
          patch_bytes: 1076,
          gold_diff_ok: false,
          fail_to_pass_ok: true,
          fail_to_pass_class: 'pass',
        },
      ],
    });
    assert.equal(derived.attempts[0]!.capability_exclusion_reason, null);
    assert.equal(derived.attempts[0]!.capability_eligible, true);
    assert.equal(derived.attempts[0]!.capability_verified_pass, true);
    assert.equal(derived.intent_to_treat_capability.numerator, 1);
    assert.equal(derived.conditional_capability.numerator, 1);
  });

  test('orphaned attempts excluded from conditional capability, remain in ITT denom', () => {
    const dir = setupEvidence(['t1', 't2']);
    const m = JSON.parse(readFileSync(join(dir, 'campaign-manifest.json'), 'utf8')) as {
      expected_attempts: Array<{ attempt_id: string; task_id: string }>;
    };
    const a0 = m.expected_attempts[0]!;
    const a1 = m.expected_attempts[1]!;
    transitionAttempt(dir, a0.attempt_id, { lifecycle: 'running' });
    transitionAttempt(dir, a0.attempt_id, {
      lifecycle: 'terminal',
      terminal_signature: 'agent:empty_patch',
    });
    transitionAttempt(dir, a1.attempt_id, {
      lifecycle: 'orphaned',
      orphan_reason: 'process_dead',
      terminal_signature: 'agent:orphaned',
    });

    const derived = validateAndDeriveCampaign({
      evidenceDir: dir,
      writerCells: [
        {
          instance_id: a0.task_id,
          phase: 'live',
          signature: 'agent:empty_patch',
          fail_to_pass_ok: false,
          fail_to_pass_class: 'assert_fail',
          gold_diff_ok: false,
          patch_bytes: 0,
        },
      ],
    });

    assert.equal(derived.eligibility.campaign_complete, true);
    assert.equal(derived.intent_to_treat_capability.denominator, 2);
    assert.equal(derived.intent_to_treat_capability.numerator, 0);
    assert.equal(derived.exclusion_counts['orphaned'], 1);
    // conditional denom excludes orphan
    assert.equal(derived.conditional_capability.denominator, 1);
    assert.equal(derived.conditional_capability.numerator, 0);
  });

  test('false_complete_suspected blocks promotion_eligible', () => {
    const dir = setupEvidence(['t1']);
    const m = JSON.parse(readFileSync(join(dir, 'campaign-manifest.json'), 'utf8')) as {
      expected_attempts: Array<{ attempt_id: string }>;
    };
    transitionAttempt(dir, m.expected_attempts[0]!.attempt_id, { lifecycle: 'running' });
    transitionAttempt(dir, m.expected_attempts[0]!.attempt_id, {
      lifecycle: 'terminal',
      terminal_signature: 'agent:task_pass',
    });
    const derived = validateAndDeriveCampaign({
      evidenceDir: dir,
      writerCells: [
        {
          instance_id: 't1',
          phase: 'live',
          signature: 'agent:task_pass',
          fail_to_pass_ok: true,
          fail_to_pass_class: 'pass',
          false_complete_suspected: true,
        },
      ],
    });
    assert.equal(derived.eligibility.reliability_eligible, true);
    assert.equal(derived.eligibility.promotion_eligible, false);
  });

  test('identity mismatch fails artifact_valid', () => {
    const dir = setupEvidence(['t1']);
    const m = JSON.parse(readFileSync(join(dir, 'campaign-manifest.json'), 'utf8')) as {
      expected_attempts: Array<{ attempt_id: string }>;
    };
    transitionAttempt(dir, m.expected_attempts[0]!.attempt_id, {
      lifecycle: 'terminal',
      terminal_signature: 'agent:empty_patch',
    });
    const derived = validateAndDeriveCampaign({
      evidenceDir: dir,
      expectedIdentity: { babel_commit: 'other-commit' },
      writerCells: [],
    });
    assert.equal(derived.eligibility.artifact_valid, false);
    assert.equal(derived.eligibility.reliability_eligible, false);
  });
});

describe('schema generation', () => {
  test('writes derived schemas from Zod', () => {
    const dir = mkdtempSync(join(tmpdir(), 'causal-schema-'));
    const paths = writeGeneratedValidatorSchemas(dir);
    assert.ok(existsSync(paths.derived));
    assert.ok(existsSync(paths.attempt));
  });
});
