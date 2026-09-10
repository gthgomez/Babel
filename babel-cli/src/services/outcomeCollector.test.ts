import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  collectGitHubPRState,
  detectPostMergeRegression,
  adjudicateCandidateReview,
  saveAdjudicatedOutcome,
  loadAdjudicatedOutcomes,
  type ObservedPRState,
} from './outcomeCollector.js';
import type { HostReviewHandoffV2 } from './hostReviewController.js';
import type { StructuredFinding } from './structuredFinding.js';

test('outcomeCollector: collectGitHubPRState parses PR and check runs correctly', () => {
  const ghMock = (args: string[]) => {
    if (args.includes('view')) {
      return JSON.stringify({
        number: 101,
        headRefOid: '1111111111111111111111111111111111111111',
        baseRefOid: '0000000000000000000000000000000000000000',
        state: 'MERGED',
        mergedAt: '2026-09-09T00:00:00Z',
        mergeCommit: { oid: '2222222222222222222222222222222222222222' },
      });
    }
    if (args.some((a) => a.includes('check-runs'))) {
      return JSON.stringify({
        check_runs: [
          {
            name: 'test-linux',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/org/repo/runs/1',
            completed_at: '2026-09-09T00:05:00Z',
          },
          {
            name: 'lint',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/org/repo/runs/2',
            completed_at: '2026-09-09T00:02:00Z',
          },
        ],
      });
    }
    return '';
  };

  const state = collectGitHubPRState('org/repo', 101, ghMock);
  assert.equal(state.pr_number, 101);
  assert.equal(state.state, 'MERGED');
  assert.equal(state.merge_commit_sha, '2222222222222222222222222222222222222222');
  assert.equal(state.checks.length, 2);
  assert.equal(state.overall_ci_verdict, 'PASS');
});

test('outcomeCollector: detectPostMergeRegression flags revert and bugfix commits', () => {
  const gitMock = (args: string[]) => {
    return [
      '3333333333333333333333333333333333333333 Revert "Feat: broken candidate"',
      '4444444444444444444444444444444444444444 Fix null pointer in player controller',
    ].join('\n');
  };

  const result = detectPostMergeRegression(
    'C:/fake/repo',
    '2222222222222222222222222222222222222222',
    ['src/player.ts'],
    gitMock,
  );

  assert.equal(result.detected, true);
  assert.equal(result.revert_commit_sha, '3333333333333333333333333333333333333333');
  assert.equal(result.related_commits.length, 2);
});

test('outcomeCollector: adjudicateCandidateReview derives True Positives and False Positives accurately', () => {
  const candidateDigest = 'a'.repeat(64);
  const headSha = '1'.repeat(40);
  const baseSha = '0'.repeat(40);
  const mergeSha = '2'.repeat(40);

  const prStateMergedClean: ObservedPRState = {
    pr_number: 42,
    repository: 'owner/repo',
    head_sha: headSha,
    base_sha: baseSha,
    state: 'MERGED',
    merged_at: '2026-09-09T01:00:00Z',
    merge_commit_sha: mergeSha,
    checks: [
      {
        name: 'ci',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://ci.test',
        completed_at: '2026-09-09T01:05:00Z',
      },
    ],
    overall_ci_verdict: 'PASS',
  };

  const handoffWithFalsePositive: HostReviewHandoffV2 = {
    schema_version: 2,
    kind: 'host_review_handoff_v2',
    repository: 'owner/repo',
    pr_number: 42,
    base_sha: baseSha,
    head_sha: headSha,
    task_id: 'task1',
    task_hash: 'b'.repeat(64),
    controller_run_id: 'round1',
    reviews: [
      {
        schema_version: 2,
        kind: 'autonomous_review_evidence_v2',
        repository: 'owner/repo',
        pr_number: 42,
        base_sha: baseSha,
        head_sha: headSha,
        task_id: 'task1',
        task_hash: 'b'.repeat(64),
        builder_id: 'codex',
        diff_numstat_digest: 'c'.repeat(64),
        reviewer_id: 'reviewer-mimo',
        reviewer_class: 'independent_readonly_ai',
        execution_id: 'exec-1',
        review_provider: 'opencode-go',
        reviewer_model: 'mimo-v2.5',
        review_mode: 'exact_diff',
        reviewed_at: '2026-09-09T00:50:00Z',
        scope: ['src/index.ts'],
        verdict: 'BLOCK',
        findings: ['Imaginary memory leak in garbage collected runtime'],
        blocking_findings: ['Imaginary memory leak in garbage collected runtime'],
        isolation: {
          mode: 'readonly_sandbox',
          candidate_write: false,
          github_mutation: false,
          merge: false,
          controller_state_access: false,
        },
        harness: {
          name: 'babel',
          mode: 'chat',
          version: 'd'.repeat(64),
          source_sha: 'e'.repeat(40),
          execution_id: 'exec-1',
        },
      },
    ],
  };

  // Clean merge without causal proof must be INCONCLUSIVE / CORRELATED, never naive FP
  const outcomeCleanMerge = adjudicateCandidateReview({
    candidateDigest,
    prState: prStateMergedClean,
    handoff: handoffWithFalsePositive,
    postMergeRegression: { detected: false, related_commits: [] },
    assumeCleanMergeIsFalsePositive: true,
  });

  assert.equal(outcomeCleanMerge.adjudicated_findings.length, 1);
  assert.equal(outcomeCleanMerge.adjudicated_findings[0]!.ground_truth_verdict, 'INCONCLUSIVE');
  assert.equal(outcomeCleanMerge.adjudicated_findings[0]!.evidence_level, 'CORRELATED');
  assert.equal(outcomeCleanMerge.flywheel_metrics.false_positives, 0);
  assert.equal(outcomeCleanMerge.flywheel_metrics.true_positives, 0);

  // Generic revert commit without causal linkage must be INCONCLUSIVE / OBSERVED
  const outcomeGenericRevert = adjudicateCandidateReview({
    candidateDigest,
    prState: prStateMergedClean,
    handoff: handoffWithFalsePositive,
    postMergeRegression: {
      detected: true,
      revert_commit_sha: '9'.repeat(40),
      related_commits: [{ sha: '9'.repeat(40), message: 'Revert candidate' }],
    },
  });

  assert.equal(outcomeGenericRevert.adjudicated_findings[0]!.ground_truth_verdict, 'INCONCLUSIVE');
  assert.equal(outcomeGenericRevert.adjudicated_findings[0]!.evidence_level, 'OBSERVED');
  assert.equal(outcomeGenericRevert.flywheel_metrics.true_positives, 0);

  // Verified causal evidence: reproducer passed on head -> FALSE_POSITIVE
  const findingFingerprint = createHash('sha256').update('Imaginary memory leak in garbage collected runtime'.toLowerCase()).digest('hex');
  const outcomeFP = adjudicateCandidateReview({
    candidateDigest,
    prState: prStateMergedClean,
    handoff: handoffWithFalsePositive,
    causalEvidence: {
      reproducers: [
        {
          findingFingerprint,
          testCommand: 'npm test',
          passedOnHead: true,
        },
      ],
    },
  });

  assert.equal(outcomeFP.adjudicated_findings[0]!.ground_truth_verdict, 'FALSE_POSITIVE');
  assert.equal(outcomeFP.adjudicated_findings[0]!.evidence_level, 'VERIFIED');
  assert.equal(outcomeFP.flywheel_metrics.false_positives, 1);
  assert.equal(outcomeFP.flywheel_metrics.precision, 0);

  // Causally verified repair commit -> TRUE_POSITIVE
  const outcomeTP = adjudicateCandidateReview({
    candidateDigest,
    prState: prStateMergedClean,
    handoff: handoffWithFalsePositive,
    causalEvidence: {
      repairCommits: [
        {
          findingFingerprint,
          commitSha: '9'.repeat(40),
          causallyVerified: true,
        },
      ],
    },
  });

  assert.equal(outcomeTP.adjudicated_findings[0]!.ground_truth_verdict, 'TRUE_POSITIVE');
  assert.equal(outcomeTP.adjudicated_findings[0]!.evidence_level, 'VERIFIED');
  assert.equal(outcomeTP.flywheel_metrics.true_positives, 1);
  assert.equal(outcomeTP.flywheel_metrics.precision, 1);
});

test('outcomeCollector: saveAdjudicatedOutcome and loadAdjudicatedOutcomes persist and roundtrip', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-outcome-test-'));
  try {
    const candidateDigest = 'a'.repeat(64);
    const headSha = '1'.repeat(40);
    const baseSha = '0'.repeat(40);

    const prState: ObservedPRState = {
      pr_number: 10,
      repository: 'owner/repo',
      head_sha: headSha,
      base_sha: baseSha,
      state: 'MERGED',
      merged_at: '2026-09-09T01:00:00Z',
      merge_commit_sha: '2'.repeat(40),
      checks: [],
      overall_ci_verdict: 'NO_CHECKS',
    };

    const handoff: HostReviewHandoffV2 = {
      schema_version: 2,
      kind: 'host_review_handoff_v2',
      repository: 'owner/repo',
      pr_number: 10,
      base_sha: baseSha,
      head_sha: headSha,
      task_id: 'task1',
      task_hash: 'b'.repeat(64),
      controller_run_id: 'round1',
      reviews: [
        {
          schema_version: 2,
          kind: 'autonomous_review_evidence_v2',
          repository: 'owner/repo',
          pr_number: 10,
          base_sha: baseSha,
          head_sha: headSha,
          task_id: 'task1',
          task_hash: 'b'.repeat(64),
          builder_id: 'codex',
          diff_numstat_digest: 'c'.repeat(64),
          reviewer_id: 'reviewer-mimo',
          reviewer_class: 'independent_readonly_ai',
          execution_id: 'exec-1',
          review_provider: 'opencode-go',
          reviewer_model: 'mimo-v2.5',
          review_mode: 'exact_diff',
          reviewed_at: '2026-09-09T00:50:00Z',
          scope: ['src/index.ts'],
          verdict: 'APPROVE',
          findings: [],
          blocking_findings: [],
          isolation: {
            mode: 'readonly_sandbox',
            candidate_write: false,
            github_mutation: false,
            merge: false,
            controller_state_access: false,
          },
          harness: {
            name: 'babel',
            mode: 'chat',
            version: 'd'.repeat(64),
            source_sha: 'e'.repeat(40),
            execution_id: 'exec-1',
          },
        },
      ],
    };

    const outcome = adjudicateCandidateReview({
      candidateDigest,
      prState,
      handoff,
    });

    const savedFile = saveAdjudicatedOutcome(tempDir, outcome);
    assert.ok(savedFile.endsWith(`${outcome.outcome_id}.json`));

    const loaded = loadAdjudicatedOutcomes(tempDir);
    assert.equal(loaded.invalid, 0);
    assert.equal(loaded.outcomes.length, 1);
    assert.equal(loaded.outcomes[0]!.outcome_id, outcome.outcome_id);
    assert.equal(loaded.outcomes[0]!.candidate_digest, candidateDigest);
    assert.equal(loaded.outcomes[0]!.flywheel_metrics.true_negatives, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
