import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assertReviewStateOutsideGit } from './babelReviewSnapshot.js';
import type { HostReviewHandoffV2 } from './hostReviewController.js';
import type { StructuredFinding } from './structuredFinding.js';

export type EvidenceLevel = 'ASSERTED' | 'OBSERVED' | 'REPRODUCED' | 'VERIFIED';

export type GroundTruthVerdict =
  | 'TRUE_POSITIVE'
  | 'FALSE_POSITIVE'
  | 'TRUE_NEGATIVE'
  | 'FALSE_NEGATIVE'
  | 'INCONCLUSIVE';

export interface ObservedCICheck {
  name: string;
  status: 'completed' | 'in_progress' | 'queued';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | null;
  html_url: string;
  completed_at: string | null;
}

export interface ObservedPRState {
  pr_number: number;
  repository: string;
  head_sha: string;
  base_sha: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged_at: string | null;
  merge_commit_sha: string | null;
  checks: ObservedCICheck[];
  overall_ci_verdict: 'PASS' | 'FAIL' | 'PENDING' | 'NO_CHECKS';
}

export interface AdjudicatedFinding {
  finding_instance_id: string;
  finding_fingerprint: string;
  reviewer_model: string;
  category: string;
  claimed_severity: string;
  claimed_blocking: boolean;
  claim: string;
  ground_truth_verdict: GroundTruthVerdict;
  evidence_level: EvidenceLevel;
  evidence_details: string;
  evidence_sources: string[];
}

export interface FlywheelMetrics {
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  precision: number | null;
  recall: number | null;
}

export interface AdjudicatedReviewOutcome {
  schema_version: 2;
  outcome_id: string;
  candidate_digest: string;
  repository: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  observed_state: ObservedPRState;
  review_verdicts: Array<{
    reviewer_id: string;
    reviewer_model: string;
    verdict: 'APPROVE' | 'BLOCK';
    blocking_findings_count: number;
  }>;
  post_merge_regression: {
    detected: boolean;
    revert_commit_sha?: string | undefined;
    related_commits?: Array<{ sha: string; message: string }> | undefined;
  };
  adjudicated_findings: AdjudicatedFinding[];
  flywheel_metrics: FlywheelMetrics;
  adjudicated_at: string;
}

export const AdjudicatedReviewOutcomeSchema = z.object({
  schema_version: z.literal(2),
  outcome_id: z.string().uuid(),
  candidate_digest: z.string().regex(/^[a-f0-9]{64}$/),
  repository: z.string().min(1),
  pr_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  base_sha: z.string().regex(/^[a-f0-9]{40}$/),
  observed_state: z.object({
    pr_number: z.number().int().positive(),
    repository: z.string().min(1),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/),
    base_sha: z.string().regex(/^[a-f0-9]{40}$/),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    merged_at: z.string().nullable(),
    merge_commit_sha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
    checks: z.array(
      z.object({
        name: z.string(),
        status: z.enum(['completed', 'in_progress', 'queued']),
        conclusion: z
          .enum(['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required'])
          .nullable(),
        html_url: z.string(),
        completed_at: z.string().nullable(),
      }),
    ),
    overall_ci_verdict: z.enum(['PASS', 'FAIL', 'PENDING', 'NO_CHECKS']),
  }),
  review_verdicts: z.array(
    z.object({
      reviewer_id: z.string(),
      reviewer_model: z.string(),
      verdict: z.enum(['APPROVE', 'BLOCK']),
      blocking_findings_count: z.number().int().nonnegative(),
    }),
  ),
  post_merge_regression: z.object({
    detected: z.boolean(),
    revert_commit_sha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    related_commits: z
      .array(z.object({ sha: z.string(), message: z.string() }))
      .optional(),
  }),
  adjudicated_findings: z.array(
    z.object({
      finding_instance_id: z.string(),
      finding_fingerprint: z.string(),
      reviewer_model: z.string(),
      category: z.string(),
      claimed_severity: z.string(),
      claimed_blocking: z.boolean(),
      claim: z.string(),
      ground_truth_verdict: z.enum([
        'TRUE_POSITIVE',
        'FALSE_POSITIVE',
        'TRUE_NEGATIVE',
        'FALSE_NEGATIVE',
        'INCONCLUSIVE',
      ]),
      evidence_level: z.enum(['ASSERTED', 'OBSERVED', 'REPRODUCED', 'VERIFIED']),
      evidence_details: z.string(),
      evidence_sources: z.array(z.string()),
    }),
  ),
  flywheel_metrics: z.object({
    true_positives: z.number().int().nonnegative(),
    false_positives: z.number().int().nonnegative(),
    true_negatives: z.number().int().nonnegative(),
    false_negatives: z.number().int().nonnegative(),
    precision: z.number().nullable(),
    recall: z.number().nullable(),
  }),
  adjudicated_at: z.string(),
});

/**
 * Collect GitHub PR state including merge status and CI check runs.
 */
export function collectGitHubPRState(
  repository: string,
  prNumber: number,
  ghExec?: (args: string[]) => string,
): ObservedPRState {
  const runner =
    ghExec ??
    ((args: string[]) =>
      execFileSync('gh', args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }));

  const prRaw = runner([
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repository,
    '--json',
    'number,headRefOid,baseRefOid,state,mergedAt,mergeCommit',
  ]);
  const prJson = JSON.parse(prRaw) as {
    number: number;
    headRefOid: string;
    baseRefOid: string;
    state: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string | null } | null;
  };

  const state =
    prJson.state === 'MERGED'
      ? 'MERGED'
      : prJson.state === 'CLOSED'
        ? 'CLOSED'
        : 'OPEN';

  let checks: ObservedCICheck[] = [];
  try {
    const checksRaw = runner([
      'api',
      `repos/${repository}/commits/${prJson.headRefOid}/check-runs`,
    ]);
    const checksJson = JSON.parse(checksRaw) as {
      check_runs?: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        completed_at: string | null;
      }>;
    };
    if (Array.isArray(checksJson.check_runs)) {
      checks = checksJson.check_runs.map((cr) => ({
        name: cr.name,
        status:
          cr.status === 'completed'
            ? 'completed'
            : cr.status === 'in_progress'
              ? 'in_progress'
              : 'queued',
        conclusion: (cr.conclusion as ObservedCICheck['conclusion']) ?? null,
        html_url: cr.html_url,
        completed_at: cr.completed_at,
      }));
    }
  } catch {
    // Non-fatal if checks cannot be reached
  }

  let overallCi: ObservedPRState['overall_ci_verdict'] = 'NO_CHECKS';
  if (checks.length > 0) {
    const hasFail = checks.some((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out');
    const hasPending = checks.some((c) => c.status !== 'completed');
    if (hasFail) overallCi = 'FAIL';
    else if (hasPending) overallCi = 'PENDING';
    else overallCi = 'PASS';
  }

  return {
    pr_number: prNumber,
    repository,
    head_sha: prJson.headRefOid,
    base_sha: prJson.baseRefOid,
    state,
    merged_at: prJson.mergedAt ?? null,
    merge_commit_sha: prJson.mergeCommit?.oid ?? null,
    checks,
    overall_ci_verdict: overallCi,
  };
}

/**
 * Inspect Git history following a merge commit to detect revert or regression fix commits.
 */
export function detectPostMergeRegression(
  repoRoot: string,
  mergeCommitSha: string,
  touchedFiles: string[],
  gitExec?: (args: string[]) => string,
): {
  detected: boolean;
  revert_commit_sha?: string | undefined;
  related_commits: Array<{ sha: string; message: string }>;
} {
  const runner =
    gitExec ??
    ((args: string[]) =>
      execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }));

  let logOutput = '';
  try {
    // Look at commits reachable from HEAD but not the merge commit, touching the given files
    logOutput = runner([
      'log',
      '--format=%H %s',
      `${mergeCommitSha}..HEAD`,
      '--',
      ...touchedFiles,
    ]);
  } catch {
    return { detected: false, related_commits: [] };
  }

  const lines = logOutput.trim().split(/\r?\n/).filter(Boolean);
  const relatedCommits: Array<{ sha: string; message: string }> = [];
  let revertCommitSha: string | undefined;

  for (const line of lines) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const sha = line.slice(0, spaceIdx).trim();
    const msg = line.slice(spaceIdx + 1).trim();

    if (/revert/i.test(msg)) {
      revertCommitSha = sha;
      relatedCommits.push({ sha, message: msg });
    } else if (/\b(fix|bug|regression|patch)\b/i.test(msg)) {
      relatedCommits.push({ sha, message: msg });
    }
  }

  return {
    detected: relatedCommits.length > 0,
    revert_commit_sha: revertCommitSha,
    related_commits: relatedCommits,
  };
}

/**
 * Adjudicate a candidate review against ground truth observed outcomes.
 */
export function adjudicateCandidateReview(input: {
  candidateDigest: string;
  prState: ObservedPRState;
  handoff?: {
    reviews: Array<{
      reviewer_id: string;
      reviewer_model: string;
      verdict: 'APPROVE' | 'BLOCK';
      blocking_findings: string[];
    }>;
  } | undefined;
  structuredFindings?: StructuredFinding[] | undefined;
  postMergeRegression?: {
    detected: boolean;
    revert_commit_sha?: string | undefined;
    related_commits?: Array<{ sha: string; message: string }> | undefined;
  } | undefined;
  now?: string | undefined;
}): AdjudicatedReviewOutcome {
  const now = input.now ?? new Date().toISOString();
  const outcomeId = randomUUID();

  const reviews = input.handoff?.reviews ?? [];
  const reviewVerdicts = reviews.map((r) => ({
    reviewer_id: r.reviewer_id,
    reviewer_model: r.reviewer_model,
    verdict: r.verdict,
    blocking_findings_count: r.blocking_findings.length,
  }));

  const findings: AdjudicatedFinding[] = [];
  const structMap = new Map<string, StructuredFinding>();
  if (input.structuredFindings) {
    for (const sf of input.structuredFindings) {
      structMap.set(sf.finding_fingerprint, sf);
    }
  }

  const isMerged = input.prState.state === 'MERGED';
  const ciFailed = input.prState.overall_ci_verdict === 'FAIL';
  const regressionDetected = input.postMergeRegression?.detected ?? false;

  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  // Adjudicate each review's findings
  for (const review of reviews) {
    for (const claim of review.blocking_findings) {
      const fingerprint = createHash('sha256').update(claim.trim().toLowerCase()).digest('hex');
      const sf = structMap.get(fingerprint);

      let gtv: GroundTruthVerdict = 'INCONCLUSIVE';
      let el: EvidenceLevel = 'OBSERVED';
      let details = '';
      const sources: string[] = [];

      if (sf?.verification_status === 'REJECTED_FALSE_POSITIVE') {
        gtv = 'FALSE_POSITIVE';
        el = 'VERIFIED';
        details = `Static finding verification rejected claim: ${sf.verification_source ?? 'invalid'}`;
        sources.push(`verifier:${sf.verification_source ?? 'syntax'}`);
        falsePositives++;
      } else if (isMerged && !regressionDetected && !ciFailed) {
        // Code merged cleanly with green CI and no revert/regression: blocker was likely a false positive
        gtv = 'FALSE_POSITIVE';
        el = 'OBSERVED';
        details = 'PR merged cleanly with passing CI and no subsequent reverts or fixes';
        if (input.prState.merge_commit_sha) sources.push(`commit:${input.prState.merge_commit_sha}`);
        falsePositives++;
      } else if (ciFailed || regressionDetected) {
        // Blocker correlated with observed failure or regression
        gtv = 'TRUE_POSITIVE';
        el = 'OBSERVED';
        details = regressionDetected
          ? `Post-merge regression observed in follow-up commit: ${input.postMergeRegression?.revert_commit_sha ?? 'related'}`
          : 'PR CI check runs failed on candidate head SHA';
        if (input.postMergeRegression?.revert_commit_sha) {
          sources.push(`commit:${input.postMergeRegression.revert_commit_sha}`);
        }
        for (const c of input.prState.checks.filter((chk) => chk.conclusion === 'failure')) {
          sources.push(`check_run:${c.name}`);
        }
        truePositives++;
      } else {
        gtv = 'INCONCLUSIVE';
        el = 'ASSERTED';
        details = 'PR still open or pending CI resolution';
      }

      findings.push({
        finding_instance_id: sf?.finding_instance_id ?? createHash('sha256').update(claim).digest('hex'),
        finding_fingerprint: sf?.finding_fingerprint ?? fingerprint,
        reviewer_model: review.reviewer_model,
        category: sf?.category ?? 'correctness',
        claimed_severity: sf?.severity ?? 'P1',
        claimed_blocking: true,
        claim,
        ground_truth_verdict: gtv,
        evidence_level: el,
        evidence_details: details,
        evidence_sources: sources,
      });
    }

    // Evaluate whole review verdict
    if (review.verdict === 'APPROVE') {
      if (regressionDetected || ciFailed) {
        falseNegatives++;
      } else if (isMerged) {
        trueNegatives++;
      }
    }
  }

  const totalPositivePredictions = truePositives + falsePositives;
  const precision = totalPositivePredictions > 0 ? truePositives / totalPositivePredictions : null;
  const actualDefects = truePositives + falseNegatives;
  const recall = actualDefects > 0 ? truePositives / actualDefects : null;

  return {
    schema_version: 2,
    outcome_id: outcomeId,
    candidate_digest: input.candidateDigest,
    repository: input.prState.repository,
    pr_number: input.prState.pr_number,
    head_sha: input.prState.head_sha,
    base_sha: input.prState.base_sha,
    observed_state: input.prState,
    review_verdicts: reviewVerdicts,
    post_merge_regression: {
      detected: regressionDetected,
      revert_commit_sha: input.postMergeRegression?.revert_commit_sha,
      related_commits: input.postMergeRegression?.related_commits,
    },
    adjudicated_findings: findings,
    flywheel_metrics: {
      true_positives: truePositives,
      false_positives: falsePositives,
      true_negatives: trueNegatives,
      false_negatives: falseNegatives,
      precision,
      recall,
    },
    adjudicated_at: now,
  };
}

/**
 * Save an adjudicated outcome record atomically outside Git.
 */
export function saveAdjudicatedOutcome(
  stateDir: string,
  outcome: AdjudicatedReviewOutcome,
): string {
  const safeState = assertReviewStateOutsideGit(stateDir);
  const outcomesDir = join(safeState, 'outcomes');
  mkdirSync(outcomesDir, { recursive: true, mode: 0o700 });

  const validated = AdjudicatedReviewOutcomeSchema.parse(outcome);
  const json = JSON.stringify(validated, null, 2);
  const target = join(outcomesDir, `${outcome.outcome_id}.json`);
  const temporary = join(outcomesDir, `${outcome.outcome_id}.${randomUUID()}.tmp`);

  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  linkSync(temporary, target);
  unlinkSync(temporary);
  return target;
}

/**
 * Load all adjudicated outcomes from state directory.
 */
export function loadAdjudicatedOutcomes(
  stateDir: string,
): { outcomes: AdjudicatedReviewOutcome[]; invalid: number } {
  if (!existsSync(stateDir)) return { outcomes: [], invalid: 0 };
  const safeState = assertReviewStateOutsideGit(stateDir);
  const outcomesDir = join(safeState, 'outcomes');
  if (!existsSync(outcomesDir)) return { outcomes: [], invalid: 0 };

  const outcomes: AdjudicatedReviewOutcome[] = [];
  let invalid = 0;

  for (const entry of readdirSync(outcomesDir, { withFileTypes: true })) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(entry.name)) continue;
    const path = join(outcomesDir, entry.name);
    try {
      if (!entry.isFile() || entry.isSymbolicLink() || lstatSync(path).size > 256 * 1024) {
        throw new Error('INVALID_OUTCOME_FILE');
      }
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const parsed = AdjudicatedReviewOutcomeSchema.parse(raw);
      outcomes.push(parsed as AdjudicatedReviewOutcome);
    } catch {
      invalid++;
    }
  }

  return { outcomes, invalid };
}
