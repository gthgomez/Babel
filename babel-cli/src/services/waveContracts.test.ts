/**
 * Contract smoke tests for the wave-1 shared seams:
 * experimentIdentity, harnessAudit/findings, pairedStats/contracts.
 * Deep behavior lives with each team's implementation; these pin the seam.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  executionProfileForArm,
  harnessIdentityForArm,
} from './experimentIdentity.js';
import {
  AuditFindingSchema,
  parseAuditFinding,
  type AuditFinding,
} from './harnessAudit/findings.js';
import { NormalizedAttemptOutcomeSchema } from './pairedStats/contracts.js';

describe('experimentIdentity seam', () => {
  test('arms resolve to orthogonal harness identity and profile', () => {
    const raw = harnessIdentityForArm('raw_opencode');
    assert.equal(raw.name, 'opencode');
    assert.equal(raw.adapter_id, 'opencode_cli_raw');

    const enforce = executionProfileForArm('babel_enforce');
    assert.equal(enforce.policy_mode, 'full');
    assert.equal(enforce.diagnostic, false);

    const shadow = executionProfileForArm('babel_shadow');
    assert.equal(shadow.policy_mode, 'shadow');
    assert.equal(shadow.diagnostic, true);
  });

  test('raw baseline is external, not silently policy-off babel', () => {
    const raw = executionProfileForArm('raw_opencode');
    assert.equal(raw.policy_mode, 'external');
  });
});

function validFinding(): AuditFinding {
  return {
    schema_version: 1,
    kind: 'babel_harness_audit_finding',
    finding_id: 'F-001',
    produced_at: '2026-08-21T00:00:00.000Z',
    task_id: 't1',
    arm: 'babel_enforce',
    model: 'x-preview-f-free',
    attempt_id: null,
    campaign_id: null,
    episode_run_dir: null,
    stage: 'verification',
    claim: 'Verification command was denied twice before agent replanned around it.',
    expected_capability: 'Run project test suite after edit.',
    observed_behavior: 'Two denials then skipped verification.',
    impact: 'Patch landed unverified.',
    evidence_refs: [{ source: 'policy_event', id: 'evt_117' }],
    hypotheses: [
      { label: 'POLICY', weight: 0.7, rationale: 'Denials recorded at boundary.' },
      { label: 'MODEL', weight: 0.3, rationale: 'No retry with allowed variant.' },
    ],
    confidence: 0.8,
    counterfactual: 'Allow exact verifier command in isolated worktree.',
    falsification_experiment: {
      description: 'Replay with verifier allowlisted.',
      preregistered_prediction: 'Verification completes on next attempt.',
      success_metric: 'verifier_attempt.receipt present with pass',
    },
    near_miss: false,
    succeeded_despite_harness: false,
    worker_friction_agreement: 'no_worker_report',
  };
}

describe('harnessAudit findings contract', () => {
  test('accepts a well-formed competing-hypothesis finding', () => {
    const parsed = parseAuditFinding(validFinding());
    assert.equal(parsed.ok, true);
  });

  test('rejects single-cause blame (needs >=2 competing hypotheses)', () => {
    const bad = validFinding();
    bad.hypotheses = [{ label: 'POLICY', weight: 1, rationale: 'only cause' }];
    const parsed = parseAuditFinding(bad);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.errors.join(' '), /at least 2 competing hypotheses/);
    }
  });

  test('rejects weights that do not sum to 1', () => {
    const bad = validFinding();
    bad.hypotheses = [
      { label: 'POLICY', weight: 0.6, rationale: 'a' },
      { label: 'MODEL', weight: 0.3, rationale: 'b' },
    ];
    const parsed = parseAuditFinding(bad);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.errors.join(' '), /sum to 1/);
    }
  });

  test('schema rejects vague evidence-free claims structurally', () => {
    const bad = validFinding();
    const parsed = AuditFindingSchema.safeParse({
      ...bad,
      claim: 'too short',
      evidence_refs: [],
    });
    assert.equal(parsed.success, false);
  });
});

describe('pairedStats contracts seam', () => {
  test('null success is representable and distinct from failure', () => {
    const parsed = NormalizedAttemptOutcomeSchema.parse({
      pair_id: 't1_r0',
      task_id: 't1',
      arm: 'raw_opencode',
      replicate_id: 0,
      success: null,
    });
    assert.equal(parsed.success, null);
    assert.equal(parsed.task_class, null);
  });

  test('replicate_id must be non-negative integer', () => {
    assert.equal(
      NormalizedAttemptOutcomeSchema.safeParse({
        pair_id: 'p',
        task_id: 't',
        arm: 'a',
        replicate_id: -1,
        success: true,
      }).success,
      false,
    );
  });
});
